/**
 * ui-text-overlay.js
 * Manage UI controls for the text overlay
 */
import { state } from '../globals.js';
import { updateTextOverlay } from '../rendering/renderer.js';
import { resetTextParameters } from './ui-parameters.js';

// AbortController for managing event listeners (prevent memory leaks)
let textOverlayEventAbortController = null;

let textOverlayInitialized = false;

/**
 * Clamp a value to an input element's min/max (when defined).
 * @param {HTMLInputElement} el - The input element
 * @param {number} val - The value to clamp
 * @returns {number} The clamped value
 */
function clampToInput(el, val) {
    const min = parseFloat(el.min);
    const max = parseFloat(el.max);
    if (Number.isFinite(min) && val < min) val = min;
    if (Number.isFinite(max) && val > max) val = max;
    return val;
}

/**
 * Show the effect-strength control only when a 3D effect is active.
 * (The strength value is ignored by the renderer when the effect is 'none'.)
 */
function updateEffectStrengthVisibility() {
    const ctrl = document.getElementById('effectStrengthControl');
    if (ctrl) {
        ctrl.style.display = (state.params.textEffect === 'none') ? 'none' : '';
    }
}

/**
 * Set up event listeners for the text overlay
 */
export function setupTextOverlayControls() {
    if (textOverlayInitialized) return;
    textOverlayInitialized = true;

    // Initialize AbortController (abort existing one if present)
    if (textOverlayEventAbortController) {
        textOverlayEventAbortController.abort();
    }
    textOverlayEventAbortController = new AbortController();
    const signal = textOverlayEventAbortController.signal;

    // Text input (apply immediately)
    const textStringEl = document.getElementById('textString');
    if (textStringEl) {
        textStringEl.addEventListener('input', (e) => {
            state.params.textString = e.target.value;
            updateTextOverlay(true);
        }, { signal });
    }

    // Text size (apply immediately)
    const textSizeEl = document.getElementById('textSize');
    if (textSizeEl) {
        // Clamp on input so the rendered font size stays within the supported range
        // even if the user types a value outside the field's min/max.
        textSizeEl.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (Number.isNaN(val)) return;
            state.params.textSize = clampToInput(e.target, val);
            updateTextOverlay(true);
        }, { signal });
        // On commit (blur/Enter), snap an out-of-range value back into the field.
        textSizeEl.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            if (Number.isNaN(val)) return;
            const clamped = clampToInput(e.target, val);
            e.target.value = clamped;
            state.params.textSize = clamped;
            updateTextOverlay(true);
        }, { signal });
    }

    // Outline (apply immediately)
    const textStrokeEl = document.getElementById('textStroke');
    if (textStrokeEl) {
        textStrokeEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (Number.isNaN(val)) return;
            state.params.textStroke = clampToInput(e.target, val);
            updateTextOverlay(true);
        }, { signal });
        textStrokeEl.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            if (Number.isNaN(val)) return;
            const clamped = clampToInput(e.target, val);
            e.target.value = clamped;
            state.params.textStroke = clamped;
            updateTextOverlay(true);
        }, { signal });
    }

    // Color (apply immediately)
    const textColorEl = document.getElementById('textColor');
    if (textColorEl) {
        textColorEl.addEventListener('input', (e) => {
            state.params.textColor = e.target.value;
            updateTextOverlay(true);
        }, { signal });
    }

    // Horizontal position (apply immediately)
    const textXEl = document.getElementById('textX');
    if (textXEl) {
        textXEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (Number.isNaN(val)) return;
            state.params.textX = val;
            updateTextOverlay(true);
        }, { signal });
    }

    // Vertical position (apply immediately)
    const textYEl = document.getElementById('textY');
    if (textYEl) {
        textYEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (Number.isNaN(val)) return;
            state.params.textY = val;
            updateTextOverlay(true);
        }, { signal });
    }

    // Text parallax (apply immediately, update uniforms only)
    const textParallaxEl = document.getElementById('textParallax');
    if (textParallaxEl) {
        textParallaxEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (Number.isNaN(val)) return;
            state.params.textParallax = val;
            const valEl = document.getElementById('valTextParallax');
            if (valEl) {
                valEl.textContent = state.params.textParallax.toFixed(3);
            }
            updateTextOverlay(false);
        }, { signal });
    }

    // Text rotation (apply immediately)
    const textRotationEl = document.getElementById('textRotation');
    if (textRotationEl) {
        textRotationEl.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (Number.isNaN(val)) return;
            state.params.textRotation = val;
            const valEl = document.getElementById('valTextRotation');
            if (valEl) {
                valEl.textContent = state.params.textRotation;
            }
            updateTextOverlay(true);
        }, { signal });
    }

    // Text 3D effect
    const textEffectEl = document.getElementById('textEffect');
    if (textEffectEl) {
        textEffectEl.addEventListener('change', (e) => {
            state.params.textEffect = e.target.value;
            updateEffectStrengthVisibility();
            updateTextOverlay(true);
        }, { signal });
    }

    // Text effect strength
    const textEffectStrengthEl = document.getElementById('textEffectStrength');
    if (textEffectStrengthEl) {
        textEffectStrengthEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (Number.isNaN(val)) return;
            state.params.textEffectStrength = val;
            const valEl = document.getElementById('valEffectStrength');
            if (valEl) {
                valEl.textContent = Math.round(state.params.textEffectStrength * 100);
            }
            updateTextOverlay(true);
        }, { signal });
    }

    // Text overlay reset button
    const resetTextBtn = document.getElementById('resetTextBtn');
    if (resetTextBtn) {
        resetTextBtn.addEventListener('click', () => {
            resetTextParameters();
        }, { signal });
    }

    // Text overlay apply button: explicit re-render of the text overlay.
    // Useful after IME composition, where intermediate 'input' events may not
    // reflect the committed string.
    const applyTextBtn = document.getElementById('applyTextBtn');
    if (applyTextBtn) {
        applyTextBtn.addEventListener('click', () => {
            updateTextOverlay(true);
        }, { signal });
    }

    // Sync dependent UI to the initial parameter state.
    updateEffectStrengthVisibility();
}

/**
 * Clean up text overlay system resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guards)
 */
export function cleanupTextOverlayControls() {
    // Remove event listeners
    if (textOverlayEventAbortController) {
        textOverlayEventAbortController.abort();
        textOverlayEventAbortController = null;
    }
    // Reset initialization flag (allow re-init after cleanup)
    textOverlayInitialized = false;
}
