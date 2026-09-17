/**
 * tests/export-params.test.mjs
 *
 * Committed, framework-free verification for the URL/list serialization in
 * js/core/export-params.js — the direction that writes the `?src=` viewer link
 * and the URL-list line that ui-export.js copies to the clipboard.
 * tests/url-params.test.mjs covers the parsers that read them back; this is
 * their counterpart, so a change to either side fails here rather than shipping.
 *
 * The module imports only pure helpers (alignment-geometry.js, mode-utils.js) —
 * no DOM, no three, no WebGL — so it runs under Node's built-in test runner.
 *
 * Run:  node tests/export-params.test.mjs
 * Exits non-zero if any assertion fails.
 *
 * Covers: which keys are emitted and which are omitted, the pixel rounding of
 * x/y, the ALIGN_EXPORT_EPS threshold below which r/z disappear, the crop tuple,
 * the mode-name fallback, and the round trip back through js/url-params.js.
 */

import {
    ALIGN_EXPORT_EPS,
    buildCropParam,
    buildListLine,
    buildViewerUrl,
    computeExportGeometry,
    formatAlignParam,
    formatCropValue,
} from '../js/core/export-params.js';
import { rotZoomToAlignTransform, splitVerticalShift } from '../js/rendering/alignment-geometry.js';
import { parseCropParam, parseModeParam, parseRotationParam, parseShiftParam } from '../js/url-params.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const BASE_URL = 'https://sphyrnidae.pages.dev';
const URL_IN = 'https://example.com/image.jpg';
const IMAGE = { width: 1920, height: 1080 };
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A shift-only view state: identity matrix, no crop, default mode. */
const shiftOnly = (overrides = {}) => ({
    mode: 0,
    shiftX: 0,
    shiftY: 0,
    alignTransform: IDENTITY.slice(),
    cropX: 0, cropY: 0, offsetX: 0, offsetY: 0,
    ...overrides,
});

// ---- the list line omits everything that is at its default ----
{
    const line = buildListLine({ url: URL_IN, params: shiftOnly(), format: 'full_sbs', image: IMAGE });
    ok(line === `${URL_IN} format=full_sbs`, `bare state -> url and format only, got: ${line}`);
}

// ---- format is always present; mode only when it is not the default ----
{
    const withMode = buildListLine({ url: URL_IN, params: shiftOnly({ mode: 2 }), format: 'half_sbs', image: IMAGE });
    ok(withMode.includes('format=half_sbs'), 'format always emitted');
    ok(/\bmode=[a-z_]+\b/.test(withMode), `non-default mode emitted by name, got: ${withMode}`);
    ok(parseModeParam(withMode.match(/mode=([a-z_]+)/)[1]) === 2, 'emitted mode name parses back to the mode');
}

// ---- x and y are whole pixels of the image, and are dropped when zero ----
{
    const params = shiftOnly({ shiftX: 10 / IMAGE.width, shiftY: -4 / IMAGE.height });
    const line = buildListLine({ url: URL_IN, params, format: 'full_sbs', image: IMAGE });
    ok(line.includes(' x=10'), `shiftX written as whole pixels, got: ${line}`);
    ok(line.includes(' y=-4'), `shiftY written as whole pixels, got: ${line}`);

    const rounded = buildListLine({
        url: URL_IN,
        params: shiftOnly({ shiftX: 10.4 / IMAGE.width }),
        format: 'full_sbs',
        image: IMAGE,
    });
    ok(rounded.includes(' x=10'), 'a fractional pixel rounds to the nearest whole one');

    const noImage = buildListLine({ url: URL_IN, params, format: 'full_sbs', image: null });
    ok(!noImage.includes(' x=') && !noImage.includes(' y='),
        `without an image there is no pixel scale, so neither is written, got: ${noImage}`);
}

// ---- r and z appear only once the decomposed value reaches the threshold ----
{
    const justUnder = ALIGN_EXPORT_EPS / 2;
    const params = shiftOnly({ alignTransform: rotZoomToAlignTransform(justUnder, justUnder) });
    const line = buildListLine({ url: URL_IN, params, format: 'full_sbs', image: IMAGE });
    ok(!line.includes(' r=') && !line.includes(' z='),
        `below ALIGN_EXPORT_EPS the rotation and zoom are omitted, got: ${line}`);

    const above = shiftOnly({ alignTransform: rotZoomToAlignTransform(2.5, 1.5) });
    const aboveLine = buildListLine({ url: URL_IN, params: above, format: 'full_sbs', image: IMAGE });
    ok(aboveLine.includes(' r=2.5'), `rotation emitted, got: ${aboveLine}`);
    ok(aboveLine.includes(' z=1.5'), `zoom emitted, got: ${aboveLine}`);
}

// ---- the crop tuple appears only when a crop is applied ----
{
    ok(buildCropParam({ cropX: 0, cropY: 0, offsetX: 0.2, offsetY: 0 }) === null,
        'an offset without a crop window is not a crop');
    ok(buildCropParam({ cropX: 0.12, cropY: 0.08, offsetX: -0.03, offsetY: 0.01 }) === '0.12,0.08,-0.03,0.01',
        'crop tuple is the four normalized values in order');

    const parsed = parseCropParam(buildCropParam({ cropX: 0.125, cropY: 0.0625, offsetX: -0.03125, offsetY: 0 }));
    ok(parsed !== null && approx(parsed.cropX, 0.125) && approx(parsed.cropY, 0.0625)
        && approx(parsed.offsetX, -0.03125) && approx(parsed.offsetY, 0),
        'the emitted crop tuple parses back to the same window');
}

// ---- value formatting keeps the documented precision ----
{
    ok(formatAlignParam(2.500000001) === '2.5', 'rotation/zoom carry four decimals, trailing zeros trimmed');
    ok(formatAlignParam(-1.23456789) === '-1.2346', 'rotation/zoom round at the fourth decimal');
    ok(formatCropValue(0.1234567) === '0.12346', 'crop values carry five decimals');
    ok(formatCropValue(0.5) === '0.5', 'crop values trim trailing zeros');
}

// ---- computeExportGeometry folds the matrix constant into the vertical value ----
{
    // A vertical shift past the slider clamp is split between shiftY and the
    // matrix; the exporter has to report the total, not the clamped part.
    const verticalUv = 0.25;
    const { shiftY, alignTransform } = splitVerticalShift(verticalUv, IDENTITY.slice());
    ok(Math.abs(shiftY) < Math.abs(verticalUv), 'the split clamps shiftY, leaving a remainder in the matrix');

    const geometry = computeExportGeometry({ shiftX: 0, shiftY, alignTransform }, IMAGE);
    ok(geometry.verticalPx === Math.round(verticalUv * IMAGE.height),
        `the whole vertical value is reported, got ${geometry.verticalPx}`);
}

// ---- the viewer link always carries x, y, mode and format ----
{
    const link = buildViewerUrl({
        baseUrl: BASE_URL, url: URL_IN, params: shiftOnly(), format: 'full_sbs', image: IMAGE,
    });
    const query = new URL(link).searchParams;
    ok(query.get('src') === URL_IN, 'src is the image URL');
    ok(query.get('format') === 'full_sbs', 'format present');
    ok(query.get('mode') !== null, 'mode always present, unlike in the list line');
    ok(query.get('x') === '0' && query.get('y') === '0',
        'x and y always present, unlike in the list line');
    ok(query.get('r') === null && query.get('z') === null, 'no rotation or zoom without one');
    ok(query.get('crop') === null, 'no crop without one');
}

// ---- a state written and read back returns to itself within the format's rounding ----
{
    const rotationDeg = 2.5;
    const zoomPct = 1.5;
    const params = shiftOnly({
        shiftX: 24 / IMAGE.width,
        alignTransform: rotZoomToAlignTransform(rotationDeg, zoomPct),
        cropX: 0.12, cropY: 0.08, offsetX: -0.03, offsetY: 0.01,
    });
    const query = new URL(buildViewerUrl({
        baseUrl: BASE_URL, url: URL_IN, params, format: 'half_sbs', image: IMAGE,
    })).searchParams;

    const x = parseShiftParam(query.get('x'));
    ok(x !== null && approx(x.value / IMAGE.width, params.shiftX, 0.5 / IMAGE.width),
        'shiftX returns within half a pixel');

    const r = parseRotationParam(query.get('r'));
    ok(r !== null && approx(r.value, rotationDeg, ALIGN_EXPORT_EPS), 'rotation returns within the threshold');

    const crop = parseCropParam(query.get('crop'));
    ok(crop !== null && approx(crop.cropX, params.cropX, 5e-6) && approx(crop.offsetY, params.offsetY, 1e-5),
        'the crop window returns within the five decimals it was written with');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
