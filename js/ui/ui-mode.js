/**
 * ui-mode.js
 * UI controls related to display modes
 * - Enable/disable parallax and intensity controls
 * - Control visibility of the 3DTV checkbox
 * - Control image adjustment UI
 */

import { state } from '../globals.js';
import { isSingleEyeMode, is3DTVModeApplicable } from '../mode-utils.js';
import { updateUniforms, updateMeshTransform } from '../rendering/renderer.js';
import { reset3DTVVirtualWindow } from './ui-crop.js';
import { applySwapLR } from './ui-alignment.js';
import { QUALITY_PARAMS } from './ui-color-adjust-config.js';

// getElement function for DOM element caching (passed from ui.js)
let getElementFn = (id) => document.getElementById(id);

/**
 * Set the getElement function (called from ui.js)
 * @param {Function} fn - DOM element getter function
 */
export function setGetElementFunction(fn) {
    getElementFn = fn;
}

/**
 * Gray out parallax/intensity controls in mono view mode (mode 4, 5)
 * These modes have no stereo view, so parallax/intensity adjustments are disabled
 * @param {number} mode - Current display mode
 */
export function updateParallaxControlsState(mode) {
    const isSingleEye = isSingleEyeMode(mode);

    // Parallax controls (shiftX, shiftY)
    const shiftXSlider = getElementFn('shiftX');
    const shiftYSlider = getElementFn('shiftY');
    const shiftXLabel = document.querySelector('label[for="shiftX"]');
    const shiftYLabel = document.querySelector('label[for="shiftY"]');
    const zeroShiftXBtn = getElementFn('zeroShiftXBtn');
    const zeroShiftYBtn = getElementFn('zeroShiftYBtn');

    // Intensity control (scale)
    const scaleSlider = getElementFn('scale');
    const scaleLabel = document.querySelector('label[for="scale"]');
    const oneScaleBtn = getElementFn('oneScaleBtn');

    if (isSingleEye) {
        // Gray out
        if (shiftXSlider) {
            shiftXSlider.disabled = true;
            shiftXSlider.style.opacity = '0.5';
        }
        if (shiftYSlider) {
            shiftYSlider.disabled = true;
            shiftYSlider.style.opacity = '0.5';
        }
        if (scaleSlider) {
            scaleSlider.disabled = true;
            scaleSlider.style.opacity = '0.5';
        }
        if (shiftXLabel) shiftXLabel.style.opacity = '0.5';
        if (shiftYLabel) shiftYLabel.style.opacity = '0.5';
        if (scaleLabel) scaleLabel.style.opacity = '0.5';
        if (zeroShiftXBtn) {
            zeroShiftXBtn.disabled = true;
            zeroShiftXBtn.style.opacity = '0.5';
        }
        if (zeroShiftYBtn) {
            zeroShiftYBtn.disabled = true;
            zeroShiftYBtn.style.opacity = '0.5';
        }
        if (oneScaleBtn) {
            oneScaleBtn.disabled = true;
            oneScaleBtn.style.opacity = '0.5';
        }
    } else {
        // Remove gray-out
        if (shiftXSlider) {
            shiftXSlider.disabled = false;
            shiftXSlider.style.opacity = '1';
        }
        if (shiftYSlider) {
            shiftYSlider.disabled = false;
            shiftYSlider.style.opacity = '1';
        }
        if (scaleSlider) {
            scaleSlider.disabled = false;
            scaleSlider.style.opacity = '1';
        }
        if (shiftXLabel) shiftXLabel.style.opacity = '1';
        if (shiftYLabel) shiftYLabel.style.opacity = '1';
        if (scaleLabel) scaleLabel.style.opacity = '1';
        if (zeroShiftXBtn) {
            zeroShiftXBtn.disabled = false;
            zeroShiftXBtn.style.opacity = '1';
        }
        if (zeroShiftYBtn) {
            zeroShiftYBtn.disabled = false;
            zeroShiftYBtn.style.opacity = '1';
        }
        if (oneScaleBtn) {
            oneScaleBtn.disabled = false;
            oneScaleBtn.style.opacity = '1';
        }
    }
}

/**
 * Control showing/hiding the 3DTV checkbox
 * Show only for SBS (mode 7, 8, 9) and TaB (mode 10, 16)
 * Excludes LRL (12) and Matrix 2x2 (13)
 * @param {number} mode - Current display mode
 */
export function update3dtvCheckboxVisibility(mode) {
    const sbs3dtvGroup = getElementFn('sbs3dtvGroup');
    const sbs3dtvCheckbox = getElementFn('sbs3dtv');
    if (!sbs3dtvGroup || !sbs3dtvCheckbox) return;

    // Show only for SBS (mode 7, 8, 9) and TaB (mode 10, 16)
    const shouldShow = is3DTVModeApplicable(mode);

    sbs3dtvGroup.style.display = shouldShow ? '' : 'none';

    // If hidden, uncheck and reset state
    if (!shouldShow && state.params.sbs3dtv) {
        sbs3dtvCheckbox.checked = false;
        state.params.sbs3dtv = false;
        if (Number.isFinite(state.pre3DTVScale)) {
            state.params.scale = state.pre3DTVScale;
            state.pre3DTVScale = null;
            const scaleInput = getElementFn('scale');
            if (scaleInput) scaleInput.value = state.params.scale;
            updateMeshTransform();
        }
        reset3DTVVirtualWindow();
        updateUniforms();
    }

}

/**
 * Control image adjustment UI and SwapLR checkbox based on display mode
 * - mode 4 (left only): disable right-eye adjustments and hide swapLR
 * - mode 5 (right only): disable left-eye adjustments and hide swapLR
 * - Other modes: enable/show all
 * @param {number} mode - Current display mode
 */
export function updateImageAdjustControlsState(mode) {
    const isLeftOnlyMode = (mode === 4);
    const isRightOnlyMode = (mode === 5);
    const isSingleEyeModeFlag = isLeftOnlyMode || isRightOnlyMode;

    // Per-eye image adjustment parameters (derived from QUALITY_PARAMS, the
    // single source of truth in ui-color-adjust-config.js).
    const leftParams = QUALITY_PARAMS.map(p => `${p.key}L`);
    const rightParams = QUALITY_PARAMS.map(p => `${p.key}R`);

    // In linked mode, L controls drive both eyes; the R row is hidden and
    // disabling the L slider would prevent any adjustment. Skip the per-eye
    // disable logic when linked (sliders + number inputs + reset buttons +
    // the separate L/R auto-correction buttons are all moot).
    const linked = !!state.params.linkLR;

    // Also touch number inputs and per-parameter reset buttons so they match
    // the slider's enabled/disabled state.
    const applyDisabled = (side, disabled) => {
        const params = side === 'L' ? leftParams : rightParams;
        params.forEach(id => {
            const slider = getElementFn(id);
            if (slider) {
                slider.disabled = disabled;
                slider.style.opacity = disabled ? '0.5' : '1';
            }
            const num = getElementFn(`${id}-num`);
            if (num) {
                num.disabled = disabled;
                num.style.opacity = disabled ? '0.5' : '1';
            }
            // Row label (look up via closest container, not parent)
            const row = slider?.closest('.quality-row');
            const label = row?.querySelector('.quality-label');
            if (label) {
                label.style.opacity = disabled ? '0.5' : '1';
            }
        });
    };

    // If right-eye only, disable left-eye sliders (only in unlinked mode)
    applyDisabled('L', !linked && isRightOnlyMode);
    // If left-eye only, disable right-eye sliders (only in unlinked mode)
    applyDisabled('R', !linked && isLeftOnlyMode);

    // Control auto-correction buttons
    const autoLevelsLBtn = getElementFn('autoLevelsLBtn');
    const autoLevelsRBtn = getElementFn('autoLevelsRBtn');
    const autoLevelsBtn = getElementFn('autoLevelsBtn');

    if (autoLevelsLBtn) {
        autoLevelsLBtn.disabled = isRightOnlyMode;
        autoLevelsLBtn.style.opacity = isRightOnlyMode ? '0.5' : '1';
    }
    if (autoLevelsRBtn) {
        autoLevelsRBtn.disabled = isLeftOnlyMode;
        autoLevelsRBtn.style.opacity = isLeftOnlyMode ? '0.5' : '1';
    }
    // Linked unified auto-correction button uses L's histogram; disable when
    // L isn't visible (right-only mode).
    if (autoLevelsBtn) {
        autoLevelsBtn.disabled = isRightOnlyMode;
        autoLevelsBtn.style.opacity = isRightOnlyMode ? '0.5' : '1';
    }

    // Control swapLR checkbox (hidden in mono mode)
    const swapLRCheckbox = getElementFn('swapLR');
    const swapLRGroup = swapLRCheckbox?.closest('.checkbox-group');

    if (swapLRGroup) {
        swapLRGroup.style.display = isSingleEyeModeFlag ? 'none' : '';
    }

    // Reset swapLR to false when entering mono mode
    if (isSingleEyeModeFlag && state.params.swapLR) {
        // This is an eye-assignment change, not a checkbox-only UI update.
        // Route it through the shared operation so shift signs and the geometric
        // alignment transform cannot be left associated with the wrong eye.
        applySwapLR(false);
    }
}

/**
 * Update border decoration checkbox visibility based on mode
 * Visible only in modes 8 (parallel), 9 (cross), 12 (LRL), 13 (2x2 matrix)
 * @param {number} mode - Current display mode
 */
export function updateBorderDecorationVisibility(mode) {
    const borderGroup = getElementFn('borderDecorationGroup');
    if (borderGroup) {
        // Show only for modes 8, 9, 12, 13
        const shouldShow = (mode === 8 || mode === 9 || mode === 12 || mode === 13);
        borderGroup.style.display = shouldShow ? '' : 'none';
    }
}
