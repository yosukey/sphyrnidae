/**
 * url-params.js
 * Shared value-level validators for stereo-image URL parameters
 * (mode / format / x / y).
 *
 * Two entry points feed these: the single-image ?src query parser
 * (checkUrlParametersAndLoadImage in main.js) and the URL-list per-line option
 * parser (parseUrlOptions in ui-viewer.js). Their tokenization differs
 * (URLSearchParams vs. whitespace-separated key=value tokens), so only the
 * per-value validation/clamping is centralized here. This keeps both paths in
 * lockstep — e.g. x/y are clamped to ±MAX_SHIFT_PX in both, and format is
 * case-normalized in both.
 */
import { CONSTANTS } from './globals.js';
import { getModeByName } from './mode-utils.js';
import { clampCropWindow } from './rendering/alignment-geometry.js';

/**
 * Valid stereo format values accepted by ?format= and `format=` list tokens.
 * Single source of truth for both parsers.
 */
export const VALID_STEREO_FORMATS = Object.freeze([
    'full_sbs', 'half_sbs', 'full_tab', 'half_tab', 'interlace_h', 'interlace_v'
]);

const VALID_FORMAT_SET = new Set(VALID_STEREO_FORMATS);

/**
 * Validate a stereo-format parameter value.
 * @param {string} value - Raw format value
 * @returns {string|null} Normalized (lowercased) format, or null if invalid
 */
export function parseFormatParam(value) {
    if (typeof value !== 'string') return null;
    const lower = value.toLowerCase().trim();
    return VALID_FORMAT_SET.has(lower) ? lower : null;
}

/**
 * Validate a display-mode parameter value. Only mode *names* are accepted
 * (numeric values are rejected), matching MODE_NAME_MAP.
 * @param {string} value - Raw mode value
 * @returns {number|null} Mode number, or null if invalid
 */
export function parseModeParam(value) {
    if (typeof value !== 'string') return null;
    const lower = value.toLowerCase().trim();
    // Whitelist characters before lookup (defense-in-depth for any logging of
    // the raw value). The mode lookup itself is already a fixed whitelist.
    if (!/^[a-z0-9_-]+$/.test(lower)) return null;
    return getModeByName(lower);
}

/**
 * Parse and clamp a pixel-shift parameter (x / y).
 * Uses Number() (not parseFloat) so '10abc' is rejected as NaN rather than
 * silently truncated to 10. Out-of-range magnitudes are clamped to
 * ±MAX_SHIFT_PX (the maximum plausible stereo shift).
 * @param {string|number} value - Raw shift value
 * @returns {{value: number, clamped: boolean}|null} Parsed result, or null if
 *   the value is not a finite number
 */
export function parseShiftParam(value) {
    // Reject empty/whitespace explicitly: Number('') and Number(' ') are 0 (not
    // NaN), which would let a blank field (e.g. "?x=") apply as an explicit 0 and
    // be logged as a valid parameter instead of being ignored as absent. Mirrors
    // the empty-field guard in parseCropParam.
    if (typeof value === 'string' && value.trim() === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const max = CONSTANTS.MAX_SHIFT_PX;
    if (Math.abs(num) > max) {
        return { value: Math.sign(num) * max, clamped: true };
    }
    return { value: num, clamped: false };
}

/**
 * Parse and clamp a rotation parameter (r, in degrees). This is the roll term of
 * the vertical-affine alignment (rotation/zoom geometric refinement); it maps to
 * the alignTransform u-gradient via rotZoomToAlignTransform. Uses Number() (not
 * parseFloat) so '2abc' is rejected. Out-of-range magnitudes are clamped to
 * ±MAX_ROTATION_DEG.
 * @param {string|number} value - Raw rotation value
 * @returns {{value: number, clamped: boolean}|null} Parsed result, or null if the
 *   value is not a finite number
 */
export function parseRotationParam(value) {
    // Reject empty/whitespace explicitly: Number('') and Number(' ') are 0 (not
    // NaN), which would let a blank field (e.g. "?x=") apply as an explicit 0 and
    // be logged as a valid parameter instead of being ignored as absent. Mirrors
    // the empty-field guard in parseCropParam.
    if (typeof value === 'string' && value.trim() === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const max = CONSTANTS.MAX_ROTATION_DEG;
    if (Math.abs(num) > max) {
        return { value: Math.sign(num) * max, clamped: true };
    }
    return { value: num, clamped: false };
}

/**
 * Parse and clamp a zoom parameter (z, in percent). This is the vertical-zoom
 * term of the vertical-affine alignment; it maps to the alignTransform v-gradient
 * via rotZoomToAlignTransform. Out-of-range magnitudes are clamped to
 * ±MAX_ZOOM_PCT (which keeps m11 = 1 - e well away from zero).
 * @param {string|number} value - Raw zoom value
 * @returns {{value: number, clamped: boolean}|null} Parsed result, or null if the
 *   value is not a finite number
 */
export function parseZoomParam(value) {
    // Reject empty/whitespace explicitly: Number('') and Number(' ') are 0 (not
    // NaN), which would let a blank field (e.g. "?x=") apply as an explicit 0 and
    // be logged as a valid parameter instead of being ignored as absent. Mirrors
    // the empty-field guard in parseCropParam.
    if (typeof value === 'string' && value.trim() === '') return null;
    const num = Number(value);
    if (!Number.isFinite(num)) return null;
    const max = CONSTANTS.MAX_ZOOM_PCT;
    if (Math.abs(num) > max) {
        return { value: Math.sign(num) * max, clamped: true };
    }
    return { value: num, clamped: false };
}

/**
 * Parse and clamp a crop-window parameter. The value is four comma-separated
 * normalized numbers `cropX,cropY,offsetX,offsetY` (the shader's resolution-
 * independent crop uniforms). Ranges are enforced by clampCropWindow. Uses
 * Number() per field so 'x' or a trailing token is rejected as NaN.
 * @param {string} value - Raw crop value, e.g. "0.12,0.08,-0.03,0.01"
 * @returns {{cropX:number, cropY:number, offsetX:number, offsetY:number, clamped:boolean}|null}
 *   Parsed/clamped window, or null if the value is not exactly four finite numbers.
 */
export function parseCropParam(value) {
    if (typeof value !== 'string') return null;
    const fields = value.split(',').map(f => f.trim());
    if (fields.length !== 4) return null;
    // Reject empty fields explicitly: Number('') is 0 (not NaN), which would let a
    // malformed tuple like "0.1,,0.3,0.4" silently parse the gap as 0.
    if (fields.some(f => f === '')) return null;
    const [cropX, cropY, offsetX, offsetY] = fields.map(Number);
    return clampCropWindow(cropX, cropY, offsetX, offsetY, CONSTANTS.MAX_CROP_RATIO);
}
