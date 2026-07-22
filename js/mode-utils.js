/**
 * mode-utils.js
 *
 * Centralized management for mode classification logic
 *
 * This module aggregates all mode-related definitions and helper functions
 * to keep mode logic from being scattered across the codebase.
 */

/**
 * Mapping from mode names to mode numbers
 * Convert mode names from URL parameters to internal mode numbers
 */
export const MODE_NAME_MAP = {
    // Anaglyph types
    'anaglyph': 0,
    'anaglyph_color': 0,
    'anaglyph_gray': 11,
    'anaglyph_blue_yellow': 14,
    'anaglyph_dubois': 15,
    // Interlace types
    'interlace_h': 1,
    'interlace_v': 2,
    // SBS types
    'half_sbs': 7,
    'parallel': 8,
    'cross': 9,
    // TaB types
    'tab': 10,
    'full_tab': 16,
    // Others
    'left_only': 4,
    'right_only': 5,
    'wiggle': 6,
    'lrl': 12,
    'matrix_2x2': 13
};

/**
 * File name suffixes for each mode
 * Appended to file names when saving
 */
export const modeSuffixes = {
    0: "_anaglyph_color",
    1: "_interlace_h",
    2: "_interlace_v",
    3: "_sbs_raw",
    4: "_left_only",
    5: "_right_only",
    6: "_wiggle",
    7: "_half_sbs",
    8: "_parallel",
    9: "_cross",
    10: "_tab",
    11: "_anaglyph_gray",
    12: "_lrl",
    13: "_matrix_2x2",
    14: "_anaglyph_blue_yellow",
    15: "_anaglyph_dubois",
    16: "_full_tab"
};

/**
 * Get the mode name from a mode number
 * @param {number} mode - Mode number
 * @returns {string|null} Mode name (null if not found)
 */
export function getModeName(mode) {
    for (const [name, num] of Object.entries(MODE_NAME_MAP)) {
        if (num === mode) return name;
    }
    return null;
}

/**
 * Get the mode number from a mode name
 * @param {string} modeName - Mode name
 * @returns {number|null} Mode number (null if not found)
 */
export function getModeByName(modeName) {
    if (!modeName) return null;
    const name = modeName.toLowerCase();
    // Only match own keys so inherited Object.prototype names
    // (e.g. 'constructor', '__proto__') don't return junk instead of null.
    if (!Object.prototype.hasOwnProperty.call(MODE_NAME_MAP, name)) return null;
    return MODE_NAME_MAP[name];
}

/**
 * Get layout information for a mode
 *
 * wMul/hMul: output frame multiplier relative to a single eye (eyeWidth/eyeHeight)
 * - Full SBS: wMul=2, hMul=1
 * - Half SBS: wMul=1, hMul=1 (compress left/right halves into one frame)
 * - LRL: wMul=3, hMul=1
 * - Half TaB: wMul=1, hMul=1 (compress top/bottom halves into one frame)
 * - Matrix 2x2: wMul=2, hMul=2
 *
 * @param {number} mode - Mode number
 * @returns {{wMul: number, hMul: number}} Layout multipliers
 */
export function getModeLayout(mode) {
    switch (mode) {
        case 3:  // Raw SBS (not exposed in the UI; layout kept for internal use)
        case 8:  // Parallel
        case 9:  // Cross
            return { wMul: 2, hMul: 1 };
        case 7:  // Half SBS (compress left/right halves within one frame)
        case 10: // Half Top-and-Bottom (compress top/bottom halves within one frame)
            return { wMul: 1, hMul: 1 };
        case 12: // LRL
            return { wMul: 3, hMul: 1 };
        case 13: // Matrix 2x2
            return { wMul: 2, hMul: 2 };
        case 16: // Full Top-and-Bottom (stacked vertically, no compression)
            return { wMul: 1, hMul: 2 };
        default:
            // Anaglyph / Interlace / 2D / Wiggle / Gray etc.
            return { wMul: 1, hMul: 1 };
    }
}

/**
 * Check if the mode is SBS-style (left/right)
 *
 * Used by viewer mode to allow independent zoom/pan per eye.
 *
 * Modes covered:
 * - Raw SBS (3): not exposed in the UI
 * - Half SBS (7): compress left/right halves
 * - Parallel (8): parallel view, full size
 * - Cross (9): cross view, full size
 * - LRL (12): left-right-left triplet
 * - Matrix 2x2 (13): 2x2 matrix layout
 *
 * Note: modes 12 and 13 are left/right layouts but are excluded from
 * is3DTVModeApplicable() because they cannot be fed directly to stereo displays.
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is SBS-style
 */
const sbsModes = new Set([3, 7, 8, 9, 12, 13]);
export function isSBSMode(mode) {
    return sbsModes.has(mode);
}

/**
 * Check if the mode is TaB-style (top/bottom)
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is TaB-style
 */
export function isTaBMode(mode) {
    return mode === 10 || mode === 16;
}

/**
 * Check if the mode is applicable for 3DTV input
 *
 * Only applied when the sbs3dtv parameter is enabled.
 *
 * Modes covered:
 * - Half SBS (7): half-width compression, 3DTV expands to full width
 * - Parallel (8): parallel view, full size
 * - Cross (9): cross view, full size
 * - Half TaB (10): half-height compression, 3DTV expands to full height
 * - Full TaB (16): full-height top/bottom
 *
 * Note: modes 12 (LRL) and 13 (Matrix 2x2) are left/right layouts but are excluded
 * because they cannot be input directly into stereo displays.
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is 3DTV applicable
 */
const dtvApplicableModes = new Set([7, 8, 9, 10, 16]);
export function is3DTVModeApplicable(mode) {
    return dtvApplicableModes.has(mode);
}

/**
 * Check if the mode shows a single eye
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is single-eye
 */
export function isSingleEyeMode(mode) {
    return mode === 4 || mode === 5;
}

/**
 * Check if the mode is full-size SBS
 * SBS modes with full-size left/right
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is full-size SBS
 */
export function isFullSBSMode(mode) {
    return mode === 3 || mode === 8 || mode === 9;
}

/**
 * Check if rectangular crop selection is allowed
 * Only valid for anaglyph (0, 11, 14, 15) and interlace (1, 2) modes
 * Not available for SBS or right-eye-only display modes
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether crop selection is allowed
 */
const cropAllowedModes = new Set([0, 1, 2, 11, 14, 15]);
export function isCropSelectionAllowed(mode) {
    return cropAllowedModes.has(mode);
}

/**
 * Check if the mode is wiggle
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is wiggle
 */
export function isWiggleMode(mode) {
    return mode === 6;
}

/**
 * Check if the mode is anaglyph
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is anaglyph
 */
const anaglyphModes = new Set([0, 11, 14, 15]);
export function isAnaglyphMode(mode) {
    return anaglyphModes.has(mode);
}

/**
 * Check if the mode is interlace
 *
 * @param {number} mode - Mode number
 * @returns {boolean} Whether the mode is interlace
 */
export function isInterlaceMode(mode) {
    return mode === 1 || mode === 2;
}
