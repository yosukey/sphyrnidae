/**
 * ui-toast.js
 * Non-blocking toast notification system
 */

// Container for toast notifications
let toastContainer = null;

// Active toasts tracking
const activeToasts = new Set();

// Auto-dismiss timer IDs (toast element → timeoutId)
const autoDismissTimers = new WeakMap();

// Maximum number of toasts to display simultaneously
const MAX_TOASTS = 5;

/**
 * Initialize toast container
 */
function initToastContainer() {
    if (toastContainer) return;

    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - Toast type: 'info', 'warning', 'error', 'success'
 * @param {number} duration - Duration in milliseconds (0 = no auto-dismiss)
 * @returns {HTMLElement} The toast element
 */
export function showToast(message, type = 'info', duration = 5000) {
    // Ensure container exists
    if (!toastContainer) {
        initToastContainer();
    }

    // Limit the number of toasts
    if (activeToasts.size >= MAX_TOASTS) {
        // Remove the oldest toast
        const oldestToast = activeToasts.values().next().value;
        if (oldestToast) {
            removeToast(oldestToast);
        }
    }

    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    // Announce to assistive technology. Without a live-region role these toasts —
    // including every error notification (CORS/save/quota failures) — are silent to
    // screen-reader users and then auto-dismiss. Errors/warnings interrupt
    // (assertive); info/success wait for a pause (polite). aria-atomic makes the
    // whole message read as one unit when it is inserted.
    const isUrgent = (type === 'error' || type === 'warning');
    toast.setAttribute('role', isUrgent ? 'alert' : 'status');
    toast.setAttribute('aria-live', isUrgent ? 'assertive' : 'polite');
    toast.setAttribute('aria-atomic', 'true');

    // Icon based on type
    const icon = getIconForType(type);

    // Message content
    const messageEl = document.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'toast-close';
    closeBtn.textContent = '\u00D7';
    closeBtn.setAttribute('aria-label', window.t?.('buttons.close') ?? 'Close');
    closeBtn.addEventListener('click', () => removeToast(toast));

    // Assemble toast
    if (icon) {
        const iconEl = document.createElement('span');
        iconEl.className = 'toast-icon';
        iconEl.textContent = icon;
        // Decorative glyph — hide from AT so aria-atomic reads only the message.
        iconEl.setAttribute('aria-hidden', 'true');
        toast.appendChild(iconEl);
    }
    toast.appendChild(messageEl);
    toast.appendChild(closeBtn);

    // Add to container
    toastContainer.appendChild(toast);
    activeToasts.add(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('toast-show');
    });

    // Auto-dismiss after duration (tracked so manual close can cancel)
    if (duration > 0) {
        const timerId = setTimeout(() => {
            autoDismissTimers.delete(toast);
            removeToast(toast);
        }, duration);
        autoDismissTimers.set(toast, timerId);
    }

    return toast;
}

/**
 * Remove a toast notification
 * @param {HTMLElement} toast - Toast element to remove
 */
function removeToast(toast) {
    // Use set membership as the idempotency guard so a toast is processed only
    // once even if both the auto-dismiss timer and a manual close fire.
    if (!toast || !activeToasts.has(toast)) return;

    // Remove from the active set synchronously (not after the 300ms fade-out)
    // so the MAX_TOASTS cap and oldest-toast eviction only ever count toasts
    // that are still active. Otherwise a burst of toasts repeatedly picks the
    // same already-dismissing toast and the visible count exceeds MAX_TOASTS.
    activeToasts.delete(toast);

    // Cancel pending auto-dismiss timer to prevent double removal
    const timerId = autoDismissTimers.get(toast);
    if (timerId) {
        clearTimeout(timerId);
        autoDismissTimers.delete(toast);
    }

    // Fade out
    toast.classList.remove('toast-show');
    toast.classList.add('toast-hide');

    // Remove from DOM after animation
    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 300);
}

/**
 * Get icon HTML for toast type
 * @param {string} type - Toast type
 * @returns {string} Icon HTML
 */
function getIconForType(type) {
    switch (type) {
        case 'success':
            return '✓';
        case 'warning':
            return '⚠';
        case 'error':
            return '✕';
        case 'info':
        default:
            return 'ℹ';
    }
}

/**
 * Clear all active toasts
 */
export function clearAllToasts() {
    const toasts = Array.from(activeToasts);
    toasts.forEach(toast => removeToast(toast));
}

/**
 * Initialize toast system
 */
export function initToastSystem() {
    initToastContainer();
}

// Auto-initialize on module load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initToastContainer);
} else {
    initToastContainer();
}
