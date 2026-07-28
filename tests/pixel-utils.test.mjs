/**
 * Regression tests for format-specific pixel validation.
 * Run: node tests/pixel-utils.test.mjs
 */
import {
    validatePixelsForFormat,
    validateInterlaceHPixels,
    validateInterlaceVPixels,
    computeDualNormalizationTarget,
    computeCenterCropOffsets,
} from '../js/utils/pixel-utils.js';

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
    if (condition) pass++;
    else { fail++; console.error('  FAIL:', message); }
};

// Interlacing alternates rows/columns; it does not split the image into two
// half-size eye images. Multiples of two, rather than four, are therefore valid.
{
    const horizontal = validateInterlaceHPixels(1920, 1082);
    ok(horizontal.isValid, 'horizontal interlace accepts an even height not divisible by four');
    ok(horizontal.correction.trimBottom === 0, 'horizontal interlace does not trim a valid height');

    const vertical = validateInterlaceVPixels(1922, 1080);
    ok(vertical.isValid, 'vertical interlace accepts an even width not divisible by four');
    ok(vertical.correction.trimRight === 0, 'vertical interlace does not trim a valid width');
}

{
    const horizontalOdd = validatePixelsForFormat(1920, 1081, 'interlace_h');
    ok(!horizontalOdd.isValid && horizontalOdd.correction.trimBottom === 1,
        'horizontal interlace trims exactly one odd row');

    const verticalOdd = validatePixelsForFormat(1921, 1080, 'interlace_v');
    ok(!verticalOdd.isValid && verticalOdd.correction.trimRight === 1,
        'vertical interlace trims exactly one odd column');
}

// Dual-image resolution normalization: target is min of each dimension,
// floored to even so no odd-pixel validation dialog follows.
{
    const same = computeDualNormalizationTarget(4000, 3000, 4000, 3000);
    ok(!same.mismatch, 'equal resolutions report no mismatch');
    ok(same.targetWidth === 4000 && same.targetHeight === 3000,
        'equal resolutions keep their dimensions');

    const slight = computeDualNormalizationTarget(4001, 3000, 3998, 3005);
    ok(slight.mismatch, 'slightly different resolutions report a mismatch');
    ok(slight.targetWidth === 3998 && slight.targetHeight === 3000,
        'target is the min of each dimension');

    const oddMins = computeDualNormalizationTarget(4001, 3001, 3999, 2999);
    ok(oddMins.targetWidth === 3998 && oddMins.targetHeight === 2998,
        'odd minimums are floored to even');

    const oneAxis = computeDualNormalizationTarget(4000, 3000, 4000, 2998);
    ok(oneAxis.mismatch && oneAxis.targetWidth === 4000 && oneAxis.targetHeight === 2998,
        'single-axis difference still reports a mismatch with the shared axis kept');

    const degenerate = computeDualNormalizationTarget(1, 1, 5, 5);
    ok(degenerate.targetWidth === 2 && degenerate.targetHeight === 2,
        'degenerate 1px input clamps to the 2px minimum');
}

// The load path relies on normalization producing a pair that the odd-pixel
// validation then finds nothing wrong with, so the user is never asked twice in
// a row. That holds only because the target is floored to even on both axes;
// switching to ensureEvenCeil, or dropping the evenization, would silently
// reintroduce a second dialog. Assert it across a spread of odd/even inputs.
{
    let offenders = 0;
    for (const [wL, hL, wR, hR] of [
        [4001, 3001, 3999, 2999], [4000, 3000, 3999, 2999], [1921, 1081, 1920, 1080],
        [801, 601, 799, 599], [4000, 3000, 3998, 2996], [3, 3, 5, 5]
    ]) {
        const t = computeDualNormalizationTarget(wL, hL, wR, hR);
        // Both eyes are normalized to the target, so the composited SBS frame is
        // twice the target width — exactly what validateDualImages validates.
        const validation = validatePixelsForFormat(t.targetWidth * 2, t.targetHeight, 'full_sbs');
        if (validation.issues.length > 0) offenders++;
    }
    ok(offenders === 0,
        `a normalized pair never trips full_sbs pixel validation (${offenders} case(s) would pop a second dialog)`);
}

// Center-crop offsets: leftover split evenly, extra odd pixel to right/bottom.
{
    const fractional = computeCenterCropOffsets(4001, 3001, 3998, 2998);
    ok(fractional.sx === 1 && fractional.sy === 1, 'odd leftover floors the offset');

    const even = computeCenterCropOffsets(4000, 3000, 3998, 2998);
    ok(even.sx === 1 && even.sy === 1, 'even leftover splits in half');

    const exact = computeCenterCropOffsets(3998, 2998, 3998, 2998);
    ok(exact.sx === 0 && exact.sy === 0, 'matching size needs no offset');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
