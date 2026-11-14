/**
 * tests/view-fit.test.mjs
 *
 * The plane-placement math in js/core/view-fit.js, shared by the page's renderer
 * (fitImageToWindow / updateMeshTransform) and the external output window.
 *
 * 1. Equivalence: meshBaseSize / fitScale / meshTransform return exactly what the
 *    renderer's former inline formulas returned (copied below as the reference), so
 *    moving them out changed nothing on the page.
 * 2. The external framing (externalFraming): everything of the image the page shows is
 *    in the external view, centred and as large as it fits; while the page shows the
 *    whole image that is the external view's fit, whatever the page's own size.
 * 3. The external pixel ratio: exact for interlace, capped at 2 otherwise.
 *
 * Run:  node tests/view-fit.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { meshBaseSize, fitScale, meshTransform, externalFraming, externalPixelRatio } from '../js/core/view-fit.js';

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

// --- The external framing: what the page shows, as large as it fits --------------
// The page as drawn: its plane (meshTransform) seen through its camera's frustum.
const pageCamera = (v) => ({ left: -FRUSTUM_H * (v.w / v.h) / 2, right: FRUSTUM_H * (v.w / v.h) / 2, top: FRUSTUM_H / 2, bottom: -FRUSTUM_H / 2 });
function frame(p, scale, panX, panY, page, ext, view = pageCamera(page)) {
    const mesh = meshTransform({ ...p, viewW: page.w, viewH: page.h, frustumH: FRUSTUM_H, scale, panX, panY });
    const t = externalFraming({ mesh, geomW: p.geomW, geomH: p.geomH, view, viewW: ext.w, viewH: ext.h, frustumH: FRUSTUM_H });
    return { mesh, t };
}
// The part of the image the page shows, in image coordinates (0..1), or null.
function visiblePart(p, mesh, page) {
    const v = pageCamera(page);
    const w = p.geomW * mesh.scaleX, h = p.geomH * mesh.scaleY;
    const u0 = Math.max(0, (v.left - (mesh.x - w / 2)) / w), u1 = Math.min(1, (v.right - (mesh.x - w / 2)) / w);
    const v0 = Math.max(0, (v.bottom - (mesh.y - h / 2)) / h), v1 = Math.min(1, (v.top - (mesh.y - h / 2)) / h);
    return (u1 > u0 && v1 > v0) ? { u0, u1, v0, v1 } : null;
}
// An image-coordinate box in a view's world coordinates, given the plane there.
function placed(p, t, part) {
    const w = p.geomW * t.scaleX, h = p.geomH * t.scaleY;
    return { x0: t.x + (part.u0 - 0.5) * w, x1: t.x + (part.u1 - 0.5) * w, y0: t.y + (part.v0 - 0.5) * h, y1: t.y + (part.v1 - 0.5) * h };
}
// Checks the framing's promises for one case; returns the part's share of the external view.
function checkFraming(label, p, scale, panX, panY, page, ext) {
    const { mesh, t } = frame(p, scale, panX, panY, page, ext);
    const halfW = FRUSTUM_H * (ext.w / ext.h) / 2, halfH = FRUSTUM_H / 2, eps = 1e-7;
    ok(near(t.scaleX / mesh.scaleX, t.scaleY / mesh.scaleY), `${label}: the image keeps its aspect`);
    const part = visiblePart(p, mesh, page) || { u0: 0, u1: 1, v0: 0, v1: 1 };
    const r = placed(p, t, part);
    ok(r.x0 >= -halfW - eps && r.x1 <= halfW + eps && r.y0 >= -halfH - eps && r.y1 <= halfH + eps,
        `${label}: everything the page shows is in the external view`);
    const share = Math.max((r.x1 - r.x0) / (2 * halfW), (r.y1 - r.y0) / (2 * halfH));
    // Never more magnified than the page: zoom relative to each view's own fit.
    const zoomPage = zoomInView(p, mesh, 2 * FRUSTUM_H * (page.w / page.h) / 2, FRUSTUM_H);
    const zoomExt = zoomInView(p, t, 2 * halfW, 2 * halfH);
    const maxZoom = Math.max(zoomPage, 1);
    ok(zoomExt <= maxZoom * (1 + 1e-9), `${label}: no more magnified than the page`);
    ok(near(share, 1, 1e-7) || near(zoomExt, maxZoom, 1e-7),
        `${label}: as large as it fits (touches the view's edges in one direction), or at the page's zoom`);
    ok(Math.abs((r.x0 + r.x1) / 2) < 1e-7 && Math.abs((r.y0 + r.y1) / 2) < 1e-7, `${label}: centred`);
    return { mesh, t, share, zoomExt, zoomPage };
}
// The image's zoom in a view of w x h world units, relative to its fit there.
function zoomInView(p, t, w, h) {
    const iw = Math.abs(p.geomW * t.scaleX), ih = Math.abs(p.geomH * t.scaleY);
    return ih / Math.min(h, (w * ih) / iw);
}
const sameT = (a, b) => near(a.scaleX, b.scaleX) && near(a.scaleY, b.scaleY) && near(a.x, b.x) && near(a.y, b.y);

// Random cases: layouts, crops, zoom (from zoomed out to well in), pans, both views' sizes.
for (let i = 0; i < 400; i++) {
    const p = { geomW: 10 * (0.4 + rnd() * 2.5), geomH: 10, baseScaleX: pick([1, 2, 3]), baseScaleY: pick([1, 2]), cropX: rnd() * 0.5, cropY: rnd() * 0.5, is3dtv: false };
    const page = { w: 400 + Math.floor(rnd() * 2400), h: 300 + Math.floor(rnd() * 1300) };
    const ext = { w: 640 + Math.floor(rnd() * 3200), h: 480 + Math.floor(rnd() * 1800) };
    const base = meshBaseSize(p);
    const pageFit = fitScale(page.w, page.h, base.width, base.height, FRUSTUM_H);
    checkFraming(`random case ${i}`, p, pageFit * (0.3 + rnd() * 4), (rnd() - 0.5) * 12, (rnd() - 0.5) * 12, page, ext);
}

const tvView = { w: 1920, h: 1080 };
const menuOpen = { w: 1680, h: 1080 }, menuClosed = { w: 1920, h: 1080 };
const extFitHeight = (p, ext) => { const b = meshBaseSize(p); return fitScale(ext.w, ext.h, b.width, b.height, FRUSTUM_H) * b.height; };

// The whole image on the page: the external view's fit, whatever the page's size.
for (const [name, p] of [['16:9 image', { geomW: 10 * 16 / 9, geomH: 10, baseScaleX: 1, baseScaleY: 1, cropX: 0, cropY: 0, is3dtv: false }],
                         ['parallel view, 4:3 eyes', { geomW: 10 * 4 / 3, geomH: 10, baseScaleX: 2, baseScaleY: 1, cropX: 0.1, cropY: 0.05, is3dtv: false }]]) {
    const b = meshBaseSize(p);
    const fitOpen = fitScale(menuOpen.w, menuOpen.h, b.width, b.height, FRUSTUM_H);
    const atFit = checkFraming(`${name} at fit`, p, fitOpen, 0, 0, menuOpen, tvView);
    ok(near(p.geomH * atFit.t.scaleY, extFitHeight(p, tvView)), `${name} at fit: the external view at its own fit`);
    // The menu closes: the page's plane stays as it is, only its view widens.
    const after = frame(p, fitOpen, 0, 0, menuClosed, tvView);
    ok(sameT(atFit.t, after.t), `${name}: hiding the page's panels moves nothing in the external view`);
    // Zoomed out and panned within the page: still the whole image at fit, centred.
    const out = checkFraming(`${name} zoomed out`, p, fitOpen * 0.7, 1.2, -0.8, menuOpen, tvView);
    ok(sameT(atFit.t, out.t), `${name}: zooming out or panning the whole image on the page keeps the external fit`);
}

// The case the former framing failed: a wide page zoomed in on a square image, shown
// on a 4:3 projector. Everything the page shows is there, larger than fit.
{
    const p = { geomW: 10, geomH: 10, baseScaleX: 1, baseScaleY: 1, cropX: 0, cropY: 0, is3dtv: false };
    const page = { w: 1920, h: 960 }, proj = { w: 1024, h: 768 };
    const fit = fitScale(page.w, page.h, 10, 10, FRUSTUM_H);
    const { t } = checkFraming('wide page zoomed in, 4:3 projector', p, fit * 2, 3, 0, page, proj);
    ok(p.geomH * t.scaleY > extFitHeight(p, proj) * 1.5, 'wide page zoomed in: the external view is zoomed in too');
}

// Zooming in on the page changes the external view continuously and never shrinks it.
{
    const p = { geomW: 10 * 3 / 2, geomH: 10, baseScaleX: 1, baseScaleY: 1, cropX: 0, cropY: 0, is3dtv: false };
    const b = meshBaseSize(p);
    const fit = fitScale(menuOpen.w, menuOpen.h, b.width, b.height, FRUSTUM_H);
    let prev = null, smooth = true, monotone = true;
    for (let f = 0.5; f <= 4; f *= 1.01) {
        const { t } = frame(p, fit * f, 0.3, -0.2, menuOpen, tvView);
        if (prev) {
            if (t.scaleY / prev > 1.0101 + 1e-9) smooth = false;
            if (t.scaleY < prev * (1 - 1e-12)) monotone = false;
        }
        prev = t.scaleY;
    }
    ok(smooth, 'zooming in: no jump in the external view');
    ok(monotone, 'zooming in: the external view never zooms out');
}

// The image dragged towards a corner of the page at fit, until it leaves the view:
// the external view never magnifies the sliver left on the page beyond the page's
// own zoom (at fit: 1), and changes without jumps until the image is gone.
{
    const p = { geomW: 10 * 16 / 9, geomH: 10, baseScaleX: 1, baseScaleY: 1, cropX: 0, cropY: 0, is3dtv: false };
    const page = { w: 1920, h: 1080 };
    const fit = fitScale(page.w, page.h, 10 * 16 / 9, 10, FRUSTUM_H);
    let maxSeen = 0, prev = null, smooth = true;
    for (let d = 0; d <= 1.0; d += 0.002) {
        // From the centre to just short of off-screen, along the diagonal.
        const panX = d * FRUSTUM_H * 16 / 9 * 0.999, panY = d * FRUSTUM_H * 0.999;
        const c = checkFraming(`dragged to the corner (${d.toFixed(3)})`, p, fit, panX, panY, page, tvView);
        maxSeen = Math.max(maxSeen, c.zoomExt);
        if (prev && Math.abs(c.t.scaleY / prev.t.scaleY - 1) > 0.02) smooth = false;
        prev = c;
    }
    ok(maxSeen <= 1 + 1e-9, `dragged to the corner: the external view stays at most at its fit (max ${maxSeen.toFixed(3)})`);
    ok(smooth, 'dragged to the corner: no jump in the external view on the way');
}

// Nothing of the image on the page, or no usable page view: the whole image at fit.
{
    const p = { geomW: 10 * 4 / 3, geomH: 10, baseScaleX: 1, baseScaleY: 1, cropX: 0, cropY: 0, is3dtv: false };
    const away = checkFraming('panned out of the page', p, 1, 40, 0, menuOpen, tvView);
    ok(near(p.geomH * away.t.scaleY, extFitHeight(p, tvView)) && near(away.t.x, 0), 'panned out of the page: the whole image at fit');
    const collapsed = frame(p, 1, 0, 0, menuOpen, tvView, { left: NaN, right: NaN, top: NaN, bottom: NaN });
    ok(near(p.geomH * collapsed.t.scaleY, extFitHeight(p, tvView)), 'no usable page view: the whole image at fit');
}

// 3DTV is not framed this way: the plane covers the external view, as the page's covers its own.
{
    const tv = { geomW: 10 * 4 / 3, geomH: 10, baseScaleX: 1, baseScaleY: 1, cropX: 0, cropY: 0, is3dtv: true, scale: 3, panX: 0, panY: 0 };
    const extT = meshTransform({ ...tv, viewW: 1920, viewH: 1080, frustumH: FRUSTUM_H });
    ok(near(extT.scaleX * tv.geomW, FRUSTUM_H * 1920 / 1080) && near(extT.scaleY * tv.geomH, FRUSTUM_H),
        '3DTV: the mesh covers the external frustum exactly');
}

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
