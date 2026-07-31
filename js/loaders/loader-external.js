/**
 * loader-external.js
 * External image mode management module
 * Load images from URL parameters
 */

import { state, DEBUG } from '../globals.js';
import { showVRButton } from '../rendering/vr.js';
import { onWindowResize } from '../rendering/renderer.js';
import { fetchImageAsFile, sanitizeDisplayUrl, isCorsOrNetworkError } from './loader-utils.js';
import { showLoadingProgress, hideLoadingProgress } from './loader-ui-progress.js';
import { updateParamValue } from '../ui/ui-parameters.js';
import { showToast } from '../ui/ui-toast.js';
import { rotZoomToAlignTransform, splitVerticalShift } from '../rendering/alignment-geometry.js';
import * as logger from '../utils/logger.js';

/**
 * Start external image mode (when loading from URL parameters)
 * @param {string} imageUrl - Image URL
 * @param {number} mode - Display mode (optional)
 * @param {string|null} format - Image format: 'full_sbs', 'half_sbs', 'full_tab', 'half_tab', 'interlace_h', 'interlace_v' (optional; skips auto-detection when specified)
 * @param {number|null} shiftXPx - Parallax shift in pixels (optional)
 * @param {number|null} shiftYPx - Vertical shift in pixels (optional)
 * @param {number|null} rotationDeg - Alignment roll in degrees (optional)
 * @param {number|null} zoomPct - Alignment vertical-zoom in percent (optional)
 * @param {{cropX:number,cropY:number,offsetX:number,offsetY:number}|null} cropParams - Normalized crop window (optional)
 * @param {Function} handleFileCallback - File handling callback
 * @param {Function} loadFileWithFormatCallback - Format-specific load callback
 * @param {Function} [getFileLoadTokenCallback] - Returns the current file-load
 *   generation token, used to detect that a newer load superseded this one.
 */
export async function startExternalImageMode(imageUrl, mode, format, shiftXPx, shiftYPx, rotationDeg, zoomPct, cropParams, handleFileCallback, loadFileWithFormatCallback, getFileLoadTokenCallback) {
    if (!imageUrl) return;

    // Declared at function scope so the catch block can detach a still-pending
    // stereo-image-loaded listener if the load throws after it was registered.
    let applyResizeAndShift = null;
    let fallbackTimeout = null;
    // The file-load generation token this load owns (captured right after kicking
    // off the load, before awaiting). Lets applyResizeAndShift/the fallback detect
    // that a newer load (e.g. a local file the user dropped mid-fetch) superseded
    // us, so we never apply this URL's shift/crop to an unrelated image.
    let myLoadToken = null;
    const isSuperseded = () => myLoadToken !== null
        && typeof getFileLoadTokenCallback === 'function'
        && getFileLoadTokenCallback() !== myLoadToken;

    const storePrevDisplay = (element) => {
        if (!element) return;
        if (element.dataset.prevDisplay === undefined) {
            element.dataset.prevDisplay = element.style.display;
        }
    };

    const restorePrevDisplay = (element) => {
        if (!element) return;
        if (element.dataset.prevDisplay !== undefined) {
            element.style.display = element.dataset.prevDisplay;
            delete element.dataset.prevDisplay;
        } else {
            element.style.display = '';
        }
    };

    // Enable external image mode
    state.externalImageMode = true;
    state.externalImageUrl = imageUrl;
    state.viewerMode = true;
    state.viewerFiles = [];
    state.viewerCurrentIndex = 0;

    // Reset viewer mode parameters
    state.viewerScale = 1.0;
    state.viewerPanX = 0;
    state.viewerPanY = 0;
    state.viewerFitScale = 1.0;

    // Display-mode state captured before the URL's mode is applied, so a failed
    // load can roll it back (see the catch block).
    const preUrlDisplayMode = {
        params: state.params.mode,
        viewer: state.viewerDisplayMode,
        select: document.getElementById('viewerDisplayMode')?.value ?? null
    };

    // Point the viewer bar's mode dropdown — and with it the viewer's remembered
    // mode, as applyViewerDisplayMode does, since external image mode is a viewer
    // session — at a display mode. Used to apply this URL's `mode=` below and, when
    // the load is discarded, to fall back to the mode actually in effect.
    const syncViewerModeSelect = (targetMode) => {
        if (!Number.isInteger(targetMode)) return;
        state.viewerDisplayMode = targetMode;
        const viewerModeSelect = document.getElementById('viewerDisplayMode');
        if (viewerModeSelect && viewerModeSelect.value !== String(targetMode)) {
            viewerModeSelect.value = String(targetMode);
        }
    };

    // Apply mode if specified, and sync the viewer bar's mode dropdown with it.
    // The ?list= path routes every per-image mode through applyViewerDisplayMode(),
    // which syncs the dropdown; this path sets state.params.mode directly, so
    // nothing else updated the <select> and it kept showing its first option
    // (anaglyph) while the image rendered in the requested mode. Every mode
    // reachable from ?mode= has a matching <option> (MODE_NAME_MAP <-> the
    // #viewerDisplayMode options, locked in by tests/mode-select-options.test.mjs),
    // so the assignment can never leave the select blank.
    if (mode !== null && typeof mode === 'number') {
        state.params.mode = mode;
        syncViewerModeSelect(mode);
    }

    const menuPanel = document.getElementById('ui-container');
    if (menuPanel) {
        storePrevDisplay(menuPanel);
        menuPanel.style.display = 'none';
    }

    const viewerBar = document.getElementById('viewer-mode-bar');
    if (viewerBar) {
        storePrevDisplay(viewerBar);
        viewerBar.style.display = 'flex';
        viewerBar.classList.remove('viewer-bar-hidden');
    }

    // Show VR button (if VR is supported)
    showVRButton();

    const canvasContainer = document.getElementById('canvas-container');
    if (!canvasContainer) {
        logger.error('LoaderExternal', 'Critical: canvas-container element not found. Cannot proceed with external image mode.');
        throw new Error('Required DOM element "canvas-container" not found');
    }
    canvasContainer.classList.add('viewer-mode');

    // Hide status panel (including iconified state)
    const statusPanel = document.getElementById('status-panel');
    if (statusPanel) {
        storePrevDisplay(statusPanel);
        statusPanel.style.display = 'none';
    }
    // Remove the status panel body class as well
    document.body.classList.remove('status-open');
    // Add viewer mode class (CSS hides showStatusBtn)
    document.body.classList.add('viewer-mode');

    // Hide icon button that reopens the status panel
    const showStatusBtn = document.getElementById('showStatusBtn');
    if (showStatusBtn) {
        storePrevDisplay(showStatusBtn);
        showStatusBtn.style.display = 'none';
    }

    // Hide histogram panel
    const histogramPanel = document.getElementById('histogram-panel');
    if (histogramPanel) {
        storePrevDisplay(histogramPanel);
        histogramPanel.style.display = 'none';
    }

    // Hide navigation buttons for external image mode (single image)
    const prevBtn = document.getElementById('viewerPrevBtn');
    const nextBtn = document.getElementById('viewerNextBtn');
    const loopBtn = document.getElementById('viewerLoopBtn');
    const fileListBtn = document.getElementById('viewerListBtn');
    const slideshowSelect = document.getElementById('viewerSlideshowSpeed');

    if (prevBtn) {
        storePrevDisplay(prevBtn);
        prevBtn.style.display = 'none';
    }
    if (nextBtn) {
        storePrevDisplay(nextBtn);
        nextBtn.style.display = 'none';
    }
    if (loopBtn) {
        storePrevDisplay(loopBtn);
        loopBtn.style.display = 'none';
    }
    if (fileListBtn) {
        storePrevDisplay(fileListBtn);
        fileListBtn.style.display = 'none';
    }
    if (slideshowSelect) {
        storePrevDisplay(slideshowSelect);
        slideshowSelect.style.display = 'none';
    }

    const restoreExternalModeUI = () => {
        // Restore hidden UI components
        restorePrevDisplay(menuPanel);
        restorePrevDisplay(viewerBar);
        restorePrevDisplay(statusPanel);
        restorePrevDisplay(showStatusBtn);
        restorePrevDisplay(histogramPanel);
        restorePrevDisplay(prevBtn);
        restorePrevDisplay(nextBtn);
        restorePrevDisplay(loopBtn);
        restorePrevDisplay(fileListBtn);
        restorePrevDisplay(slideshowSelect);

        // Reset viewer mode CSS classes
        if (canvasContainer) {
            canvasContainer.classList.remove('viewer-mode');
        }
        document.body.classList.remove('viewer-mode');
    };

    try {
        // Fetch image from URL
        showLoadingProgress(10);
        const file = await fetchImageAsFile(imageUrl);
        showLoadingProgress(30);

        const filenameEl = document.getElementById('viewerFilename');
        if (filenameEl) {
            filenameEl.textContent = file.name || 'External Image';
        } else {
            // Log warning if filename display element is missing
            if (DEBUG.RENDER_ERROR_LOG) {
                logger.warn('LoaderExternal','viewerFilename element not found - filename will not be displayed');
            }
        }

        // Auto-fit and apply shift values in viewer mode.
        // Use event-based synchronization with the 'stereo-image-loaded' event.
        let resizeAndShiftApplied = false;

        applyResizeAndShift = () => {
            if (resizeAndShiftApplied) return; // Prevent double execution
            // Superseded by a newer load: the stereo-image-loaded event we are
            // handling belongs to a different image (e.g. a local file dropped
            // during this URL's fetch). Do not apply this URL's shift/crop to it.
            if (isSuperseded()) {
                resizeAndShiftApplied = true;
                window.removeEventListener('stereo-image-loaded', applyResizeAndShift);
                logger.info('LoaderExternal', '[External] Load superseded by a newer load; skipping resize/shift.');
                return;
            }
            resizeAndShiftApplied = true;

            // Clear fallback timeout if event fired
            if (fallbackTimeout) {
                clearTimeout(fallbackTimeout);
                fallbackTimeout = null;
            }

            // Apply the crop window BEFORE the auto-fit. Crop is normalized and
            // resolution-independent, and the fit (fitImageToWindow via
            // onWindowResize) plus updateMeshTransform both scale the mesh by
            // (1 - cropX/cropY), so the crop must be in state.params before the
            // fit runs — otherwise the cropped image renders at the wrong scale.
            if (cropParams) {
                try {
                    updateParamValue('cropX', cropParams.cropX);
                    updateParamValue('cropY', cropParams.cropY);
                    updateParamValue('offsetX', cropParams.offsetX);
                    updateParamValue('offsetY', cropParams.offsetY);
                    logger.info('LoaderExternal', `[External] Applied crop: ${cropParams.cropX},${cropParams.cropY},${cropParams.offsetX},${cropParams.offsetY}`);
                } catch (err) {
                    logger.warn('LoaderExternal', '[External] Error applying crop values:', err);
                }
            }

            try {
                onWindowResize();
            } catch (err) {
                logger.warn('LoaderExternal','[External] Error during auto-fit resize:', err);
            }

            // Build the vertical-affine alignTransform from rotation/zoom FIRST, so
            // the vertical-shift step below can fold any clamp overflow into its a[7]
            // constant. Resolution-independent (no image dimensions needed), but must
            // run here so it overwrites the identity reset that clearPreviousImageState
            // performed during the load. Kept as a local base matrix (only written to
            // state once, together with the vertical shift) so a large `y` and a
            // rotation/zoom in the same URL do not fight over alignTransform.
            const hasRotZoom = rotationDeg !== null || zoomPct !== null;
            let baseAlign = null;
            if (hasRotZoom) {
                try {
                    baseAlign = rotZoomToAlignTransform(rotationDeg ?? 0, zoomPct ?? 0);
                    logger.info('LoaderExternal', `[External] Applied rotation: ${rotationDeg ?? 0}deg, zoom: ${zoomPct ?? 0}%`);
                } catch (err) {
                    logger.warn('LoaderExternal', '[External] Error applying rotation/zoom values:', err);
                }
            }

            // Apply shift values from URL parameters (requires loaded image dimensions)
            if (shiftXPx !== null || shiftYPx !== null || baseAlign) {
                try {
                    const img = state.material?.uniforms?.map?.value?.image;
                    if (img) {
                        if (shiftXPx !== null) {
                            const normalizedX = shiftXPx / img.width;
                            updateParamValue('shiftX', normalizedX);
                            logger.info('LoaderExternal',`[External] Applied shiftX: ${shiftXPx}px -> ${normalizedX.toFixed(6)}`);
                        }
                        if (shiftYPx !== null) {
                            // The exporter folds the matrix constant f (= -a[7]) into the
                            // vertical `y`, which can exceed the shiftY ±0.1 slider clamp.
                            // splitVerticalShift keeps the in-range part in shiftY and folds
                            // the overflow back into a[7] so vertical parallax > 10% (adopted
                            // affine) round-trips losslessly instead of being truncated.
                            const normalizedY = shiftYPx / img.height;
                            const { shiftY, alignTransform } = splitVerticalShift(
                                normalizedY, baseAlign ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]
                            );
                            updateParamValue('shiftY', shiftY);
                            updateParamValue('alignTransform', alignTransform);
                            logger.info('LoaderExternal',`[External] Applied shiftY: ${shiftYPx}px -> ${normalizedY.toFixed(6)} (shiftY=${shiftY.toFixed(6)}, a7=${alignTransform[7].toFixed(6)})`);
                        } else if (baseAlign) {
                            // Rotation/zoom without a vertical shift: apply the base matrix as-is.
                            updateParamValue('alignTransform', baseAlign);
                        }
                    } else {
                        logger.warn('LoaderExternal', '[External] Image not available for shift calculation');
                        // Still apply rotation/zoom, which does not need image dimensions.
                        if (baseAlign) {
                            updateParamValue('alignTransform', baseAlign);
                        }
                    }
                } catch (err) {
                    logger.warn('LoaderExternal','[External] Error applying shift values:', err);
                }
            }
        };

        // Register the listener BEFORE starting the load. stereo-image-loaded is
        // dispatched synchronously inside updateSceneWithImage(), so attaching it
        // only after awaiting the load risks missing the event (e.g. a cached
        // texture), which would delay the resize/shift until the 5s fallback.
        window.addEventListener('stereo-image-loaded', applyResizeAndShift, { once: true });

        // Capture the load token our load owns immediately after kicking it off,
        // BEFORE awaiting: handleFile()/loadFileWithFormat() bump the token in their
        // synchronous prefix, so reading it here (still synchronous) yields our own
        // token, not a later load's. isSuperseded() then compares against it.
        // .mpo/.jps are container formats whose stereo layout comes from the file
        // itself (MPO embeds two JPEGs; JPS is a raw SBS JPEG). loadFileWithFormat has
        // no routing for them and would decode only the first embedded JPEG of an MPO
        // (then width-double it as "half SBS") or width-double a raw JPS — corrupting a
        // shared ?src=...&format= link. Route them through handleFile so the
        // extension-specific loader runs; the format hint is intentionally ignored.
        const lowerName = (file.name || '').toLowerCase();
        const isContainerFormat = lowerName.endsWith('.mpo') || lowerName.endsWith('.jps');

        if (format && !isContainerFormat) {
            // Format explicitly specified via URL parameter: skip auto-detection
            logger.info('LoaderExternal',`[External Image Mode] Loading with specified format: ${format}`);
            state.currentImageFormat = format;
            const loadPromise = loadFileWithFormatCallback(file, format, false);
            myLoadToken = (typeof getFileLoadTokenCallback === 'function') ? getFileLoadTokenCallback() : null;
            await loadPromise;
        } else {
            // Auto-detect format (default behavior), or a container file whose format
            // hint we deliberately ignore. In external image mode, do not show the
            // format selection dialog; use suppressFormatDialog to load with default.
            if (format && isContainerFormat) {
                logger.info('LoaderExternal', `[External Image Mode] Ignoring format=${format} for container file "${lowerName}"; using the extension-specific loader`);
            } else {
                logger.info('LoaderExternal', '[External Image Mode] Auto-detecting format or loading as Half SBS');
            }
            const loadPromise = handleFileCallback(file, {
                suppressFormatDialog: true,
                defaultFormat: 'half_sbs',
                // Preserve the URL-specified mode: handleFile() clears params via
                // clearPreviousImageState(), so it must re-apply mode itself.
                mode: (mode !== null && typeof mode === 'number') ? mode : null
            });
            myLoadToken = (typeof getFileLoadTokenCallback === 'function') ? getFileLoadTokenCallback() : null;
            await loadPromise;
        }

        // Reconcile the dropdown with the display mode that actually ended up in
        // effect. Normally that is this URL's mode and the call is a no-op, but a
        // local file dropped during the fetch runs clearPreviousImageState() in
        // between, which resets state.params.mode to the default: whichever of the
        // two loads then reaches the screen, the bar must show the mode it is
        // rendered with rather than the one this URL asked for.
        syncViewerModeSelect(state.params.mode);

        // If a newer load superseded this one during the fetch/decode, detach the
        // listener and do NOT arm the fallback: otherwise our once-listener would
        // fire on that unrelated image, or the 5s fallback would apply this URL's
        // shift/crop to it.
        if (isSuperseded()) {
            window.removeEventListener('stereo-image-loaded', applyResizeAndShift);
            logger.info('LoaderExternal', '[External] Load superseded during fetch; not arming resize/shift fallback.');
        } else if (!resizeAndShiftApplied) {
            // Start the fallback timer only after the load settles, so a slow load does
            // not trigger the fallback before the image is ready. If the event already
            // fired during the load (e.g. a cached texture), this is skipped.
            fallbackTimeout = setTimeout(() => {
                if (!resizeAndShiftApplied && !isSuperseded()) {
                    // Remove the one-time listener before running the fallback so it does not
                    // linger on the window waiting for an event that may never fire.
                    window.removeEventListener('stereo-image-loaded', applyResizeAndShift);
                    logger.warn('LoaderExternal','[External] stereo-image-loaded event not fired within 5s, applying resize/shift via fallback');
                    applyResizeAndShift();
                } else if (isSuperseded()) {
                    window.removeEventListener('stereo-image-loaded', applyResizeAndShift);
                }
            }, 5000);
        }
    } catch (err) {
        logger.error('LoaderExternal','Failed to load external image:', err);

        // Detach a still-pending stereo-image-loaded listener so it cannot misfire on
        // a later successful load and apply this failed load's stale shift values.
        if (fallbackTimeout) {
            clearTimeout(fallbackTimeout);
            fallbackTimeout = null;
        }
        if (applyResizeAndShift) {
            window.removeEventListener('stereo-image-loaded', applyResizeAndShift);
        }

        // Determine whether this is a CORS/network error. Shared classifier also
        // catches Safari's "Load failed" (via err.name === 'TypeError'), which a
        // plain substring check would miss, mislabeling CORS failures as generic.
        let errorMessage;
        const isCORSError = isCorsOrNetworkError(err);

        if (isCORSError) {
            errorMessage = window.t?.('messages.corsError') ||
                'Unable to load the image due to CORS policy.\n\n' +
                'Images from external sites can only be loaded if the site allows CORS (Cross-Origin Resource Sharing)';
        } else {
            errorMessage = window.t?.('messages.loadFailed') || 'Failed to load image';
        }

        // File decoding/worker errors were already surfaced by
        // loadFileWithFormat(). This layer still restores external-viewer state,
        // but should not stack another toast over the original error.
        if (!err?.__loadFileWithFormatHandled) {
            // Strip query string from URL before displaying to avoid leaking sensitive params (API keys, tokens).
            const displayUrl = sanitizeDisplayUrl(imageUrl);
            showToast(`${errorMessage}\n\nURL: ${displayUrl}\n\nError: ${err.message}`, 'error', 8000);
            hideLoadingProgress();
        }

        // On error, remove URL parameters and return to normal mode
        // location.reload() keeps URL params, causing infinite loop
        state.externalImageMode = false;
        state.viewerMode = false;
        // Clear the format captured before the (failed) load so it cannot be read by a
        // later share/export path. The next successful load resets it via
        // clearPreviousImageState() anyway, but resetting here keeps the failed-load
        // cleanup consistent with the other state fields restored in this block.
        state.currentImageFormat = null;
        // Clear the URL-params flag so a later local/manual load is not treated as a
        // URL-originated session (which would force-trim odd images without a dialog
        // and hide the viewer Exit button). It is set true before this load starts.
        state.loadedFromUrlParams = false;

        // Roll back the URL-specified display mode. It was applied to state.params
        // and to the viewer dropdown before the fetch, but no image was ever shown,
        // so leaving it set strands the app back in normal mode with a mode nothing
        // on screen uses and a viewer dropdown pointing at it (which would then seed
        // state.viewerDisplayMode for the next viewer session).
        if (mode !== null && typeof mode === 'number') {
            if (isSuperseded()) {
                // A newer load owns state.params.mode; only the dropdown needs to
                // stop advertising this failed load's mode.
                syncViewerModeSelect(state.params.mode);
            } else {
                state.params.mode = preUrlDisplayMode.params;
                state.viewerDisplayMode = preUrlDisplayMode.viewer;
                // Restore the dropdown's own previous value rather than deriving it
                // from the mode: the menu's #displayMode and the viewer bar's
                // #viewerDisplayMode are independent controls, so the two can legally
                // disagree outside viewer mode.
                const viewerModeSelect = document.getElementById('viewerDisplayMode');
                if (viewerModeSelect && preUrlDisplayMode.select !== null) {
                    viewerModeSelect.value = preUrlDisplayMode.select;
                }
            }
        }

        // Remove only the known external-image params from the URL to prevent
        // re-triggering on reload. Any other query params are intentionally preserved.
        const url = new URL(window.location.href);
        url.searchParams.delete('src');
        url.searchParams.delete('mode');
        url.searchParams.delete('format');
        url.searchParams.delete('x');
        url.searchParams.delete('y');
        // Also strip the alignment/crop params (r, z, crop) that this same load
        // accepts — otherwise they linger and get re-applied to a later image.
        url.searchParams.delete('r');
        url.searchParams.delete('z');
        url.searchParams.delete('crop');
        // Preserve url.hash so a fragment deep link is not silently dropped.
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);

        // Restore UI when returning from external image mode
        restoreExternalModeUI();
    }
}

/**
 * Expose external image mode functions on window.StereoView (and as direct globals)
 * @param {Function} handleFileCallback - File handling callback
 * @param {Function} loadFileWithFormatCallback - Format-specific load callback
 * @param {Function} [getFileLoadTokenCallback] - Current file-load token getter
 */
export function setupExternalGlobals(handleFileCallback, loadFileWithFormatCallback, getFileLoadTokenCallback) {
    // Initialize namespace
    if (!window.StereoView) {
        window.StereoView = {};
    }

    // Create external namespace
    window.StereoView.external = {
        startImageMode: (imageUrl, mode = null, format = null, shiftXPx = null, shiftYPx = null, rotationDeg = null, zoomPct = null, cropParams = null) => {
            return startExternalImageMode(imageUrl, mode, format, shiftXPx, shiftYPx, rotationDeg, zoomPct, cropParams, handleFileCallback, loadFileWithFormatCallback, getFileLoadTokenCallback);
        }
    };
}
