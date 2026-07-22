/**
 * logger.js
 * Centralized logging utility for consistent console output
 * Provides debug mode controls and structured logging
 */

import { DEBUG } from '../globals.js';

/**
 * Log levels:
 * - ERROR: Always logged - critical errors that prevent functionality
 * - WARN: Always logged - non-critical issues, fallbacks, resource warnings
 * - INFO: Logged in normal mode - important lifecycle events
 * - DEBUG: Only when specific DEBUG flag is enabled - detailed debugging information
 * - AUDIT: Only when AUDIT_LOG is enabled - complete action lifecycle tracking
 */

/**
 * Log error - always output (critical errors)
 * @param {string} category - Module name
 * @param {string} message - Error message
 * @param {...any} data - Additional error data
 */
export function error(category, message, ...data) {
    console.error(`[${category}]`, message, ...data);
}

/**
 * Log warning - always output (non-critical issues, fallbacks)
 * @param {string} category - Module name
 * @param {string} message - Warning message
 * @param {...any} data - Additional warning data
 */
export function warn(category, message, ...data) {
    console.warn(`[${category}]`, message, ...data);
}

/**
 * Log info - output in normal mode (important events)
 * @param {string} category - Module name
 * @param {string} message - Info message
 * @param {...any} data - Additional info data
 */
export function info(category, message, ...data) {
    console.info(`[${category}]`, message, ...data);
}

/**
 * Log debug - only output when specific DEBUG flag is enabled
 * @param {string} debugFlag - DEBUG flag to check (e.g., 'LOADER_LOG', 'RENDER_VALIDATION_LOG')
 * @param {string} category - Module name
 * @param {string} message - Debug message
 * @param {...any} data - Additional debug data
 */
export function debug(debugFlag, category, message, ...data) {
    if (DEBUG[debugFlag]) {
        console.log(`[${category}]`, message, ...data);
    }
}

/**
 * Log audit trail - only output when AUDIT_LOG is enabled
 * @param {string} category - Module name
 * @param {string} message - Audit message
 * @param {...any} data - Additional audit data
 */
export function audit(category, message, ...data) {
    if (DEBUG.AUDIT_LOG) {
        console.log(`[${category}]`, message, ...data);
    }
}

/**
 * Log EXIF-related information - only when EXIF_LOG is enabled
 * @param {string} message - EXIF log message
 * @param {...any} data - Additional EXIF data
 */
export function exif(message, ...data) {
    if (DEBUG.EXIF_LOG) {
        console.log('[EXIF]', message, ...data);
    }
}

/**
 * Create a logger instance for a specific module
 * Provides convenience methods with pre-bound category
 * @param {string} category - Module/component name
 * @returns {Object} - Logger instance with bound methods
 */
export function createLogger(category) {
    return {
        error: (message, ...data) => error(category, message, ...data),
        warn: (message, ...data) => warn(category, message, ...data),
        info: (message, ...data) => info(category, message, ...data),
        debug: (debugFlag, message, ...data) => debug(debugFlag, category, message, ...data),
        audit: (message, ...data) => audit(category, message, ...data)
    };
}
