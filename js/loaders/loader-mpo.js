/**
 * loader-mpo.js
 * MPO file processing module
 * Extract and process JPEGs from MPO (Multi-Picture Object) files
 * Ensure generated images have even pixel dimensions
 */

import { sendWorkerMessage } from './loader-worker.js';
import * as logger from '../utils/logger.js';
import { readExifDataFromBuffer, getCurrentExifToken } from './loader-exif.js';
import { syncActiveExifState } from './loader-exif.js';
import { readFileAsArrayBuffer, loadImageFromUrl } from './loader-utils.js';
import { showLoadingProgress, hideLoadingProgress } from './loader-ui-progress.js';
import { state } from '../globals.js';
import { ensureEven } from '../utils/pixel-utils.js';
import { validateDualImages } from './loader-pixel-validation.js';
import { showToast } from '../ui/ui-toast.js';
import { resetUIStateAfterLoadError } from './loader-ui-progress.js';
import { createAndTrackBlobUrl } from './loader.js';
import { extractImageData, composeSBSFromDualImageDataOnMainThread } from './loader-image-processing.js';

/**
 * Process an MPO file (async/await version)
 * @param {File} file - MPO file
 * @param {Function} loadTextureCallback - Callback after texture load
 * @param {number} exifToken - Token for EXIF loading
 * @param {number|null} myToken - This load's generation token (optional)
 * @param {Function|null} getTokenFunc - Returns the current generation token (optional)
 */
export async function processMPOFile(file, loadTextureCallback, exifToken, myToken = null, getTokenFunc = null) {
    // A superseded load (a newer file load bumped the token) must not touch the
    // shared loading UI — the newer load now owns the progress bar / toasts /
    // error reset. Mirror the invariant the normal-image path enforces in
    // loader.js. When no token is supplied, staleness checking is skipped entirely.
    const isStale = () => myToken !== null && typeof getTokenFunc === 'function' && getTokenFunc() !== myToken;
    const safeProgress = (p) => { if (!isStale()) showLoadingProgress(p); };
    const safeHideProgress = () => { if (!isStale()) hideLoadingProgress(); };
    const safeToast = (msg, type, duration) => { if (!isStale()) showToast(msg, type, duration); };
    const safeResetUI = () => { if (!isStale()) resetUIStateAfterLoadError(); };

    safeProgress(0);

    let leftUrl = null;
    let rightUrl = null;

    try {
        // Read file (0-30%)
        const buffer = await readFileAsArrayBuffer(file, (loaded, total) => {
            const percentComplete = Math.round((loaded / total) * 30);
            safeProgress(percentComplete);
        });

        // Extract JPEG from MPO (30-70%)
        // Transfer the file buffer instead of structured-cloning it (MPO files
        // are tens of MB and the clone would stall the main thread). The buffer
        // is not referenced again after this call on any path — the JPEGs come
        // back in result.arrayBuffers (already transferred by the worker).
        const result = await sendWorkerMessage(
            {
                type: 'extractJpegsFromMpo',
                payload: { mpoArrayBuffer: buffer }
            },
            (progress) => {
                const totalProgress = 30 + (progress.progress * 0.4);
                safeProgress(totalProgress);
            },
            null,
            [buffer]
        );

        if (result.type !== 'extractMpo-complete') {
            throw new Error('MPO extraction failed');
        }

        const arrayBuffers = result.arrayBuffers;
        safeProgress(70);

        if (arrayBuffers.length < 2) {
            safeToast(window.t?.('messages.noMPOImages') ?? 'No MPO images found', 'error');
            safeHideProgress();
            safeResetUI();
            return;
        }

        // Read EXIF from left/right JPEG buffers (in parallel)
        const [leftExif, rightExif] = await Promise.all([
            readExifDataFromBuffer(arrayBuffers[0], 'left', exifToken),
            readExifDataFromBuffer(arrayBuffers[1], 'right', exifToken)
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

        // Create Image on the main thread
        // IMPORTANT: Create blob URLs inside try block to ensure finally cleanup works
        try {
            const leftBlob = new Blob([arrayBuffers[0]], { type: 'image/jpeg' });
            const rightBlob = new Blob([arrayBuffers[1]], { type: 'image/jpeg' });
            leftUrl = URL.createObjectURL(leftBlob);
            rightUrl = URL.createObjectURL(rightBlob);

            // Load images in parallel
            const [imgL, imgR] = await Promise.all([
                loadImageFromUrl(leftUrl),
                loadImageFromUrl(rightUrl)
            ]);

            safeProgress(75);

            // Resolution check
            // Note: Early return here is safe - the finally block will clean up leftUrl/rightUrl
            if (imgL.width !== imgR.width || imgL.height !== imgR.height) {
                safeToast(window.t?.('messages.resolutionMismatch', {
                    leftWidth: imgL.width,
                    leftHeight: imgL.height,
                    rightWidth: imgR.width,
                    rightHeight: imgR.height
                }) ?? `Resolution mismatch: L=${imgL.width}x${imgL.height}, R=${imgR.width}x${imgR.height}`, 'error', 8000);
                safeHideProgress();
                safeResetUI();
                return;
            }

            // Pixel validation dialog (when odd pixels). For ?src=/?list= URL launches
            // (state.loadedFromUrlParams), force silent trim-to-even so an odd-eye MPO
            // does not pop the blocking dialog that URL-parameter loads are meant to
            // skip — matching the single-image path (loader.js forceTrimWithoutDialog).
            // Note: Early return here is safe - the finally block will clean up leftUrl/rightUrl
            const validation = await validateDualImages(imgL, imgR, {
                forceTrimWithoutDialog: state.loadedFromUrlParams
            });
            if (validation.action === 'cancel') {
                safeHideProgress();
                safeResetUI();
                return;
            }

            // Use the validated image (trimmed or original)
            const processedImgL = validation.imgL;
            const processedImgR = validation.imgR;

            // Draw to canvas and extract ImageData (ensure even pixels)
            const evenWidth = ensureEven(processedImgL.width);
            const evenHeight = ensureEven(processedImgL.height);

            const leftImageData = extractImageData(processedImgL, evenWidth, evenHeight);
            const rightImageData = extractImageData(processedImgR, evenWidth, evenHeight);

            // Generate SBS (75-100%).
            // OffscreenCanvas is unavailable on older browsers (e.g. Safari < 16.4);
            // there the worker's createSBSFromDualImages throws OFFSCREEN_CANVAS_NOT_SUPPORTED,
            // so route SBS composition to a main-thread fallback instead of hard-failing.
            // Detect support up-front (same test the worker uses) so we never transfer
            // the ImageData buffers to the worker on the unsupported path — a transfer
            // detaches them and the fallback could not reuse them. This mirrors the test
            // in image-processing-worker.js; OffscreenCanvas.prototype is shared across
            // main/worker contexts, so the main-thread result matches the worker's.
            const offscreenSupported = typeof OffscreenCanvas !== 'undefined'
                && typeof OffscreenCanvas.prototype?.convertToBlob === 'function';

            let sbsBlob = null;
            if (offscreenSupported) {
                // Transfer the pixel buffers instead of structured-cloning them
                // (8 bytes/px across both eyes). On this (supported) path the detached
                // ImageData is never reused — the fallback below is only taken when
                // OffscreenCanvas is absent, so no transfer happens there.
                const sbsResult = await sendWorkerMessage(
                    {
                        type: 'createSBSFromDualImages',
                        payload: {
                            leftImageData: leftImageData,
                            rightImageData: rightImageData
                        }
                    },
                    (progress) => {
                        const sbsProgress = 75 + (progress.progress * 0.25);
                        safeProgress(sbsProgress);
                    },
                    null,
                    [leftImageData.data.buffer, rightImageData.data.buffer]
                );

                if (sbsResult.type !== 'createSBS-complete') {
                    throw new Error(`Unexpected SBS worker response type: ${sbsResult.type}`);
                }
                // Validate the worker payload before turning it into a Blob.
                // An undefined or empty ArrayBuffer would produce a 0-byte image that
                // fails silently later in the load pipeline.
                const buf = sbsResult.arrayBuffer;
                if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) {
                    throw new Error(
                        `Invalid SBS worker response: arrayBuffer missing or empty (byteLength=${buf?.byteLength ?? 'undefined'})`
                    );
                }
                sbsBlob = new Blob([buf], { type: 'image/jpeg' });
            } else {
                // Main-thread fallback: compose SBS without the worker. The ImageData
                // buffers were NOT transferred above, so they are still valid here.
                logger.info('MPO', 'OffscreenCanvas unavailable; composing SBS on the main thread');
                safeProgress(85);
                sbsBlob = await composeSBSFromDualImageDataOnMainThread(leftImageData, rightImageData);
            }

            // Validate the composed blob (both paths) before use.
            if (!(sbsBlob instanceof Blob) || sbsBlob.size === 0) {
                throw new Error(`Invalid SBS result: blob missing or empty (size=${sbsBlob?.size ?? 'undefined'})`);
            }
            // If a newer load superseded this one while SBS ran, skip: do not
            // create/track a blob URL (it would otherwise leak until a later load's
            // cleanup pass) and do not touch the progress UI.
            if (isStale()) {
                return;
            }
            const url = createAndTrackBlobUrl(sbsBlob);
            safeProgress(100);
            setTimeout(() => safeHideProgress(), 300);
            loadTextureCallback(url);
        } finally {
            // Clean up the URL
            if (leftUrl) URL.revokeObjectURL(leftUrl);
            if (rightUrl) URL.revokeObjectURL(rightUrl);
        }

    } catch (err) {
        logger.error('MPO', 'MPO processing error:', err);

        // Detailed feedback based on error type
        let userMessage = '';
        let errorType = 'unknown';
        // 'error' for genuine failures; an unanswered dialog is only a warning.
        let toastType = 'error';

        if (err?.dialogTimeout) {
            // An unanswered dialog is not a processing failure. Checked before the
            // message-substring chain below, whose 'timeout' branch would otherwise
            // blame the file size for the user simply not clicking a button.
            errorType = 'dialog_timeout';
            toastType = 'warning';
            userMessage = window.t?.('messages.dialogTimeout') ?? 'No response to the confirmation dialog; loading was canceled.';
        } else if (err.message) {
            const msg = err.message.toLowerCase();

            if (msg.includes('offscreen_canvas_not_supported')) {
                // Browser compatibility issue
                errorType = 'browser_compatibility';
                userMessage = (window.t?.('messages.processingFailed') ?? 'Processing failed') + '\n' +
                    (window.t?.('messages.browserCompatibilityIssue') ?? '(Browser compatibility issue: OffscreenCanvas not supported)');
                logger.warn('MPO', 'OffscreenCanvas not supported in MPO processing');
            } else if (msg.includes('timeout') || msg.includes('timed out')) {
                // Timeout error
                errorType = 'timeout';
                userMessage = (window.t?.('messages.processingFailed') ?? 'Processing failed') + '\n' +
                    (window.t?.('messages.processingTimeout') ?? '(Processing timed out. The file may be too large.)');
            } else if (msg.includes('memory') || msg.includes('out of memory') || msg.includes('allocation')) {
                // Memory-related error
                errorType = 'memory';
                userMessage = (window.t?.('messages.processingFailed') ?? 'Processing failed') + '\n' +
                    (window.t?.('messages.memoryError') ?? '(Insufficient memory. Try a smaller file or close other applications.)');
            } else if (msg.includes('worker') || msg.includes('postmessage')) {
                // Worker communication error
                errorType = 'worker';
                userMessage = (window.t?.('messages.processingFailed') ?? 'Processing failed') + '\n' +
                    (window.t?.('messages.workerError') ?? '(Background processing failed. Please try again.)');
            } else if (msg.includes('network') || msg.includes('fetch') || msg.includes('load')) {
                // File read error
                errorType = 'file_read';
                userMessage = (window.t?.('messages.processingFailed') ?? 'Processing failed') + '\n' +
                    (window.t?.('messages.fileReadError') ?? '(Failed to read the file. Please try again.)');
            } else if (msg.includes('invalid') || msg.includes('corrupt') || msg.includes('format')) {
                // File format error
                errorType = 'invalid_format';
                userMessage = (window.t?.('messages.processingFailed') ?? 'Processing failed') + '\n' +
                    (window.t?.('messages.invalidFileFormat') ?? '(Invalid or corrupted file format.)');
            } else {
                // Other errors
                userMessage = window.t?.('messages.processingFailed') ?? 'Processing failed';
            }
        } else {
            userMessage = window.t?.('messages.processingFailed') ?? 'Processing failed';
        }

        // Output debug information to the console
        logger.warn('MPO', `MPO processing failed [${errorType}]:`, {
            errorType,
            message: err.message,
            stack: err.stack
        });

        safeToast(userMessage, toastType, 8000);
        safeHideProgress();
        safeResetUI();
    }
}
