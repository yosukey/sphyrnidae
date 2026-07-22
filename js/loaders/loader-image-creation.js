/**
 * loader-image-creation.js
 * Image creation and compositing module
 * Combine left/right images and generate SBS images
 * Ensure generated images have even pixel dimensions
 */

import { showToast } from '../ui/ui-toast.js';
import * as THREE from 'three';
import { state, CONSTANTS, DEBUG } from '../globals.js';
import { sendWorkerMessage } from './loader-worker.js';
import { readExifDataFromBuffer, getCurrentExifToken, syncActiveExifState } from './loader-exif.js';
import { showLoadingProgress, hideLoadingProgress } from './loader-ui-progress.js';
import { updateSceneWithImage, getMaxTextureSize } from '../rendering/renderer.js';
import { ensureEven } from '../utils/pixel-utils.js';
import { validateDualImages } from './loader-pixel-validation.js';
import { resetUIStateAfterLoadError } from './loader-ui-progress.js';
import { readFileAsArrayBuffer, loadImageFromUrl, canvasToBlobAsync } from './loader-utils.js';
import { clearPreviousImageState } from './loader-state.js';
import * as logger from '../utils/logger.js';

/**
 * Helper to promisify Three.js TextureLoader.load
 * @param {string} url - Texture URL
 * @returns {Promise<THREE.Texture>}
 */
function loadTextureAsync(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) {
                settled = true;
                reject(new Error(`Texture load timed out after ${timeoutMs}ms`));
            }
        }, timeoutMs);

        const loader = state.textureLoader || new THREE.TextureLoader();
        loader.load(
            url,
            (texture) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(texture);
                }
            },
            undefined,
            (err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    // Three.js error callback may pass various types: Error, Event, string, or undefined
                    const errorMessage = err?.message || (typeof err === 'string' ? err : 'Unknown texture load error');
                    reject(new Error(`Texture load failed: ${errorMessage}`));
                }
            }
        );
    });
}

/**
 * Draw an image-like source (HTMLImageElement or canvas) into a temporary
 * canvas and extract its ImageData, releasing the canvas immediately.
 * Used both for the initial worker payload and to RE-extract fresh pixel data
 * for the main-thread fallback after the originals were transferred (detached).
 * @param {CanvasImageSource & {width: number, height: number}} source
 * @returns {ImageData}
 */
function extractImageData(source) {
    let canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    let ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context for ImageData extraction');
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, source.width, source.height);
    canvas.width = 0;
    canvas.height = 0;
    ctx = null;
    canvas = null;
    return imageData;
}

/**
 * Create an SBS image on the main thread (fallback when OffscreenCanvas is unsupported)
 * Ensure generated images have even pixel dimensions
 * @param {ImageData} leftImageData - Left image data
 * @param {ImageData} rightImageData - Right image data
 * @returns {Promise<ArrayBuffer>} SBS image ArrayBuffer
 */
export async function createSBSOnMainThread(leftImageData, rightImageData) {
    const leftWidth = leftImageData.width;
    const leftHeight = leftImageData.height;
    const rightWidth = rightImageData.width;
    const rightHeight = rightImageData.height;

    // Resolution check
    if (leftWidth !== rightWidth || leftHeight !== rightHeight) {
        throw new Error('Resolution mismatch');
    }

    // Generate SBS image (ensure even pixels)
    const evenEyeWidth = ensureEven(leftWidth);
    const evenHeight = ensureEven(leftHeight);
    const canvas = document.createElement('canvas');
    canvas.width = evenEyeWidth * 2;
    canvas.height = evenHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context for SBS canvas');

    // Left image (trim to even size)
    const tempCanvasL = document.createElement('canvas');
    tempCanvasL.width = leftWidth;
    tempCanvasL.height = leftHeight;
    const ctxTempL = tempCanvasL.getContext('2d');
    if (!ctxTempL) throw new Error('Failed to get 2D context for left temp canvas');
    ctxTempL.putImageData(leftImageData, 0, 0);
    ctx.drawImage(tempCanvasL, 0, 0, evenEyeWidth, evenHeight, 0, 0, evenEyeWidth, evenHeight);

    // Right image (trim to even size)
    const tempCanvasR = document.createElement('canvas');
    tempCanvasR.width = rightWidth;
    tempCanvasR.height = rightHeight;
    const ctxTempR = tempCanvasR.getContext('2d');
    if (!ctxTempR) throw new Error('Failed to get 2D context for right temp canvas');
    ctxTempR.putImageData(rightImageData, 0, 0);
    ctx.drawImage(tempCanvasR, 0, 0, evenEyeWidth, evenHeight, evenEyeWidth, 0, evenEyeWidth, evenHeight);

    try {
        // Convert to Blob
        return await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('Failed to create blob from canvas'));
                    return;
                }
                blob.arrayBuffer().then(resolve).catch(reject);
            }, 'image/jpeg', 0.95);
        });
    } finally {
        // Release canvas resources to prevent memory leaks
        canvas.width = 0;
        canvas.height = 0;
        tempCanvasL.width = 0;
        tempCanvasL.height = 0;
        tempCanvasR.width = 0;
        tempCanvasR.height = 0;
    }
}

/**
 * Generate an SBS image by placing two image Blobs side by side
 * Return an error if resolutions differ
 *
 * Important: this function returns a Blob. The caller is responsible for creating/revoking the Object URL
 *
 * @param {Blob} blobLeft - Left image Blob
 * @param {Blob} blobRight - Right image Blob
 * @returns {Promise<Blob>} SBS image Blob
 *
 * @example
 * // Caller responsibility: create/revoke the Object URL
 * try {
 *     const sbsBlob = await createSBSFromDualImages(blobLeft, blobRight);
 *     const sbsUrl = URL.createObjectURL(sbsBlob);
 *     try {
 *         loadTexture(sbsUrl); // Texture loading
 *     } finally {
 *         // Revoke Object URL after texture loading completes
 *         setTimeout(() => URL.revokeObjectURL(sbsUrl), 1000);
 *     }
 * } catch (err) {
 *     logger.error('LoaderImageCreation','SBS creation failed:', err);
 * }
 */
export async function createSBSFromDualImages(blobLeft, blobRight) {
    const leftUrl = URL.createObjectURL(blobLeft);
    const rightUrl = URL.createObjectURL(blobRight);

    try {
        // Load both images in parallel with proper timeout handling
        // Calculate timeout based on total file size (blobLeft + blobRight)
        // Base timeout: 10s, plus 1s per MB for slower networks
        const totalSize = blobLeft.size + blobRight.size;
        const sizeInMB = totalSize / (1024 * 1024);
        const calculatedTimeout = Math.max(10000, 10000 + (sizeInMB * 1000));

        // Cap timeout at FILE_LOAD_TIMEOUT_MS to prevent excessively long waits
        const timeout = Math.min(calculatedTimeout, CONSTANTS.FILE_LOAD_TIMEOUT_MS);

        if (DEBUG.RENDER_ERROR_LOG) {
            logger.debug('LOADER_LOG', 'LoaderImageCreation',`[Loader] ImageBitmap timeout: ${timeout}ms for ${sizeInMB.toFixed(2)}MB (${totalSize} bytes)`);
        }

        // Using a timeout that gets cleared on success to prevent timer leaks
        let timeoutId = null;
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error('Image load timeout'));
            }, timeout);
        });

        const loadPromise = Promise.all([loadImageFromUrl(leftUrl), loadImageFromUrl(rightUrl)]);
        // If the timeout wins, loadPromise stays pending and may reject later (a
        // decode failure after the deadline). Attach a no-op handler so that late
        // rejection is not reported as an unhandledrejection; the timeout error from
        // the race is the one propagated to the caller.
        loadPromise.catch(() => {});

        // Race between load and timeout
        const [imgL, imgR] = await Promise.race([loadPromise, timeoutPromise])
            .finally(() => {
                // Clear timeout to prevent timer leak
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            });

        // Resolution check
        if (imgL.width !== imgR.width || imgL.height !== imgR.height) {
            throw new Error(window.t?.('messages.resolutionMismatch', {
                leftWidth: imgL.width,
                leftHeight: imgL.height,
                rightWidth: imgR.width,
                rightHeight: imgR.height
            }) ?? `Resolution mismatch: L=${imgL.width}x${imgL.height}, R=${imgR.width}x${imgR.height}`);
        }

        // Ensure even pixels
        const evenEyeWidth = ensureEven(imgL.width);
        const evenHeight = ensureEven(imgL.height);
        const canvas = document.createElement('canvas');
        canvas.width = evenEyeWidth * 2;
        canvas.height = evenHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context for SBS canvas');

        // Trim to even size and draw
        ctx.drawImage(imgL, 0, 0, evenEyeWidth, evenHeight, 0, 0, evenEyeWidth, evenHeight);
        ctx.drawImage(imgR, 0, 0, evenEyeWidth, evenHeight, evenEyeWidth, 0, evenEyeWidth, evenHeight);

        // Convert canvas to a Blob
        const blob = await canvasToBlobAsync(canvas, 'image/jpeg', 0.95);

        return blob;
    } finally {
        URL.revokeObjectURL(leftUrl);
        URL.revokeObjectURL(rightUrl);
    }
}

/**
 * Load two individual image files and generate an SBS image
 * @param {File} fileLeft - Left image file
 * @param {File} fileRight - Right image file
 * @param {number} exifToken - Token for EXIF reading
 */
export async function loadDualImageFiles(fileLeft, fileRight, exifToken, myToken = null, getTokenFunc = null) {
    if (!fileLeft || !fileRight) {
        showToast(window.t?.('messages.selectBothImages') ?? 'Please select both left and right images', 'error');
        return;
    }

    // True once a newer load has superseded this one (the caller bumps the shared
    // file-load token). Used to avoid overwriting the newer load's scene and to
    // avoid touching its shared progress/error UI.
    const isStale = () => myToken !== null && getTokenFunc && getTokenFunc() !== myToken;
    // Guard the shared progress bar so a superseded load cannot overwrite a newer
    // load's progress display. Mirrors loader-mpo.js's safeProgress.
    const safeProgress = (p) => { if (!isStale()) showLoadingProgress(p); };

    // Clear current Three.js resources (mesh/material/texture) before loading dual images
    // to prevent GPU memory leaks on consecutive loads
    clearPreviousImageState();

    try {
        showLoadingProgress(0);

        // Read left/right files in parallel
        const [leftBuffer, rightBuffer] = await Promise.all([
            readFileAsArrayBuffer(fileLeft),
            readFileAsArrayBuffer(fileRight)
        ]);
        safeProgress(30);

        // Read EXIF from both files (in parallel)
        const [leftExif, rightExif] = await Promise.all([
            readExifDataFromBuffer(leftBuffer, 'left', exifToken),
            readExifDataFromBuffer(rightBuffer, 'right', exifToken)
        ]);

        // Store in state only if the token is valid
        if (getCurrentExifToken() === exifToken) {
            state.exifDataLeft = leftExif.tags;
            state.exifThumbnailLeft = leftExif.thumbnail;
            state.exifRawSegmentLeft = leftExif.rawSegment;
            state.exifDataRight = rightExif.tags;
            state.exifThumbnailRight = rightExif.thumbnail;
            state.exifRawSegmentRight = rightExif.rawSegment;
            syncActiveExifState();

            const hasExif = !!(leftExif.tags || rightExif.tags);
            const hasThumbnail = !!(leftExif.thumbnail || rightExif.thumbnail);
            window.dispatchEvent(new CustomEvent('exif-loaded', { detail: { hasExif, hasThumbnail } }));
        }

        // Convert image to Blob and create Object URL
        const leftBlob = new Blob([leftBuffer], { type: fileLeft.type || 'image/jpeg' });
        const rightBlob = new Blob([rightBuffer], { type: fileRight.type || 'image/jpeg' });
        const leftUrl = URL.createObjectURL(leftBlob);
        const rightUrl = URL.createObjectURL(rightBlob);
        // Declared here (not inside the success path) so the finally block can revoke
        // it on any error thrown between its creation and the deferred rAF revoke.
        let sbsUrl = null;
        // Set once ownership of sbsUrl is handed to the deferred (double-rAF) revoke.
        // While false, the finally block is responsible for revoking sbsUrl.
        let sbsUrlRevokeScheduled = false;

        try {
            // Load both images in parallel
            const [imgL, imgR] = await Promise.all([
                loadImageFromUrl(leftUrl),
                loadImageFromUrl(rightUrl)
            ]);
            safeProgress(40);

            // Resolution check
            if (imgL.width !== imgR.width || imgL.height !== imgR.height) {
                throw new Error(window.t?.('messages.resolutionMismatch', {
                    leftWidth: imgL.width,
                    leftHeight: imgL.height,
                    rightWidth: imgR.width,
                    rightHeight: imgR.height
                }) ?? `Resolution mismatch: L=${imgL.width}x${imgL.height}, R=${imgR.width}x${imgR.height}`);
            }

            // Pixel validation (for odd pixels)
            const validation = await validateDualImages(imgL, imgR);
            if (validation.action === 'cancel') {
                // The cancel may have been forced by a newer load's clearDialogQueue();
                // in that case do not touch the newer load's progress UI.
                if (!isStale()) {
                    hideLoadingProgress();
                    resetUIStateAfterLoadError();
                }
                return;
            }

            // Draw to canvas and extract ImageData (temporary canvases are
            // released inside the helper)
            const leftImageData = extractImageData(validation.imgL);
            const rightImageData = extractImageData(validation.imgR);

            // URL cleanup is handled in the finally block

            // Generate SBS in the Worker
            let sbsBuffer;
            try {
                const result = await sendWorkerMessage(
                    {
                        type: 'createSBSFromDualImages',
                        payload: {
                            leftImageData: leftImageData,
                            rightImageData: rightImageData
                        }
                    },
                    (progress) => {
                        const totalProgress = 40 + (progress.progress * 0.6);
                        safeProgress(totalProgress);
                    },
                    null,
                    // Transfer the pixel buffers instead of structured-cloning them
                    // (8 bytes/px across both eyes — ~96MB for two 12MP images).
                    // Cloning that on the main thread stalls the UI at the exact
                    // peak-memory moment the worker exists to keep smooth. The
                    // worker response already transfers its result back.
                    [leftImageData.data.buffer, rightImageData.data.buffer]
                );

                if (result.type === 'createSBS-complete') {
                    sbsBuffer = result.arrayBuffer;
                } else {
                    throw new Error('Unexpected worker response');
                }
            } catch (err) {
                // Fallback to the main thread if OffscreenCanvas is unsupported
                if (err.message && err.message.includes('OFFSCREEN_CANVAS_NOT_SUPPORTED')) {
                    logger.warn('LoaderImageCreation','OffscreenCanvas not supported for SBS creation, falling back to main thread');
                    // leftImageData/rightImageData were transferred to the worker —
                    // this error is only thrown by the worker AFTER receiving the
                    // message, so their buffers are detached here. Re-extract fresh
                    // ImageData from the still-alive source images (leftUrl/rightUrl
                    // are revoked only in the outer finally) for the fallback.
                    sbsBuffer = await createSBSOnMainThread(
                        extractImageData(validation.imgL),
                        extractImageData(validation.imgR)
                    );
                } else {
                    throw err;
                }
            }

            // Texture loading
            safeProgress(100);
            const sbsBlob = new Blob([sbsBuffer], { type: 'image/jpeg' });
            sbsUrl = URL.createObjectURL(sbsBlob);

            const texture = await loadTextureAsync(sbsUrl);
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;

            const maxSize = getMaxTextureSize();
            if (texture.image.width > maxSize || texture.image.height > maxSize) {
                logger.warn('LoaderImageCreation',
                    `[DualImageCreation] Image size (${texture.image.width}x${texture.image.height}) ` +
                    `exceeds GPU max texture size (${maxSize}x${maxSize}). ` +
                    `Performance may be degraded or rendering may fail.`
                );
            }

            // A newer load superseded this one while it was processing — dispose
            // the decoded texture and skip displaying it / updating UI so the newer
            // image is not overwritten. The finally block still revokes the URLs.
            if (isStale()) {
                texture.dispose();
                return;
            }

            updateSceneWithImage(texture);

            // Use requestAnimationFrame to wait for next frame (texture upload happens during render)
            // Then use another rAF to ensure the upload is fully processed.
            // Hand ownership of sbsUrl to this deferred revoke so the finally block
            // does not revoke it prematurely (before the GPU upload completes).
            sbsUrlRevokeScheduled = true;
            const deferredSbsUrl = sbsUrl;
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    URL.revokeObjectURL(deferredSbsUrl);
                    // Guard the progress hide: a newer load may have started and shown
                    // its own progress overlay in the ~2 frames since this load
                    // finished, and hiding unconditionally would remove the newer
                    // load's overlay. The URL revoke above is unconditional (it owns
                    // this load's blob). Matches the stale-guard pattern used by the
                    // other deferred hides (loader.js, loader-mpo.js).
                    if (!isStale()) hideLoadingProgress();
                });
            });

            // Update filename
            const namePartsLeft = fileLeft.name.split('.');
            if (namePartsLeft.length > 1) namePartsLeft.pop();
            const namePartsRight = fileRight.name.split('.');
            if (namePartsRight.length > 1) namePartsRight.pop();
            const baseName = namePartsLeft.join('.') + '_' + namePartsRight.join('.');
            state.originalFileNameBase = baseName;

            window.dispatchEvent(new CustomEvent('dual-images-loaded', {
                detail: { baseName, leftName: fileLeft.name, rightName: fileRight.name }
            }));
        } finally {
            URL.revokeObjectURL(leftUrl);
            URL.revokeObjectURL(rightUrl);
            // Revoke sbsUrl here if an error short-circuited the success path before
            // the deferred (double-rAF) revoke took ownership of it. Once that revoke
            // is scheduled, sbsUrlRevokeScheduled is true and we leave it alone.
            if (sbsUrl && !sbsUrlRevokeScheduled) {
                URL.revokeObjectURL(sbsUrl);
            }
        }
    } catch (err) {
        logger.error('LoaderImageCreation',err);
        // Skip the error toast / progress teardown if a newer load already owns the
        // shared UI, so a stale dual-load failure cannot disrupt the in-flight load.
        if (!isStale()) {
            showToast(window.t?.('messages.combineFailed') ?? 'Failed to combine images', 'error');
            hideLoadingProgress();
            // Re-enable the load controls / file inputs, matching every other load
            // failure path (loader.js, loader-mpo.js, the cancel path above). Without
            // this a dual-load failure leaves the controls disabled.
            resetUIStateAfterLoadError();
        }
    }
}
