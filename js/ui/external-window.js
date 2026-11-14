/**
 * external-window.js
 * A second browser window that shows only the picture — the image and the pointer —
 * for a stereoscopic monitor next to the one Sphyrnidae is operated on.
 *
 * The window is a blank one (`about:blank`) opened from the page: it is of the
 * page's origin, so the page builds its contents and draws into its canvas
 * directly. Nothing runs in it — no script is loaded there, no state is copied
 * over: the page's own render loop draws the picture a second time
 * (js/rendering/external-output.js). A blank page inherits the page's CSP, which
 * already allows the inline style it needs ('unsafe-inline' in style-src).
 *
 * What the browser allows shapes the rest:
 *
 * - Opening needs the click: the window is opened synchronously from it, or a
 *   popup blocker refuses it.
 * - Placing it on the other monitor is possible only where the browser has the
 *   Window Management API (getScreenDetails: Chrome and Edge), once the viewer
 *   allows it. Elsewhere it opens beside the page and is moved by hand.
 * - Full screen takes a click (or Enter) in that window itself: the page's click
 *   is not the window's. The window says so until it is. A click there never
 *   leaves full screen — a touch by accident would otherwise end it; Esc does, as
 *   the browser itself says.
 *
 * Ported from the MANTIS viewer's external window (same author).
 */

import {
    openingFeatures, pickExternalScreen,
    fullscreenSupported, isDocumentFullscreen, onFullscreenChange
} from '../core/external-window-utils.js';
import { requestFullscreenCompat } from './ui-fullscreen.js';
import { safeLocalStorageGet, safeLocalStorageSet } from '../utils/safe-storage.js';

/** The window's name: opened again, the same window is reused, where it was left. */
export const EXTERNAL_WINDOW_NAME = 'sphyrnidae-stereo-output';

/** Which monitor was chosen last time (its label), to choose again. */
const SCREEN_KEY = 'sphyrnidae_external_screen';

/** How long the mouse rests before the window's own cursor and note go. */
const IDLE_MS = 4000;

/** How often to look whether the window was closed, for browsers that say nothing. */
const CLOSED_POLL_MS = 250;

const STYLE = `
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;}
body.idle,body.idle *{cursor:none;}
canvas{position:fixed;left:0;top:0;display:block;}
.sphyrnidae-hint{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);box-sizing:border-box;
  max-width:min(560px,calc(100% - 32px));padding:16px 22px;border-radius:14px;background:rgba(18,20,26,.88);
  color:#e8eaee;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:15px;line-height:1.6;text-align:center;
  box-shadow:0 6px 24px rgba(0,0,0,.45);pointer-events:none;transition:opacity .35s;}
.sphyrnidae-hint b{display:block;font-size:12px;letter-spacing:.06em;opacity:.7;margin-bottom:6px;}
.sphyrnidae-hint.off{opacity:0;}
`;

/**
 * @typedef {Object} ExternalWindowTexts
 * @property {string} title - window title and the note's heading
 * @property {string} hint - before full screen, where the browser offers it there
 * @property {string} hintNoFullscreen - where it does not: move the window and maximise it
 */

/**
 * @typedef {Object} ExternalWindowEvents
 * @property {() => void} closed - closed (by the viewer, by the page, or navigated away). Once.
 * @property {() => void} resized - its size or pixel ratio may have changed
 * @property {() => void} [replaced] - its document was replaced and the contents built
 *   again, with a new canvas (which needs a new renderer)
 * @property {() => void} [visibility] - it came into or went out of sight
 */

/** The second window, built and watched from the page. */
export class ExternalWindow {
    /**
     * @param {Window} win
     * @param {Window} opener
     * @param {ExternalWindowTexts} texts
     * @param {ExternalWindowEvents} events
     */
    constructor(win, opener, texts, events) {
        this.win = win;
        this.opener = opener;
        this.texts = texts;
        this.events = events;
        /** @type {HTMLCanvasElement} The canvas drawn into; a new one if the document is replaced. */
        this.canvas = null;
        this.hintEl = null;
        this.done = false;
        this.idleTimer = null;
        /** What undoes the listeners on the window and its document; built again with them. */
        this.windowCleanup = [];
        /** What undoes the rest: the listener on the page. */
        this.cleanup = [];
        /** The size and ratio last told to the page (check). */
        this.lastSize = '';

        this.wake = this.wake.bind(this);
        this.enterFullscreen = this.enterFullscreen.bind(this);

        this.build();
        // Looked at now and then, besides the events: whether it was closed without
        // a word, whether it came to a size or ratio without a resize event (a new
        // window can report none at first), and whether its blank document was
        // replaced under it.
        this.poll = setInterval(() => this.check(), CLOSED_POLL_MS);
        // The page going away takes the window with it: left open, it would hold a
        // canvas that nothing draws into any more.
        const onPageGone = () => this.close();
        opener.addEventListener('pagehide', onPageGone);
        this.cleanup.push(() => { try { opener.removeEventListener('pagehide', onPageGone); } catch (e) { /* gone */ } });
    }

    /**
     * Open the window, or find the one opened before under EXTERNAL_WINDOW_NAME.
     * Call it straight from the click. On failure `window` is null and `failure`
     * says why: 'blocked' — the browser refused to open one (a popup blocker, or a
     * browser with no windows to open); 'unusable' — one opened, but its document
     * would not take the contents, and it was closed again.
     * @param {Window} opener
     * @param {ExternalWindowTexts} texts
     * @param {ExternalWindowEvents} events
     * @returns {{window: ExternalWindow|null, failure: null|'blocked'|'unusable'}}
     */
    static open(opener, texts, events) {
        const features = openingFeatures(opener);
        const tryOpen = (name) => {
            try { return opener.open('', name, features); } catch (e) { return null; }
        };
        const unusable = (win) => {
            try { win.close(); } catch (_) { /* gone already */ }
            return { window: null, failure: 'unusable' };
        };
        let win = tryOpen(EXTERNAL_WINDOW_NAME);
        if (!win) return { window: null, failure: 'blocked' };
        if (!ExternalWindow.reachable(win)) {
            // Under that name is a window since gone to another site: not ours to
            // write into, nor to close. Leave it, and open a new one.
            win = tryOpen(`${EXTERNAL_WINDOW_NAME}-${Date.now().toString(36)}`);
            if (!win) return { window: null, failure: 'blocked' };
            // Opened just now, and still not ours to write into: not left open, empty.
            if (!ExternalWindow.reachable(win)) return unusable(win);
        }
        try { win.focus(); } catch (e) { /* the browser keeps it where it is */ }
        try {
            return { window: new ExternalWindow(win, opener, texts, events), failure: null };
        } catch (e) {
            // Its document would not take the contents: not left open, empty.
            return unusable(win);
        }
    }

    static reachable(win) {
        try { return !!win.document && !!win.document.body && !!win.document.head; } catch (e) { return false; }
    }

    /**
     * Put the window's contents into its document — the canvas and the note — and
     * listen to it. Again, all new, if the document is replaced (check).
     */
    build() {
        const doc = this.win.document;
        // A window reused under the same name still holds what the last page put
        // there — a canvas whose context went with that page.
        for (const n of [...doc.head.childNodes]) n.remove();
        for (const n of [...doc.body.childNodes]) n.remove();
        doc.body.className = '';
        const style = doc.createElement('style');
        style.textContent = STYLE;
        doc.head.appendChild(style);
        this.canvas = doc.createElement('canvas');
        doc.body.appendChild(this.canvas);
        this.hintEl = doc.createElement('div');
        this.hintEl.className = 'sphyrnidae-hint';
        this.hintEl.setAttribute('role', 'status');
        doc.body.appendChild(this.hintEl);
        this.renderTexts();
        this.listen();
        this.wake();
        this.lastSize = this.sizeKey();
    }

    sizeKey() {
        try { return `${this.win.innerWidth}x${this.win.innerHeight}@${this.win.devicePixelRatio}`; } catch (e) { return ''; }
    }

    /**
     * Closed? Then say so. Its document replaced — a browser may load a fresh blank
     * page over the one the window was opened with, which leaves the window open
     * and empty — then move in again. Gone to another site, it is not ours any
     * more: close it. And a size or ratio the page was not told of, tell it.
     */
    check() {
        if (this.closed) { this.finish(); return; }
        let replaced;
        try { replaced = this.canvas.ownerDocument !== this.win.document || !this.canvas.isConnected; } catch (e) { this.close(); return; }
        if (replaced) {
            if (!ExternalWindow.reachable(this.win)) { this.close(); return; }
            for (const fn of this.windowCleanup.splice(0)) fn();
            this.build();
            this.events.replaced?.();
            this.events.resized();
            return;
        }
        const key = this.sizeKey();
        if (key !== this.lastSize) { this.lastSize = key; this.events.resized(); }
    }

    /** Whether the window is gone. */
    get closed() {
        if (this.done) return true;
        try { return this.win.closed; } catch (e) { return true; }
    }

    /** Whether it is out of sight — minimised, or behind another window — so its frames wait. */
    hidden() {
        try { return this.win.document.hidden; } catch (e) { return true; }
    }

    /** Whether its page is in full screen now. */
    fullscreen() {
        try { return isDocumentFullscreen(this.win.document); } catch (e) { return false; }
    }

    /** The size to draw at, in its CSS pixels. */
    size() {
        return { width: Math.max(1, this.win.innerWidth || 1), height: Math.max(1, this.win.innerHeight || 1) };
    }

    /** Its own pixel ratio: a monitor at another scaling than the page's has another. */
    devicePixelRatio() {
        return this.win.devicePixelRatio || 1;
    }

    /**
     * Ask the window for the next frame, as requestAnimationFrame does: its frames
     * come at its own monitor's refresh, and keep coming while the page is out of
     * sight. Returns the id, for cancelFrame.
     * @param {FrameRequestCallback} callback
     * @returns {number}
     */
    requestFrame(callback) {
        return this.win.requestAnimationFrame(callback);
    }

    /** @param {number} id - from requestFrame */
    cancelFrame(id) {
        try { this.win.cancelAnimationFrame(id); } catch (e) { /* gone with the window */ }
    }

    /** Put the window's words in the page's language. Cheap when nothing changed. */
    setTexts(texts) {
        const t = this.texts;
        if (t.title === texts.title && t.hint === texts.hint && t.hintNoFullscreen === texts.hintNoFullscreen) return;
        this.texts = texts;
        this.renderTexts();
    }

    renderTexts() {
        const doc = this.win.document;
        doc.title = this.texts.title;
        const canFullscreen = fullscreenSupported(doc, doc.documentElement);
        const head = doc.createElement('b');
        head.textContent = this.texts.title;
        const body = doc.createElement('span');
        body.textContent = canFullscreen ? this.texts.hint : this.texts.hintNoFullscreen;
        this.hintEl.replaceChildren(head, body);
        this.showHint();
    }

    /** The note is for before full screen: in it there is nothing to say. */
    showHint() {
        this.hintEl.classList.toggle('off', this.fullscreen() || this.win.document.body.classList.contains('idle'));
    }

    /** The mouse moved: the cursor and the note come back, and go again after a rest. */
    wake() {
        if (this.closed) return;
        const body = this.win.document.body;
        body.classList.remove('idle');
        this.showHint();
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.closed) return;
            body.classList.add('idle');
            this.showHint();
        }, IDLE_MS);
    }

    /** Full screen, from the window's own click or key. Never out of it: that is Esc. */
    enterFullscreen() {
        const doc = this.win.document;
        if (isDocumentFullscreen(doc) || !fullscreenSupported(doc, doc.documentElement)) return;
        try {
            const pending = requestFullscreenCompat(doc.documentElement);
            if (pending && typeof pending.catch === 'function') pending.catch(() => { /* refused */ });
        } catch (e) { /* refused */ }
    }

    listen() {
        const { win } = this;
        const doc = win.document;
        const on = (target, type, fn) => {
            target.addEventListener(type, fn);
            this.windowCleanup.push(() => { try { target.removeEventListener(type, fn); } catch (e) { /* gone */ } });
        };
        on(doc, 'pointermove', this.wake);
        on(doc, 'pointerdown', this.wake);
        on(doc, 'click', this.enterFullscreen);
        on(doc, 'keydown', (e) => {
            this.wake();
            if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); this.enterFullscreen(); }
        });
        on(doc, 'visibilitychange', () => this.events.visibility?.());
        on(win, 'resize', () => { this.lastSize = this.sizeKey(); this.showHint(); this.events.resized(); });
        this.windowCleanup.push(onFullscreenChange(doc, () => { this.showHint(); this.events.resized(); }));
        // Another monitor at another scaling changes no CSS size, so no resize.
        let mq = null;
        const onRatio = () => { this.events.resized(); if (!this.closed) watchRatio(); };
        const watchRatio = () => {
            try {
                mq = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
                mq.addEventListener('change', onRatio, { once: true });
            } catch (e) { mq = null; }
        };
        watchRatio();
        this.windowCleanup.push(() => { try { mq?.removeEventListener('change', onRatio); } catch (e) { /* gone */ } });
        // Closed by its own button, or its document replaced: which of the two is
        // clear only once the page hiding has finished (check) — at once on some
        // browsers, a moment later on others; the poll is the last word.
        on(win, 'pagehide', () => {
            for (const ms of [0, 60, 200]) setTimeout(() => { if (!this.done) this.check(); }, ms);
        });
    }

    /**
     * Move it onto the other monitor and fill that monitor's working area — where
     * the browser can say which monitors there are and lets the page place windows
     * on them (the Window Management API, after the viewer allows it). A single
     * monitor is not asked about.
     * @returns {Promise<'placed'|'one-screen'|'unsupported'|'refused'>}
     */
    async place() {
        const opener = this.opener;
        if (typeof opener.getScreenDetails !== 'function') return 'unsupported';
        // Said without asking: one monitor, nowhere to go, and no question to put.
        if (opener.screen && opener.screen.isExtended === false) return 'one-screen';
        let details;
        try { details = await opener.getScreenDetails(); } catch (e) { return 'refused'; }
        if (this.closed) return 'refused';
        const target = pickExternalScreen(details.screens, details.currentScreen, safeLocalStorageGet(SCREEN_KEY));
        if (!target) return 'one-screen';
        try {
            this.win.moveTo(target.availLeft, target.availTop);
            this.win.resizeTo(target.availWidth, target.availHeight);
        } catch (e) { return 'refused'; }
        if (target.label) safeLocalStorageSet(SCREEN_KEY, target.label);
        return 'placed';
    }

    /** Close the window. The `closed` event follows, once. */
    close() {
        try { if (!this.win.closed) this.win.close(); } catch (e) { /* gone already */ }
        this.finish();
    }

    finish() {
        if (this.done) return;
        this.done = true;
        if (this.poll) clearInterval(this.poll);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        for (const fn of this.windowCleanup.splice(0)) fn();
        for (const fn of this.cleanup.splice(0)) fn();
        this.events.closed();
    }
}
