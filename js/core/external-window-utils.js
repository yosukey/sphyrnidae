/**
 * external-window-utils.js
 * Pure helpers for the external output window (js/ui/external-window.js): whether
 * to offer it in this browser, how to open it, which monitor to move it to, and the
 * Fullscreen API on a given document. No three.js and no globals, so they run
 * under Node (tests/external-window.test.mjs).
 */

/**
 * Whether to offer the external window here: not on an iPhone, an iPad or an
 * Android device. There a popup opens as a tab in front of the page, hiding the
 * page it is meant to be operated beside. Every browser on iOS is WebKit, so
 * Chrome and Firefox there too. An iPad asks for desktop sites by default and then
 * calls itself a Mac — a Mac with a touch screen, which no Mac is. Android says so
 * in every browser's user agent, tablets included; one asking for the desktop site
 * calls itself Linux, and is let be.
 * @param {{userAgent?: string, platform?: string, maxTouchPoints?: number}} nav
 * @returns {boolean}
 */
export function externalWindowOffered(nav) {
    const ua = (nav && nav.userAgent) || '';
    if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return false;
    if (/\bAndroid\b/.test(ua)) return false;
    const mac = /Macintosh/.test(ua) || (nav && nav.platform === 'MacIntel');
    if (mac && ((nav && nav.maxTouchPoints) || 0) > 1) return false;
    return true;
}

/**
 * The window.open() features: a popup beside the page, on the side an extended
 * monitor usually is, at the page's size or less. Where the browser keeps a window
 * on the page's own monitor, it is pushed back to the edge, which is still where
 * the viewer looks for it.
 * @param {{screenX:number, screenY:number, outerWidth:number, outerHeight:number,
 *          screen?: {availWidth?:number, availHeight?:number}}} g - the page's window
 * @returns {string}
 */
export function openingFeatures(g) {
    const availW = (g.screen && g.screen.availWidth) || g.outerWidth || 1280;
    const availH = (g.screen && g.screen.availHeight) || g.outerHeight || 800;
    const width = Math.max(320, Math.round(Math.min(g.outerWidth || 1280, availW, 1280)));
    const height = Math.max(240, Math.round(Math.min(g.outerHeight || 800, availH, 800)));
    const left = Math.round((g.screenX || 0) + (g.outerWidth || 0));
    const top = Math.round(g.screenY || 0);
    return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

function sameScreen(a, b) {
    return a === b || (a.availLeft === b.availLeft && a.availTop === b.availTop
        && a.availWidth === b.availWidth && a.availHeight === b.availHeight);
}

/**
 * The monitor to put the window on (from getScreenDetails(), the Window Management
 * API): not the one the page is on. The one chosen last time if it is there (by its
 * label); otherwise one that is not the primary monitor; otherwise the first.
 * Null with one monitor.
 * @param {Array<{availLeft:number, availTop:number, availWidth:number, availHeight:number,
 *          isPrimary?:boolean, label?:string}>} screens
 * @param {object|null|undefined} current - the page's monitor
 * @param {string|null} [remembered] - label chosen last time
 * @returns {object|null}
 */
export function pickExternalScreen(screens, current, remembered) {
    const others = screens.filter(s => !current || !sameScreen(s, current));
    if (!others.length) return null;
    if (remembered) {
        const again = others.find(s => s.label && s.label === remembered);
        if (again) return again;
    }
    return others.find(s => !s.isPrimary) || others[0];
}

/**
 * The pointer the external window draws: the 3D pointer exactly as the page draws
 * it while that is on; otherwise the mouse's place over the image as a flat arrow —
 * zero parallax, at screen depth — so the audience at the stereo monitor sees what
 * the operator points at. Positions are in the shader's per-eye image space
 * (pointer3dX/Y), so they land on the same image point whatever each window's size.
 * @param {{pointer3dEnabled:boolean, pointer3dVisible:boolean, pointerOverImage:boolean,
 *          pointer3dX:number, pointer3dY:number, pointer3dParallax:number}} s - app state
 * @returns {{enabled:number, x:number, y:number, parallax:number}} shader uniform values
 */
export function externalPointer(s) {
    const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
    const x = finite(s.pointer3dX, 0.5);
    const y = finite(s.pointer3dY, 0.5);
    if (s.pointer3dEnabled) {
        return { enabled: s.pointer3dVisible ? 1.0 : 0.0, x, y, parallax: finite(s.pointer3dParallax, 0) };
    }
    return { enabled: s.pointerOverImage ? 1.0 : 0.0, x, y, parallax: 0.0 };
}

/** The events that say a document entered or left full screen. */
const FULLSCREEN_CHANGE_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'];

/**
 * Whether `doc` offers element full screen for `el` at all.
 * @param {Document} doc
 * @param {Element} el
 * @returns {boolean}
 */
export function fullscreenSupported(doc, el) {
    const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? false;
    const canRequest = typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
    return !!enabled && canRequest;
}

/**
 * Whether some element of `doc` is in full screen now.
 * @param {Document} doc
 * @returns {boolean}
 */
export function isDocumentFullscreen(doc) {
    return !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
}

/**
 * Call `listener` whenever `doc` enters or leaves full screen.
 * @param {Document} doc
 * @param {() => void} listener
 * @returns {() => void} the way to stop
 */
export function onFullscreenChange(doc, listener) {
    for (const type of FULLSCREEN_CHANGE_EVENTS) doc.addEventListener(type, listener);
    return () => { for (const type of FULLSCREEN_CHANGE_EVENTS) doc.removeEventListener(type, listener); };
}
