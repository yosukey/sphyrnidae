/**
 * tests/viewer-3dtv-zoom.test.mjs
 *
 * Committed, framework-free verification of the two halves of the viewer's 3DTV
 * zoom contract:
 *
 * 1. getViewerDisplayScale() (js/globals.js) — which of state.viewerScale,
 *    state.params.scale and their product the zoom readout must be computed from.
 *    Five call sites (the renderer's post-fit event, the post-load and
 *    canvas-resized refreshes in ui.js, the double-click fit in ui-input.js and
 *    the FIT button in ui-alignment.js) each used to inline this rule, and the
 *    ones that forgot the 3DTV case reported the mesh fit scale instead of the
 *    zoom the image is actually displayed at.
 *
 * 2. That every viewer entry point applies its display mode through
 *    applyViewerDisplayMode() (js/ui/ui-viewer.js) — the single place that turns
 *    3DTV on for a 3DTV-applicable mode in a viewer session. The ?src= path used
 *    to assign state.params.mode directly, so an image opened straight into a
 *    left/right display mode kept normal-mode zoom (the whole two-eye plane
 *    scaling as one, so the eyes appeared stuck together) until the user touched
 *    the mode dropdown. This half is a source-text check because the loaders pull
 *    in three.js/WebGL and cannot be imported under Node.
 *
 * Run:  node tests/viewer-3dtv-zoom.test.mjs
 * Exits non-zero if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { state, getViewerDisplayScale, is3DTVActive } from '../js/globals.js';
import { is3DTVModeApplicable, isSBSMode, modeSuffixes } from '../js/mode-utils.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

const readSource = (relPath) =>
    readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8');

/**
 * Prepare a module's source for the structural checks below.
 *
 * Two transforms, both required:
 * - Comments are dropped so a mention of a function in prose cannot stand in for
 *   a real call. These modules explain themselves at length — including naming
 *   the very handler this test looks for — so searching the raw text would pass
 *   even after the call itself was deleted. Only whole-line `//` comments are
 *   removed (plus block comments): a general line-comment strip would cut at a
 *   `//` inside a string or regex, and in the minified build — one long line —
 *   that would blank the rest of the file.
 * - Terser's boolean folding is undone. CI runs this suite against the RELEASE
 *   artifact, i.e. after `terser --compress` (no --mangle) has rewritten every
 *   source file in place, so `= true` reaches this test as `=!0`. Identifiers,
 *   property names and parameter names survive that pass, which is what makes
 *   these checks viable at all — but literals do not.
 * @param {string} src - JavaScript source
 * @returns {string} Comment-free source with folded booleans spelled out
 */
const prepareSource = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
    .replace(/!0\b/g, 'true')
    .replace(/!1\b/g, 'false');

/**
 * Put the shared state into a known zoom configuration.
 * @param {{mode:number, sbs3dtv:boolean, scale:number, viewerScale:number}} cfg - Zoom state
 */
function setZoomState({ mode, sbs3dtv, scale, viewerScale }) {
    state.params.mode = mode;
    state.params.sbs3dtv = sbs3dtv;
    state.params.scale = scale;
    state.viewerScale = viewerScale;
}

// ---- 3DTV: viewerScale alone ----
// In 3DTV mode updateMeshTransform() stretches the mesh to cover the screen and
// ignores state.params.scale entirely, so only the shader's per-eye UV zoom
// (viewerScale) changes what the viewer sees.
for (const mode of [7, 8, 9, 10, 16]) {
    setZoomState({ mode, sbs3dtv: true, scale: 0.67, viewerScale: 1.0 });
    ok(is3DTVModeApplicable(mode), `mode ${mode} is 3DTV-applicable (test premise)`);
    ok(getViewerDisplayScale() === 1.0,
        `mode ${mode} + 3DTV -> viewerScale (got ${getViewerDisplayScale()}, not the 0.67 mesh fit scale)`);

    setZoomState({ mode, sbs3dtv: true, scale: 0.67, viewerScale: 2.5 });
    ok(getViewerDisplayScale() === 2.5, `mode ${mode} + 3DTV, zoomed in -> viewerScale`);
}

// ---- Viewer SBS without 3DTV: the two scales compose ----
// Mesh scale and the shader's UV zoom stack in this path, matching the composite
// wheel-zoom handler in ui-input.js.
for (const mode of [3, 7, 8, 9, 12, 13]) {
    setZoomState({ mode, sbs3dtv: false, scale: 0.5, viewerScale: 3.0 });
    ok(isSBSMode(mode), `mode ${mode} is an SBS layout (test premise)`);
    ok(getViewerDisplayScale() === 1.5, `mode ${mode} without 3DTV -> scale * viewerScale`);
}

// ---- Non-SBS layouts: mesh scale alone ----
for (const mode of [0, 1, 2, 4, 5, 6, 11, 14, 15]) {
    setZoomState({ mode, sbs3dtv: false, scale: 0.8, viewerScale: 3.0 });
    ok(getViewerDisplayScale() === 0.8, `mode ${mode} -> scale only (viewerScale does not apply)`);
}

// ---- The sbs3dtv flag alone does not switch the rule ----
// LRL (12) and Matrix 2x2 (13) are left/right layouts that are deliberately NOT
// 3DTV-applicable, so a stale sbs3dtv flag must not divert them to viewerScale.
for (const mode of [12, 13]) {
    setZoomState({ mode, sbs3dtv: true, scale: 0.5, viewerScale: 3.0 });
    ok(!is3DTVActive(), `mode ${mode} is not 3DTV-active even with sbs3dtv set (test premise)`);
    ok(getViewerDisplayScale() === 1.5, `mode ${mode} + stale sbs3dtv -> still scale * viewerScale`);
}

// ---- The rule tracks is3DTVActive() for every mode the UI can select ----
// Guards against the branch order drifting away from the shader's own gate.
for (const modeKey of Object.keys(modeSuffixes)) {
    const mode = Number(modeKey);
    setZoomState({ mode, sbs3dtv: true, scale: 0.4, viewerScale: 2.0 });
    const expected = is3DTVActive()
        ? 2.0
        : (isSBSMode(mode) ? 0.8 : 0.4);
    ok(getViewerDisplayScale() === expected,
        `mode ${mode} follows is3DTVActive() (expected ${expected}, got ${getViewerDisplayScale()})`);
}

// ---- 3DTV is off by default, so every load has to re-apply it ----
// clearPreviousImageState() restores state.params from defaultParams on every
// load, which is why the viewer entry points must (re-)apply their display mode
// through applyViewerDisplayMode() AFTER the image loads rather than priming the
// flag before it.
ok(state.defaultParams.sbs3dtv === false, 'defaultParams.sbs3dtv is false (3DTV is re-applied per load)');

// ---- applyViewerDisplayMode() forces 3DTV on for a viewer session ----
{
    const viewerSrc = prepareSource(readSource('js/ui/ui-viewer.js'));
    const fnStart = viewerSrc.indexOf('export function applyViewerDisplayMode');
    ok(fnStart !== -1, 'applyViewerDisplayMode() found in js/ui/ui-viewer.js');
    if (fnStart !== -1) {
        // Bounded by the next export declaration, so the body cannot silently
        // swallow the rest of the module and pass vacuously. Searched as a
        // pattern rather than "\nexport ": the minified build is a single line.
        const rest = viewerSrc.slice(fnStart + 1);
        const nextExport = rest.search(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class)\b/);
        const body = nextExport === -1 ? viewerSrc.slice(fnStart) : viewerSrc.slice(fnStart, fnStart + 1 + nextExport);
        ok(body.length > 0 && body.length < viewerSrc.length, 'applyViewerDisplayMode() body extracted');
        ok(/state\.viewerMode\s*&&\s*is3DTVModeApplicable\(mode\)/.test(body),
            'applyViewerDisplayMode() gates on viewer mode + 3DTV applicability');
        ok(/state\.params\.sbs3dtv\s*=\s*true/.test(body),
            'applyViewerDisplayMode() turns 3DTV on for those modes');
    }
}

// ---- Every viewer entry point routes its display mode through that handler ----
// A bare `state.params.mode = ...` here renders in the right mode but leaves the
// zoom model behind, which is exactly the ?src= bug this test guards.
// Both loaders reach the handler through a dynamic import, so they are checked in
// two parts: that they pull the shared handler in (as an import binding or a
// property of the imported module) and that they actually invoke it. The
// invocation pattern allows a local alias (loader-external.js resolves the import
// before the load and calls it through applyViewerDisplayModeFn, keeping its
// stereo-image-loaded listener synchronous).
for (const entryPoint of ['js/loaders/loader-external.js', 'js/loaders/loader-viewer.js']) {
    const src = prepareSource(readSource(entryPoint));
    ok(/\bapplyViewerDisplayMode\b/.test(src),
        `${entryPoint} obtains the shared applyViewerDisplayMode handler in code`);
    ok(/\bapplyViewerDisplayMode\w*\s*\([^)]/.test(src),
        `${entryPoint} calls it to apply its display mode`);
}

console.log(`viewer-3dtv-zoom: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
