/**
 * shared-utils.js
 * Shared utility functions and constants for Web Workers
 *
 * Usage:
 * - In a worker: import { ensureEven, WORKER_CONSTANTS } from './shared-utils.js'
 * - In the main thread: import { ensureEven } from '../utils/pixel-utils.js'
 *
 * Note: This file provides worker-only functions and constants.
 * In the main thread, use the ES module version in pixel-utils.js and constants from globals.js.
 */

/**
 * Worker constants (synced with globals.js CONSTANTS)
 */
export const WORKER_CONSTANTS = {
    // MPO processing related
    MPO_MAX_SCAN_LENGTH: 10 * 1024 * 1024,  // Max MPO scan length (10MB)
    MPO_MAX_JPEG_COUNT: 20,                 // Max JPEGs to extract from MPO
    MPO_MIN_JPEG_SIZE: 4096                 // Min JPEG size in MPO (bytes)
};

/**
 * Adjust a value to an even integer (flooring)
 *
 * IMPORTANT: This is a duplicate of the canonical implementation in js/utils/pixel-utils.js.
 * Web Workers cannot import from the main thread's ES modules, so this duplication is required.
 * Both copies MUST stay identical — search for "ensureEven" across both files when editing.
 *
 * @param {number} value - Value to adjust
 * @returns {number} Even value (minimum 2)
 */
export function ensureEven(value) {
    // Handle NaN, Infinity, undefined, null
    if (!Number.isFinite(value)) {
        console.warn('ensureEven received non-finite value:', value);
        return 2;
    }
    const intVal = Math.floor(value);
    if (intVal <= 1) return 2;
    return intVal % 2 === 0 ? intVal : intVal - 1;
}
