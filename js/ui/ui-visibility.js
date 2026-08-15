/**
 * ui-visibility.js
 * Panel visibility for the normal (editable) mode
 * - Distraction-free view: hides every operation panel and drawer handle at once so
 *   the image gets the whole window, and restores them on the next toggle
 * - The status panel's own minimize/restore, which is a smaller version of the same
 *   idea and shares the restore button with it
 *
 * Hiding every panel is done purely by adding `ui-chrome-hidden` to <body>: the CSS
 * rules that class enables use `display: none !important`, so no panel's own state (the
 * menu drawer's .ui-hidden / body.menu-open, the status panel's .status-hidden /
 * body.status-open, the histogram's inline display) is ever touched. Restoring is
 * therefore just removing the class, and every panel comes back exactly as the user
 * left it — including panels opened or closed by the fullscreen handlers.
 *
 * Five controls drive it. The four buttons are wired here so their labels can never
 * disagree; the H key is bound in ui-input.js and calls in through toggleUiChrome():
 *   H key (ui-input.js) ....... toggle the distraction-free view
 *   #hideStatusBtn (×) ........ hide every panel
 *   #minimizeStatusBtn (−) .... collapse the status panel alone
 *   #showStatusBtn ............ restore — whichever of the two is in effect
 *   #uiVisibilityToggleBtn .... restore every panel, from the canvas
 *
 * Only one control puts the panels away by pointer, and it is the status panel's ×.
 * Nothing on the canvas duplicates it: a hide button drawn over the image would be a
 * second way to do what the × already does, sitting on top of the thing the whole
 * feature exists to show. The consequence is deliberate — while the status panel is
 * minimized the × is off screen, so hiding is the H key only.
 *
 * The top-right restore button is shared on purpose: only one of the two hidden states
 * can be the outer one at a time, so a single button in the slot the status panel
 * vacates can carry both meanings without ambiguity. With both in effect it takes two
 * clicks — first the panels come back, then the status panel — which follows from never
 * save/restoring a panel's own state. The on-canvas button is a second route back for
 * the same outer state, which is what lets it be drawn as faintly as it is.
 *
 * Viewer mode is deliberately out of scope: it has its own auto-hiding control bar,
 * so the toggle is inert there and is reset when viewer mode starts.
 */

import { state } from '../globals.js';
import { clearElementCache } from './ui.js';
import * as logger from '../utils/logger.js';

const BODY_CLASS = 'ui-chrome-hidden';
const BTN_ID = 'uiVisibilityToggleBtn';
const RESTORE_BTN_ID = 'showStatusBtn';

// i18n keys for the top-right restore button's label/tooltip, per state. The other
// three buttons never change what they mean, so they carry their keys in the markup.
const LABEL_KEY_SHOW = 'accessibility.showPanels';
const LABEL_KEY_SHOW_STATUS = 'accessibility.showStatus';

// Glyphs, kept in the same geometric family as the drawer handle (› ‹) and the close
// buttons (×) rather than emoji, which render in colour and at their own size per
// platform. « = bring the panels back, ▤ = the status panel itself (rows of readings).
const ICON_SHOW_ALL = '«';
const ICON_SHOW_STATUS = '▤';

// Set once the first image is loaded. The H key is gated on it: with no image there is
// nothing to look at, so clearing the panels only costs a keystroke to undo.
let imageAvailable = false;

/**
 * Translate a label, falling back to the English wording when i18next is unavailable.
 * The fallback must go through i18next's defaultValue option, not just `??`: before
 * init (and when the i18next CDN script is unavailable) t() returns the raw KEY rather
 * than undefined, so `??` alone would put "accessibility.showPanels" in the tooltip.
 * @param {string} key - i18n key
 * @param {string} fallback - English wording, mirroring locales/en.json
 * @returns {string} Translated label
 */
function label(key, fallback) {
    return window.t?.(key, { defaultValue: fallback }) ?? fallback;
}

/**
 * Point a button's label, tooltip and i18n keys at one translation.
 * The data-i18n attributes are repointed as well as the resolved text, so a later
 * language switch re-translates the label that matches the CURRENT state instead of
 * the one baked into the markup.
 * @param {HTMLElement} btn - Button to label
 * @param {string} key - i18n key for the current state
 * @param {string} fallback - English wording for that key
 */
function applyLabel(btn, key, fallback) {
    const text = label(key, fallback);
    btn.setAttribute('aria-label', text);
    btn.setAttribute('title', text);
    btn.setAttribute('data-i18n', `[aria-label]${key}`);
    btn.setAttribute('data-i18n-title', key);
}

/**
 * Whether an element is rendered — laid out, and not `visibility: hidden`.
 * getClientRects() flushes any pending style change, so this reports the state just
 * applied rather than the one before it. offsetParent is not usable here: it is null
 * for the position:fixed restore button whether or not that button is on screen.
 * @param {Element|null} el - Element to test
 * @returns {boolean} True when the element occupies space and is visible
 */
function isOnScreen(el) {
    return !!el && el.getClientRects().length > 0 &&
        getComputedStyle(el).visibility !== 'hidden';
}

/**
 * Try to put focus on an element, and report whether it took.
 * Used to pick a landing spot, where asking the browser is exact: display, visibility
 * and a hidden ancestor all refuse focus while each looks different from CSS.
 * @param {Element|null} el - Element to focus
 * @returns {boolean} True if the element now holds focus
 */
function tryFocus(el) {
    if (!el) return false;
    el.focus({ preventScroll: true });
    return document.activeElement === el;
}

/**
 * Hand focus to the control that now undoes what just happened.
 *
 * Hiding a panel `display: none`s whatever had focus inside it, and the browser then
 * drops focus to <body> with nothing announced — a keyboard user is left with no
 * selection and has to hunt for the way back. Moving focus onto the surviving control
 * is the same contract a dialog's close button has. Ordered so it never lands on the ×
 * unprompted: a stray Enter should not clear the screen again.
 * @param {Element|null} previous - The element that was focused before the change
 * @param {boolean} [alreadyLost=false] - Treat `previous` as gone without asking. The
 *   status panel slides out over --transition-medium and only stops being focusable at
 *   the end of it, so on this tick the browser would still accept focus there; only the
 *   caller knows it is on its way out.
 */
function keepFocusOnScreen(previous, alreadyLost = false) {
    if (!previous || previous === document.body) return;

    // Whether focus was lost is read from layout, never from document.activeElement:
    // the browser does not move focus off a display:none element until after this turn,
    // so asking it here would always answer "still focused" and skip the hand-off.
    if (!alreadyLost && isOnScreen(previous)) return;

    // Candidates are screened by layout for the same reason before focus is attempted:
    // a button that just went away still compares equal to document.activeElement, so
    // focusing it would look like a success and stop the search on the wrong element.
    for (const id of [RESTORE_BTN_ID, BTN_ID, 'minimizeStatusBtn']) {
        const candidate = document.getElementById(id);
        if (isOnScreen(candidate) && tryFocus(candidate)) return;
    }
}

/**
 * Show or hide every UI panel at once.
 * Hiding is a no-op in viewer mode (which has its own control bar); restoring always
 * runs, so the state can never get stuck on.
 * @param {boolean} hidden - True to hide all panels, false to restore them
 * @param {Object} [options] - Options
 * @param {boolean} [options.requireImage=true] - Refuse to hide before the first image
 *   loads, which is what the H key wants: with nothing on screen to look at, clearing
 *   the panels achieves nothing and only costs a keystroke to undo. The status panel's
 *   × clears the flag, because a user who found and pressed that button meant it.
 */
function setUiChromeHidden(hidden, { requireImage = true } = {}) {
    const next = !!hidden;

    if (next && state.viewerMode) return;
    if (next && requireImage && !imageAvailable) return;
    if (next === !!state.uiChromeHidden) return;

    const previouslyFocused = document.activeElement;

    state.uiChromeHidden = next;
    document.body.classList.toggle(BODY_CLASS, next);

    // The menu drawer leaves the flex flow while hidden, so the canvas resizes and
    // the cached element references taken while it was laid out may be stale.
    clearElementCache();

    syncRestoreButton();
    keepFocusOnScreen(previouslyFocused);

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
 * Collapse or restore the status panel on its own, leaving every other panel alone.
 * @param {boolean} hidden - True to minimize the status panel, false to bring it back
 */
function setStatusPanelHidden(hidden) {
    const previouslyFocused = document.activeElement;
    const statusPanel = document.getElementById('status-panel');
    // Noted before the class changes, and from the state rather than from layout: the
    // panel slides out over --transition-medium, so its buttons still measure as on
    // screen for the whole animation even though they are already unreachable.
    const focusLeavesWithPanel = !!hidden && !!statusPanel?.contains(previouslyFocused);

    if (statusPanel) statusPanel.classList.toggle('status-hidden', !!hidden);
    document.body.classList.toggle('status-open', !hidden);

    clearElementCache();
    syncRestoreButton();
    keepFocusOnScreen(previouslyFocused, focusLeavesWithPanel);
}

/**
 * Sync the top-right restore button's glyph and label with the current state.
 *
 * It is the only control here whose meaning depends on state; the other three each do
 * one thing and carry their labels in the markup. Every path that changes either state
 * runs through this module, so one pass here is enough. The other modules that touch
 * `status-open` (ui-fullscreen.js, main.js's recovery path, the viewer loaders) all
 * leave this button hidden by CSS while they hold it, and hand back a state where it is
 * hidden again.
 */
function syncRestoreButton() {
    const restoreBtn = document.getElementById(RESTORE_BTN_ID);
    if (!restoreBtn) return;

    const hidden = !!state.uiChromeHidden;

    // While everything is hidden this button undoes that; otherwise it is only on
    // screen because the status panel alone is minimized, and it undoes that.
    applyLabel(restoreBtn,
        hidden ? LABEL_KEY_SHOW : LABEL_KEY_SHOW_STATUS,
        hidden ? 'Show panels again (H)' : 'Show the status panel');

    const icon = restoreBtn.querySelector('.status-toggle-icon');
    if (icon) icon.textContent = hidden ? ICON_SHOW_ALL : ICON_SHOW_STATUS;
}

/**
 * Set up the panel visibility controls.
 * @param {AbortSignal} signal - AbortController signal
 */
export function setupUiVisibilityToggle(signal) {
    syncRestoreButton();

    // Arm the H key once there is an image to look at
    window.addEventListener('stereo-image-loaded', () => {
        imageAvailable = true;
    }, { signal });

    // Only ever on screen while the panels are hidden (see css/layout.css), so this is
    // a restore, not a toggle.
    document.getElementById(BTN_ID)?.addEventListener('click', () => {
        resetUiChrome();
    }, { signal });

    // The status panel's × clears every panel, not just this one — the panel-sized
    // action lives on the − beside it.
    document.getElementById('hideStatusBtn')?.addEventListener('click', () => {
        setUiChromeHidden(true, { requireImage: false });
    }, { signal });

    document.getElementById('minimizeStatusBtn')?.addEventListener('click', () => {
        setStatusPanelHidden(true);
    }, { signal });

    document.getElementById(RESTORE_BTN_ID)?.addEventListener('click', () => {
        if (state.uiChromeHidden) {
            resetUiChrome();
        } else {
            setStatusPanelHidden(false);
        }
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

    // Leave the label matching the state just reset to, so a torn-down UI cannot be
    // left showing "restore the panels" on a screen where nothing is hidden.
    syncRestoreButton();
}
