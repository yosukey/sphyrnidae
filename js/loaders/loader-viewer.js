/**
 * loader-viewer.js
 * Viewer mode management module
 * View multiple images, slideshow features, etc.
 */

import { showToast } from '../ui/ui-toast.js';
import { state } from '../globals.js';
import { showVRButton } from '../rendering/vr.js';
import { onWindowResize } from '../rendering/renderer.js';
import { handleFile } from './loader.js';
import { fetchImageAsFile, sanitizeDisplayUrl } from './loader-utils.js';
import { showLoadingProgress, hideLoadingProgress } from './loader-ui-progress.js';
import { updateParamValue } from '../ui/ui-parameters.js';
import { updateViewerExitButtonVisibility } from '../ui/ui-viewer.js';
import { rotZoomToAlignTransform, splitVerticalShift } from '../rendering/alignment-geometry.js';
import * as logger from '../utils/logger.js';

/**
 * Start viewer mode
 * @param {FileList|File[]} files - List of files to load
 * @param {Function} loadViewerImageCallback - Image load callback (optional)
 */
export async function startViewerMode(files, loadViewerImageCallback = null) {
    if (!files || files.length === 0) return;

    // Enable viewer mode
    state.viewerMode = true;
    state.viewerFiles = files;
    state.viewerCurrentIndex = 0;

    // Reset viewer mode parameters
    state.viewerScale = 1.0;
    state.viewerPanX = 0;
    state.viewerPanY = 0;
    state.viewerFitScale = 1.0;

    // Seed the remembered display state from the viewer's mode dropdown so the
    // first and subsequent images share a consistent mode. These persist across
    // navigation and are re-applied after each load (clearPreviousImageState
    // resets state.params to defaults). See loadViewerImage().
    const viewerModeSelect = document.getElementById('viewerDisplayMode');
    const initialViewerMode = viewerModeSelect ? parseInt(viewerModeSelect.value, 10) : 0;
    state.viewerDisplayMode = Number.isNaN(initialViewerMode) ? 0 : initialViewerMode;
    state.viewerSwapLR = false;
    // Reset loop mode for the new session. A stale loop flag carried over from a prior
    // multi-file session would otherwise make single-file navigation (N/P) wrap and
    // reload the same image (index (0+1) % 1 = 0); also resync the loop button's
    // active appearance so it does not stay highlighted from the previous session.
    state.viewerLoopMode = false;
    const viewerLoopBtnEl = document.getElementById('viewerLoopBtn');
    if (viewerLoopBtnEl) viewerLoopBtnEl.classList.remove('active');

    // Switch UI (hide menu)
    const menuPanel = document.getElementById('ui-container');
    if (menuPanel) {
        menuPanel.style.display = 'none';
    }

    const viewerBar = document.getElementById('viewer-mode-bar');
    if (viewerBar) {
        viewerBar.style.display = 'flex';
        // Remove auto-hide class on fullscreen to ensure it is visible
        viewerBar.classList.remove('viewer-bar-hidden');
    }

    // Update exit button visibility (hide if started from external URL)
    updateViewerExitButtonVisibility();

    // Show VR button (if VR is supported)
    showVRButton();

    const canvasContainer = document.getElementById('canvas-container');
    if (canvasContainer) {
        canvasContainer.classList.add('viewer-mode');
    }

    // Hide status panel (including iconified state)
    const statusPanel = document.getElementById('status-panel');
    if (statusPanel) {
        statusPanel.style.display = 'none';
    }
    // Remove the status panel body class as well
    document.body.classList.remove('status-open');
    // Add viewer mode class (CSS hides showStatusBtn)
    document.body.classList.add('viewer-mode');

    // Hide icon button that reopens the status panel
    const showStatusBtn = document.getElementById('showStatusBtn');
    if (showStatusBtn) {
        showStatusBtn.style.display = 'none';
    }

    // Hide the histogram panel
    const histogramPanel = document.getElementById('histogram-panel');
    if (histogramPanel) {
        histogramPanel.style.display = 'none';
    }

    // Load the first image
    // If no callback is provided, get it from the namespace
    const callback = loadViewerImageCallback || window.StereoView?.viewer?.loadImage;
    if (callback && typeof callback === 'function') {
        await callback(0);
    } else {
        logger.error('LoaderViewer', '[ViewerMode] Image load callback not available');
        // Fallback: try to load directly if we have files
        if (state.viewerFiles && state.viewerFiles.length > 0) {
            try {
                const { handleFile } = await import('./loader.js');
                await handleFile(state.viewerFiles[0]);
            } catch (err) {
                logger.error('LoaderViewer','[ViewerMode] Failed to load first image:', err);
            }
        }
    }

    // Auto-fit in viewer mode
    // Delay so it runs after image loading completes
    setTimeout(() => {
        onWindowResize();
    }, 100);
}

// Track the current invocation's per-URL-options listener and fallback timer so a
// new loadViewerImage() can detach the previous one. Otherwise, navigating before a
// load completes (or a failed load) leaves an orphaned { once: true } listener that
// fires on the NEXT image and applies the previous item's mode/shift to the wrong
// image. Mirrors loader-external.js's listener-detach approach.
let activeViewerOptionsListener = null;
let activeViewerFallbackTimeout = null;

function clearActiveViewerOptions() {
    if (activeViewerFallbackTimeout) {
        clearTimeout(activeViewerFallbackTimeout);
        activeViewerFallbackTimeout = null;
    }
    if (activeViewerOptionsListener) {
        window.removeEventListener('stereo-image-loaded', activeViewerOptionsListener);
        activeViewerOptionsListener = null;
    }
}

/**
 * Load an image at a specific index for viewer mode
 * @param {number} index - Index of the image to load
 * @param {Function} handleFileCallback - File handling callback (optional)
 */
export async function loadViewerImage(index, handleFileCallback = null) {
    if (!state.viewerFiles || !Number.isFinite(index) || index < 0 || index >= state.viewerFiles.length) {
        return;
    }

    // Detach any listener/timer left over from a previous (possibly still in-flight
    // or failed) load so it cannot misfire on this image with stale options.
    clearActiveViewerOptions();

    state.viewerCurrentIndex = index;
    const item = state.viewerFiles[index];

    // Reset viewer mode parameters
    state.viewerScale = 1.0;
    state.viewerPanX = 0;
    state.viewerPanY = 0;
    state.viewerFitScale = 1.0;

    // Update the filename
    const filenameEl = document.getElementById('viewerFilename');
    if (filenameEl) {
        filenameEl.textContent = item.name;
    }

    // Resolve the file: local File or URL item requiring fetch
    let file;
    if (item._isUrlItem) {
        try {
            showLoadingProgress(10);
            file = await fetchImageAsFile(item._urlSource);
            item._status = 'loaded';
            // A newer navigation may have superseded this load while the fetch was
            // in flight. Re-showing the overlay here would leave it stuck if the
            // newer load already finished (the staleness guard below returns without
            // hiding). The newer load owns the overlay now.
            if (state.viewerCurrentIndex === index) {
                showLoadingProgress(30);
            }
        } catch (err) {
            logger.error('LoaderViewer', '[ViewerMode] Failed to load URL:', sanitizeDisplayUrl(item._urlSource), err);
            item._status = 'error';
            // Only touch shared UI if this load is still current. A superseded
            // load's late failure must not hide the newer load's overlay or show
            // a stale error toast.
            if (state.viewerCurrentIndex === index) {
                hideLoadingProgress();

                // Show toast notification
                const { showViewerToast } = await import('../ui/ui-viewer.js');
                const errorMsg = window.t?.('viewer.urlLoadError', { name: item.name }) || `Failed to load: ${item.name}`;
                showViewerToast(errorMsg, { isError: true, duration: 3000 });
            }

            // Update navigation button state
            window.updateViewerNavigationButtons?.();

            // Stop here on error. In slideshow mode the slideshow timer advances to
            // the next image; in manual mode there is nothing further to do. Both
            // cases simply return.
            return;
        }
    } else {
        file = item;
    }

    // Staleness guard: a newer navigation may have superseded this load while the
    // URL fetch above was in flight (it sets state.viewerCurrentIndex synchronously).
    // If so, bail before registering the options listener or calling handleFile, so
    // this older/slower load cannot win handleFile's generation race and overwrite the
    // newer image. Do not touch shared UI here — the progress bar belongs to the
    // newer load now.
    if (state.viewerCurrentIndex !== index) {
        return;
    }

    // Run the post-load options pass for per-URL options AND, in viewer mode, on
    // every navigation so the viewer's remembered display mode / swapLR are
    // re-applied (handleFile -> clearPreviousImageState resets state.params to
    // defaults, otherwise each navigation would silently revert to anaglyph and
    // desync the viewer dropdown).
    const hasPerUrlOptions = item._mode !== undefined || item._shiftX !== undefined ||
        item._shiftY !== undefined || item._rotation !== undefined ||
        item._zoom !== undefined || item._crop !== undefined || state.viewerMode;
    let optionsApplied = false;
    let fallbackTimeout = null;

    const applyOptions = async () => {
        if (optionsApplied) return; // Prevent double execution
        optionsApplied = true;

        // Clear fallback timeout if event fired
        if (fallbackTimeout) {
            clearTimeout(fallbackTimeout);
            fallbackTimeout = null;
        }
        // Clear module-level handles ONLY if this invocation still owns them.
        // A superseded invocation must not clear the newer load's fallback timer,
        // otherwise the newer item's options could be left unapplied.
        if (activeViewerOptionsListener === applyOptions) {
            activeViewerOptionsListener = null;
            if (activeViewerFallbackTimeout) {
                clearTimeout(activeViewerFallbackTimeout);
                activeViewerFallbackTimeout = null;
            }
        }

        try {
            // Apply the crop window FIRST (normalized/resolution-independent), before
            // the mode handler below runs its fit. Both fitImageToWindow and
            // updateMeshTransform scale the mesh by (1 - cropX/cropY), so the crop must
            // be in state.params before the fit — otherwise the cropped image renders
            // at the wrong scale.
            if (item._crop !== undefined) {
                updateParamValue('cropX', item._crop.cropX);
                updateParamValue('cropY', item._crop.cropY);
                updateParamValue('offsetX', item._crop.offsetX);
                updateParamValue('offsetY', item._crop.offsetY);
                logger.info('LoaderViewer', `[ViewerMode] Applied crop: ${item._crop.cropX},${item._crop.cropY},${item._crop.offsetX},${item._crop.offsetY}`);
            }

            // Determine the effective display mode: a per-image URL `mode=` option
            // wins; otherwise re-apply the viewer's remembered mode so navigation
            // does not revert to the default. Use the viewer's shared mode handler
            // so it runs the same side effects (3DTV handling, mesh rescale, fit,
            // dropdown sync) as the viewer's mode dropdown; updateParamValue('mode')
            // would only set the uniform. Dynamic import avoids a static cycle
            // (ui-viewer -> loader -> loader-viewer).
            let effectiveMode;
            if (item._mode !== undefined) {
                effectiveMode = item._mode;
            } else if (state.viewerMode) {
                effectiveMode = state.viewerDisplayMode;
            }
            if (effectiveMode !== undefined) {
                try {
                    const { applyViewerDisplayMode } = await import('../ui/ui-viewer.js');
                    applyViewerDisplayMode(effectiveMode);
                } catch (modeErr) {
                    logger.warn('LoaderViewer', '[ViewerMode] Falling back to updateParamValue for mode:', modeErr);
                    updateParamValue('mode', effectiveMode);
                }
            }

            // Re-apply the viewer's remembered swap-L/R state (reset by
            // clearPreviousImageState). Absolute set, so no shift-sign inversion.
            if (state.viewerMode && state.viewerSwapLR) {
                try {
                    const { applyViewerSwapState } = await import('../ui/ui-viewer.js');
                    applyViewerSwapState(true);
                } catch (swapErr) {
                    logger.warn('LoaderViewer', '[ViewerMode] Falling back to direct swapLR set:', swapErr);
                    updateParamValue('swapLR', true);
                }
            }

            // Build the vertical-affine alignTransform from rotation/zoom FIRST, so the
            // vertical-shift step below can fold any clamp overflow into its a[7]
            // constant. Resolution-independent (unlike shiftX/shiftY). Kept as a local
            // base matrix and written to state once, together with the vertical shift,
            // so a large `y` and a rotation/zoom on the same entry do not fight over
            // alignTransform.
            const hasRotZoom = item._rotation !== undefined || item._zoom !== undefined;
            const baseAlign = hasRotZoom
                ? rotZoomToAlignTransform(item._rotation ?? 0, item._zoom ?? 0)
                : null;
            if (hasRotZoom) {
                logger.info('LoaderViewer', `[ViewerMode] Applied rotation: ${item._rotation ?? 0}deg, zoom: ${item._zoom ?? 0}%`);
            }

            // Apply shift values (requires loaded image dimensions)
            const img = state.material?.uniforms?.map?.value?.image;
            if (img) {
                if (item._shiftX !== undefined) {
                    const normalizedX = item._shiftX / img.width;
                    updateParamValue('shiftX', normalizedX);
                    logger.info('LoaderViewer',`[ViewerMode] Applied shiftX: ${item._shiftX}px -> ${normalizedX.toFixed(6)}`);
                }
                if (item._shiftY !== undefined) {
                    // The exporter folds the matrix constant f (= -a[7]) into the vertical
                    // `y`, which can exceed the shiftY ±0.1 slider clamp. splitVerticalShift
                    // keeps the in-range part in shiftY and folds the overflow into a[7] so
                    // vertical parallax > 10% (adopted affine) round-trips losslessly.
                    const normalizedY = item._shiftY / img.height;
                    const { shiftY, alignTransform } = splitVerticalShift(
                        normalizedY, baseAlign ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]
                    );
                    updateParamValue('shiftY', shiftY);
                    updateParamValue('alignTransform', alignTransform);
                    logger.info('LoaderViewer',`[ViewerMode] Applied shiftY: ${item._shiftY}px -> ${normalizedY.toFixed(6)} (shiftY=${shiftY.toFixed(6)}, a7=${alignTransform[7].toFixed(6)})`);
                } else if (baseAlign) {
                    // Rotation/zoom without a vertical shift: apply the base matrix as-is.
                    updateParamValue('alignTransform', baseAlign);
                }
            } else {
                if (item._shiftX !== undefined || item._shiftY !== undefined) {
                    logger.warn('LoaderViewer', '[ViewerMode] Image not available for shift calculation');
                }
                // Rotation/zoom does not need image dimensions, so still apply it.
                if (baseAlign) {
                    updateParamValue('alignTransform', baseAlign);
                }
            }
        } catch (err) {
            logger.warn('LoaderViewer','[ViewerMode] Error applying per-URL options:', err);
        }
    };

    // Register the load-completion listener BEFORE starting the load. The
    // stereo-image-loaded event is dispatched synchronously inside
    // updateSceneWithImage(), so attaching the listener only after awaiting the
    // load risks missing the event (e.g. a cached texture, or a future change that
    // awaits loadTexture()), which would leave options unapplied until the fallback.
    if (hasPerUrlOptions) {
        window.addEventListener('stereo-image-loaded', applyOptions, { once: true });
        // Record on the module level so the NEXT loadViewerImage() can detach this
        // listener if it is still pending (navigation before load completes / failure).
        activeViewerOptionsListener = applyOptions;
    }

    // Load the file: route both the explicit-format and auto-detect paths through
    // handleFile so the load inherits full generation management (abort the
    // previous load, clear the pixel-validation dialog queue, issue a new
    // fileLoadToken, clearPreviousImageState) and proper stale-result rejection.
    // Calling loadFileWithFormat() directly would bypass all of that and disable
    // the completion-time token check (myToken would be null).
    // Priming the mode here lets the initial shader build with the correct mode
    // (clearPreviousImageState resets it to the default), avoiding a flash before
    // the stereo-image-loaded handler applies the full viewer mode side effects.
    const loadOptions = {};
    // URL-list items launched via ?list= must keep state.loadedFromUrlParams alive
    // through handleFile()'s clearPreviousImageState(). handleFile only preserves that
    // flag when suppressFormatDialog is set, and loadFileWithFormat reads it as
    // forceTrimWithoutDialog to trim odd-dimension images silently. Without this, the
    // first list item wipes the flag and an odd-size image pops the blocking
    // pixel-validation dialog, stalling (and eventually failing) an unattended
    // slideshow. Suppressing the format-selection dialog is also correct for a
    // slideshow item, and forceFormat below still takes precedence when set.
    if (item._isUrlItem) loadOptions.suppressFormatDialog = true;
    if (item._format) loadOptions.forceFormat = item._format;
    // Prime with the per-image mode if given, otherwise the viewer's remembered
    // mode, so the initial shader build matches and there is no anaglyph flash.
    if (item._mode !== undefined) {
        loadOptions.mode = item._mode;
    } else if (state.viewerMode) {
        loadOptions.mode = state.viewerDisplayMode;
    }
    const callback = handleFileCallback || handleFile;
    try {
        await callback(file, loadOptions);
    } catch (err) {
        // handleFile's forceFormat branch rethrows loadFileWithFormat() failures
        // (unlike the auto-detect branch, which swallows handled errors), and every
        // caller of loadViewerImage is fire-and-forget — without this catch a
        // corrupt list item becomes an unhandled promise rejection. The error UI
        // (toast, progress reset) has already been presented downstream; what still
        // needs doing here is the failure cleanup: detach the armed options
        // listener so it cannot apply this item's mode/crop/shift to the next
        // successfully loaded image, and refresh the nav buttons that the early
        // return below would otherwise skip.
        if (!err?.__loadFileWithFormatHandled && !err?.__loadTextureHandled) {
            logger.error('LoaderViewer', '[ViewerMode] Unexpected error loading viewer image:', err);
        }
        if (hasPerUrlOptions && activeViewerOptionsListener === applyOptions) {
            window.removeEventListener('stereo-image-loaded', applyOptions);
            activeViewerOptionsListener = null;
        }
        if (state.viewerCurrentIndex === index) {
            window.updateViewerNavigationButtons?.();
        }
        return;
    }

    // Staleness guard: if a newer navigation superseded this load during handleFile,
    // do not arm the fallback timer or refresh the nav buttons for this stale load —
    // both belong to the newer load, and an armed fallback could later apply this
    // item's mode/shift to whatever image is now shown. (The existing
    // activeViewerOptionsListener check below is a second line of defence for the
    // same-index reload case where the index comparison cannot distinguish loads.)
    if (state.viewerCurrentIndex !== index) {
        return;
    }

    // Start the fallback timer only after the load settles, so a slow load (which
    // can legitimately exceed the timeout) does not trigger the fallback before the
    // image is ready. If the event already fired during the load, this is skipped.
    // The ownership guard (activeViewerOptionsListener === applyOptions) prevents a
    // superseded invocation — whose await resolved late (e.g. a slow MPO load that
    // was already overtaken by a newer navigation) — from arming a stale fallback
    // that would later apply this item's mode/shift to whatever image is now shown.
    if (hasPerUrlOptions && !optionsApplied && activeViewerOptionsListener === applyOptions) {
        fallbackTimeout = setTimeout(() => {
            if (!optionsApplied) {
                // Remove the one-time listener before running the fallback so it does
                // not linger on the window waiting for an event that may never fire.
                window.removeEventListener('stereo-image-loaded', applyOptions);
                logger.warn('LoaderViewer','[ViewerMode] stereo-image-loaded event not fired within 5s, applying options via fallback');
                applyOptions();
            }
        }, 5000);
        // Mirror the timer on the module level so a later load can clear it.
        activeViewerFallbackTimeout = fallbackTimeout;
    }

    // Update navigation button state
    window.updateViewerNavigationButtons?.();
}

/**
 * Show the next image in viewer mode
 * @param {Function} loadViewerImageCallback - Image load callback (optional)
 */
export async function viewerNextImage(loadViewerImageCallback = null) {
    if (!state.viewerMode) return;
    if (!state.viewerFiles || state.viewerFiles.length === 0) return;

    // If not in loop mode and at the last image, stop slideshow and disable it
    if (!state.viewerLoopMode && state.viewerCurrentIndex >= state.viewerFiles.length - 1) {
        if (state.viewerSlideshowIntervalId) {
            clearTimeout(state.viewerSlideshowIntervalId);
            state.viewerSlideshowIntervalId = null;
        }
        state.viewerSlideshowSpeed = 0;

        const slideshowSelect = document.getElementById('viewerSlideshowSpeed');
        if (slideshowSelect && slideshowSelect.value !== '0') {
            slideshowSelect.value = '0';
        }
        return;
    }

    const nextIndex = (state.viewerCurrentIndex + 1) % state.viewerFiles.length;
    const callback = loadViewerImageCallback || window.loadViewerImage;
    if (callback) {
        await callback(nextIndex);
    }
}

/**
 * Show the image before the current one in viewer mode
 * @param {Function} loadViewerImageCallback - Image load callback (optional)
 */
export async function viewerPrevImage(loadViewerImageCallback = null) {
    if (!state.viewerMode) return;
    if (!state.viewerFiles || state.viewerFiles.length === 0) return;

    // If not in loop mode and at the first image, do nothing
    if (!state.viewerLoopMode && state.viewerCurrentIndex <= 0) {
        return;
    }

    const prevIndex = (state.viewerCurrentIndex - 1 + state.viewerFiles.length) % state.viewerFiles.length;
    const callback = loadViewerImageCallback || window.loadViewerImage;
    if (callback) {
        await callback(prevIndex);
    }
}

/**
 * Show a non-blocking confirmation dialog
 * @param {string} message - Confirmation message
 * @returns {Promise<boolean>} true if confirmed, false if cancelled
 * @private
 */
function showConfirmDialog(message) {
    return new Promise((resolve) => {
        // Remove any existing dialog
        const existingDialog = document.getElementById('viewerExitConfirmDialog');
        if (existingDialog) {
            existingDialog.remove();
        }

        // Create the dialog overlay
        const dialog = document.createElement('div');
        dialog.id = 'viewerExitConfirmDialog';
        dialog.className = 'dialog-overlay';
        dialog.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            display: flex;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;

        // Create the dialog box
        const dialogBox = document.createElement('div');
        dialogBox.className = 'dialog-box';
        dialogBox.style.cssText = `
            background: var(--panel-bg, #2a2a2a);
            border-radius: 8px;
            padding: 20px;
            max-width: 400px;
            color: var(--text-color, #e0e0e0);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;

        // Create message
        const messageEl = document.createElement('p');
        messageEl.style.cssText = 'margin: 0 0 20px 0; font-size: 14px; line-height: 1.5;';
        messageEl.textContent = message;

        // Create action buttons
        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'modern-btn primary';
        confirmBtn.style.cssText = 'padding: 8px 16px;';
        confirmBtn.textContent = window.t?.('common.ok') || 'OK';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modern-btn';
        cancelBtn.style.cssText = 'padding: 8px 16px;';
        cancelBtn.textContent = window.t?.('common.cancel') || 'Cancel';

        // ESC key to cancel
        const handleKeydown = (e) => {
            if (e.key === 'Escape') {
                // Stop the global viewer keydown handler (registered on window) from
                // also acting on this Escape. This handler is on document, which
                // bubbles before window, and cleanup() removes the dialog — so
                // without stopPropagation the global handler would then see no open
                // dialog and go on to exit fullscreen / stop the slideshow, making a
                // dialog "cancel" also perform an unrelated action on one keypress.
                e.preventDefault();
                e.stopPropagation();
                cleanup();
                resolve(false);
            }
        };

        const handleConfirm = () => {
            cleanup();
            resolve(true);
        };

        const handleCancel = () => {
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            document.removeEventListener('keydown', handleKeydown);
            confirmBtn.removeEventListener('click', handleConfirm);
            cancelBtn.removeEventListener('click', handleCancel);
            dialog.remove();
        };

        confirmBtn.addEventListener('click', handleConfirm);
        cancelBtn.addEventListener('click', handleCancel);

        document.addEventListener('keydown', handleKeydown);

        // Assemble dialog
        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        dialogBox.appendChild(messageEl);
        dialogBox.appendChild(actions);
        dialog.appendChild(dialogBox);
        document.body.appendChild(dialog);

        // Focus confirm button
        confirmBtn.focus();
    });
}

/**
 * Exit viewer mode and fully reset to the initial state
 */
export async function exitViewerMode() {
    if (!state.viewerMode) return;

    // If in external image mode, close the tab
    if (state.externalImageMode) {
        // Detect F11 fullscreen (when the Fullscreen API is not used)
        const heightRatio = window.innerHeight / screen.availHeight;
        const widthRatio = window.innerWidth / screen.availWidth;
        const isF11Fullscreen = (heightRatio > 0.95) && (widthRatio > 0.95);

        // Stop the slideshow first (must be done before any early return)
        if (state.viewerSlideshowIntervalId) {
            clearTimeout(state.viewerSlideshowIntervalId);
            state.viewerSlideshowIntervalId = null;
        }

        // If F11 fullscreen, notify the user
        if (isF11Fullscreen && !document.fullscreenElement) {
            const f11Message = window.t?.('viewer.f11FullscreenNotice') ?? 'Press F11 to exit fullscreen mode';
            showToast(f11Message, 'info');
            return;
        }

        // Exit fullscreen
        if (document.fullscreenElement) {
            document.exitFullscreen?.();
        }

        // Close the tab (window.close only works for script-opened windows)
        // If it cannot be closed, fall back to reload
        window.close();
        // If window.close does not work (e.g., opened via direct URL)
        // Reload the page after a short wait
        setTimeout(() => {
            location.reload();
        }, 100);
        return;
    }

    // Detect F11 fullscreen (when the Fullscreen API is not used)
    const heightRatio = window.innerHeight / screen.availHeight;
    const widthRatio = window.innerWidth / screen.availWidth;
    const isF11Fullscreen = (heightRatio > 0.95) && (widthRatio > 0.95);

    // If F11 fullscreen, notify the user and cancel the reload
    // Stop the slideshow first since user is trying to exit
    if (isF11Fullscreen && !document.fullscreenElement) {
        if (state.viewerSlideshowIntervalId) {
            clearTimeout(state.viewerSlideshowIntervalId);
            state.viewerSlideshowIntervalId = null;
        }
        const f11Message = window.t?.('viewer.f11FullscreenNotice') ?? 'Press F11 to exit fullscreen mode';
        showToast(f11Message, 'info');
        return;
    }

    // Exit confirmation dialog (non-blocking)
    const confirmMessage = window.t?.('viewer.confirmExit') || 'Exit viewer mode?';
    const confirmed = await showConfirmDialog(confirmMessage);
    if (!confirmed) {
        return; // If canceled, do nothing (slideshow continues)
    }

    // Stop the slideshow (timer is created with setTimeout, not setInterval)
    if (state.viewerSlideshowIntervalId) {
        clearTimeout(state.viewerSlideshowIntervalId);
        state.viewerSlideshowIntervalId = null;
    }

    // Exit fullscreen (run before reload)
    if (document.fullscreenElement) {
        document.exitFullscreen?.();
    }

    // Reload the page to fully reset state
    location.reload();
}

/**
 * Set the viewer mode slideshow speed
 * @param {number} speed - Slideshow speed (seconds)
 * @param {Function} viewerNextImageCallback - Callback to show the next image (optional)
 */
export function setViewerSlideshowSpeed(speed, viewerNextImageCallback = null) {
    if (!state.viewerMode) return;

    // Stop the existing slideshow
    if (state.viewerSlideshowIntervalId) {
        clearTimeout(state.viewerSlideshowIntervalId);
        state.viewerSlideshowIntervalId = null;
    }

    state.viewerSlideshowSpeed = speed;

    // Start if the slideshow is enabled
    if (speed > 0) {
        // Switch to fullscreen (use document.documentElement in viewer mode)
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen?.().catch(err => {
                logger.info('LoaderViewer','Fullscreen request failed:', err);
            });
        }

        const callback = viewerNextImageCallback || window.viewerNextImage;
        // Use self-rescheduling setTimeout to prevent overlapping async image loads
        const scheduleNext = () => {
            state.viewerSlideshowIntervalId = setTimeout(async () => {
                try {
                    if (callback && typeof callback === 'function') {
                        await callback();
                    }
                    // Schedule next only after current load completes
                    if (state.viewerSlideshowSpeed > 0) {
                        scheduleNext();
                    }
                } catch (err) {
                    logger.error('LoaderViewer','[ViewerMode] Slideshow error, stopping:', err);
                    state.viewerSlideshowIntervalId = null;
                    // Fully stop the slideshow, matching the end-of-list stop path in
                    // viewerNextImage(): also clear the remembered speed and sync the
                    // dropdown to "0". Otherwise the speed select keeps showing e.g.
                    // "5s" with no timer running, and loadViewerImage()'s URL-error
                    // branch (which returns early when viewerSlideshowSpeed > 0,
                    // expecting the timer to advance) would stall.
                    state.viewerSlideshowSpeed = 0;

                    const slideshowSelect = document.getElementById('viewerSlideshowSpeed');
                    if (slideshowSelect && slideshowSelect.value !== '0') {
                        slideshowSelect.value = '0';
                    }
                    // Notify user
                    const errorMsg = window.t?.('viewer.slideshowError') || 'Slideshow stopped due to error';
                    showToast(errorMsg, 'info');
                }
            }, speed * 1000);
        };
        scheduleNext();
    }
}

/**
 * Expose viewer functions on window.StereoView (and as direct globals)
 * @param {Function} loadViewerImageCallback - Image load callback
 * @param {Function} handleFileCallback - File handling callback
 */
export function setupViewerGlobals(loadViewerImageCallback, handleFileCallback) {
    // Initialize and export the namespace
    if (!window.StereoView) {
        window.StereoView = {};
    }

    // Create viewer namespace
    window.StereoView.viewer = {
        loadImage: (index) => loadViewerImage(index, handleFileCallback),
        nextImage: () => viewerNextImage(loadViewerImageCallback),
        prevImage: () => viewerPrevImage(loadViewerImageCallback),
        exitMode: exitViewerMode,
        setSlideshowSpeed: (speed) => setViewerSlideshowSpeed(speed, () => viewerNextImage(loadViewerImageCallback))
    };

    // Expose as direct globals in addition to the namespace, via getters
    Object.defineProperty(window, 'loadViewerImage', {
        get: () => window.StereoView.viewer.loadImage,
        configurable: true
    });

    Object.defineProperty(window, 'viewerNextImage', {
        get: () => window.StereoView.viewer.nextImage,
        configurable: true
    });

    Object.defineProperty(window, 'viewerPrevImage', {
        get: () => window.StereoView.viewer.prevImage,
        configurable: true
    });

    Object.defineProperty(window, 'exitViewerMode', {
        get: () => window.StereoView.viewer.exitMode,
        configurable: true
    });

    Object.defineProperty(window, 'setViewerSlideshowSpeed', {
        get: () => window.StereoView.viewer.setSlideshowSpeed,
        configurable: true
    });
}
