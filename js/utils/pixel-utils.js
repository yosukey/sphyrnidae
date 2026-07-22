/**
 * pixel-utils.js
 * Even-pixel size utility
 *
 * Utilities to ensure single-eye width/height are even in stereo image processing
 * Provides helper functions.
 */

import * as logger from './logger.js';

/**
 * Adjust value to even (floor)
 *
 * IMPORTANT: This function is duplicated in js/workers/shared-utils.js for Web Worker compatibility.
 * If you modify this function, ensure the implementation in shared-utils.js stays synchronized.
 *
 * @param {number} value - Value to adjust
 * @returns {number} Adjusted even value (minimum 2)
 */
export function ensureEven(value) {
    // Handle NaN, Infinity, undefined, null
    if (!Number.isFinite(value)) {
        logger.warn('PixelUtils','ensureEven received non-finite value:', value);
        return 2;
    }
    const intVal = Math.floor(value);
    if (intVal <= 1) return 2;
    return intVal % 2 === 0 ? intVal : intVal - 1;
}

/**
 * Adjust value to even (ceil)
 * @param {number} value - Value to adjust
 * @returns {number} Adjusted even value (minimum 2)
 */
export function ensureEvenCeil(value) {
    // Handle NaN, Infinity, undefined, null
    if (!Number.isFinite(value)) {
        logger.warn('PixelUtils','ensureEvenCeil received non-finite value:', value);
        return 2;
    }
    const intVal = Math.ceil(value);
    if (intVal <= 0) return 2;
    return intVal % 2 === 0 ? intVal : intVal + 1;
}

/**
 * Check whether image size is even
 * @param {number} width - Width
 * @param {number} height - Height
 * @returns {boolean} True if both are even
 */
export function isEvenDimensions(width, height) {
    return width % 2 === 0 && height % 2 === 0;
}

/**
 * Adjust crop ratio to yield even pixels
 * Adjust crop ratio so the post-crop size is even
 * @param {number} cropRatio - Crop ratio (0-1), 1.0 removes all, 0.0 removes none
 * @param {number} originalSize - Original size (pixels)
 * @returns {number} Adjusted crop ratio
 */
export function adjustCropRatioForEven(cropRatio, originalSize) {
    // Calculate post-crop size
    const croppedSize = Math.floor(originalSize * (1.0 - cropRatio));
    // Adjust to even
    const evenCroppedSize = ensureEven(croppedSize);
    // Calculate adjusted crop ratio
    return 1.0 - (evenCroppedSize / originalSize);
}

/**
 * Pixel validation for SBS images
 * @param {number} width - Combined image width
 * @param {number} height - Combined image height
 * @returns {Object} Validation result { isValid, issues, correction }
 */
export function validateSBSPixels(width, height) {
    const issues = [];
    const correction = { trimRight: 0, trimBottom: 0 };

    // Combined width is odd → 1-pixel difference between sides
    if (width % 2 !== 0) {
        issues.push({
            type: 'sbs_odd_width',
            severity: 'error',
            width: width
        });
        correction.trimRight = 1;
    }

    // Single-eye width (half of combined) is odd
    const eyeWidth = Math.floor(width / 2);
    if (eyeWidth % 2 !== 0) {
        issues.push({
            type: 'eye_odd_width',
            severity: 'warning',
            eyeWidth: eyeWidth
        });
        // For both the combined width AND each eye width to be even, the combined
        // width must be a multiple of 4. Trimming a fixed 2px is insufficient when
        // width % 4 === 3 (e.g. 1923 → 1921 is still odd), so trim down to the
        // nearest multiple of 4. (When eyeWidth is odd, width % 4 is always 2 or 3.)
        correction.trimRight = Math.max(correction.trimRight, width % 4);
    }

    // Height is odd
    if (height % 2 !== 0) {
        issues.push({
            type: 'odd_height',
            severity: 'warning',
            height: height
        });
        correction.trimBottom = 1;
    }

    return {
        isValid: issues.filter(i => i.severity === 'error').length === 0,
        issues,
        correction
    };
}

/**
 * Pixel validation for TaB images
 * @param {number} width - Combined image width
 * @param {number} height - Combined image height
 * @returns {Object} Validation result { isValid, issues, correction }
 */
export function validateTaBPixels(width, height) {
    const issues = [];
    const correction = { trimRight: 0, trimBottom: 0 };

    // Combined height is odd → 1-pixel difference between top/bottom
    if (height % 2 !== 0) {
        issues.push({
            type: 'tab_odd_height',
            severity: 'error',
            height: height
        });
        correction.trimBottom = 1;
    }

    // Single-eye height (half of combined) is odd
    const eyeHeight = Math.floor(height / 2);
    if (eyeHeight % 2 !== 0) {
        issues.push({
            type: 'eye_odd_height',
            severity: 'warning',
            eyeHeight: eyeHeight
        });
        // For both the combined height AND each eye height to be even, the combined
        // height must be a multiple of 4. Trimming a fixed 2px is insufficient when
        // height % 4 === 3, so trim down to the nearest multiple of 4.
        // (When eyeHeight is odd, height % 4 is always 2 or 3.)
        correction.trimBottom = Math.max(correction.trimBottom, height % 4);
    }

    // Width is odd
    if (width % 2 !== 0) {
        issues.push({
            type: 'odd_width',
            severity: 'warning',
            width: width
        });
        correction.trimRight = 1;
    }

    return {
        isValid: issues.filter(i => i.severity === 'error').length === 0,
        issues,
        correction
    };
}

/**
 * Pixel validation for single-eye images
 * @param {number} width - Single-eye image width
 * @param {number} height - Single-eye image height
 * @returns {Object} Validation result { isValid, issues, correction }
 */
export function validateEyePixels(width, height) {
    const issues = [];
    const correction = { trimRight: 0, trimBottom: 0 };

    if (width % 2 !== 0) {
        issues.push({
            type: 'eye_odd_width',
            severity: 'warning',
            width: width
        });
        correction.trimRight = 1;
    }

    if (height % 2 !== 0) {
        issues.push({
            type: 'eye_odd_height',
            severity: 'warning',
            height: height
        });
        correction.trimBottom = 1;
    }

    return {
        isValid: issues.length === 0,
        issues,
        correction
    };
}

/**
 * Pixel validation for horizontal interlaced images.
 * Only the row count needs to be even: unlike TaB, rows are not split into
 * two independently renderable images, so a multiple of four is unnecessary.
 * @param {number} width - Combined image width
 * @param {number} height - Combined image height
 * @returns {Object} Validation result { isValid, issues, correction }
 */
export function validateInterlaceHPixels(width, height) {
    const issues = [];
    const correction = { trimRight: 0, trimBottom: 0 };

    if (height % 2 !== 0) {
        issues.push({
            type: 'interlace_odd_height',
            severity: 'error',
            height
        });
        correction.trimBottom = 1;
    }

    return { isValid: issues.length === 0, issues, correction };
}

/**
 * Pixel validation for vertical interlaced images.
 * Only the column count needs to be even: unlike SBS, columns are not split
 * into two independently renderable images, so a multiple of four is unnecessary.
 * @param {number} width - Combined image width
 * @param {number} height - Combined image height
 * @returns {Object} Validation result { isValid, issues, correction }
 */
export function validateInterlaceVPixels(width, height) {
    const issues = [];
    const correction = { trimRight: 0, trimBottom: 0 };

    if (width % 2 !== 0) {
        issues.push({
            type: 'interlace_odd_width',
            severity: 'error',
            width
        });
        correction.trimRight = 1;
    }

    return { isValid: issues.length === 0, issues, correction };
}

/**
 * Run pixel validation based on format
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {string} format - Format ('full_sbs', 'half_sbs', 'full_tab', 'half_tab', etc.)
 * @returns {Object} Validation result { isValid, issues, correction }
 */
export function validatePixelsForFormat(width, height, format) {
    switch (format) {
        case 'full_sbs':
        case 'half_sbs':
            return validateSBSPixels(width, height);

        case 'full_tab':
        case 'half_tab':
            return validateTaBPixels(width, height);

        case 'interlace_h':
            // Horizontal interlace: height must be even (separate odd/even rows)
            return validateInterlaceHPixels(width, height);

        case 'interlace_v':
            // Vertical interlace: width must be even (separate odd/even columns)
            return validateInterlaceVPixels(width, height);

        default:
            // No validation needed
            return { isValid: true, issues: [], correction: { trimRight: 0, trimBottom: 0 } };
    }
}

/**
 * Trim image to even pixels
 * @param {HTMLCanvasElement|ImageBitmap} image - Original image
 * @param {number} trimRight - Pixels to trim from the right
 * @param {number} trimBottom - Pixels to trim from the bottom
 * @returns {HTMLCanvasElement} Trimmed canvas
 */
export function trimToEvenPixels(image, trimRight, trimBottom) {
    const srcWidth = image.width;
    const srcHeight = image.height;

    const newWidth = srcWidth - trimRight;
    const newHeight = srcHeight - trimBottom;

    const canvas = document.createElement('canvas');
    canvas.width = newWidth;
    canvas.height = newHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        logger.error('PixelUtils', 'Failed to get 2D context for trimToEvenPixels');
        return canvas;
    }
    ctx.drawImage(image, 0, 0, newWidth, newHeight, 0, 0, newWidth, newHeight);

    return canvas;
}
