/**
 * tests/external-window.test.mjs
 *
 * The pure helpers behind the external output window (js/core/external-window-utils.js):
 * which browsers are offered it, how it is opened, which monitor it is moved to,
 * and the Fullscreen API on a given document.
 *
 * Run:  node tests/external-window.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    externalWindowOffered, openingFeatures, pickExternalScreen,
    fullscreenSupported, isDocumentFullscreen, onFullscreenChange, externalPointer
} from '../js/core/external-window-utils.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

const screen = (left, extra = {}) => ({ availLeft: left, availTop: 0, availWidth: 1920, availHeight: 1040, ...extra });

// --- pickExternalScreen ---------------------------------------------------------
{
    const a = screen(0, { isPrimary: true }), b = screen(1920);
    ok(pickExternalScreen([a, b], a) === b, 'chooses the monitor the page is not on');
    ok(pickExternalScreen([a, b], b) === a, 'the page on the second monitor: the window goes to the first');
}
{
    // Two calls give two objects for the same monitor on some browsers.
    const a = screen(0), b = screen(1920);
    ok(pickExternalScreen([a, b], screen(0)) === b, 'knows the current monitor by its place as well as by identity');
}
{
    const a = screen(0);
    ok(pickExternalScreen([a], a) === null, 'nowhere to go with one monitor');
    ok(pickExternalScreen([], null) === null, 'nowhere to go with none');
}
{
    const page = screen(0, { isPrimary: true }), b = screen(1920, { label: 'Office' }), c = screen(3840, { label: '3D' });
    ok(pickExternalScreen([page, b, c], page, '3D') === c, 'chooses the one chosen last time, by its label');
    ok(pickExternalScreen([page, b, c], page, 'Projector') === b, 'remembered one gone: the first that is not the page\'s');
}
{
    const page = screen(0), primary = screen(1920, { isPrimary: true }), other = screen(3840);
    ok(pickExternalScreen([page, primary, other], page) === other, 'prefers a monitor that is not the primary one');
}

// --- openingFeatures ------------------------------------------------------------
ok(openingFeatures({ screenX: 100, screenY: 50, outerWidth: 1000, outerHeight: 700, screen: { availWidth: 1920, availHeight: 1040 } })
    === 'popup=yes,width=1000,height=700,left=1100,top=50', 'opens a popup beside the page, at its size');
ok(openingFeatures({ screenX: 0, screenY: 0, outerWidth: 3000, outerHeight: 2000, screen: { availWidth: 1440, availHeight: 900 } })
    === 'popup=yes,width=1280,height=800,left=3000,top=0', 'keeps to the screen\'s size and a sensible maximum');
{
    const f = openingFeatures({ screenX: 0, screenY: 0, outerWidth: 0, outerHeight: 0 });
    const m = /width=(\d+),height=(\d+)/.exec(f);
    ok(m && Number(m[1]) >= 320 && Number(m[2]) >= 240, 'never asks for a window too small to see');
}

// --- externalWindowOffered ------------------------------------------------------
{
    const UA = {
        iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
        ipadMobile: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
        chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
        macLike: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
        windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
        androidTablet: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        androidFirefox: 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
        linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        chromeOs: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    };
    ok(!externalWindowOffered({ userAgent: UA.iphone, maxTouchPoints: 5 }), 'not on an iPhone');
    ok(!externalWindowOffered({ userAgent: UA.ipadMobile, maxTouchPoints: 5 }), 'not on an iPad');
    ok(!externalWindowOffered({ userAgent: UA.chromeIos, maxTouchPoints: 5 }), 'not in Chrome on iOS');
    ok(!externalWindowOffered({ userAgent: UA.macLike, platform: 'MacIntel', maxTouchPoints: 5 }), 'not on an iPad that calls itself a Mac');
    ok(!externalWindowOffered({ userAgent: UA.android, maxTouchPoints: 5 }), 'not on an Android phone');
    ok(!externalWindowOffered({ userAgent: UA.androidTablet, maxTouchPoints: 10 }), 'not on an Android tablet');
    ok(!externalWindowOffered({ userAgent: UA.androidFirefox, maxTouchPoints: 5 }), 'not in Firefox on Android');
    ok(externalWindowOffered({ userAgent: UA.macLike, platform: 'MacIntel', maxTouchPoints: 0 }), 'on a Mac');
    ok(externalWindowOffered({ userAgent: UA.windowsChrome, platform: 'Win32', maxTouchPoints: 10 }), 'on Windows with a touch screen');
    ok(externalWindowOffered({ userAgent: UA.linux, platform: 'Linux x86_64', maxTouchPoints: 0 }), 'on Linux');
    ok(externalWindowOffered({ userAgent: UA.chromeOs, platform: 'Linux x86_64', maxTouchPoints: 10 }), 'on ChromeOS');
    ok(externalWindowOffered({}), 'when nothing is known');
    // An Android tablet asking for the desktop site calls itself Linux: a touch screen and no fine pointer.
    ok(!externalWindowOffered({ userAgent: UA.linux, platform: 'Linux x86_64', maxTouchPoints: 10 }, { finePointer: false }),
        'not on an Android tablet asking for the desktop site (Linux, touch, no fine pointer)');
    ok(externalWindowOffered({ userAgent: UA.linux, platform: 'Linux x86_64', maxTouchPoints: 10 }, { finePointer: true }),
        'on a Linux computer with a touch screen and a mouse or touchpad');
    ok(externalWindowOffered({ userAgent: UA.linux, platform: 'Linux x86_64', maxTouchPoints: 0 }, { finePointer: false }),
        'on a Linux computer without touch, whatever the pointer');
    ok(externalWindowOffered({ userAgent: UA.chromeOs, platform: 'Linux x86_64', maxTouchPoints: 10 }, { finePointer: false }),
        'on a ChromeOS tablet (real windows)');
    ok(externalWindowOffered({ userAgent: UA.windowsChrome, platform: 'Win32', maxTouchPoints: 10 }, { finePointer: false }),
        'on a Windows tablet (real windows)');
}

// --- Fullscreen on a given document ---------------------------------------------
{
    const listeners = {};
    const doc = {
        fullscreenEnabled: true,
        fullscreenElement: null,
        addEventListener(type, fn) { (listeners[type] ||= new Set()).add(fn); },
        removeEventListener(type, fn) { listeners[type]?.delete(fn); },
    };
    const el = { requestFullscreen() {} };
    ok(fullscreenSupported(doc, el), 'supported with the standard API');
    ok(!fullscreenSupported({ fullscreenEnabled: false }, el), 'not supported when disabled');
    ok(fullscreenSupported({ webkitFullscreenEnabled: true }, { webkitRequestFullscreen() {} }), 'supported with the WebKit prefix');
    ok(!fullscreenSupported({ fullscreenEnabled: true }, {}), 'not supported without a request method');
    ok(!isDocumentFullscreen(doc), 'not in full screen');
    ok(isDocumentFullscreen({ webkitFullscreenElement: {} }), 'in full screen, WebKit-prefixed');

    let calls = 0;
    const stop = onFullscreenChange(doc, () => calls++);
    for (const fn of listeners.fullscreenchange) fn();
    for (const fn of listeners.webkitfullscreenchange) fn();
    ok(calls === 2, 'hears both change events');
    stop();
    ok(listeners.fullscreenchange.size === 0 && listeners.webkitfullscreenchange.size === 0, 'stops listening');
}

// --- The pointer the external window draws ---------------------------------------
{
    const base = { pointer3dX: 0.25, pointer3dY: 0.75, pointer3dParallax: 0.03, pointer3dVisible: false, pointerOverImage: false };
    let p = externalPointer({ ...base, pointer3dEnabled: true, pointer3dVisible: true });
    ok(p.enabled === 1 && p.x === 0.25 && p.y === 0.75 && p.parallax === 0.03, '3D pointer on: drawn as on the page, with its parallax');
    p = externalPointer({ ...base, pointer3dEnabled: true, pointer3dVisible: false, pointerOverImage: true });
    ok(p.enabled === 0, '3D pointer on but off the image: not drawn');
    p = externalPointer({ ...base, pointer3dEnabled: false, pointerOverImage: true });
    ok(p.enabled === 1 && p.x === 0.25 && p.y === 0.75 && p.parallax === 0, '3D pointer off: the mouse as a flat arrow (zero parallax)');
    p = externalPointer({ ...base, pointer3dEnabled: false, pointerOverImage: false });
    ok(p.enabled === 0, '3D pointer off and the mouse off the image: not drawn');
    p = externalPointer({ pointer3dEnabled: true, pointer3dVisible: true, pointer3dX: NaN, pointer3dY: undefined, pointer3dParallax: Infinity });
    ok(p.x === 0.5 && p.y === 0.5 && p.parallax === 0, 'non-finite values do not reach the shader');
}

// --- Wiring checked in the source (these modules pull in three.js/WebGL) ----------
// The release runs these tests on its built tree, where terser has stripped the
// comments and re-printed the code (objects across lines, 0.0 as 0, an arrow function
// argument wrapped in parentheses, { failure } as { failure: failure }). So the source
// is compared with its comments removed and every run of whitespace made one space,
// and the patterns below accept both forms.
{
    const raw = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
    const code = (rel) => raw(rel)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
        .replace(/\s+/g, ' ');

    const pointer = code('js/ui/ui-pointer3d.js');
    ok(/if \(!state\.pointer3dEnabled && !state\.externalOutputOpen\) return;/.test(pointer),
        'the mouse is tracked while the external window is open, 3D pointer or not');
    ok(/function handlePointerMouseLeave\(\) \{ state\.pointer3dVisible = false; state\.pointerOverImage = false;/.test(pointer),
        'leaving the canvas hides the external pointer');
    ok(/if \(!state\.renderer \|\| !state\.mesh \|\| !state\.material\?\.uniforms\) return null;/.test(pointer),
        'the pointer is not computed on the fallback material without uniforms');
    ok(/document\.addEventListener\('visibilitychange', \(?\(\) => \{ if \(!document\.hidden \|\| !state\.externalOutputOpen\) return; state\.pointerOverImage = false;/.test(pointer),
        'the page going out of sight takes the pointer out of the external window, and only while it is open');

    const output = code('js/rendering/external-output.js');
    const windowSrc = code('js/ui/external-window.js');
    ok(/return \{ window: null, failure: 'blocked' \};/.test(windowSrc) && /return \{ window: null, failure: 'unusable' \};/.test(windowSrc)
        && /if \(!win\) return \{ output: null, failure(?:: failure)? \};/.test(output) && /return \{ output: null, failure: 'webgl' \};/.test(output),
        'opening tells a refused pop-up from a window that would not take its contents and from a refused WebGL context');
    ok(/if \(!ExternalWindow\.reachable\(win\)\) return unusable\(win\);/.test(windowSrc),
        'a window opened just now that cannot be written into is closed, not left empty');
    ok(/output\.draw\(\{ render: !output\.hidden\(\) \}\);/.test(code('js/ui/ui-external-output.js')),
        'out of sight the external window is not drawn, but follows the page (no replaced image kept alive)');
    ok(/if \(render\) this\.track\(\(?\(\) => this\.renderer\.render\(this\.scene, this\.camera\)\)?\); this\.pruneHooks\(\);/.test(output),
        'dead dispose hooks are dropped whether or not a frame was drawn');
    ok(/if \(this\.material\) \{ this\.material\.dispose\(\); this\.forgetLastRender\(\); \}/.test(output)
        && /this\.source = null; \} this\.forgetLastRender\(\); \}/.test(output)
        && /forgetLastRender\(\) \{ try \{ this\.renderer\.renderLists\.dispose\(\);/.test(output),
        'a replaced material is not kept by three\'s render list from the last frame drawn');
    ok(/window\.addEventListener\('stereo-image-loaded', \(?\(\) => \{ if \(!output \|\| output\.closed \|\| state\.externalOutputHold\) return; try \{ output\.draw\(\{ render: false \}\);/.test(code('js/ui/ui-external-output.js')),
        'a new image is followed even while nothing is in sight and the loop is stopped');
    ok(/if \(dst\.gridEnabled\) dst\.gridEnabled\.value = 0(?:\.0)?;/.test(output), 'the grid is never drawn in the external window');
    ok(/const p = externalPointer\(state\);/.test(output), 'the external window draws externalPointer');
    // Dispose hooks: dead entries go every frame, not only past a threshold.
    const trackBody = output.slice(output.indexOf('track(drawing) {'), output.indexOf('release() {'));
    ok(trackBody.length > 0 && !/prunedAt/.test(output) && /hooks\.length = kept;/.test(trackBody),
        'entries for objects the page disposed are dropped on every draw');
    ok(/externalFraming\(\{/.test(output) && /if \(is3DTVActive\(\)\) \{/.test(output),
        'outside 3DTV the plane is framed by what the page shows');

    const controller = code('js/ui/ui-external-output.js');
    ok(/result\.failure === 'webgl'/.test(controller) && /externalOutput\.webglFailed/.test(controller)
        && /result\.failure === 'unusable'/.test(controller) && /externalOutput\.unusable/.test(controller),
        'neither a refused WebGL context nor an unusable window is reported as a pop-up blocker');
    ok(/window\.t\?\.\(key, \{ defaultValue: fallback \}\) \?\? fallback/.test(controller),
        'the English text is the defaultValue, so no raw key shows before i18next is ready');
    ok(/if \(isExternalOutputOpen\(\)\) \{ closeExternalOutput\(\); return; \} if \(output\) output\.close\(\); openExternalOutput\(\);/.test(controller),
        'a window closed by hand and not yet noticed does not swallow the next click');

    const vr = code('js/rendering/vr.js');
    const closeAt = vr.indexOf('closeExternalOutput();');
    const requestAt = vr.indexOf("navigator.xr.requestSession('immersive-vr'");
    ok(closeAt > 0 && requestAt > closeAt, 'entering VR closes the external window first');
    const started = vr.slice(vr.indexOf('async function onSessionStarted'));
    const closeInStart = started.indexOf('closeExternalOutput();');
    ok(closeInStart > 0 && closeInStart < started.indexOf('state.renderer.xr.enabled = true;'),
        'a window opened while the VR session was starting is closed when it starts');

    const ui = code('js/ui/ui.js');
    ok(/setupExternalOutputControls\(signal\);/.test(ui), 'ui.js wires the external output buttons');

    const main = code('js/main.js');
    ok(/renderExternalOutput\(\);/.test(main), 'the render loop draws the external window');
    ok(/addEventListener\('external-output-frames', refreshAnimationLoop\)/.test(main),
        'the render loop re-aims its frames when the external window opens, closes or changes sight');

    ok(/if \(output\.foreign\(\)\) \{ output\.close\(\); return; \}/.test(controller),
        'a window gone to another site is closed at once, not drawn into');
    ok(/if \(this\.mesh \|\| this\.material\) \{/.test(output),
        'with no image, the plane and material are let go once, not every frame');
    ok(/doc\.documentElement\.lang = this\.opener\.document\.documentElement\.lang/.test(windowSrc),
        'the window\'s document is in the page\'s language');
    ok(!/aria-pressed/.test(controller.slice(controller.indexOf('const menuBtn'), controller.indexOf('const viewerBtn'))),
        'the menu button, whose label says what it does, is not also a toggle');
    ok(/viewerBtn\.setAttribute\('aria-pressed', String\(open\)\)/.test(controller) && !/viewerBtn\.(title|setAttribute\('aria-label')/.test(controller),
        'the viewer bar button keeps its name and toggles aria-pressed');

    const html = raw('index.html');
    ok(!/id="externalOutputBtn"[^>]*aria-pressed/.test(html), 'the menu button carries no aria-pressed');
    ok(/id="viewerExternalOutputBtn"[^>]*data-i18n="\[aria-label\]externalOutput\.button"[^>]*aria-pressed="false"/.test(html),
        'the viewer bar button\'s accessible name is translated, and it starts not pressed');
    ok(/id="externalOutputGroup"[^>]*class="[^"]*\bhidden\b|class="[^"]*\bhidden\b[^"]*" id="externalOutputGroup"/.test(html),
        'the menu button starts hidden (shown only where offered)');
    ok(/id="viewerExternalOutputBtn" class="[^"]*\bhidden\b/.test(html), 'the viewer button starts hidden');

    // Every externalOutput.* key the page and the module use exists in each locale.
    const used = new Set([
        ...[...html.matchAll(/data-i18n(?:-title)?="(?:\[[\w-]+\])?externalOutput\.(\w+)"/g)].map(m => m[1]),
        ...[...controller.matchAll(/t\('externalOutput\.(\w+)'/g)].map(m => m[1]),
    ]);
    ok(used.size >= 10, 'found the externalOutput keys in use');
    for (const lang of ['en', 'ja']) {
        const section = JSON.parse(raw(`locales/${lang}.json`)).externalOutput || {};
        const missing = [...used].filter(k => typeof section[k] !== 'string' || !section[k]);
        ok(missing.length === 0, `locales/${lang}.json has every externalOutput key in use (missing: ${missing.join(', ')})`);
    }

    const exportSrc = code('js/ui/ui-export.js');
    ok(/state\.externalOutputHold = true;/.test(exportSrc), 'an export holds the external window');
    ok(/\} finally \{ state\.externalOutputHold = false;/.test(exportSrc),
        'the hold is released first thing in the export\'s finally');
}

console.log(`external-window: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
