/**
 * tests/view-fit.test.mjs
 *
 * The plane-placement math in js/core/view-fit.js, shared by the page's renderer
 * (fitImageToWindow / updateMeshTransform) and the external output window.
 *
 * 1. Equivalence: meshBaseSize / fitScale / meshTransform return exactly what the
 *    renderer's former inline formulas returned (copied below as the reference), so
 *    moving them out changed nothing on the page.
 * 2. The external framing: scaling the page's framing by externalZoom keeps the same
 *    image point at the centre and the same zoom relative to fit.
 * 3. The external pixel ratio: exact for interlace, capped at 2 otherwise.
 *
 * Run:  node tests/view-fit.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { meshBaseSize, fitScale, meshTransform, externalZoom, externalPixelRatio } from '../js/core/view-fit.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

const FRUSTUM_H = 10;

// --- Reference: the renderer's inline formulas before the extraction ---------------
function refFit(p, viewW, viewH) {
    const cropRatioX = 1.0 - p.cropX;
    const cropRatioY = 1.0 - p.cropY;
    const meshBaseW = p.is3dtv ? p.geomW : p.geomW * p.baseScaleX * cropRatioX;
    const meshBaseH = p.is3dtv ? p.geomH : p.geomH * p.baseScaleY * cropRatioY;
    const frustumH = FRUSTUM_H;
    const aspect = viewW / viewH;
    const frustumW = frustumH * aspect;
    const margin = 1.0;
    const scaleW = (frustumW * margin) / meshBaseW;
    const scaleH = (frustumH * margin) / meshBaseH;
    return Math.min(scaleW, scaleH);
}
function refTransform(p, viewW, viewH) {
    const s = p.scale;
    const cropRatioX = 1.0 - p.cropX;
    const cropRatioY = 1.0 - p.cropY;
    let sx, sy;
    if (p.is3dtv) {
        const frustumH = FRUSTUM_H;
        const aspect = viewW / viewH;
        const frustumW = frustumH * aspect;
        sx = frustumW / p.geomW;
        sy = frustumH / p.geomH;
    } else {
        sx = p.baseScaleX * s * cropRatioX;
        sy = p.baseScaleY * s * cropRatioY;
    }
    return { scaleX: sx, scaleY: sy, x: p.panX, y: p.panY };
}

// Deterministic pseudo-random inputs (LCG) so a failure reproduces.
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

for (let i = 0; i < 500; i++) {
    const p = {
        geomW: 10 * (0.3 + rnd() * 3),
        geomH: 10,
        baseScaleX: pick([1, 2, 3]),
        baseScaleY: pick([1, 2]),
        cropX: rnd() * 0.6,
        cropY: rnd() * 0.6,
        is3dtv: rnd() < 0.3,
        scale: 0.1 + rnd() * 5,
        panX: (rnd() - 0.5) * 20,
        panY: (rnd() - 0.5) * 20,
    };
    const viewW = 200 + Math.floor(rnd() * 3000);
    const viewH = 200 + Math.floor(rnd() * 2000);

    const base = meshBaseSize(p);
    const got = fitScale(viewW, viewH, base.width, base.height, FRUSTUM_H);
    ok(got === refFit(p, viewW, viewH), `fitScale identical to the former inline formula (case ${i})`);

    const t = meshTransform({ ...p, viewW, viewH, frustumH: FRUSTUM_H });
    const r = refTransform(p, viewW, viewH);
    ok(t.scaleX === r.scaleX && t.scaleY === r.scaleY && t.x === r.x && t.y === r.y,
        `meshTransform identical to the former inline formula (case ${i})`);
}

// --- The external framing ---------------------------------------------------------
{
    // A 4:3 eye image in parallel view (baseScaleX 2), page 1600x900, zoomed 1.7x
    // from fit and panned. The external window is 1920x1080 (same aspect) and then
    // 1920x1200 (taller).
    const p = { geomW: 10 * 4 / 3, geomH: 10, baseScaleX: 2, baseScaleY: 1, cropX: 0.1, cropY: 0.05, is3dtv: false };
    const base = meshBaseSize(p);
    const pageFit = fitScale(1600, 900, base.width, base.height, FRUSTUM_H);
    const page = { ...p, scale: pageFit * 1.7, panX: 1.2, panY: -0.4 };
    const pageT = meshTransform({ ...page, viewW: 1600, viewH: 900, frustumH: FRUSTUM_H });

    // Same aspect: identical picture.
    {
        const extFit = fitScale(1920, 1080, base.width, base.height, FRUSTUM_H);
        const k = externalZoom(pageFit, extFit);
        ok(near(k, 1), 'same aspect: externalZoom is 1');
        const extT = meshTransform({ ...page, viewW: 1920, viewH: 1080, frustumH: FRUSTUM_H, zoom: k });
        ok(near(extT.scaleX, pageT.scaleX) && near(extT.x, pageT.x), 'same aspect: same mesh transform');
    }

    // Another aspect: same zoom relative to fit, and the point at the view centre
    // (world origin) is the same image point.
    {
        const extFit = fitScale(1920, 1200, base.width, base.height, FRUSTUM_H);
        const k = externalZoom(pageFit, extFit);
        const extT = meshTransform({ ...page, viewW: 1920, viewH: 1200, frustumH: FRUSTUM_H, zoom: k });
        ok(near(extT.scaleX / extFit, pageT.scaleX / pageFit), 'other aspect: same zoom relative to fit');
        // Image-relative coordinate of the world origin: (0 - centre) / mesh width.
        const uPage = (0 - pageT.x) / pageT.scaleX;
        const uExt = (0 - extT.x) / extT.scaleX;
        const vPage = (0 - pageT.y) / pageT.scaleY;
        const vExt = (0 - extT.y) / extT.scaleY;
        ok(near(uPage, uExt) && near(vPage, vExt), 'other aspect: the same image point at the view centre');
    }

    // Viewer mode sets scale to the page's fit: the external window then shows its own fit.
    {
        const extFit = fitScale(1280, 1024, base.width, base.height, FRUSTUM_H);
        const k = externalZoom(pageFit, extFit);
        const extT = meshTransform({ ...p, scale: pageFit, panX: 0, panY: 0, viewW: 1280, viewH: 1024, frustumH: FRUSTUM_H, zoom: k });
        const fitT = meshTransform({ ...p, scale: extFit, panX: 0, panY: 0, viewW: 1280, viewH: 1024, frustumH: FRUSTUM_H });
        ok(near(extT.scaleX, fitT.scaleX) && near(extT.scaleY, fitT.scaleY), 'page at fit: external window at its own fit');
    }

    // 3DTV: the mesh covers the external window's own frustum, whatever the page's.
    {
        const tv = { ...p, is3dtv: true, scale: 3, panX: 0, panY: 0 };
        const extT = meshTransform({ ...tv, viewW: 1920, viewH: 1080, frustumH: FRUSTUM_H, zoom: 2 });
        ok(near(extT.scaleX * tv.geomW, FRUSTUM_H * 1920 / 1080) && near(extT.scaleY * tv.geomH, FRUSTUM_H),
            '3DTV: the mesh covers the external frustum exactly');
    }
}

// externalZoom falls back to 1 when a view is collapsed or the page has no mesh.
ok(externalZoom(NaN, 2) === 1, 'externalZoom: NaN page fit gives 1');
ok(externalZoom(0, 2) === 1, 'externalZoom: zero page fit gives 1');
ok(externalZoom(2, Infinity) === 1, 'externalZoom: infinite other fit gives 1');
ok(externalZoom(2, 3) === 1.5, 'externalZoom: ratio of the two fits');

// --- The external pixel ratio ------------------------------------------------------
ok(externalPixelRatio(1, 3) === 3, 'horizontal interlace: the window ratio, uncapped');
ok(externalPixelRatio(2, 2.5) === 2.5, 'vertical interlace: the window ratio, uncapped');
ok(externalPixelRatio(1, 1.25) === 1.25, 'interlace: a fractional ratio as is');
ok(externalPixelRatio(0, 3) === 2, 'anaglyph: capped at 2');
ok(externalPixelRatio(7, 1.5) === 1.5, 'half SBS: below the cap as is');
ok(externalPixelRatio(1, 0) === 1 && externalPixelRatio(0, NaN) === 1, 'unusable ratio: 1');

// --- The renderer uses the shared math ---------------------------------------------
{
    const src = readFileSync(fileURLToPath(new URL('../js/rendering/renderer.js', import.meta.url)), 'utf8');
    ok(/from '\.\.\/core\/view-fit\.js'/.test(src), 'renderer.js imports view-fit.js');
    ok(/meshTransform\(\{/.test(src), 'updateMeshTransform uses meshTransform');
    ok(/computeFitScale\(containerWidth, containerHeight/.test(src), 'fitImageToWindow uses fitScale');
}

console.log(`view-fit: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
