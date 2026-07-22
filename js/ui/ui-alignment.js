/**
 * ui-alignment.js
 * Manage alignment UI controls (shift, swap, auto-alignment)
 */
import { state, isSBSMode, is3DTVActive } from '../globals.js';
import {
    updateUniforms,
    updateMeshTransform,
    fitImageToWindow
} from '../rendering/renderer.js';
import { performAutoAlignment } from '../rendering/alignment.js';
import { syncActiveExifState } from '../loaders/loader.js';
import { updateExifModalIfVisible } from './ui-exif.js';
import {
    reset3DTVVirtualWindow
} from './ui-crop.js';

// AbortController for managing event listeners (prevent memory leaks)
let alignmentEventAbortController = null;

/**
 * Parameter update function (injected from ui-parameters.js)
 */
let updateParamValue = null;

/**
 * Pixel display update function (injected from ui.js)
 */
let updatePxDisplay = null;

/**
 * Histogram panel update function (injected from ui-histogram.js)
 */
let updateHistogramPanelIfVisible = null;

/**
 * Crop button state update function (injected from ui-crop.js)
 */
let updateCropButtonState = null;

/**
 * Zoom display update function (injected from ui-zoom.js)
 */
let updateViewerZoomDisplay = null;

/**
 * Normal-mode zoom readout update function (injected from ui-zoom.js)
 */
let updateZoomDisplay = null;

/**
 * Set callback functions
 * @param {Object} callbacks - Callback function object
 */
export function setAlignmentCallbacks(callbacks) {
    updateParamValue = callbacks.updateParamValue;
    updatePxDisplay = callbacks.updatePxDisplay;
    updateHistogramPanelIfVisible = callbacks.updateHistogramPanelIfVisible;
    updateCropButtonState = callbacks.updateCropButtonState;
    updateViewerZoomDisplay = callbacks.updateViewerZoomDisplay;
    updateZoomDisplay = callbacks.updateZoomDisplay;
}

/**
 * Apply a left/right eye swap from any entry point (the swapLR checkbox, the
 * keyboard 'S' shortcut, or the viewer swap button) so every path stays
 * consistent. Inverts the manual shift signs (the shift basis reverses with the
 * swap), resets the auto-alignment homography (it is eye-assignment specific),
 * and refreshes every dependent UI surface (sliders, the swapLR checkbox, the
 * pixel-shift readout, crop button, uniforms, histogram, EXIF). Centralizing
 * this prevents the readout/checkbox from going stale when the swap is triggered
 * from the keyboard or viewer button rather than the checkbox.
 * @param {boolean} newSwapValue - Desired swapLR state.
 */
export function applySwapLR(newSwapValue) {
    state.params.swapLR = newSwapValue;

    // When swapLR toggles, invert sign because the shift basis reverses.
    // This preserves the visual alignment before and after switching.
    state.params.shiftX = -state.params.shiftX;
    state.params.shiftY = -state.params.shiftY;

    // The auto-alignment homography was computed for the previous eye
    // assignment; after a swap it would be applied to the wrong physical
    // half. Reset it to identity (same reset the ZERO buttons use).
    if (updateParamValue) {
        updateParamValue('alignTransform', [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    } else {
        state.params.alignTransform = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }

    // Update slider UI display
    const shiftXSlider = document.getElementById('shiftX');
    const shiftYSlider = document.getElementById('shiftY');
    if (shiftXSlider) shiftXSlider.value = state.params.shiftX;
    if (shiftYSlider) shiftYSlider.value = state.params.shiftY;

    // Keep the swapLR checkbox in sync regardless of which control triggered the swap
    const swapLREl = document.getElementById('swapLR');
    if (swapLREl) swapLREl.checked = state.params.swapLR;

    // Update pixel display (otherwise the px readout keeps the pre-swap sign)
    if (updatePxDisplay) updatePxDisplay();

    // Update crop button state
    if (updateCropButtonState) updateCropButtonState();

    updateUniforms();

    // Update histogram panel if visible (reflect left/right swap)
    if (updateHistogramPanelIfVisible) updateHistogramPanelIfVisible();

    // Update EXIF display (switch based on swapLR)
    syncActiveExifState();
    updateExifModalIfVisible();
}

/**
 * Set up alignment event listeners
 */
export function setupAlignmentControls() {
    // Initialize AbortController (abort existing one if present)
    if (alignmentEventAbortController) {
        alignmentEventAbortController.abort();
    }
    alignmentEventAbortController = new AbortController();
    const signal = alignmentEventAbortController.signal;

    // shiftX, shiftY, scale parameters
    const params = ['shiftX', 'shiftY', 'scale'];
    params.forEach(id => {
        const el = document.getElementById(id);
        if (el && updateParamValue) {
            el.addEventListener('input', (e) => {
                updateParamValue(id, parseFloat(e.target.value));
            }, { signal });
        }
    });

    // swapLR checkbox
    const swapLREl = document.getElementById('swapLR');
    if (swapLREl) {
        swapLREl.addEventListener('change', (e) => {
            applySwapLR(e.target.checked);
        }, { signal });

        // Sync initial state
        swapLREl.checked = state.params.swapLR;
    }

    // 3DTV checkbox
    const sbs3dtvEl = document.getElementById('sbs3dtv');
    if (sbs3dtvEl) {
        sbs3dtvEl.addEventListener('change', (e) => {
            state.params.sbs3dtv = e.target.checked;

            if (e.target.checked) {
                // 3DTV mode on: reset viewerScale to 1.0 and stretch the mesh to full screen
                state.pre3DTVScale = state.params.scale;
                state.viewerScale = 1.0;
                state.viewerPanX = 0;
                state.viewerPanY = 0;
                state.params.panX = 0;
                state.params.panY = 0;
                // Sync the #scale slider to 1.0 too: in 3DTV mode this slider drives
                // viewerScale (ui-parameters.js), so leaving it at the old value made
                // the next nudge jump the zoom from 1.0 to the stale value. Mirrors
                // the slider sync the disable branch below already performs.
                const scaleInput = document.getElementById('scale');
                if (scaleInput) scaleInput.value = 1.0;
            } else if (Number.isFinite(state.pre3DTVScale)) {
                state.params.scale = state.pre3DTVScale;
                state.pre3DTVScale = null;
                const scaleInput = document.getElementById('scale');
                if (scaleInput) scaleInput.value = state.params.scale;
            }

            // Keep 3DTV virtual trim neutral by default (no implicit aspect change)
            // and never alter regular crop values here.
            reset3DTVVirtualWindow();

            updateMeshTransform();
            updateUniforms();
        }, { signal });
    }

    // ZERO button (shiftX) — also resets alignTransform to identity
    const zeroShiftXBtn = document.getElementById('zeroShiftXBtn');
    if (zeroShiftXBtn && updateParamValue) {
        zeroShiftXBtn.addEventListener('click', () => {
            updateParamValue('alignTransform', [1, 0, 0, 0, 1, 0, 0, 0, 1]);
            updateParamValue('shiftX', 0);
        }, { signal });
    }

    // ZERO button (shiftY) — also resets alignTransform to identity
    const zeroShiftYBtn = document.getElementById('zeroShiftYBtn');
    if (zeroShiftYBtn && updateParamValue) {
        zeroShiftYBtn.addEventListener('click', () => {
            updateParamValue('alignTransform', [1, 0, 0, 0, 1, 0, 0, 0, 1]);
            updateParamValue('shiftY', 0);
        }, { signal });
    }

    // FIT button (scale/zoom)
    const fitBtn = document.getElementById('fitBtn');
    if (fitBtn) {
        fitBtn.addEventListener('click', () => {
            fitImageToWindow();
            // Update zoom display after FIT
            const is3dtvMode = is3DTVActive();
            if (is3dtvMode) {
                // In 3DTV mode the #scale slider drives viewerScale, which FIT reset
                // to 1.0. fitImageToWindow() dispatched param-changed-externally with
                // the internal mesh scale (fitScale), which ui.js wrote into the
                // slider — leaving it at fitScale while viewerScale is 1.0, so the
                // next nudge would jump the zoom. Re-sync the slider to viewerScale
                // (mirrors the 3DTV-checkbox slider sync).
                const scaleInput = document.getElementById('scale');
                if (scaleInput) scaleInput.value = state.viewerScale;
            }
            if (state.viewerMode || is3dtvMode) {
                const effectiveScale = is3dtvMode
                    ? state.viewerScale
                    : (isSBSMode(state.params.mode)
                        ? state.params.scale * state.viewerScale
                        : state.params.scale);
                if (updateViewerZoomDisplay) updateViewerZoomDisplay(effectiveScale);
            } else {
                // Normal (non-viewer, non-3DTV) mode: fitImageToWindow only dispatches
                // viewer-zoom-changed in viewer mode, and param-changed-externally
                // updates only the slider value, so the valScale/valZoomDisplay
                // readouts stay stale. Refresh them from the new state.params.scale.
                if (updateZoomDisplay) updateZoomDisplay();
            }
        }, { signal });
    }

    // Auto-alignment button
    const autoAlignBtn = document.getElementById('autoAlignBtn');
    if (autoAlignBtn && updateParamValue) {
        autoAlignBtn.addEventListener('click', () => {
            performAutoAlignment(updateParamValue, null);
        }, { signal });
    }
}

/**
 * Clean up alignment system resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guards)
 */
export function cleanupAlignmentControls() {
    // Remove event listeners
    if (alignmentEventAbortController) {
        alignmentEventAbortController.abort();
        alignmentEventAbortController = null;
    }
}
