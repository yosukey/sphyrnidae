/**
 * ui-color-adjust-config.js
 * Single source of truth for image-quality parameter metadata.
 * Consumed by:
 *  - ui-color-adjustments.js (event wiring, clamping, reset)
 *  - ui-histogram.js (display formatting, UI sync)
 *  - loader-state.js (reset on image load)
 *
 * Each key corresponds to two state.params entries: `${key}L` and `${key}R`.
 * Keep defaults here in sync with js/globals.js defaultParams for the matching L/R keys.
 */

export const QUALITY_PARAMS = [
    {
        key: 'brightness',
        section: 'color',
        min: -1.0,
        max: 1.0,
        step: 0.01,
        default: 0.0,
        i18n: 'controls.brightness',
        format: (v) => v.toFixed(2)
    },
    {
        key: 'contrast',
        section: 'color',
        min: 0.0,
        max: 2.0,
        step: 0.01,
        default: 1.0,
        i18n: 'controls.contrast',
        format: (v) => v.toFixed(2)
    },
    {
        key: 'saturation',
        section: 'color',
        min: 0.0,
        max: 2.0,
        step: 0.01,
        default: 1.0,
        i18n: 'controls.saturation',
        format: (v) => v.toFixed(2)
    },
    {
        key: 'hue',
        section: 'color',
        min: -180,
        max: 180,
        step: 1,
        default: 0,
        i18n: 'controls.hue',
        format: (v) => `${Math.round(v)}°`
    },
    {
        key: 'sharpness',
        section: 'filter',
        min: 0.0,
        max: 2.0,
        step: 0.01,
        default: 0.0,
        i18n: 'controls.sharpness',
        format: (v) => v.toFixed(2)
    },
    {
        key: 'noiseReduction',
        section: 'filter',
        min: 0.0,
        max: 1.0,
        step: 0.01,
        default: 0.0,
        i18n: 'controls.noiseReduction',
        format: (v) => v.toFixed(2)
    }
];

/**
 * All 12 state.params keys (L + R) for the quality adjustments.
 */
export const QUALITY_PARAM_KEYS = QUALITY_PARAMS.flatMap(p => [`${p.key}L`, `${p.key}R`]);

/**
 * Lookup a param definition by its base key.
 */
export function getQualityParam(key) {
    return QUALITY_PARAMS.find(p => p.key === key) || null;
}

/**
 * Format a value for the <input type="number"> display field.
 * Integer-step params (e.g. hue) show integers; others show 2 decimals so
 * trailing zeros stay visible (e.g. 0.50, not 0.5).
 *
 * Single source of truth shared by ui-color-adjustments.js (slider/number
 * wiring) and ui-histogram.js (updateColorAdjustUI) so the two never drift.
 */
export function formatQualityNumberInput(def, value) {
    if (def.step >= 1) {
        return String(Math.round(value));
    }
    return value.toFixed(2);
}

/**
 * Clamp a raw value into the parameter's valid range.
 * Returns null when the value is not a finite number (caller should revert to previous).
 */
export function clampParamValue(key, rawValue) {
    const def = getQualityParam(key);
    if (!def) return null;
    const n = typeof rawValue === 'number' ? rawValue : parseFloat(rawValue);
    if (!Number.isFinite(n)) return null;
    return Math.min(def.max, Math.max(def.min, n));
}
