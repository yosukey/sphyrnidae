/**
 * ui-export.js
 * Export/save related functions
 */
import { showToast } from './ui-toast.js';
import * as THREE from 'three';
import { state, CONSTANTS, getModeLayout, BASE_URL } from '../globals.js';
import { updateMeshScaleForMode, updateUniforms, rebuildShaderForMode, syncInterlaceParityOffset, getMaxTextureSize } from '../rendering/renderer.js';
import { ensureEven } from '../utils/pixel-utils.js';
import { setPixelDimensionsInExifSegment } from '../loaders/loader-exif.js';
import { getModeName, is3DTVModeApplicable } from '../mode-utils.js';
import { alignTransformToRotZoom } from '../rendering/alignment-geometry.js';
import * as logger from '../utils/logger.js';

// Cache GIF Worker Blob URL
let gifWorkerBlobUrl = null;

// Guard against concurrent saveImage calls
let isSaving = false;

/**
 * Show the export loading overlay to indicate saving is in progress
 */
function showExportLoading() {
    if (document.getElementById('exportLoadingOverlay')) return;

    // Inject spinner keyframe once
    if (!document.getElementById('exportSpinnerStyle')) {
        const style = document.createElement('style');
        style.id = 'exportSpinnerStyle';
        style.textContent = '@keyframes exportSpinner { to { transform: rotate(360deg); } }';
        document.head.appendChild(style);
    }

    const overlay = document.createElement('div');
    overlay.id = 'exportLoadingOverlay';
    overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:10000',
        'background:rgba(0,0,0,0.5)',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'cursor:wait',
    ].join(';');

    const modal = document.createElement('div');
    modal.style.cssText = [
        'background:rgba(30,30,30,0.95)',
        'color:#fff',
        'padding:24px 40px',
        'border-radius:8px',
        'text-align:center',
        'font-family:sans-serif',
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'gap:14px',
    ].join(';');

    const spinner = document.createElement('div');
    spinner.style.cssText = [
        'width:28px',
        'height:28px',
        'border:3px solid rgba(255,255,255,0.2)',
        'border-top-color:#fff',
        'border-radius:50%',
        'animation:exportSpinner 0.8s linear infinite',
    ].join(';');

    const message = document.createElement('div');
    message.style.cssText = 'font-size:14px';
    message.setAttribute('data-i18n', 'messages.exportSaving');
    message.textContent = window.t?.('messages.exportSaving') ?? 'Saving...';

    modal.appendChild(spinner);
    modal.appendChild(message);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
}

/**
 * Hide the export loading overlay
 */
function hideExportLoading() {
    const overlay = document.getElementById('exportLoadingOverlay');
    if (overlay && overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
    }
}

/**
 * Update the text inside the export loading overlay (e.g. progress percent).
 * Safe to call before the overlay exists — it simply no-ops.
 */
function setExportLoadingMessage(text) {
    const overlay = document.getElementById('exportLoadingOverlay');
    if (!overlay) return;
    const msg = overlay.querySelector('[data-i18n="messages.exportSaving"]')
        ?? overlay.querySelector('div > div + div');
    if (msg) msg.textContent = text;
}

class CanvasPool {
    constructor(maxPoolSize = 3) {
        this.pool = [];
        this.maxPoolSize = maxPoolSize;
    }

    /**
     * Get or create a canvas of the specified size
     * Reuses pooled canvas if available, otherwise creates new one
     * @param {number} width - Canvas width
     * @param {number} height - Canvas height
     * @returns {HTMLCanvasElement} Canvas element
     */
    acquire(width, height) {
        // Try to find a canvas with matching dimensions in the pool
        const existingIndex = this.pool.findIndex(c => c.width === width && c.height === height);
        if (existingIndex >= 0) {
            const canvas = this.pool.splice(existingIndex, 1)[0];
            // Clear the canvas before returning
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
                ctx.clearRect(0, 0, width, height);
            }
            return canvas;
        }

        // Create new canvas if no match found
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    /**
     * Return a canvas to the pool for reuse
     * @param {HTMLCanvasElement} canvas - Canvas to return
     */
    release(canvas) {
        if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
            return;
        }

        // Only pool if under max size
        if (this.pool.length < this.maxPoolSize) {
            // Clear context to prevent state leakage
            try {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                }
            } catch (err) {
                logger.warn('Export', 'Error clearing canvas:', err);
            }
            this.pool.push(canvas);
        }
    }

    /**
     * Clear all pooled canvases
     */
    clear() {
        this.pool.length = 0;
    }
}

const canvasPool = new CanvasPool(3);

// Export guardrails: warn when the estimated output exceeds these thresholds.
//
// The real failure mode on mobile is the encoder's PEAK memory during export
// (browsers kill a tab well before RAM is exhausted), not the final file size,
// so the pixel thresholds are format-specific and reflect each encoder's memory
// profile (see estimateExportSizeBytes) against a conservative ~200MB single-
// allocation ceiling:
//   - JPEG/WebP/MPO: native streaming encoders, low peak      -> high threshold
//   - PNG/AGIF:      native/JS with larger working buffers     -> mid threshold
//   - APNG/BMP/TIFF: multi-frame RGBA (UPNG) or uncompressed JS
//                    encoders that allocate ImageData + output
//                    buffer at once (highest OOM risk)          -> low threshold
// A modern 12MP/eye stereo Full SBS export is 24MP, which must NOT warn for the
// compressed formats — a single flat threshold (e.g. ~10MP) would fire on nearly
// every high-res export.
// MPO's pixel count is measured as 2x the per-eye area (two stored JPEGs).
const LARGE_EXPORT_WARNING_PIXEL_THRESHOLDS = {
    'image/jpeg': 48_000_000, // 48MP
    'image/webp': 48_000_000, // 48MP
    'image/mpo':  40_000_000, // 40MP (2-eye pixel count)
    'image/png':  32_000_000, // 32MP
    'image/agif': 32_000_000, // 32MP (Wiggle only)
    'image/apng': 24_000_000, // 24MP (Wiggle only)
    'image/bmp':  24_000_000, // 24MP (uncompressed)
    'image/tiff': 24_000_000, // 24MP (uncompressed)
};
const LARGE_EXPORT_WARNING_DEFAULT_PIXEL_THRESHOLD = 24_000_000; // 24MP fallback
// Secondary, pure file-size courtesy guard (mainly catches high-res PNG/BMP/TIFF).
const LARGE_EXPORT_WARNING_SIZE_THRESHOLD_BYTES = 150 * 1024 * 1024; // 150MB

/**
 * Resolve the output-pixel warning threshold for an export format.
 * @param {string} format - Export MIME string (may be a custom image/mpo etc.)
 * @returns {number} Pixel-count threshold above which the large-export warning fires
 */
function largeExportPixelThreshold(format) {
    return LARGE_EXPORT_WARNING_PIXEL_THRESHOLDS[format]
        ?? LARGE_EXPORT_WARNING_DEFAULT_PIXEL_THRESHOLD;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    const decimals = value >= 100 ? 0 : (value >= 10 ? 1 : 2);
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
}

function estimateExportSizeBytes(format, pixelCount) {
    // Conservative estimate for warning purposes.
    // Even compressed formats can become very large with stereo/high-frequency content,
    // so we keep fallback estimates intentionally on the safe side.
    switch (format) {
        case 'image/png':
            return pixelCount * 4;
        case 'image/bmp':
        case 'image/tiff':
            return pixelCount * 3;
        case 'image/jpeg':
        case 'image/webp':
        case 'image/avif':
        case 'image/heif':
            return pixelCount * 1.5;
        case 'image/gif':
        case 'image/agif':
        case 'image/apng':
        case 'image/mpo':
            return pixelCount * 2;
        default:
            return pixelCount * 2;
    }
}

/**
 * Resize the canvas to the specified size
 */
export function resizeCanvas(sourceCanvas, targetWidth, targetHeight, algorithm) {
    const resizedCanvas = canvasPool.acquire(targetWidth, targetHeight);
    const ctx = resizedCanvas.getContext('2d', { willReadFrequently: true });

    // Error handling if getContext returns null
    if (!ctx) {
        throw new Error('Failed to get 2D context for canvas resize');
    }

    try {
        if (algorithm === 'lanczos') {
            // Lanczos resize (high quality, progressive downscale)
            return lanczosResize(sourceCanvas, targetWidth, targetHeight, resizedCanvas);
        } else {
            // Use the browser default imageSmoothingQuality
            ctx.imageSmoothingEnabled = algorithm !== 'low';
            ctx.imageSmoothingQuality = algorithm; // 'low', 'medium', 'high'
            ctx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);
        }

        return resizedCanvas;
    } catch (err) {
        // Return canvas to pool on error
        canvasPool.release(resizedCanvas);
        throw err;
    }
}

/**
 * Lanczos resize (high quality via progressive downscaling)
 */
function lanczosResize(sourceCanvas, targetWidth, targetHeight, finalCanvas = null) {
    let currentCanvas = sourceCanvas;
    let currentWidth = sourceCanvas.width;
    let currentHeight = sourceCanvas.height;
    const tempCanvasesCreated = [];  // Track intermediate canvases for cleanup

    try {
        // Downscale progressively (never reduce by more than 50% at once)
        while (currentWidth > targetWidth * 2 || currentHeight > targetHeight * 2) {
            const nextWidth = Math.max(targetWidth, Math.floor(currentWidth / 2));
            const nextHeight = Math.max(targetHeight, Math.floor(currentHeight / 2));

            const tempCanvas = canvasPool.acquire(nextWidth, nextHeight);
            tempCanvasesCreated.push(tempCanvas);
            const tempCtx = tempCanvas.getContext('2d');

            // Error handling if getContext returns null
            if (!tempCtx) {
                throw new Error('Failed to get 2D context for Lanczos progressive downscale');
            }

            tempCtx.imageSmoothingEnabled = true;
            tempCtx.imageSmoothingQuality = 'high';
            tempCtx.drawImage(currentCanvas, 0, 0, nextWidth, nextHeight);

            currentCanvas = tempCanvas;
            currentWidth = nextWidth;
            currentHeight = nextHeight;
        }

        // Final resize - use provided finalCanvas or acquire from pool
        const resizeFinalCanvas = finalCanvas || canvasPool.acquire(targetWidth, targetHeight);
        const finalCtx = resizeFinalCanvas.getContext('2d');

        // Error handling if getContext returns null
        if (!finalCtx) {
            throw new Error('Failed to get 2D context for Lanczos final resize');
        }

        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';
        finalCtx.drawImage(currentCanvas, 0, 0, targetWidth, targetHeight);

        return resizeFinalCanvas;

    } finally {
        tempCanvasesCreated.forEach(canvas => {
            canvasPool.release(canvas);
        });
    }
}

/**
 * Read back RGBA pixels from a canvas that may be WebGL-backed.
 * getContext('2d') returns null on a canvas that already holds a WebGL
 * context (the renderer's domElement reaches the BMP/TIFF encoders directly
 * when neither resize nor border decoration created a 2D copy), so fall
 * back to drawing it into a temporary 2D canvas first.
 */
function getCanvasImageData(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) {
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvas.width;
    tempCanvas.height = canvas.height;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    if (!tempCtx) {
        throw new Error('Failed to get 2D context for canvas pixel readback');
    }
    tempCtx.drawImage(canvas, 0, 0);
    return tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
}

/**
 * Generate a BMP Blob
 */
async function createBmpBlob(canvas) {
    const width = canvas.width;
    const height = canvas.height;

    const imageData = getCanvasImageData(canvas);

    // BMP stores bottom-to-top; rows are padded to a 4-byte boundary
    const rowSize = Math.ceil((width * 3) / 4) * 4;
    const pixelDataSize = rowSize * height;
    const fileSize = 54 + pixelDataSize;

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);

    // BMP File Header (14 bytes)
    view.setUint8(0, 0x42); // 'B'
    view.setUint8(1, 0x4D); // 'M'
    view.setUint32(2, fileSize, true);
    view.setUint32(6, 0, true); // Reserved
    view.setUint32(10, 54, true); // Pixel data offset

    // DIB Header (BITMAPINFOHEADER, 40 bytes)
    view.setUint32(14, 40, true); // Header size
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
    view.setUint16(26, 1, true); // Planes
    view.setUint16(28, 24, true); // Bits per pixel
    view.setUint32(30, 0, true); // Compression (none)
    view.setUint32(34, pixelDataSize, true);
    view.setUint32(38, 2835, true); // X pixels per meter
    view.setUint32(42, 2835, true); // Y pixels per meter
    view.setUint32(46, 0, true); // Colors in color table
    view.setUint32(50, 0, true); // Important colors

    // Pixel data (bottom-up, BGR format).
    // Use direct Uint8Array indexing rather than DataView.setUint8 — the
    // latter goes through a slower property accessor and stalls the UI
    // for several seconds on multi-megapixel images.
    const data = imageData.data;
    const bytes = new Uint8Array(buffer);
    const padding = rowSize - width * 3;
    for (let y = height - 1; y >= 0; y--) {
        let srcIdx = y * width * 4;
        let dstIdx = 54 + (height - 1 - y) * rowSize;
        for (let x = 0; x < width; x++) {
            bytes[dstIdx++] = data[srcIdx + 2]; // B
            bytes[dstIdx++] = data[srcIdx + 1]; // G
            bytes[dstIdx++] = data[srcIdx];     // R
            srcIdx += 4;
        }
        // Row padding bytes are already zero in the freshly-allocated buffer
        dstIdx += padding;
    }

    return new Blob([buffer], { type: 'image/bmp' });
}

/**
 * Generate a TIFF Blob (uncompressed RGB)
 */
async function createTiffBlob(canvas) {
    const width = canvas.width;
    const height = canvas.height;

    const imageData = getCanvasImageData(canvas);

    const pixelDataSize = width * height * 3;
    const ifdOffset = 8;
    const numTags = 12;
    const ifdSize = 2 + numTags * 12 + 4;
    // Extended data area (after IFD, before pixel data):
    // - BitsPerSample: 3 x UINT16 = 6 bytes
    // - XResolution: RATIONAL (2 x UINT32) = 8 bytes
    // - YResolution: RATIONAL (2 x UINT32) = 8 bytes
    const extDataOffset = ifdOffset + ifdSize;
    const bpsOffset = extDataOffset;          // 3 SHORT values for BitsPerSample
    const xresOffset = bpsOffset + 6;         // RATIONAL for XResolution
    const yresOffset = xresOffset + 8;        // RATIONAL for YResolution
    const stripOffset = yresOffset + 8;       // Pixel data starts here
    const fileSize = stripOffset + pixelDataSize;

    const buffer = new ArrayBuffer(fileSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // TIFF Header
    view.setUint16(0, 0x4949, false); // Little endian ('II')
    view.setUint16(2, 42, true); // TIFF magic number
    view.setUint32(4, ifdOffset, true); // IFD offset

    // IFD
    let pos = ifdOffset;
    view.setUint16(pos, numTags, true); pos += 2;

    // Helper function for IFD entry
    const writeTag = (tag, type, count, value) => {
        view.setUint16(pos, tag, true); pos += 2;
        view.setUint16(pos, type, true); pos += 2;
        view.setUint32(pos, count, true); pos += 4;
        view.setUint32(pos, value, true); pos += 4;
    };

    writeTag(256, 3, 1, width);           // ImageWidth
    writeTag(257, 3, 1, height);          // ImageLength
    writeTag(258, 3, 3, bpsOffset);       // BitsPerSample → offset to 3 SHORT values
    writeTag(259, 3, 1, 1);               // Compression (none)
    writeTag(262, 3, 1, 2);               // PhotometricInterpretation (RGB)
    writeTag(273, 4, 1, stripOffset);     // StripOffsets
    writeTag(277, 3, 1, 3);               // SamplesPerPixel
    writeTag(278, 4, 1, height);          // RowsPerStrip
    writeTag(279, 4, 1, pixelDataSize);   // StripByteCounts
    writeTag(282, 5, 1, xresOffset);      // XResolution → offset to RATIONAL
    writeTag(283, 5, 1, yresOffset);      // YResolution → offset to RATIONAL
    writeTag(296, 3, 1, 2);               // ResolutionUnit (inch)

    view.setUint32(pos, 0, true); // Next IFD (none)

    // Write extended data: BitsPerSample [8, 8, 8]
    view.setUint16(bpsOffset, 8, true);
    view.setUint16(bpsOffset + 2, 8, true);
    view.setUint16(bpsOffset + 4, 8, true);

    // Write extended data: XResolution = 72/1
    view.setUint32(xresOffset, 72, true);
    view.setUint32(xresOffset + 4, 1, true);

    // Write extended data: YResolution = 72/1
    view.setUint32(yresOffset, 72, true);
    view.setUint32(yresOffset + 4, 1, true);

    // Pixel data (RGB, top to bottom)
    const data = imageData.data;
    let offset = stripOffset;
    for (let i = 0; i < data.length; i += 4) {
        bytes[offset++] = data[i];     // R
        bytes[offset++] = data[i + 1]; // G
        bytes[offset++] = data[i + 2]; // B
    }

    return new Blob([buffer], { type: 'image/tiff' });
}

/**
 * Create an MPO file from two JPEG data blobs
 */
function createMpoFromJpegs(firstJpeg, secondJpeg) {
    const numberOfImages = 2;
    const mpEntrySize = 16;
    const numIfdTags = 3;

    // Calculate MPF structure size
    const mpfBodySize = 8 + 2 + (numIfdTags * 12) + 4 + (numberOfImages * mpEntrySize);
    const totalMpfSize = 4 + mpfBodySize;
    const app2Length = 2 + totalMpfSize;

    const firstJpegWithoutSoi = firstJpeg.slice(2);
    const app2SegmentSize = 2 + app2Length;
    // File-absolute position (from SOI at byte 0) of the second image's SOI.
    const secondImageOffset = 2 + app2SegmentSize + firstJpegWithoutSoi.length;

    // Detect a leading APP1 (Exif) on the first image. It is reordered ahead of
    // the MPF APP2 below; its length shifts the MP Header position in the file.
    let app1Len = 0;
    if (firstJpegWithoutSoi.length >= 4 &&
        firstJpegWithoutSoi[0] === 0xFF && firstJpegWithoutSoi[1] === 0xE1) {
        const len = 2 + ((firstJpegWithoutSoi[2] << 8) | firstJpegWithoutSoi[3]);
        if (len <= firstJpegWithoutSoi.length) app1Len = len;
    }

    // CIPA DC-007: the MPEntry "Individual Image Data Offset" is measured from the
    // start of the MP Header (the MP Endian / TIFF "II" header inside the MPF APP2),
    // not from the start of the file. The MP Header sits at:
    //   SOI(2) + optional APP1(app1Len) + APP2 marker(2) + APP2 length(2) + "MPF\0"(4)
    const mpHeaderPos = 2 + app1Len + 2 + 2 + 4;
    const secondImageDataOffset = secondImageOffset - mpHeaderPos;

    // MPF Index IFD
    const mpfData = new ArrayBuffer(mpfBodySize);
    const mpfView = new DataView(mpfData);
    const mpfBytes = new Uint8Array(mpfData);

    // Byte order (Little Endian) + TIFF magic
    mpfView.setUint8(0, 0x49); // 'I'
    mpfView.setUint8(1, 0x49); // 'I'
    mpfView.setUint16(2, 42, true); // TIFF magic
    mpfView.setUint32(4, 8, true); // IFD offset

    // IFD Entry count
    let pos = 8;
    mpfView.setUint16(pos, numIfdTags, true); pos += 2;

    // MPFVersion tag (0xB000)
    mpfView.setUint16(pos, 0xB000, true); pos += 2;
    mpfView.setUint16(pos, 7, true); pos += 2; // Type: UNDEFINED
    mpfView.setUint32(pos, 4, true); pos += 4; // Count
    mpfView.setUint8(pos, 0x30); pos += 1; // '0'
    mpfView.setUint8(pos, 0x31); pos += 1; // '1'
    mpfView.setUint8(pos, 0x30); pos += 1; // '0'
    mpfView.setUint8(pos, 0x30); pos += 1; // '0'

    // NumberOfImages tag (0xB001)
    mpfView.setUint16(pos, 0xB001, true); pos += 2;
    mpfView.setUint16(pos, 4, true); pos += 2; // Type: LONG
    mpfView.setUint32(pos, 1, true); pos += 4; // Count
    mpfView.setUint32(pos, numberOfImages, true); pos += 4; // Value

    // MPEntry tag (0xB002)
    const mpEntryDataOffset = 8 + 2 + (numIfdTags * 12) + 4;
    mpfView.setUint16(pos, 0xB002, true); pos += 2;
    mpfView.setUint16(pos, 7, true); pos += 2; // Type: UNDEFINED
    mpfView.setUint32(pos, numberOfImages * mpEntrySize, true); pos += 4;
    mpfView.setUint32(pos, mpEntryDataOffset, true); pos += 4;

    // Next IFD offset (none)
    mpfView.setUint32(pos, 0, true); pos += 4;

    // MP Entry values
    // First image (representative).
    // Its size is the byte count of the whole first image as written to the file:
    //   SOI(2) + APP2(app2SegmentSize) + firstJpegWithoutSoi.length
    // = 2 + app2SegmentSize + (firstJpeg.length - 2)
    // = firstJpeg.length + app2SegmentSize
    // (equal to the file-absolute secondImageOffset). The SOI is part of the first
    // image and must be counted, so do not subtract it.
    // MPType = 0x20020002: representative-image flag (0x20000000) | Multi-Frame
    // Disparity type code (0x020002), matching real stereo cameras. 0x020001 is
    // the Panorama type code and would misdeclare the pair (CIPA DC-007).
    mpfView.setUint32(pos, 0x20020002, true); pos += 4;
    mpfView.setUint32(pos, firstJpeg.length + app2SegmentSize, true); pos += 4;
    mpfView.setUint32(pos, 0, true); pos += 4;
    mpfView.setUint16(pos, 0, true); pos += 2;
    mpfView.setUint16(pos, 0, true); pos += 2;

    // Second image
    mpfView.setUint32(pos, 0x00020002, true); pos += 4;
    mpfView.setUint32(pos, secondJpeg.length, true); pos += 4;
    mpfView.setUint32(pos, secondImageDataOffset, true); pos += 4;
    mpfView.setUint16(pos, 0, true); pos += 2;
    mpfView.setUint16(pos, 0, true); pos += 2;

    // Build APP2 segment
    const app2Segment = new Uint8Array(app2SegmentSize);
    let segPos = 0;
    app2Segment[segPos++] = 0xFF; // APP2 marker
    app2Segment[segPos++] = 0xE2;
    app2Segment[segPos++] = (app2Length >> 8) & 0xFF;
    app2Segment[segPos++] = app2Length & 0xFF;
    app2Segment[segPos++] = 0x4D; // 'M'
    app2Segment[segPos++] = 0x50; // 'P'
    app2Segment[segPos++] = 0x46; // 'F'
    app2Segment[segPos++] = 0x00; // '\0'
    app2Segment.set(mpfBytes, segPos);

    // Build the final MPO file
    const mpoSize = 2 + app2SegmentSize + firstJpegWithoutSoi.length + secondJpeg.length;
    const mpoData = new Uint8Array(mpoSize);
    let offset = 0;

    // If the first image carries a leading APP1 (Exif) segment, keep it ahead
    // of the MPF APP2 so the marker order is the conventional SOI, APP1, APP2
    // (the MP format expects the MPF APP2 immediately after APP1 when present).
    // The total byte count is unchanged, so all MPF offsets above stay valid
    // (app1Len was detected earlier to position the MP-Header-relative offset).

    // SOI
    mpoData[offset++] = 0xFF;
    mpoData[offset++] = 0xD8;

    // Leading APP1 (Exif) of the first image, if any
    if (app1Len > 0) {
        mpoData.set(firstJpegWithoutSoi.subarray(0, app1Len), offset);
        offset += app1Len;
    }

    // APP2 (MPF)
    mpoData.set(app2Segment, offset);
    offset += app2Segment.length;

    // Remainder of the first JPEG (without SOI and without the leading APP1)
    mpoData.set(firstJpegWithoutSoi.subarray(app1Len), offset);
    offset += firstJpegWithoutSoi.length - app1Len;

    // Second JPEG (complete)
    mpoData.set(secondJpeg, offset);

    return new Blob([mpoData], { type: 'image/mpo' });
}

/**
 * Generate an MPO Blob (for stereo images)
 */
async function createMpoBlob(appState, eyeWidth, eyeHeight, enableResize, resizeScale, resizeAlgorithm) {
    const quality = appState.exportOptions.quality;

    // Render left and right eyes separately
    const originalMode = appState.material.uniforms.mode.value;
    const savedMeshScaleX = appState.mesh.scale.x;
    const savedMeshScaleY = appState.mesh.scale.y;

    // Output size (ensure even pixels)
    let targetWidth = ensureEven(eyeWidth);
    let targetHeight = ensureEven(eyeHeight);
    if (enableResize) {
        targetWidth = Math.max(2, ensureEven(Math.round(eyeWidth * resizeScale)));
        targetHeight = Math.max(2, ensureEven(Math.round(eyeHeight * resizeScale)));
    }

    // Size actually encoded into each eye JPEG, assigned from the canvas below
    // rather than from targetWidth/Height, since the no-resize branch copies the
    // renderer canvas at its own size. Used to patch the EXIF dimension tags so
    // they match the bytes written. Left deliberately unset here: seeding it with
    // targetWidth would reintroduce the assumption this exists to avoid.
    let encodedEyeWidth;
    let encodedEyeHeight;

    let leftBlob, rightBlob;
    try {
        // Modes 4/5 map a single eye across the entire mesh, so the layout
        // baseScale that updateMeshScaleForMode() applied for the on-screen
        // display mode (e.g. 2x width for Full SBS, 3x for LRL, 2x height for
        // Full TaB) must not be kept here — the eye frustum below would then
        // see only a center-cropped, zoomed portion of the eye. Scale the mesh
        // to fill the single-eye frustum exactly, mirroring the mode-13
        // exportView fill logic: frustum height is fixed at frustumSize and
        // the camera aspect already encodes cropRatioX/cropRatioY.
        const cropRatioX = 1.0 - appState.params.cropX;
        const cropRatioY = 1.0 - appState.params.cropY;
        const fillScaleX = (cropRatioY > 0) ? cropRatioX / cropRatioY : cropRatioX;
        appState.mesh.scale.set(fillScaleX, 1.0, 1);

        // Switch to the single-view shader program. Modes 4/5 belong to the
        // 'singleView' shader group, but MPO is only offered for anaglyph/layout
        // display modes, so the active shader here is the anaglyph or layout
        // program — neither has a mode==4/5 branch. Setting only the mode uniform
        // (without rebuilding the program) would render black (anaglyph) or the
        // left eye twice (layout). Rebuild once; modes 4 and 5 share the group so
        // the second eye needs no further rebuild. Restored in the finally block.
        rebuildShaderForMode(4);

        // Left eye (mode=4)
        appState.material.uniforms.mode.value = 4;
        appState.renderer.setSize(eyeWidth, eyeHeight);
        const aspect = eyeWidth / eyeHeight;
        const frustumSize = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        appState.camera.left = -frustumSize * aspect / 2;
        appState.camera.right = frustumSize * aspect / 2;
        appState.camera.updateProjectionMatrix();
        appState.renderer.render(appState.scene, appState.camera);

        let leftCanvas = appState.renderer.domElement;
        if (enableResize && (targetWidth !== eyeWidth || targetHeight !== eyeHeight)) {
            leftCanvas = resizeCanvas(appState.renderer.domElement, targetWidth, targetHeight, resizeAlgorithm);
        } else {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = leftCanvas.width;
            tempCanvas.height = leftCanvas.height;
            const tempCtxL = tempCanvas.getContext('2d');
            if (!tempCtxL) throw new Error('Failed to get 2d context for left eye canvas copy');
            tempCtxL.drawImage(leftCanvas, 0, 0);
            leftCanvas = tempCanvas;
        }
        encodedEyeWidth = leftCanvas.width;
        encodedEyeHeight = leftCanvas.height;

        // Right eye (mode=5)
        appState.material.uniforms.mode.value = 5;
        appState.renderer.render(appState.scene, appState.camera);

        let rightCanvas = appState.renderer.domElement;
        if (enableResize && (targetWidth !== eyeWidth || targetHeight !== eyeHeight)) {
            rightCanvas = resizeCanvas(appState.renderer.domElement, targetWidth, targetHeight, resizeAlgorithm);
        } else {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = rightCanvas.width;
            tempCanvas.height = rightCanvas.height;
            const tempCtxR = tempCanvas.getContext('2d');
            if (!tempCtxR) throw new Error('Failed to get 2d context for right eye canvas copy');
            tempCtxR.drawImage(rightCanvas, 0, 0);
            rightCanvas = tempCanvas;
        }

        // Encode both eyes as JPEG with proper error handling
        leftBlob = await new Promise((resolve, reject) => {
            try {
                leftCanvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to encode left canvas to JPEG blob'));
                }, 'image/jpeg', quality);
            } catch (err) {
                reject(err);
            }
        });
        rightBlob = await new Promise((resolve, reject) => {
            try {
                rightCanvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to encode right canvas to JPEG blob'));
                }, 'image/jpeg', quality);
            } catch (err) {
                reject(err);
            }
        });
    } finally {
        // Always restore the shader mode uniform and mesh scale, even on
        // encode failure
        appState.material.uniforms.mode.value = originalMode;
        // Restore the display mode's shader program (the single-view program was
        // swapped in above). originalMode is the on-screen display mode, so this
        // returns to the correct shader group.
        rebuildShaderForMode(originalMode);
        appState.mesh.scale.set(savedMeshScaleX, savedMeshScaleY, 1);
    }

    let leftData = new Uint8Array(await leftBlob.arrayBuffer());
    let rightData = new Uint8Array(await rightBlob.arrayBuffer());

    // Optional: re-inject each eye's own original EXIF APP1 segment.
    // mode=4/5 render the displayed left/right eye, which the shader swaps when
    // swapLR is active (see computeSampleCoordinates). Map each output back to
    // the source image actually shown there so the metadata stays per-eye
    // correct instead of duplicating the active eye into both.
    if (appState.exportOptions.preserveExif) {
        const swapped = appState.params.swapLR;
        const leftSeg = swapped ? appState.exifRawSegmentRight : appState.exifRawSegmentLeft;
        const rightSeg = swapped ? appState.exifRawSegmentLeft : appState.exifRawSegmentRight;
        // Each eye JPEG is encodedEyeWidth x encodedEyeHeight, which differs from
        // the source whenever crop, resize, even-pixel trim, or left/right
        // resolution normalization applied.
        if (leftSeg) {
            leftData = injectExifIntoJpeg(leftData,
                setPixelDimensionsInExifSegment(leftSeg, encodedEyeWidth, encodedEyeHeight));
        }
        if (rightSeg) {
            rightData = injectExifIntoJpeg(rightData,
                setPixelDimensionsInExifSegment(rightSeg, encodedEyeWidth, encodedEyeHeight));
        }
    }

    return createMpoFromJpegs(leftData, rightData);
}

/**
 * Insert an EXIF APP1 segment (FFE1 + length + "Exif\0\0" + TIFF) into a JPEG
 * byte stream, immediately after the SOI marker. Returns a new Uint8Array.
 * Returns the input unchanged if either side is malformed.
 */
function injectExifIntoJpeg(jpegBytes, app1Segment) {
    if (!app1Segment || app1Segment.length < 4) return jpegBytes;
    if (jpegBytes.length < 2 || jpegBytes[0] !== 0xFF || jpegBytes[1] !== 0xD8) return jpegBytes;
    const out = new Uint8Array(jpegBytes.length + app1Segment.length);
    out[0] = 0xFF;
    out[1] = 0xD8;
    out.set(app1Segment, 2);
    out.set(jpegBytes.subarray(2), 2 + app1Segment.length);
    return out;
}

/**
 * Fetch GIF worker script and create a Blob URL (avoid CORS)
 */
async function getGifWorkerBlobUrl() {
    if (gifWorkerBlobUrl) {
        return gifWorkerBlobUrl;
    }

    const workerUrl = 'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js';
    const expectedSriHash = 'uL0SwIQSos1DfQU2KzlDbPuSz7Jwo+hmNPIhe86VJ+MWwyj0DvjngnAgWrkNi9eQ';
    const maxRetries = 3;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const response = await fetch(workerUrl);
            if (!response.ok) {
                throw new Error(`Worker script fetch failed: ${response.status}`);
            }
            const arrayBuffer = await response.arrayBuffer();

            // SRI integrity verification (SHA-384)
            const hashBuffer = await crypto.subtle.digest('SHA-384', arrayBuffer);
            const hashBase64 = btoa(String.fromCharCode(...new Uint8Array(hashBuffer)));
            if (hashBase64 !== expectedSriHash) {
                throw new Error('GIF worker script integrity check failed (SHA-384 mismatch)');
            }

            const workerBlob = new Blob([arrayBuffer], { type: 'application/javascript' });

            const oldUrl = gifWorkerBlobUrl;
            gifWorkerBlobUrl = URL.createObjectURL(workerBlob);
            if (oldUrl) {
                URL.revokeObjectURL(oldUrl);
            }

            return gifWorkerBlobUrl;
        } catch (error) {
            logger.error('Export', `GIF worker fetch error (attempt ${attempt + 1}/${maxRetries}):`, error);
            if (attempt === maxRetries - 1) {
                throw new Error('Failed to fetch GIF worker script');
            }
            await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
        }
    }
    // Defensive: every successful iteration returns inside the try, and the
    // last failing iteration re-throws. This statement should be unreachable,
    // but is present to guard against future refactors silently returning
    // undefined.
    throw new Error('Failed to fetch GIF worker script (unreachable)');
}

/**
 * Clear the GIF Worker Blob URL (on page unload or memory cleanup)
 */
export function clearGifWorkerBlobUrl() {
    if (gifWorkerBlobUrl) {
        URL.revokeObjectURL(gifWorkerBlobUrl);
        gifWorkerBlobUrl = null;
    }
}

/**
 * Generate animated GIF (for Wiggle mode)
 */
async function createAnimatedGif(appState, renderWidth, renderHeight, targetWidth, targetHeight, enableResize, resizeAlgorithm) {
    if (!window.GIF) {
        throw new Error("GIF.js library is not loaded");
    }

    const workerBlobUrl = await getGifWorkerBlobUrl();

    const gif = new GIF({
        workers: 2,
        quality: 10,
        width: targetWidth,
        height: targetHeight,
        workerScript: workerBlobUrl
    });

    // Capture left/right frames
    for (let phase of [0.0, 1.0]) {
        appState.params.wigglePhase = phase;
        if (appState.material) appState.material.uniforms.wigglePhase.value = phase;

        appState.renderer.render(appState.scene, appState.camera);

        let canvas = appState.renderer.domElement;
        if (enableResize && (targetWidth !== renderWidth || targetHeight !== renderHeight)) {
            canvas = resizeCanvas(canvas, targetWidth, targetHeight, resizeAlgorithm);
        } else {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = canvas.width;
            tempCanvas.height = canvas.height;
            const ctx = tempCanvas.getContext('2d', { willReadFrequently: true });

            // Error handling if getContext returns null
            if (!ctx) {
                throw new Error('Failed to get 2D context for GIF frame capture');
            }

            ctx.drawImage(canvas, 0, 0);
            canvas = tempCanvas;
        }

        gif.addFrame(canvas, { delay: 150 });
    }

    return new Promise((resolve, reject) => {
        // gif.js@0.2.0 does not terminate its Web Workers when rendering finishes;
        // without this each Wiggle GIF export would leave 2 idle workers alive for
        // the page lifetime, accumulating across exports (noticeable on mobile).
        const terminateGifWorkers = () => {
            try {
                const workers = [...(gif.freeWorkers || []), ...(gif.activeWorkers || [])];
                workers.forEach((w) => { try { w.terminate(); } catch (e) { /* already gone */ } });
                if (gif.freeWorkers) gif.freeWorkers.length = 0;
                if (gif.activeWorkers) gif.activeWorkers.length = 0;
            } catch (e) {
                logger.warn('Export', 'Failed to terminate GIF workers:', e);
            }
        };

        const finishedHandler = (blob) => {
            // Note: gif.js@0.2.0 doesn't support .off() for removing listeners
            // Since the GIF object is used once and discarded, cleanup is not critical
            terminateGifWorkers();
            resolve(blob);
        };
        const errorHandler = (err) => {
            // Note: gif.js@0.2.0 doesn't support .off() for removing listeners
            // Since the GIF object is used once and discarded, cleanup is not critical
            terminateGifWorkers();
            reject(err);
        };

        gif.on('finished', finishedHandler);
        gif.on('error', errorHandler);
        gif.on('progress', (p) => {
            const pct = Math.round(p * 100);
            const tmpl = window.t?.('messages.exportProgress', { percent: pct });
            setExportLoadingMessage(tmpl ?? `Encoding... ${pct}%`);
        });
        gif.render();
    });
}

/**
 * Generate animated PNG (for Wiggle mode)
 */
async function createAnimatedPng(appState, renderWidth, renderHeight, targetWidth, targetHeight, enableResize, resizeAlgorithm) {
    if (!window.UPNG) {
        throw new Error("UPNG.js library is not loaded");
    }

    const frames = [];
    const delays = [];
    // Captured frames may be at renderWidth×renderHeight (no resize) or
    // targetWidth×targetHeight (resized). Use the actual frame dimensions
    // when encoding to avoid mismatched buffer/header sizes.
    let frameWidth = 0;
    let frameHeight = 0;

    // Capture left/right frames
    for (let phase of [0.0, 1.0]) {
        appState.params.wigglePhase = phase;
        if (appState.material) appState.material.uniforms.wigglePhase.value = phase;

        appState.renderer.render(appState.scene, appState.camera);

        let canvas;
        if (enableResize && (targetWidth !== renderWidth || targetHeight !== renderHeight)) {
            canvas = resizeCanvas(appState.renderer.domElement, targetWidth, targetHeight, resizeAlgorithm);
        } else {
            canvas = document.createElement('canvas');
            canvas.width = renderWidth;
            canvas.height = renderHeight;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            // Error handling if getContext returns null
            if (!ctx) {
                throw new Error('Failed to get 2D context for APNG frame copy');
            }

            ctx.drawImage(appState.renderer.domElement, 0, 0);
        }

        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        // Error handling if getContext returns null
        if (!ctx) {
            throw new Error('Failed to get 2D context for APNG frame pixel data');
        }

        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        frames.push(imageData.data.buffer.slice(0));
        delays.push(150);
        frameWidth = canvas.width;
        frameHeight = canvas.height;
    }

    const apngBuffer = UPNG.encode(frames, frameWidth, frameHeight, 0, delays);
    return new Blob([apngBuffer], { type: 'image/png' });
}

/**
 * Toggle Quality setting visibility based on format
 */
export function updateQualityControlVisibility() {
    const saveFormatEl = document.getElementById('saveFormat');
    if (!saveFormatEl) return;

    const format = saveFormatEl.value;
    const qualityControl = document.getElementById('qualityControl');

    if (!qualityControl) return;

    // Show only for JPEG, WebP, MPO
    if (format === 'image/jpeg' || format === 'image/webp' || format === 'image/mpo') {
        qualityControl.style.display = '';
    } else {
        qualityControl.style.display = 'none';
    }
}

/**
 * Update export format options based on display mode
 */
export function updateExportFormatOptions() {
    const saveFormatSelect = document.getElementById('saveFormat');
    if (!saveFormatSelect) return;

    const currentMode = state.params.mode;
    const currentValue = saveFormatSelect.value;

    // Get all standard format option elements
    const standardOptions = Array.from(saveFormatSelect.querySelectorAll('option')).filter(opt =>
        opt.value !== 'image/agif' && opt.value !== 'image/apng'
    );

    // Remove existing AGIF/APNG options
    const agifOption = saveFormatSelect.querySelector('option[value="image/agif"]');
    const apngOption = saveFormatSelect.querySelector('option[value="image/apng"]');
    if (agifOption) agifOption.remove();
    if (apngOption) apngOption.remove();

    // For Wiggle mode (6)
    if (currentMode === 6) {
        // Hide standard formats. Safari/iOS native <select> pickers ignore CSS
        // display:none on <option>, so also set disabled+hidden to make the
        // unsupported formats genuinely unselectable on every browser.
        standardOptions.forEach(opt => {
            opt.style.display = 'none';
            opt.disabled = true;
            opt.hidden = true;
        });

        // Add AGIF/APNG
        const agifOpt = document.createElement('option');
        agifOpt.value = 'image/agif';
        agifOpt.textContent = window.t?.('controls.formatAgif') ?? 'AGIF (Animated GIF)';
        saveFormatSelect.appendChild(agifOpt);

        const apngOpt = document.createElement('option');
        apngOpt.value = 'image/apng';
        apngOpt.textContent = window.t?.('controls.formatApng') ?? 'APNG (Animated PNG)';
        saveFormatSelect.appendChild(apngOpt);

        // Select AGIF by default
        if (currentValue !== 'image/agif' && currentValue !== 'image/apng') {
            saveFormatSelect.value = 'image/agif';
        }
    } else {
        // For non-Wiggle modes, show standard formats (clear the disabled+hidden
        // attributes set above so they become selectable again everywhere).
        standardOptions.forEach(opt => {
            opt.style.display = '';
            opt.disabled = false;
            opt.hidden = false;
        });

        // If AGIF/APNG is selected, reset to default
        if (currentValue === 'image/agif' || currentValue === 'image/apng') {
            saveFormatSelect.value = 'image/png';
        }

        // Control MPO format visibility
        const mpoOption = saveFormatSelect.querySelector('option[value="image/mpo"]');
        if (mpoOption) {
            const mpoInappropriateModes = [1, 2, 4, 5];
            // Border decoration (naked-eye margin + fusion dots) is a 2D canvas
            // post-process applied to the composited output. The MPO path stores
            // two separate per-eye JPEGs and never touches that canvas, so the
            // decoration would be silently dropped. Treat MPO as inapplicable while
            // border decoration is enabled AND applicable to the current mode
            // (8/9/12/13); in other modes the checkbox is inert (hidden), so its
            // stale state must not suppress MPO.
            const borderDecorationActive = state.exportOptions.enableBorderDecoration
                && (currentMode === 8 || currentMode === 9 || currentMode === 12 || currentMode === 13);
            if (mpoInappropriateModes.includes(currentMode) || borderDecorationActive) {
                // disabled+hidden as well as display:none so Safari/iOS pickers
                // cannot select MPO in modes where it does not apply.
                mpoOption.style.display = 'none';
                mpoOption.disabled = true;
                mpoOption.hidden = true;
                if (currentValue === 'image/mpo') {
                    saveFormatSelect.value = 'image/png';
                }
            } else {
                mpoOption.style.display = '';
                mpoOption.disabled = false;
                mpoOption.hidden = false;
            }
        }
    }

    // This function reassigns saveFormatSelect.value programmatically (e.g. MPO→PNG
    // on entering an incompatible mode, or JPEG→AGIF on entering Wiggle) without
    // firing a 'change' event, so the quality-control visibility — which is
    // otherwise only refreshed on the user 'change' handler — would go stale (e.g.
    // the inert Quality slider left visible after JPEG→AGIF). Re-sync it here.
    updateQualityControlVisibility();
}

/**
 * Sanitize filename (remove unsafe characters)
 * @param {string} filename - Filename to sanitize
 * @returns {string} Sanitized filename
 */
export function sanitizeFileName(filename) {
    // Remove path separators, control chars, and reserved chars
    // Windows: < > : " / \ | ? *
    // Unix: /
    // Control chars: 0x00-0x1F, 0x7F
    let safe = filename
        .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_')
        .replace(/^\.+/, '_')   // Remove leading dots (avoid hidden files)
        .replace(/\s+/g, '_')   // Replace consecutive spaces with underscores
        .replace(/[. ]+$/, ''); // Windows rejects trailing dots and spaces

    // Avoid Windows reserved device names (case-insensitive). When the base
    // (before any extension) matches one of these, prefix an underscore so
    // the file becomes openable on Windows.
    const reservedDevices = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
    if (reservedDevices.test(safe)) {
        safe = '_' + safe;
    }

    if (safe.length === 0) safe = '_';
    return safe.substring(0, 200);  // Limit base name; extension is appended by the caller
}

/**
 * Ensure a fully-assembled filename (base + suffix + extension) fits within
 * the common filesystem limit of 255 characters.
 * @param {string} fullName - Complete filename including extension
 * @returns {string} Filename trimmed to 250 chars if necessary
 */
function limitFileNameLength(fullName) {
    if (fullName.length <= 250) return fullName;
    // Preserve the extension when truncating
    const dotIdx = fullName.lastIndexOf('.');
    if (dotIdx > 0) {
        const ext = fullName.slice(dotIdx);
        return fullName.slice(0, 250 - ext.length) + ext;
    }
    return fullName.slice(0, 250);
}

/**
 * Get panel coordinates for border decoration based on mode.
 *
 * Only single-row layouts reach this function: Parallel/Cross (8/9) and LRL (12).
 * The 2x2 Matrix (mode 13) is decorated per-view — drawBorderDecoration() is
 * called separately for its parallel (8) and cross (9) rows, which are then
 * stacked — so mode 13 is never passed here. (A single-canvas mode-13 layout is
 * intentionally not supported: its top-row dots would land inside the image
 * instead of in a top margin.)
 *
 * @param {number} mode - Display mode (8, 9, or 12)
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @returns {Array<{x: number, y: number, width: number, height: number}>} Panel coordinates
 */
function getPanelsForMode(mode, width, height, yOffset = 0) {
    if (mode === 8 || mode === 9) {
        // Parallel/Cross: 2 panels (left/right)
        return [
            { x: 0, y: yOffset, width: width / 2, height: height },
            { x: width / 2, y: yOffset, width: width / 2, height: height }
        ];
    } else if (mode === 12) {
        // LRL: 3 panels (left/center/right)
        return [
            { x: 0, y: yOffset, width: width / 3, height: height },
            { x: width / 3, y: yOffset, width: width / 3, height: height },
            { x: 2 * width / 3, y: yOffset, width: width / 3, height: height }
        ];
    }
    return [];
}

/**
 * Draw border decoration for a single panel
 * @param {CanvasRenderingContext2D} ctx - Canvas 2D context
 * @param {{x: number, y: number, width: number, height: number}} panel - Panel coordinates
 * @param {number} borderThickness - Border line width
 * @param {number} cornerRadius - Corner radius for rounded corners
 * @param {number} dotRadius - Radius of center dot
 */
function drawPanelDecoration(ctx, panel, borderThickness, cornerRadius, dotRadius) {
    const { x, y, width, height } = panel;

    // Draw border decoration on top of existing image (don't overwrite it!)
    ctx.save();

    // Create a path that fills the outer area (outside rounded rectangle)
    // Use even-odd fill rule to create a "hole" for the image
    ctx.beginPath();

    // Outer rectangle (entire panel area)
    ctx.rect(x, y, width, height);

    // Inner rounded rectangle (creates a hole with even-odd rule)
    ctx.moveTo(x + cornerRadius, y);
    ctx.lineTo(x + width - cornerRadius, y);
    ctx.arcTo(x + width, y, x + width, y + cornerRadius, cornerRadius);
    ctx.lineTo(x + width, y + height - cornerRadius);
    ctx.arcTo(x + width, y + height, x + width - cornerRadius, y + height, cornerRadius);
    ctx.lineTo(x + cornerRadius, y + height);
    ctx.arcTo(x, y + height, x, y + height - cornerRadius, cornerRadius);
    ctx.lineTo(x, y + cornerRadius);
    ctx.arcTo(x, y, x + cornerRadius, y, cornerRadius);
    ctx.closePath();

    // Fill the outer area (corners) with black using even-odd rule
    ctx.fillStyle = '#000000';
    ctx.fill('evenodd');

    // Draw black border stroke on the rounded rectangle
    ctx.beginPath();
    ctx.moveTo(x + cornerRadius, y);
    ctx.lineTo(x + width - cornerRadius, y);
    ctx.arcTo(x + width, y, x + width, y + cornerRadius, cornerRadius);
    ctx.lineTo(x + width, y + height - cornerRadius);
    ctx.arcTo(x + width, y + height, x + width - cornerRadius, y + height, cornerRadius);
    ctx.lineTo(x + cornerRadius, y + height);
    ctx.arcTo(x, y + height, x, y + height - cornerRadius, cornerRadius);
    ctx.lineTo(x, y + cornerRadius);
    ctx.arcTo(x, y, x + cornerRadius, y, cornerRadius);
    ctx.closePath();

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = borderThickness;
    ctx.stroke();

    ctx.restore();

    // Draw white dot above top edge in the top margin area
    const dotX = x + width / 2;
    const dotY = y - dotRadius - borderThickness / 2; // Position dot just above panel top edge

    // Draw the white dot (with black outline)
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = Math.max(1, Math.round(borderThickness / 2));
    ctx.stroke();
}

/**
 * Draw border decoration on canvas (black borders, rounded corners, white center dots)
 * @param {HTMLCanvasElement} canvas - Source canvas
 * @param {number} mode - Display mode (8, 9, or 12; the 2x2 Matrix is decorated
 *   per-row via 8/9, so mode 13 is never passed here — see getPanelsForMode)
 * @returns {HTMLCanvasElement} Decorated canvas
 */
function drawBorderDecoration(canvas, mode) {
    const width = canvas.width;
    const height = canvas.height;

    // Decoration parameters (proportional to image size)
    const borderThickness = Math.max(2, Math.round(width * 0.009));  // 0.9% (3x thicker)
    const cornerRadius = Math.max(4, Math.round(width * 0.008));     // 0.8%
    const dotRadius = Math.max(3, Math.round(width * 0.005));        // 0.5%

    // Calculate top margin for white dots (dot diameter + border + small spacing)
    const topMargin = dotRadius * 2 + borderThickness + dotRadius;

    // Create new canvas with extra space at top for white dots.
    // Request a read-optimized (CPU-backed) 2D context up front: the decorated
    // canvas is read back via getImageData for the BMP/TIFF encoders, and a later
    // getContext('2d', {willReadFrequently:true}) on the same canvas is ignored
    // (attributes only apply on first context creation), so it would otherwise
    // force a slow GPU→CPU readback. Matches resizeCanvas()'s context options.
    const decoratedCanvas = canvasPool.acquire(width, height + topMargin);
    const ctx = decoratedCanvas.getContext('2d', { willReadFrequently: true });

    // Error handling if getContext returns null (consistent with every other
    // export path); release the just-acquired canvas so the pool is not leaked.
    if (!ctx) {
        canvasPool.release(decoratedCanvas);
        throw new Error('Failed to get 2D context for border decoration');
    }

    // Fill entire canvas with black first (background for top margin area)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, topMargin);

    // Draw original image below the top margin
    ctx.drawImage(canvas, 0, topMargin);

    // Get panel coordinates for this mode (offset by topMargin)
    const panels = getPanelsForMode(mode, width, height, topMargin);

    // Apply decoration to each panel
    panels.forEach(panel => {
        drawPanelDecoration(ctx, panel, borderThickness, cornerRadius, dotRadius);
    });

    return decoratedCanvas;
}

/**
 * Save image
 * @param {function} updateZoomDisplay - Zoom display update function
 */
export async function saveImage(updateZoomDisplay) {
    // Guard against concurrent save operations (e.g., button double-click)
    if (isSaving) {
        logger.warn('Export', 'Save already in progress, ignoring');
        return;
    }
    isSaving = true;

    try {
    if (!state.material || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image) {
        showToast(window.t?.('messages.noImage') ?? 'No image loaded', 'error');
        return;
    }

    const saveFormatEl = document.getElementById('saveFormat');
    const outputFileNameEl = document.getElementById('outputFileName');

    if (!saveFormatEl || !outputFileNameEl) {
        logger.error('Export', 'Required DOM elements not found');
        showToast(window.t?.('messages.exportFailed') ?? 'Export failed: UI elements not found', 'error');
        return;
    }

    const format = saveFormatEl.value;
    const fileNameInput = sanitizeFileName(outputFileNameEl.value || "image");
    const addSuffix = document.getElementById('addSuffix')?.checked ?? true;
    const modeSuffix = addSuffix ? (document.getElementById('modeSuffixDisplay')?.value || "") : "";
    const extension = CONSTANTS.extensionMap[format] || ".png";
    // Accept common synonym extensions so a name the user already typed with a
    // valid extension for this format is not given a second one (e.g. "photo.jpeg"
    // must stay as-is under JPEG rather than becoming "photo.jpeg.jpg", and
    // "photo.tif" must not become "photo.tif.tiff").
    const acceptedExtensions = {
        "image/jpeg": [".jpg", ".jpeg"],
        "image/tiff": [".tiff", ".tif"]
    }[format] || [extension];

    let finalFileName = fileNameInput + modeSuffix;
    const lowerFinalFileName = finalFileName.toLowerCase();
    if (!acceptedExtensions.some(ext => lowerFinalFileName.endsWith(ext))) {
        finalFileName += extension;
    }
    finalFileName = limitFileNameLength(finalFileName);

    // Output resolution
    const sourceImg = state.material.uniforms.map.value.image;
    const imgW = sourceImg.width;
    const imgH = sourceImg.height;
    const eyeWidth = Math.floor(imgW / 2);
    const eyeHeight = imgH;

    // Apply crop ratio (ensure even pixels)
    const cropRatioX = 1.0 - state.params.cropX;
    const cropRatioY = 1.0 - state.params.cropY;
    // Round (not floor) before the even-snap: cropX/cropY encode an even integer
    // pixel count as 1 - evenPx/eyeWidth, and the float round-trip lands just below
    // that integer for many inputs, so Math.floor + ensureEven silently dropped the
    // output 2px short (e.g. a 1920px request saved as 1918). Matches ui-crop.js.
    const croppedEyeWidth = ensureEven(Math.round(eyeWidth * cropRatioX));
    const croppedEyeHeight = ensureEven(Math.round(eyeHeight * cropRatioY));

    const mode = state.params.mode;
    const layout = getModeLayout(mode);
    // Ensure output size is even
    let targetWidth = Math.max(2, ensureEven(Math.round(croppedEyeWidth * layout.wMul)));
    let targetHeight = Math.max(2, ensureEven(Math.round(croppedEyeHeight * layout.hMul)));

    const enableResize = state.exportOptions.enableResize;
    let resizeScale = state.exportOptions.resizeScale;
    // Pixel-width mode: compute scale from target width
    if (state.exportOptions.resizeMode === 'pixel' && state.exportOptions.resizeTargetWidth && targetWidth > 0) {
        resizeScale = Math.min(state.exportOptions.resizeTargetWidth / targetWidth, 1.0);
    }
    const resizeAlgorithm = state.exportOptions.resizeAlgorithm;

    let renderWidth = targetWidth;
    let renderHeight = targetHeight;

    // For mode 13 (2x2 Matrix), we render each view (mode 8/9) individually and combine.
    // The renderer must be set to mode 8/9 dimensions (hMul=1) from the start,
    // not mode 13's full dimensions (hMul=2).
    if (mode === 13) {
        renderHeight = Math.max(2, ensureEven(Math.round(croppedEyeHeight)));
    }

    // Ensure even pixels when resizing
    if (enableResize) {
        targetWidth = Math.max(2, ensureEven(Math.round(targetWidth * resizeScale)));
        targetHeight = Math.max(2, ensureEven(Math.round(targetHeight * resizeScale)));
    }

    {
        // GPU-limit guardrail. The export renders at renderWidth×renderHeight into a
        // WebGL drawing buffer, which the GPU caps at MAX_TEXTURE_SIZE per side. Exceed
        // it and the driver silently clamps or blanks the render, so the saved file is
        // truncated/black with no error. The memory-based large-export warning below
        // does not catch this: a long, thin panorama can sit under the pixel/byte
        // thresholds yet still blow past the per-axis limit. Warn with the concrete
        // limit and let the user cancel. Enabling resize does not help — the renderer
        // draws the full renderWidth×renderHeight first, then downscales.
        const maxTextureSize = getMaxTextureSize();
        if (renderWidth > maxTextureSize || renderHeight > maxTextureSize) {
            const gpuFallback = `This export renders at ${renderWidth}x${renderHeight}px, which exceeds this device's GPU limit of ${maxTextureSize}px per side.\nThe saved image may be clipped or blank (enabling resize does not help — the full size is rendered first).`;
            const gpuWarn = window.t?.('messages.exportGpuLimitWarning', {
                width: renderWidth,
                height: renderHeight,
                maxSize: maxTextureSize,
                defaultValue: gpuFallback,
            }) ?? gpuFallback;
            const gpuConfirm = window.t?.('messages.exportGpuLimitConfirm', { defaultValue: 'Try to save anyway?' }) ?? 'Try to save anyway?';
            if (!confirm(`${gpuWarn}\n\n${gpuConfirm}`)) {
                // User cancelled — not an error. The outer finally still resets
                // isSaving / hides the loading overlay.
                return;
            }
        }
    }

    {
        // Estimate the output size for the large-export guardrail.
        // MPO is special: it does not produce a single targetWidth×targetHeight
        // frame but stores two per-eye JPEGs. Estimating from the on-screen layout
        // dimensions mis-counts depending on mode (e.g. it under-counts in anaglyph
        // mode, where the layout is one eye wide yet the file holds two eyes). Use
        // 2× the per-eye output area instead, matching createMpoBlob()'s pipeline
        // (each eye rendered at cropped eye size, then scaled by resizeScale).
        let estWidth = targetWidth;
        let estHeight = targetHeight;
        let estimatedPixelCount = estWidth * estHeight;
        if (format === 'image/mpo') {
            let eyeW = croppedEyeWidth;
            let eyeH = croppedEyeHeight;
            if (enableResize) {
                eyeW = Math.max(2, ensureEven(Math.round(croppedEyeWidth * resizeScale)));
                eyeH = Math.max(2, ensureEven(Math.round(croppedEyeHeight * resizeScale)));
            }
            estWidth = eyeW;
            estHeight = eyeH;
            estimatedPixelCount = 2 * eyeW * eyeH; // two eyes stored in the MPO
        }

        const estimatedBytes = estimateExportSizeBytes(format, estimatedPixelCount);
        const pixelThreshold = largeExportPixelThreshold(format);
        if (estimatedPixelCount > pixelThreshold ||
                estimatedBytes > LARGE_EXPORT_WARNING_SIZE_THRESHOLD_BYTES) {
            // Show the detailed warning (actual dimensions / megapixels / estimated
            // size / thresholds) followed by the continue/cancel question.
            const megapixels = (estimatedPixelCount / 1_000_000).toFixed(1);
            const thresholdMegapixels = (pixelThreshold / 1_000_000).toString();
            const thresholdSizeStr = formatBytes(LARGE_EXPORT_WARNING_SIZE_THRESHOLD_BYTES);
            const estimatedSizeStr = formatBytes(estimatedBytes);
            const warningFallback = `Estimated export is very large (${estWidth}x${estHeight} / ${megapixels}MP / about ${estimatedSizeStr}).\n`
                + `If it exceeds ${thresholdMegapixels}MP or ${thresholdSizeStr}, saving/display may become unstable.`;
            // Pass defaultValue so the fallback also applies before i18next has
            // initialized (t() returns the raw key otherwise, not undefined, which
            // would slip past the ?? guard).
            const warningMsg = window.t?.('messages.exportLargeEstimateWarning', {
                width: estWidth,
                height: estHeight,
                megapixels,
                estimatedSize: estimatedSizeStr,
                thresholdMegapixels,
                thresholdSize: thresholdSizeStr,
                defaultValue: warningFallback,
            }) ?? warningFallback;
            const confirmMsg = window.t?.('messages.exportLargeEstimateConfirm') ?? 'Continue anyway? (Enable resize if needed)';
            if (!confirm(`${warningMsg}\n\n${confirmMsg}`)) {
                // User cancelled — not an error. The outer finally still
                // resets isSaving/hides loading overlay.
                return;
            }
        }
    }

    // File System Access API
    let fileHandle = null;
    if (window.showSaveFilePicker) {
        try {
            // The picker rejects keys that are not registered IANA MIME types.
            // Custom MIME strings used internally (image/mpo, image/agif,
            // image/apng) must be mapped to a standard equivalent before
            // being handed to the API.
            const acceptMime = ({
                'image/mpo':  'image/jpeg',
                'image/agif': 'image/gif',
                'image/apng': 'image/png',
            })[format] ?? format;
            const opts = {
                suggestedName: finalFileName,
                types: [{
                    description: 'Image Files',
                    accept: {
                        [acceptMime]: [extension]
                    }
                }]
            };
            fileHandle = await window.showSaveFilePicker(opts);
        } catch (err) {
            if (err.name === 'AbortError') {
                // User canceled save (do nothing)
                return;
            }
            logger.warn('Export', 'showSaveFilePicker failed, falling back to download:', err);
        }
    }

    // All user dialogs are done — show loading overlay before heavy processing starts
    showExportLoading();

    // Save current state
    const originalSize = new THREE.Vector2();
    state.renderer.getSize(originalSize);
    const originalPixelRatio = state.renderer.getPixelRatio();
    const oldScale = state.params.scale;
    const oldPanX = state.params.panX;
    const oldPanY = state.params.panY;
    const oldSbs3dtv = state.params.sbs3dtv;
    // Wiggle exports (AGIF/APNG) drive wigglePhase 0.0 -> 1.0 to capture both
    // eyes and never reset it. Every other export-time mutation here is restored,
    // so restore this one too for symmetry; updateUniforms(true) in the finally
    // re-syncs the uniform from the restored value.
    const oldWigglePhase = state.params.wigglePhase;
    // The 'intensity' uniform applies a global 0.85 display dimming for on-screen
    // viewing comfort (see renderer.js / shaders.js). It must NOT be baked into
    // saved files — exports should reflect the true adjusted image (and stay
    // consistent with auto-levels, which measures at intensity=1.0). Force it to
    // 1.0 for the whole export and restore it in the finally block. Optional
    // chaining guards the rare context-restore fallback material with no uniforms.
    const oldIntensity = state.material?.uniforms?.intensity?.value;
    // The alignment grid and the 3D-pointer crosshair are on-screen-only aids
    // (an alignment guide and a mouse-tracking measurement cursor), not image
    // content, so they must not be baked into saved files — mirroring how the
    // histogram/auto-levels pass neutralizes them (see js/core/histogram.js).
    // The text overlay is deliberately excluded here: it is user-authored image
    // content and should be preserved in exports. Saved and restored in finally.
    const oldGridEnabled = state.material?.uniforms?.gridEnabled?.value;
    const oldPointer3dEnabled = state.material?.uniforms?.pointer3dEnabled?.value;

    // For image export, force 3DTV off to avoid writing the 3DTV viewport-stretched result.
    if (oldSbs3dtv && is3DTVModeApplicable(mode)) {
        state.params.sbs3dtv = false;
        const sbs3dtvEl = document.getElementById('sbs3dtv');
        if (sbs3dtvEl) {
            sbs3dtvEl.checked = false;
        }
    }

    try {
        // Resize renderer and camera for saving
        state.renderer.setPixelRatio(1);
        state.renderer.setSize(renderWidth, renderHeight);
        syncInterlaceParityOffset();
        const aspect = renderWidth / renderHeight;
        const frustumSize = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        state.camera.left = -frustumSize * aspect / 2;
        state.camera.right = frustumSize * aspect / 2;
        state.camera.top = frustumSize / 2;
        state.camera.bottom = -frustumSize / 2;
        state.camera.updateProjectionMatrix();

        // Disable pan/zoom for saving
        state.params.scale = 1.0;
        state.params.panX = 0.0;
        state.params.panY = 0.0;
        updateMeshScaleForMode();
        // The export renderer is sized so the canvas aspect matches the cropped
        // output (renderWidth/Height already include cropRatioX/Y, and hMul for the
        // height). Camera frustum height is fixed at CAMERA_FRUSTUM_HEIGHT, so the
        // mesh must be scaled to fill that fixed frustum exactly.
        //
        // After updateMeshScaleForMode(), mesh world height = geomH * baseScaleY *
        // cropRatioY. For a vertically-stacked layout (Full TaB, mode 16) baseScaleY
        // is 2, so without correction the mesh is 2x the frustum and the export shows
        // only the centre, magnified. The required uniform fill factor on both axes
        // is 1 / (baseScaleY * cropRatioY): the baseScaleX==wMul term cancels in X,
        // and baseScaleY==hMul handles both the crop removal and the layout stacking.
        // (Modes 8/9/12 have baseScaleY=1, so this reduces to 1/cropRatioY. Mode 13
        // renders via its own exportView path, which
        // overwrites mesh.scale, so its value here is moot; MPO/AGIF/APNG set their
        // own mesh scale too.)
        {
            const exportBaseScaleY = state.mesh.userData.baseScaleY || 1.0;
            const exportCropRatioY = 1.0 - state.params.cropY;
            if (exportCropRatioY > 0) {
                const inv = 1.0 / (exportBaseScaleY * exportCropRatioY);
                if (inv !== 1.0) {
                    state.mesh.scale.x *= inv;
                    state.mesh.scale.y *= inv;
                }
            }
        }
        // Sync shader uniforms (including sbs3dtv) with current state.params.
        // updateMeshScaleForMode() updates the mesh transform but does not update uniforms.
        // Without this call the sbs3dtv shader uniform would still be 1.0 even though
        // state.params.sbs3dtv was forced to false above, causing the export to render
        // the 3DTV-stretched result instead of the normal stereo image.
        updateUniforms(true);

        // Render every export path (main, MPO, 2x2, AGIF/APNG all share this
        // material) at full intensity so the on-screen 0.85 dimming is not baked
        // into the saved file. updateUniforms() does not touch this uniform.
        if (state.material?.uniforms?.intensity) {
            state.material.uniforms.intensity.value = 1.0;
        }
        // Keep on-screen-only overlays (alignment grid, 3D-pointer crosshair) out
        // of the saved pixels. updateUniforms(true) above just re-synced these from
        // state, so force them off here for the whole export (restored in finally).
        if (state.material?.uniforms?.gridEnabled) {
            state.material.uniforms.gridEnabled.value = 0.0;
        }
        if (state.material?.uniforms?.pointer3dEnabled) {
            state.material.uniforms.pointer3dEnabled.value = 0.0;
        }

        let outputCanvas;

        // MPO/AGIF/APNG do not consume outputCanvas — they manage their own
        // render pipeline. Skip the main render to avoid wasted GPU work
        // (and, for MPO, avoid mutating renderer size only to overwrite it).
        const needsOutputCanvas = (format !== 'image/mpo' && format !== 'image/agif' && format !== 'image/apng');

        // Special handling for 2x2 Matrix mode (mode=13)
        // Strategy: render mode 8 (parallel) and mode 9 (cross) individually,
        // using the exact same pipeline as normal export, then stack vertically.
        // swapLR is handled naturally by the shader (no mode reordering needed).
        if (needsOutputCanvas && mode === 13) {
            logger.info('Export', `Mode 13 (2x2 Matrix): Rendering parallel and cross views separately (renderer: ${renderWidth}x${renderHeight}, canvas: ${state.renderer.domElement.width}x${state.renderer.domElement.height})`);

            // Save state that will be modified
            const savedModeUniform = state.material.uniforms.mode.value;
            const savedBaseScaleX = state.mesh.userData.baseScaleX;
            const savedBaseScaleY = state.mesh.userData.baseScaleY;
            const savedMeshScaleX = state.mesh.scale.x;
            const savedMeshScaleY = state.mesh.scale.y;
            const shouldApplyDecoration = state.exportOptions.enableBorderDecoration;

            // Mode 8/9 render dimensions (wMul=2, hMul=1)
            const viewRenderW = Math.max(2, ensureEven(Math.round(croppedEyeWidth * 2)));
            const viewRenderH = Math.max(2, ensureEven(Math.round(croppedEyeHeight)));
            let viewTargetW = viewRenderW;
            let viewTargetH = viewRenderH;
            if (enableResize) {
                viewTargetW = Math.max(2, ensureEven(Math.round(viewRenderW * resizeScale)));
                viewTargetH = Math.max(2, ensureEven(Math.round(viewRenderH * resizeScale)));
            }

            // (cropRatioX / cropRatioY from the enclosing scope are reused here.)

            // Export a single view: directly set all state, render, post-process
            const exportView = (viewMode) => {
                // Renderer should already be at mode 8/9 dimensions from initial setup.
                // Re-confirm size (defensive).
                state.renderer.setSize(viewRenderW, viewRenderH);
                logger.info('Export', `exportView(mode=${viewMode}): target=${viewRenderW}x${viewRenderH}, actual canvas=${state.renderer.domElement.width}x${state.renderer.domElement.height}`);
                const a = viewRenderW / viewRenderH;
                state.camera.left = -frustumSize * a / 2;
                state.camera.right = frustumSize * a / 2;
                state.camera.top = frustumSize / 2;
                state.camera.bottom = -frustumSize / 2;
                state.camera.updateProjectionMatrix();

                // Shader mode uniform
                state.material.uniforms.mode.value = viewMode;

                // Mesh scale: mode 8/9 = baseScaleX=2, baseScaleY=1
                // Set directly to avoid updateMeshScaleForMode() side effects.
                // Divide cropRatioX by cropRatioY so the mesh fills the cropped
                // frustum exactly (frustum height is fixed; aspect already encodes
                // cropRatioX/cropRatioY). Without this, the cropped region would
                // appear as a black border instead of being removed.
                const fillScaleX = (cropRatioY > 0)
                    ? (2.0 * cropRatioX) / cropRatioY
                    : 2.0 * cropRatioX;
                const fillScaleY = 1.0;
                state.mesh.scale.set(fillScaleX, fillScaleY, 1);
                state.mesh.position.set(0, 0, 0);

                // Render
                state.renderer.render(state.scene, state.camera);
                let c = state.renderer.domElement;

                // Resize (same as normal export path)
                if (enableResize && (viewTargetW !== viewRenderW || viewTargetH !== viewRenderH)) {
                    c = resizeCanvas(state.renderer.domElement, viewTargetW, viewTargetH, resizeAlgorithm);
                }

                // Border decoration (same as normal export path)
                if (shouldApplyDecoration) {
                    const dc = drawBorderDecoration(c, viewMode);
                    if (c !== state.renderer.domElement) {
                        canvasPool.release(c);
                    }
                    c = dc;
                }

                // Copy to standalone canvas (renderer content will change on next render)
                const result = document.createElement('canvas');
                result.width = c.width;
                result.height = c.height;
                const ctx = result.getContext('2d', { willReadFrequently: true });
                if (!ctx) throw new Error('Failed to create 2D context');
                ctx.drawImage(c, 0, 0);
                if (c !== state.renderer.domElement) {
                    canvasPool.release(c);
                }
                return result;
            };

            try {
                // Render mode 8 (top) and mode 9 (bottom)
                const topCanvas = exportView(8);
                const bottomCanvas = exportView(9);

                // Combine vertically
                const combinedCanvas = document.createElement('canvas');
                combinedCanvas.width = topCanvas.width;
                combinedCanvas.height = topCanvas.height + bottomCanvas.height;
                const combinedCtx = combinedCanvas.getContext('2d', { willReadFrequently: true });
                if (!combinedCtx) throw new Error('Failed to create 2D context for combined canvas');
                combinedCtx.drawImage(topCanvas, 0, 0);
                combinedCtx.drawImage(bottomCanvas, 0, topCanvas.height);

                logger.info('Export', `Combined canvas: ${combinedCanvas.width}x${combinedCanvas.height} (top: ${topCanvas.width}x${topCanvas.height}, bottom: ${bottomCanvas.width}x${bottomCanvas.height})`);
                outputCanvas = combinedCanvas;
            } finally {
                // Always restore mesh/uniform state, even on error inside exportView
                state.material.uniforms.mode.value = savedModeUniform;
                state.mesh.userData.baseScaleX = savedBaseScaleX;
                state.mesh.userData.baseScaleY = savedBaseScaleY;
                state.mesh.scale.set(savedMeshScaleX, savedMeshScaleY, 1);
            }
        } else if (needsOutputCanvas) {
            // Normal rendering for non-2x2 modes
            state.renderer.render(state.scene, state.camera);

            // Capture render result
            outputCanvas = state.renderer.domElement;

            // Resize processing
            if (enableResize && (targetWidth !== renderWidth || targetHeight !== renderHeight)) {
                outputCanvas = resizeCanvas(state.renderer.domElement, targetWidth, targetHeight, resizeAlgorithm);
            }

            // Apply border decoration if enabled (modes 8/9/12 only)
            const shouldApplyDecoration = state.exportOptions.enableBorderDecoration &&
                                           (mode === 8 || mode === 9 || mode === 12);
            if (shouldApplyDecoration) {
                const decoratedCanvas = drawBorderDecoration(outputCanvas, mode);
                // Release resized canvas back to pool if created
                if (outputCanvas !== state.renderer.domElement) {
                    canvasPool.release(outputCanvas);
                }
                outputCanvas = decoratedCanvas;
            }
        }

        // Generate Blob
        let blob;
        if (format === 'image/bmp') {
            blob = await createBmpBlob(outputCanvas);
        } else if (format === 'image/tiff') {
            blob = await createTiffBlob(outputCanvas);
        } else if (format === 'image/mpo') {
            blob = await createMpoBlob(state, croppedEyeWidth, croppedEyeHeight, enableResize, resizeScale, resizeAlgorithm);
        } else if (format === 'image/agif') {
            try {
                blob = await createAnimatedGif(state, renderWidth, renderHeight, targetWidth, targetHeight, enableResize, resizeAlgorithm);
            } catch (err) {
                logger.error('Export', 'AGIF generation error:', err);
                throw new Error(`Failed to generate animated GIF: ${err.message}`);
            }
        } else if (format === 'image/apng') {
            try {
                blob = await createAnimatedPng(state, renderWidth, renderHeight, targetWidth, targetHeight, enableResize, resizeAlgorithm);
            } catch (err) {
                logger.error('Export', 'APNG generation error:', err);
                throw new Error(`Failed to generate animated PNG: ${err.message}`);
            }
        } else {
            const quality = (format === 'image/png') ? undefined : state.exportOptions.quality;
            blob = await new Promise(resolve =>
                outputCanvas.toBlob(resolve, format, quality)
            );
            // Error handling if toBlob returns null (out of memory, etc.)
            if (!blob) {
                throw new Error('Failed to encode canvas to blob (memory may be insufficient)');
            }
            // Some browsers (notably Safari) ignore an unsupported `format` and
            // silently encode PNG instead, so the blob would be saved under the
            // wrong extension with the quality slider inert. Trust blob.type and
            // relabel the download to match the real contents.
            if (blob.type && blob.type !== format) {
                logger.warn('Export', `Requested format ${format} not honored by browser; encoded as ${blob.type}`);
                const actualExt = CONSTANTS.extensionMap[blob.type];
                if (actualExt && !finalFileName.toLowerCase().endsWith(actualExt)) {
                    finalFileName = finalFileName.replace(/\.[^.]+$/, '') + actualExt;
                }
                showToast(
                    window.t?.('messages.formatFallback', { requested: format, actual: blob.type })
                        ?? `This browser does not support ${format}; saved as ${blob.type} instead.`,
                    'warning'
                );
            }
            // Re-inject the source EXIF APP1 segment into the JPEG output if requested.
            // WebP/PNG containers store metadata differently and are not handled here.
            if (format === 'image/jpeg'
                    && state.exportOptions.preserveExif
                    && state.exifRawSegment) {
                const jpegBytes = new Uint8Array(await blob.arrayBuffer());
                // The stored segment describes one source eye; this output is the
                // composited frame (layout multiplier, crop, resize, decoration all
                // applied). Take the size from the canvas that was just encoded so
                // the tags cannot drift from the pixels.
                const segment = setPixelDimensionsInExifSegment(
                    state.exifRawSegment, outputCanvas.width, outputCanvas.height);
                const withExif = injectExifIntoJpeg(jpegBytes, segment);
                // Re-wrap only when the splice actually happened. On the fallback
                // path above the browser may have encoded PNG despite the JPEG
                // request; injectExifIntoJpeg then no-ops on the missing SOI, and
                // re-wrapping would relabel those bytes as JPEG right after the
                // code above corrected the extension to match the real format.
                if (withExif !== jpegBytes) {
                    blob = new Blob([withExif], { type: 'image/jpeg' });
                }
            }
        }

        if (!blob) throw new Error("Blob generation failed");

        // Save file
        if (fileHandle) {
            let writable = null;
            try {
                writable = await fileHandle.createWritable();
                await writable.write(blob);
                await writable.close();
                writable = null; // Closed successfully; nothing left to abort
                // Save file succeeded (UI notifies user)
            } catch (err) {
                logger.error('Export', 'File write error:', err);
                // If write()/close() failed after the writable was opened, abort it
                // so the browser can clean up the temp file/lock and discard the
                // partial write (close() above would otherwise never run).
                if (writable) {
                    try {
                        await writable.abort();
                    } catch (abortErr) {
                        logger.warn('Export', 'Failed to abort writable after error:', abortErr);
                    }
                }
                throw err;
            }
        } else {
            // Fallback: use download attribute
            const url = URL.createObjectURL(blob);
            try {
                const link = document.createElement('a');
                link.href = url;
                link.download = finalFileName;
                document.body.appendChild(link);
                link.click();
                link.remove();
                // Defer revoke generously — Safari iOS and slow devices may
                // take longer than a second to attach the download to the
                // user's chosen handler, and revoking too early aborts it.
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            } catch (downloadErr) {
                // click()/DOM manipulation threw before the deferred revoke was
                // scheduled; revoke immediately so the blob URL is not leaked for
                // the lifetime of the page.
                URL.revokeObjectURL(url);
                throw downloadErr;
            }
            // File download complete (UI notifies user)
        }

    } catch (err) {
        logger.error('Export', err);
        showToast(window.t?.('messages.saveFailed', { error: err.message }) ?? `Save failed: ${err.message}`, 'error');
    } finally {
        // Restore state (always executed, success or failure)
        state.params.scale = oldScale;
        state.params.panX = oldPanX;
        state.params.panY = oldPanY;
        state.params.sbs3dtv = oldSbs3dtv;
        // Restore the Wiggle phase that AGIF/APNG export forced to 1.0 (no-op for
        // non-Wiggle exports). The updateUniforms(true) below propagates it to the
        // shader uniform.
        state.params.wigglePhase = oldWigglePhase;
        const sbs3dtvEl = document.getElementById('sbs3dtv');
        if (sbs3dtvEl) {
            sbs3dtvEl.checked = oldSbs3dtv;
        }
        // Restore the on-screen display dimming forced to 1.0 for export.
        if (oldIntensity !== undefined && state.material?.uniforms?.intensity) {
            state.material.uniforms.intensity.value = oldIntensity;
        }
        // Restore the on-screen-only overlays forced off for export. The
        // updateUniforms(true) below also re-syncs these from state, but restore
        // explicitly so the values are correct even on the context-restore
        // fallback material where updateUniforms is a partial no-op.
        if (oldGridEnabled !== undefined && state.material?.uniforms?.gridEnabled) {
            state.material.uniforms.gridEnabled.value = oldGridEnabled;
        }
        if (oldPointer3dEnabled !== undefined && state.material?.uniforms?.pointer3dEnabled) {
            state.material.uniforms.pointer3dEnabled.value = oldPointer3dEnabled;
        }
        updateMeshScaleForMode();
        state.renderer.setPixelRatio(originalPixelRatio);
        state.renderer.setSize(originalSize.x, originalSize.y);
        // Restore the camera frustum to the on-screen aspect synchronously. The export
        // set it to the output aspect (renderWidth/renderHeight); the 'resize' dispatch
        // below only recomputes it via renderer's *debounced* (100ms) onWindowResize, so
        // the explicit render at the end of this block — and any animate() frames within
        // that window — would otherwise draw the restored-size canvas through the stale
        // export-aspect camera, flashing a stretched/squashed frame after every export.
        const restoredAspect = originalSize.y > 0 ? originalSize.x / originalSize.y : 1;
        const restoredFrustumH = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        state.camera.left = -restoredFrustumH * restoredAspect / 2;
        state.camera.right = restoredFrustumH * restoredAspect / 2;
        state.camera.top = restoredFrustumH / 2;
        state.camera.bottom = -restoredFrustumH / 2;
        state.camera.updateProjectionMatrix();
        syncInterlaceParityOffset();
        window.dispatchEvent(new Event('resize'));
        // Re-sync shader uniforms with the restored state.params. The export forced
        // sbs3dtv off (updateUniforms(true) above) and may have rebuilt the shader
        // (MPO single-view); without this the sbs3dtv uniform stays 0.0 while
        // updateMeshScaleForMode() re-stretches the mesh for 3DTV, leaving the
        // on-screen image distorted until the next control change. The 'resize'
        // event only re-syncs uniforms in viewer mode, but Save is normal-mode only.
        updateUniforms(true);
        state.renderer.render(state.scene, state.camera);
        if (updateZoomDisplay) updateZoomDisplay();
        // Clear the canvas pool so stale image data from a failed export
        // does not get returned on the next acquire.
        canvasPool.clear();
    }
    } finally {
        isSaving = false;
        hideExportLoading();
    }
}

// Below this magnitude a decomposed rotation/zoom is treated as zero and omitted
// from the export (also the round-off floor for the 4-decimal serialization).
const ALIGN_EXPORT_EPS = 1e-4;

/**
 * Format a rotation (deg) / zoom (pct) value for URL/list output: fixed 4-decimal
 * precision with trailing zeros trimmed. Ample for the small roll/vertical-zoom
 * magnitudes involved (< ~10 deg / < ~6 %).
 * @param {number} n
 * @returns {string}
 */
function formatAlignParam(n) {
    return parseFloat(n.toFixed(4)).toString();
}

/**
 * Format a normalized crop value (ratio / offset) for URL/list output: fixed
 * 5-decimal precision with trailing zeros trimmed. One extra digit over the
 * rotation/zoom formatter because these ratios scale directly by image pixels.
 * @param {number} n
 * @returns {string}
 */
function formatCropValue(n) {
    return parseFloat(n.toFixed(5)).toString();
}

/**
 * Build the compact `crop=cropX,cropY,offsetX,offsetY` value for the current crop
 * state, or null when no crop is applied (cropX and cropY both zero). The four
 * values are the shader's normalized, resolution-independent crop uniforms, so
 * they round-trip without needing image dimensions.
 * @returns {string|null}
 */
function buildCropParam() {
    const { cropX = 0, cropY = 0, offsetX = 0, offsetY = 0 } = state.params;
    if (!(cropX > 0 || cropY > 0)) return null;
    return [cropX, cropY, offsetX, offsetY].map(formatCropValue).join(',');
}

/**
 * Compute the shared URL/list export geometry for the current parallax + alignment
 * state.
 *
 * shiftX -> x (px). The vertical value folds BOTH shiftY and any folded vertical
 * constant f (= -alignTransform[7]) into a single `y` (px), so `y` stays a pure
 * vertical-shift value whether or not geometric refinement is active. The
 * alignTransform roll/vertical-zoom are decomposed into rotation (deg) / zoom (pct).
 * `y` is written unclamped (full image height), so it carries the entire vertical
 * value even when it exceeds the shiftY ±0.1 slider range. On import,
 * rotZoomToAlignTransform rebuilds the roll/zoom matrix and splitVerticalShift keeps
 * the in-range part in shiftY while folding any overflow back into alignTransform[7]
 * (the shader adds the two: srcR.y constant = a[7] - shiftY) — a lossless,
 * rendering-equivalent round-trip of the exported state.
 *
 * @param {HTMLImageElement|undefined} img - current stereo image (for px scale)
 * @returns {{parallaxPx:number, verticalPx:number, rotationDeg:number, zoomPct:number}}
 */
function computeExportGeometry(img) {
    const align = state.params.alignTransform;
    // f = -a[7]: vertical constant carried by the matrix (0 for the shift-only path).
    const fUV = (Array.isArray(align) && align.length >= 9) ? -align[7] : 0;
    const verticalUV = (state.params.shiftY || 0) + fUV;

    let parallaxPx = 0;
    let verticalPx = 0;
    if (img) {
        parallaxPx = Math.round((state.params.shiftX || 0) * img.width);
        verticalPx = Math.round(verticalUV * img.height);
    }

    const rz = alignTransformToRotZoom(align) || { rotationDeg: 0, zoomPct: 0 };
    return { parallaxPx, verticalPx, rotationDeg: rz.rotationDeg, zoomPct: rz.zoomPct };
}

/**
 * Generate clipboard export string in list format
 * Format: URL format=value mode=mode_name x=value y=value r=value z=value crop=cx,cy,ox,oy
 * Only includes non-default/non-zero values for compactness
 * @returns {string|null} Export string or null if not in external image mode or URL dialog mode
 */
export function generateClipboardListFormat() {
    if ((!state.externalImageMode && !state.loadedFromUrlDialog) || !state.externalImageUrl) {
        return null;
    }

    const url = state.externalImageUrl;
    const mode = state.params.mode;
    let format = state.currentImageFormat || 'half_sbs';

    // Get current image dimensions to convert shift/alignment to pixels
    const img = state.material?.uniforms?.map?.value?.image;
    const { parallaxPx, verticalPx, rotationDeg, zoomPct } = computeExportGeometry(img);

    // Build key=value pairs (only include non-default values)
    const parts = [url];

    // Always include format
    parts.push(`format=${format}`);

    // Include mode if not default (anaglyph)
    // Use mode name instead of number for readability
    if (mode !== 0) {
        const modeName = getModeName(mode);
        if (modeName) {
            parts.push(`mode=${modeName}`);
        } else {
            // Fallback to number if name not found
            parts.push(`mode=${mode}`);
        }
    }

    // Include x if non-zero
    if (parallaxPx !== 0) {
        parts.push(`x=${parallaxPx}`);
    }

    // Include y if non-zero
    if (verticalPx !== 0) {
        parts.push(`y=${verticalPx}`);
    }

    // Include rotation/zoom only when geometric refinement is in effect
    if (Math.abs(rotationDeg) >= ALIGN_EXPORT_EPS) {
        parts.push(`r=${formatAlignParam(rotationDeg)}`);
    }
    if (Math.abs(zoomPct) >= ALIGN_EXPORT_EPS) {
        parts.push(`z=${formatAlignParam(zoomPct)}`);
    }

    // Include the crop window only when a crop is applied
    const cropStr = buildCropParam();
    if (cropStr) {
        parts.push(`crop=${cropStr}`);
    }

    return parts.join(' ');
}

/**
 * Generate clipboard export string in viewer format
 * Format: https://sphyrnidae.pages.dev?src=URL&mode=mode_name&x=...&y=...&r=...&z=...&crop=...&format=...
 * @returns {string|null} Export string or null if not in external image mode or URL dialog mode
 */
export function generateClipboardViewerFormat() {
    if ((!state.externalImageMode && !state.loadedFromUrlDialog) || !state.externalImageUrl) {
        return null;
    }

    const baseUrl = BASE_URL;
    const url = state.externalImageUrl;
    const mode = state.params.mode;
    let format = state.currentImageFormat || 'half_sbs';

    // Get current image dimensions to convert shift/alignment to pixels
    const img = state.material?.uniforms?.map?.value?.image;
    const { parallaxPx, verticalPx, rotationDeg, zoomPct } = computeExportGeometry(img);

    // Build query string
    const params = new URLSearchParams();
    params.set('src', url);

    // Use mode name instead of number
    const modeName = getModeName(mode);
    if (modeName) {
        params.set('mode', modeName);
    } else {
        // Fallback to number if name not found
        params.set('mode', mode.toString());
    }

    params.set('x', parallaxPx.toString());
    params.set('y', verticalPx.toString());
    // Include rotation/zoom only when geometric refinement is in effect, so plain
    // shift-only links stay unchanged.
    if (Math.abs(rotationDeg) >= ALIGN_EXPORT_EPS) {
        params.set('r', formatAlignParam(rotationDeg));
    }
    if (Math.abs(zoomPct) >= ALIGN_EXPORT_EPS) {
        params.set('z', formatAlignParam(zoomPct));
    }
    // Include the crop window only when a crop is applied
    const cropStr = buildCropParam();
    if (cropStr) {
        params.set('crop', cropStr);
    }
    params.set('format', format);

    return `${baseUrl}?${params.toString()}`;
}

/**
 * Copy clipboard export to clipboard (list format)
 */
export async function copyClipboardListFormat() {
    const text = generateClipboardListFormat();
    if (!text) {
        logger.warn('Export', 'Image not loaded from URL or format not detected');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        logger.info('Export', 'List format copied to clipboard');
    } catch (err) {
        logger.error('Export', 'Failed to copy to clipboard:', err);
        throw err;
    }
}

/**
 * Copy clipboard export to clipboard (viewer format)
 */
export async function copyClipboardViewerFormat() {
    const text = generateClipboardViewerFormat();
    if (!text) {
        logger.warn('Export', 'Image not loaded from URL or format not detected');
        return;
    }

    try {
        await navigator.clipboard.writeText(text);
        logger.info('Export', 'Viewer format copied to clipboard');
    } catch (err) {
        logger.error('Export', 'Failed to copy to clipboard:', err);
        throw err;
    }
}
