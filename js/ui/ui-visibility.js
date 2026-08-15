/**
 * ui-visibility.js
 * Distraction-free view for the normal (editable) mode
 * - Hides every operation panel and drawer handle at once so the image gets the
 *   whole window, and restores them on the next toggle
 * - Driven by the H key (ui-input.js) and the floating toggle button on the canvas
 *
 * Hiding is done purely by adding `ui-chrome-hidden` to <body>: the CSS rules that
 * class enables use `display: none !important`, so no panel's own state (the menu
 * drawer's .ui-hidden / body.menu-open, the status panel's .status-hidden /
 * body.status-open, the histogram's inline display) is ever touched. Restoring is
 * therefore just removing the class, and every panel comes back exactly as the
 * user left it — including panels opened or closed by the fullscreen handlers.
 *
 * Viewer mode is deliberately out of scope: it has its own auto-hiding control bar,
 * so the toggle is inert there and is reset when viewer mode starts.
 */

import { state } from '../globals.js';
import { clearElementCache } from './ui.js';
import * as logger from '../utils/logger.js';

const BODY_CLASS = 'ui-chrome-hidden';
const BTN_ID = 'uiVisibilityToggleBtn';

// i18n keys for the toggle button's label/tooltip, per state
const LABEL_KEY_HIDE = 'accessibility.hidePanels';
const LABEL_KEY_SHOW = 'accessibility.showPanels';

// Set once the first image is loaded. Both the toggle button and the H key are
// gated on it: with no image there is nothing to look at, and the button (which is
// the only pointer route back) is not on screen yet, so hiding would strand a user
// who pressed H by accident.
let imageAvailable = false;

/**
 * Show or hide every UI panel at once.
 * Hiding is a no-op before the first image loads and in viewer mode (which has its
 * own control bar); restoring always runs, so the state can never get stuck on.
 * @param {boolean} hidden - True to hide all panels, false to restore them
 */
function setUiChromeHidden(hidden) {
    const next = !!hidden;

    if (next && (state.viewerMode || !imageAvailable)) return;
    if (next === !!state.uiChromeHidden) return;

    state.uiChromeHidden = next;
    document.body.classList.toggle(BODY_CLASS, next);

    // The menu drawer leaves the flex flow while hidden, so the canvas resizes and
    // the cached element references taken while it was laid out may be stale.
    clearElementCache();

    updateUiVisibilityButton();

    logger.debug('UI_LOG', 'UIVisibility', `UI panels ${next ? 'hidden' : 'restored'}`);
}

/**
 * Toggle the distraction-free view
 */
export function toggleUiChrome() {
    setUiChromeHidden(!state.uiChromeHidden);
}

/**
 * Force every panel back into view.
 * Called when viewer mode starts so the viewer never inherits a hidden-chrome
 * state that its own UI has no control for.
 */
export function resetUiChrome() {
    setUiChromeHidden(false);
}

/**
 * Sync the toggle button's pressed state, icon and label with the current state
 */
function updateUiVisibilityButton() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    const hidden = !!state.uiChromeHidden;
    const key = hidden ? LABEL_KEY_SHOW : LABEL_KEY_HIDE;
    // Fallbacks mirror locales/en.json. They must go through i18next's defaultValue
    // option, not just `??`: before init (and when the i18next CDN script is
    // unavailable) t() returns the raw KEY rather than undefined, so `??` alone
    // would put "accessibility.hidePanels" in the tooltip.
    const fallback = hidden ? 'Show panels again (H)' : 'Hide all panels (H)';
    const label = window.t?.(key, { defaultValue: fallback }) ?? fallback;

    btn.setAttribute('aria-pressed', String(hidden));
    btn.setAttribute('aria-label', label);
    btn.setAttribute('title', label);
    // Repoint the i18n keys so a later language switch re-translates the label that
    // matches the CURRENT state instead of the one baked into the markup.
    btn.setAttribute('data-i18n', `[aria-label]${key}`);
    btn.setAttribute('data-i18n-title', key);

    // 🖼 = "picture only" (click to hide the panels), 👁 = "the UI is out of sight"
    // (click to bring it back). VS16 keeps both in emoji presentation.
    const icon = btn.querySelector('.ui-visibility-icon');
    if (icon) icon.textContent = hidden ? '\u{1F441}\u{FE0F}' : '\u{1F5BC}\u{FE0F}';
}

/**
 * Set up the distraction-free view toggle button.
 * The button stays out of the way until an image is loaded, matching the rest of
 * the initial UI lock.
 * @param {AbortSignal} signal - AbortController signal
 */
export function setupUiVisibilityToggle(signal) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    updateUiVisibilityButton();

    btn.addEventListener('click', () => {
        toggleUiChrome();
    }, { signal });

    // Arm the toggle once there is an image to look at
    window.addEventListener('stereo-image-loaded', () => {
        imageAvailable = true;
        btn.classList.add('is-available');
    }, { signal });
}

/**
 * Reset the distraction-free view (used by the UI cleanup path)
 * @idempotent Safe to call multiple times
 */
export function cleanupUiVisibility() {
    state.uiChromeHidden = false;
    imageAvailable = false;
    document.body.classList.remove(BODY_CLASS);

    const btn = document.getElementById(BTN_ID);
    if (btn) btn.classList.remove('is-available');
}
