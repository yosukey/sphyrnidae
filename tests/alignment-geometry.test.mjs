/**
 * tests/alignment-geometry.test.mjs
 *
 * Committed, framework-free verification for the geometric-refinement math in
 * js/rendering/alignment-geometry.js (the optional, default-OFF vertical-affine
 * auto-alignment refinement). Pure functions only — no DOM, no OpenCV, no WebGL.
 *
 * Run:  node tests/alignment-geometry.test.mjs
 * Exits non-zero if any assertion fails.
 *
 * Covers:
 *  - estimateVerticalAffine: parameter recovery, exact matrix inverse (depth
 *    preserved), and every model-selection fallback gate.
 *  - isIdentityAlign.
 *  - verticalCropFromSampling: EXACT reduction to the prior shift-only crop
 *    (|shiftY|, shiftY) for the identity matrix (regression-safety), and a sound
 *    black-free crop window for an adopted affine matrix.
 */

import {
    estimateVerticalAffine,
    isIdentityAlign,
    verticalCropFromSampling,
    cropWindowToAnalysisRect,
    rotZoomToAlignTransform,
    alignTransformToRotZoom,
    clampCropWindow,
    splitVerticalShift,
    composeManualCropWindow,
} from '../js/rendering/alignment-geometry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Deterministic pseudo-random (reproducible; no Math.random).
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const gauss = (s) => {
    const u1 = Math.max(1e-9, rnd()), u2 = rnd();
    return s * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
};

// Apply a column-major mat3 the way the GLSL shader does: src = M*[x,y,1], /z.
function applyMat(M, x, y) {
    const sx = M[0] * x + M[3] * y + M[6];
    const sy = M[1] * x + M[4] * y + M[7];
    const sz = M[2] * x + M[5] * y + M[8];
    return [sx / sz, sy / sz];
}

// Build a disparity field disp = dT*u + eT*v + fT (u,v = left/display position),
// where dT ~ roll gradient, eT ~ vertical-zoom gradient, fT ~ constant disparity.
function makePoints(dT, eT, fT, { n = 300, noise = 0.0008, outlierFrac = 0.1 } = {}) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const u = rnd(), v = rnd();
        let t = dT * u + eT * v + fT + gauss(noise);
        let dist = 20 + rnd() * 30;
        if (rnd() < outlierFrac) { t += (rnd() - 0.5) * 0.4; dist = 80 + rnd() * 40; }
        pts.push({ u, v, t, dist });
    }
    return pts;
}

// ---- estimateVerticalAffine: recover a known disparity field & verify the matrix ----
{
    const dT = 0.05, eT = 0.02, fT = 0.10; // roll gradient, vzoom gradient, constant disp
    const r = estimateVerticalAffine(makePoints(dT, eT, fT));
    ok(r.adopted, 'adopt field for clear roll+zoom');
    ok(Math.abs(r.d - dT) < 0.012, `recover d (got ${r.d})`);
    ok(Math.abs(r.e - eT) < 0.012, `recover e (got ${r.e})`);
    ok(Math.abs(r.f - fT) < 0.012, `recover f (got ${r.f})`);
    ok(r.residualTier1 < r.residualTier0, 'field residual beats shift-only');

    // The matrix must realize srcR.y = uv.y - (d*u + e*v + f) and leave horizontal
    // untouched (depth preserved). This is the SHADER's actual mapping, so it pins
    // the vertical sign (generalization of the proven srcR.y = uv.y - shiftY).
    let maxVErr = 0, maxHErr = 0;
    for (let i = 0; i < 50; i++) {
        const u = rnd(), v = rnd();
        const expectedY = v - (r.d * u + r.e * v + r.f);
        const [sx, sy] = applyMat(r.matrix, u, v);
        maxHErr = Math.max(maxHErr, Math.abs(sx - u));
        maxVErr = Math.max(maxVErr, Math.abs(sy - expectedY));
    }
    ok(maxHErr < 1e-12, `horizontal preserved exactly (depth), got ${maxHErr}`);
    ok(maxVErr < 1e-12, `srcR.y == uv.y - field (sign-correct), got ${maxVErr}`);
    ok(r.matrix[2] === 0 && r.matrix[5] === 0 && r.matrix[8] === 1,
        'matrix has constant denominator [*,*,1] (no perspective division)');
    // Constant-only field must reduce to the shift-only transform: srcR.y = uv.y - f.
    ok(approx(r.matrix[1], -r.d) && approx(r.matrix[4], 1 - r.e) && approx(r.matrix[7], -r.f),
        'matrix rows match [1,-d,0, 0,1-e,0, 0,-f,1]');
}

// ---- Sign anchor: a pure constant disparity reproduces srcR.y = uv.y - shiftY ----
// (Adoption is gated out for pure shift, so verify the math directly via a strong
// field that is then evaluated at the constant limit.)
{
    // A field with only a constant term, built by hand, must give m12 = -f so that
    // srcR.y = uv.y - f. This is the invariant that makes the vertical sign correct.
    const f = 0.123;
    const M = [1, 0, 0, 0, 1, 0, 0, -f, 1]; // d=e=0
    const [sx, sy] = applyMat(M, 0.4, 0.7);
    ok(approx(sx, 0.4) && approx(sy, 0.7 - f), 'constant field => srcR.y = uv.y - f (shift-only sign)');
}

// ---- Fallback gates ----
{
    // Constant disparity with tiny residual -> already comfortable, no field.
    const r = estimateVerticalAffine(makePoints(0, 0, 0.02, { noise: 0.0002, outlierFrac: 0.05 }));
    ok(!r.adopted && r.reason === 'already_aligned', `already-aligned (got ${r.reason})`);
}
{
    // Constant disparity with real noise -> a field adds nothing over shift-only.
    const r = estimateVerticalAffine(makePoints(0, 0, 0.03, { noise: 0.001, outlierFrac: 0.05 }));
    ok(!r.adopted, `pure shift -> not adopted (got ${r.reason})`);
}
{
    const r = estimateVerticalAffine([{ u: 0.1, v: 0.2, t: 0.2, dist: 1 }]);
    ok(!r.adopted && r.reason === 'too_few_points', 'too few points');
}
{
    const r = estimateVerticalAffine(makePoints(0.5, 0.0, 0.0));
    ok(!r.adopted && r.reason === 'out_of_range', 'extreme roll rejected (clamp)');
}
{
    const pts = [];
    for (let i = 0; i < 200; i++) {
        const u = rnd();
        const v = 0.5 + gauss(0.005); // almost no vertical spread
        pts.push({ u, v, t: 0.05 * u + 0.02 * v + 0.01 + gauss(0.0008), dist: 20 + rnd() * 10 });
    }
    ok(!estimateVerticalAffine(pts).adopted, 'poor spatial spread -> not adopted');
}

// ---- isIdentityAlign ----
ok(isIdentityAlign([1, 0, 0, 0, 1, 0, 0, 0, 1]), 'identity recognized');
ok(isIdentityAlign(null), 'null treated as identity (defensive)');
ok(isIdentityAlign([1, 0, 0, 0, 1]), 'short array treated as identity (defensive)');
ok(!isIdentityAlign([1, 0.05, 0, 0, 1, 0, 0, -0.01, 1]), 'non-identity recognized');

// ---- verticalCropFromSampling: EXACT reduction to shift-only for identity ----
{
    const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    for (const s of [0, 0.03, -0.03, 0.1, -0.075]) {
        const { cropY, offsetY } = verticalCropFromSampling(I, s);
        ok(approx(cropY, Math.abs(s)), `identity+shiftY=${s}: cropY==|shiftY| (got ${cropY})`);
        ok(approx(offsetY, s), `identity+shiftY=${s}: offsetY==shiftY (got ${offsetY})`);
    }
    // Defensive: bad matrix falls back to shift-only.
    const fb = verticalCropFromSampling(null, 0.04);
    ok(approx(fb.cropY, 0.04) && approx(fb.offsetY, 0.04), 'bad matrix -> shift-only fallback');
}

// ---- verticalCropFromSampling: adopted matrix yields a black-free crop window ----
{
    const r = estimateVerticalAffine(makePoints(0.08, -0.03, 0.06, { n: 400 }));
    ok(r.adopted, 'setup: matrix adopted for crop-window test');
    const { cropY, offsetY } = verticalCropFromSampling(r.matrix, 0); // shiftY=0 when adopted
    ok(cropY >= 0 && cropY < 1, `cropY in [0,1) (got ${cropY})`);

    // Shader window in originalUv.y: [marginLo, 1-marginHi].
    const marginLo = (cropY + offsetY) / 2;
    const marginHi = (cropY - offsetY) / 2;
    const lo = marginLo, hi = 1 - marginHi;
    ok(hi > lo, 'crop window is non-empty');

    // For every display point in the cropped window, srcR.y must be within [0,1]
    // (no black). Affine is linear, so corners of the window bound the extremes.
    const eps = 1e-6;
    let worst = 0, inRange = true;
    for (const v of [lo, hi]) {
        for (const u of [0, 1]) {
            const [, sy] = applyMat(r.matrix, u, v);
            if (sy < -eps || sy > 1 + eps) inRange = false;
            worst = Math.max(worst, Math.max(0, -sy, sy - 1));
        }
    }
    ok(inRange, `cropped window keeps srcR.y in [0,1] (worst excursion ${worst})`);

    // Tightness: the crop is no looser than necessary. Where a margin was applied
    // (marginLo/marginHi > 0), the corresponding window edge must sit exactly on a
    // sampling boundary — min srcR.y == 0 at the lo edge, max srcR.y == 1 at the hi
    // edge (over u in [0,1]; affine -> extremes at u in {0,1}).
    const syAt = (v) => {
        const a = applyMat(r.matrix, 0, v)[1];
        const b = applyMat(r.matrix, 1, v)[1];
        return { min: Math.min(a, b), max: Math.max(a, b) };
    };
    if (marginLo > 1e-4) ok(approx(syAt(lo).min, 0, 1e-6), 'lo edge sits on srcR.y=0 (tight)');
    if (marginHi > 1e-4) ok(approx(syAt(hi).max, 1, 1e-6), 'hi edge sits on srcR.y=1 (tight)');
}

// ---- cropWindowToAnalysisRect: crop window -> analysis ROI (px, top-origin) ----
{
    const W = 512, H = 384;

    // No crop -> full frame, not restricted.
    const none = cropWindowToAnalysisRect({ cropX: 0, cropY: 0, offsetX: 0, offsetY: 0 }, W, H);
    ok(!none.restricted && none.x === 0 && none.y === 0 && none.width === W && none.height === H,
        'no crop -> full frame');
    ok(none.reason === 'no_crop', 'no crop reason');

    // Missing/NaN params -> full frame (defensive).
    ok(!cropWindowToAnalysisRect({}, W, H).restricted, 'empty params -> full frame');
    ok(cropWindowToAnalysisRect({ cropX: NaN }, W, H).reason === 'invalid_params',
        'NaN param -> full frame');

    // Centered symmetric crop: cropX=0.2 -> x window UV [0.1, 0.9].
    const sym = cropWindowToAnalysisRect({ cropX: 0.2, cropY: 0, offsetX: 0, offsetY: 0 }, W, H);
    ok(sym.restricted, 'symmetric crop restricts');
    ok(sym.x === Math.floor(0.1 * W) && sym.x + sym.width === Math.ceil(0.9 * W),
        `symmetric crop x window (got x=${sym.x}, w=${sym.width})`);
    ok(sym.y === 0 && sym.height === H, 'symmetric x-crop leaves y full');

    // flipY: visible UV y in [0.2, 1.0] (upper 80% visually) must map to the TOP
    // rows [0, 0.8H) in top-origin pixel space. cropY=0.2, offsetY=+0.2 ->
    // y0u=(0.2+0.2)/2=0.2, y1u=1-(0.2-0.2)/2=1.
    const flip = cropWindowToAnalysisRect({ cropX: 0, cropY: 0.2, offsetX: 0, offsetY: 0.2 }, W, H);
    ok(flip.restricted, 'y crop restricts');
    ok(flip.y === 0 && flip.y + flip.height === Math.ceil(0.8 * H),
        `flipY: UV window [0.2,1] -> pixel rows [0, 0.8H) (got y=${flip.y}, h=${flip.height})`);

    // Mirror case: visible UV y in [0, 0.8] (lower 80%) -> BOTTOM rows [0.2H, H).
    const flip2 = cropWindowToAnalysisRect({ cropX: 0, cropY: 0.2, offsetX: 0, offsetY: -0.2 }, W, H);
    ok(flip2.y === Math.floor(0.2 * H) && flip2.y + flip2.height === H,
        `flipY mirror: UV window [0,0.8] -> pixel rows [0.2H, H) (got y=${flip2.y}, h=${flip2.height})`);

    // Post-alignment auto-crop params (applyManualCrop with shiftX>0):
    // cropX=2s, offsetX=2s -> x window UV [2s, 1].
    const s = 0.05;
    const ac = cropWindowToAnalysisRect({ cropX: 2 * s, cropY: 0, offsetX: 2 * s, offsetY: 0 }, W, H);
    ok(ac.x === Math.floor(2 * s * W) && ac.x + ac.width === W,
        `auto-crop params -> x window [2s, 1] (got x=${ac.x}, w=${ac.width})`);

    // Out-of-range offset is clamped to the frame.
    const cl = cropWindowToAnalysisRect({ cropX: 0.1, cropY: 0, offsetX: 1.5, offsetY: 0 }, W, H);
    ok(!cl.restricted || (cl.x >= 0 && cl.x + cl.width <= W), 'window clamped to frame');

    // Degenerate: crop leaves nothing visible.
    ok(cropWindowToAnalysisRect({ cropX: 2.5, cropY: 0, offsetX: 0, offsetY: 0 }, W, H)
        .reason === 'degenerate_window', 'empty window -> full-frame fallback');

    // Too small: sliver window falls back to the full frame.
    const tiny = cropWindowToAnalysisRect({ cropX: 0.99, cropY: 0, offsetX: 0, offsetY: 0 }, W, H);
    ok(!tiny.restricted && tiny.reason === 'too_small_fallback',
        `sliver window -> too_small_fallback (got ${tiny.reason})`);

    // The rect never drops visible pixels (floor/ceil grow outward).
    const grow = cropWindowToAnalysisRect({ cropX: 0.333, cropY: 0.333, offsetX: 0.1, offsetY: -0.05 }, W, H);
    {
        const x0u = (0.333 + 0.1) / 2, x1u = 1 - (0.333 - 0.1) / 2;
        const y0u = (0.333 - 0.05) / 2, y1u = 1 - (0.333 + 0.05) / 2;
        ok(grow.x <= x0u * W && grow.x + grow.width >= x1u * W, 'x rect encloses UV window');
        ok(grow.y <= (1 - y1u) * H && grow.y + grow.height >= (1 - y0u) * H, 'y rect encloses UV window');
    }
}

// ---- rotZoomToAlignTransform / alignTransformToRotZoom (URL r/z round-trip) ----
{
    // Zero rotation/zoom -> identity matrix (no r/z emitted on export).
    const id = rotZoomToAlignTransform(0, 0);
    ok(isIdentityAlign(id), 'rotZoom(0,0) is identity');

    // The matrix must match the estimateVerticalAffine convention exactly:
    //   d = tan(rotDeg), matrix = [1, -d, 0, 0, 1-e, 0, 0, 0, 1], f = 0.
    const rotDeg = 2.5, zoomPct = 1.8;
    const m = rotZoomToAlignTransform(rotDeg, zoomPct);
    const dExpected = Math.tan(rotDeg * Math.PI / 180);
    ok(approx(m[0], 1) && approx(m[3], 0) && approx(m[6], 0), 'top row identity (depth preserved)');
    ok(approx(m[1], -dExpected), `m10 = -tan(rot) (got ${m[1]})`);
    ok(approx(m[4], 1 - zoomPct / 100), `m11 = 1 - e (got ${m[4]})`);
    ok(approx(m[7], 0) && approx(m[8], 1), 'no folded constant (f=0), projective denom 1');

    // Round-trip: decompose(build(r,z)) == (r,z).
    const back = alignTransformToRotZoom(m);
    ok(approx(back.rotationDeg, rotDeg, 1e-9), `round-trip rotation (got ${back.rotationDeg})`);
    ok(approx(back.zoomPct, zoomPct, 1e-9), `round-trip zoom (got ${back.zoomPct})`);

    // Negative values round-trip too.
    const m2 = rotZoomToAlignTransform(-3.2, -0.75);
    const back2 = alignTransformToRotZoom(m2);
    ok(approx(back2.rotationDeg, -3.2, 1e-9), 'round-trip negative rotation');
    ok(approx(back2.zoomPct, -0.75, 1e-9), 'round-trip negative zoom');

    // An adopted affine from estimateVerticalAffine decomposes to its rollDeg/zoomPct
    // (the folded constant f is intentionally dropped — the exporter folds it into y).
    const est = estimateVerticalAffine(makePoints(0.05, 0.02, 0.10));
    ok(est.adopted, 'adopt affine for decomposition check');
    const rz = alignTransformToRotZoom(est.matrix);
    ok(approx(rz.rotationDeg, est.rollDeg, 1e-9), `decompose matches rollDeg (got ${rz.rotationDeg} vs ${est.rollDeg})`);
    ok(approx(rz.zoomPct, est.zoomPct, 1e-9), `decompose matches zoomPct (got ${rz.zoomPct} vs ${est.zoomPct})`);

    // Malformed input -> null (callers treat as no rotation/zoom).
    ok(alignTransformToRotZoom(null) === null, 'null array -> null');
    ok(alignTransformToRotZoom([1, 0, 0]) === null, 'short array -> null');
}

// ---- clampCropWindow (URL crop= validation/clamping) ----
{
    // In-range values pass through untouched.
    const w = clampCropWindow(0.12, 0.08, -0.03, 0.01, 0.98);
    ok(w && !w.clamped, 'in-range crop not clamped');
    ok(approx(w.cropX, 0.12) && approx(w.cropY, 0.08) && approx(w.offsetX, -0.03) && approx(w.offsetY, 0.01),
        'in-range crop preserved');

    // Negative crop ratios clamp to 0.
    const neg = clampCropWindow(-0.2, -0.1, 0, 0, 0.98);
    ok(neg.clamped && neg.cropX === 0 && neg.cropY === 0, 'negative crop -> 0');

    // Crop ratio above the max clamps to maxCropRatio.
    const big = clampCropWindow(1.5, 2.0, 0, 0, 0.98);
    ok(big.clamped && approx(big.cropX, 0.98) && approx(big.cropY, 0.98), 'crop clamped to maxCropRatio');

    // Offset is clamped to ±crop (window stays inside the image).
    const off = clampCropWindow(0.10, 0.10, 0.50, -0.50, 0.98);
    ok(off.clamped && approx(off.offsetX, 0.10) && approx(off.offsetY, -0.10), 'offset clamped to ±crop');

    // Zero crop forces zero offset (no pan without a crop window).
    const zc = clampCropWindow(0, 0, 0.3, 0.3, 0.98);
    ok(zc.clamped && zc.offsetX === 0 && zc.offsetY === 0, 'zero crop -> zero offset');

    // Non-finite input -> null (callers treat as no crop).
    ok(clampCropWindow(NaN, 0, 0, 0, 0.98) === null, 'NaN crop -> null');
    ok(clampCropWindow(0.1, 0.1, Infinity, 0, 0.98) === null, 'Infinite offset -> null');
}

// ---- splitVerticalShift: lossless shiftY round-trip past the ±0.1 slider clamp ----
{
    // The exporter's combined vertical value is applied additively by the shader as
    // srcR.y constant = a[7] - shiftY. splitVerticalShift must apportion the total so
    // this equals -verticalUv for ANY verticalUv, keeping |shiftY| within the slider.
    const shaderConst = (v) => {
        const { shiftY, alignTransform } = splitVerticalShift(v, rotZoomToAlignTransform(0, 0));
        return { shiftY, a7: alignTransform[7], applied: alignTransform[7] - shiftY };
    };

    // In-range: everything stays in shiftY, a[7] untouched (no regression vs. shift-only).
    const inRange = shaderConst(0.07);
    ok(approx(inRange.shiftY, 0.07) && approx(inRange.a7, 0), 'in-range vertical stays in shiftY, a[7]=0');
    ok(approx(inRange.applied, -0.07), 'in-range: a[7]-shiftY == -verticalUv');

    // Boundary: exactly ±0.1 still fits in shiftY with no overflow.
    const atBound = shaderConst(0.1);
    ok(approx(atBound.shiftY, 0.1) && approx(atBound.a7, 0), 'boundary 0.1 fits in shiftY');

    // Overflow (vertical parallax > 10%): shiftY clamps, remainder folds into a[7],
    // and the shader-applied constant is still exactly -verticalUv (lossless).
    for (const v of [0.15, 0.35, -0.22, 0.5, -0.5]) {
        const r = shaderConst(v);
        ok(Math.abs(r.shiftY) <= 0.1 + 1e-12, `shiftY within ±0.1 for v=${v} (got ${r.shiftY})`);
        ok(approx(r.applied, -v), `lossless: a[7]-shiftY == -v for v=${v} (got ${r.applied})`);
    }

    // Overflow folds into a[7] with the correct magnitude/sign: a[7] = shiftY - v.
    const big = splitVerticalShift(0.35, rotZoomToAlignTransform(0, 0));
    ok(approx(big.shiftY, 0.1) && approx(big.alignTransform[7], 0.1 - 0.35), 'a[7] carries the exact overflow');

    // Roll/zoom channels are preserved when overflow folds into a[7] (only a[7] changes).
    const base = rotZoomToAlignTransform(3, 2); // non-identity a[1], a[4]
    const combined = splitVerticalShift(0.3, base);
    ok(approx(combined.alignTransform[1], base[1]) && approx(combined.alignTransform[4], base[4]),
        'roll/zoom (a[1],a[4]) preserved through the split');
    ok(approx(combined.alignTransform[7], combined.shiftY - 0.3), 'a[7] set alongside preserved roll/zoom');
    // Input matrix is copied, not mutated.
    ok(base[7] === 0, 'input matrix not mutated');

    // Auto-crop consistency: verticalCropFromSampling reads a[7]-shiftY, so the split
    // yields the SAME crop window as the original (unclamped) vertical value would via
    // an identity matrix. Guards against the auto-crop drifting after import.
    for (const v of [0.05, 0.15, -0.3]) {
        const s = splitVerticalShift(v, rotZoomToAlignTransform(0, 0));
        const cropSplit = verticalCropFromSampling(s.alignTransform, s.shiftY);
        const cropRef = verticalCropFromSampling([1, 0, 0, 0, 1, 0, 0, 0, 1], v); // identity, all-in-shiftY
        ok(approx(cropSplit.cropY, cropRef.cropY) && approx(cropSplit.offsetY, cropRef.offsetY),
            `auto-crop window invariant to the split for v=${v}`);
    }

    // Non-finite / degenerate inputs fall back safely (identity matrix, zero shift).
    const nan = splitVerticalShift(NaN, null);
    ok(nan.shiftY === 0 && nan.alignTransform[7] === 0, 'NaN verticalUv -> shiftY 0, a[7] 0');
    ok(nan.alignTransform.length === 9, 'null matrix -> identity mat3 fallback');
}

// ---- composeManualCropWindow: auto-crop composes with (not replaces) a rect crop ----
{
    const noCrop = { cropX: 0, cropY: 0, offsetX: 0, offsetY: 0 };
    const vId = (s) => verticalCropFromSampling([1, 0, 0, 0, 1, 0, 0, 0, 1], s);

    // Fresh state (no existing crop): reduces to the previous replace behavior
    // (crop = 2|shift|*margin on the band side only).
    const fresh = composeManualCropWindow(noCrop, 0.05, vId(0.02), 1.001);
    ok(approx(fresh.cropX, 0.1 * 1.001) && approx(fresh.offsetX, 0.1 * 1.001),
        'no existing crop: horizontal trim = 2*shiftX*margin on the band side');
    // Vertical trim is |shiftY| (one-sided band), not 2*|shiftY|.
    ok(approx(fresh.cropY, 0.02 * 1.001) && approx(fresh.offsetY, 0.02 * 1.001),
        'no existing crop: vertical trim from verticalCropFromSampling');

    // Negative shift trims the opposite side (offset sign follows the band).
    const neg = composeManualCropWindow(noCrop, -0.05, vId(0), 1.001);
    ok(approx(neg.cropX, 0.1 * 1.001) && approx(neg.offsetX, -0.1 * 1.001),
        'negative shiftX trims the opposite side');

    // Rectangle crop whose window already excludes the alignment bands is
    // preserved UNCHANGED (this is the reported regression: it used to be
    // wiped and replaced by the alignment trim).
    const rect = { cropX: 0.4, cropY: 0.4, offsetX: 0.0, offsetY: 0.2 }; // x:[0.2,0.8] y:[0.3,0.9]
    const kept = composeManualCropWindow(rect, 0.05, vId(0.05), 1.001);
    ok(approx(kept.cropX, rect.cropX) && approx(kept.offsetX, rect.offsetX) &&
       approx(kept.cropY, rect.cropY) && approx(kept.offsetY, rect.offsetY),
        'rect crop away from the bands survives auto-crop unchanged');

    // Rectangle crop overlapping the band: only the overlapping strip is trimmed.
    const edgeRect = { cropX: 0.4, cropY: 0, offsetX: -0.4, offsetY: 0 }; // x:[0,0.6]
    const trimmed = composeManualCropWindow(edgeRect, 0.05, vId(0), 1.0);
    // Window becomes x:[0.1,0.6] -> cropX=0.5, offsetX=0.1+0.6-1=-0.3
    ok(approx(trimmed.cropX, 0.5) && approx(trimmed.offsetX, -0.3),
        'band-overlapping rect crop is trimmed only where the band intrudes');

    // Composed offset always stays within the shader-valid range |offset| <= crop.
    ok(Math.abs(trimmed.offsetX) <= trimmed.cropX + 1e-12 &&
       Math.abs(fresh.offsetX) <= fresh.cropX + 1e-12,
        'composed window satisfies |offset| <= crop');

    // Empty intersection (band swallows the whole window) -> null.
    const tiny = { cropX: 0.9, cropY: 0, offsetX: -0.9, offsetY: 0 }; // x:[0,0.05]
    ok(composeManualCropWindow(tiny, 0.1, vId(0), 1.0) === null,
        'empty intersection returns null');

    // Non-finite input -> null.
    ok(composeManualCropWindow({ cropX: NaN }, 0.1, vId(0)) === null,
        'non-finite params return null');
}

// ---- composeManualCropWindow: shader-faithful end-to-end property test ----
// Replays the GLSL pipeline in JS:
//   originalUv = baseUv*(1-crop) + crop*0.5 + offset*0.5          (applyCropAndOffset)
//   srcR.x = originalUv.x - 2*shiftX                              (computeSampleCoordinates)
//   srcR.y = a[1]*originalUv.x + a[4]*originalUv.y + (a[7]-shiftY)
// and asserts that for many random (rect crop, shift, matrix) combinations the
// composed window (a) never grows beyond the rect window, (b) leaves both eyes'
// sample coordinates inside [0,1] — i.e. no residual black band — and (c) keeps
// the shader-valid |offset| <= crop invariant, including after the even-pixel
// snap that applyManualCrop() performs (crop grows, offset fixed).
{
    const shaderWindow = (cropX, cropY, offsetX, offsetY) => ({
        x1: (cropX + offsetX) / 2, x2: 1 - (cropX - offsetX) / 2,
        y1: (cropY + offsetY) / 2, y2: 1 - (cropY - offsetY) / 2,
    });
    // ensureEven/adjustCropRatioForEven semantics from js/utils/pixel-utils.js.
    const evenSnap = (crop, size) => {
        const px = Math.floor(size * (1 - crop));
        const evenPx = px <= 1 ? 2 : (px % 2 === 0 ? px : px - 1);
        return 1 - evenPx / size;
    };
    const EYE_W = 1920, EYE_H = 1080;
    let violations = 0;
    for (let i = 0; i < 500; i++) {
        // Random rect crop window inside [0,1]^2 (>= ~10% on each axis).
        const rx1 = rnd() * 0.6, rx2 = rx1 + 0.1 + rnd() * (1 - rx1 - 0.1);
        const ry1 = rnd() * 0.6, ry2 = ry1 + 0.1 + rnd() * (1 - ry1 - 0.1);
        const rect = {
            cropX: 1 - (rx2 - rx1), cropY: 1 - (ry2 - ry1),
            offsetX: rx1 + rx2 - 1, offsetY: ry1 + ry2 - 1,
        };
        const shiftX = (rnd() - 0.5) * 0.1;
        const shiftY = (rnd() - 0.5) * 0.1;
        // Half the trials use an adopted-style affine matrix, half identity.
        const useMatrix = rnd() < 0.5;
        const M = useMatrix
            ? [1, (rnd() - 0.5) * 0.2, 0, 0, 1 - (rnd() - 0.5) * 0.1, 0, 0, (rnd() - 0.5) * 0.06, 1]
            : [1, 0, 0, 0, 1, 0, 0, 0, 1];
        const sY = useMatrix ? 0 : shiftY; // shiftY folds to 0 when a matrix is adopted
        const vCrop = verticalCropFromSampling(M, sY);

        const c = composeManualCropWindow(rect, shiftX, vCrop, 1.0);
        if (!c) continue; // empty intersection is a legal outcome
        // Even-pixel snap as applyManualCrop() does (offset unchanged).
        const cropX = evenSnap(c.cropX, EYE_W);
        const cropY = evenSnap(c.cropY, EYE_H);

        // (c) shader-valid invariants.
        if (!(cropX >= c.cropX - 1e-12 && cropY >= c.cropY - 1e-12)) violations++;
        if (Math.abs(c.offsetX) > cropX + 1e-9 || Math.abs(c.offsetY) > cropY + 1e-9) violations++;

        const w = shaderWindow(cropX, cropY, c.offsetX, c.offsetY);
        const r = shaderWindow(rect.cropX, rect.cropY, rect.offsetX, rect.offsetY);
        // (a) never grows beyond the rect window.
        if (w.x1 < r.x1 - 1e-9 || w.x2 > r.x2 + 1e-9 ||
            w.y1 < r.y1 - 1e-9 || w.y2 > r.y2 + 1e-9) violations++;

        // (b) both eyes sample inside [0,1] across the whole visible window.
        for (let bi = 0; bi <= 8 && violations === 0; bi++) {
            for (let bj = 0; bj <= 8; bj++) {
                const bx = bi / 8, by = bj / 8;
                const ox = bx * (1 - cropX) + cropX * 0.5 + c.offsetX * 0.5;
                const oy = by * (1 - cropY) + cropY * 0.5 + c.offsetY * 0.5;
                const rX = ox - 2 * shiftX;
                const rY = M[1] * ox + M[4] * oy + (M[7] - sY);
                if (ox < -1e-9 || ox > 1 + 1e-9 || oy < -1e-9 || oy > 1 + 1e-9 ||
                    rX < -1e-9 || rX > 1 + 1e-9 || rY < -1e-9 || rY > 1 + 1e-9) {
                    violations++;
                    break;
                }
            }
        }
    }
    ok(violations === 0, `shader-faithful property test found ${violations} violation(s)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
