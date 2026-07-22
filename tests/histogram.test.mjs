/**
 * tests/histogram.test.mjs
 *
 * Committed, framework-free verification for the pure histogram math in
 * js/core/histogram-math.js. Pure functions only — no DOM, no three, no WebGL
 * (histogram.js itself imports three and cannot be unit-tested here; the pure
 * math was extracted into histogram-math.js precisely so it can be).
 *
 * Run:  node tests/histogram.test.mjs
 * Exits non-zero if any assertion fails.
 *
 * Covers:
 *  - buildHistogramFromData: RGBA bin counting, Rec.601 luminance rounding,
 *    skipBlackPixels behavior, originalPixelCount, invalid-input guards, and the
 *    non-multiple-of-4 (truncated RGBA) length guard.
 *  - calculateHistogramStats: percentile-clipped min/max (0.1% / 99.9% outlier
 *    exclusion), mean, median, single-spike, the empty-histogram (divide-by-zero)
 *    edge case, and null/malformed-histogram degradation to neutral stats.
 *  - downsampleForHistogram: aspect-preserving cap at maxSize.
 *  - croppedEyeDimensions: even-snapping and the round-not-floor rule that keeps
 *    the histogram "Pixels:" count consistent with the displayed/exported
 *    cropped resolution (the ±2px fix).
 */

import {
    buildHistogramFromData,
    calculateHistogramStats,
    downsampleForHistogram,
    croppedEyeDimensions,
} from '../js/core/histogram-math.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Build an RGBA Uint8Array from [r,g,b] triples (alpha forced to 255).
function rgba(...pixels) {
    const data = new Uint8Array(pixels.length * 4);
    pixels.forEach(([r, g, b], i) => {
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
    });
    return data;
}

const zeros = () => new Array(256).fill(0);
// Build a histogram object whose luminance channel is defined by `bins`
// ({ index: count }); r/g/b are left zeroed (stats are asserted on luminance).
function lumHist(bins) {
    const luminance = zeros();
    let total = 0;
    for (const [i, c] of Object.entries(bins)) { luminance[Number(i)] = c; total += c; }
    return { r: zeros(), g: zeros(), b: zeros(), luminance, originalPixelCount: total };
}

// ---- buildHistogramFromData: bin counting + Rec.601 luminance ----
{
    const h = buildHistogramFromData(rgba([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]));
    ok(h.r[255] === 2 && h.r[0] === 2, `R channel counts (got 255:${h.r[255]}, 0:${h.r[0]})`);
    ok(h.g[255] === 2 && h.b[255] === 2, 'G/B channel counts');
    // Rec.601: lum = round(0.299 r + 0.587 g + 0.114 b)
    ok(h.luminance[76] === 1, `pure red -> lum 76 (got count ${h.luminance[76]})`);   // round(76.245)
    ok(h.luminance[150] === 1, 'pure green -> lum 150');                                // round(149.685)
    ok(h.luminance[29] === 1, 'pure blue -> lum 29');                                   // round(29.07)
    ok(h.luminance[255] === 1, 'white -> lum 255');
    ok(h.originalPixelCount === 4, `originalPixelCount defaults to pixel count (got ${h.originalPixelCount})`);
}

// ---- buildHistogramFromData: skipBlackPixels only drops EXACT (0,0,0) ----
{
    const buf = rgba([0, 0, 0], [0, 0, 1], [10, 10, 10], [0, 0, 0]);
    const kept = buildHistogramFromData(buf, false);
    // (0,0,1) has lum round(0.114)=0, so lum[0] = 2 pure-black + that pixel = 3.
    ok(kept.luminance[0] === 3, `skip=false counts all near-black (got ${kept.luminance[0]})`);

    const skipped = buildHistogramFromData(buf, true);
    ok(skipped.luminance[0] === 1, `skip=true drops the two exact (0,0,0) (got ${skipped.luminance[0]})`);
    ok(skipped.b[1] === 1 && skipped.r[0] === 1, 'skip=true keeps the genuine (0,0,1) pixel');
    ok(skipped.luminance[10] === 1, 'skip=true keeps the (10,10,10) pixel');
}

// ---- buildHistogramFromData: originalPixelCount override + invalid inputs ----
{
    ok(buildHistogramFromData(rgba([1, 2, 3]), false, 999).originalPixelCount === 999,
        'originalPixelCount override honored');
    ok(buildHistogramFromData(new Uint8ClampedArray([255, 255, 255, 255])) !== null,
        'Uint8ClampedArray accepted');
    ok(buildHistogramFromData(null) === null, 'null data -> null');
    ok(buildHistogramFromData(new Uint8Array(0)) === null, 'empty data -> null');
    ok(buildHistogramFromData([0, 0, 0, 255]) === null, 'plain (non-typed) array -> null');
}

// ---- buildHistogramFromData: reject non-multiple-of-4 (truncated RGBA) buffers ----
{
    // A length that is not a whole number of RGBA pixels would let the 4-byte scan
    // read past the end (undefined g/b -> NaN bin). Reject it instead of returning
    // a histogram polluted with stray non-index properties.
    ok(buildHistogramFromData(new Uint8Array([255, 0, 0])) === null, 'length 3 (not %4) -> null');
    ok(buildHistogramFromData(new Uint8Array([255, 0, 0, 255, 10])) === null, 'length 5 (not %4) -> null');
    ok(buildHistogramFromData(new Uint8ClampedArray([1, 2, 3, 4, 5, 6])) === null, 'length 6 (not %4) -> null');
    // A valid multiple-of-4 buffer is unaffected and produces only numeric bins.
    const h = buildHistogramFromData(new Uint8Array([9, 9, 9, 255]));
    ok(h !== null && h.g.every(c => Number.isInteger(c)), 'valid %4 buffer -> only integer bins (no NaN)');
}

// ---- calculateHistogramStats: percentile-clipped min/max + mean + median ----
{
    // total=2000; a single low outlier (bin 5) and single high outlier (bin 250)
    // sit below the 0.1% (=2) / above the 99.9% (cum>=1998) thresholds and are
    // excluded, so min=max=median=100 (the bulk), mean is only nudged by outliers.
    const h = lumHist({ 5: 1, 100: 1998, 250: 1 });
    const s = calculateHistogramStats(h).luminance;
    ok(s.min === 100, `min excludes low outlier (got ${s.min})`);
    ok(s.max === 100, `max excludes high outlier (got ${s.max})`);
    ok(s.median === 100, `median at bulk (got ${s.median})`);
    ok(approx(s.mean, 200055 / 2000), `mean over full distribution (got ${s.mean})`); // 100.0275
}

// ---- calculateHistogramStats: single spike ----
{
    const s = calculateHistogramStats(lumHist({ 128: 500 })).luminance;
    ok(s.min === 128 && s.max === 128 && s.median === 128 && approx(s.mean, 128),
        `single spike -> all stats equal the spike bin (got ${JSON.stringify(s)})`);
}

// ---- calculateHistogramStats: empty histogram (no divide-by-zero) ----
{
    const s = calculateHistogramStats(lumHist({})).luminance;
    ok(s.mean === 0 && Number.isFinite(s.mean), `empty histogram -> finite mean 0 (got ${s.mean})`);
    ok(s.min === 0 && s.max === 0 && s.median === 0, 'empty histogram -> zeroed stats');
}

// ---- calculateHistogramStats: null / malformed histogram -> neutral stats, no throw ----
{
    // buildHistogramFromData() returns null on failure and this function is
    // re-exported publicly, so a bad/missing histogram must degrade to neutral
    // stats (min 0 / max 255 / mean 0 / median 0) rather than throw.
    const neutral = (s) => s && ['r', 'g', 'b', 'luminance'].every(c =>
        s[c] && s[c].min === 0 && s[c].max === 255 && s[c].mean === 0 && s[c].median === 0);

    ok(neutral(calculateHistogramStats(null)), 'null histogram -> neutral stats (no throw)');
    ok(neutral(calculateHistogramStats(undefined)), 'undefined histogram -> neutral stats (no throw)');
    ok(neutral(calculateHistogramStats(42)), 'non-object histogram -> neutral stats (no throw)');
    ok(neutral(calculateHistogramStats({})), 'histogram missing channels -> neutral stats (no throw)');
    // Wrong bin count (channel present but not 256-length) is also rejected.
    ok(neutral(calculateHistogramStats({ r: [], g: [], b: [], luminance: [] })),
        'zero-length channels -> neutral stats (no throw)');
    ok(neutral(calculateHistogramStats({ r: zeros(), g: zeros(), b: zeros(), luminance: new Array(128).fill(0) })),
        'short luminance channel -> neutral stats (no throw)');
}

// ---- downsampleForHistogram: aspect-preserving cap ----
{
    const under = downsampleForHistogram(800, 600, 1536);
    ok(under.width === 800 && under.height === 600, 'under cap -> unchanged');

    const wide = downsampleForHistogram(3000, 1500, 1536);
    ok(wide.width === 1536 && wide.height === 768, `wide over cap -> 1536x768 (got ${wide.width}x${wide.height})`);
    ok(approx(wide.width / wide.height, 3000 / 1500, 1e-3), 'wide aspect preserved');

    const tall = downsampleForHistogram(1000, 4000, 1536);
    ok(tall.width === 384 && tall.height === 1536, `tall over cap -> 384x1536 (got ${tall.width}x${tall.height})`);
}

// ---- croppedEyeDimensions: even-snapping + round-not-floor (±2px fix) ----
{
    const d = croppedEyeDimensions(1920, 1080, 0.1, 0.2);
    ok(d.width === 1728 && d.height === 864, `crop dims even (got ${d.width}x${d.height})`); // 1728, 864 both even

    const oddSource = croppedEyeDimensions(1921, 1081, 0, 0);
    ok(oddSource.width === 1920 && oddSource.height === 1080, 'odd source snapped down to even');

    // Uses Math.round (not Math.floor) before the even-snap. This is the fix that
    // keeps the histogram "Pixels:" count aligned with updateCroppedResolution
    // (renderer.js) and the exporter (ui-export.js): 1000*0.9995 = 999.5 rounds to
    // 1000, whereas the old Math.floor path yielded 999 -> ensureEven -> 998.
    const rounded = croppedEyeDimensions(1000, 1000, 0.0005, 0.0005);
    ok(rounded.width === 1000 && rounded.height === 1000,
        `round-then-even (999.5 -> 1000), not floor (-> 998) (got ${rounded.width}x${rounded.height})`);

    // Result is always even and never below the ensureEven floor of 2.
    const heavy = croppedEyeDimensions(100, 100, 0.999, 0.999);
    ok(heavy.width === 2 && heavy.height === 2, `heavy crop floored to 2px (got ${heavy.width}x${heavy.height})`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
