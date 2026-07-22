/**
 * Regression tests for format-specific pixel validation.
 * Run: node tests/pixel-utils.test.mjs
 */
import {
    validatePixelsForFormat,
    validateInterlaceHPixels,
    validateInterlaceVPixels,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
