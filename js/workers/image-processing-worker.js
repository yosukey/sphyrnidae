/**
* image-processing-worker.js
* Web Worker that runs image processing in the background
* Executes canvas processing and format conversion without blocking the main thread
*/

// Import shared utilities (provides ensureEven and WORKER_CONSTANTS)
import { ensureEven, WORKER_CONSTANTS } from './shared-utils.js';
import * as logger from '../utils/logger.js';

// Detect OffscreenCanvas support
const isOffscreenCanvasSupported = typeof OffscreenCanvas !== 'undefined' &&
    OffscreenCanvas.prototype.convertToBlob !== undefined;

// Track resources for cleanup
let activeImageBitmaps = new Set();
let activeCanvases = new Set();

self.onmessage = async (event) => {
    const { requestId, type, payload } = event.data;

    if (type === 'cleanup') {
        logger.debug('WORKER_LOG', 'ImageWorker', 'Cleanup requested, releasing resources');

        // Close all active ImageBitmaps
        activeImageBitmaps.forEach(bitmap => {
            try {
                if (bitmap && typeof bitmap.close === 'function') {
                    bitmap.close();
                }
            } catch (err) {
                logger.warn('ImageWorker', 'Error closing ImageBitmap:', err);
            }
        });
        activeImageBitmaps.clear();

        // Clear all active canvases
        activeCanvases.forEach(canvas => {
            try {
                if (canvas) {
                    canvas.width = 0;
                    canvas.height = 0;
                }
            } catch (err) {
                logger.warn('ImageWorker', 'Error clearing canvas:', err);
            }
        });
        activeCanvases.clear();

        // Respond with cleanup complete
        if (requestId !== undefined && requestId !== null) {
            self.postMessage({
                requestId,
                type: 'cleanup-complete'
            });
        }
        return;
    }

    // Validate that requestId is present (required for response routing)
    if (requestId === undefined || requestId === null) {
        logger.error('ImageWorker', 'Worker received message without requestId:', type);
        // Cannot respond without requestId, but log the error
        return;
    }

    try {
        if (type === 'processImage') {
            await handleProcessImage(payload, requestId);
        } else if (type === 'createSBSFromDualImages') {
            await handleCreateSBS(payload, requestId);
        } else if (type === 'extractJpegsFromMpo') {
            await handleExtractMpo(payload, requestId);
        } else {
            // Unknown message type - send error response to prevent main thread from hanging
            logger.warn('ImageWorker', 'Worker received unknown message type:', type);
            self.postMessage({
                requestId,
                type: 'error',
                error: `Unknown message type: ${type}`
            });
        }
    } catch (error) {
        // Do not send stack traces for security reasons
        // (avoid leaking internal implementation details)
        logger.error('ImageWorker', 'Worker error:', error);
        self.postMessage({
            requestId,
            type: 'error',
            error: error.message
        });
    }
};

/**
* Image processing (format conversion)
* Process via Canvas using an ImageBitmap (zero-copy transfer via Transferable Objects)
*/
async function handleProcessImage({ imageBitmap, width, height, format, filename }, requestId) {
    // Check for OffscreenCanvas support
    if (!isOffscreenCanvasSupported) {
        // Close the transferred (detached-on-main-thread) ImageBitmap before
        // bailing: this throw is BEFORE the try/finally that normally closes it,
        // so without this the bitmap leaks for the worker's lifetime on every
        // unsupported-browser processImage call.
        if (imageBitmap && typeof imageBitmap.close === 'function') {
            imageBitmap.close();
        }
        throw new Error('OFFSCREEN_CANVAS_NOT_SUPPORTED');
    }

    // Progress: 10% - processing start
    self.postMessage({ requestId, type: 'progress', progress: 10 });

    // Track ImageBitmap for cleanup on unexpected termination
    if (imageBitmap) activeImageBitmaps.add(imageBitmap);

    try {
        // Validate ImageBitmap
        if (!imageBitmap) {
            throw new Error('ImageBitmap not received from main thread');
        }

        // Progress: 30% - ImageBitmap received
        self.postMessage({ requestId, type: 'progress', progress: 30 });

        // Run canvas processing (processImageWithFormat returns a Promise)
        const resultBlob = await processImageWithFormat(imageBitmap, format);

        // Progress: 90% - Canvas processing complete
        self.postMessage({ requestId, type: 'progress', progress: 90 });

        // Convert Blob to ArrayBuffer and send
        const buffer = await resultBlob.arrayBuffer();

        // Progress: 100% - complete
        self.postMessage({
            requestId,
            type: 'processImage-complete',
            arrayBuffer: buffer,
            format: format,
            filename: filename
        }, [buffer]); // ArrayBuffer is a transferable object
    } finally {
        // Always release ImageBitmap memory (success or failure)
        if (imageBitmap && typeof imageBitmap.close === 'function') {
            imageBitmap.close();
        }
        activeImageBitmaps.delete(imageBitmap);
    }
}

/**
* Image format conversion (accepts ImageBitmap)
* ImageBitmap is transferred as a Transferable Object (zero-copy),
* and can be drawn directly with drawImage, which is more efficient than putImageData.
*
* Memory management: Intermediate OffscreenCanvas objects are explicitly set to null
* after use to facilitate garbage collection, especially important for large images.
*/
async function processImageWithFormat(imageBitmap, format) {
    // Validate ImageBitmap
    if (!imageBitmap) {
        throw new Error('ImageBitmap is null or undefined');
    }
    if (typeof imageBitmap.width !== 'number' || typeof imageBitmap.height !== 'number') {
        throw new Error('ImageBitmap has invalid width or height');
    }

    const srcWidth = imageBitmap.width;
    const srcHeight = imageBitmap.height;

    // Reject genuinely degenerate sources up front. ensureEven() floors to a minimum
    // of 2, so a per-format `evenWidth < 2` check can never fire for a 0- or 1-px
    // source — the image would instead be silently upscaled with an oversized
    // drawImage source rect. Guarding the raw source dimensions makes such images
    // fail cleanly (the caller surfaces it as a load failure).
    if (srcWidth < 2 || srcHeight < 2) {
        throw new Error(`Image too small: ${srcWidth}x${srcHeight} (minimum 2x2)`);
    }

    let canvas = new OffscreenCanvas(srcWidth, srcHeight);
    activeCanvases.add(canvas);
    // Only enable willReadFrequently for formats that call getImageData on the
    // initial canvas; full_tab uses drawImage and never reads back.
    const needsReadback = ['half_tab', 'interlace_h', 'interlace_v'].includes(format);
    let ctx = canvas.getContext('2d', needsReadback ? { willReadFrequently: true } : undefined);

    if (!ctx) {
        throw new Error('Failed to get 2D context - OffscreenCanvas may not be fully supported');
    }

    // Draw ImageBitmap onto canvas
    ctx.drawImage(imageBitmap, 0, 0);

    // Track intermediate canvases for cleanup
    let intermediateCanvases = [];

    // Release every canvas still tracked for this request. Used by the error path
    // below so a throw (small-image guard, getImageData OOM, convertToBlob timeout)
    // does not pin full-resolution canvases in the module-level activeCanvases set
    // for the worker's lifetime — the worker is reused after a 'type: error' reply,
    // so a leaked canvas would persist for the whole session.
    const releaseTrackedCanvases = () => {
        if (Array.isArray(intermediateCanvases)) {
            for (const c of intermediateCanvases) {
                if (c) {
                    try { c.width = 0; c.height = 0; } catch (_) { /* ignore */ }
                    activeCanvases.delete(c);
                }
            }
        }
        if (canvas) {
            try { canvas.width = 0; canvas.height = 0; } catch (_) { /* ignore */ }
            activeCanvases.delete(canvas);
        }
    };

    try {
    switch (format) {
        case 'full_sbs': {
            // Full SBS: trim as needed to ensure even pixels
            const evenWidth = ensureEven(srcWidth);
            const evenHeight = ensureEven(srcHeight);

            if (evenWidth !== srcWidth || evenHeight !== srcHeight) {
                const oldCanvas = canvas;
                intermediateCanvases.push(oldCanvas);
                canvas = new OffscreenCanvas(evenWidth, evenHeight);
                activeCanvases.add(canvas);
                ctx = canvas.getContext('2d');
                ctx.drawImage(oldCanvas, 0, 0, evenWidth, evenHeight, 0, 0, evenWidth, evenHeight);
                logger.debug('WORKER_LOG', 'ImageWorker', `[full_sbs] Trimmed: ${srcWidth}x${srcHeight} → ${evenWidth}x${evenHeight}`);
            }
            break;
        }

        case 'half_sbs': {
            // Double width (ensure even pixels)
            const newWidth = ensureEven(srcWidth * 2);
            const newHeight = ensureEven(srcHeight);

            if (newWidth < 2 || newHeight < 2) {
                throw new Error(`Image too small after adjustment: ${newWidth}x${newHeight} (original: ${srcWidth}x${srcHeight})`);
            }

            const oldCanvas = canvas;
            intermediateCanvases.push(oldCanvas);
            canvas = new OffscreenCanvas(newWidth, newHeight);
            activeCanvases.add(canvas);
            ctx = canvas.getContext('2d');
            ctx.drawImage(oldCanvas, 0, 0, srcWidth, srcHeight, 0, 0, newWidth, newHeight);
            logger.debug('WORKER_LOG', 'ImageWorker', `[half_sbs] Converted: ${srcWidth}x${srcHeight} → ${newWidth}x${newHeight}`);
            break;
        }

        case 'full_tab': {
            // Place top/bottom halves side-by-side (ensure even pixels).
            // Use drawImage with explicit source/dest rects (matching the
            // main-thread fallback in loader-image-processing.js) instead of
            // putImageData. putImageData is a 1:1 copy with no scaling, so when
            // halfHeight is odd (newHeight = ensureEven(halfHeight) < halfHeight)
            // it wrote halfHeight rows into a shorter canvas and clipped the
            // bottom row — diverging from the main-thread path by up to 1px for
            // the same input. (half_tab already uses an exact-sized temp canvas
            // + drawImage scale, so it did not have this issue.)
            const halfHeight = Math.floor(srcHeight / 2);
            const newWidth = ensureEven(srcWidth * 2);
            const newHeight = ensureEven(halfHeight);

            if (newWidth < 2 || newHeight < 2 || halfHeight < 1) {
                throw new Error(`Image too small after adjustment: ${newWidth}x${newHeight} (original: ${srcWidth}x${srcHeight})`);
            }

            const newCanvas = new OffscreenCanvas(newWidth, newHeight);
            const newCtx = newCanvas.getContext('2d');

            // Upper half (left eye) to the left
            newCtx.drawImage(canvas, 0, 0, srcWidth, halfHeight, 0, 0, srcWidth, newHeight);
            // Lower half (right eye) to the right
            newCtx.drawImage(canvas, 0, halfHeight, srcWidth, halfHeight, srcWidth, 0, srcWidth, newHeight);

            // Track source canvas for cleanup
            intermediateCanvases.push(canvas);
            canvas = newCanvas;
            activeCanvases.add(canvas);
            logger.debug('WORKER_LOG', 'ImageWorker', `[full_tab] Converted: ${srcWidth}x${srcHeight} → ${newWidth}x${newHeight}`);
            break;
        }

        case 'half_tab': {
            // Double height and then place left/right (ensure even pixels)
            const halfHeight = Math.floor(srcHeight / 2);
            const newWidth = ensureEven(srcWidth * 2);
            const newHeight = ensureEven(halfHeight * 2);

            if (newWidth < 2 || newHeight < 2 || halfHeight < 1) {
                throw new Error(`Image too small after adjustment: ${newWidth}x${newHeight} (original: ${srcWidth}x${srcHeight})`);
            }

            const newCanvas = new OffscreenCanvas(newWidth, newHeight);
            const newCtx = newCanvas.getContext('2d');

            // Upper half (left eye) to the left, double height
            const topData = ctx.getImageData(0, 0, srcWidth, halfHeight);
            const topCanvas = new OffscreenCanvas(srcWidth, halfHeight);
            topCanvas.getContext('2d').putImageData(topData, 0, 0);
            newCtx.drawImage(topCanvas, 0, 0, srcWidth, halfHeight, 0, 0, srcWidth, newHeight);
            intermediateCanvases.push(topCanvas);

            // Lower half (right eye) to the right, double height
            const bottomData = ctx.getImageData(0, halfHeight, srcWidth, halfHeight);
            const bottomCanvas = new OffscreenCanvas(srcWidth, halfHeight);
            bottomCanvas.getContext('2d').putImageData(bottomData, 0, 0);
            newCtx.drawImage(bottomCanvas, 0, 0, srcWidth, halfHeight, srcWidth, 0, srcWidth, newHeight);
            intermediateCanvases.push(bottomCanvas);

            // Track source canvas for cleanup
            intermediateCanvases.push(canvas);
            canvas = newCanvas;
            activeCanvases.add(canvas);
            logger.debug('WORKER_LOG', 'ImageWorker', `[half_tab] Converted: ${srcWidth}x${srcHeight} → ${newWidth}x${newHeight}`);
            break;
        }

        case 'interlace_h': {
            // Horizontal line interlace (alternate rows, ensure even pixels)
            const halfHeight = Math.floor(srcHeight / 2);

            // Guard against a source too short to deinterlace: halfHeight === 0
            // (srcHeight < 2) would make createImageData(srcWidth, 0) throw a raw
            // IndexSizeError. Surface the same explicit message as the SBS/TaB
            // paths instead. (interlace is user-selectable via the format dialog.)
            if (halfHeight < 1) {
                throw new Error(`Image too small after adjustment: interlace needs at least 2 rows (original: ${srcWidth}x${srcHeight})`);
            }

            // Step 1: fetch all pixel data at once (batch to reduce GC)
            const srcImageData = ctx.getImageData(0, 0, srcWidth, srcHeight);
            const srcData = srcImageData.data;

            // Separate left and right eyes (each W × H/2)
            const leftCanvas = new OffscreenCanvas(srcWidth, halfHeight);
            const leftCtx = leftCanvas.getContext('2d', { willReadFrequently: true });
            const leftImageData = leftCtx.createImageData(srcWidth, halfHeight);
            const leftData = leftImageData.data;

            const rightCanvas = new OffscreenCanvas(srcWidth, halfHeight);
            const rightCtx = rightCanvas.getContext('2d', { willReadFrequently: true });
            const rightImageData = rightCtx.createImageData(srcWidth, halfHeight);
            const rightData = rightImageData.data;

            // Deinterlace by directly manipulating the byte array
            const bytesPerRow = srcWidth * 4;
            for (let y = 0; y < halfHeight; y++) {
                const leftSrcOffset = (y * 2) * bytesPerRow;
                const rightSrcOffset = (y * 2 + 1) * bytesPerRow;
                const dstOffset = y * bytesPerRow;

                // Copy one row (memcpy equivalent)
                leftData.set(srcData.subarray(leftSrcOffset, leftSrcOffset + bytesPerRow), dstOffset);
                rightData.set(srcData.subarray(rightSrcOffset, rightSrcOffset + bytesPerRow), dstOffset);
            }

            leftCtx.putImageData(leftImageData, 0, 0);
            rightCtx.putImageData(rightImageData, 0, 0);

            // Step 2: double height per eye (ensure even pixels)
            const newWidth = ensureEven(srcWidth);
            const newHeight = ensureEven(srcHeight);
            const expandedLeftCanvas = new OffscreenCanvas(newWidth, newHeight);
            expandedLeftCanvas.getContext('2d').drawImage(leftCanvas, 0, 0, srcWidth, halfHeight, 0, 0, newWidth, newHeight);

            const expandedRightCanvas = new OffscreenCanvas(newWidth, newHeight);
            expandedRightCanvas.getContext('2d').drawImage(rightCanvas, 0, 0, srcWidth, halfHeight, 0, 0, newWidth, newHeight);

            // Track intermediate canvases for cleanup
            intermediateCanvases.push(leftCanvas, rightCanvas);

            // Step 3: arrange in SBS format
            const sbsCanvas = new OffscreenCanvas(newWidth * 2, newHeight);
            const sbsCtx = sbsCanvas.getContext('2d');
            sbsCtx.drawImage(expandedLeftCanvas, 0, 0);
            sbsCtx.drawImage(expandedRightCanvas, newWidth, 0);

            // Track expanded canvases and original canvas for cleanup
            intermediateCanvases.push(expandedLeftCanvas, expandedRightCanvas, canvas);

            logger.debug('WORKER_LOG', 'ImageWorker', `[interlace_h] Converted: ${srcWidth}x${srcHeight} → ${newWidth * 2}x${newHeight}`);
            canvas = sbsCanvas;
            activeCanvases.add(canvas);
            break;
        }

        case 'interlace_v': {
            // Vertical line interlace (alternate columns, ensure even pixels)
            const halfWidth = Math.floor(srcWidth / 2);

            // Guard against a source too narrow to deinterlace: halfWidth === 0
            // (srcWidth < 2) would make createImageData(0, srcHeight) throw a raw
            // IndexSizeError. Surface the same explicit message as the SBS/TaB
            // paths instead. (interlace is user-selectable via the format dialog.)
            if (halfWidth < 1) {
                throw new Error(`Image too small after adjustment: interlace needs at least 2 columns (original: ${srcWidth}x${srcHeight})`);
            }

            // Step 1: fetch all pixel data at once (batch to reduce GC)
            const srcImageData = ctx.getImageData(0, 0, srcWidth, srcHeight);
            const srcData = srcImageData.data;

            // Separate left and right eyes (each W/2 × H)
            const leftCanvas = new OffscreenCanvas(halfWidth, srcHeight);
            const leftCtx = leftCanvas.getContext('2d', { willReadFrequently: true });
            const leftImageData = leftCtx.createImageData(halfWidth, srcHeight);
            const leftData = leftImageData.data;

            const rightCanvas = new OffscreenCanvas(halfWidth, srcHeight);
            const rightCtx = rightCanvas.getContext('2d', { willReadFrequently: true });
            const rightImageData = rightCtx.createImageData(halfWidth, srcHeight);
            const rightData = rightImageData.data;

            // Deinterlace column-by-column. Unlike interlace_h (whole contiguous
            // rows), the left/right eyes are interleaved per column, so the copy
            // is inherently per-pixel. Assign the 4 RGBA bytes directly rather than
            // allocating a subarray view per pixel, which would create millions of
            // short-lived objects (GC pressure) on large images.
            for (let y = 0; y < srcHeight; y++) {
                const srcRowOffset = y * srcWidth * 4;
                const dstRowOffset = y * halfWidth * 4;

                for (let x = 0; x < halfWidth; x++) {
                    const leftSrcOffset = srcRowOffset + (x * 2) * 4;
                    const rightSrcOffset = srcRowOffset + (x * 2 + 1) * 4;
                    const dstOffset = dstRowOffset + x * 4;

                    leftData[dstOffset]     = srcData[leftSrcOffset];
                    leftData[dstOffset + 1] = srcData[leftSrcOffset + 1];
                    leftData[dstOffset + 2] = srcData[leftSrcOffset + 2];
                    leftData[dstOffset + 3] = srcData[leftSrcOffset + 3];

                    rightData[dstOffset]     = srcData[rightSrcOffset];
                    rightData[dstOffset + 1] = srcData[rightSrcOffset + 1];
                    rightData[dstOffset + 2] = srcData[rightSrcOffset + 2];
                    rightData[dstOffset + 3] = srcData[rightSrcOffset + 3];
                }
            }

            leftCtx.putImageData(leftImageData, 0, 0);
            rightCtx.putImageData(rightImageData, 0, 0);

            // Step 2: double width per eye (ensure even pixels)
            const newWidth = ensureEven(srcWidth);
            const newHeight = ensureEven(srcHeight);
            const expandedLeftCanvas = new OffscreenCanvas(newWidth, newHeight);
            expandedLeftCanvas.getContext('2d').drawImage(leftCanvas, 0, 0, halfWidth, srcHeight, 0, 0, newWidth, newHeight);

            const expandedRightCanvas = new OffscreenCanvas(newWidth, newHeight);
            expandedRightCanvas.getContext('2d').drawImage(rightCanvas, 0, 0, halfWidth, srcHeight, 0, 0, newWidth, newHeight);

            // Track intermediate canvases for cleanup
            intermediateCanvases.push(leftCanvas, rightCanvas);

            // Step 3: arrange in SBS format
            const sbsCanvas = new OffscreenCanvas(newWidth * 2, newHeight);
            const sbsCtx = sbsCanvas.getContext('2d');
            sbsCtx.drawImage(expandedLeftCanvas, 0, 0);
            sbsCtx.drawImage(expandedRightCanvas, newWidth, 0);

            // Track expanded canvases and original canvas for cleanup
            intermediateCanvases.push(expandedLeftCanvas, expandedRightCanvas, canvas);

            logger.debug('WORKER_LOG', 'ImageWorker', `[interlace_v] Converted: ${srcWidth}x${srcHeight} → ${newWidth * 2}x${newHeight}`);
            canvas = sbsCanvas;
            activeCanvases.add(canvas);
            break;
        }

        default: {
            // Default also ensures even pixels
            const evenWidth = ensureEven(srcWidth);
            const evenHeight = ensureEven(srcHeight);
            if (evenWidth !== srcWidth || evenHeight !== srcHeight) {
                const oldCanvas = canvas;
                intermediateCanvases.push(oldCanvas);
                canvas = new OffscreenCanvas(evenWidth, evenHeight);
                activeCanvases.add(canvas);
                ctx = canvas.getContext('2d');
                ctx.drawImage(oldCanvas, 0, 0, evenWidth, evenHeight, 0, 0, evenWidth, evenHeight);
            }
            break;
        }
    }

    // This is especially important for large images to prevent memory pressure
    // Setting dimensions to 0 helps browser GC reclaim memory faster
    if (intermediateCanvases && Array.isArray(intermediateCanvases)) {
        try {
            // Clear each canvas by setting dimensions to 0
            intermediateCanvases.forEach(c => {
                try {
                    if (c && typeof c === 'object') {
                        c.width = 0;
                        c.height = 0;
                        activeCanvases.delete(c);
                    }
                } catch (canvasErr) {
                    // Individual canvas cleanup failure should not break the loop
                    logger.warn('ImageWorker', 'Error clearing individual canvas:', canvasErr);
                }
            });
            // Clear array to remove all references
            intermediateCanvases.length = 0;
        } catch (err) {
            logger.warn('ImageWorker', 'Error clearing intermediateCanvases array:', err);
        }
    } else if (intermediateCanvases) {
        logger.warn('ImageWorker', 'intermediateCanvases is not an array:', typeof intermediateCanvases);
    }
    intermediateCanvases = null;

    // Convert OffscreenCanvas to a PNG Blob, then clean up
    // Scale timeout based on canvas pixel count (base 30s + 1s per megapixel, max 120s)
    const megapixels = (canvas.width * canvas.height) / (1024 * 1024);
    const blobTimeoutMs = Math.min(120000, Math.max(30000, 30000 + megapixels * 1000));
    const blobPromise = canvas.convertToBlob({ type: 'image/png' });
    let blobTimeoutId = null;
    const timeoutPromise = new Promise((_, reject) => {
        blobTimeoutId = setTimeout(() => reject(new Error('convertToBlob timeout')), blobTimeoutMs);
    });
    const blob = await Promise.race([blobPromise, timeoutPromise]).finally(() => {
        if (blobTimeoutId) clearTimeout(blobTimeoutId);
    });
    canvas.width = 0;
    canvas.height = 0;
    activeCanvases.delete(canvas);
    return blob;
    } catch (err) {
        // Free tracked canvases before propagating so the failed request does not
        // leak them; handleProcessImage's catch still replies with 'type: error'.
        releaseTrackedCanvases();
        throw err;
    }
}

/**
* SBS image generation (accepts ImageData)
* The generated image is guaranteed to have even pixel dimensions
*
* Memory management: Intermediate OffscreenCanvas objects are explicitly set to null
* after use to facilitate garbage collection.
*/
async function handleCreateSBS({ leftImageData, rightImageData }, requestId) {
    // Check for OffscreenCanvas support
    if (!isOffscreenCanvasSupported) {
        throw new Error('OFFSCREEN_CANVAS_NOT_SUPPORTED');
    }

    self.postMessage({ requestId, type: 'progress', progress: 20 });

    // Track intermediate canvases for cleanup
    let tempCanvasL = null;
    let tempCanvasR = null;
    // Final SBS canvas — tracked here so the finally block can release it if
    // convertToBlob (or the blob/arrayBuffer steps) throws or times out.
    let sbsCanvas = null;

    try {
        const leftWidth = leftImageData.width;
        const leftHeight = leftImageData.height;
        const rightWidth = rightImageData.width;
        const rightHeight = rightImageData.height;

        self.postMessage({ requestId, type: 'progress', progress: 50 });

        // Resolution check
        if (leftWidth !== rightWidth || leftHeight !== rightHeight) {
            throw new Error('Resolution mismatch');
        }

        // Ensure even pixels
        const evenEyeWidth = ensureEven(leftWidth);
        const evenHeight = ensureEven(leftHeight);

        // Generate SBS image (even pixel size)
        const canvas = new OffscreenCanvas(evenEyeWidth * 2, evenHeight);
        sbsCanvas = canvas;
        activeCanvases.add(canvas);
        const ctx = canvas.getContext('2d');

        // Left image (trim to even size)
        tempCanvasL = new OffscreenCanvas(leftWidth, leftHeight);
        activeCanvases.add(tempCanvasL);
        tempCanvasL.getContext('2d').putImageData(leftImageData, 0, 0);
        ctx.drawImage(tempCanvasL, 0, 0, evenEyeWidth, evenHeight, 0, 0, evenEyeWidth, evenHeight);

        // Right image (trim to even size)
        tempCanvasR = new OffscreenCanvas(rightWidth, rightHeight);
        activeCanvases.add(tempCanvasR);
        tempCanvasR.getContext('2d').putImageData(rightImageData, 0, 0);
        ctx.drawImage(tempCanvasR, 0, 0, evenEyeWidth, evenHeight, evenEyeWidth, 0, evenEyeWidth, evenHeight);

        // Cleanup intermediate canvases immediately after use
        tempCanvasL.width = 0;
        tempCanvasL.height = 0;
        activeCanvases.delete(tempCanvasL);
        tempCanvasL = null;
        tempCanvasR.width = 0;
        tempCanvasR.height = 0;
        activeCanvases.delete(tempCanvasR);
        tempCanvasR = null;

        self.postMessage({ requestId, type: 'progress', progress: 80 });

        // Convert to Blob with timeout protection
        const megapixels = (canvas.width * canvas.height) / (1024 * 1024);
        const blobTimeoutMs = Math.min(120000, Math.max(30000, 30000 + megapixels * 1000));
        const blobPromise = canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
        let blobTimeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            blobTimeoutId = setTimeout(() => reject(new Error('convertToBlob timeout')), blobTimeoutMs);
        });
        const blob = await Promise.race([blobPromise, timeoutPromise]).finally(() => {
            if (blobTimeoutId) clearTimeout(blobTimeoutId);
        });
        const buffer = await blob.arrayBuffer();

        // Clean up the final SBS canvas after blob conversion
        canvas.width = 0;
        canvas.height = 0;
        activeCanvases.delete(canvas);
        sbsCanvas = null;

        self.postMessage({
            requestId,
            type: 'createSBS-complete',
            arrayBuffer: buffer
        }, [buffer]);
    } finally {
        // Ensure cleanup even on error
        if (tempCanvasL) {
            tempCanvasL.width = 0;
            tempCanvasL.height = 0;
            activeCanvases.delete(tempCanvasL);
            tempCanvasL = null;
        }
        if (tempCanvasR) {
            tempCanvasR.width = 0;
            tempCanvasR.height = 0;
            activeCanvases.delete(tempCanvasR);
            tempCanvasR = null;
        }
        if (sbsCanvas) {
            try { sbsCanvas.width = 0; sbsCanvas.height = 0; } catch (_) { /* ignore */ }
            activeCanvases.delete(sbsCanvas);
            sbsCanvas = null;
        }
    }
}

/**
* MPO extraction
*/
async function handleExtractMpo({ mpoArrayBuffer }, requestId) {
    self.postMessage({ requestId, type: 'progress', progress: 10 });

    const jpegBlobs = extractJpegsFromMpo(mpoArrayBuffer);

    // Report progress AFTER the parse, BEFORE the blob→ArrayBuffer conversion, so the
    // bar advances through the conversion instead of jumping to 100% and then sitting
    // there (the loader maps this stage to 30–70%). 100% is posted once conversion
    // actually completes.
    self.postMessage({ requestId, type: 'progress', progress: 60 });

    // Convert Blob array to ArrayBuffer array
    const arrayBuffers = await Promise.all(
        jpegBlobs.map((blob) => blob.arrayBuffer())
    );

    self.postMessage({ requestId, type: 'progress', progress: 100 });

    self.postMessage({
        requestId,
        type: 'extractMpo-complete',
        arrayBuffers: arrayBuffers
    }, arrayBuffers); // Transferable objects
}

/**
 * Consolidates iteration limit logic for consistency
 */
function createLoopGuard(maxIterations, context = 'loop') {
    let iterations = 0;
    return {
        check: () => {
            iterations++;
            if (iterations > maxIterations) {
                logger.warn('ImageWorker', `MPO extraction: ${context} exceeded maximum iterations (${maxIterations})`);
                return true; // Limit exceeded
            }
            return false; // Continue
        },
        getIterations: () => iterations
    };
}

/**
* Extract JPEGs from MPO
* Includes guard conditions to prevent infinite loops from corrupt or malicious data
*/
function extractJpegsFromMpo(buffer) {
    const data = new Uint8Array(buffer);
    const jpegBlobs = [];
    let offset = 0;
    const maxScanLength = WORKER_CONSTANTS.MPO_MAX_SCAN_LENGTH;
    let scannedSinceSoi = 0;

    // Absolute iteration cap to prevent excessive CPU time on very large/corrupt files
    // (normal MPO files are typically < 20MB; cap at 20M iterations)
    const MAX_ABSOLUTE_ITERATIONS = 20 * 1024 * 1024;
    const outerLoopGuard = createLoopGuard(Math.min(data.length, MAX_ABSOLUTE_ITERATIONS), 'outer loop');

    // Max JPEGs to extract (MPO usually has 2; <=10 with thumbnails)
    const maxJpegs = WORKER_CONSTANTS.MPO_MAX_JPEG_COUNT;

    while (offset < data.length - 1) {
        const initialOffset = offset; // Track starting position for safety

        if (outerLoopGuard.check()) {
            break;
        }

        // Stop after enough JPEGs are extracted
        if (jpegBlobs.length >= maxJpegs) {
            logger.warn('ImageWorker', `MPO extraction: Maximum JPEG count (${maxJpegs}) reached`);
            break;
        }

        if (data[offset] === 0xFF && data[offset + 1] === 0xD8) {
            const startIndex = offset;
            let ptr = offset + 2;
            let eoiFound = false;
            scannedSinceSoi = 0;

            const innerLoopGuard = createLoopGuard(data.length - startIndex, 'inner loop');

            while (ptr < data.length - 1) {
                if (innerLoopGuard.check()) {
                    break;
                }

                if (data[ptr] !== 0xFF) { ptr++; continue; }
                const marker = data[ptr + 1];
                if (marker === 0xFF) { ptr++; continue; }
                if (marker === 0x00) { ptr += 2; continue; }

                if (marker === 0xD9) { // EOI
                    const endIndex = ptr + 2;
                    const jpegData = data.slice(startIndex, endIndex);
                    if (jpegData.length > WORKER_CONSTANTS.MPO_MIN_JPEG_SIZE) {
                        jpegBlobs.push(new Blob([jpegData], { type: 'image/jpeg' }));
                    }
                    offset = endIndex;
                    eoiFound = true;
                    break;
                }

                if (marker === 0xDA) { // SOS - start of scan data (search until EOI)
                    ptr += 2;
                    let scanDataFound = false;
                    // After SOS, search for EOI (0xFFD9) with a size limit to prevent
                    // infinite loops. A single high-res embedded JPEG scan can exceed the
                    // fixed 10MB MPO_MAX_SCAN_LENGTH cap, which would cause valid files to
                    // report "No MPO images found". Bound the scan by the remaining buffer
                    // size instead (with the 10MB constant as a floor) so legitimate large
                    // scans complete; the per-loop ptr advance plus scanLoopGuard and the
                    // outer MAX_ABSOLUTE_ITERATIONS cap still bound total CPU work.
                    const maxScanSize = Math.max(WORKER_CONSTANTS.MPO_MAX_SCAN_LENGTH, data.length);
                    const scanStart = ptr;

                    const scanLoopGuard = createLoopGuard(maxScanSize, 'scan data loop');

                    while (ptr < data.length - 1) {
                        if (scanLoopGuard.check() || (ptr - scanStart > maxScanSize)) {
                            logger.warn('ImageWorker', `MPO extraction: Scan data exceeded limits (size: ${ptr - scanStart})`);
                            break;
                        }

                        if (data[ptr] === 0xFF && data[ptr + 1] === 0xD9) {
                            const endIndex = ptr + 2;
                            const jpegData = data.slice(startIndex, endIndex);
                            if (jpegData.length > WORKER_CONSTANTS.MPO_MIN_JPEG_SIZE) {
                                jpegBlobs.push(new Blob([jpegData], { type: 'image/jpeg' }));
                            }
                            offset = endIndex;
                            eoiFound = true;
                            scanDataFound = true;
                            break;
                        }
                        ptr++;
                    }
                    // If EOI not found, skip past the scanned region rather than
                    // rewinding to startIndex + 1. The scan looked for ANY 0xFFD9 in
                    // [scanStart, ptr), so no complete JPEG can end inside that range;
                    // rescanning it from the next SOI candidate would make a crafted
                    // file (repeated FF D8 FF DA with no EOI) quadratic — ~n/4 restarts
                    // × an O(n) scan each pegs the worker until the 60s load timeout
                    // terminates it, failing all other in-flight worker requests too.
                    if (!scanDataFound) {
                        offset = Math.max(ptr, startIndex + 1);
                    }
                    break;
                }

                // Standalone markers carry no length field: TEM (0x01) and RST0–7
                // (0xD0–0xD7). In a conforming stream these appear only inside
                // entropy-coded scan data (after SOS, handled above), so this only
                // hardens malformed/nonstandard input: otherwise the length-prefixed
                // branch below reads two payload bytes as a segment length and skips
                // an arbitrary distance, possibly past the real SOS/EOI and losing a
                // valid second eye.
                if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
                    ptr += 2;
                    continue;
                }

                if (ptr + 3 < data.length) {
                    const length = (data[ptr + 2] << 8) + data[ptr + 3];
                    // Guard against invalid length
                    if (length < 2 || ptr + 2 + length > data.length) {
                        ptr += 2;
                    } else {
                        ptr += 2 + length;
                    }
                } else {
                    ptr += 2;
                }
            }

            // If offset is not set in inner while loop, advance it
            if (!eoiFound) offset++;

        } else {
            offset++;
            scannedSinceSoi++;
        }
        if (scannedSinceSoi > maxScanLength) {
            logger.warn('ImageWorker', 'MPO extraction: Exceeded maximum scan length without finding SOI marker');
            break; // Use break instead of throw (allow partial extraction)
        }

        // Safety: ensure offset always advances to prevent infinite loop
        if (offset === initialOffset) {
            logger.warn('ImageWorker', 'MPO extraction: offset did not advance, forcing increment');
            offset++;
        }
    }
    return jpegBlobs;
}
