/**
 * alignment-geometry.js
 * Optional geometric refinement for auto-alignment (experimental, default OFF).
 *
 * Scope: a single-eye, FOV-free, depth-preserving *vertical affine* correction.
 *
 *   The reference (logical left) eye is left untouched. Only the logical right
 *   (shift-target) eye is corrected. We null the position-dependent VERTICAL
 *   disparity (residual roll + vertical-zoom difference) that a single dy shift
 *   cannot remove, while leaving the HORIZONTAL coordinate as a pure global
 *   shift so the horizontal disparity field (scene depth) is preserved exactly.
 *
 * Approach — generalize the proven shift-only transform (sign-safe):
 *   The shipped shift-only path applies, in the shader, srcR.y = uv.y - shiftY
 *   with shiftY = median vertical disparity, and this is known-correct (it already
 *   accounts for the texture's flipY orientation). We generalize the constant
 *   shiftY to a position-dependent linear disparity field:
 *       srcR.y = uv.y - (d*uv.x + e*uv.y + f)
 *   fitted from the per-match disparity disp = (right.y - left.y) against the
 *   left/display position (u,v) in shader-UV space. Because the constant case
 *   (d=e=0, f=median disp) reproduces srcR.y = uv.y - shiftY EXACTLY, the vertical
 *   sign is inherited from the working path rather than re-derived (which is what
 *   makes this robust to the flipY convention).
 *
 *   As the existing mat3 `alignTransform` (display->source sampling map):
 *       [ 1    0     0  ]
 *       [ -d   1-e   -f ]
 *       [ 0    0     1  ]
 *   The top row is identity (srcR.x = uv.x) so the horizontal coordinate — hence
 *   horizontal disparity / scene depth — is untouched; the bottom row [0,0,1]
 *   keeps the projective denominator at 1 (no perspective division). A keystone
 *   (projective) term would share that denominator with u' and distort depth, so
 *   it is intentionally out of scope here (see docs / Phase 2). d (u-gradient) is
 *   the roll term, e (v-gradient) the vertical-zoom term; no field-of-view assumed.
 *
 * Method (not an SPM port):
 *   - disp ~ d*u + e*v + f is LINEAR in (d,e,f), so the fit is a robust weighted
 *     linear least squares (IRLS, Huber) solved as a 3x3 normal-equation system.
 *     No grid search, no coordinate descent, no fixed iteration schedule, no FOV.
 *   - Outlier handling is MAD-adaptive (resolution invariant), with a thin
 *     hard-rejection/refit outer pass for structured outliers.
 *   - A model-selection gate adopts the field only when it beats the shift-only
 *     baseline by a margin AND the matches span the frame AND the parameters stay
 *     within sane clamps; otherwise it reports `adopted: false` and the caller
 *     falls back to the existing shift-only path.
 *
 * All coordinates here are normalized per-eye UV in [0,1] (x across the eye-half
 * width, y across the image height), matching the shader's `alignTransform` space.
 * Pure functions only; no OpenCV / DOM dependency.
 */

function median(sortedCopy) {
    const n = sortedCopy.length;
    if (!n) return 0;
    const mid = (n / 2) | 0;
    return (n % 2) ? sortedCopy[mid] : (sortedCopy[mid - 1] + sortedCopy[mid]) / 2;
}

function medianOf(values) {
    if (!values.length) return 0;
    return median(values.slice().sort((a, b) => a - b));
}

function madScale(residuals) {
    // 1.4826 * MAD -> robust estimate of the Gaussian standard deviation.
    if (!residuals.length) return 0;
    const med = medianOf(residuals);
    const dev = residuals.map(r => Math.abs(r - med));
    return 1.4826 * medianOf(dev);
}

/**
 * Solve a 3x3 linear system A x = b by Gaussian elimination with partial
 * pivoting. Returns null when (near-)singular.
 */
function solve3x3(A, b) {
    // Augmented matrix [A | b]
    const M = [
        [A[0][0], A[0][1], A[0][2], b[0]],
        [A[1][0], A[1][1], A[1][2], b[1]],
        [A[2][0], A[2][1], A[2][2], b[2]],
    ];
    for (let col = 0; col < 3; col++) {
        let pivot = col;
        let maxVal = Math.abs(M[col][col]);
        for (let row = col + 1; row < 3; row++) {
            const v = Math.abs(M[row][col]);
            if (v > maxVal) { maxVal = v; pivot = row; }
        }
        if (maxVal < 1e-12) return null;
        if (pivot !== col) { const t = M[col]; M[col] = M[pivot]; M[pivot] = t; }
        const inv = 1.0 / M[col][col];
        for (let row = col + 1; row < 3; row++) {
            const factor = M[row][col] * inv;
            for (let j = col; j <= 3; j++) M[row][j] -= factor * M[col][j];
        }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
        let s = M[i][3];
        for (let j = i + 1; j < 3; j++) s -= M[i][j] * x[j];
        x[i] = s / M[i][i];
    }
    if (!x.every(Number.isFinite)) return null;
    return x;
}

/** Huber weight for a standardized residual t = r / (k*sigma). */
function huberWeight(absr, kSigma) {
    if (kSigma <= 0) return 1;
    return absr <= kSigma ? 1 : kSigma / absr;
}

/** Smaller eigenvalue of the 2x2 covariance [[suu,suv],[suv,svv]]. */
function minEigen2x2(suu, svv, suv) {
    const tr = suu + svv;
    const diff = suu - svv;
    const disc = Math.sqrt(diff * diff + 4 * suv * suv);
    return (tr - disc) / 2;
}

/**
 * Estimate a robust vertical disparity field (a linear correction applied to the
 * right/target eye) by generalizing the proven shift-only path.
 *
 * @param {Array<{u:number,v:number,t:number,dist?:number}>} points
 *        u,v = LEFT/display position in shader-UV space ([0,1]; v already
 *        flip-corrected for the texture's flipY); t = vertical disparity
 *        disp = (right.y - left.y) in UV. The fit disp ~ d*u + e*v + f then maps
 *        to srcR.y = uv.y - (d*uv.x + e*uv.y + f); the constant case reproduces
 *        the shift-only transform exactly, so the vertical sign is guaranteed.
 * @param {Object} [opts]
 * @returns {{
 *   adopted:boolean, reason:string, matrix:number[]|null,
 *   d:number, e:number, f:number,
 *   residualTier0:number, residualTier1:number,
 *   inlierCount:number, usedCount:number,
 *   rollDeg:number, zoomPct:number, minSpreadStd:number
 * }}
 */
export function estimateVerticalAffine(points, opts = {}) {
    const o = {
        keepRatio: 0.60,
        minKeep: 80,
        maxKeep: 900,
        minInliers: 30,
        huberK: 1.345,
        maxIter: 12,
        tol: 1e-7,
        regFrac: 0.02,          // ridge toward identity (2% of data diagonal); a
                                // light numerical safety net — the adoption gates,
                                // not the ridge, are the primary over-fit guard.
        spreadMinStd: 0.10,     // require inlier spread std >= 10% of eye dim per axis
        residualMarginFrac: 0.15, // Tier1 must reduce robust residual by >= 15%
        residualSkipUv: 5e-4,   // below this Tier0 residual, shift-only is already fine
        maxRollAbsD: 0.18,      // |d| = |u-gradient of disparity| ~ tan(roll); ~10 deg
        maxZoomAbs: 0.06,       // |e| = |v-gradient of disparity| ~ vertical-zoom diff; 6%
        floorSigmaUv: 1e-4,
        ...opts,
    };

    // Placeholder params on failure are the no-refinement identity: d=e=f=0
    // (the matrix row is m11 = 1-e, so identity means e=0, not e=1).
    const fail = (reason) => ({
        adopted: false, reason, matrix: null,
        d: 0, e: 0, f: 0,
        residualTier0: 0, residualTier1: 0,
        inlierCount: 0, usedCount: 0,
        rollDeg: 0, zoomPct: 0, minSpreadStd: 0,
    });

    if (!Array.isArray(points) || points.length < 4) return fail('too_few_points');

    // Keep only finite samples.
    const clean = points.filter(p =>
        Number.isFinite(p.u) && Number.isFinite(p.v) && Number.isFinite(p.t));
    if (clean.length < 4) return fail('too_few_points');

    // Distance prefilter: keep the best matches by descriptor distance.
    const byDist = clean.slice().sort((a, b) => ((a.dist ?? 1e9) - (b.dist ?? 1e9)));
    const targetKeep = Math.floor(byDist.length * Math.max(0.05, Math.min(1, o.keepRatio)));
    const nKeep = Math.max(
        4,
        Math.min(byDist.length, Math.max(Math.min(o.minKeep, byDist.length), Math.min(o.maxKeep, targetKeep)))
    );
    let work = byDist.slice(0, nKeep);

    // --- Tier 0: best constant disparity (the shift-only baseline). ---
    // t is the vertical disparity (disp = vR - vL); a constant disparity is
    // exactly what the shift-only path removes, so f0 = median(disp).
    const f0 = medianOf(work.map(p => p.t));
    const residual0Arr = work.map(p => p.t - f0);
    const residualTier0 = madScale(residual0Arr);

    // --- Tier 1: robust linear disparity field via IRLS (Huber). ---
    // Fit disp ~ d*u + e*v + f, where (u,v) is the left/display position in
    // shader-UV space and d (u-gradient) ~ roll, e (v-gradient) ~ vertical-zoom
    // difference, f ~ constant vertical shift. The identity/no-refine point is
    // (d,e)=(0,0), so we initialize there.
    let d = 0, e = 0, f = f0;
    let lastSigma = Math.max(o.floorSigmaUv, residualTier0);
    let converged = false;

    // Thin outer hard-rejection/refit loop (structured outliers IRLS can't fully kill).
    for (let outer = 0; outer < 2; outer++) {
        let prev = [d, e, f];
        converged = false;

        for (let iter = 0; iter < o.maxIter; iter++) {
            // Residuals and adaptive scale from the current model.
            const res = work.map(p => (d * p.u + e * p.v + f) - p.t);
            const sigma = Math.max(o.floorSigmaUv, madScale(res));
            lastSigma = sigma;
            // Graduated non-convexity: start loose, tighten the Huber cutoff.
            const scaleMul = iter === 0 ? 4 : iter === 1 ? 2.5 : iter === 2 ? 1.5 : 1;
            const kSigma = o.huberK * scaleMul * sigma;

            // Weighted normal equations for [u v 1] x = t.
            let Suu = 0, Suv = 0, Su1 = 0, Svv = 0, Sv1 = 0, S11 = 0;
            let Sut = 0, Svt = 0, S1t = 0;
            for (let i = 0; i < work.length; i++) {
                const p = work[i];
                const w = huberWeight(Math.abs(res[i]), kSigma);
                const wu = w * p.u, wv = w * p.v;
                Suu += wu * p.u; Suv += wu * p.v; Su1 += wu;
                Svv += wv * p.v; Sv1 += wv;        S11 += w;
                Sut += wu * p.t; Svt += wv * p.t;  S1t += w * p.t;
            }

            // Tikhonov ridge toward no-refinement (d -> 0, e -> 0; f unpenalized),
            // tied to the data diagonal so it is scale-invariant and only bites
            // when the data is weak/ill-conditioned.
            const lamD = o.regFrac * Suu;
            const lamE = o.regFrac * Svv;
            const Amat = [
                [Suu + lamD, Suv, Su1],
                [Suv, Svv + lamE, Sv1],
                [Su1, Sv1, S11],
            ];
            const bvec = [Sut, Svt, S1t];

            const sol = solve3x3(Amat, bvec);
            if (!sol) return fail('singular');
            [d, e, f] = sol;

            const dd = d - prev[0], de = e - prev[1], df = f - prev[2];
            prev = [d, e, f];
            if (Math.sqrt(dd * dd + de * de + df * df) < o.tol) { converged = true; break; }
        }

        // Hard-reject points beyond 3*sigma and refit if any were dropped.
        const before = work.length;
        const kept = work.filter(p => Math.abs((d * p.u + e * p.v + f) - p.t) <= 3 * lastSigma);
        if (kept.length >= o.minInliers && kept.length < before) {
            work = kept;
            continue;
        }
        break;
    }

    // Final inliers and robust residual for the affine model.
    const finalRes = work.map(p => (d * p.u + e * p.v + f) - p.t);
    const residualTier1 = madScale(finalRes);
    const kInlier = o.huberK * lastSigma;
    const inliers = work.filter(p => Math.abs((d * p.u + e * p.v + f) - p.t) <= Math.max(kInlier, 3 * o.floorSigmaUv));
    const inlierCount = inliers.length;

    const rollDeg = Math.atan(d) * 180 / Math.PI;
    const zoomPct = e * 100;

    // Spatial-spread gate (inlier covariance eigenvalues) on (u,v).
    let minSpreadStd = 0;
    if (inlierCount >= 2) {
        let mu = 0, mv = 0;
        for (const p of inliers) { mu += p.u; mv += p.v; }
        mu /= inlierCount; mv /= inlierCount;
        let suu = 0, svv = 0, suv = 0;
        for (const p of inliers) {
            const du = p.u - mu, dv = p.v - mv;
            suu += du * du; svv += dv * dv; suv += du * dv;
        }
        suu /= inlierCount; svv /= inlierCount; suv /= inlierCount;
        minSpreadStd = Math.sqrt(Math.max(0, minEigen2x2(suu, svv, suv)));
    }

    const result = {
        adopted: false, reason: '',
        matrix: null, d, e, f,
        residualTier0, residualTier1,
        inlierCount, usedCount: work.length,
        rollDeg, zoomPct, minSpreadStd,
    };

    // --- Model-selection gate: adopt the affine only when justified. ---
    if (residualTier0 < o.residualSkipUv) { result.reason = 'already_aligned'; return result; }
    if (inlierCount < o.minInliers) { result.reason = 'few_inliers'; return result; }
    if (minSpreadStd < o.spreadMinStd) { result.reason = 'poor_spread'; return result; }
    if (Math.abs(d) > o.maxRollAbsD || Math.abs(e) > o.maxZoomAbs) { result.reason = 'out_of_range'; return result; }
    if (!(residualTier1 <= residualTier0 * (1 - o.residualMarginFrac))) { result.reason = 'no_improvement'; return result; }

    // Build the shader display->source sampling matrix (column-major for
    // THREE.Matrix3). This GENERALIZES the proven shift-only transform
    //   srcR.y = uv.y - shiftY      (shiftY = median disparity)
    // to a position-dependent field:
    //   srcR.y = uv.y - (d*uv.x + e*uv.y + f)
    //          = (-d)*uv.x + (1-e)*uv.y + (-f)
    // so the constant case (d=e=0, f=median disp) reproduces shift-only EXACTLY,
    // guaranteeing the vertical sign matches the known-correct path. The top row
    // is identity (srcR.x = uv.x) so horizontal disparity (depth) is untouched.
    const m11 = 1 - e;
    // Defensive: e is clamped to |e| <= maxZoomAbs (~0.06) above, so m11 ~ 1.
    if (!Number.isFinite(m11) || Math.abs(m11) < 0.5) { result.reason = 'degenerate_scale'; return result; }
    const matrix = [
        1, -d, 0,    // column 0: (m00, m10, m20)
        0, m11, 0,   // column 1: (m01, m11, m21)
        0, -f, 1,    // column 2: (m02, m12, m22)
    ];

    if (!matrix.every(Number.isFinite)) { result.reason = 'matrix_nonfinite'; return result; }

    result.adopted = true;
    result.reason = 'adopted';
    result.matrix = matrix;
    return result;
}

/**
 * Compute the per-eye analysis rectangle (analysis-image pixels, top-left
 * origin, y down) corresponding to the user's crop window, so auto-alignment
 * can exclude cropped-away regions (borders, subtitles, ...) from feature
 * detection.
 *
 * The shader maps display UV to source UV as
 *   originalUv = baseUv*(1-crop) + crop*0.5 + offset*0.5
 * so the visible per-eye source window (UV, y-up because of the texture's
 * flipY=true) is
 *   x in [(cropX+offsetX)/2, 1-(cropX-offsetX)/2]
 *   y in [(cropY+offsetY)/2, 1-(cropY-offsetY)/2]
 *
 * The window lives in originalUv space (BEFORE the per-eye alignment shift),
 * so it is identical for both physical halves regardless of swapLR. Using one
 * rect for both eyes keeps the dx/dy deltas correction-free (the common
 * origin cancels in differences) and keeps the estimation independent of the
 * current shift state (idempotent). The 3DTV virtual trim (tvCrop*) is a
 * display-mode-dependent trim and is intentionally NOT considered here.
 *
 * Keypoint pixels are top-left origin (y down) while the window is flipY UV
 * (y up), so the visible row range is [(1-y1)*h, (1-y0)*h].
 *
 * Falls back to the full frame (restricted:false) when there is no effective
 * crop, any parameter is non-finite, or the window is degenerate or smaller
 * than minSizePx on either axis (too few pixels for useful features).
 *
 * @param {{cropX?:number,cropY?:number,offsetX?:number,offsetY?:number}} params
 * @param {number} eyeW - analysis per-eye width in px
 * @param {number} eyeH - analysis image height in px
 * @param {{minSizePx?:number}} [opts]
 * @returns {{x:number,y:number,width:number,height:number,restricted:boolean,reason:string}}
 */
export function cropWindowToAnalysisRect(params, eyeW, eyeH, opts = {}) {
    const minSizePx = Number.isFinite(opts.minSizePx) ? opts.minSizePx : 32;
    const full = (reason) => ({
        x: 0, y: 0, width: eyeW, height: eyeH, restricted: false, reason,
    });

    const cropX = params?.cropX ?? 0;
    const cropY = params?.cropY ?? 0;
    const offsetX = params?.offsetX ?? 0;
    const offsetY = params?.offsetY ?? 0;
    if (![cropX, cropY, offsetX, offsetY].every(Number.isFinite)) return full('invalid_params');
    if (cropX === 0 && cropY === 0 && offsetX === 0 && offsetY === 0) return full('no_crop');

    // Visible window in per-eye source UV (y-up), clamped to [0,1].
    const x0u = Math.max(0, (cropX + offsetX) / 2);
    const x1u = Math.min(1, 1 - (cropX - offsetX) / 2);
    const y0u = Math.max(0, (cropY + offsetY) / 2);
    const y1u = Math.min(1, 1 - (cropY - offsetY) / 2);
    if (!(x1u > x0u) || !(y1u > y0u)) return full('degenerate_window');

    // UV -> analysis px. Grow outward (floor/ceil) so the rect never drops
    // visible pixels; flipY converts the y interval to top-origin rows.
    const x = Math.max(0, Math.floor(x0u * eyeW));
    const xEnd = Math.min(eyeW, Math.ceil(x1u * eyeW));
    const y = Math.max(0, Math.floor((1 - y1u) * eyeH));
    const yEnd = Math.min(eyeH, Math.ceil((1 - y0u) * eyeH));
    const width = xEnd - x;
    const height = yEnd - y;

    if (width >= eyeW && height >= eyeH) return full('no_crop');
    if (width < minSizePx || height < minSizePx) return full('too_small_fallback');

    return { x, y, width, height, restricted: true, reason: 'restricted' };
}

// Column-major identity mat3, matching the shader/uniform convention.
const IDENTITY_MAT3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Compose the alignment auto-crop trim with the CURRENT crop window instead of
 * replacing it, so a rectangle-selection crop survives a subsequent Auto Crop.
 *
 * The shader's visible per-eye source window (UV, y-up) for the current params is
 *   x in [(cropX+offsetX)/2, 1-(cropX-offsetX)/2]
 *   y in [(cropY+offsetY)/2, 1-(cropY-offsetY)/2]
 * and the alignment trim (from shiftX and verticalCropFromSampling) defines the
 * sub-range of the FULL image free of the black bands the shift/matrix introduces.
 * The composed window is simply the intersection of the two: regions the current
 * crop already excludes need no extra trim, and a fresh (no-crop) state reduces to
 * the previous replace behavior.
 *
 * @param {{cropX?:number,cropY?:number,offsetX?:number,offsetY?:number}} params - current crop window
 * @param {number} shiftX - the shader's horizontal shift uniform
 * @param {{cropY:number,offsetY:number}} vCrop - result of verticalCropFromSampling
 * @param {number} [marginFactor=1.001] - safety margin applied to the alignment trim amounts
 * @returns {{cropX:number,cropY:number,offsetX:number,offsetY:number}|null}
 *   Composed crop params, or null when the intersection is empty/invalid.
 */
export function composeManualCropWindow(params, shiftX, vCrop, marginFactor = 1.001) {
    const cropX = params?.cropX ?? 0;
    const cropY = params?.cropY ?? 0;
    const offsetX = params?.offsetX ?? 0;
    const offsetY = params?.offsetY ?? 0;
    if (![cropX, cropY, offsetX, offsetY, shiftX, vCrop?.cropY, vCrop?.offsetY].every(Number.isFinite)) {
        return null;
    }

    // Current visible window in per-eye source UV.
    const curX1 = (cropX + offsetX) / 2;
    const curX2 = 1 - (cropX - offsetX) / 2;
    const curY1 = (cropY + offsetY) / 2;
    const curY2 = 1 - (cropY - offsetY) / 2;

    // Alignment trim margins measured from the full-image edges (band side only).
    const autoLoX = Math.max(0, 2 * shiftX) * marginFactor;
    const autoHiX = Math.max(0, -2 * shiftX) * marginFactor;
    const autoLoY = Math.max(0, (vCrop.cropY + vCrop.offsetY) / 2) * marginFactor;
    const autoHiY = Math.max(0, (vCrop.cropY - vCrop.offsetY) / 2) * marginFactor;

    const x1 = Math.max(curX1, autoLoX);
    const x2 = Math.min(curX2, 1 - autoHiX);
    const y1 = Math.max(curY1, autoLoY);
    const y2 = Math.min(curY2, 1 - autoHiY);
    if (!(x2 > x1) || !(y2 > y1)) return null;

    return {
        cropX: 1 - (x2 - x1),
        cropY: 1 - (y2 - y1),
        offsetX: x1 + x2 - 1,
        offsetY: y1 + y2 - 1,
    };
}

/**
 * Build a column-major alignTransform mat3 from a roll (rotation, degrees) and a
 * vertical-zoom difference (zoom, percent), with NO folded vertical constant
 * (f = 0). This is the inverse of alignTransformToRotZoom and the reconstruction
 * used when loading rotation/zoom from URL parameters.
 *
 *   d = tan(rotationDeg * pi/180)   (roll / u-gradient of the disparity field)
 *   e = zoomPct / 100               (vertical-zoom / v-gradient)
 *   matrix = [ 1, -d, 0,  0, 1-e, 0,  0, 0, 1 ]   (column-major, see estimateVerticalAffine)
 *
 * The vertical constant is intentionally left at 0 here and carried separately by
 * the shader's shiftY uniform, which is rendering-equivalent to folding it into
 * m12: the shader computes srcR.y = a[1]*u + a[4]*v + (a[7] - shiftY), so the
 * constant term (a[7]) and shiftY are additive. Keeping f in shiftY lets the URL
 * `y` parameter remain a pure vertical-shift value in both the shift-only and the
 * rotation/zoom cases.
 *
 * @param {number} rotationDeg - roll angle in degrees
 * @param {number} zoomPct - vertical-zoom difference in percent
 * @returns {number[]} column-major mat3 alignTransform
 */
export function rotZoomToAlignTransform(rotationDeg, zoomPct) {
    const d = Math.tan((Number(rotationDeg) || 0) * Math.PI / 180);
    const e = (Number(zoomPct) || 0) / 100;
    return [1, -d, 0, 0, 1 - e, 0, 0, 0, 1];
}

/**
 * Split an imported total vertical shift (UV) into the shader's shiftY uniform and
 * the alignTransform's folded vertical constant a[7], so a value exceeding the
 * shiftY slider clamp survives the round-trip instead of being silently truncated.
 *
 * The exporter folds BOTH the shiftY uniform and the matrix constant f (= -a[7])
 * into a single vertical `y` value (see computeExportGeometry). On import that
 * value was assigned straight to shiftY, whose slider clamps it to ±0.1, so a
 * vertical parallax above 10% of the image height lost its excess (only reachable
 * when the geometric-refinement affine is adopted, since f is otherwise 0 and a
 * shift-only shiftY is already ≤0.1 by construction). Because the shader applies
 * the two additively — srcR.y constant = a[7] - shiftY — any apportionment that
 * keeps a[7] - shiftY = -verticalUv renders identically. We therefore clamp shiftY
 * to the slider range and fold the remainder back into a[7]:
 *
 *   shiftY = clamp(verticalUv, -maxShiftAbs, +maxShiftAbs)
 *   a[7]   = shiftY - verticalUv        (= -(verticalUv - shiftY), the clamp overflow)
 *
 * This is lossless, rendering-identical, and consistent with verticalCropFromSampling
 * (which reads a[7] - shiftY = -verticalUv, so the auto-crop window is unchanged by
 * the split). When |verticalUv| ≤ maxShiftAbs the overflow is 0, a[7] stays 0, and
 * the result is identical to the previous shift-only behavior.
 *
 * The incoming matrix is treated as the roll/zoom reconstruction (a[7] expected 0);
 * a[7] is overwritten, not accumulated. The array is copied — the input is not
 * mutated.
 *
 * @param {number} verticalUv - total vertical shift in UV (exporter's shiftY + f)
 * @param {number[]} alignArr - column-major mat3 (roll/zoom matrix) to fold a[7] into
 * @param {number} [maxShiftAbs=0.1] - shiftY clamp bound (the slider's |min| = |max|)
 * @returns {{shiftY:number, alignTransform:number[]}}
 */
export function splitVerticalShift(verticalUv, alignArr, maxShiftAbs = 0.1) {
    const v = Number.isFinite(verticalUv) ? verticalUv : 0;
    const bound = Math.abs(Number.isFinite(maxShiftAbs) ? maxShiftAbs : 0.1);
    const shiftY = Math.max(-bound, Math.min(bound, v));
    const out = (Array.isArray(alignArr) && alignArr.length >= 9)
        ? alignArr.slice()
        : IDENTITY_MAT3.slice();
    // shader constant a[7] - shiftY must equal -v  ->  a[7] = shiftY - v (the overflow).
    out[7] = shiftY - v;
    return { shiftY, alignTransform: out };
}

/**
 * Decompose an alignTransform mat3 into rotation (degrees) and vertical-zoom
 * (percent). Inverse of rotZoomToAlignTransform. The folded vertical constant f
 * (= -a[7]) is intentionally ignored here — the exporter folds it into the URL
 * `y` (vertical-shift) parameter instead — so only the roll and vertical-zoom are
 * returned.
 *
 *   d = -a[1]        -> rotationDeg = atan(d) * 180/pi
 *   e = 1 - a[4]     -> zoomPct = e * 100
 *
 * @param {number[]} alignArr - column-major mat3 (alignTransform)
 * @returns {{rotationDeg:number, zoomPct:number}|null} null if the array is not a
 *   valid mat3 or the decomposition is non-finite.
 */
export function alignTransformToRotZoom(alignArr) {
    if (!Array.isArray(alignArr) || alignArr.length < 9) return null;
    const d = -alignArr[1];
    const e = 1 - alignArr[4];
    const rotationDeg = Math.atan(d) * 180 / Math.PI;
    const zoomPct = e * 100;
    if (!Number.isFinite(rotationDeg) || !Number.isFinite(zoomPct)) return null;
    return { rotationDeg, zoomPct };
}

/**
 * Validate and clamp a crop window (the shader's cropX/cropY/offsetX/offsetY, all
 * normalized and resolution-independent) to the ranges the crop shader math
 * requires. Used when importing a `crop=` URL/list parameter.
 *
 *   cropX, cropY  -> [0, maxCropRatio]        (trim ratio; (1 - crop) stays > 0)
 *   offsetX       -> [-cropX, cropX]          (pan window stays inside the image;
 *   offsetY       -> [-cropY, cropY]           see cropWindowToAnalysisRect bounds)
 *
 * A zero crop forces the matching offset to 0 (no pan without a crop window).
 *
 * @param {number} cropX
 * @param {number} cropY
 * @param {number} offsetX
 * @param {number} offsetY
 * @param {number} [maxCropRatio=0.98] - upper bound for cropX/cropY
 * @returns {{cropX:number, cropY:number, offsetX:number, offsetY:number, clamped:boolean}|null}
 *   null if any input is non-finite.
 */
export function clampCropWindow(cropX, cropY, offsetX, offsetY, maxCropRatio = 0.98) {
    if (![cropX, cropY, offsetX, offsetY].every(Number.isFinite)) return null;
    let clamped = false;
    const clampRange = (v, lo, hi) => {
        if (v < lo) { clamped = true; return lo; }
        if (v > hi) { clamped = true; return hi; }
        return v;
    };
    const cx = clampRange(cropX, 0, maxCropRatio);
    const cy = clampRange(cropY, 0, maxCropRatio);
    const ox = clampRange(offsetX, -cx, cx);
    const oy = clampRange(offsetY, -cy, cy);
    return { cropX: cx, cropY: cy, offsetX: ox, offsetY: oy, clamped };
}

/**
 * True when the alignTransform array is (effectively) the identity matrix, i.e.
 * no geometric refinement is applied and only shiftX/shiftY are in play.
 */
export function isIdentityAlign(alignArr, eps = 1e-9) {
    if (!Array.isArray(alignArr) || alignArr.length < 9) return true;
    for (let i = 0; i < 9; i++) {
        if (Math.abs(alignArr[i] - IDENTITY_MAT3[i]) > eps) return false;
    }
    return true;
}

/**
 * Compute the auto-crop vertical parameters needed to trim the black region the
 * right (target) eye introduces, given the adopted alignTransform plus the
 * shader's shiftY. Derived directly from the shader pipeline:
 *   - crop window:   originalUv.y = baseUv.y*(1-cropY) + cropY*0.5 + offsetY*0.5
 *   - right sample:  srcR.y = a[1]*u + a[4]*originalUv.y + (a[7] - shiftY)   (affine, z=1)
 * The window [marginLo, 1-marginHi] is the largest sub-range of originalUv.y for
 * which srcR.y stays within [0,1] for all u in [0,1]. For the identity matrix this
 * reduces EXACTLY to the previous shift-only behavior (cropY=|shiftY|, offsetY=shiftY).
 *
 * @param {number[]} alignArr - column-major mat3 (alignTransform)
 * @param {number} shiftY - the shader's vertical shift uniform (0 when affine adopted)
 * @returns {{cropY:number, offsetY:number}} both in UV [0,1]
 */
export function verticalCropFromSampling(alignArr, shiftY) {
    const s = Number.isFinite(shiftY) ? shiftY : 0;
    const a = (Array.isArray(alignArr) && alignArr.length >= 9) ? alignArr : IDENTITY_MAT3;
    const A = a[1];          // m10: u-coefficient of srcR.y
    const B = a[4];          // m11: v-coefficient of srcR.y
    const C = a[7] - s;      // m12 folded with the shader's srcR.y -= shiftY

    // Guard: B is m11 = 1-e (~1, >0) for a valid affine; else fall back to shift-only.
    if (!Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(C) || B <= 1e-6) {
        return { cropY: Math.abs(s), offsetY: s };
    }

    // Largest window of originalUv.y keeping srcR.y in [0,1] across u in [0,1].
    const yLo = (-C - Math.min(0, A)) / B;     // srcR.y >= 0 boundary
    const yHi = (1 - C - Math.max(0, A)) / B;  // srcR.y <= 1 boundary
    const marginLo = Math.max(0, yLo);         // trim from the y=0 side
    const marginHi = Math.max(0, 1 - yHi);     // trim from the y=1 side
    return { cropY: marginLo + marginHi, offsetY: marginLo - marginHi };
}
