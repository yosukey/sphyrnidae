/**
 * tests/url-params.test.mjs
 *
 * Committed, framework-free verification for the URL-parameter value validators
 * in js/url-params.js. These are the per-value parsers shared by the single-image
 * ?src query path (main.js) and the URL-list per-line option path (ui-viewer.js).
 * The module imports only pure helpers (globals.js CONSTANTS, mode-utils.js,
 * alignment-geometry.js clampCropWindow) — no DOM, no three, no WebGL — so it runs
 * under Node's built-in test runner.
 *
 * Run:  node tests/url-params.test.mjs
 * Exits non-zero if any assertion fails.
 *
 * Focus: parseCropParam (the `crop=cropX,cropY,offsetX,offsetY` parser). The
 * clamping math itself is covered by clampCropWindow in
 * tests/alignment-geometry.test.mjs; here we verify the URL-parser contract that
 * sits on top of it — field-count enforcement, empty-field rejection, the
 * Number() (not parseFloat) conversion, non-finite rejection, and that in-range
 * values pass through while out-of-range values are clamped (clamped=true).
 */

import {
    parseCropParam,
    parseFormatParam,
    parseModeParam,
    parseShiftParam,
} from '../js/url-params.js';
import { CONSTANTS } from '../js/globals.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ---- parseCropParam: valid four-field tuple passes through unclamped ----
{
    const c = parseCropParam('0.12,0.08,-0.03,0.01');
    ok(c !== null, 'valid tuple -> object');
    ok(approx(c.cropX, 0.12) && approx(c.cropY, 0.08), 'cropX/cropY preserved');
    ok(approx(c.offsetX, -0.03) && approx(c.offsetY, 0.01), 'offsetX/offsetY preserved');
    ok(c.clamped === false, 'in-range tuple -> clamped false');
    // Surrounding whitespace per field is tolerated (list tokens may be padded).
    const spaced = parseCropParam(' 0.12 , 0.08 , -0.03 , 0.01 ');
    ok(spaced !== null && approx(spaced.cropX, 0.12) && spaced.clamped === false,
        'per-field whitespace tolerated');
}

// ---- parseCropParam: wrong field count -> null ----
{
    ok(parseCropParam('0.1,0.1,0') === null, 'three fields -> null');
    ok(parseCropParam('0.1,0.1,0,0,0') === null, 'five fields -> null');
    ok(parseCropParam('0.1') === null, 'single field -> null');
    ok(parseCropParam('') === null, 'empty string -> null');
}

// ---- parseCropParam: empty field -> null (Number('') is 0, must not parse as 0) ----
{
    ok(parseCropParam('0.1,,0.3,0.4') === null, 'gap field -> null (not silent 0)');
    ok(parseCropParam(',0.1,0.2,0.3') === null, 'leading gap -> null');
    ok(parseCropParam('0.1,0.2,0.3,') === null, 'trailing gap -> null');
    ok(parseCropParam('0.1, ,0.3,0.4') === null, 'whitespace-only field -> null');
}

// ---- parseCropParam: non-finite fields -> null (via clampCropWindow) ----
{
    ok(parseCropParam('0.1,NaN,0,0') === null, 'NaN field -> null');
    ok(parseCropParam('Infinity,0,0,0') === null, 'Infinity field -> null');
    ok(parseCropParam('0.1,0.1,-Infinity,0') === null, '-Infinity field -> null');
    // Number() (not parseFloat): a trailing-garbage token is NaN, not a truncated number.
    ok(parseCropParam('0.1abc,0.1,0,0') === null, "trailing garbage -> NaN -> null (not parseFloat's 0.1)");
    ok(parseCropParam('0x10,0,0,0') !== null, 'Number() still accepts valid non-decimal literals');
}

// ---- parseCropParam: out-of-range values are clamped (clamped=true), not rejected ----
{
    const max = CONSTANTS.MAX_CROP_RATIO;

    // Negative crop clamps up to 0; a zero crop forces its offset to 0.
    const neg = parseCropParam('-0.2,-0.1,0.05,0.05');
    ok(neg !== null && neg.cropX === 0 && neg.cropY === 0, 'negative crop clamps to 0');
    ok(neg.offsetX === 0 && neg.offsetY === 0, 'zero crop forces offset to 0');
    ok(neg.clamped === true, 'clamped flag set for out-of-range crop');

    // Crop above MAX_CROP_RATIO clamps down to the cap.
    const big = parseCropParam('1.5,2.0,0,0');
    ok(big !== null && approx(big.cropX, max) && approx(big.cropY, max), 'oversized crop clamps to MAX_CROP_RATIO');
    ok(big.clamped === true, 'clamped flag set for oversized crop');

    // Offset magnitude is bounded by the crop: |offset| <= crop.
    const off = parseCropParam('0.10,0.10,0.50,-0.50');
    ok(off !== null && approx(off.offsetX, 0.10) && approx(off.offsetY, -0.10),
        'offset clamped into [-crop, crop]');
    ok(off.clamped === true, 'clamped flag set for oversized offset');
}

// ---- parseCropParam: non-string input -> null ----
{
    ok(parseCropParam(null) === null, 'null -> null');
    ok(parseCropParam(undefined) === null, 'undefined -> null');
    ok(parseCropParam(0.5) === null, 'number input -> null');
    ok(parseCropParam(['0.1', '0.1', '0', '0']) === null, 'array input -> null');
}

// ---- sibling parsers: light sanity so the shared contract is exercised here too ----
{
    ok(parseFormatParam('HALF_SBS') === 'half_sbs', 'format case-normalized');
    ok(parseFormatParam('nope') === null, 'unknown format -> null');
    ok(parseModeParam('123') === null, 'numeric mode name rejected');
    ok(parseShiftParam('') === null, 'empty shift field -> null (not 0)');
    ok(parseShiftParam('10abc') === null, "shift trailing garbage -> null (Number, not parseFloat)");
    const clampedShift = parseShiftParam(String(CONSTANTS.MAX_SHIFT_PX + 1000));
    ok(clampedShift !== null && clampedShift.clamped === true && clampedShift.value === CONSTANTS.MAX_SHIFT_PX,
        'oversized shift clamps to +MAX_SHIFT_PX');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
