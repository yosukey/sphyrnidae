/**
 * ui-histogram.js
 * Histogram display and color correction UI features
 */
import { showToast } from './ui-toast.js';
import { state, CONSTANTS } from '../globals.js';
import { calculateHistogram, drawHistogram } from '../core/histogram.js';
import { QUALITY_PARAMS, formatQualityNumberInput } from './ui-color-adjust-config.js';
import * as logger from '../utils/logger.js';

// Debounce timer for histogram updates
let histogramDebounceTimer = null;

/**
 * Run histogram updates with debounce
 * Reduce load during continuous shift slider operations or key holds
 */
export function updateHistogramPanelDebounced() {
    if (histogramDebounceTimer) {
        clearTimeout(histogramDebounceTimer);
    }
    histogramDebounceTimer = setTimeout(() => {
        updateHistogramPanelIfVisible();
        histogramDebounceTimer = null;
    }, CONSTANTS.HISTOGRAM_DEBOUNCE_DELAY);
}

/**
 * Toggle histogram panel visibility
 */
export function showHistogramPanel() {
    const panel = document.getElementById('histogram-panel');
    const statusPanel = document.getElementById('status-panel');

    // Guard against missing DOM elements
    if (!panel) {
        logger.warn('UIHistogram','Histogram panel not found in DOM');
        return;
    }

    // Close if already visible. This must run BEFORE the no-image guard below so a
    // panel left open after the image was cleared (e.g. a failed reload disposed
    // state.material) can still be toggled shut — the guard only blocks OPENING it.
    if (panel.style.display !== 'none') {
        panel.style.display = 'none';
        return;
    }

    // Opening the panel requires a loaded image to build the histogram from.
    if (!state.material || !state.material.uniforms.map.value) {
        showToast(window.t?.('messages.noImageForHistogram') ?? 'No image loaded for histogram', 'warning');
        return;
    }

    // Make panel measurable before clamping its position.
    panel.style.display = 'block';

    // Place below the status panel (if available), clamping so the panel stays
    // inside the viewport even when the status panel is near the bottom edge
    // (e.g. fullscreen / repositioned layouts).
    if (statusPanel) {
        const statusRect = statusPanel.getBoundingClientRect();
        const desiredTop = statusRect.bottom + 10;
        const panelHeight = panel.offsetHeight;
        const maxTop = Math.max(0, window.innerHeight - panelHeight - 10);
        panel.style.top = `${Math.min(desiredTop, maxTop)}px`;
    }

    updateHistogramPanel();
}

/**
 * Update the histogram panel
 */
export function updateHistogramPanel() {
    // Guard against missing material or texture
    if (!state.material?.uniforms?.map?.value) {
        return;
    }

    const texture = state.material.uniforms.map.value;
    const image = texture.image;

    if (!image) {
        logger.warn('UIHistogram','Texture image not available');
        return;
    }

    // Get channel selector (default to 'luminance' if not found).
    // 'all' is not a valid channel for drawHistogram (it expects
    // 'luminance'|'rgb'|'r'|'g'|'b'), so the fallback must be a real channel.
    const channelSelect = document.getElementById('histogram-channel-panel');
    const channel = channelSelect ? channelSelect.value : 'luminance';

    // Get the state of the "crop area only" option
    const cropOnlyCheckbox = document.getElementById('histogramCropOnly');
    const cropOnly = cropOnlyCheckbox ? cropOnlyCheckbox.checked : false;

    // Left-eye histogram
    const histogramL = calculateHistogram(image, true, cropOnly);
    const canvasL = document.getElementById('histogram-canvas-left-panel');
    if (canvasL) {
        drawHistogram(histogramL, canvasL, channel);
    }

    // Right-eye histogram
    const histogramR = calculateHistogram(image, false, cropOnly);
    const canvasR = document.getElementById('histogram-canvas-right-panel');
    if (canvasR) {
        drawHistogram(histogramR, canvasR, channel);
    }
}

/**
 * Update if the histogram panel is visible
 *
 * @description
 * For performance, skip updates when the panel is hidden.
 * This function is called from multiple places:
 * - When parameters change (shiftX/Y, cropX/Y, offsetX/Y, image adjustment parameters)
 * - When images load
 * - When display mode changes
 *
 * @dependencies
 * - updateHistogramPanel() - actual histogram rendering
 * - histogram-panel DOM element
 */
export function updateHistogramPanelIfVisible() {
    const panel = document.getElementById('histogram-panel');
    if (panel && panel.style.display !== 'none') {
        updateHistogramPanel();
    }
}

/**
 * Update slider, number input, link-toggle, and per-parameter reset-button
 * state in the image-quality adjustment UI from state.params.
 *
 * Called after applyAutoLevels, resetColorAdjustmentUI, and other out-of-band
 * state changes to keep the DOM in sync.
 */
export function updateColorAdjustUI() {
    // Sync link toggle + container class
    const linked = !!state.params.linkLR;
    const linkToggle = document.getElementById('linkLRToggle');
    if (linkToggle) {
        linkToggle.checked = linked;
    }
    const content = document.getElementById('image-adjust-content');
    if (content) {
        content.classList.toggle('linked', linked);
        content.classList.toggle('unlinked', !linked);
    }

    // Sync each parameter's slider + number input (both sides)
    for (const def of QUALITY_PARAMS) {
        for (const side of ['L', 'R']) {
            const stateKey = `${def.key}${side}`;
            const value = state.params[stateKey];
            const slider = document.getElementById(`${def.key}${side}`);
            const num = document.getElementById(`${def.key}${side}-num`);
            if (slider) slider.value = String(value);
            if (num && document.activeElement !== num) {
                num.value = formatQualityNumberInput(def, value);
            }
        }

        // Per-parameter reset button enabled state
        const container = document.querySelector(`.quality-param[data-param="${def.key}"]`);
        if (container) {
            const lBtn = container.querySelector('.param-reset-btn[data-reset-side="L"]');
            const rBtn = container.querySelector('.param-reset-btn[data-reset-side="R"]');
            const lDirty = state.params[`${def.key}L`] !== def.default;
            const rDirty = state.params[`${def.key}R`] !== def.default;
            if (lBtn) lBtn.disabled = !(linked ? (lDirty || rDirty) : lDirty);
            if (rBtn) rBtn.disabled = !rDirty;
        }
    }
}

// Expose updateColorAdjustUI globally for use by other modules
// Initialize namespace
if (typeof window !== 'undefined') {
    if (!window.StereoView) {
        window.StereoView = {};
    }
    if (!window.StereoView.ui) {
        window.StereoView.ui = {};
    }
    window.StereoView.ui.updateColorAdjustUI = updateColorAdjustUI;

    // Expose as a direct global in addition to the namespace
    Object.defineProperty(window, 'updateColorAdjustUI', {
        get: () => window.StereoView.ui.updateColorAdjustUI,
        configurable: true
    });
}
