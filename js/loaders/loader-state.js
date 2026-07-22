/**
 * loader-state.js
 * State management module
 * Handles clearing and resetting state when loading images
 */

import { state } from '../globals.js';
import { onWindowResize, removeTextureFromCache } from '../rendering/renderer.js';
import { QUALITY_PARAM_KEYS } from '../ui/ui-color-adjust-config.js';
import * as logger from '../utils/logger.js';

/**
 * Fully clear the current image state before loading a new file
 */
export function clearPreviousImageState() {
    // Release Three.js resources
    if (state.mesh) {
        state.scene?.remove(state.mesh);
        state.mesh.geometry?.dispose();
        // mesh.material is normally the same object as state.material (they are set
        // together in createStereoMesh). Dispose it here only when it is a *different*
        // material, so the shared one is disposed exactly once in the block below
        // rather than twice.
        if (state.mesh.material && state.mesh.material !== state.material) {
            state.mesh.material.dispose();
        }
        state.mesh = null;
    }

    if (state.material) {
        // Release the main image texture, keeping the renderer's texture cache in
        // sync so a disposed texture can never be served from the cache afterwards
        // (mirrors the cleanup createStereoMesh performs for the replaced texture).
        const mapTexture = state.material.uniforms?.map?.value;
        if (mapTexture) {
            removeTextureFromCache(mapTexture);
            mapTexture.dispose?.();
        }
        state.material.dispose();
        state.material = null;
    }

    if (state.textTextureL) {
        state.textTextureL.dispose();
        state.textTextureL = null;
    }

    if (state.textTextureR) {
        state.textTextureR.dispose();
        state.textTextureR = null;
    }

    // Reset crop mode (event-based decoupling)
    // Use custom events instead of dynamic import to avoid circular dependency
    if (state.cropSelectionMode) {
        // Perform minimal state reset here (accessible from loader.js)
        state.cropSelectionMode = false;
        state.cropSelection = null;

        // Send reset notification to ui.js (DOM cleanup handled in ui.js)
        window.dispatchEvent(new CustomEvent('crop-selection-reset-requested'));
    }

    // Reset state variables
    state.originalImageWidth = 0;
    state.originalImageHeight = 0;

    // Reset EXIF data (left/right + display)
    state.exifData = null;
    state.exifThumbnail = null;
    state.exifDataLeft = null;
    state.exifDataRight = null;
    state.exifThumbnailLeft = null;
    state.exifThumbnailRight = null;

    // Reset raw APP1/EXIF segments too. These are consumed during export
    // (preserveExif) and are otherwise only refreshed asynchronously by the
    // EXIF readers; clearing them here keeps them in sync with exifData* so a
    // previous image's segment cannot leak into the export of a new image.
    state.exifRawSegment = null;
    state.exifRawSegmentLeft = null;
    state.exifRawSegmentRight = null;

    // Reset URL dialog loading flag
    state.loadedFromUrlDialog = false;
    state.loadedFromUrlParams = false;
    state.externalImageMode = false;
    state.externalImageUrl = null;
    state.currentImageFormat = null;

    // Restore params from defaultParams (deep copy to avoid shared references)
    for (const [key, value] of Object.entries(state.defaultParams)) {
        if (Array.isArray(value)) {
            state.params[key] = [...value];
        } else if (value !== null && typeof value === 'object') {
            state.params[key] = structuredClone(value);
        } else {
            state.params[key] = value;
        }
    }

    // === Reset UI elements ===
    resetUIElements();

    // Reset file input value (allow re-selecting the same file)
    const fileInput = document.getElementById('fileInput');
    if (fileInput) fileInput.value = '';

    const fileInputManual = document.getElementById('fileInputManual');
    if (fileInputManual) fileInputManual.value = '';

    // Clear the canvas
    if (state.renderer && state.scene && state.camera) {
        state.renderer.setClearColor(0x1a1a1a, 1);
        state.renderer.render(state.scene, state.camera);
    }

    // Update window size to adjust layout
    onWindowResize();
}

/**
 * Restore URL dialog flags after clearPreviousImageState()
 * This preserves the external URL loading state through state resets
 * @param {boolean} shouldRestore - Whether to restore the flags
 * @param {string|null} externalImageUrl - External image URL to restore
 * @param {string|null} format - Image format to set (optional)
 */
export function restoreUrlDialogFlags(shouldRestore, externalImageUrl, format = null) {
    if (shouldRestore) {
        state.loadedFromUrlDialog = true;
        state.externalImageUrl = externalImageUrl;
        if (format !== null) {
            state.currentImageFormat = format;
        }
    }
}

/**
 * Reset UI elements to default values
 */
function resetUIElements() {
    // Display format select box
    const displayModeSelect = document.getElementById('displayMode');
    if (displayModeSelect) {
        displayModeSelect.value = '0';
    }

    // Checkboxes
    const swapLRCheckbox = document.getElementById('swapLR');
    if (swapLRCheckbox) {
        swapLRCheckbox.checked = false;
    }

    const gridEnabledCheckbox = document.getElementById('gridEnabled');
    if (gridEnabledCheckbox) {
        gridEnabledCheckbox.checked = false;
    }

    // Grid density
    const gridDensityInput = document.getElementById('gridDensity');
    const valGridDensity = document.getElementById('valGridDensity');
    if (gridDensityInput) {
        gridDensityInput.value = state.defaultParams.gridDensity;
    }
    if (valGridDensity) {
        valGridDensity.textContent = state.defaultParams.gridDensity;
    }

    // Grid color (reset active class)
    const colorOptions = document.querySelectorAll('.color-option');
    colorOptions.forEach(btn => {
        if (btn.dataset.color === state.defaultParams.gridColor) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });

    // Text overlay
    resetTextOverlayUI();

    // Shift slider
    const shiftXSlider = document.getElementById('shiftX');
    const shiftYSlider = document.getElementById('shiftY');
    if (shiftXSlider) {
        shiftXSlider.value = state.defaultParams.shiftX;
    }
    if (shiftYSlider) {
        shiftYSlider.value = state.defaultParams.shiftY;
    }

    // Image adjustment parameters (left/right)
    resetColorAdjustmentUI();
}

/**
 * Reset the text overlay UI
 */
function resetTextOverlayUI() {
    const textStringInput = document.getElementById('textString');
    if (textStringInput) {
        textStringInput.value = '';
    }

    const textSizeInput = document.getElementById('textSize');
    if (textSizeInput) {
        textSizeInput.value = state.defaultParams.textSize;
    }

    const textStrokeInput = document.getElementById('textStroke');
    if (textStrokeInput) {
        textStrokeInput.value = state.defaultParams.textStroke;
    }

    const textColorInput = document.getElementById('textColor');
    if (textColorInput) {
        textColorInput.value = state.defaultParams.textColor;
    }

    const textXInput = document.getElementById('textX');
    if (textXInput) {
        textXInput.value = state.defaultParams.textX;
    }

    const textYInput = document.getElementById('textY');
    if (textYInput) {
        textYInput.value = state.defaultParams.textY;
    }

    const textParallaxInput = document.getElementById('textParallax');
    const valTextParallax = document.getElementById('valTextParallax');
    if (textParallaxInput) {
        textParallaxInput.value = state.defaultParams.textParallax;
    }
    if (valTextParallax) {
        valTextParallax.textContent = state.defaultParams.textParallax.toFixed(3);
    }

    const textRotationInput = document.getElementById('textRotation');
    const valTextRotation = document.getElementById('valTextRotation');
    if (textRotationInput) {
        textRotationInput.value = state.defaultParams.textRotation;
    }
    if (valTextRotation) {
        valTextRotation.textContent = state.defaultParams.textRotation;
    }

    const textEffectSelect = document.getElementById('textEffect');
    if (textEffectSelect) {
        textEffectSelect.value = state.defaultParams.textEffect;
    }

    const textEffectStrengthInput = document.getElementById('textEffectStrength');
    const valEffectStrength = document.getElementById('valEffectStrength');
    if (textEffectStrengthInput) {
        textEffectStrengthInput.value = state.defaultParams.textEffectStrength;
    }
    if (valEffectStrength) {
        valEffectStrength.textContent = Math.round(state.defaultParams.textEffectStrength * 100);
    }
}

/**
 * Reset the color adjustment UI.
 * state.params should already be reset to defaults before calling this
 * (see resetImageParameters / RESET_PARAM_KEYS below). This just syncs
 * the DOM from the current state via the shared updateColorAdjustUI helper.
 */
function resetColorAdjustmentUI() {
    // Delegate to the single-source-of-truth UI sync function.
    // Accessed via the StereoView namespace to avoid a circular import between
    // loaders and ui modules.
    const sync = (typeof window !== 'undefined'
        && window.StereoView?.ui?.updateColorAdjustUI) || null;
    if (sync) sync();
}

/**
 * Reset parameters when loading images
 */
// Parameter keys to reset on image load
const RESET_PARAM_KEYS = [
    // Crop & offset
    'cropX', 'cropY', 'offsetX', 'offsetY',
    // 3DTV crop & offset
    'tvCropX', 'tvCropY', 'tvOffsetX', 'tvOffsetY',
    // Alignment
    'shiftX', 'shiftY',
    // Zoom/pan
    'scale', 'panX', 'panY',
    // L/R swap
    'swapLR',
    // Auto-alignment transform
    'alignTransform',
    // Image quality adjustments (left & right) - single source of truth lives
    // in ui-color-adjust-config.js so adding a new quality param resets it too.
    ...QUALITY_PARAM_KEYS
];

export function resetImageParameters() {
    // Reset all tracked parameters to their defaults
    for (const key of RESET_PARAM_KEYS) {
        const defaultVal = state.defaultParams[key];
        if (Array.isArray(defaultVal)) {
            state.params[key] = [...defaultVal];
        } else {
            state.params[key] = defaultVal;
        }
    }

    // Reset crop tracking state
    state.lastCroppedShiftX = null;
    state.lastCroppedShiftY = null;
    state.lastCroppedAlign = null;
    state.lastCropState = null;

    // Sync slider UI values
    const sliderParams = ['shiftX', 'shiftY', 'scale'];
    sliderParams.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = state.defaultParams[id];
    });

    // Sync swapLR checkbox
    const swapLRCheckbox = document.getElementById('swapLR');
    if (swapLRCheckbox) swapLRCheckbox.checked = false;

    // Reset pixel display labels (parallax / vertical shift)
    const pxXEl = document.getElementById('valShiftXPx');
    const pxYEl = document.getElementById('valShiftYPx');
    if (pxXEl) pxXEl.textContent = '0';
    if (pxYEl) pxYEl.textContent = '0';

    // Reset viewer bar shift display
    const viewerShiftX = document.getElementById('viewerShiftX');
    const viewerShiftY = document.getElementById('viewerShiftY');
    if (viewerShiftX) viewerShiftX.textContent = '0';
    if (viewerShiftY) viewerShiftY.textContent = '0';

    // Reset zoom display labels
    const valScale = document.getElementById('valScale');
    if (valScale) valScale.textContent = '100%';
    const valZoomDisplay = document.getElementById('valZoomDisplay');
    if (valZoomDisplay) valZoomDisplay.textContent = '100%';
    const viewerZoom = document.getElementById('viewerZoom');
    if (viewerZoom) viewerZoom.textContent = '100%';

    // Update the color adjustment UI
    if (typeof window.updateColorAdjustUI === 'function') {
        // Use the globally available function directly
        window.updateColorAdjustUI();
    } else {
        // Fallback: try dynamic import, then fall back to local reset
        // Cache the import promise to prevent multiple concurrent imports from racing
        if (!resetImageParameters._colorAdjustImport) {
            resetImageParameters._colorAdjustImport = import('../ui/ui-color-adjustments.js');
        }
        resetImageParameters._colorAdjustImport.then(module => {
            if (module.updateColorAdjustUI) {
                module.updateColorAdjustUI();
            } else {
                resetColorAdjustmentUI();
            }
        }).catch(err => {
            logger.warn('LoaderState','[State] Dynamic import failed, using fallback:', err.message);
            resetImageParameters._colorAdjustImport = null;  // Allow retry on failure
            resetColorAdjustmentUI();
        });
    }
}
