/**
 * offlineDetection.js
 * Detect offline state and notify
 */

import * as logger from '../utils/logger.js';

let offlineIndicator = null;
let offlineAbortController = null;
let hideTimerId = null;

/**
 * Initialize offline detection
 * Monitor navigator.onLine events and show notifications when offline
 */
export function initOfflineDetection() {
    logger.debug('OFFLINE_LOG', 'OfflineDetection', 'Initializing offline detection');

    // Clean up any existing listeners
    cleanupOfflineDetection();

    // Create new AbortController for cleanup
    offlineAbortController = new AbortController();
    const signal = offlineAbortController.signal;

    // Check initial state
    if (!navigator.onLine) {
        try {
            showOfflineIndicator();
        } catch (err) {
            logger.error('OfflineDetection', 'Error showing initial offline indicator:', err);
        }
    }

    // Offline/online event listeners
    window.addEventListener('offline', () => {
        try {
            logger.debug('OFFLINE_LOG', 'OfflineDetection', 'Network offline');
            showOfflineIndicator();
        } catch (err) {
            logger.error('OfflineDetection', 'Error handling offline event:', err);
        }
    }, { signal });

    window.addEventListener('online', () => {
        try {
            logger.debug('OFFLINE_LOG', 'OfflineDetection', 'Network online');
            hideOfflineIndicator();
        } catch (err) {
            logger.error('OfflineDetection', 'Error handling online event:', err);
        }
    }, { signal });
}

/**
 * Cleanup offline detection listeners
 * @idempotent Safe to call multiple times (has null guards)
 */
export function cleanupOfflineDetection() {
    if (offlineAbortController) {
        offlineAbortController.abort();
        offlineAbortController = null;
    }
    // Cancel any pending hide animation timer
    if (hideTimerId) {
        clearTimeout(hideTimerId);
        hideTimerId = null;
    }
    hideOfflineIndicator();
    logger.debug('OFFLINE_LOG', 'OfflineDetection', 'Cleaned up offline detection');
}

/**
 * Show offline notification indicator
 * XSS protection: insert text safely using textContent
 */
function showOfflineIndicator() {
    try {
        // Do nothing if already shown
        if (offlineIndicator && document.body.contains(offlineIndicator)) {
            return;
        }

        // Create offline notification element (XSS protection: use DOM API)
        offlineIndicator = document.createElement('div');
        offlineIndicator.className = 'offline-indicator';

        const content = document.createElement('div');
        content.className = 'offline-indicator-content';

        const icon = document.createElement('div');
        icon.className = 'offline-indicator-icon';
        icon.textContent = '📡';

        const textContainer = document.createElement('div');
        textContainer.className = 'offline-indicator-text';

        const title = document.createElement('div');
        title.className = 'offline-indicator-title';
        title.textContent = window.t?.('offline.title') ?? 'Offline';

        const message = document.createElement('div');
        message.className = 'offline-indicator-message';
        message.textContent = window.t?.('offline.message') ?? 'You are not connected to the network. Running with cached content.';

        textContainer.appendChild(title);
        textContainer.appendChild(message);
        content.appendChild(icon);
        content.appendChild(textContainer);
        offlineIndicator.appendChild(content);

        // Append indicator to body
        document.body.appendChild(offlineIndicator);

        // Fade-in animation
        requestAnimationFrame(() => {
            if (offlineIndicator) {
                offlineIndicator.classList.add('show');
            }
        });

        logger.debug('OFFLINE_LOG', 'OfflineDetection', 'Offline indicator shown');
    } catch (err) {
        logger.error('OfflineDetection', 'Error creating offline indicator:', err);
        offlineIndicator = null;
    }
}

/**
 * Hide offline notification indicator
 */
function hideOfflineIndicator() {
    try {
        if (!offlineIndicator) return;

        // Capture reference and clear immediately to prevent race conditions
        // (showOfflineIndicator checks offlineIndicator before creating a new one)
        const indicator = offlineIndicator;
        offlineIndicator = null;

        // Fade-out animation
        indicator.classList.remove('show');

        // Remove from DOM after animation completes (track timer for cleanup)
        hideTimerId = setTimeout(() => {
            hideTimerId = null;
            try {
                if (indicator && document.body.contains(indicator)) {
                    document.body.removeChild(indicator);
                }
            } catch (err) {
                logger.error('OfflineDetection', 'Error removing offline indicator from DOM:', err);
            }
        }, 300);

        logger.debug('OFFLINE_LOG', 'OfflineDetection', 'Offline indicator hidden');
    } catch (err) {
        logger.error('OfflineDetection', 'Error hiding offline indicator:', err);
        offlineIndicator = null;
    }
}
