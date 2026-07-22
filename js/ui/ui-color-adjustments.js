/**
 * ui-color-adjustments.js
 * Manage UI controls for color adjustments and histograms.
 *
 * Features:
 *  - L/R link toggle (global option for image-quality adjustments).
 *    When linked, the L control drives both eyes and the R row is hidden.
 *  - Paired slider + number input with clamping validation per parameter.
 *  - Per-parameter reset button in addition to "Reset all".
 */
import { state } from '../globals.js';
import { updateUniforms } from '../rendering/renderer.js';
import { applyAutoLevels } from '../core/histogram.js';
import { QUALITY_PARAMS, QUALITY_PARAM_KEYS, getQualityParam, clampParamValue, formatQualityNumberInput } from './ui-color-adjust-config.js';
import { updateImageAdjustControlsState } from './ui-mode.js';
import {
    showHistogramPanel,
    updateHistogramPanel,
    updateHistogramPanelIfVisible,
    updateHistogramPanelDebounced,
    updateColorAdjustUI
} from './ui-histogram.js';

// AbortController for managing event listeners (prevent memory leaks)
let colorAdjustmentEventAbortController = null;

/**
 * Apply `${key}${side}` parameter value to state + DOM, honoring the link toggle.
 * If linked, the opposite side is synced to the same value.
 * @param {string} key  Base parameter key (e.g. 'brightness')
 * @param {'L'|'R'} side Eye side
 * @param {number} clampedValue Already-clamped finite value
 */
function applyParamValue(key, side, clampedValue) {
    const linked = !!state.params.linkLR;
    const sides = linked ? ['L', 'R'] : [side];

    for (const s of sides) {
        state.params[`${key}${s}`] = clampedValue;
        syncRowDom(key, s, clampedValue);
    }

    updateUniforms();
    refreshResetButton(key);
    updateHistogramPanelDebounced();
}

/**
 * Sync slider + number input DOM for one (key, side) pair.
 */
function syncRowDom(key, side, value) {
    const def = getQualityParam(key);
    if (!def) return;

    const slider = document.getElementById(`${key}${side}`);
    const num = document.getElementById(`${key}${side}-num`);
    if (slider) slider.value = String(value);
    if (num && document.activeElement !== num) {
        // Format number input so trailing zeros show (e.g. 0.50 not 0.5) but
        // don't rewrite while the user is actively typing in it.
        num.value = formatQualityNumberInput(def, value);
    }
}

/**
 * Enable/disable a parameter's reset button based on whether current state
 * differs from defaults (per linked/unlinked view).
 */
function refreshResetButton(key) {
    const def = getQualityParam(key);
    if (!def) return;
    const linked = !!state.params.linkLR;
    const container = document.querySelector(`.quality-param[data-param="${key}"]`);
    if (!container) return;

    const lBtn = container.querySelector('.param-reset-btn[data-reset-side="L"]');
    const rBtn = container.querySelector('.param-reset-btn[data-reset-side="R"]');
    const lDirty = state.params[`${key}L`] !== def.default;
    const rDirty = state.params[`${key}R`] !== def.default;

    if (lBtn) {
        // In linked view the L reset button represents both eyes
        const dirty = linked ? (lDirty || rDirty) : lDirty;
        lBtn.disabled = !dirty;
    }
    if (rBtn) {
        rBtn.disabled = !rDirty;
    }
}

function refreshAllResetButtons() {
    QUALITY_PARAMS.forEach(def => refreshResetButton(def.key));
}

/**
 * Reset a single parameter.
 * - side 'L' in linked mode → resets both eyes.
 * - side 'L'/'R' in unlinked mode → resets only that side.
 */
function resetParam(key, side) {
    const def = getQualityParam(key);
    if (!def) return;
    const linked = !!state.params.linkLR;
    const sides = linked ? ['L', 'R'] : [side];
    for (const s of sides) {
        state.params[`${key}${s}`] = def.default;
        syncRowDom(key, s, def.default);
    }
    updateUniforms();
    refreshResetButton(key);
    updateHistogramPanelIfVisible();
}

/**
 * Handle link-toggle change.
 * When turning ON, force R to match L so the two eyes are in sync.
 */
function onLinkLRChange(linked) {
    state.params.linkLR = linked;
    const content = document.getElementById('image-adjust-content');
    if (content) {
        content.classList.toggle('linked', linked);
        content.classList.toggle('unlinked', !linked);
    }

    if (linked) {
        // Align R to L so both eyes match.
        for (const def of QUALITY_PARAMS) {
            const lVal = state.params[`${def.key}L`];
            state.params[`${def.key}R`] = lVal;
            syncRowDom(def.key, 'R', lVal);
        }
        updateUniforms();
        updateHistogramPanelIfVisible();
    }
    refreshAllResetButtons();
    // The per-eye enable/disable logic depends on the link state (in mono modes,
    // linking hides the R row and must re-enable the L controls; unlinking must
    // restore the mono-mode disable). Re-run it so toggling the link never leaves
    // a visible control stuck disabled or a hidden control needlessly enabled.
    updateImageAdjustControlsState(state.params.mode);
}

/**
 * Set up event listeners for color adjustments.
 */
export function setupColorAdjustmentControls() {
    // Initialize AbortController (abort existing one if present)
    if (colorAdjustmentEventAbortController) {
        colorAdjustmentEventAbortController.abort();
    }
    colorAdjustmentEventAbortController = new AbortController();
    const signal = colorAdjustmentEventAbortController.signal;

    // ----- Per-parameter slider + number input wiring -----
    for (const def of QUALITY_PARAMS) {
        for (const side of ['L', 'R']) {
            const slider = document.getElementById(`${def.key}${side}`);
            const num = document.getElementById(`${def.key}${side}-num`);

            if (slider) {
                slider.addEventListener('input', (e) => {
                    const raw = parseFloat(e.target.value);
                    const clamped = clampParamValue(def.key, raw);
                    if (clamped === null) return;
                    applyParamValue(def.key, side, clamped);
                }, { signal });
            }

            if (num) {
                // Commit only on change/blur so mid-typing "-" or "." is not clobbered.
                const commitFromNumber = () => {
                    const raw = num.value.trim();
                    const clamped = clampParamValue(def.key, raw);
                    if (clamped === null) {
                        // Invalid → revert to current state value
                        const current = state.params[`${def.key}${side}`];
                        num.value = formatQualityNumberInput(def, current);
                        return;
                    }
                    applyParamValue(def.key, side, clamped);
                    // Re-format the input to canonical representation (e.g. "99" → "1.00")
                    num.value = formatQualityNumberInput(def, clamped);
                };
                num.addEventListener('change', commitFromNumber, { signal });
                num.addEventListener('blur', commitFromNumber, { signal });
                // Enter key commits too (some browsers don't fire 'change' until blur)
                num.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        commitFromNumber();
                        num.blur();
                    }
                }, { signal });
            }
        }
    }

    // ----- Per-parameter reset buttons -----
    document.querySelectorAll('#image-adjust-content .param-reset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const key = btn.dataset.resetParam;
            const side = btn.dataset.resetSide; // 'L' or 'R'
            if (!key || !side) return;
            resetParam(key, side === 'R' ? 'R' : 'L');
        }, { signal });
    });

    // ----- Link L/R toggle -----
    const linkToggle = document.getElementById('linkLRToggle');
    if (linkToggle) {
        // Initialize from state
        linkToggle.checked = !!state.params.linkLR;
        onLinkLRChange(linkToggle.checked);
        linkToggle.addEventListener('change', (e) => {
            onLinkLRChange(!!e.target.checked);
        }, { signal });
    }

    // ----- Auto-level correction -----
    // Linked: single button applies L histogram to both eyes.
    //
    // Design intent (do NOT change to per-eye or averaged): in linked mode the
    // LEFT eye is the single reference. Auto-correction is computed from the L
    // histogram and mirrored to R, exactly as the manual linked sliders drive
    // both eyes from L. This deliberately keeps both eyes on one identical curve
    // — matched L/R tone is preferred over each eye being individually optimal,
    // so the stereo pair fuses without a brightness/contrast mismatch.
    const autoLevelsBtn = document.getElementById('autoLevelsBtn');
    if (autoLevelsBtn) {
        autoLevelsBtn.addEventListener('click', () => {
            applyAutoLevels(true);
            // Copy L results to R (linked mode always mirrors)
            mirrorLtoR();
            updateColorAdjustUI();
            refreshAllResetButtons();
            updateHistogramPanelIfVisible();
        }, { signal });
    }

    // Unlinked: separate L and R buttons
    const autoLevelsLBtn = document.getElementById('autoLevelsLBtn');
    if (autoLevelsLBtn) {
        autoLevelsLBtn.addEventListener('click', () => {
            applyAutoLevels(true);
            updateColorAdjustUI();
            refreshAllResetButtons();
            updateHistogramPanelIfVisible();
        }, { signal });
    }

    const autoLevelsRBtn = document.getElementById('autoLevelsRBtn');
    if (autoLevelsRBtn) {
        autoLevelsRBtn.addEventListener('click', () => {
            applyAutoLevels(false);
            updateColorAdjustUI();
            refreshAllResetButtons();
            updateHistogramPanelIfVisible();
        }, { signal });
    }

    // ----- Histogram panel controls -----
    const showHistogramPanelBtn = document.getElementById('showHistogramPanelBtn');
    if (showHistogramPanelBtn) {
        showHistogramPanelBtn.addEventListener('click', () => {
            showHistogramPanel();
        }, { signal });
    }

    const closeHistogramPanel = document.getElementById('closeHistogramPanel');
    if (closeHistogramPanel) {
        closeHistogramPanel.addEventListener('click', () => {
            const histogramPanel = document.getElementById('histogram-panel');
            if (histogramPanel) {
                histogramPanel.style.display = 'none';
            }
        }, { signal });
    }

    const histogramChannelPanel = document.getElementById('histogram-channel-panel');
    if (histogramChannelPanel) {
        histogramChannelPanel.addEventListener('change', () => {
            updateHistogramPanel();
        }, { signal });
    }

    const histogramCropOnly = document.getElementById('histogramCropOnly');
    if (histogramCropOnly) {
        histogramCropOnly.addEventListener('change', () => {
            updateHistogramPanel();
        }, { signal });
    }

    // ----- Reset all (image-quality parameters only; keep linkLR state) -----
    const resetColorAdjustBtn = document.getElementById('resetColorAdjustBtn');
    if (resetColorAdjustBtn) {
        resetColorAdjustBtn.addEventListener('click', () => {
            for (const key of QUALITY_PARAM_KEYS) {
                state.params[key] = state.defaultParams[key];
            }
            updateUniforms();
            updateColorAdjustUI();
            refreshAllResetButtons();
            updateHistogramPanelIfVisible();
        }, { signal });
    }

    // Initial UI sync (label text, reset-button enabled state)
    refreshAllResetButtons();
}

/**
 * Copy left-eye quality params to right eye and refresh DOM/uniforms.
 * Used by the linked auto-correction handler.
 */
function mirrorLtoR() {
    for (const def of QUALITY_PARAMS) {
        state.params[`${def.key}R`] = state.params[`${def.key}L`];
    }
    updateUniforms();
}

/**
 * Clean up color adjustment system resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guards)
 */
export function cleanupColorAdjustmentControls() {
    if (colorAdjustmentEventAbortController) {
        colorAdjustmentEventAbortController.abort();
        colorAdjustmentEventAbortController = null;
    }
}
