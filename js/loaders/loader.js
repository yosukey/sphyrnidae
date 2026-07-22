/**
 * loader.js
 * Entry point for loading, parsing, and combining image files
 *
 * This file integrates modules and provides an external access point.
 */

import * as THREE from 'three';
import { state, DEBUG, CONSTANTS } from '../globals.js';
import { updateSceneWithImage, getMaxTextureSize, getCachedOrCreateTexture, removeTextureFromCache } from '../rendering/renderer.js';

// Module imports
import { sendWorkerMessage } from './loader-worker.js';
import { clearPreviousImageState, resetImageParameters, restoreUrlDialogFlags } from './loader-state.js';
import { detectInterlaceFormat, detectStereoFormat, prepareImageForDetection, cleanupDetectionResources } from './loader-format-detection.js';
import { readExifData, getNextExifToken, syncActiveExifState } from './loader-exif.js';
import { processImageOnMainThread } from './loader-image-processing.js';
import { processMPOFile } from './loader-mpo.js';
import { loadDualImageFiles as loadDualImageFilesInternal, createSBSFromDualImages } from './loader-image-creation.js';
import { startViewerMode, setupViewerGlobals, loadViewerImage } from './loader-viewer.js';
import { startExternalImageMode, setupExternalGlobals } from './loader-external.js';
import { showLoadingProgress, hideLoadingProgress, resetUIStateAfterLoadError } from './loader-ui-progress.js';
import { validateAndProcessImage, clearDialogQueue } from './loader-pixel-validation.js';
import { showToast } from '../ui/ui-toast.js';
import { readFileAsArrayBuffer } from './loader-utils.js';
import * as logger from '../utils/logger.js';

// Prevent race conditions in file loading
let fileLoadToken = 0;       // File load generation token
let currentFileLoadAbortController = null;  // AbortController for current file load operation

/**
 * Read the current file-load generation token. handleFile()/loadFileWithFormat()
 * bump this synchronously (before their first await) at the start of every load,
 * so a caller can capture the token its load owns and later detect that a newer
 * load has superseded it (used by external-image mode to avoid applying a URL's
 * shift/crop to an unrelated image the user loaded mid-fetch).
 * @returns {number} The current generation token
 */
export function getFileLoadToken() {
    return fileLoadToken;
}

// Track all created Blob URLs for explicit cleanup
const activeBlobUrls = new Set();
const BLOB_URL_CLEANUP_DELAY_MS = 10000;  // Clean up URLs 10 seconds after texture load completes

/**
 * @param {Blob} blob - Blob to create URL from
 * @returns {string} Blob URL
 */
export function createAndTrackBlobUrl(blob) {
    const url = URL.createObjectURL(blob);
    activeBlobUrls.add(url);
    if (DEBUG.RENDER_ERROR_LOG) {
        logger.debug('LOADER_LOG', 'Loader', `[Loader] Blob URL created and tracked: ${url.substring(0, 50)}... (total: ${activeBlobUrls.size})`);
    }
    return url;
}

/**
 * Revoke a tracked Blob URL and remove it from the active set.
 * @param {string} url - Blob URL to revoke
 */
function revokeTrackedBlobUrl(url) {
    if (!url || !url.startsWith('blob:')) {
        return;
    }

    const wasTracked = activeBlobUrls.delete(url);
    try {
        URL.revokeObjectURL(url);
        if (DEBUG.RENDER_ERROR_LOG) {
            logger.debug('LOADER_LOG', 'Loader', `[Loader] Blob URL revoked${wasTracked ? ' (tracked)' : ''}: ${url.substring(0, 50)}...`);
        }
    } catch (err) {
        logger.warn('Loader', 'Error revoking Blob URL:', err);
    }
}

/**
 * Defers URL revocation to avoid immediate memory pressure
 * Captures current URLs at scheduling time to ensure all are eventually cleaned up
 */
export function scheduleActiveBlobUrlsCleanup() {
    // Capture snapshot of current URLs to clean up
    // This ensures these URLs will be cleaned up even if new files are loaded
    const urlsToCleanup = new Set(activeBlobUrls);

    if (urlsToCleanup.size === 0) {
        return;  // Nothing to clean up
    }

    if (DEBUG.RENDER_ERROR_LOG) {
        logger.debug('LOADER_LOG', 'Loader', `[Loader] Scheduled cleanup for ${urlsToCleanup.size} Blob URLs`);
    }

    // Schedule cleanup after delay
    // Each call creates its own cleanup task, preventing URL leaks on rapid successive loads
    setTimeout(() => {
        let cleanedCount = 0;
        urlsToCleanup.forEach((url) => {
            // Only revoke if still tracked (may have been cleaned up early)
            if (activeBlobUrls.has(url)) {
                revokeTrackedBlobUrl(url);
                cleanedCount++;
            }
        });

        if (DEBUG.RENDER_ERROR_LOG) {
            logger.debug('LOADER_LOG', 'Loader', `[Loader] Cleaned up ${cleanedCount} Blob URLs`);
        }
    }, BLOB_URL_CLEANUP_DELAY_MS);
}

/**
 * Immediately revoke all active Blob URLs (called on page unload or manual cleanup)
 */
export function revokeAllActiveBlobUrls() {

    const urlsToRevoke = Array.from(activeBlobUrls);
    urlsToRevoke.forEach((url) => {
        revokeTrackedBlobUrl(url);
    });
    activeBlobUrls.clear();
    if (DEBUG.RENDER_ERROR_LOG) {
        logger.debug('LOADER_LOG', 'Loader', 'All Blob URLs revoked');
    }
}

/**
 * Receive a file object and branch processing based on type
 * UI updates (file name display, reset, output name update) are handled in ui.js to avoid circular references
 * Race condition mitigation: manage tokens so stale results are not applied during rapid loads
 * Uses AbortController to explicitly cancel in-flight load operations
 * @param {File} file - File to process
 * @param {Object} options - Optional configuration
 * @param {boolean} options.suppressFormatDialog - Skip format selection dialog
 * @param {string} options.defaultFormat - Default format to use when dialog is suppressed
 * @param {boolean} options.loadedFromUrlDialog - Whether the file was loaded from URL dialog
 * @param {string} options.externalImageUrl - External image URL (if loaded from URL dialog)
 */
export async function handleFile(file, options = {}) {
    if (!file) return;

    const {
        suppressFormatDialog = false,
        defaultFormat = 'half_sbs',
        loadedFromUrlDialog = false,
        externalImageUrl = null,
        mode = null,
        forceFormat = null
    } = options;

    // Preserve URL dialog flags - use explicit option value if provided, otherwise fall back to state
    // Use 'in' operator to detect if option was explicitly passed (even if false)
    const preserveUrlDialogFlags = 'loadedFromUrlDialog' in options
        ? loadedFromUrlDialog
        : state.loadedFromUrlDialog;
    // A load that explicitly declares loadedFromUrlDialog:false is a local
    // drop / file-input load. It must NOT inherit a previous ?src= session's
    // external mode and URL: doing so makes the share/export paths emit the old
    // remote URL paired with the new local image's settings, and makes
    // exitViewerMode take the external-mode (window.close/reload) branch for what
    // is now a local image. The ?src= and viewer load paths do not pass
    // loadedFromUrlDialog, so they still preserve external mode from state; the
    // Open-URL dialog passes its own externalImageUrl explicitly (handled above).
    const isExplicitLocalLoad = ('loadedFromUrlDialog' in options) && loadedFromUrlDialog === false;
    const preserveExternalImageUrl = 'externalImageUrl' in options
        ? externalImageUrl
        : (isExplicitLocalLoad ? null : state.externalImageUrl);
    const preserveExternalImageMode = isExplicitLocalLoad ? false : state.externalImageMode;
    // Carry the URL-parameter launch flag through clearPreviousImageState(),
    // which resets it. It is read later in this same load flow
    // (loadFileWithFormat reads it as forceTrimWithoutDialog to skip the
    // blocking odd-size dialog for ?src=/?list= launches), so losing it here
    // would re-enable the dialog for the URL-parameter load itself.
    // BUT it must NOT leak to a later local load: only a URL-parameter load
    // suppresses the format dialog (external mode passes suppressFormatDialog),
    // while a drag/drop/file-input load never does. Gating on that flag clears
    // the sticky state on the next local load, so an odd-size dropped image
    // still gets its validation dialog and the viewer Exit button reappears —
    // matching the error path's cleanup in loader-external.js.
    const preserveLoadedFromUrlParams = suppressFormatDialog && state.loadedFromUrlParams;

    scheduleActiveBlobUrlsCleanup();

    // Cancel any in-flight file load operation
    if (currentFileLoadAbortController) {
        currentFileLoadAbortController.abort();
        if (DEBUG.RENDER_ERROR_LOG) {
            logger.debug('LOADER_LOG', 'Loader', 'Previous file load cancelled due to new file load');
        }
    }

    // Clear any pending pixel validation dialogs from an earlier load operation
    clearDialogQueue();

    // Create new AbortController for this file load
    currentFileLoadAbortController = new AbortController();
    const myAbortController = currentFileLoadAbortController;

    // Issue a new token (race condition mitigation)
    const myToken = ++fileLoadToken;

    const fileName = file.name.toLowerCase();

    // Read EXIF data in parallel (intentionally not awaited for performance).
    // Race safety: readExifData uses exifLoadToken checks at every async boundary
    // to discard stale results when a new file load starts.
    // Skip for .mpo: the MPO branch calls getNextExifToken() (line below) before this
    // read's first await (file.arrayBuffer()) resolves, so its result is always
    // discarded as stale — while still having pulled the whole (tens-of-MB) file into
    // memory, doubling peak use since processMPOFile reads the file again itself and
    // extracts per-eye EXIF via readExifDataFromBuffer.
    if (!fileName.endsWith('.mpo')) {
        readExifData(file)
            .catch(err => {
                logger.warn('Loader', 'EXIF extraction failed, continuing without EXIF:', err);
                // Notify user of EXIF failure (optional - can be disabled in production)
                // This is a non-critical error - image loading continues
                if (window.dispatchEvent) {
                    try {
                        window.dispatchEvent(new CustomEvent('exif-load-failed', {
                            detail: {
                                filename: file.name,
                                error: err.message
                            }
                        }));
                    } catch (notifyErr) {
                        logger.warn('Loader', 'Failed to dispatch exif-load-failed event:', notifyErr);
                    }
                }
            });
    }

    // Clear current Three.js resources (mesh/material/texture) for all load paths
    // (JPS, MPO, and normal images) to prevent GPU memory leaks on consecutive loads
    clearPreviousImageState();

    // Restore the URL-parameter launch flag captured above (see comment there)
    state.loadedFromUrlParams = preserveLoadedFromUrlParams;
    if (preserveExternalImageMode && preserveExternalImageUrl) {
        state.externalImageMode = true;
        state.externalImageUrl = preserveExternalImageUrl;
    }

    // Re-apply a caller-specified display mode. clearPreviousImageState() restores
    // params from defaultParams, which would otherwise discard a mode supplied via
    // URL parameters (e.g. ?src=...&mode=parallel) on the auto-detect path, where
    // the shader is built from state.params.mode further down this load.
    if (typeof mode === 'number') {
        state.params.mode = mode;
    }

    if (fileName.endsWith('.mpo')) {
        // Restore URL dialog flags (cleared by clearPreviousImageState above) so the
        // "copy/share URL" and clipboard-export features stay enabled for .mpo URLs.
        restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl);
        // The MPO branch composes both embedded JPEGs into a full-width SBS texture
        // (2 * eyeWidth). Record that as the source format so the export/share-URL
        // paths (ui-export.js) do not fall back to 'half_sbs', which would make a
        // shared .mpo link reopen with the wrong geometry.
        state.currentImageFormat = 'full_sbs';
        // Create a token-aware callback (ignore stale results)
        const wrappedLoadTexture = (url) => {
            if (fileLoadToken === myToken && !myAbortController.signal.aborted) {
                // Load texture (fire and forget, errors handled internally).
                // Pass the token so a stale texture is discarded if a newer load
                // starts during the async decode.
                loadTexture(url, myToken, () => fileLoadToken).catch((err) => {
                    // Error already handled in loadTexture, but log here for debugging
                    if (DEBUG.RENDER_ERROR_LOG) {
                        logger.debug('LOADER_LOG', 'Loader', 'loadTexture failed for MPO:', err);
                    }
                });
            } else {
                // Superseded/cancelled: revoke the composed SBS blob URL now (it can
                // be tens of MB) instead of leaking it until a future load's cleanup.
                // Use the tracked revoke so it is also removed from activeBlobUrls,
                // otherwise the set keeps a dead entry that gets revoked again later.
                revokeTrackedBlobUrl(url);
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', 'handleFile: Skipping outdated/cancelled MPO texture load');
                }
            }
        };
        await processMPOFile(file, wrappedLoadTexture, getNextExifToken(), myToken, () => fileLoadToken);
    } else if (fileName.endsWith('.jps')) {
        // Restore URL dialog flags (cleared by clearPreviousImageState above) so the
        // "copy/share URL" and clipboard-export features stay enabled for .jps URLs.
        restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl);
        await processJPSFile(file, myToken, () => fileLoadToken, myAbortController.signal);
    } else if (forceFormat) {
        // Explicit format override (e.g. Viewer per-item format). Skip auto-detection
        // and the format dialog, but still run through the shared generation
        // management performed above (previous-load abort, dialog-queue clear, new
        // fileLoadToken, clearPreviousImageState) and pass the token so a stale
        // result from a superseded load is discarded.
        restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, forceFormat);
        await loadFileWithFormat(file, forceFormat, false, myToken, () => fileLoadToken);
    } else {
        // For normal images, attempt auto format detection
        try {
            // to avoid unit confusion
            const fileSizeMB = file.size / (1024 * 1024);
            const isLargeFile = fileSizeMB > CONSTANTS.LARGE_IMAGE_FILE_SIZE_MB;

            if (isLargeFile) {
                logger.debug('LOADER_LOG', 'Loader', `[handleFile] Large file detected (${fileSizeMB.toFixed(2)}MB)`);
            }

            // Prevents UI freeze if detection takes too long due to large images
            const DETECTION_TIMEOUT = 5000;

            // Encoded file-size gate. A separate decoded-pixel-count gate
            // (CONSTANTS.SKIP_FORMAT_DETECTION_MP, in megapixels) is enforced inside
            // prepareImageForDetection() once the real dimensions are known, since a
            // small highly-compressed file can still decode to a huge pixel buffer.
            const skipFormatDetectionDueToFileSize = fileSizeMB > CONSTANTS.FORMAT_DETECTION_SKIP_SIZE_MB;

            if (skipFormatDetectionDueToFileSize) {
                logger.warn('Loader',`[handleFile] File size (${fileSizeMB.toFixed(2)}MB) exceeds threshold (${CONSTANTS.FORMAT_DETECTION_SKIP_SIZE_MB}MB), skipping format detection`);

                if (suppressFormatDialog) {
                    // Load with default format when dialog is suppressed
                    logger.debug('LOADER_LOG', 'Loader', `[handleFile] Loading with default format: ${defaultFormat}`);
                    restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, defaultFormat);
                    await loadFileWithFormat(file, defaultFormat, false, myToken, () => fileLoadToken);
                } else {
                    logger.warn('Loader',`[handleFile] Please manually select the correct format`);
                    // Restore URL dialog flags before showing the format dialog so they
                    // persist through format selection (matches the auto-detect path).
                    restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl);
                    // Skip format detection and show format dialog
                    if (window.showFormatSelectDialog) {
                        window.showFormatSelectDialog(file);
                    } else {
                        // Fallback: load as Half SBS (statistically most common)
                        // Restore URL dialog flags and format before loading
                        restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, 'half_sbs');
                        await loadFileWithFormat(file, 'half_sbs', false, myToken, () => fileLoadToken);
                    }
                }
                return;
            }

            // Prepare image for detection once (shared by interlace and stereo detection)
            const preparedImage = await prepareImageForDetection(file, myAbortController.signal);
            if (!preparedImage) {
                // Distinguish a genuine cancellation (a newer file load started) from
                // a real preparation failure (decode error, or image too small/large
                // for analysis). A cancellation must stay silent; a failure must NOT
                // be silently dropped — fall back to manual format selection so the
                // user gets feedback and valid-but-unanalyzable images still load.
                if (myAbortController.signal.aborted || fileLoadToken !== myToken) {
                    if (DEBUG.RENDER_ERROR_LOG) {
                        logger.debug('LOADER_LOG', 'Loader', '[handleFile] Image preparation aborted');
                    }
                    return;
                }

                logger.warn('Loader', '[handleFile] Image preparation failed; falling back to manual format selection');
                if (suppressFormatDialog) {
                    restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, defaultFormat);
                    await loadFileWithFormat(file, defaultFormat, true, myToken, () => fileLoadToken);
                } else {
                    restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl);
                    if (window.showFormatSelectDialog) {
                        window.showFormatSelectDialog(file);
                    } else {
                        const dialog = document.getElementById('formatSelectDialog');
                        if (dialog) {
                            import('../ui/ui-file-loading.js').then(({ setPendingFormatFile }) => {
                                setPendingFormatFile(file);
                                dialog.style.display = 'flex';
                            }).catch(() => {
                                dialog.style.display = 'flex';
                            });
                        } else {
                            restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, 'half_sbs');
                            await loadFileWithFormat(file, 'half_sbs', true, myToken, () => fileLoadToken);
                        }
                    }
                }
                return;
            }

            // Token check after preparation
            if (fileLoadToken !== myToken || myAbortController.signal.aborted) {
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', 'handleFile: Skipping after preparation - token mismatch or aborted');
                }
                return;
            }

            // 1. Detect interlace format with timeout and AbortController
            const interlaceAbortController = new AbortController();
            // Propagate parent cancellation so detection stops immediately when the file load is cancelled
            const interlaceAbortHandler = () => interlaceAbortController.abort();
            myAbortController.signal.addEventListener('abort', interlaceAbortHandler, { once: true });
            const interlacePromise = detectInterlaceFormat(preparedImage, myToken, () => fileLoadToken, interlaceAbortController.signal);
            let interlaceTimeoutId = null;
            const interlaceTimeoutPromise = new Promise((_, reject) => {
                interlaceTimeoutId = setTimeout(() => {
                    interlaceAbortController.abort();
                    reject(new Error('Interlace detection timeout'));
                }, DETECTION_TIMEOUT);
            });

            let interlaceResult;
            try {
                interlaceResult = await Promise.race([interlacePromise, interlaceTimeoutPromise]).finally(() => {
                    if (interlaceTimeoutId) clearTimeout(interlaceTimeoutId);
                    // Remove the propagation listener to prevent accumulation on repeated calls
                    myAbortController.signal.removeEventListener('abort', interlaceAbortHandler);
                });
            } catch (err) {
                if (err.message === 'Interlace detection timeout') {
                    logger.warn('Loader','[handleFile] Interlace detection timed out after 5 seconds');
                    // Create a default result to continue to stereo detection
                    interlaceResult = { detected: false, reason: 'timeout', confidence: null };
                } else {
                    cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                    throw err;
                }
            }

            // Token check: abort if a new file is loaded or operation was cancelled
            if (fileLoadToken !== myToken || myAbortController.signal.aborted) {
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', 'handleFile: Skipping outdated/cancelled interlace detection result');
                }
                return;
            }

            // If detection is aborted due to token mismatch, return early
            if (interlaceResult.reason === 'token_mismatch') {
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                return;
            }

            if (interlaceResult.detected && interlaceResult.format) {
                // If interlace is detected, load with that format
                // EXIF has already been read, so skip
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', `[handleFile] Interlace format detected: ${interlaceResult.format} (confidence: ${interlaceResult.confidence?.toFixed(3)})`);
                }
                // Clean up prepared resources before loading
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                // Restore URL dialog flags and format before loading
                restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, interlaceResult.format);
                await loadFileWithFormat(file, interlaceResult.format, true, myToken, () => fileLoadToken);
                return;
            }

            // Log errors if interlace detection fails (vetoed_by_sbs_tab is expected, not an error)
            if (interlaceResult.reason && !['below_threshold', 'token_mismatch', 'timeout', 'vetoed_by_sbs_tab'].includes(interlaceResult.reason)) {
                logger.warn('Loader',`[handleFile] Interlace detection issue: ${interlaceResult.reason}`, interlaceResult.details);
            }

            // 2. Detect SBS/TaB format with timeout and AbortController
            const stereoAbortController = new AbortController();
            // Propagate parent cancellation so detection stops immediately when the file load is cancelled
            const stereoAbortHandler = () => stereoAbortController.abort();
            myAbortController.signal.addEventListener('abort', stereoAbortHandler, { once: true });
            const stereoPromise = detectStereoFormat(preparedImage, myToken, () => fileLoadToken, stereoAbortController.signal);
            let stereoTimeoutId = null;
            const stereoTimeoutPromise = new Promise((_, reject) => {
                stereoTimeoutId = setTimeout(() => {
                    stereoAbortController.abort();
                    reject(new Error('Stereo detection timeout'));
                }, DETECTION_TIMEOUT);
            });

            let stereoResult;
            try {
                stereoResult = await Promise.race([stereoPromise, stereoTimeoutPromise]).finally(() => {
                    if (stereoTimeoutId) clearTimeout(stereoTimeoutId);
                    // Remove the propagation listener to prevent accumulation on repeated calls
                    myAbortController.signal.removeEventListener('abort', stereoAbortHandler);
                });
            } catch (err) {
                if (err.message === 'Stereo detection timeout') {
                    logger.warn('Loader','[handleFile] Stereo detection timed out after 5 seconds');
                    // Create a default result to fallback to format dialog
                    stereoResult = { detected: false, reason: 'timeout', confidence: null };
                } else {
                    cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                    throw err;
                }
            }

            // Token check: abort if a new file is loaded or operation was cancelled
            if (fileLoadToken !== myToken || myAbortController.signal.aborted) {
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', 'handleFile: Skipping outdated/cancelled stereo detection result');
                }
                return;
            }

            // If detection is aborted due to token mismatch, return early
            if (stereoResult.reason === 'token_mismatch') {
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                return;
            }

            if (stereoResult.detected && stereoResult.format) {
                // If SBS/TaB is detected, load with that format
                // EXIF has already been read, so skip
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', `[handleFile] Stereo format detected: ${stereoResult.format} (confidence: ${stereoResult.confidence?.toFixed(3)})`);
                }
                // Clean up prepared resources before loading
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                // Restore URL dialog flags and format before loading
                restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, stereoResult.format);
                await loadFileWithFormat(file, stereoResult.format, true, myToken, () => fileLoadToken);
                return;
            }

            // Log errors if stereo detection fails
            if (stereoResult.reason && !['below_threshold', 'confidence_too_low', 'similarity_difference_too_small', 'token_mismatch', 'timeout'].includes(stereoResult.reason)) {
                logger.warn('Loader',`[handleFile] Stereo detection issue: ${stereoResult.reason}`, stereoResult.details);
            }

            // 3. Detection failed: show the format selection dialog
            if (DEBUG.RENDER_ERROR_LOG) {
                logger.debug('LOADER_LOG', 'Loader','[handleFile] Auto-detection failed, showing format dialog', {
                    interlaceResult: { reason: interlaceResult.reason, confidence: interlaceResult.confidence },
                    stereoResult: { reason: stereoResult.reason, confidence: stereoResult.confidence }
                });
            }

            if (fileLoadToken !== myToken || myAbortController.signal.aborted) {
                cleanupDetectionResources(preparedImage.canvas, preparedImage.img);
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', 'handleFile: Skipping outdated/cancelled format dialog display');
                }
                return;
            }

            // Clean up prepared resources after both detections complete
            cleanupDetectionResources(preparedImage.canvas, preparedImage.img);

            if (suppressFormatDialog) {
                // Load with default format when dialog is suppressed
                logger.debug('LOADER_LOG', 'Loader', `[handleFile] Auto-detection failed, loading with default format: ${defaultFormat}`);
                restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, defaultFormat);
                await loadFileWithFormat(file, defaultFormat, true, myToken, () => fileLoadToken);
            } else {
                // Restore URL dialog flags before showing format dialog
                // (so they persist through format selection)
                restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl);
                // Use dynamic import to avoid circular dependency
                if (window.showFormatSelectDialog) {
                    window.showFormatSelectDialog(file);
                } else {
                    // Fallback: show dialog via direct DOM manipulation
                    const dialog = document.getElementById('formatSelectDialog');
                    if (dialog) {
                        // Dynamic import to set pending file
                        import('../ui/ui-file-loading.js').then(({ setPendingFormatFile }) => {
                            setPendingFormatFile(file);
                            dialog.style.display = 'flex';
                        }).catch(() => {
                            // If import fails, use DOM-only approach
                            dialog.style.display = 'flex';
                        });
                    } else {
                        logger.error('Loader','Format selection dialog not found in DOM');
                        // Final fallback: load as Half SBS (statistically most common)
                        // EXIF has already been read, so skip
                        // Restore URL dialog flags and format before loading
                        restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, 'half_sbs');
                        await loadFileWithFormat(file, 'half_sbs', true, myToken, () => fileLoadToken);
                    }
                }
            }
        } catch (err) {
            // Token check: if a new file is loaded, skip error handling too
            if (fileLoadToken !== myToken) {
                return;
            }

            // loadFileWithFormat() has already presented these failures and reset
            // its UI. They are not format-detection failures, so retrying through
            // the default format would perform the same failing decode twice. The
            // external-image caller still needs the rejection to restore its own
            // viewer UI; ordinary local loads can finish after the handled error.
            if (err?.__loadFileWithFormatHandled) {
                if (suppressFormatDialog) throw err;
                return;
            }

            logger.warn('Loader','Error in auto-detection:', err);

            if (suppressFormatDialog) {
                // Load with default format when dialog is suppressed
                logger.debug('LOADER_LOG', 'Loader', `[handleFile] Error in auto-detection, loading with default format: ${defaultFormat}`);
                restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, defaultFormat);
                await loadFileWithFormat(file, defaultFormat, true, myToken, () => fileLoadToken);
            } else {
                // Restore URL dialog flags before showing the format dialog so they
                // persist through format selection (matches the non-error path).
                restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl);
                // On error, show the format selection dialog
                if (window.showFormatSelectDialog) {
                    window.showFormatSelectDialog(file);
                } else {
                    const dialog = document.getElementById('formatSelectDialog');
                    if (dialog) {
                        // Dynamic import to set pending file
                        import('../ui/ui-file-loading.js').then(({ setPendingFormatFile }) => {
                            setPendingFormatFile(file);
                            dialog.style.display = 'flex';
                        }).catch(() => {
                            dialog.style.display = 'flex';
                        });
                    }
                }
            }
        }
    }
}

/**
 * Load the image with the selected format (use Web Worker)
 * Asynchronous implementation using createImageBitmap + Transferable Objects to avoid blocking the main thread
 * @param {File} file - File to load
 * @param {string} format - Image format
 * @param {boolean} skipExifRead - Whether to skip EXIF reading (if already read)
 */
export async function loadFileWithFormat(file, format, skipExifRead = false, myToken = null, getTokenFunc = null) {
    if (DEBUG.AUDIT_LOG) {
        const fileSizeMB = (file.size / (1024 * 1024)).toFixed(2);
        logger.debug('LOADER_LOG', 'Loader', `[AUDIT] Processing image: ${file.name} | Format: ${format} | Size: ${fileSizeMB}MB | Timestamp: ${new Date().toISOString()}`);
    }

    // Standalone calls (format-select dialog, ?src=&format= external loads) do
    // not come through handleFile and may pass no token, which would disable every
    // staleness check in this function (worker progress/result, validation-dialog
    // cancel, error handling). Claim a fresh load generation so this load and any
    // newer handleFile invocation correctly supersede each other.
    if (myToken === null) {
        myToken = ++fileLoadToken;
        getTokenFunc = () => fileLoadToken;
    }

    // Keep the effective source format available to URL sharing/export paths for
    // both explicit format loads and auto-detected loads that arrive here.
    state.currentImageFormat = format;

    // Read EXIF data (parallel; skip if already read; errors handled internally)
    if (!skipExifRead) {
        readExifData(file)
            .catch(err => {
                logger.warn('Loader', 'EXIF extraction failed in loadFileWithFormat, continuing without EXIF:', err);
                // Non-critical error - image processing continues
                // Optionally notify UI (comment out to suppress notifications)
                if (window.dispatchEvent) {
                    try {
                        window.dispatchEvent(new CustomEvent('exif-load-failed', {
                            detail: {
                                filename: file.name,
                                error: err.message,
                                source: 'loadFileWithFormat'
                            }
                        }));
                    } catch (notifyErr) {
                        logger.warn('Loader', 'Failed to dispatch exif-load-failed event:', notifyErr);
                    }
                }
            });
    }

    // Show load progress UI
    showLoadingProgress(0);

    try {
        // Larger files may take longer to decode; slower networks may need more time
        // Base timeout: 15s, plus 2s per MB, capped at FILE_LOAD_TIMEOUT_MS
        showLoadingProgress(10);

        const fileSizeInMB = file.size / (1024 * 1024);
        const calculatedTimeout = Math.max(15000, 15000 + (fileSizeInMB * 2000));
        const timeout = Math.min(calculatedTimeout, CONSTANTS.FILE_LOAD_TIMEOUT_MS);

        if (DEBUG.RENDER_ERROR_LOG) {
            logger.debug('LOADER_LOG', 'Loader', `[Loader] createImageBitmap timeout: ${timeout}ms for ${fileSizeInMB.toFixed(2)}MB (${file.size} bytes)`);
        }

        let timeoutId = null;
        let timedOut = false;

        const imageBitmapPromise = createImageBitmap(file);
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                timedOut = true;
                reject(new Error(`createImageBitmap timeout after ${timeout}ms`));
            }, timeout);
        });

        // Attach the late-resolution cleanup BEFORE awaiting the race. On timeout the
        // race rejects and the await throws straight to the catch block, so a cleanup
        // placed after the await would never run and a bitmap that resolves after the
        // timeout would leak. When the bitmap wins the race, timedOut is still false
        // here, so the handler leaves it untouched for normal use.
        imageBitmapPromise.then(bmp => {
            if (timedOut && bmp && bmp.close) bmp.close();
        }).catch(() => {
            // Ignore errors from the timed-out promise
        });

        const imageBitmap = await Promise.race([imageBitmapPromise, timeoutPromise]).finally(() => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        });

        if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
            if (imageBitmap && typeof imageBitmap.close === 'function') {
                try { imageBitmap.close(); } catch (_) { /* ignore */ }
            }
            return;
        }

        showLoadingProgress(20);

        // Validate the ImageBitmap
        if (!imageBitmap || typeof imageBitmap.width !== 'number' || typeof imageBitmap.height !== 'number') {
            logger.error('Loader','Invalid ImageBitmap created from file:', file.name);
            throw new Error('Failed to create valid ImageBitmap');
        }

        if (imageBitmap.width <= 0 || imageBitmap.height <= 0) {
            logger.error('Loader','ImageBitmap has invalid dimensions:', imageBitmap.width, 'x', imageBitmap.height);
            throw new Error('Image has invalid dimensions (width or height is zero or negative)');
        }

        // Pixel validation dialog (for odd pixels)
        // When launched directly from URL parameters,
        // skip odd-size warning and force trim-to-even.
        const forceTrimWithoutDialog = state.loadedFromUrlParams;
        const validation = await validateAndProcessImage(imageBitmap, format, {
            forceTrimWithoutDialog
        });
        if (validation.action === 'cancel') {
            // The cancelled image is never used; release the decoded bitmap now
            if (imageBitmap && typeof imageBitmap.close === 'function') {
                try {
                    imageBitmap.close();
                } catch (closeErr) {
                    logger.warn('Loader', 'Failed to close ImageBitmap after cancel:', closeErr);
                }
            }
            // Distinguish a user cancel on the active load from a stale cancel:
            // when a newer load starts, clearDialogQueue() dismisses this load's
            // validation dialog by resolving it with 'cancel'. That resolution
            // arrives in a microtask AFTER the newer load has already run
            // clearPreviousImageState() and re-applied its own params/mode, so
            // touching shared state here would wipe the in-flight load's setup.
            // Same policy as the stale worker-result path below: clean up only
            // what belongs to this load.
            if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
                if (DEBUG.RENDER_ERROR_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', 'loadFileWithFormat: Skipping cancel cleanup for superseded load');
                }
                return;
            }
            hideLoadingProgress();
            // Comprehensive cleanup on user cancel
            clearPreviousImageState();     // Clear image state
            resetImageParameters();        // Reset all parameters
            resetUIStateAfterLoadError();  // Reset UI state
            // Notify other modules that image load was cancelled
            window.dispatchEvent(new Event('image-load-cancelled'));
            return;
        }

        // Use the validated image (trimmed or original)
        const processedImage = validation.image;
        showLoadingProgress(25);

        // Hand off the ImageBitmap to the Web Worker (zero-copy transfer)
        // Note: if validation.image is a Canvas, convert it to ImageBitmap
        let imageToSend = processedImage;
        let transferList = [];
        let wasTransferred = false;  // Track if ImageBitmap was transferred (neutered)
        if (processedImage instanceof HTMLCanvasElement) {
            // Trimming produced a separate canvas, so the original full-size
            // ImageBitmap (already copied into that canvas) is no longer needed.
            // Release it now to avoid holding two full image copies in memory; this
            // also covers the early-return error path of the conversion below.
            if (imageBitmap && imageBitmap !== processedImage && typeof imageBitmap.close === 'function') {
                try {
                    imageBitmap.close();
                } catch (closeErr) {
                    logger.warn('Loader', 'Failed to close original ImageBitmap after trim:', closeErr);
                }
            }

            // Add timeout protection for Canvas→ImageBitmap conversion (can be slow for large canvases)
            const canvasTimeout = 5000;  // 5 seconds for canvas conversion
            let canvasConversionTimeoutId = null;
            let canvasConversionTimedOut = false;

            try {
                const canvasBitmapPromise = createImageBitmap(processedImage);
                const canvasTimeoutPromise = new Promise((_, reject) => {
                    canvasConversionTimeoutId = setTimeout(() => {
                        canvasConversionTimedOut = true;
                        reject(new Error(`Canvas to ImageBitmap conversion timeout after ${canvasTimeout}ms`));
                    }, canvasTimeout);
                });

                canvasBitmapPromise.then(bitmap => {
                    if (canvasConversionTimedOut && bitmap && typeof bitmap.close === 'function') {
                        bitmap.close();
                    }
                }).catch(() => {});

                imageToSend = await Promise.race([canvasBitmapPromise, canvasTimeoutPromise]).finally(() => {
                    if (canvasConversionTimeoutId) {
                        clearTimeout(canvasConversionTimeoutId);
                        canvasConversionTimeoutId = null;
                    }
                });
                if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
                    if (imageToSend && typeof imageToSend.close === 'function') {
                        try { imageToSend.close(); } catch (_) { /* ignore */ }
                    }
                    return;
                }
            } catch (err) {
                logger.error('Loader','Canvas to ImageBitmap conversion failed:', err);
                // Skip touching shared UI if a newer load has already superseded this
                // one (mirrors the success path above and the worker-error branch at
                // ~1048): otherwise a stale conversion failure — e.g. this load's slow
                // createImageBitmap rejecting after the user dropped a newer image —
                // would hide the in-flight load's progress and show a spurious error
                // toast over it.
                if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
                    return;
                }
                showToast(window.t?.('messages.processingFailed') ?? 'Processing failed', 'error');
                hideLoadingProgress();
                resetUIStateAfterLoadError();
                return;
            }

            transferList = [imageToSend];
        } else if (processedImage instanceof ImageBitmap) {
            transferList = [processedImage];
        } else {
            logger.error('Loader','Invalid image type after validation:', processedImage);
            showToast(window.t?.('messages.processingFailed') ?? 'Processing failed', 'error');
            hideLoadingProgress();
            resetUIStateAfterLoadError();
            return;
        }

        // sendWorkerMessage sets transferResult.transferred = true ONLY when
        // postMessage actually ran with a non-empty transfer list (the bitmap is then
        // neutered). It never throws synchronously: a full queue, a worker-construction
        // failure, or a postMessage that throws all surface as a rejected promise with
        // the transfer never having happened. Deriving wasTransferred from this flag
        // (instead of transferList.length) ensures those failure paths still close the
        // un-transferred ImageBitmap and do not leak a full-res bitmap.
        const transferResult = { transferred: false };
        const workerPromise = sendWorkerMessage(
            {
                type: 'processImage',
                payload: {
                    imageBitmap: imageToSend,
                    width: imageToSend.width,
                    height: imageToSend.height,
                    format: format,
                    filename: file.name
                }
            },
            (progress) => {
                // Token check: ignore progress from a stale worker request. Without
                // this, an older request still draining in the worker queue would
                // overwrite the progress bar for the newer load currently in flight.
                if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
                    return;
                }
                // Display progress info (normalize to 20-100%)
                const totalProgress = 20 + (progress.progress * 0.8);
                showLoadingProgress(totalProgress);
            },
            null,
            transferList,  // Send ImageBitmap as Transferable Object (zero-copy)
            transferResult
        );

        wasTransferred = transferResult.transferred;

        await workerPromise.then(async (result) => {
            if (result.type === 'processImage-complete') {
                // Token check FIRST: abort if a new file is loaded (before closing ImageBitmap)
                if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
                    if (DEBUG.RENDER_ERROR_LOG) {
                        logger.debug('LOADER_LOG', 'Loader','loadFileWithFormat: Skipping outdated worker result');
                    }
                    // Close ImageBitmap before returning for outdated results
                    // (skip if already transferred to worker - neutered reference)
                    if (!wasTransferred && imageToSend instanceof ImageBitmap) {
                        try {
                            if (imageToSend && typeof imageToSend.close === 'function') {
                                imageToSend.close();
                            }
                        } catch (closeErr) {
                            logger.warn('Loader', 'Failed to close ImageBitmap:', closeErr);
                        }
                    }
                    // Do NOT touch shared UI state here (e.g. hideLoadingProgress()).
                    // This result belongs to a superseded load; the newer load now owns
                    // the progress UI, and hiding it would wipe the in-flight load's
                    // progress display. Limit ourselves to cleaning up this stale result.
                    return;
                }

                // Close ImageBitmap after token validation
                // (skip if already transferred to worker - neutered reference)
                if (!wasTransferred && imageToSend instanceof ImageBitmap) {
                    try {
                        if (imageToSend && typeof imageToSend.close === 'function') {
                            imageToSend.close();
                            if (DEBUG.RENDER_ERROR_LOG) {
                                logger.debug('LOADER_LOG', 'Loader', 'ImageBitmap released after worker completion');
                            }
                        }
                    } catch (closeErr) {
                        logger.warn('Loader', 'Failed to close ImageBitmap:', closeErr);
                    }
                }

                // Validate the worker payload before turning it into a Blob, mirroring
                // the MPO path — an undefined/empty arrayBuffer would otherwise produce a
                // 0-byte PNG that only fails later as a generic texture-decode error.
                if (!(result.arrayBuffer instanceof ArrayBuffer) || result.arrayBuffer.byteLength === 0) {
                    throw new Error(
                        `Invalid worker response: arrayBuffer missing or empty (byteLength=${result.arrayBuffer?.byteLength ?? 'undefined'})`
                    );
                }

                const blob = new Blob([result.arrayBuffer], { type: 'image/png' });
                const url = createAndTrackBlobUrl(blob);
                showLoadingProgress(100);

                if (DEBUG.AUDIT_LOG) {
                    logger.debug('LOADER_LOG', 'Loader', `[AUDIT] Successfully processed: ${file.name} | Format: ${format} | Timestamp: ${new Date().toISOString()}`);
                }

                // The operation is not successful until the decoded texture has been
                // accepted by the renderer. Awaiting also propagates corrupt-image
                // failures to external-image mode so it can restore its UI and URL.
                await loadTexture(url, myToken, getTokenFunc);
                if (!getTokenFunc || getTokenFunc() === myToken) {
                    setTimeout(() => {
                        if (!getTokenFunc || getTokenFunc() === myToken) {
                            hideLoadingProgress();
                        }
                    }, 300);
                }
            }
        }).catch((err) => {
            // Direct close() ensures cleanup even on failure
            // (skip if already transferred to worker - neutered reference)
            if (!wasTransferred && imageToSend instanceof ImageBitmap) {
                try {
                    if (imageToSend && typeof imageToSend.close === 'function') {
                        imageToSend.close();
                        if (DEBUG.RENDER_ERROR_LOG) {
                            logger.debug('LOADER_LOG', 'Loader', 'ImageBitmap released after worker error');
                        }
                    }
                } catch (closeErr) {
                    logger.warn('Loader', 'Failed to close ImageBitmap on error:', closeErr);
                }
            }

            logger.error('Loader','Worker error:', err);

            if (DEBUG.AUDIT_LOG) {
                logger.debug('LOADER_LOG', 'Loader', `[AUDIT] Processing failed: ${file.name} | Format: ${format} | Error: ${err.message} | Timestamp: ${new Date().toISOString()}`);
            }

            // Fallback to the main thread if OffscreenCanvas is unsupported
            if (err.message && err.message.includes('OFFSCREEN_CANVAS_NOT_SUPPORTED')) {
                logger.warn('Loader','OffscreenCanvas not supported, falling back to main thread processing');
                // Token check: if a newer load has already started, this fallback is
                // stale. Skip it entirely so it doesn't touch the progress UI or end up
                // displaying an outdated image via processImageOnMainThread/loadTexture.
                const isStale = () => myToken !== null && getTokenFunc && getTokenFunc() !== myToken;
                if (isStale()) {
                    if (DEBUG.RENDER_ERROR_LOG) {
                        logger.debug('LOADER_LOG', 'Loader', 'Skipping stale main-thread fallback (token mismatch)');
                    }
                    return;
                }
                hideLoadingProgress();
                // Regenerate ImageBitmap from original file (processedImage was transferred to worker and is now neutered)
                return createImageBitmap(file).then(async freshImageBitmap => {
                    // Re-check the token after the async decode: a newer load may have
                    // started while createImageBitmap was running.
                    if (isStale()) {
                        if (freshImageBitmap && typeof freshImageBitmap.close === 'function') {
                            try { freshImageBitmap.close(); } catch (_) { /* ignore */ }
                        }
                        if (DEBUG.RENDER_ERROR_LOG) {
                            logger.debug('LOADER_LOG', 'Loader', 'Discarding stale main-thread fallback bitmap (token mismatch)');
                        }
                        return;
                    }
                    // Re-run validation on the fresh bitmap so the fallback honors the
                    // same trim decision the worker path used. The user already
                    // confirmed (or URL-forced) the trim earlier in this load, so force
                    // it without re-prompting; otherwise odd-dimension images would flow
                    // into processImageOnMainThread untrimmed. validation.image is the
                    // trimmed Canvas (or the original bitmap when no trim was needed);
                    // processImageOnMainThread accepts either.
                    const fallbackValidation = await validateAndProcessImage(freshImageBitmap, format, {
                        forceTrimWithoutDialog: true
                    });
                    const fallbackImage = fallbackValidation.image;
                    // If trimming produced a separate canvas, the original full-size
                    // bitmap is no longer needed; release it now.
                    if (fallbackImage !== freshImageBitmap &&
                        freshImageBitmap && typeof freshImageBitmap.close === 'function') {
                        try { freshImageBitmap.close(); } catch (_) { /* ignore */ }
                    }
                    if (isStale()) {
                        if (fallbackImage && fallbackImage !== freshImageBitmap &&
                            typeof fallbackImage.close === 'function') {
                            try { fallbackImage.close(); } catch (_) { /* ignore */ }
                        }
                        return;
                    }
                    // Pass a token-aware texture loader so a stale texture is discarded
                    // if a newer load starts during the main-thread decode.
                    await processImageOnMainThread(fallbackImage, format, file.name,
                        (textureUrl) => loadTexture(textureUrl, myToken, getTokenFunc),
                        isStale);
                });
            } else {
                // Skip touching shared UI if a newer load has already superseded
                // this one (mirrors the OFFSCREEN_CANVAS_NOT_SUPPORTED branch above
                // and the outer catch): otherwise a stale worker failure would hide
                // the in-flight load's progress and show a spurious error toast.
                if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
                    if (DEBUG.RENDER_ERROR_LOG) {
                        logger.debug('LOADER_LOG', 'Loader', 'Skipping stale worker-error UI reset (token mismatch)');
                    }
                    return;
                }
                // loadTexture already presented its own failure and reset the UI.
                // Do not turn one corrupt-image error into two stacked toasts.
                if (!err.__loadTextureHandled) {
                    showToast(window.t?.('messages.processingFailed') ?? 'Processing failed', 'error');
                    hideLoadingProgress();
                    resetUIStateAfterLoadError();
                }
                err.__loadFileWithFormatHandled = true;
                throw err;
            }
        });
    } catch (err) {
        // Token check: skip error handling if a new file load has superseded this
        // one (mirrors processJPSFile's catch). This also covers the rejection
        // clearDialogQueue() issues for this load's still-queued validation dialog
        // ('Dialog cancelled due to new file load'): without the guard, that
        // rejection would show a spurious "Failed to load file" toast and hide
        // the progress UI of the load actually in flight.
        if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
            if (DEBUG.RENDER_ERROR_LOG) {
                logger.debug('LOADER_LOG', 'Loader', 'loadFileWithFormat: Skipping error handling for superseded load:', err.message);
            }
            return;
        }
        if (err?.__loadTextureHandled) {
            // Texture decoding has already shown its error and reset the UI. This
            // path is reached by the main-thread OffscreenCanvas fallback, which
            // otherwise added a second generic "load failed" toast.
            err.__loadFileWithFormatHandled = true;
        } else if (!err?.__loadFileWithFormatHandled) {
            logger.error('Loader','ImageBitmap creation error:', err);
            showToast(window.t?.('messages.loadFailed') ?? 'Failed to load file', 'error');
            hideLoadingProgress();
            resetUIStateAfterLoadError();
            err.__loadFileWithFormatHandled = true;
        }
        throw err;
    }
}

/**
 * Process a JPS file
 * @param {File} file - JPS file
 * @param {number} myToken - File load identification token
 * @param {Function} getCurrentToken - Function to get the current token
 * @param {AbortSignal} signal - Abort signal for cancellation
 * @returns {Promise<void>}
 */
async function processJPSFile(file, myToken, getCurrentToken, signal) {
    try {
        // Read file as ArrayBuffer using Promise-based utility
        const arrayBuffer = await readFileAsArrayBuffer(file);

        // Abort check: return early if cancelled
        if (signal.aborted) {
            if (DEBUG.RENDER_ERROR_LOG) {
                logger.debug('LOADER_LOG', 'Loader', 'processJPSFile: Aborted after readFileAsArrayBuffer');
            }
            return;
        }

        // Token check: abort if a new file is loaded
        if (getCurrentToken() !== myToken) {
            if (DEBUG.RENDER_ERROR_LOG) {
                logger.debug('LOADER_LOG', 'Loader','processJPSFile: Skipping outdated JPS file load');
            }
            return;
        }

        // Create Blob URL from ArrayBuffer
        const blob = new Blob([arrayBuffer], { type: 'image/jpeg' });
        const url = createAndTrackBlobUrl(blob);

        // Detect format from aspect ratio before loading texture
        // JPS files are typically Half SBS (2:1 aspect ratio) but can be Full SBS (4:1)
        const detectedFormat = await detectJPSFormat(url, signal, getCurrentToken, myToken);

        // Set format if detection succeeded
        if (detectedFormat && getCurrentToken() === myToken && !signal.aborted) {
            state.currentImageFormat = detectedFormat;
            logger.info('Loader', `[processJPSFile] Detected format: ${detectedFormat}`);
        }

        // Abort/token check: a new file may have been selected while detectJPSFormat()
        // was awaiting. Without this guard the stale JPS texture would still be loaded
        // and rendered over the newer image (matches the MPO path's token-aware load).
        if (signal.aborted || getCurrentToken() !== myToken) {
            if (DEBUG.RENDER_ERROR_LOG) {
                logger.debug('LOADER_LOG', 'Loader', 'processJPSFile: Skipping outdated JPS texture load after format detection');
            }
            return;
        }

        // Load texture (await to ensure updateSceneWithImage completes).
        // Pass the token so a stale texture is discarded if a newer load starts
        // during the async decode.
        await loadTexture(url, myToken, getCurrentToken);

        // loadTexture's success path does not hide the loading overlay (its token
        // guard skips UI teardown), and nothing else hides it on the JPS success
        // path (unlike MPO / loadFileWithFormat). Hide it here so a successful .jps
        // load does not leave the progress overlay stuck. Guard on the token/abort
        // state so a superseded load does not tear down a newer load's overlay.
        if (!signal.aborted && getCurrentToken() === myToken) {
            hideLoadingProgress();
        }
    } catch (err) {
        // Token check: skip error handling if a new file is loaded
        if (getCurrentToken() !== myToken) {
            return;
        }

        // loadTexture (awaited above) already shows the loadFailed toast, hides the
        // progress UI, and resets UI state before rethrowing. Skip re-handling that
        // case here so a corrupt .jps does not produce two stacked toasts / a double
        // UI reset. Genuine file-read errors (no marker) still fall through below.
        if (err && err.__loadTextureHandled) {
            return;
        }

        // Handle file reading errors
        logger.error('Loader','Error reading JPS file:', err);
        const errorMessage = window.t?.('messages.loadFailed') || 'Failed to load the file.';
        showToast(errorMessage, 'error');
        hideLoadingProgress();
        resetUIStateAfterLoadError();
    }
}

/**
 * Detect JPS format from image aspect ratio
 * @param {string} url - Image URL
 * @param {AbortSignal} signal - Abort signal
 * @param {Function} getCurrentToken - Token getter function
 * @param {*} myToken - Current token
 * @returns {Promise<string|null>} Detected format ('half_sbs' or 'full_sbs') or null if failed
 * @private
 */
async function detectJPSFormat(url, signal, getCurrentToken, myToken) {
    // Base timeout for reading image dimensions. Every sibling image-decode helper
    // (loadImageFromUrl / loadImageFromDataURL / loadTextureAsync) carries a timeout;
    // without one here, a decode that never fires onload/onerror (a pathological or
    // huge blob that stalls the browser) would hang processJPSFile forever with no
    // toast and no UI reset.
    const JPS_DETECTION_TIMEOUT_MS = 15000;

    return new Promise((resolve) => {
        const img = new Image();
        let settled = false;
        let timeoutId = null;
        let abortHandler = null;

        const cleanup = () => {
            img.onload = null;
            img.onerror = null;
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
            if (abortHandler && signal) {
                signal.removeEventListener('abort', abortHandler);
                abortHandler = null;
            }
            // Clear src so the decoded JPS is not retained until GC (mirrors
            // cleanupDetectionResources / loadImageFromDataURL).
            img.src = '';
        };

        // Single-settle wrapper so the timeout, abort, onload and onerror paths
        // can never resolve twice or leak the listener/timer.
        const settle = (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };

        img.onload = () => {
            // Capture dimensions BEFORE cleanup(): cleanup() clears img.src, which
            // resets img.width/img.height to 0 (the same behavior documented in
            // prepareImageForDetection). Reading them after cleanup() would make
            // aspectRatio NaN and force every JPS — including 4:1 Full SBS — into
            // the half_sbs fallback.
            const imgWidth = img.width;
            const imgHeight = img.height;

            // Abort/token check
            if ((signal && signal.aborted) || getCurrentToken() !== myToken) {
                settle(null);
                return;
            }

            // Detect format from aspect ratio
            const aspectRatio = imgWidth / imgHeight;

            // Full SBS: aspect ratio ~4:1 (e.g., 3840x1080)
            // Half SBS: aspect ratio ~2:1 (e.g., 1920x1080)
            // Allow some tolerance for non-standard resolutions
            if (aspectRatio > 3.5) {
                settle('full_sbs');
            } else if (aspectRatio > 1.5) {
                settle('half_sbs');
            } else {
                // Unusual aspect ratio, default to Half SBS
                logger.warn('Loader', `[detectJPSFormat] Unusual aspect ratio ${aspectRatio.toFixed(2)}, defaulting to Half SBS`);
                settle('half_sbs');
            }
        };

        img.onerror = () => {
            logger.warn('Loader', '[detectJPSFormat] Failed to load image for detection, defaulting to Half SBS');
            settle('half_sbs'); // Fallback to Half SBS
        };

        // Fall back to Half SBS if the decode never settles, so the JPS load can
        // proceed (or be superseded) instead of hanging indefinitely.
        timeoutId = setTimeout(() => {
            logger.warn('Loader', `[detectJPSFormat] Detection timed out after ${JPS_DETECTION_TIMEOUT_MS}ms, defaulting to Half SBS`);
            settle('half_sbs');
        }, JPS_DETECTION_TIMEOUT_MS);

        // Propagate cancellation so a superseded/aborted load stops promptly.
        if (signal) {
            if (signal.aborted) {
                settle(null);
                return;
            }
            abortHandler = () => settle(null);
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        img.src = url;
    });
}

/**
 * Wrapper to load textures and update the scene
 * @param {string} url - Object URL
 * @param {number|null} myToken - File load identification token (optional; no check if null)
 * @param {Function|null} getTokenFunc - Function returning the current token (optional)
 * @returns {Promise<void>} Resolves after updateSceneWithImage completes
 */
async function loadTexture(url, myToken = null, getTokenFunc = null) {
    // Guard: allow loading even if initThree did not run for some reason
    if (!state.textureLoader) {
        state.textureLoader = new THREE.TextureLoader();
    }

    // Use texture cache to avoid duplicate GPU memory allocation
    const texture = getCachedOrCreateTexture(url, () => {
        // This function is called only if texture is not cached
        return new Promise((resolve, reject) => {
            state.textureLoader.load(
                url,
                function (loadedTexture) {
                    loadedTexture.minFilter = THREE.LinearFilter;
                    loadedTexture.magFilter = THREE.LinearFilter;
                    loadedTexture.generateMipmaps = false;
                    loadedTexture.wrapS = THREE.ClampToEdgeWrapping;
                    loadedTexture.wrapT = THREE.ClampToEdgeWrapping;

                    const maxSize = getMaxTextureSize();
                    if (loadedTexture.image.width > maxSize || loadedTexture.image.height > maxSize) {
                        logger.warn('Loader',
                            `[Loader] Image size (${loadedTexture.image.width}x${loadedTexture.image.height}) ` +
                            `exceeds GPU max texture size (${maxSize}x${maxSize}). ` +
                            `Performance may be degraded or rendering may fail.`
                        );
                    }

                    resolve(loadedTexture);
                },
                undefined,
                reject
            );
        });
    });

    try {
        // Handle both async (Promise) and sync (cached texture) paths
        let resolvedTexture;
        if (texture instanceof Promise) {
            resolvedTexture = await texture;
        } else if (texture) {
            resolvedTexture = texture;
        } else {
            // Cached texture is null - this should not happen but guard against it
            throw new Error('Cached texture is null or undefined');
        }

        // Token check after the async decode: a newer load may have started while
        // TextureLoader.load was decoding. Without this, the stale texture would be
        // displayed and the image parameters reset over the in-flight load. Dispose
        // the resolved texture and revoke the blob URL before bailing. Do NOT touch
        // shared UI/params state here (it belongs to the newer load).
        if (myToken !== null && getTokenFunc && getTokenFunc() !== myToken) {
            if (DEBUG.RENDER_ERROR_LOG) {
                logger.debug('LOADER_LOG', 'Loader', 'loadTexture: Skipping stale texture after decode (token mismatch)');
            }
            if (resolvedTexture && typeof resolvedTexture.dispose === 'function') {
                // Evict from the texture cache BEFORE disposing: getCachedOrCreateTexture
                // stores the resolved texture on resolve, so disposing without removing
                // would leave a disposed texture (pinning its full-res image) reachable
                // in the cache until MAX_TEXTURE_CACHE_SIZE eviction — a large memory
                // leak on rapid successive loads, and a violation of the "a disposed
                // texture is never served from the cache" invariant.
                removeTextureFromCache(resolvedTexture);
                try { resolvedTexture.dispose(); } catch (_) { /* ignore */ }
            }
            revokeTrackedBlobUrl(url);
            return;
        }

        // Reset parameters before loading a new image
        resetImageParameters();

        // Update scene with the loaded texture
        updateSceneWithImage(resolvedTexture);

        // Release the Blob URL after GPU upload completes.
        // Use double rAF to ensure the texture upload is fully processed
        // (consistent with the pattern in loader-image-creation.js).
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                revokeTrackedBlobUrl(url);
            });
        });
    } catch (err) {
        logger.error('Loader', "Texture load error:", err);
        // Release Object URL on error as well (prevent memory leaks)
        revokeTrackedBlobUrl(url);
        // Only surface the failure UI (toast + progress hide + reset) if this load
        // is still current. A superseded load's late decode failure must not tear
        // down the newer in-flight load's UI (mirrors the success-path token guard).
        if (myToken === null || !getTokenFunc || getTokenFunc() === myToken) {
            const errorMessage = window.t?.('messages.loadFailed') || 'Failed to load the image.';
            showToast(errorMessage, 'error');
            hideLoadingProgress();
            resetUIStateAfterLoadError();
        }
        // Mark so a caller that awaits loadTexture (processJPSFile) can tell this
        // failure was already surfaced here (toast + progress hide + UI reset) and
        // avoid showing a duplicate toast / doing a second reset when it rethrows.
        if (err && typeof err === 'object') {
            err.__loadTextureHandled = true;
        }
        throw err; // Re-throw to allow caller to handle
    }
}

// ===== Global exposure =====

// Export state management functions
export { clearPreviousImageState, restoreUrlDialogFlags, syncActiveExifState };

// Export image generation utilities
export { createSBSFromDualImages };

// Dual image loading
export function loadDualImageFiles(fileLeft, fileRight) {
    // Claim a new load generation so a dual-image load participates in the same
    // abort/token system as handleFile: abort the previous in-flight load, clear
    // any queued pixel-validation dialogs, and issue a fresh token. Without this a
    // slow dual load could overwrite a newer single-file load's scene/UI, or a
    // newer load's clearDialogQueue() could tear down this load's progress UI.
    if (currentFileLoadAbortController) {
        currentFileLoadAbortController.abort();
    }
    clearDialogQueue();
    currentFileLoadAbortController = new AbortController();
    const myToken = ++fileLoadToken;
    return loadDualImageFilesInternal(
        fileLeft, fileRight, getNextExifToken(), myToken, () => fileLoadToken
    );
}

// Export viewer mode functions
export { startViewerMode };

// Export external image mode functions (wrapper auto-injects required callbacks)
const startExternalImageModeWrapper = (imageUrl, mode = null, format = null, shiftXPx = null, shiftYPx = null, rotationDeg = null, zoomPct = null, cropParams = null) => {
    return startExternalImageMode(imageUrl, mode, format, shiftXPx, shiftYPx, rotationDeg, zoomPct, cropParams, handleFile, loadFileWithFormat, getFileLoadToken);
};
export { startExternalImageModeWrapper as startExternalImageMode };

// ===== Global namespace setup =====
// Pass the loadViewerImage callback directly to avoid circular indirection
// through window.StereoView.viewer.loadImage (which is itself set up by setupViewerGlobals)
const loadViewerImageCallback = (index) => loadViewerImage(index, handleFile);
setupViewerGlobals(loadViewerImageCallback, handleFile);
setupExternalGlobals(handleFile, loadFileWithFormat, getFileLoadToken);
