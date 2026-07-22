/**
 * main.js
 * Application entry point
 */

import * as THREE from 'three';
import { state, CONSTANTS } from './globals.js';
import { initThree, render, isRenderingStopped, clearTextureCache } from './rendering/renderer.js';
import { setupEventListeners, setupCropSelection, setupInputHandlers, cleanupUI } from './ui/ui.js';
import { cleanupFullscreenSystem } from './ui/ui-fullscreen.js';
import { cleanupViewerUI, parseUrlList } from './ui/ui-viewer.js';
import { cleanupExifModal } from './ui/ui-exif.js';
import { cleanupCropSelectionListeners } from './ui/ui-crop.js';
import { clearGifWorkerBlobUrl } from './ui/ui-export.js';
import { initVR, getVRSession, endVRSession, updateVRNavigation } from './rendering/vr.js';
import { startExternalImageMode, revokeAllActiveBlobUrls, startViewerMode } from './loaders/loader.js';
import { terminateWorker } from './loaders/loader-worker.js';
import { fetchTextWithSizeLimit, isHttpUrl, sanitizeDisplayUrl, isCorsOrNetworkError } from './loaders/loader-utils.js';
import { parseModeParam, parseFormatParam, parseShiftParam, parseRotationParam, parseZoomParam, parseCropParam } from './url-params.js';
import { checkForUpdates } from './core/versionCheck.js';
import { initUpdateNotification } from './ui/ui-update-notification.js';
import { initOfflineDetection, cleanupOfflineDetection } from './core/offlineDetection.js';
import { showToast } from './ui/ui-toast.js';
import * as logger from './utils/logger.js';

// Animation tracking variable for Wiggle mode
let lastWiggleTime = 0;

// Power-saving mode: control animation loop when the tab is hidden
let isAnimating = false;
let animationFrameId = null;

// Named handler for visibilitychange so it can be removed during cleanup
function handleVisibilityChange() {
    if (document.hidden) {
        // Tab hidden: stop animation
        stopAnimation();
    } else {
        // Tab visible: resume animation
        if (!isAnimating) {
            startAnimation();
        }
    }
}

// Initialization flag (prevent duplicate initialization)
let initialized = false;

// Start initialization after the DOM is fully built
// This prevents getElementById from returning null in setupEventListeners()
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    // If the DOM is already loaded (deferred script, etc.)
    init();
}

async function init() {
    // Prevent duplicate initialization
    if (initialized) {
        logger.warn('Main', 'init() called multiple times. Skipping duplicate initialization.');
        return;
    }
    initialized = true;

    // Register update listeners before awaiting locale fetches. A waiting service
    // worker can be discovered during window.load and CustomEvent is not replayed.
    initUpdateNotification();

    // Wait for i18n initialization (ensure translations work correctly)
    // Timeout after 5 seconds to prevent blocking app startup on slow/failing networks
    if (window.i18nReadyPromise) {
        let timedOut = false;
        const timeoutPromise = new Promise((resolve) => setTimeout(() => {
            timedOut = true;
            resolve({ success: false, error: 'timeout' });
        }, 5000));

        const result = await Promise.race([
            window.i18nReadyPromise,
            timeoutPromise
        ]);

        if (timedOut) {
            window.i18nReadyPromise.then((finalResult) => {
                if (finalResult && finalResult.success === false) {
                    logger.warn('Main', 'i18n initialization failed (late):', finalResult.error);
                } else {
                    logger.debug('MAIN_LOG', 'Main', 'i18n initialized successfully (after startup timeout)');
                }
            }).catch((err) => {
                logger.warn('Main', 'i18n promise rejected (late):', err);
            });
        } else if (result && result.success === false) {
            logger.warn('Main', 'i18n initialization failed:', result.error);
        }
    }

    // Early check for URL parameters to prevent UI flicker
    // If loading from external URL or list, set viewer mode UI immediately
    // Parse once here; the same object is passed to checkUrlParametersAndLoadImage() later.
    const urlParams = new URLSearchParams(window.location.search);
    try {
        const hasExternalSource = urlParams.has('src') || urlParams.has('list');

        if (hasExternalSource) {
            logger.info('Main', 'External source detected in URL, setting viewer mode UI early');
            applyEarlyViewerModeUI();
        }
    } catch (err) {
        logger.warn('Main', 'Error during early URL parameter check:', err);
    }

    // Set up UI event listeners first (DOM elements required)
    setupEventListeners();

    // Initialize Three.js
    const rendererInitialized = initThree('canvas-container');
    if (!rendererInitialized) {
        const errorMsg = window.t?.('messages.rendererInitFailed') ?? 'Failed to initialize 3D renderer. Please reload the page.';
        alert(errorMsg);
        throw new Error('Renderer initialization failed');
    }

    // WebGL context event handlers (cleanup required on page unload)
    const handleWebGLContextLost = () => {
        stopAnimation();
    };

    const handleWebGLContextRestored = () => {
        if (!document.hidden && !isAnimating) {
            startAnimation();
        }
    };

    const webglContextTarget = state.renderer?.domElement;
    if (webglContextTarget) {
        webglContextTarget.addEventListener('webglcontextlost', handleWebGLContextLost);
        webglContextTarget.addEventListener('webglcontextrestored', handleWebGLContextRestored);
    }

    // Store references for cleanup on page unload
    // Initialize namespace
    if (!window.StereoView) {
        window.StereoView = {};
    }
    if (!window.StereoView._internal) {
        window.StereoView._internal = {};
    }

    // Store WebGL context references in namespace
    window.StereoView._internal.webglContextTarget = webglContextTarget;
    window.StereoView._internal.webglContextLostHandler = handleWebGLContextLost;
    window.StereoView._internal.webglContextRestoredHandler = handleWebGLContextRestored;

    // Renderer-dependent initialization (after renderer init)
    setupCropSelection();
    setupInputHandlers();

    // Initialize VR features
    initVR();

    // Initialize offline detection
    initOfflineDetection();

    // Run version check (async; ignore errors)
    checkForUpdates().catch(err => {
        logger.warn('Main', 'Version check failed:', err);
    });

    // Standardize OpenCV initialization as Promise-based
    let openCVPromise = null;
    // Track active polling interval to prevent accumulation
    let activeOpenCVPollInterval = null;

    let openCVUiEnabled = false;
    const enableOpenCVUi = () => {
        // Idempotency guard: prevent duplicate UI updates from race conditions
        // (e.g. late OpenCV load after timeout + normal .then() both calling this)
        if (openCVUiEnabled) return;
        openCVUiEnabled = true;
        try {
            const btn = document.getElementById('autoAlignBtn');
            if (btn) btn.disabled = false;

            const statusEl = document.getElementById('opencvStatus');
            if (statusEl) {
                const variant = window.opencvBuildVariant || '';
                const readyText = window.t?.('status.opencvReady') ?? 'Ready';
                statusEl.textContent = variant ? `${readyText} (${variant})` : readyText;
                statusEl.setAttribute('data-i18n', 'status.opencvReady');
                statusEl.setAttribute('data-i18n-skip', '');
                statusEl.style.color = '#66bb6a';
            }
        } catch (err) {
            logger.error('Main', 'Error enabling OpenCV UI:', err);
        }
    };

    /**
     * Return a Promise that waits for OpenCV initialization (single instance)
     * Return the same Promise on multiple calls to prevent duplicate initialization
     */
    function waitForOpenCV() {
        if (openCVPromise) {
            return openCVPromise;
        }

        // Clear any orphaned polling interval from an incomplete initialization cycle
        if (activeOpenCVPollInterval !== null) {
            clearInterval(activeOpenCVPollInterval);
            activeOpenCVPollInterval = null;
        }

        // Resolve immediately if OpenCV is already available
        if (window.cv && window.cv.Mat) {
            openCVPromise = Promise.resolve();
            return openCVPromise;
        }

        // Create the Promise (only once)
        openCVPromise = new Promise((resolve, reject) => {
            let settled = false;
            let timedOut = false;

            const handleOpenCVReady = () => {
                try {
                    if (!window.cv || !window.cv.Mat) {
                        return;
                    }

                    if (timedOut) {
                        // OpenCV loaded after timeout: enable UI even though promise was rejected
                        cleanupLateListener();
                        enableOpenCVUi();
                        return;
                    }

                    if (!settled) {
                        settled = true;
                        cleanupAll();
                        resolve();
                    }
                } catch (err) {
                    logger.error('Main', 'Error in OpenCV ready handler:', err);
                    if (!settled) {
                        settled = true;
                        cleanupAll();
                        reject(err);
                    }
                }
            };

            const cleanupPollingAndTimeout = () => {
                if (activeOpenCVPollInterval !== null) {
                    clearInterval(activeOpenCVPollInterval);
                    activeOpenCVPollInterval = null;
                }
                clearTimeout(cvTimeout);
            };

            const cleanupAll = () => {
                cleanupLateListener();
                cleanupPollingAndTimeout();
            };

            const cleanupLateListener = () => {
                window.removeEventListener('opencv-ready', handleOpenCVReady);
            };

            // Event listener
            window.addEventListener('opencv-ready', handleOpenCVReady);

            // Polling (250ms interval) - tracked globally to prevent accumulation
            activeOpenCVPollInterval = setInterval(handleOpenCVReady, 250);

            // Timeout (30 seconds)
            const cvTimeout = setTimeout(() => {
                // Double-check settled flag to prevent race with polling
                if (!settled && !timedOut) {
                    settled = true;
                    timedOut = true;
                    // Stop polling and clear timeout, but keep event listener
                    // so late-loading OpenCV can still enable the UI
                    cleanupPollingAndTimeout();
                    openCVPromise = null;
                    reject(new Error('OpenCV initialization timeout'));
                }
            }, 30000);
        });

        return openCVPromise;
    }

    // Start OpenCV initialization (with error handling)
    waitForOpenCV()
        .then(() => {
            // Actions when OpenCV is ready
            try {
                enableOpenCVUi();
            } catch (err) {
                logger.error('Main', 'Error enabling OpenCV UI:', err);
            }
        })
        .catch(err => {
            logger.warn('Main', 'OpenCV initialization failed or timed out:', err.message);
            // Surface the failure in the status panel (the timeout path does not
            // dispatch opencvLoadError on its own). A late-loading OpenCV can still
            // fire opencv-ready afterward and flip the status back to Ready.
            window.dispatchEvent(new CustomEvent('opencv-error', { detail: err }));
        });

    // Power-saving mode: stop animation when the tab is hidden
    // Stop the animation loop when the page is hidden
    // Resume on visibility to reduce unnecessary CPU/GPU usage
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Start the animation loop
    startAnimation();

    // Check URL parameters and load an external image (urlParams parsed above)
    checkUrlParametersAndLoadImage(urlParams);

    // Set up page lifecycle handlers for cleanup
    setupPageLifecycleCleanup();
}

/**
 * Set up page lifecycle handlers for cleanup on page unload/navigation
 * Ensures all resources are properly released when the user leaves the page
 */
function setupPageLifecycleCleanup() {
    /**
     * Clean up all resources before page unload
     * Called on beforeunload and pagehide events
     */
    let cleanupDone = false;
    function performCleanup() {
        // Guard against double execution (beforeunload + pagehide may both fire)
        if (cleanupDone) return;
        cleanupDone = true;

        logger.info('Main', 'Performing page lifecycle cleanup');

        try {
            // Stop animation loop first (prevent further frame requests)
            stopAnimation();

            // Remove visibilitychange listener (registered in init)
            document.removeEventListener('visibilitychange', handleVisibilityChange);

            // Clean up all UI resources (single entry point for UI cleanup)
            // This orchestrates cleanup of all UI submodules:
            // - Window event listeners
            // - Fullscreen system
            // - Viewer UI
            // - EXIF modal
            // - Crop selection
            // - Offline detection
            cleanupUI();

            // Clean up i18n event listeners
            if (window.StereoView?.i18n?.cleanup) {
                window.StereoView.i18n.cleanup();
            }

            // Terminate Web Worker (fire-and-forget; beforeunload/pagehide are synchronous)
            terminateWorker().catch((err) => {
                logger.warn('Main', 'Error terminating worker:', err);
            });

            // Remove WebGL context event listeners
            const internal = window.StereoView?._internal;
            if (internal?.webglContextTarget && internal?.webglContextLostHandler) {
                internal.webglContextTarget.removeEventListener('webglcontextlost', internal.webglContextLostHandler);
                internal.webglContextLostHandler = null;
            }
            if (internal?.webglContextTarget && internal?.webglContextRestoredHandler) {
                internal.webglContextTarget.removeEventListener('webglcontextrestored', internal.webglContextRestoredHandler);
                internal.webglContextRestoredHandler = null;
            }
            if (internal) {
                internal.webglContextTarget = null;
            }

            // Disconnect ResizeObserver (if active)
            if (state.resizeObserver) {
                state.resizeObserver.disconnect();
                state.resizeObserver = null;
                logger.info('Main', 'ResizeObserver disconnected');
            }

            // End VR session if active (fire-and-forget; synchronous event handler)
            const currentVRSession = getVRSession();
            if (currentVRSession) {
                logger.info('Main', 'Ending VR session');
                endVRSession().catch((err) => {
                    logger.warn('Main', 'Error ending VR session:', err);
                });
            }

            // Release Three.js resources
            if (state.renderer) {
                // Disable XR if enabled
                if (state.renderer.xr && state.renderer.xr.enabled) {
                    state.renderer.xr.enabled = false;
                }
                // Clear animation loop
                state.renderer.setAnimationLoop(null);
            }

            // Clear texture cache (disposes all cached textures from GPU memory)
            clearTextureCache();

            clearGifWorkerBlobUrl();

            revokeAllActiveBlobUrls();

            logger.info('Main', 'Page lifecycle cleanup completed');
        } catch (err) {
            // Log but do not throw (cleanup must not fail)
            logger.error('Main', 'Error during page lifecycle cleanup:', err);
        }
    }

    // Use pagehide (NOT beforeunload) for tab close / navigation cleanup.
    // IMPORTANT: pagehide also fires when the page enters the back/forward cache
    // (bfcache), signalled by event.persisted === true. In that case the page is
    // frozen — not destroyed — and may be restored later via pageshow WITHOUT
    // re-running init(). Running destructive cleanup here (stopping animation,
    // terminating the worker, releasing WebGL/textures/Blob URLs) would leave the
    // restored page broken. Only clean up on a real unload (persisted === false).
    //
    // Deliberately no `beforeunload` listener: it fires BEFORE pagehide and has no
    // `persisted` flag, so it cannot tell a bfcache freeze from a real unload. In
    // browsers that bfcache pages despite a beforeunload listener (e.g. Chrome
    // desktop) it would destroy all resources on navigation, and pressing Back
    // would then restore a frozen, broken page — the exact failure the pagehide
    // guard below prevents. pagehide fires on real unloads in every modern browser.
    window.addEventListener('pagehide', (event) => {
        if (event.persisted) {
            logger.info('Main', 'pagehide with persisted=true (entering bfcache); skipping destructive cleanup');
            return;
        }
        performCleanup();
    });

    // Note: visibilitychange to 'hidden' is NOT used for cleanup here.
    // Unlike beforeunload/pagehide, visibilitychange fires on normal tab switches
    // and window minimization — running destructive cleanup in those cases would
    // destroy all resources (WebGL, workers, textures) and freeze the UI when the
    // user returns to the tab.
}

// Apply the viewer-mode UI early (before the async load) to avoid a flash of the
// normal menu. Reversible: each hidden element's prior inline display is recorded
// under dataset.prevDisplay (the same convention loader-external.js uses), so a
// later validation/load failure can restore the normal UI via
// restoreEarlyViewerModeUI() instead of stranding the user in an empty viewer
// shell. startExternalImageMode() shares the convention and skips re-capturing an
// already-stored value, so its own error-path restore stays correct too.
function applyEarlyViewerModeUI() {
    const earlyStyle = document.getElementById('early-viewer-mode-style');
    if (earlyStyle) {
        earlyStyle.remove();
    }

    const hide = (id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.dataset.prevDisplay === undefined) {
            el.dataset.prevDisplay = el.style.display;
        }
        el.style.display = 'none';
    };

    hide('ui-container');
    hide('status-panel');
    hide('showStatusBtn');
    hide('histogram-panel');

    const viewerBar = document.getElementById('viewer-mode-bar');
    if (viewerBar) {
        if (viewerBar.dataset.prevDisplay === undefined) {
            viewerBar.dataset.prevDisplay = viewerBar.style.display;
        }
        viewerBar.style.display = 'flex';
        viewerBar.classList.remove('viewer-bar-hidden');
    }

    document.body.classList.add('viewer-mode');
    document.body.classList.remove('status-open');
    const canvasContainer = document.getElementById('canvas-container');
    if (canvasContainer) {
        canvasContainer.classList.add('viewer-mode');
    }
}

// Undo applyEarlyViewerModeUI(). Only restores elements the early switch actually
// touched (dataset.prevDisplay set), so it is a safe no-op when the early switch
// never ran. Used by the URL-parameter failure paths that return without entering
// a real viewer/external mode.
function restoreEarlyViewerModeUI() {
    const restore = (id) => {
        const el = document.getElementById(id);
        if (!el || el.dataset.prevDisplay === undefined) return;
        el.style.display = el.dataset.prevDisplay;
        delete el.dataset.prevDisplay;
    };

    restore('ui-container');
    restore('status-panel');
    restore('showStatusBtn');
    restore('histogram-panel');
    restore('viewer-mode-bar');

    document.body.classList.remove('viewer-mode');
    // Re-add the default drawer/status classes that the early viewer-mode switch
    // stripped (early-viewer-mode.js removes menu-open/status-open; applyEarlyViewerModeUI
    // removes status-open). Without this the page returns from a failed ?src=/?list=
    // load with the panels visible but the body lacking these classes, so the drawer
    // handle and status-toggle button render on top of the already-open panels and the
    // menu toggle starts inverted. index.html's initial body state is these two classes.
    document.body.classList.add('menu-open', 'status-open');
    const canvasContainer = document.getElementById('canvas-container');
    if (canvasContainer) {
        canvasContainer.classList.remove('viewer-mode');
    }
}

/**
 * Reset state left over from a failed ?list= load: clear the URL-params flag (set
 * true before the load starts) so a subsequent local viewer session is not treated
 * as URL-originated — which would force-trim odd images without a dialog and hide the
 * viewer Exit button — and strip the `list` param so a reload does not re-trigger the
 * broken fetch. Mirrors the ?src= failure cleanup in loader-external.js.
 */
function resetFailedUrlListState() {
    state.loadedFromUrlParams = false;
    const url = new URL(window.location.href);
    url.searchParams.delete('list');
    // Preserve any fragment (url.hash) — stripping it would drop a deep link the
    // user may still rely on after the failed list load.
    window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
}

/**
 * Load a URL list from a text file and start viewer mode
 * @param {string} listUrl - URL of the text file containing URL list
 */
async function loadUrlListAndStartViewerMode(listUrl) {
    try {
        // Validate URL scheme (http/https only)
        if (!isHttpUrl(listUrl, window.location.href)) {
            logger.error('Main', 'Invalid list URL (scheme or format):', listUrl);
            showToast(window.t?.('messages.invalidUrl') ?? 'Invalid URL: only HTTP/HTTPS protocols are supported', 'error');
            resetFailedUrlListState();
            restoreEarlyViewerModeUI();
            return;
        }

        logger.info('Main', 'Fetching URL list from:', sanitizeDisplayUrl(listUrl));

        // Fetch the text file with a timeout + incremental size cap so a hung
        // connection cannot block the UI and an oversized/unbounded body cannot
        // be buffered fully into memory before the size check.
        const text = await fetchTextWithSizeLimit(listUrl, {
            maxBytes: CONSTANTS.URL_LIST_MAX_BYTES,
            timeout: CONSTANTS.URL_LIST_FETCH_TIMEOUT
        });

        // Parse URL list (capped to a maximum number of entries). Pass the list
        // file's own URL as the base so entries may use paths relative to where
        // the list lives; absolute URLs in the list are unaffected.
        const urlItems = parseUrlList(text, CONSTANTS.URL_LIST_MAX_ENTRIES, listUrl);

        if (urlItems.length === 0) {
            showToast(window.t?.('messages.noValidUrls') ?? 'No valid URLs found in the list', 'error');
            resetFailedUrlListState();
            restoreEarlyViewerModeUI();
            return;
        }

        logger.info('Main', `Loaded ${urlItems.length} URL(s) from list, starting viewer mode`);

        // Start viewer mode with the URL list
        await startViewerMode(urlItems);

    } catch (err) {
        logger.error('Main', 'Failed to load URL list:', err);

        // Shared classifier also catches Safari's "Load failed" (err.name ===
        // 'TypeError'), which a plain substring check would miss.
        const isCORSError = isCorsOrNetworkError(err);

        const errorMessage = isCORSError
            ? (window.t?.('messages.corsError') ?? 'Unable to load the URL list due to CORS policy.')
            : (window.t?.('messages.loadFailed') ?? 'Failed to load URL list');

        // Strip the query string before display to avoid leaking sensitive
        // params (API keys, tokens), matching the external-image error path.
        showToast(`${errorMessage}\n\nURL: ${sanitizeDisplayUrl(listUrl)}\n\nError: ${err.message}`, 'error', 8000);
        resetFailedUrlListState();
        restoreEarlyViewerModeUI();
    }
}

/**
 * Parse URL parameters and start external image mode or viewer mode
 * - Load an external image with ?src=<image URL>
 * - Load a URL list with ?list=<text file URL>
 * - Specify display mode with ?mode=<mode name> (optional)
 * @param {URLSearchParams} urlParams - Already-parsed URL parameters
 */
function checkUrlParametersAndLoadImage(urlParams) {
    try {

        // Check the list parameter first (takes precedence over src)
        const listUrl = urlParams.get('list');
        if (listUrl) {
            state.loadedFromUrlParams = true;
            loadUrlListAndStartViewerMode(listUrl).catch(err => {
                logger.error('Main', 'Failed to load URL list:', err);
            });
            return;
        }

        // Check the src parameter
        const imageUrl = urlParams.get('src');
        if (!imageUrl) {
            // An empty/absent src (e.g. "?src=") may still have triggered the early
            // viewer-mode UI switch via urlParams.has(); restore the normal UI so the
            // user is not stranded in an empty viewer shell.
            restoreEarlyViewerModeUI();
            return; // Do nothing if there is no src or list parameter
        }

        // Basic URL validation: ensure it's http/https
        if (!isHttpUrl(imageUrl, window.location.href)) {
            logger.error('Main', 'Invalid URL (scheme or format):', imageUrl);
            showToast(window.t?.('messages.invalidUrl') ?? 'Invalid URL: only HTTP/HTTPS protocols are supported', 'error');
            restoreEarlyViewerModeUI();
            return;
        }

        // Check the mode parameter (optional). Shared validator only accepts
        // mode names (not numbers) and rejects illegal characters.
        let mode = null;
        const modeParam = urlParams.get('mode');
        if (modeParam) {
            mode = parseModeParam(modeParam);
            if (mode === null) {
                logger.warn('Main', 'Invalid mode parameter (only mode names are accepted, not numbers):', modeParam);
            }
        }

        // Check the format parameter (optional)
        // When specified, skip auto-detection and load with this image format
        let format = null;
        const formatParam = urlParams.get('format');
        if (formatParam) {
            format = parseFormatParam(formatParam);
            if (format === null) {
                logger.warn('Main', 'Invalid format parameter:', formatParam);
            }
        }

        // Check the x parameter (shift X in pixels, optional)
        let shiftXPx = null;
        const xParam = urlParams.get('x');
        if (xParam !== null) {
            const parsedX = parseShiftParam(xParam);
            if (parsedX === null) {
                logger.warn('Main', 'Invalid x parameter (not a finite number):', xParam);
            } else {
                shiftXPx = parsedX.value;
                if (parsedX.clamped) {
                    logger.warn('Main', `x parameter out of range (${xParam}), clamped to ${shiftXPx}`);
                }
            }
        }

        // Check the y parameter (shift Y in pixels, optional)
        let shiftYPx = null;
        const yParam = urlParams.get('y');
        if (yParam !== null) {
            const parsedY = parseShiftParam(yParam);
            if (parsedY === null) {
                logger.warn('Main', 'Invalid y parameter (not a finite number):', yParam);
            } else {
                shiftYPx = parsedY.value;
                if (parsedY.clamped) {
                    logger.warn('Main', `y parameter out of range (${yParam}), clamped to ${shiftYPx}`);
                }
            }
        }

        // Check the r parameter (rotation / roll in degrees, optional) and the
        // z parameter (vertical zoom in percent, optional). Together they carry
        // the vertical-affine alignment (geometric refinement) that x/y alone
        // cannot express.
        let rotationDeg = null;
        const rParam = urlParams.get('r');
        if (rParam !== null) {
            const parsedR = parseRotationParam(rParam);
            if (parsedR === null) {
                logger.warn('Main', 'Invalid r parameter (not a finite number):', rParam);
            } else {
                rotationDeg = parsedR.value;
                if (parsedR.clamped) {
                    logger.warn('Main', `r parameter out of range (${rParam}), clamped to ${rotationDeg}`);
                }
            }
        }

        let zoomPct = null;
        const zParam = urlParams.get('z');
        if (zParam !== null) {
            const parsedZ = parseZoomParam(zParam);
            if (parsedZ === null) {
                logger.warn('Main', 'Invalid z parameter (not a finite number):', zParam);
            } else {
                zoomPct = parsedZ.value;
                if (parsedZ.clamped) {
                    logger.warn('Main', `z parameter out of range (${zParam}), clamped to ${zoomPct}`);
                }
            }
        }

        // Check the crop parameter (crop=cropX,cropY,offsetX,offsetY, optional).
        // These are the shader's normalized, resolution-independent crop uniforms.
        let cropParams = null;
        const cropParam = urlParams.get('crop');
        if (cropParam !== null) {
            cropParams = parseCropParam(cropParam);
            if (cropParams === null) {
                logger.warn('Main', 'Invalid crop parameter (expected four comma-separated numbers):', cropParam);
            } else if (cropParams.clamped) {
                logger.warn('Main', `crop parameter out of range (${cropParam}), clamped`);
            }
        }

        // Start external image mode (with error handling inside startExternalImageMode)
        state.loadedFromUrlParams = true;
        logger.info('Main', `Loading external image: ${sanitizeDisplayUrl(imageUrl)}, mode: ${mode}, format: ${format}, x: ${shiftXPx}, y: ${shiftYPx}, r: ${rotationDeg}, z: ${zoomPct}, crop: ${cropParams ? `${cropParams.cropX},${cropParams.cropY},${cropParams.offsetX},${cropParams.offsetY}` : null}`);
        startExternalImageMode(imageUrl, mode, format, shiftXPx, shiftYPx, rotationDeg, zoomPct, cropParams).catch(err => {
            logger.error('Main', 'Failed to load external image:', err);
            showToast(window.t?.('messages.failedToLoadExternalImage') ?? 'Failed to load external image. Check CORS settings and URL validity.', 'error', 8000);
        });
    } catch (err) {
        logger.error('Main', 'Error in checkUrlParametersAndLoadImage:', err);
        restoreEarlyViewerModeUI();
    }
}

/**
 * Start the animation loop
 */
function startAnimation() {
    if (!isAnimating) {
        isAnimating = true;
        animate();
    }
}

/**
 * Stop the animation loop
 */
function stopAnimation() {
    isAnimating = false;
    if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

/**
 * Resume the normal requestAnimationFrame loop after a VR session ends.
 *
 * Cancels any existing rAF chain first, then starts exactly one. This matters for
 * a failed VR start (e.g. the requestSession timeout) where VR never became active
 * and the normal loop was therefore never stopped: calling animate() directly there
 * bypasses startAnimation()'s isAnimating guard and would spawn a second concurrent
 * chain (one extra per failed attempt). On a normal VR exit the old chain is already
 * dead, so the cancel is a harmless no-op and this simply restarts rendering.
 */
export function resumeAnimationLoop() {
    if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
    isAnimating = true;
    animate();
}

export function animate() {
    // Null guard: renderer may be null after cleanup or if initThree failed
    if (!state.renderer) return;

    // Power-saving mode: do not continue the loop when animation is stopped
    if (!isAnimating && !state.renderer.xr.enabled) {
        return;
    }

    // Stop the animation loop if rendering has stopped due to an error
    // (do not continue unnecessary requestAnimationFrame calls)
    if (isRenderingStopped()) {
        stopAnimation();
        return;
    }

    // In VR mode, WebXRManager manages the animation loop automatically
    // In normal mode, use requestAnimationFrame
    if (!state.renderer.xr.enabled) {
        animationFrameId = requestAnimationFrame(animate);
    }

    // Animation handling for Wiggle mode (6)
    if (state.material && state.params.mode === 6) {
        const now = performance.now();

        // Toggle at the specified interval
        if (now - lastWiggleTime > CONSTANTS.WIGGLE_ANIMATION_INTERVAL_MS) {
            const currentPhase = state.params.wigglePhase;
            // 0.0 -> 1.0 -> 0.0
            const nextPhase = (currentPhase === 0.0) ? 1.0 : 0.0;

            // Update both state and uniforms
            state.params.wigglePhase = nextPhase;
            if (state.material) state.material.uniforms.wigglePhase.value = nextPhase;

            lastWiggleTime = now;
        }
    }

    if (state.renderer.xr.enabled) {
        updateVRNavigation();
    }

    render();
}
