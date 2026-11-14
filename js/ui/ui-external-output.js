/**
 * ui-external-output.js
 * The external output window, from the page's side: the buttons that open and
 * close it, what it says, and what the render loop asks of it.
 *
 * While it is open, the page stays as it is — same display mode, same controls —
 * and the window shows only the picture: the image, the text overlay, and the
 * pointer (js/rendering/external-output.js). It is meant for a stereoscopic
 * monitor beside the one the app is operated on.
 *
 * The render loop (main.js) draws it after the page every frame
 * (renderExternalOutput), and asks frames of its window while that window is in
 * sight (externalFrameSource) — they come at the stereo monitor's refresh, and keep
 * coming while the page is out of sight. Whenever that may have changed this
 * module dispatches 'external-output-frames' on window.
 */

import { state } from '../globals.js';
import { externalWindowOffered } from '../core/external-window-utils.js';
import { ExternalOutput } from '../rendering/external-output.js';
import { showToast } from './ui-toast.js';
import * as logger from '../utils/logger.js';

/** The external output, while it is open. */
let output = null;

/** Consecutive frames that threw; the window is closed after this many. */
let drawErrors = 0;
const MAX_DRAW_ERRORS = 10;

/**
 * Whether this browser is offered the external window: not on an iPhone, an iPad
 * or Android, where a popup opens as a tab in front of the page (externalWindowOffered).
 */
export const externalOutputOffered = typeof navigator !== 'undefined' && externalWindowOffered(navigator);

// window.t returns the key itself until i18next is ready (or if it never loads), so
// the English text goes in as its defaultValue rather than only after `??`.
const t = (key, fallback) => window.t?.(key, { defaultValue: fallback }) ?? fallback;

function windowTexts() {
    return {
        title: t('externalOutput.windowTitle', 'Sphyrnidae — external output'),
        hint: t('externalOutput.windowHint', 'Move this window to the stereo display, then click it or press Enter for full screen (Esc to leave). Operate from the original window.'),
        hintNoFullscreen: t('externalOutput.windowHintNoFullscreen', 'Move this window to the stereo display and maximize it. Operate from the original window.'),
    };
}

/** Tell the render loop to ask its next frame of whichever window is in sight now. */
function framesChanged() {
    try {
        window.dispatchEvent(new Event('external-output-frames'));
    } catch (_) { /* Event unavailable: non-fatal */ }
}

/** Whether the external window is open. */
export function isExternalOutputOpen() {
    return !!output && !output.closed;
}

/**
 * The window to ask animation frames of: the external one while it is open and in
 * sight, otherwise null (the page's own).
 * @returns {import('./external-window.js').ExternalWindow|null}
 */
export function externalFrameSource() {
    if (!output || output.closed || output.hidden()) return null;
    return output.window;
}

/**
 * Draw the external window's frame. Called by the render loop after the page's.
 * Skipped while an export holds the render state (state.externalOutputHold): the
 * window keeps its last frame rather than flash the export's temporary state.
 * Not drawn while the window is out of sight.
 */
export function renderExternalOutput() {
    if (!output || output.closed || state.externalOutputHold) return;
    try {
        // Out of sight (minimised or covered): nothing is drawn, but what it holds
        // follows the page, so a replaced image is not kept alive there. It draws
        // again on its next frame once it is back in sight.
        output.draw({ render: !output.hidden() });
        drawErrors = 0;
    } catch (err) {
        drawErrors++;
        logger.warn('ExternalOutput', `Drawing the external window failed (${drawErrors}/${MAX_DRAW_ERRORS}):`, err);
        if (drawErrors >= MAX_DRAW_ERRORS) {
            showToast(t('externalOutput.failed', 'The external window stopped drawing and was closed.'), 'error');
            output.close();
        }
    }
}

/**
 * Open the external window. Synchronous: it has to be inside the click, or the
 * popup blocker refuses it.
 */
export function openExternalOutput() {
    if (output || !externalOutputOffered) return;
    // VR draws with the page's renderer and owns the render loop.
    if (state.renderer?.xr?.enabled) return;
    let opened = null;
    const result = ExternalOutput.open(window, windowTexts(), {
        closed: () => { if (opened) externalClosed(opened); },
        frames: () => framesChanged(),
        contextLost: () => {
            if (!opened || opened !== output) return;
            showToast(t('externalOutput.contextLost', 'The external window lost its WebGL context and was closed. Open it again to continue.'), 'warning');
            opened.close();
        },
    });
    opened = result.output;
    if (!opened) {
        if (result.failure === 'webgl') {
            showToast(t('externalOutput.webglFailed', 'The external window could not start WebGL and was closed. Close other tabs or windows that use 3D, then try again.'), 'error');
        } else if (result.failure === 'unusable') {
            showToast(t('externalOutput.unusable', 'The external window could not be prepared and was closed. Try again.'), 'error');
        } else {
            showToast(t('externalOutput.blocked', 'Could not open the external window. Allow pop-ups for this site, then try again.'), 'warning');
        }
        return;
    }
    output = opened;
    drawErrors = 0;
    state.externalOutputOpen = true;
    updateExternalOutputButtons();
    framesChanged();
    logger.info('ExternalOutput', 'External window opened');
    // Onto the other monitor, where the browser can and the viewer allows it.
    void opened.place().then((result) => {
        if (opened !== output) return;
        if (result === 'placed') {
            showToast(t('externalOutput.placed', 'Moved the external window to the second display. Click it to go full screen.'), 'info');
        }
    }).catch(() => { /* stays where it opened */ });
}

/** Close the external window, if it is open. What it held is let go when it says it closed. */
export function closeExternalOutput() {
    output?.close();
}

/** The buttons: open the external window, or close it. */
export function toggleExternalOutput() {
    if (isExternalOutputOpen()) {
        closeExternalOutput();
        return;
    }
    // Closed by hand a moment ago and not yet noticed (the window is looked at every
    // 250 ms): let it go now, so this click opens a new one rather than closing a
    // window that is already gone. Synchronous, so the click still opens the popup.
    if (output) output.close();
    openExternalOutput();
}

function externalClosed(closed) {
    if (output !== closed) return;
    output = null;
    try { closed.dispose(); } catch (err) { logger.warn('ExternalOutput', 'Error releasing the external window:', err); }
    state.externalOutputOpen = false;
    state.pointerOverImage = false;
    updateExternalOutputButtons();
    framesChanged();
    logger.info('ExternalOutput', 'External window closed');
}

/** Bring the buttons (menu and viewer bar) in line with whether the window is open. */
export function updateExternalOutputButtons() {
    const open = isExternalOutputOpen();
    const menuBtn = document.getElementById('externalOutputBtn');
    if (menuBtn) {
        menuBtn.textContent = open
            ? t('externalOutput.close', 'Close external window')
            : t('externalOutput.open', 'Output to external window');
        menuBtn.classList.toggle('active', open);
        menuBtn.setAttribute('aria-pressed', String(open));
    }
    const viewerBtn = document.getElementById('viewerExternalOutputBtn');
    if (viewerBtn) {
        if (open) {
            viewerBtn.style.backgroundColor = 'var(--accent-color, #4a9eff)';
            viewerBtn.style.color = 'white';
        } else {
            viewerBtn.style.backgroundColor = '';
            viewerBtn.style.color = '';
        }
        viewerBtn.setAttribute('aria-pressed', String(open));
        const title = open
            ? t('externalOutput.close', 'Close external window')
            : t('externalOutput.open', 'Output to external window');
        viewerBtn.title = title;
        viewerBtn.setAttribute('aria-label', title);
    }
}

/**
 * Wire the buttons. Hidden where the window is not offered.
 * @param {AbortSignal} signal - AbortController signal for cleanup
 */
export function setupExternalOutputControls(signal) {
    for (const id of ['externalOutputGroup', 'viewerExternalOutputBtn']) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !externalOutputOffered);
    }
    if (!externalOutputOffered) return;

    for (const id of ['externalOutputBtn', 'viewerExternalOutputBtn']) {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', () => toggleExternalOutput(), { signal });
    }

    window.addEventListener('app-language-changed', () => {
        updateExternalOutputButtons();
        output?.setTexts(windowTexts());
    }, { signal });

    updateExternalOutputButtons();
}
