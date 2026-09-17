/**
 * alignment-shift.js
 * Shift-only estimation for auto-alignment (the default, always-on path).
 *
 * Split out of alignment.js so the estimator can be exercised without a DOM:
 * alignment.js reaches into the THREE.js material, the DOM and the toast layer,
 * so importing it outside a browser fails before any of this arithmetic runs.
 * This module has no imports and touches nothing outside its arguments, the
 * same arrangement alignment-geometry.js uses for the geometric refinement.
 *
 * The estimator returns a single horizontal shift and a single vertical
 * correction:
 *   - dy nulls the mechanical vertical misalignment of the pair.
 *   - dx places the disparity distribution for comfortable viewing, without
 *     rescaling it, so scene depth is preserved.
 * alignment-geometry.js generalizes the vertical half of this to a
 * position-dependent field; its constant case reproduces the dy here exactly.
 */

// ------------------------------
// Helpers: estimation methods
// ------------------------------

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function medianSorted(arrSorted) {
    const n = arrSorted.length;
    if (!n) return 0;
    const mid = (n / 2) | 0;
    return (n % 2) ? arrSorted[mid] : (arrSorted[mid - 1] + arrSorted[mid]) / 2;
}

// Precondition: arrSorted is sorted ascending and contains only finite numbers
// (all callers pass keypoint-derived values, which are always finite). A NaN
// filter here would be too late anyway: a NaN would already have corrupted the
// caller's comparator-based sort, leaving the array unsorted.
function percentileSorted(arrSorted, q) {
    const n = arrSorted.length;
    if (!n) return 0;
    const qq = clamp(q, 0, 1);
    const idx = (n - 1) * qq;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return arrSorted[lo];
    const t = idx - lo;
    return arrSorted[lo] * (1 - t) + arrSorted[hi] * t;
}

function medianAbsDeviation(values, med) {
    if (!values.length) return 0;
    const dev = values.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    return medianSorted(dev);
}

/**
 * Estimate shift-only correction focused on viewing comfort.
 *
 * - dy: robustly estimate mechanical vertical misalignment.
 * - dx: preserve disparity structure and find a single horizontal shift
 *       minimizing comfort penalties (range overflow + zero-plane target,
 *       optionally biased by zeroPlaneBiasPx toward pop-out/recess). The score
 *       depends on the disparities only through dx − s, so the result is
 *       invariant to the input pair's arbitrary horizontal framing offset.
 *
 * @param {Array<{dx:number,dy:number,dist?:number,y?:number}>} deltas
 * @param {Object} opts
 * @returns {{method:string,dyCorrection:number,dxShift:number,dyInlierCount:number,dxSampleCount:number,comfortScore:number,disparityStats:Object}}
 */
export function estimateDisparityComfortShift(deltas, opts = {}) {
    const o = {
        keepRatio: 0.60,
        minKeep: 80,
        maxKeep: 900,
        dyMadK: 2.5,
        dyMinTol: 1.0,
        comfortNegLimitPx: 24,
        comfortPosLimitPx: 40,
        targetZeroPercentile: 0.45,
        zeroWeight: 0.25,
        // Target disparity (px) for the zero-plane percentile after the shift;
        // negative places it slightly in front of the screen (pop-out). Being a
        // fixed pixel offset inside the score, it is invariant to the input
        // pair's arbitrary horizontal framing offset.
        zeroPlaneBiasPx: 0,
        ...opts
    };

    if (!Array.isArray(deltas) || deltas.length < 4) {
        return {
            method: 'disparity_comfort',
            dyCorrection: 0,
            dxShift: 0,
            dyInlierCount: 0,
            dxSampleCount: 0,
            comfortScore: 0,
            disparityStats: {
                min: 0, max: 0, p10: 0, p50: 0, p90: 0,
                zeroPlaneEstimate: 0,
                targetZeroPercentile: o.targetZeroPercentile
            }
        };
    }

    // Distance prefilter
    const byDist = deltas.slice().sort((a, b) => ((a.dist ?? 1e9) - (b.dist ?? 1e9)));
    const target = Math.floor(byDist.length * clamp(o.keepRatio, 0.05, 1.0));
    const nKeep = clamp(target, Math.min(o.minKeep | 0, byDist.length), Math.min(o.maxKeep | 0, byDist.length));
    const work = byDist.slice(0, Math.max(4, nKeep));

    // Robust dy estimation
    const dySorted = work.map(d => d.dy).sort((a, b) => a - b);
    const dyMedian = medianSorted(dySorted);
    const dyMad = medianAbsDeviation(work.map(d => d.dy), dyMedian);
    const tolY = Math.max(o.dyMinTol, o.dyMadK * (1.4826 * dyMad));

    let dyInliers = work.filter(d => Math.abs(d.dy - dyMedian) <= tolY);
    if (dyInliers.length < Math.max(8, Math.floor(work.length * 0.15))) {
        dyInliers = work.filter(d => Math.abs(d.dy - dyMedian) <= Math.max(tolY, 3.0));
    }
    if (dyInliers.length < 4) dyInliers = work.slice();

    const inlierDySorted = dyInliers.map(d => d.dy).sort((a, b) => a - b);
    const dyCorrection = medianSorted(inlierDySorted);

    const dxArr = dyInliers.map(d => d.dx).sort((a, b) => a - b);
    if (dxArr.length < 4) {
        return {
            method: 'disparity_comfort',
            dyCorrection,
            dxShift: 0,
            dyInlierCount: dyInliers.length,
            dxSampleCount: dxArr.length,
            comfortScore: 0,
            disparityStats: {
                min: 0, max: 0, p10: 0, p50: 0, p90: 0,
                zeroPlaneEstimate: 0,
                targetZeroPercentile: o.targetZeroPercentile
            }
        };
    }

    const p10 = percentileSorted(dxArr, 0.10);
    const p50 = percentileSorted(dxArr, 0.50);
    const p90 = percentileSorted(dxArr, 0.90);
    const p95 = percentileSorted(dxArr, 0.95);
    const p05 = percentileSorted(dxArr, 0.05);

    // Percentiles are translation-equivariant: P_q(dx − s) = P_q(dx) − s, so the
    // zero-plane position for every candidate shift comes from one precomputed
    // percentile — no per-candidate re-sort. This also shows the zero term is an
    // exact convex quadratic in s; the overflow term is convex too, so the whole
    // score is convex and the coarse+local search cannot be trapped in a local
    // minimum.
    const pZero = percentileSorted(dxArr, o.targetZeroPercentile);

    const evalShift = (s) => {
        let overflow = 0;
        for (const dx of dxArr) {
            const d = dx - s;
            const overNeg = Math.max(0, -o.comfortNegLimitPx - d);
            const overPos = Math.max(0, d - o.comfortPosLimitPx);
            overflow += overNeg * overNeg + overPos * overPos;
        }
        const zeroPlane = pZero - s;
        const zeroDev = zeroPlane - o.zeroPlaneBiasPx;
        return {
            score: overflow / dxArr.length + o.zeroWeight * zeroDev * zeroDev,
            zeroPlane
        };
    };

    // Search range driven by current disparity distribution and comfort limits.
    const sMin = p05 - o.comfortPosLimitPx;
    const sMax = p95 + o.comfortNegLimitPx;

    let bestS = p50;
    let best = evalShift(bestS);

    const coarseSteps = 60;
    const span = Math.max(1e-6, sMax - sMin);
    for (let i = 0; i <= coarseSteps; i++) {
        const s = sMin + (span * i) / coarseSteps;
        const cur = evalShift(s);
        if (cur.score < best.score) {
            best = cur;
            bestS = s;
        }
    }

    // Local refinement around best coarse candidate.
    const localHalf = span / coarseSteps;
    for (let i = 0; i < 24; i++) {
        const step = localHalf / Math.pow(1.5, i / 4);
        const l = evalShift(bestS - step);
        const r = evalShift(bestS + step);
        if (l.score < best.score) {
            best = l;
            bestS -= step;
        } else if (r.score < best.score) {
            best = r;
            bestS += step;
        }
    }

    // The viewer-preference bias is part of the score itself (zeroPlaneBiasPx),
    // so the search optimum needs no post-hoc scaling. A multiplicative dxGain
    // would instead scale the absolute shift and make the final placement
    // depend on the input pair's arbitrary framing offset.
    return {
        method: 'disparity_comfort',
        dyCorrection,
        dxShift: bestS,
        dyInlierCount: dyInliers.length,
        dxSampleCount: dxArr.length,
        comfortScore: best.score,
        disparityStats: {
            min: dxArr[0],
            max: dxArr[dxArr.length - 1],
            p10,
            p50,
            p90,
            zeroPlaneEstimate: best.zeroPlane,
            zeroPlaneBiasPx: o.zeroPlaneBiasPx,
            targetZeroPercentile: o.targetZeroPercentile
        }
    };
}
