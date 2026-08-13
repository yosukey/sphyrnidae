/**
 * ui.js
 */
import { showToast } from './ui-toast.js';
import { state, DEBUG, CONSTANTS, getModeLayout, isCropSelectionAllowed, getViewerDisplayScale, APP_NAME, REPOSITORY_URL, APP_VERSION, BUILD_DATE, COMMIT_SHA } from '../globals.js';
import * as logger from '../utils/logger.js';
import {
    updateUniforms,
    updateTextOverlay,
    updateMeshScaleForMode,
    updateCroppedResolution,
    updateMeshTransform,
    fitImageToWindow,
    resetRenderErrorState
} from '../rendering/renderer.js';
import { handleFile, loadDualImageFiles, loadFileWithFormat, startViewerMode, clearPreviousImageState, syncActiveExifState } from '../loaders/loader.js';
import { applyAutoLevels, clearHistogramCache, warmUpHistogramShader } from '../core/histogram.js';
import { ensureEven } from '../utils/pixel-utils.js';
import { isIdentityAlign } from '../rendering/alignment-geometry.js';

// Import split UI modules
import {
    saveImage,
    clearGifWorkerBlobUrl,
    updateQualityControlVisibility,
    updateExportFormatOptions,
    copyClipboardListFormat,
    copyClipboardViewerFormat
} from './ui-export.js';
import {
    updateHistogramPanelDebounced,
    showHistogramPanel,
    updateHistogramPanel,
    updateHistogramPanelIfVisible,
    updateColorAdjustUI
} from './ui-histogram.js';
import {
    setupExifModal,
    updateExifModalIfVisible,
    cleanupExifModal
} from './ui-exif.js';
import {
    setupCropSelection,
    resetCropSelection,
    resetCropSelectionInternalState,
    updateCropButtonState,
    applyManualCrop,
    setCropCallbacks,
    cleanupCropSelectionListeners
} from './ui-crop.js';
import { setupMenuSystem, cleanupMenuSystem } from './ui-menu.js';
import { setupFullscreenSystem, cleanupFullscreenSystem } from './ui-fullscreen.js';
import {
    setupViewerModeDialog,
    setupViewerControlBar,
    setupViewerFileListModal,
    setViewerCallbacks,
    cleanupViewerUI
} from './ui-viewer.js';
import { cleanupOfflineDetection } from '../core/offlineDetection.js';
import { setupPointer3dControls, cleanupPointer3dControls } from './ui-pointer3d.js';

// Input handler module
import {
    setInputCallbacks,
    setupDragAndDrop,
    setupMouseHandlers,
    setupTouchHandlers,
    setupDoubleClick,
    setupClickNavigation,
    setupWheelHandler,
    setupFullscreenSlideshowHandler,
    setupKeyboardHandler
} from './ui-input.js';

// Mode-related modules
import {
    setGetElementFunction,
    updateParallaxControlsState,
    update3dtvCheckboxVisibility,
    updateImageAdjustControlsState,
    updateBorderDecorationVisibility
} from './ui-mode.js';

// Parameter management module
import {
    setParameterCallbacks,
    updateParamValue as updateParamValueInternal,
    resetAllCrop,
    resetTextParameters
} from './ui-parameters.js';

// Zoom display module
import {
    updateZoomDisplay,
    updateViewerZoomDisplay
} from './ui-zoom.js';

// Import newly split UI modules
import { setupTextOverlayControls, cleanupTextOverlayControls } from './ui-text-overlay.js';
import { setupAlignmentControls, setAlignmentCallbacks, cleanupAlignmentControls } from './ui-alignment.js';
import { setupColorAdjustmentControls, cleanupColorAdjustmentControls } from './ui-color-adjustments.js';
import { cleanupUpdateNotification } from './ui-update-notification.js';
import {
    setupFileLoadingControls,
    setupDualImageDialog,
    setupFormatSelectDialog,
    setupOpenUrlDialog,
    setFileLoadingCallbacks
} from './ui-file-loading.js';

// Re-export ui-crop.js functions for main.js
export { setupCropSelection };

// Re-export ui-zoom.js functions
export { updateZoomDisplay };

// Cache DOM references (performance optimization)
// Store { time, el } objects to track per-element TTL and validate DOM connection
const cachedElements = new Map();

// DOM element cache TTL.
// Cache is explicitly cleared on menu open/close events.
const CACHE_VALIDITY_MS = 60000;  // 60 seconds TTL for DOM element cache

// Flag to prevent duplicate event listener registration
let eventListenersInitialized = false;
let inputHandlersInitialized = false;

// Initial UI lock state (unlock after first image load)
let isInitialUiLocked = true;

const INITIAL_UI_LOCK_SELECTOR = '#ui-container button, #ui-container input, #ui-container select, #ui-container textarea, #ui-container .menu-card';

function isInitialUiLockExempt(el) {
    if (!el) return false;
    return Boolean(
        el.closest('#open-menu')
        || el.closest('#language-menu')
        || el.closest('#help-menu')
        || el.closest('#about-menu')
        || el.id === 'langSelectBtn'
        || el.closest('[data-submenu="open-menu"]')
        || el.closest('[data-submenu="help-menu"]')
        || el.closest('[data-submenu="about-menu"]')
    );
}

function applyInitialUiLock() {
    if (!isInitialUiLocked) return;

    document.querySelectorAll(INITIAL_UI_LOCK_SELECTOR).forEach(el => {
        if (isInitialUiLockExempt(el)) {
            return;
        }

        if ('disabled' in el) {
            el.dataset.initialUiLockPrevDisabled = el.disabled ? '1' : '0';
            el.disabled = true;
        }

        el.classList.add('initial-ui-locked');
        el.dataset.initialUiLocked = 'true';
    });
}

function releaseInitialUiLock() {
    if (!isInitialUiLocked) return;
    isInitialUiLocked = false;

    document.querySelectorAll('[data-initial-ui-locked="true"]').forEach(el => {
        if ('disabled' in el && el.dataset.initialUiLockPrevDisabled === '0') {
            el.disabled = false;
        }

        delete el.dataset.initialUiLockPrevDisabled;
        delete el.dataset.initialUiLocked;
        el.classList.remove('initial-ui-locked');
    });
}

// AbortController for event listener management (prevent memory leaks)
let windowEventAbortController = null;

/**
 * Get DOM element (with cache and TTL)
 * Optimize getElementById calls for frequently accessed elements
 * Cache entries are invalidated after CACHE_VALIDITY_MS to prevent stale references
 * Also validates that cached elements are still connected to the DOM
 * @param {string} id - Element ID
 * @returns {HTMLElement|null} DOM element or null
 */
function getElement(id) {
    const now = Date.now();
    const cached = cachedElements.get(id);

    // Return cached element if valid, not expired, and still connected to DOM
    if (cached && (now - cached.time < CACHE_VALIDITY_MS) && cached.el.isConnected) {
        return cached.el;
    }

    // Cache miss or invalid: fetch fresh element
    const el = document.getElementById(id);
    if (el) {
        cachedElements.set(id, { time: now, el });
    } else {
        // Remove stale cache entry if element no longer exists
        cachedElements.delete(id);
    }
    return el;
}

/**
 * Called on menu open/close or when DOM structure may change
 * @export
 */
export function clearElementCache() {
    cachedElements.clear();
    if (window.debugUICache) {
        logger.debug('UI_LOG', 'UI', 'Element cache cleared');
    }
}

/**
 * Clean up UI module resources (prevent memory leaks)
 *
 * This is the single entry point for cleaning up all UI-related resources.
 * It orchestrates the cleanup of all UI submodules in dependency order.
 *
 * All cleanup functions are idempotent (safe to call multiple times).
 * Each function has guards to prevent double cleanup and null pointer issues.
 *
 * Cleanup order:
 * 1. Window event listeners (this module)
 * 2. Fullscreen system (DOM API listeners)
 * 3. Viewer UI (viewer mode specific)
 * 4. EXIF modal (modal specific)
 * 5. Crop selection (canvas interaction)
 * 6. Offline detection (network listeners)
 * 7. DOM cache (internal state)
 * 8. Initialization flags (reset for re-init)
 *
 * @export
 * @idempotent Safe to call multiple times
 */
export function cleanupUI() {
    // Remove window event listeners
    if (windowEventAbortController) {
        windowEventAbortController.abort();
        windowEventAbortController = null;
    }

    // Clean up child UI modules (prevent listener/timer leaks)
    // Order: high-level → low-level dependencies
    cleanupFullscreenSystem();          // Fullscreen API listeners
    cleanupViewerUI();                   // Viewer mode UI
    cleanupExifModal();                  // EXIF modal UI
    cleanupCropSelectionListeners();     // Crop selection interactions
    cleanupOfflineDetection();           // Network status detection
    cleanupMenuSystem();                 // Menu system listeners
    cleanupColorAdjustmentControls();    // Color adjustment UI
    cleanupAlignmentControls();          // Alignment controls
    cleanupTextOverlayControls();        // Text overlay UI
    cleanupPointer3dControls();          // 3D Pointer controls
    cleanupUpdateNotification();         // Update notification system

    // Clear DOM reference cache
    clearElementCache();

    // Reset initialization flag (allow re-init)
    eventListenersInitialized = false;
    inputHandlersInitialized = false;
}

function updateAboutInfo() {
    const appNameEl = getElement('aboutAppName');
    if (appNameEl) {
        // Show version info (display full version string even with dev)
        const versionText = ` v${APP_VERSION}`;
        appNameEl.textContent = `${APP_NAME}${versionText}`;
    }

    const repoLink = getElement('repoLink');
    if (repoLink) {
        repoLink.href = REPOSITORY_URL;
        repoLink.textContent = REPOSITORY_URL;
    }

    const noticesLink = getElement('noticesLink');
    if (noticesLink) {
        noticesLink.href = `${REPOSITORY_URL}/blob/main/THIRD-PARTY-NOTICES.md`;
    }

    // Show build info (release builds only)
    const buildInfoEl = getElement('buildInfo');
    if (buildInfoEl) {
        if (BUILD_DATE && COMMIT_SHA) {
            const shortSha = COMMIT_SHA.substring(0, 7);

            // Ensure consistent UTC timezone display
            let displayDate = BUILD_DATE;
            try {
                // If BUILD_DATE doesn't already include timezone info, add UTC
                if (!BUILD_DATE.includes('UTC') && !BUILD_DATE.includes('GMT')) {
                    // Parse the date string and reformat with explicit UTC
                    const parsedDate = new Date(BUILD_DATE);
                    if (!isNaN(parsedDate.getTime())) {
                        // Format as YYYY-MM-DD HH:MM:SS UTC
                        const year = parsedDate.getUTCFullYear();
                        const month = String(parsedDate.getUTCMonth() + 1).padStart(2, '0');
                        const day = String(parsedDate.getUTCDate()).padStart(2, '0');
                        const hours = String(parsedDate.getUTCHours()).padStart(2, '0');
                        const minutes = String(parsedDate.getUTCMinutes()).padStart(2, '0');
                        const seconds = String(parsedDate.getUTCSeconds()).padStart(2, '0');
                        displayDate = `${year}-${month}-${day} ${hours}:${minutes}:${seconds} UTC`;
                    }
                }
            } catch (err) {
                // If date parsing fails, use the original string
                logger.warn('UI', 'Failed to parse BUILD_DATE for timezone formatting:', err);
            }

            buildInfoEl.textContent = `Build: ${displayDate} (${shortSha})`;
            buildInfoEl.style.display = 'block';
        } else {
            buildInfoEl.style.display = 'none';
        }
    }
}

export function setupEventListeners() {
    // Prevent duplicate event listener registration
    if (eventListenersInitialized) {
        logger.warn('UI', 'setupEventListeners() called multiple times. Skipping duplicate registration.');
        return;
    }
    eventListenersInitialized = true;

    // Initialize AbortController (abort existing one if present)
    if (windowEventAbortController) {
        windowEventAbortController.abort();
    }
    windowEventAbortController = new AbortController();
    const signal = windowEventAbortController.signal;

    // Set getElement function on split modules
    setGetElementFunction(getElement);

    // Set callbacks on parameter module
    setParameterCallbacks({
        updateZoomDisplay,
        updateViewerZoomDisplay,
        updatePxDisplay,
        updateCropButtonState,
        updateHistogramPanelDebounced,
        updateHistogramPanelIfVisible,
        updateExportResolution
    });

    updateAboutInfo();

    // Set callbacks on newly split modules
    setAlignmentCallbacks({
        updateParamValue: updateParamValueInternal,
        updatePxDisplay,
        updateHistogramPanelIfVisible,
        updateCropButtonState,
        updateViewerZoomDisplay,
        updateZoomDisplay
    });

    setFileLoadingCallbacks({
        updateOutputFileNameField
    });

    // Set up event listeners on newly split modules
    setupFileLoadingControls();
    setupDualImageDialog();
    setupFormatSelectDialog();
    setupOpenUrlDialog();
    setupAlignmentControls();
    setupColorAdjustmentControls();
    setupTextOverlayControls();

    // Set callbacks on ui-crop.js
    setCropCallbacks({
        updateZoomDisplay,
        updateExportResolution,
        updateHistogramPanelIfVisible
    });

    // ===== Listen for crop reset requests from loader.js =====
    // Avoid circular dependencies by using event-based decoupling
    window.addEventListener('crop-selection-reset-requested', () => {
        // Clean up DOM elements and reset UI state
        // state.cropSelectionMode and state.cropSelection are already reset in loader.js
        // Only perform UI-related cleanup here

        // Reset event listeners and internal state (prevent memory leaks)
        resetCropSelectionInternalState();

        // Hide DOM elements
        const overlay = getElement('crop-selection-overlay');
        const infoDiv = getElement('cropSelectionInfo');
        const actionsDiv = getElement('cropSelectionActions');
        const toggleBtn = getElement('toggleCropSelectionBtn');

        if (overlay) overlay.style.display = 'none';
        if (infoDiv) infoDiv.style.display = 'none';
        if (actionsDiv) actionsDiv.style.display = 'none';
        if (toggleBtn) {
            toggleBtn.classList.remove('active');
            // Use the same label key as the ui-crop.js reset paths for consistency.
            toggleBtn.textContent = window.t?.('controls.rectangularMode') ?? 'Rectangular selection';
        }
    }, { signal });

    // ===== Listen for error notifications from renderer.js =====
    // Separation of concerns: renderer avoids DOM; UI handles events
    window.addEventListener('render-error-threshold-reached', () => {
        const statusEl = document.getElementById('renderStatus');
        if (statusEl) {
            // Check if window.t is available (avoid errors before i18n init)
            const errorMsg = window.t?.('messages.renderingError') ?? 'Rendering error occurred';
            const retryBtnText = window.t?.('buttons.retry') ?? 'Retry';

            // XSS protection: use createElement instead of innerHTML
            statusEl.textContent = '';
            statusEl.appendChild(document.createTextNode(errorMsg));
            statusEl.appendChild(document.createElement('br'));

            // Show error details in debug mode
            if (DEBUG.RENDER_ERROR_LOG) {
                const detailsDiv = document.createElement('div');
                detailsDiv.style.fontSize = '0.85em';
                detailsDiv.style.marginTop = '8px';
                detailsDiv.style.color = '#ccc';
                const maxTextureSize = Math.max(state.renderer?.capabilities?.maxTextureSize || 0, 2048);
                const gpuInfo = `GPU max texture: ${maxTextureSize}px`;
                detailsDiv.appendChild(document.createTextNode(gpuInfo));
                statusEl.appendChild(detailsDiv);
            }

            const retryBtn = document.createElement('button');
            retryBtn.id = 'retryRenderBtn';
            retryBtn.textContent = retryBtnText;
            retryBtn.style.marginTop = '10px';
            retryBtn.style.padding = '5px 10px';
            retryBtn.style.cursor = 'pointer';
            statusEl.appendChild(retryBtn);

            statusEl.style.color = '#ff0000';
            statusEl.style.display = 'block';

            // Retry button event listener.
            // No long-lived signal here: a fresh retry button is created on every
            // render-error-threshold event and the previous one is discarded via
            // statusEl.textContent = '' above. Binding with { once: true } lets the
            // node + listener be GC'd after use instead of accumulating detached
            // buttons on the app-lifetime AbortController until cleanup.
            retryBtn.addEventListener('click', () => {
                resetRenderErrorState();
                statusEl.style.display = 'none';
            }, { once: true });
        } else {
            // Alert if status panel is missing
            const alertMessage = window.t?.('messages.continuousRenderingError') ?? 'Rendering error occurred';
            showToast(alertMessage, 'error');
        }
    }, { signal });

    // ===== Initialize menu system =====
    setupMenuSystem();

    // ===== Fullscreen detection and viewer bar control =====
    setupFullscreenSystem();

    // --- Toggle collapsible sections (event delegation for memory efficiency) ---
    // Handle via parent element instead of per-header listeners
    document.addEventListener('click', (event) => {
        const header = event.target.closest('.section-header');
        if (header) {
            const targetId = header.getAttribute('data-target');
            const content = document.getElementById(targetId);

            if (content) {
                // Toggle
                header.classList.toggle('active');
                content.classList.toggle('expanded');
            }
        }
    }, { signal });

    const displayModeEl = document.getElementById('displayMode');
    if (displayModeEl) {
    // Track whether the pending value change came from a pointer (mouse/touch)
    // rather than the keyboard. A native <select> keeps focus after a mouse pick,
    // and the keyboard handler deliberately lets a focused <select> consume the
    // arrow keys (native option cycling, for keyboard a11y). Together that means
    // after picking a display format with the mouse, the arrow keys kept changing
    // the format instead of adjusting parallax (X) / vertical shift (Y). Blur the
    // select after a pointer-driven change so focus returns to the document and the
    // arrow keys go back to parallax; keyboard-driven changes keep focus so native
    // dropdown navigation still works.
    let displayModePointerInteraction = false;
    displayModeEl.addEventListener('pointerdown', () => {
        displayModePointerInteraction = true;
    }, { signal });
    displayModeEl.addEventListener('keydown', () => {
        displayModePointerInteraction = false;
    }, { signal });
    displayModeEl.addEventListener('change', (e) => {
        const newMode = parseInt(e.target.value, 10);
        state.params.mode = newMode;

        // Auto-disable rectangle selection if new mode is not allowed
        if (state.cropSelectionMode && !isCropSelectionAllowed(newMode)) {
            resetCropSelection();
        }

        // Control 3DTV checkbox visibility
        update3dtvCheckboxVisibility(newMode);

        // Gray out parallax/intensity in mono mode (mode 4, 5)
        updateParallaxControlsState(newMode);

        // Control image adjustment UI and swapLR in mono mode
        updateImageAdjustControlsState(newMode);

        // Control border decoration visibility (modes 8/9/12/13 only)
        updateBorderDecorationVisibility(newMode);

        updateUniforms();
        updateMeshScaleForMode();
        updateOutputFileNameField();
        updateZoomDisplay();
        updateExportResolution();
        updateExportFormatOptions();

        // If the format was picked with the pointer, drop focus so the next arrow
        // key adjusts parallax/vertical shift instead of being swallowed by this
        // native <select> to cycle the display format again.
        if (displayModePointerInteraction) {
            displayModePointerInteraction = false;
            e.target.blur();
        }
    }, { signal });
    }

    // Initialize mode name suffix display
    updateModeSuffixDisplay();

    // Initialize 3DTV checkbox visibility
    update3dtvCheckboxVisibility(state.params.mode);

    // Initialize border decoration visibility
    updateBorderDecorationVisibility(state.params.mode);

    // Initialize parallax/intensity control state
    updateParallaxControlsState(state.params.mode);

    // Initialize image adjustment UI and swapLR state
    updateImageAdjustControlsState(state.params.mode);

  // === Add handling for save format changes ===
  const saveFormatEl = document.getElementById('saveFormat');
  if (saveFormatEl) {
    saveFormatEl.addEventListener('change', (e) => {
      updateQualityControlVisibility();
    }, { signal });
  }

  // === Add handling for Quality slider ===
  const qualitySlider = document.getElementById('saveQuality');
  if (qualitySlider) {
    qualitySlider.addEventListener('input', (e) => {
      const quality = parseFloat(e.target.value);
      state.exportOptions.quality = quality;
      const qualityLabel = document.getElementById('valQuality');
      if (qualityLabel) {
        qualityLabel.textContent = Math.round(quality * 100);
      }
    }, { signal });
  }

  // Control quality setting visibility on initial display
  updateQualityControlVisibility();

  // Control export format options on initial display
  updateExportFormatOptions();

  // === Add handling for resize options ===
  const enableResizeCheckbox = document.getElementById('enableResize');
  if (enableResizeCheckbox) {
    enableResizeCheckbox.addEventListener('change', (e) => {
      state.exportOptions.enableResize = e.target.checked;
      const resizeOptions = document.getElementById('resizeOptions');
      if (resizeOptions) {
        resizeOptions.classList.toggle('hidden', !e.target.checked);
      }
      updateExportResolution();
    }, { signal });
  }

  const resizeScaleSlider = document.getElementById('resizeScale');
  if (resizeScaleSlider) {
    resizeScaleSlider.addEventListener('input', (e) => {
      const scale = parseFloat(e.target.value);
      state.exportOptions.resizeScale = scale;
      const label = document.getElementById('valResizeScale');
      if (label) {
        label.textContent = Math.round(scale * 100);
      }
      updateExportResolution();
    }, { signal });
  }

  // Resize mode toggle (scale / pixel)
  const resizeModeScaleBtn = document.getElementById('resizeModeScale');
  const resizeModePixelBtn = document.getElementById('resizeModePixel');
  const resizeScaleGroup = document.getElementById('resizeScaleGroup');
  const resizePixelGroup = document.getElementById('resizePixelGroup');

  function switchResizeMode(mode) {
    state.exportOptions.resizeMode = mode;
    if (resizeModeScaleBtn) resizeModeScaleBtn.classList.toggle('active', mode === 'scale');
    if (resizeModePixelBtn) resizeModePixelBtn.classList.toggle('active', mode === 'pixel');
    if (resizeScaleGroup) resizeScaleGroup.classList.toggle('hidden', mode !== 'scale');
    if (resizePixelGroup) resizePixelGroup.classList.toggle('hidden', mode !== 'pixel');
    if (mode === 'pixel') {
      updateResizeTargetWidthMax();
    }
    updateExportResolution();
  }

  if (resizeModeScaleBtn) {
    resizeModeScaleBtn.addEventListener('click', () => switchResizeMode('scale'), { signal });
  }
  if (resizeModePixelBtn) {
    resizeModePixelBtn.addEventListener('click', () => switchResizeMode('pixel'), { signal });
  }

  // Pixel width input
  const resizeTargetWidthInput = document.getElementById('resizeTargetWidth');
  if (resizeTargetWidthInput) {
    resizeTargetWidthInput.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      const maxWidth = getExportMaxWidth();
      if (!isNaN(val) && val >= 2) {
        // Clamp to max width (original resolution)
        const clamped = Math.min(val, maxWidth);
        state.exportOptions.resizeTargetWidth = ensureEven(clamped);
        if (val > maxWidth) {
          e.target.value = maxWidth;
        }
      } else {
        state.exportOptions.resizeTargetWidth = null;
      }
      updateExportResolution();
    }, { signal });

    // On blur, enforce even value and clamp
    resizeTargetWidthInput.addEventListener('blur', (e) => {
      const maxWidth = getExportMaxWidth();
      let val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val >= 2) {
        val = ensureEven(Math.min(Math.max(val, 2), maxWidth));
        e.target.value = val;
        state.exportOptions.resizeTargetWidth = val;
        updateExportResolution();
      }
    }, { signal });
  }

  const resizeAlgorithmSelect = document.getElementById('resizeAlgorithm');
  if (resizeAlgorithmSelect) {
    resizeAlgorithmSelect.addEventListener('change', (e) => {
      state.exportOptions.resizeAlgorithm = e.target.value;
    }, { signal });
  }

  const enableBorderDecorationCheckbox = document.getElementById('enableBorderDecoration');
  if (enableBorderDecorationCheckbox) {
    enableBorderDecorationCheckbox.addEventListener('change', (e) => {
      state.exportOptions.enableBorderDecoration = e.target.checked;
      // Border decoration is incompatible with MPO (the MPO export path stores
      // per-eye JPEGs and skips the decorated canvas), so re-evaluate the format
      // list to remove/restore the MPO option and switch away from it if selected.
      updateExportFormatOptions();
    }, { signal });
  }

  const preserveExifCheckbox = document.getElementById('preserveExif');
  if (preserveExifCheckbox) {
    // Initialize the checkbox from the default option value so the two
    // sources of truth do not drift apart on first load.
    preserveExifCheckbox.checked = state.exportOptions.preserveExif;
    preserveExifCheckbox.addEventListener('change', (e) => {
      state.exportOptions.preserveExif = e.target.checked;
    }, { signal });
  }

    const saveBtnEl = document.getElementById('saveBtn');
    if (saveBtnEl) {
        saveBtnEl.addEventListener('click', () => {
            // saveImage() handles errors inside its main export body, but a throw in
            // its setup prologue or restore epilogue (e.g. state.renderer null after a
            // WebGL context loss) escapes as an unhandled rejection with no user
            // feedback. Catch here so the failure surfaces as a toast.
            saveImage(updateZoomDisplay).catch((err) => {
                logger.error('Export', 'Save failed:', err);
                showToast(window.t?.('messages.saveFailed', { error: err?.message }) ?? `Save failed: ${err?.message}`, 'error');
            });
        }, { signal });
    }

    // Clipboard export buttons (list format)
    const exportClipboardListBtn = document.getElementById('exportClipboardListBtn');
    if (exportClipboardListBtn) {
        exportClipboardListBtn.addEventListener('click', async () => {
            try {
                await copyClipboardListFormat();
                const msg = window.t?.('messages.copiedToClipboard') || 'Copied to clipboard';
                logger.info('Export', msg);
                // Notify the user that the copy succeeded
                showToast(msg, 'success');
                // Show visual feedback
                exportClipboardListBtn.style.opacity = '0.6';
                setTimeout(() => {
                    exportClipboardListBtn.style.opacity = '1';
                }, 300);
            } catch (err) {
                logger.error('Export', 'Failed to copy list format:', err);
                showToast(window.t?.('messages.clipboardError') || 'Failed to copy to clipboard', 'error');
            }
        }, { signal });
    }

    // Clipboard export buttons (viewer format)
    const exportClipboardViewerBtn = document.getElementById('exportClipboardViewerBtn');
    if (exportClipboardViewerBtn) {
        exportClipboardViewerBtn.addEventListener('click', async () => {
            try {
                await copyClipboardViewerFormat();
                const msg = window.t?.('messages.copiedToClipboard') || 'Copied to clipboard';
                logger.info('Export', msg);
                // Notify the user that the copy succeeded
                showToast(msg, 'success');
                // Show visual feedback
                exportClipboardViewerBtn.style.opacity = '0.6';
                setTimeout(() => {
                    exportClipboardViewerBtn.style.opacity = '1';
                }, 300);
            } catch (err) {
                logger.error('Export', 'Failed to copy viewer format:', err);
                showToast(window.t?.('messages.clipboardError') || 'Failed to copy to clipboard', 'error');
            }
        }, { signal });
    }

    const manualCropBtnEl = document.getElementById('manualCropBtn');
    if (manualCropBtnEl) {
        manualCropBtnEl.addEventListener('click', () => {
            applyManualCrop();
        }, { signal });
    }

    // Crop reset button (shared)
    const resetAllCropBtn = document.getElementById('resetAllCropBtn');
    if (resetAllCropBtn) {
        resetAllCropBtn.addEventListener('click', () => {
            resetAllCrop();
        }, { signal });
    }

    window.addEventListener('param-changed-externally', (e) => {
        const { name, value } = e.detail;
        const el = document.getElementById(name);
        if (el) {
            // Clamp only the slider's *displayed* value to its own range (a range
            // input cannot represent a value past its max regardless).
            const min = parseFloat(el.min);
            const max = parseFloat(el.max);
            let displayValue = value;
            if (Number.isFinite(min) && displayValue < min) displayValue = min;
            if (Number.isFinite(max) && displayValue > max) displayValue = max;
            el.value = displayValue;
        }
        // Keep state.params at the true value the dispatcher already applied to the
        // mesh. fitImageToWindow() sets state.params.scale = fitScale, which for a
        // heavy crop (URL crop up to 0.98) can exceed the #scale slider max; clamping
        // it here would desync the stored scale from the rendered mesh and make the
        // first zoom interaction jump the image or become a no-op.
        state.params[name] = value;
        // Viewer mode display updates happen via viewer-zoom-changed event
    }, { signal });

    window.addEventListener('viewer-zoom-changed', (e) => {
        const { scale } = e.detail;
        updateViewerZoomDisplay(scale);
    }, { signal });

    // Grid display
    const gridEnabled = document.getElementById('gridEnabled');
    if (gridEnabled) {
        gridEnabled.addEventListener('change', (e) => {
            state.params.gridEnabled = e.target.checked;
            updateUniforms();
        }, { signal });
    }

    // Grid density
    const gridDensity = document.getElementById('gridDensity');
    if (gridDensity) {
        gridDensity.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            state.params.gridDensity = value;
            const valGridDensity = document.getElementById('valGridDensity');
            if (valGridDensity) {
                valGridDensity.textContent = value;
            }
            updateUniforms();
        }, { signal });
    }

    // Grid color selection
    const colorOptions = document.querySelectorAll('.color-option');
    colorOptions.forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Toggle active class
            colorOptions.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Update color
            state.params.gridColor = btn.dataset.color;
            updateUniforms();
        }, { signal });
    });

    window.addEventListener('stereo-image-loaded', () => {
        releaseInitialUiLock();

        // Clear DOM reference cache on new image load (prevent memory leaks)
        clearElementCache();

        // In viewer mode, auto-fit and update zoom display
        if (state.viewerMode) {
            // Auto-fit after image load completes
            setTimeout(() => {
                fitImageToWindow();
                // Read the scale the same way the renderer's own post-fit event does:
                // a 3DTV load (every SBS/TaB display mode in viewer mode) is zoomed by
                // viewerScale alone, so the SBS formula reported the mesh fit scale
                // here and overwrote the correct percentage fitImageToWindow() had
                // just published.
                updateViewerZoomDisplay(getViewerDisplayScale());
            }, 100);
        } else {
            updateZoomDisplay();
        }

        updateCropButtonState();
        updateExportResolution();
        // Reset color adjustment UI
        updateColorAdjustUI();
        // Clear histogram cache and update panel if visible
        clearHistogramCache();
        // Precompile the single-eye histogram shader off the main thread so the
        // first histogram request does not stall while the shader compiles.
        warmUpHistogramShader();
        // Recompute histogram for new image (only if visible)
        updateHistogramPanelIfVisible();
    }, { signal });

    // Histogram refresh event
    window.addEventListener('refresh-histogram', () => {
        updateHistogramPanelIfVisible();
    }, { signal });

    // OpenCV loaded event
    window.addEventListener('opencv-ready', () => {
        updateOpenCVStatus(true);
    }, { signal });

    // OpenCV load/init failure (script or WASM error, or timeout). Without this the
    // status panel showed "Loading..." forever and auto-align stayed disabled with
    // no explanation. Both event names are dispatched by the OpenCV loaders.
    const handleOpenCVError = () => updateOpenCVStatus('failed');
    window.addEventListener('opencv-error', handleOpenCVError, { signal });
    window.addEventListener('opencvLoadError', handleOpenCVError, { signal });

    // Re-render the OpenCV status on language change. The Ready text carries a
    // runtime "(SIMD)"-style variant suffix and is marked data-i18n-skip, so
    // updateContent() deliberately leaves it untouched — without this it would stay
    // in the load-time language after a switch. Re-rendering Loading/Failed here too
    // is harmless (they also re-translate via updateContent()).
    window.addEventListener('app-language-changed', () => {
        if (currentOpenCVStatus !== null) {
            updateOpenCVStatus(currentOpenCVStatus);
        }
    }, { signal });

    // Update status immediately if OpenCV already loaded
    if (window.cv && window.cv.Mat) {
        updateOpenCVStatus(true);
    }

    // Show two filenames when loading left/right images
    window.addEventListener('dual-images-loaded', (e) => {
        const { leftName, rightName } = e.detail;
        const nameEl = document.getElementById('infoFileName');
        const secondaryRow = document.getElementById('infoFileNameSecondaryRow');
        const secondaryEl = document.getElementById('infoFileNameSecondary');

        if (nameEl) {
            nameEl.textContent = leftName;
            nameEl.removeAttribute('data-i18n');  // Remove translation attribute for dynamic text
        }
        if (secondaryRow && secondaryEl) {
            secondaryEl.textContent = rightName;
            secondaryRow.style.display = 'flex';
        }

        updateOutputFileNameField();
    }, { signal });

    window.addEventListener('resize', () => {
        updateZoomDisplay();
    }, { signal });

    // The renderer emits 'canvas-resized' after it has resized (and, in viewer mode,
    // refit) the canvas. Recompute the viewer-bar / 3DTV zoom readout here, since it
    // is derived from the canvas size and would otherwise stay stale until the next
    // zoom interaction. updateViewerZoomDisplay() self-gates to viewer/3DTV modes,
    // and running after the renderer's refit means state.params.scale is current.
    window.addEventListener('canvas-resized', () => {
        updateViewerZoomDisplay(getViewerDisplayScale());
    }, { signal });


  // === Sync initial state ===
  // Sync swapLR checkbox initial state with state.params.swapLR
  const swapLRCheckbox = document.getElementById('swapLR');
  if (swapLRCheckbox) {
    swapLRCheckbox.checked = state.params.swapLR;
  }

    // ===== Viewer mode dialog =====
    setupViewerModeDialog();

    // ===== EXIF display =====
    setupExifModal();

    // Apply startup lock after all initial UI state sync to avoid accidental re-enabling
    applyInitialUiLock();
}

/**
 * Set up mouse, keyboard, and drag-and-drop handling (after renderer init)
 */
export function setupInputHandlers() {
    // Prevent duplicate event listener registration
    if (inputHandlersInitialized) {
        logger.warn('UI', 'setupInputHandlers() called multiple times. Skipping duplicate registration.');
        return;
    }

    // Skip if renderer is not initialized yet
    if (!state.renderer || !state.renderer.domElement) {
        logger.warn('UI', 'setupInputHandlers: renderer not initialized yet');
        return;
    }

    inputHandlersInitialized = true;

    // Get AbortController signal initialized in setupEventListeners()
    const signal = windowEventAbortController?.signal;

    const canvas = state.renderer.domElement;

    // Set callbacks on input module
    setInputCallbacks({
        updateParamValue: updateParamValueInternal,
        updateViewerZoomDisplay,
        updateOutputFileNameField
    });

    // ===== Set up each input handler =====

    // Drag and drop
    setupDragAndDrop(signal);

    // Mouse interactions
    const mouseState = setupMouseHandlers(canvas, signal);

    // Touch/pinch interactions
    setupTouchHandlers(canvas, mouseState, signal);

    // Double click
    setupDoubleClick(canvas, signal);

    // Click navigation (viewer mode)
    setupClickNavigation(canvas, signal);

    // Wheel interactions (zoom)
    setupWheelHandler(canvas, signal);

    // Stop slideshow on fullscreen exit
    setupFullscreenSlideshowHandler(signal);

    // Keyboard interactions
    setupKeyboardHandler(signal);

    // 3D Pointer controls
    setupPointer3dControls(signal);

    // ===== Viewer mode control bar =====
    setViewerCallbacks({ updateZoomDisplay });
    setupViewerControlBar();

    // ===== File list modal =====
    setupViewerFileListModal();
}

// updateParamValue is imported/re-exported from ui-parameters.js
export { updateParamValueInternal as updateParamValue };

// Last OpenCV status passed to updateOpenCVStatus (true | 'failed' | false),
// so the app-language-changed handler can re-render the (data-i18n-skip) label.
let currentOpenCVStatus = null;

/**
 * Update display of OpenCV load status
 */
function updateOpenCVStatus(status) {
    const statusEl = document.getElementById('opencvStatus');
    if (!statusEl) return;

    currentOpenCVStatus = status;

    // Accept both a boolean (true=ready/false=loading) and a 'failed' string, so
    // an OpenCV load error/timeout can clear the perpetual "Loading...".
    if (status === true) {
        const variant = window.opencvBuildVariant || '';
        const readyText = window.t?.('status.opencvReady') ?? 'Ready';
        statusEl.textContent = variant ? `${readyText} (${variant})` : readyText;
        statusEl.setAttribute('data-i18n', 'status.opencvReady');
        statusEl.setAttribute('data-i18n-skip', '');
        statusEl.style.color = '#66bb6a'; // Green
    } else if (status === 'failed') {
        statusEl.textContent = window.t?.('status.opencvFailed') ?? 'Unavailable';
        statusEl.setAttribute('data-i18n', 'status.opencvFailed');
        statusEl.removeAttribute('data-i18n-skip');
        statusEl.style.color = '#ef5350'; // Red
    } else {
        statusEl.textContent = window.t?.('status.opencvLoading') ?? 'OpenCV Loading...';
        statusEl.setAttribute('data-i18n', 'status.opencvLoading');
        statusEl.removeAttribute('data-i18n-skip');
        statusEl.style.color = '#ffa726'; // Orange
    }
}

// updateZoomDisplay/updateViewerZoomDisplay are imported from ui-zoom.js

/**
 * Get the base (full-resolution) export width for the current image/mode/crop.
 * Used as the upper limit for pixel-width input.
 */
function getExportBaseSize() {
    if (!state.material || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image) {
        return { width: 0, height: 0 };
    }
    const texture = state.material.uniforms.map.value;
    const imgW = texture.image.width;
    const imgH = texture.image.height;
    const eyeWidth = Math.floor(imgW / 2);
    const eyeHeight = imgH;
    const cropRatioX = 1.0 - state.params.cropX;
    const cropRatioY = 1.0 - state.params.cropY;
    // Round (not floor) before the even-snap so this matches the actual output size
    // computed in saveImage() (ui-export.js): cropX/cropY encode an even pixel count
    // as 1 - evenPx/eyeWidth, and the float round-trip lands just below that integer,
    // so Math.floor + ensureEven drops the size 2px short. Using floor here made the
    // export resolution readout, the pixel-width `max` label/clamp, and the resize
    // scale disagree with the saved file by 2px.
    const croppedEyeWidth = ensureEven(Math.round(eyeWidth * cropRatioX));
    const croppedEyeHeight = ensureEven(Math.round(eyeHeight * cropRatioY));
    const mode = state.params.mode;
    const layout = getModeLayout(mode);
    const width = Math.max(2, ensureEven(Math.round(croppedEyeWidth * layout.wMul)));
    const height = Math.max(2, ensureEven(Math.round(croppedEyeHeight * layout.hMul)));
    return { width, height };
}

/**
 * Get the maximum allowed export width (= base width at full resolution).
 */
function getExportMaxWidth() {
    return getExportBaseSize().width;
}

/**
 * Update the max-width label and input constraints for pixel mode.
 */
function updateResizeTargetWidthMax() {
    const maxWidth = getExportMaxWidth();
    const maxLabel = document.getElementById('resizeTargetWidthMax');
    if (maxLabel) {
        maxLabel.textContent = maxWidth > 0 ? `max ${maxWidth}` : '';
    }
    const input = document.getElementById('resizeTargetWidth');
    if (input) {
        input.max = maxWidth > 0 ? maxWidth : '';
    }
}

/**
 * Compute the resize scale from pixel-width target.
 * Returns the scale factor, or 1.0 if pixel mode is not configured.
 */
export function getEffectiveResizeScale() {
    if (state.exportOptions.resizeMode === 'pixel') {
        const targetWidth = state.exportOptions.resizeTargetWidth;
        const base = getExportBaseSize();
        if (targetWidth && base.width > 0) {
            return Math.min(targetWidth / base.width, 1.0);
        }
        return 1.0; // no valid target → no resize
    }
    return state.exportOptions.resizeScale;
}

/**
 * Update export resolution display
 * Adjust to even pixels to match actual output size
 */
export function updateExportResolution() {
    const el = document.getElementById('exportResolution');
    if (!el) return;

    if (!state.material || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image) {
        el.textContent = "- x -";
        return;
    }

    const base = getExportBaseSize();
    let outputWidth = base.width;
    let outputHeight = base.height;

    // When resize option is enabled (ensure even pixels)
    if (state.exportOptions.enableResize) {
        const scale = getEffectiveResizeScale();
        outputWidth = Math.max(2, ensureEven(Math.round(outputWidth * scale)));
        outputHeight = Math.max(2, ensureEven(Math.round(outputHeight * scale)));
    }

    el.textContent = `${outputWidth} x ${outputHeight}`;

    // Also update pixel-mode max when displayed
    if (state.exportOptions.resizeMode === 'pixel') {
        updateResizeTargetWidthMax();
    }
}

/**
 * Update px display (no UV display)
 */
export function updatePxDisplay() {
    if (!state.material || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image) {
        const pxXEl = document.getElementById('valShiftXPx');
        const pxYEl = document.getElementById('valShiftYPx');
        if (pxXEl) pxXEl.textContent = "0";
        if (pxYEl) pxYEl.textContent = "0";
        // Also update viewer bar display
        const viewerShiftX = document.getElementById('viewerShiftX');
        const viewerShiftY = document.getElementById('viewerShiftY');
        if (viewerShiftX) viewerShiftX.textContent = "0";
        if (viewerShiftY) viewerShiftY.textContent = "0";
        return;
    }

    const img = state.material.uniforms.map.value.image;
    const eyeWidth = img.width / 2;
    const eyeHeight = img.height;

    const shiftX = state.params.shiftX;
    const shiftY = state.params.shiftY;

    const pxX = shiftX * eyeWidth * 2.0;
    const pxY = shiftY * eyeHeight;

    // When geometric refinement is adopted the vertical correction lives in the
    // alignTransform matrix (and shiftY is 0), so a bare "0.0" would misleadingly
    // read as "no vertical correction". Tag the vertical readout in that case.
    const hasGeometry = !isIdentityAlign(state.params.alignTransform);
    const matrixTag = hasGeometry ? ` ${window.t?.('controls.geomMatrixTag') ?? '(matrix)'}` : '';
    const pxYText = pxY.toFixed(1) + matrixTag;

    const pxXEl = document.getElementById('valShiftXPx');
    const pxYEl = document.getElementById('valShiftYPx');

    if (pxXEl) pxXEl.textContent = pxX.toFixed(1);
    if (pxYEl) pxYEl.textContent = pxYText;

    // Update viewer bar shift display
    const viewerShiftX = document.getElementById('viewerShiftX');
    const viewerShiftY = document.getElementById('viewerShiftY');
    if (viewerShiftX) viewerShiftX.textContent = pxX.toFixed(1);
    if (viewerShiftY) viewerShiftY.textContent = pxYText;
}

export function updateOutputFileNameField() {
    // Set filename field to the original filename only
    const fileNameField = document.getElementById('outputFileName');
    if (fileNameField && state.originalFileNameBase) {
        fileNameField.value = state.originalFileNameBase;
    }
    // Update mode name suffix display
    updateModeSuffixDisplay();
}

/**
 * Update mode name suffix display
 */
export function updateModeSuffixDisplay() {
    const suffixDisplay = document.getElementById('modeSuffixDisplay');
    if (suffixDisplay) {
        const currentMode = state.params.mode;
        const suffix = CONSTANTS.modeSuffixes[currentMode] || "_edit";
        suffixDisplay.value = suffix;
    }
}


// resetAllCrop, resetTextParameters imported from ui-parameters.js
