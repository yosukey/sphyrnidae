/**
 * loader-image-processing.js
 * Image processing module
 * Image format conversion (SBS, TaB, interlace, etc.)
 * Ensure processed images have even pixel dimensions
 */

import { showLoadingProgress, hideLoadingProgress } from './loader-ui-progress.js';
import * as logger from '../utils/logger.js';
import { ensureEven } from '../utils/pixel-utils.js';
import { canvasToBlobAsync } from './loader-utils.js';
import { createAndTrackBlobUrl } from './loader.js';

/**
 * Helper to get 2D canvas context with error checking
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @returns {CanvasRenderingContext2D}
 * @throws {Error} If 2D context cannot be obtained
 */
function get2DContext(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Failed to get 2D canvas context');
    }
    return ctx;
}

/**
 * Run image processing on the main thread (fallback when OffscreenCanvas is unsupported)
 * @param {ImageBitmap} imageBitmap - Image to process
 * @param {string} format - Format
 * @param {string} filename - Filename
 * @param {Function} loadTextureCallback - Callback after texture load
 * @param {Function} [isStale] - Returns true if a newer load has superseded this
 *   one. Used to gate the SHARED loading-overlay calls: this fallback can take tens
 *   of seconds (large-canvas toBlob) during which the user may start another load,
 *   and without this guard it would overwrite that load's progress and then hide
 *   its overlay 300ms later. The texture load is already token-guarded by the
 *   caller. Defaults to never-stale.
 */
export async function processImageOnMainThread(imageBitmap, format, filename, loadTextureCallback, isStale = () => false) {
    let canvas = null;
    let resultCanvas = null;
    const safeProgress = (pct) => { if (!isStale()) showLoadingProgress(pct); };
    const safeHideProgress = () => { if (!isStale()) hideLoadingProgress(); };

    try {
        safeProgress(30);

        canvas = document.createElement('canvas');
        const srcWidth = imageBitmap.width;
        const srcHeight = imageBitmap.height;

        canvas.width = srcWidth;
        canvas.height = srcHeight;
        const ctx = get2DContext(canvas);

        // Draw the ImageBitmap
        ctx.drawImage(imageBitmap, 0, 0);

        // Close the ImageBitmap (release memory)
        if (imageBitmap.close) {
            imageBitmap.close();
        }

        safeProgress(50);

        // Format conversion processing
        resultCanvas = processImageWithFormat({ width: srcWidth, height: srcHeight, canvas }, format, ctx);

        safeProgress(90);

        // Scale timeout based on canvas pixel count (base 30s + 1s per megapixel)
        const megapixels = (resultCanvas.width * resultCanvas.height) / (1024 * 1024);
        const blobTimeoutMs = Math.min(120000, Math.max(30000, 30000 + megapixels * 1000));
        const blobPromise = canvasToBlobAsync(resultCanvas, 'image/png');
        // If the timeout wins the race, blobPromise stays pending; the finally block
        // below zeroes the canvas, which makes the still-pending toBlob call back with
        // null and reject. Attach a no-op handler so that late rejection does not
        // surface as an unhandledrejection — the timeout error from the race is the
        // one we actually report.
        blobPromise.catch(() => {});
        let blobTimeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            blobTimeoutId = setTimeout(() => reject(new Error('Canvas to blob conversion timeout')), blobTimeoutMs);
        });

        const blob = await Promise.race([blobPromise, timeoutPromise]).finally(() => {
            if (blobTimeoutId) clearTimeout(blobTimeoutId);
        });
        const url = createAndTrackBlobUrl(blob);
        safeProgress(100);
        // Texture decode is part of the load operation. Await it so a corrupt
        // result is reported to the caller instead of being treated as success.
        await loadTextureCallback(url);
        setTimeout(() => safeHideProgress(), 300);

    } catch (err) {
        logger.error('ImageProcessing', 'Main thread processing error:', err);
        throw err;
    } finally {
        // Ensure ImageBitmap is always released, even if drawImage threw before the
        // close() call in the try block could execute. imageBitmap.close() is idempotent
        // (calling it twice is safe per spec), so this guard only prevents leaks on error.
        if (imageBitmap && typeof imageBitmap.close === 'function') {
            try { imageBitmap.close(); } catch (_) { /* ignore */ }
        }

        // This is especially important for large images to prevent memory pressure.
        // Release each distinct canvas exactly once via a Set. When processImageWithFormat
        // returns the source canvas unchanged (e.g. an already-even full_sbs or the
        // default branch), canvas === resultCanvas; a pair of per-reference !== guards
        // would both be false in that case and fail to detect the alias, leaving the
        // full-resolution canvas unzeroed until GC — exactly the memory pressure this
        // release is meant to avoid on the low-memory devices this main-thread fallback
        // exists for.
        const canvasesToRelease = new Set();
        if (canvas) canvasesToRelease.add(canvas);
        if (resultCanvas) canvasesToRelease.add(resultCanvas);
        for (const c of canvasesToRelease) {
            try {
                const ctx = c.getContext('2d');
                if (ctx) {
                    ctx.clearRect(0, 0, c.width, c.height);
                }
                // Set dimensions to zero to explicitly release memory
                c.width = 0;
                c.height = 0;
            } catch (err) {
                logger.warn('ImageProcessing', 'Error clearing canvas context:', err);
            }
        }

        // Clear references
        canvas = null;
        resultCanvas = null;
    }
}

/**
 * Draw an image onto an even-sized 2D canvas and read back its pixels. Factors out
 * the decode -> canvas -> getImageData step used by the MPO loader (and any future
 * dual-image path) so the main-thread SBS fallback and the worker path agree on the
 * even-trim geometry. The scratch canvas is released before returning.
 *
 * @param {CanvasImageSource} image - decoded image (HTMLImageElement / ImageBitmap)
 * @param {number} width - target (even) width in px
 * @param {number} height - target (even) height in px
 * @returns {ImageData}
 */
export function extractImageData(image, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
        const ctx = get2DContext(canvas);
        // 9-arg drawImage: take the top-left width x height region 1:1 (trims odd pixels).
        ctx.drawImage(image, 0, 0, width, height, 0, 0, width, height);
        return ctx.getImageData(0, 0, width, height);
    } finally {
        // Release the scratch canvas immediately (important for large images).
        canvas.width = 0;
        canvas.height = 0;
    }
}

/**
 * Compose two equal-size eye ImageData objects into a side-by-side (SBS) JPEG blob
 * ON THE MAIN THREAD. This is the fallback for browsers without OffscreenCanvas
 * (e.g. Safari < 16.4), where the worker's createSBSFromDualImages throws
 * OFFSCREEN_CANVAS_NOT_SUPPORTED and .mpo files would otherwise hard-fail. It mirrors
 * the worker's handleCreateSBS exactly — even-eye trim, eye placement, JPEG quality
 * 0.95, and blob timeout scaling — so both paths produce the same pixels.
 *
 * Unlike the worker path, this does NOT transfer/detach the ImageData buffers, so the
 * caller must route here WITHOUT transferring them.
 *
 * @param {ImageData} leftImageData - left eye (already even-sized by the caller)
 * @param {ImageData} rightImageData - right eye (same dimensions as left)
 * @returns {Promise<Blob>} SBS JPEG blob (even eyeWidth*2 x even height)
 */
export async function composeSBSFromDualImageDataOnMainThread(leftImageData, rightImageData) {
    const leftWidth = leftImageData.width;
    const leftHeight = leftImageData.height;
    const rightWidth = rightImageData.width;
    const rightHeight = rightImageData.height;

    // Resolution check (matches the worker). The loader validates image sizes earlier,
    // but the ImageData pair is re-checked here so this helper is safe standalone.
    if (leftWidth !== rightWidth || leftHeight !== rightHeight) {
        throw new Error('Resolution mismatch');
    }

    // Ensure even pixels (a no-op when the caller already even-sized the eyes, which
    // keeps the output byte-identical to the worker path that re-applies ensureEven).
    const evenEyeWidth = ensureEven(leftWidth);
    const evenHeight = ensureEven(leftHeight);

    let sbsCanvas = document.createElement('canvas');
    let tempCanvasL = null;
    let tempCanvasR = null;
    try {
        sbsCanvas.width = evenEyeWidth * 2;
        sbsCanvas.height = evenHeight;
        const ctx = get2DContext(sbsCanvas);

        // Left eye -> left half (trim to even size).
        tempCanvasL = document.createElement('canvas');
        tempCanvasL.width = leftWidth;
        tempCanvasL.height = leftHeight;
        get2DContext(tempCanvasL).putImageData(leftImageData, 0, 0);
        ctx.drawImage(tempCanvasL, 0, 0, evenEyeWidth, evenHeight, 0, 0, evenEyeWidth, evenHeight);
        cleanupCanvas(tempCanvasL);
        tempCanvasL = null;

        // Right eye -> right half (trim to even size).
        tempCanvasR = document.createElement('canvas');
        tempCanvasR.width = rightWidth;
        tempCanvasR.height = rightHeight;
        get2DContext(tempCanvasR).putImageData(rightImageData, 0, 0);
        ctx.drawImage(tempCanvasR, 0, 0, evenEyeWidth, evenHeight, evenEyeWidth, 0, evenEyeWidth, evenHeight);
        cleanupCanvas(tempCanvasR);
        tempCanvasR = null;

        // Convert to a JPEG blob with the same timeout scaling as the worker.
        const megapixels = (sbsCanvas.width * sbsCanvas.height) / (1024 * 1024);
        const blobTimeoutMs = Math.min(120000, Math.max(30000, 30000 + megapixels * 1000));
        const blobPromise = canvasToBlobAsync(sbsCanvas, 'image/jpeg', 0.95);
        // Swallow a late rejection if the timeout wins and the finally below releases
        // the canvas out from under the still-pending toBlob (avoids unhandledrejection).
        blobPromise.catch(() => {});
        let blobTimeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            blobTimeoutId = setTimeout(() => reject(new Error('Canvas to blob conversion timeout')), blobTimeoutMs);
        });
        const blob = await Promise.race([blobPromise, timeoutPromise]).finally(() => {
            if (blobTimeoutId) clearTimeout(blobTimeoutId);
        });
        return blob;
    } finally {
        // Release all canvases even on error (large images cause memory pressure).
        if (tempCanvasL) cleanupCanvas(tempCanvasL);
        if (tempCanvasR) cleanupCanvas(tempCanvasR);
        cleanupCanvas(sbsCanvas);
        sbsCanvas = null;
    }
}

/**
 * Helper to cleanup intermediate canvas
 * @param {HTMLCanvasElement} canvas - Canvas to cleanup
 */
function cleanupCanvas(canvas) {
    if (!canvas) return;
    try {
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        // Set dimensions to zero to explicitly release memory
        canvas.width = 0;
        canvas.height = 0;
    } catch (err) {
        logger.warn('ImageProcessing', 'Error cleaning up canvas:', err);
    }
}

/**
 * Process the image based on format
 * Ensure processed images have even pixel dimensions
 * @param {Object} image - Image object (has width and height)
 * @param {string} format - Format
 * @param {CanvasRenderingContext2D} sourceCtx - Source context (optional)
 * @returns {HTMLCanvasElement} Processed canvas
 */
export function processImageWithFormat(image, format, sourceCtx = null) {
    const srcWidth = image.width;
    const srcHeight = image.height;

    // Prepare the source canvas
    let sourceCanvas;
    if (sourceCtx) {
        sourceCanvas = sourceCtx.canvas;
    } else if (image.canvas) {
        sourceCanvas = image.canvas;
    } else {
        // When image is an HTMLImageElement
        sourceCanvas = document.createElement('canvas');
        sourceCanvas.width = srcWidth;
        sourceCanvas.height = srcHeight;
        const ctx = get2DContext(sourceCanvas);
        ctx.drawImage(image, 0, 0);
    }

    let resultCanvas = sourceCanvas;
    let resultCtx = get2DContext(resultCanvas);

    switch (format) {
        case 'full_sbs': {
            // Full SBS: trim as needed to ensure even pixels
            const evenWidth = ensureEven(srcWidth);
            const evenHeight = ensureEven(srcHeight);
            if (evenWidth !== srcWidth || evenHeight !== srcHeight) {
                resultCanvas = document.createElement('canvas');
                resultCanvas.width = evenWidth;
                resultCanvas.height = evenHeight;
                resultCtx = get2DContext(resultCanvas);
                resultCtx.drawImage(sourceCanvas, 0, 0, evenWidth, evenHeight, 0, 0, evenWidth, evenHeight);
                logger.debug('LOADER_LOG', 'ImageProcessing', `Full SBS: ${srcWidth}x${srcHeight} → ${evenWidth}x${evenHeight} (even pixel adjustment)`);
            }
            break;
        }

        case 'half_sbs': {
            // Double the width (ensure even pixels)
            const newWidth = ensureEven(srcWidth * 2);
            const newHeight = ensureEven(srcHeight);
            resultCanvas = document.createElement('canvas');
            resultCanvas.width = newWidth;
            resultCanvas.height = newHeight;
            resultCtx = get2DContext(resultCanvas);
            resultCtx.drawImage(sourceCanvas, 0, 0, srcWidth, srcHeight, 0, 0, newWidth, newHeight);
            logger.debug('LOADER_LOG', 'ImageProcessing', `Half SBS: ${srcWidth}x${srcHeight} → ${newWidth}x${newHeight}`);
            break;
        }

        case 'full_tab': {
            // Place left/right side by side (ensure even pixels)
            const halfHeight = Math.floor(srcHeight / 2);
            const newWidth = ensureEven(srcWidth * 2);
            const newHeight = ensureEven(halfHeight);
            resultCanvas = document.createElement('canvas');
            resultCanvas.width = newWidth;
            resultCanvas.height = newHeight;
            resultCtx = get2DContext(resultCanvas);
            // Upper half (left eye) goes to the left
            resultCtx.drawImage(sourceCanvas, 0, 0, srcWidth, halfHeight, 0, 0, srcWidth, newHeight);
            // Lower half (right eye) goes to the right
            resultCtx.drawImage(sourceCanvas, 0, halfHeight, srcWidth, halfHeight, srcWidth, 0, srcWidth, newHeight);
            logger.debug('LOADER_LOG', 'ImageProcessing', `Full TaB: ${srcWidth}x${srcHeight} → ${newWidth}x${newHeight}`);
            break;
        }

        case 'half_tab': {
            // Double the height and then place left/right (ensure even pixels)
            const halfHeight = Math.floor(srcHeight / 2);
            const newWidth = ensureEven(srcWidth * 2);
            const newHeight = ensureEven(halfHeight * 2);
            resultCanvas = document.createElement('canvas');
            resultCanvas.width = newWidth;
            resultCanvas.height = newHeight;
            resultCtx = get2DContext(resultCanvas);
            // Upper half (left eye) goes to the left, double height
            resultCtx.drawImage(sourceCanvas, 0, 0, srcWidth, halfHeight, 0, 0, srcWidth, newHeight);
            // Lower half (right eye) goes to the right, double height
            resultCtx.drawImage(sourceCanvas, 0, halfHeight, srcWidth, halfHeight, srcWidth, 0, srcWidth, newHeight);
            logger.debug('LOADER_LOG', 'ImageProcessing', `Half TaB: ${srcWidth}x${srcHeight} → ${newWidth}x${newHeight}`);
            break;
        }

        case 'interlace_h': {
            // Horizontal line interlace (ensure even pixels)
            const halfHeight = Math.floor(srcHeight / 2);
            const leftCanvas = document.createElement('canvas');
            leftCanvas.width = srcWidth;
            leftCanvas.height = halfHeight;
            const leftCtx = get2DContext(leftCanvas);

            const rightCanvas = document.createElement('canvas');
            rightCanvas.width = srcWidth;
            rightCanvas.height = halfHeight;
            const rightCtx = get2DContext(rightCanvas);

            // Bulk deinterlace: read all pixels once, then split even/odd rows
            const srcCtx = get2DContext(sourceCanvas);
            const srcData = srcCtx.getImageData(0, 0, srcWidth, srcHeight);
            const srcPixels = srcData.data;
            const leftData = leftCtx.createImageData(srcWidth, halfHeight);
            const rightData = rightCtx.createImageData(srcWidth, halfHeight);
            const leftPixels = leftData.data;
            const rightPixels = rightData.data;
            const rowBytes = srcWidth * 4;
            for (let y = 0; y < halfHeight; y++) {
                const srcEvenOffset = y * 2 * rowBytes;
                const srcOddOffset = (y * 2 + 1) * rowBytes;
                const dstOffset = y * rowBytes;
                leftPixels.set(srcPixels.subarray(srcEvenOffset, srcEvenOffset + rowBytes), dstOffset);
                rightPixels.set(srcPixels.subarray(srcOddOffset, srcOddOffset + rowBytes), dstOffset);
            }
            leftCtx.putImageData(leftData, 0, 0);
            rightCtx.putImageData(rightData, 0, 0);

            // Double the height (ensure even pixels)
            const newWidth = ensureEven(srcWidth);
            const newHeight = ensureEven(srcHeight);
            const expandedLeftCanvas = document.createElement('canvas');
            expandedLeftCanvas.width = newWidth;
            expandedLeftCanvas.height = newHeight;
            get2DContext(expandedLeftCanvas).drawImage(leftCanvas, 0, 0, srcWidth, halfHeight, 0, 0, newWidth, newHeight);

            const expandedRightCanvas = document.createElement('canvas');
            expandedRightCanvas.width = newWidth;
            expandedRightCanvas.height = newHeight;
            get2DContext(expandedRightCanvas).drawImage(rightCanvas, 0, 0, srcWidth, halfHeight, 0, 0, newWidth, newHeight);

            // Arrange in SBS format
            resultCanvas = document.createElement('canvas');
            resultCanvas.width = newWidth * 2;
            resultCanvas.height = newHeight;
            resultCtx = get2DContext(resultCanvas);
            resultCtx.drawImage(expandedLeftCanvas, 0, 0);
            resultCtx.drawImage(expandedRightCanvas, newWidth, 0);
            logger.debug('LOADER_LOG', 'ImageProcessing', `Interlace H: ${srcWidth}x${srcHeight} → ${newWidth * 2}x${newHeight}`);

            cleanupCanvas(leftCanvas);
            cleanupCanvas(rightCanvas);
            cleanupCanvas(expandedLeftCanvas);
            cleanupCanvas(expandedRightCanvas);
            break;
        }

        case 'interlace_v': {
            // Vertical line interlace (ensure even pixels)
            const halfWidth = Math.floor(srcWidth / 2);
            const leftCanvas = document.createElement('canvas');
            leftCanvas.width = halfWidth;
            leftCanvas.height = srcHeight;
            const leftCtx = get2DContext(leftCanvas);

            const rightCanvas = document.createElement('canvas');
            rightCanvas.width = halfWidth;
            rightCanvas.height = srcHeight;
            const rightCtx = get2DContext(rightCanvas);

            // Bulk deinterlace: read all pixels once, then split even/odd columns
            const srcCtx = get2DContext(sourceCanvas);
            const srcData = srcCtx.getImageData(0, 0, srcWidth, srcHeight);
            const srcPixels = srcData.data;
            const leftData = leftCtx.createImageData(halfWidth, srcHeight);
            const rightData = rightCtx.createImageData(halfWidth, srcHeight);
            const leftPixels = leftData.data;
            const rightPixels = rightData.data;
            for (let y = 0; y < srcHeight; y++) {
                const srcRowOffset = y * srcWidth * 4;
                const dstRowOffset = y * halfWidth * 4;
                for (let x = 0; x < halfWidth; x++) {
                    const srcEvenIdx = srcRowOffset + x * 2 * 4;
                    const srcOddIdx = srcRowOffset + (x * 2 + 1) * 4;
                    const dstIdx = dstRowOffset + x * 4;
                    leftPixels[dstIdx]     = srcPixels[srcEvenIdx];
                    leftPixels[dstIdx + 1] = srcPixels[srcEvenIdx + 1];
                    leftPixels[dstIdx + 2] = srcPixels[srcEvenIdx + 2];
                    leftPixels[dstIdx + 3] = srcPixels[srcEvenIdx + 3];
                    rightPixels[dstIdx]     = srcPixels[srcOddIdx];
                    rightPixels[dstIdx + 1] = srcPixels[srcOddIdx + 1];
                    rightPixels[dstIdx + 2] = srcPixels[srcOddIdx + 2];
                    rightPixels[dstIdx + 3] = srcPixels[srcOddIdx + 3];
                }
            }
            leftCtx.putImageData(leftData, 0, 0);
            rightCtx.putImageData(rightData, 0, 0);

            // Double the width (ensure even pixels)
            const newWidth = ensureEven(srcWidth);
            const newHeight = ensureEven(srcHeight);
            const expandedLeftCanvas = document.createElement('canvas');
            expandedLeftCanvas.width = newWidth;
            expandedLeftCanvas.height = newHeight;
            get2DContext(expandedLeftCanvas).drawImage(leftCanvas, 0, 0, halfWidth, srcHeight, 0, 0, newWidth, newHeight);

            const expandedRightCanvas = document.createElement('canvas');
            expandedRightCanvas.width = newWidth;
            expandedRightCanvas.height = newHeight;
            get2DContext(expandedRightCanvas).drawImage(rightCanvas, 0, 0, halfWidth, srcHeight, 0, 0, newWidth, newHeight);

            // Arrange in SBS format
            resultCanvas = document.createElement('canvas');
            resultCanvas.width = newWidth * 2;
            resultCanvas.height = newHeight;
            resultCtx = get2DContext(resultCanvas);
            resultCtx.drawImage(expandedLeftCanvas, 0, 0);
            resultCtx.drawImage(expandedRightCanvas, newWidth, 0);
            logger.debug('LOADER_LOG', 'ImageProcessing', `Interlace V: ${srcWidth}x${srcHeight} → ${newWidth * 2}x${newHeight}`);

            cleanupCanvas(leftCanvas);
            cleanupCanvas(rightCanvas);
            cleanupCanvas(expandedLeftCanvas);
            cleanupCanvas(expandedRightCanvas);
            break;
        }

        default:
            // Default: leave as-is (but ensure even pixels)
            {
                const evenWidth = ensureEven(srcWidth);
                const evenHeight = ensureEven(srcHeight);
                if (evenWidth !== srcWidth || evenHeight !== srcHeight) {
                    resultCanvas = document.createElement('canvas');
                    resultCanvas.width = evenWidth;
                    resultCanvas.height = evenHeight;
                    resultCtx = get2DContext(resultCanvas);
                    resultCtx.drawImage(sourceCanvas, 0, 0, evenWidth, evenHeight, 0, 0, evenWidth, evenHeight);
                }
            }
            break;
    }

    return resultCanvas;
}
