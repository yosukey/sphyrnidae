/**
 * ui-parameters.js
 * Parameter management and reset functions
 * - Update parameter values
 * - Reset parallax parameters
 * - Reset crop
 * - Reset text parameters
 */

import { state, is3DTVActive } from '../globals.js';
import {
    updateUniforms,
    updateMeshTransform,
    updateCroppedResolution,
    updateTextOverlay
} from '../rendering/renderer.js';
import * as logger from '../utils/logger.js';

// Callback functions (set from ui.js)
let callbacks = {
    updateZoomDisplay: null,
    updateViewerZoomDisplay: null,
    updatePxDisplay: null,
    updateCropButtonState: null,
    updateHistogramPanelDebounced: null,
    updateHistogramPanelIfVisible: null,
    updateExportResolution: null
};

/**
 * Set callback functions
 * @param {Object} cbs - Callback function object
 */
export function setParameterCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

/**
 * Update parameters from JS and sync both UI (sliders) and shaders
 * @param {string} id - Parameter ID
 * @param {number} value - New value
 */
export function updateParamValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
        const min = parseFloat(el.min);
        const max = parseFloat(el.max);

        // Only clamp if min/max are valid numbers
        if (Number.isFinite(min) && value < min) value = min;
        if (Number.isFinite(max) && value > max) value = max;

        el.value = value;
    }

    // For scale only, update mesh transform and zoom display
    if (id === 'scale') {
        // In 3DTV mode, update viewerScale (used for zoom in shader)
        const is3dtvMode = is3DTVActive();
        if (is3dtvMode) {
            // 3DTV uses a separate shader zoom. Do not overwrite the normal-view
            // mesh scale, otherwise leaving 3DTV applies the virtual zoom to 2D.
            state.viewerScale = value;
            // Reset pan when zoomed out (viewerScale <= 1.0)
            if (value <= 1.0) {
                state.viewerPanX = 0;
                state.viewerPanY = 0;
            }
            updateUniforms();
            callbacks.updateViewerZoomDisplay?.(value);
        } else {
            state.params[id] = value;
            updateMeshTransform();
            callbacks.updateZoomDisplay?.();  // Updates both valScale and valZoomDisplay
        }
    } else if (id === 'cropX' || id === 'cropY' || id === 'offsetX' || id === 'offsetY') {
        // Crop-window parameters need the same downstream sync as the canonical
        // crop paths (applyCropSelection in ui-crop.js and resetAllCrop below):
        // the mesh is scaled by (1 - cropX/cropY), and the cropped-resolution
        // readout, export resolution, crop-button state and (visible-area)
        // histogram all derive from the crop values. Previously this fell through
        // to the generic branch (state.params + updateUniforms only), so the only
        // safe caller was the external-image loader, which follows the four
        // updateParamValue('crop…') calls with onWindowResize(). Firing the side
        // effects here keeps any future/other caller from leaving these displays
        // stale. The histogram uses the debounced update so the loader's four
        // successive crop writes coalesce into a single recompute.
        state.params[id] = value;
        updateUniforms();
        updateMeshTransform();
        if (state.material && state.material.uniforms.map.value?.image) {
            const texture = state.material.uniforms.map.value;
            const eyeWidth = Math.floor(texture.image.width / 2);
            const eyeHeight = texture.image.height;
            updateCroppedResolution(eyeWidth, eyeHeight);
            callbacks.updateZoomDisplay?.();
            callbacks.updateExportResolution?.();
        }
        callbacks.updateCropButtonState?.();
        callbacks.updateHistogramPanelDebounced?.();
    } else {
        state.params[id] = value;
        updateUniforms();
        if (id === 'shiftX' || id === 'shiftY') {
            callbacks.updatePxDisplay?.();
            callbacks.updateCropButtonState?.();
            // Update histogram only if "visible area only" is checked
            // (If off, it uses the full image and is not affected by shifts)
            // Update with debounce (slider drags or key holds)
            const cropOnlyCheckbox = document.getElementById('histogramCropOnly');
            if (cropOnlyCheckbox && cropOnlyCheckbox.checked) {
                callbacks.updateHistogramPanelDebounced?.();
            }
        }
    }
}

/**
 * Clear all crops (auto crop and rectangle crop)
 * Return to a state with no crop applied
 */
export function resetAllCrop() {
    logger.debug('UI_LOG', 'UIParameters','[UI-Parameters] resetAllCrop: Before reset', {
        cropX: state.params.cropX,
        cropY: state.params.cropY,
        offsetX: state.params.offsetX,
        offsetY: state.params.offsetY
    });

    state.params.cropX = state.defaultParams.cropX;
    state.params.cropY = state.defaultParams.cropY;
    state.params.offsetX = state.defaultParams.offsetX;
    state.params.offsetY = state.defaultParams.offsetY;

    state.lastCroppedShiftX = null;
    state.lastCroppedShiftY = null;
    state.lastCroppedAlign = null;
    state.lastCropState = null; // Clear saved rectangle crop state as well

    logger.debug('UI_LOG', 'UIParameters','[UI-Parameters] resetAllCrop: After reset', {
        cropX: state.params.cropX,
        cropY: state.params.cropY,
        offsetX: state.params.offsetX,
        offsetY: state.params.offsetY
    });

    updateUniforms();
    updateMeshTransform();  // Update mesh scale based on crop reset

    logger.debug('UI_LOG', 'UIParameters','[UI-Parameters] resetAllCrop: After mesh update');

    // Force render to ensure visual update is applied immediately
    if (state.renderer && typeof state.renderer.render === 'function') {
        if (state.scene && state.camera) {
            state.renderer.render(state.scene, state.camera);
            logger.debug('UI_LOG', 'UIParameters','[UI-Parameters] resetAllCrop: Forced render executed');
        }
    }

    if (state.material && state.material.uniforms.map.value?.image) {
        // Guard .image, not just the texture: a texture can exist with its image
        // already released mid-teardown (mirrors the updateParamValue crop branch).
        const texture = state.material.uniforms.map.value;
        const imageWidth = texture.image.width;
        const imageHeight = texture.image.height;
        const eyeWidth = Math.floor(imageWidth / 2);
        const eyeHeight = imageHeight;
        updateCroppedResolution(eyeWidth, eyeHeight);
        callbacks.updateZoomDisplay?.();
        callbacks.updateExportResolution?.();
    }

    callbacks.updateCropButtonState?.();
    callbacks.updateHistogramPanelIfVisible?.();
}

/**
 * Reset text overlay
 */
export function resetTextParameters() {
    const textInput = document.getElementById('textString');
    if (textInput) textInput.value = '';

    state.params.textString = state.defaultParams.textString;
    state.params.textSize = state.defaultParams.textSize;
    state.params.textStroke = state.defaultParams.textStroke;
    state.params.textColor = state.defaultParams.textColor;
    state.params.textX = state.defaultParams.textX;
    state.params.textY = state.defaultParams.textY;
    state.params.textParallax = state.defaultParams.textParallax;
    const sizeInput = document.getElementById('textSize');
    if (sizeInput) sizeInput.value = state.defaultParams.textSize;

    const strokeInput = document.getElementById('textStroke');
    if (strokeInput) strokeInput.value = state.defaultParams.textStroke;

    const colorInput = document.getElementById('textColor');
    if (colorInput) colorInput.value = state.defaultParams.textColor;

    const xInput = document.getElementById('textX');
    if (xInput) xInput.value = state.defaultParams.textX;

    const yInput = document.getElementById('textY');
    if (yInput) yInput.value = state.defaultParams.textY;

    const parallaxInput = document.getElementById('textParallax');
    if (parallaxInput) parallaxInput.value = state.defaultParams.textParallax;

    const parallaxLabel = document.getElementById('valTextParallax');
    if (parallaxLabel) parallaxLabel.textContent = state.defaultParams.textParallax.toFixed(3);

    state.params.textRotation = state.defaultParams.textRotation;
    state.params.textEffect = state.defaultParams.textEffect;
    state.params.textEffectStrength = state.defaultParams.textEffectStrength;

    const rotationInput = document.getElementById('textRotation');
    if (rotationInput) rotationInput.value = state.defaultParams.textRotation;

    const rotationLabel = document.getElementById('valTextRotation');
    if (rotationLabel) rotationLabel.textContent = state.defaultParams.textRotation;

    const effectSelect = document.getElementById('textEffect');
    if (effectSelect) effectSelect.value = state.defaultParams.textEffect;

    // Keep the effect-strength control's visibility in sync with the reset effect.
    const effectStrengthControl = document.getElementById('effectStrengthControl');
    if (effectStrengthControl) {
        effectStrengthControl.style.display =
            (state.defaultParams.textEffect === 'none') ? 'none' : '';
    }

    const effectStrengthInput = document.getElementById('textEffectStrength');
    if (effectStrengthInput) effectStrengthInput.value = state.defaultParams.textEffectStrength;

    const effectStrengthLabel = document.getElementById('valEffectStrength');
    if (effectStrengthLabel) effectStrengthLabel.textContent = Math.round(state.defaultParams.textEffectStrength * 100);

    updateTextOverlay(true);
}
