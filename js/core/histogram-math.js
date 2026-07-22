/**
 * histogram-math.js
 * Pure histogram math extracted from histogram.js.
 *
 * This module is intentionally dependency-light: it imports ONLY pure helpers
 * (ensureEven, logger) and must NOT import three, globals.js (state/renderer),
 * the renderer, shaders, or any DOM/WebGL code. Keeping it pure — like
 * alignment-geometry.js and pixel-utils.js — is what allows it to be imported
 * and unit-tested under Node's built-in test runner (see tests/histogram.test.mjs).
 *
 * histogram.js re-exports calculateHistogramStats from here to preserve its
 * public API, and calls the other functions internally.
 */

import { ensureEven } from '../utils/pixel-utils.js';
import * as logger from '../utils/logger.js';

// Cache statistics per histogram.
// Use WeakMap with histogram objects as keys to store stats.
const statsCache = new WeakMap();

/**
 * Common function to build a histogram from pixel data
 * @param {Uint8ClampedArray|Uint8Array} data - Pixel data (RGBA)
 * @param {boolean} skipBlackPixels - Skip black pixels (0,0,0) (default: false)
 * @param {number} originalPixelCount - Original pixel count before downsampling (optional)
 * @returns {Object} Histogram data
 */
export function buildHistogramFromData(data, skipBlackPixels = false, originalPixelCount = null) {
    try {
        // Validate input data (support both Uint8ClampedArray and Uint8Array)
        if (!data || (!(data instanceof Uint8ClampedArray) && !(data instanceof Uint8Array)) || data.length === 0) {
            logger.error('Histogram','[Histogram] Invalid pixel data provided');
            return null;
        }

        // RGBA data must be a whole number of 4-byte pixels. A truncated buffer
        // (length % 4 !== 0) would let the 4-byte-stride scan below read past the
        // end on its last iteration: data[i+1]/data[i+2] become undefined, so
        // histogram.g[undefined]++ / histogram.luminance[NaN]++ write stray
        // non-index (NaN) properties instead of counting a real bin. ImageData is
        // always a multiple of 4, but this is a public, unit-tested utility, so
        // reject malformed lengths explicitly rather than corrupting the result.
        if (data.length % 4 !== 0) {
            logger.error('Histogram','[Histogram] Pixel data length is not a multiple of 4 (RGBA)');
            return null;
        }

        // Initialize histogram (256 bins per channel)
        const histogram = {
            r: new Array(256).fill(0),
            g: new Array(256).fill(0),
            b: new Array(256).fill(0),
            luminance: new Array(256).fill(0),
            originalPixelCount: originalPixelCount || (data.length / 4)
        };

        // Calculate histogram
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            // Optional handling for skipping black pixels
            if (skipBlackPixels && r === 0 && g === 0 && b === 0) continue;

            histogram.r[r]++;
            histogram.g[g]++;
            histogram.b[b]++;

            // Luminance (Rec. 601 standard)
            const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            histogram.luminance[lum]++;
        }

        return histogram;
    } catch (err) {
        logger.error('Histogram','[Histogram] Error building histogram:', err);
        return null;
    }
}

/**
 * Compute statistics from histogram
 * @param {Object} histogram - Histogram data
 * @returns {Object} Statistics (min, max, mean, median)
 */
export function calculateHistogramStats(histogram) {
    const channels = ['r', 'g', 'b', 'luminance'];

    // Guard against null / malformed histogram objects. buildHistogramFromData()
    // returns null on failure, and this function is re-exported as public API
    // (histogram.js), so an invalid histogram must degrade to neutral stats rather
    // than throw. Without this guard, statsCache.set() below rejects a null key and
    // hist.reduce() throws on a missing channel, turning a safely-skippable
    // "calculation failed" into an exception out of the panel-refresh/auto-levels
    // path. Each channel must be a 256-bin array for the fixed-range loops below.
    const isValidHistogram = histogram && typeof histogram === 'object' &&
        channels.every(c => Array.isArray(histogram[c]) && histogram[c].length === 256);
    if (!isValidHistogram) {
        logger.warn('Histogram', '[Histogram] Invalid histogram passed to calculateHistogramStats; returning neutral stats');
        return {
            r: { min: 0, max: 255, mean: 0, median: 0 },
            g: { min: 0, max: 255, mean: 0, median: 0 },
            b: { min: 0, max: 255, mean: 0, median: 0 },
            luminance: { min: 0, max: 255, mean: 0, median: 0 }
        };
    }

    // Check cache (avoid recalculating for the same histogram)
    if (statsCache.has(histogram)) {
        return statsCache.get(histogram);
    }

    const stats = {
        r: { min: 0, max: 255, mean: 0, median: 0 },
        g: { min: 0, max: 255, mean: 0, median: 0 },
        b: { min: 0, max: 255, mean: 0, median: 0 },
        luminance: { min: 0, max: 255, mean: 0, median: 0 }
    };

    for (const channel of channels) {
        const hist = histogram[channel];
        const totalPixels = hist.reduce((sum, count) => sum + count, 0);

        // Find min (cumulative frequency >= 0.1%) - stricter outlier exclusion
        let cumSum = 0;
        let minVal = 0;
        const threshold = totalPixels * 0.001;
        for (let i = 0; i < 256; i++) {
            cumSum += hist[i];
            if (cumSum >= threshold) {
                minVal = i;
                break;
            }
        }

        // Find max (cumulative frequency >= 99.9%) - stricter outlier exclusion
        cumSum = 0;
        let maxVal = 255;
        const upperThreshold = totalPixels * 0.999;
        for (let i = 0; i < 256; i++) {
            cumSum += hist[i];
            if (cumSum >= upperThreshold) {
                maxVal = i;
                break;
            }
        }

        // Calculate mean
        let sum = 0;
        for (let i = 0; i < 256; i++) {
            sum += i * hist[i];
        }
        const mean = totalPixels > 0 ? sum / totalPixels : 0;

        // Calculate median
        cumSum = 0;
        let median = 0;
        const medianThreshold = totalPixels > 0 ? totalPixels / 2 : 0;
        for (let i = 0; i < 256; i++) {
            cumSum += hist[i];
            if (cumSum >= medianThreshold) {
                median = i;
                break;
            }
        }

        stats[channel] = { min: minVal, max: maxVal, mean, median };
    }

    // Save statistics to cache
    statsCache.set(histogram, stats);

    return stats;
}

/**
 * Downsample dimensions to fit within maxSize
 *
 * maxSize is passed in explicitly (rather than read from globals) so this module
 * stays free of the state/three dependency and remains unit-testable.
 * @param {number} width - Source width
 * @param {number} height - Source height
 * @param {number} maxSize - Maximum dimension (e.g. CONSTANTS.MAX_HISTOGRAM_SIZE)
 * @returns {{width: number, height: number}} Downsampled dimensions
 */
export function downsampleForHistogram(width, height, maxSize) {
    if (width > maxSize || height > maxSize) {
        const scale = Math.min(maxSize / width, maxSize / height);
        return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
    }
    return { width, height };
}

/**
 * Compute the even-snapped single-eye dimensions for a given crop ratio.
 *
 * Matches the rounding used for the displayed cropped resolution
 * (renderer.js updateCroppedResolution) and the exported image
 * (ui-export.js): ensureEven(Math.round(size * (1 - crop))). Using this shared
 * helper keeps the histogram's render size and "Pixels:" count consistent with
 * the resolution the user sees and the pixels that are actually exported, rather
 * than plain Math.floor, which can disagree by up to ~2px.
 * @param {number} eyeWidth - Per-eye width in pixels
 * @param {number} eyeHeight - Per-eye height in pixels
 * @param {number} cropX - Horizontal crop fraction [0,1)
 * @param {number} cropY - Vertical crop fraction [0,1)
 * @returns {{width: number, height: number}} Even-snapped cropped dimensions
 */
export function croppedEyeDimensions(eyeWidth, eyeHeight, cropX, cropY) {
    return {
        width: ensureEven(Math.round(eyeWidth * (1 - cropX))),
        height: ensureEven(Math.round(eyeHeight * (1 - cropY)))
    };
}
