/**
 * bench/params-roundtrip/run.mjs
 *
 * Measures how much of a view state survives being written to a link and read
 * back.
 *
 * The application can hand the current view to someone else in two forms: the
 * `?src=` viewer link and the URL-list line, both built by
 * js/core/export-params.js. Reading either one back goes through the parsers in
 * js/url-params.js and then the reconstruction js/loaders/loader-external.js
 * performs: pixel shifts divided by the image dimensions, rotation and zoom fed
 * to rotZoomToAlignTransform(), and the vertical value split by
 * splitVerticalShift(). This benchmark drives that full circle with generated
 * states and records what comes back.
 *
 * Both directions are the application's own modules. The only code here is the
 * state generator, the reconstruction sequence copied from loader-external.js,
 * and the comparison.
 *
 * What is compared
 *   The state is reduced to the quantities the shader actually consumes before
 *   comparing. In particular the vertical value is compared as shiftY minus
 *   alignTransform[7]: the exporter folds both into a single `y`, and
 *   splitVerticalShift is free to divide it differently on the way back, so the
 *   pair can change while the rendered result does not. The invariants table
 *   records how often that happens.
 *
 * Populations
 *   in-range   every value inside the limits the parsers enforce
 *              (MAX_SHIFT_PX, MAX_ROTATION_DEG, MAX_ZOOM_PCT, MAX_CROP_RATIO),
 *              so the only losses are the serialization's own rounding
 *   clamping   values deliberately outside those limits
 *
 * Outputs
 *   params-roundtrip.csv            per-parameter error, against the bound
 *                                   derived from the serialization format
 *   params-roundtrip-invariants.csv invariants checked over random states
 *   params-roundtrip-fuzz.csv       parser behaviour on malformed input
 *
 * Usage
 *   node bench/params-roundtrip/run.mjs [--samples=200000] [--seed=...]
 */

import { CONSTANTS } from '../../js/globals.js';
import { MODE_NAME_MAP, getModeName } from '../../js/mode-utils.js';
import {
    ALIGN_EXPORT_EPS,
    buildListLine,
    buildViewerUrl,
} from '../../js/core/export-params.js';
import {
    parseCropParam,
    parseFormatParam,
    parseModeParam,
    parseRotationParam,
    parseShiftParam,
    parseZoomParam,
    VALID_STEREO_FORMATS,
} from '../../js/url-params.js';
import {
    alignTransformToRotZoom,
    clampCropWindow,
    rotZoomToAlignTransform,
    splitVerticalShift,
    verticalCropFromSampling,
} from '../../js/rendering/alignment-geometry.js';
import { createRng, randInt, randRange, percentile, num } from '../lib/stats.mjs';
import { writeTables } from '../lib/run-manifest.mjs';

/** Identity alignTransform, column-major, as the application writes it. */
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** The shiftY slider bound splitVerticalShift clamps to. */
const MAX_SHIFT_UV = 0.1;

/** Image sizes the pixel-valued parameters are serialized against. */
const IMAGE_WIDTHS = [640, 1920, 4096, 8192];

/** Origin used for the viewer links; only its presence matters here. */
const BASE_URL = 'https://sphyrnidae.pages.dev';

/** Image URL written into every generated link. */
const IMAGE_URL = 'https://example.com/image.jpg';

/** Distinct mode numbers reachable through the mode names. */
const MODE_NUMBERS = [...new Set(Object.values(MODE_NAME_MAP))].sort((a, b) => a - b);

/**
 * Parse `--name=value` arguments.
 *
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv) {
    const out = {};
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
        if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}

/**
 * Generate a view state the application could actually hold.
 *
 * alignTransform is either the identity (the shift-only path) or a roll/zoom
 * matrix with a folded vertical constant, which are the only two shapes the
 * application ever produces.
 *
 * @param {() => number} rng
 * @param {{width:number, height:number}} image
 * @param {'in-range'|'clamping'} population
 * @returns {{params:Object, format:string}}
 */
function randomState(rng, image, population) {
    const inRange = population === 'in-range';

    // Horizontal shift, expressed so the exported pixel value lands inside or
    // outside MAX_SHIFT_PX as the population requires.
    const maxPx = CONSTANTS.MAX_SHIFT_PX;
    const shiftXPx = inRange
        ? randRange(rng, -maxPx, maxPx)
        : randRange(rng, maxPx * 1.5, maxPx * 6) * (rng() < 0.5 ? -1 : 1);
    const shiftX = shiftXPx / image.width;

    // Roughly a third of states exercise the shift-only path. Of the rest, a
    // tenth draw their rotation and zoom from a band around zero, so the
    // threshold below which the exporter omits them entirely is exercised
    // instead of being reached only by chance out of a wide uniform draw.
    const useRotZoom = rng() > 0.34;
    const nearZero = useRotZoom && rng() < 0.1;
    const drawAngle = (limit) => {
        if (nearZero) return randRange(rng, -ALIGN_EXPORT_EPS * 3, ALIGN_EXPORT_EPS * 3);
        if (inRange) return randRange(rng, -limit, limit);
        return randRange(rng, limit * 1.5, limit * 4) * (rng() < 0.5 ? -1 : 1);
    };
    const rotationDeg = useRotZoom ? drawAngle(CONSTANTS.MAX_ROTATION_DEG) : 0;
    const zoomPct = useRotZoom ? drawAngle(CONSTANTS.MAX_ZOOM_PCT) : 0;

    // The total vertical value, then split the way the application splits it.
    const verticalPxLimit = inRange ? maxPx : maxPx * 6;
    const verticalPx = inRange
        ? randRange(rng, -verticalPxLimit, verticalPxLimit)
        : randRange(rng, maxPx * 1.5, verticalPxLimit) * (rng() < 0.5 ? -1 : 1);
    const verticalUv = verticalPx / image.height;
    const base = useRotZoom ? rotZoomToAlignTransform(rotationDeg, zoomPct) : IDENTITY.slice();
    const { shiftY, alignTransform } = splitVerticalShift(verticalUv, base, MAX_SHIFT_UV);

    // Crop window: half the states carry one.
    let cropX = 0;
    let cropY = 0;
    let offsetX = 0;
    let offsetY = 0;
    if (rng() > 0.5) {
        const maxRatio = inRange ? CONSTANTS.MAX_CROP_RATIO : 2.5;
        cropX = randRange(rng, 0, maxRatio);
        cropY = randRange(rng, 0, maxRatio);
        offsetX = randRange(rng, -cropX, cropX);
        offsetY = randRange(rng, -cropY, cropY);
        if (inRange) {
            // Keep the generated window inside what clampCropWindow accepts, so
            // this population isolates rounding from clamping.
            const c = clampCropWindow(cropX, cropY, offsetX, offsetY, CONSTANTS.MAX_CROP_RATIO);
            cropX = c.cropX;
            cropY = c.cropY;
            offsetX = c.offsetX;
            offsetY = c.offsetY;
        }
    }

    return {
        params: {
            mode: MODE_NUMBERS[randInt(rng, 0, MODE_NUMBERS.length - 1)],
            shiftX,
            shiftY,
            alignTransform,
            cropX,
            cropY,
            offsetX,
            offsetY,
        },
        format: VALID_STEREO_FORMATS[randInt(rng, 0, VALID_STEREO_FORMATS.length - 1)],
    };
}

/**
 * Reduce a view state to the quantities the shader consumes, which is what the
 * round trip has to preserve.
 *
 * @param {Object} params
 * @returns {Object}
 */
function renderState(params) {
    const rz = alignTransformToRotZoom(params.alignTransform) ?? { rotationDeg: 0, zoomPct: 0 };
    const align = Array.isArray(params.alignTransform) ? params.alignTransform : IDENTITY;
    return {
        shiftX: params.shiftX ?? 0,
        // The exporter's single vertical value: shiftY folded with the matrix
        // constant. Equals the negated shader constant a[7] - shiftY.
        verticalUv: (params.shiftY ?? 0) - (align[7] ?? 0),
        rotationDeg: rz.rotationDeg,
        zoomPct: rz.zoomPct,
        cropX: params.cropX ?? 0,
        cropY: params.cropY ?? 0,
        offsetX: params.offsetX ?? 0,
        offsetY: params.offsetY ?? 0,
    };
}

/**
 * Rebuild a view state from parsed URL parameters, following the sequence in
 * js/loaders/loader-external.js: the roll/zoom matrix first, then the vertical
 * value split into shiftY and the matrix constant.
 *
 * @param {Object} parsed - parser outputs, null where the key was absent
 * @param {{width:number, height:number}} image
 * @returns {Object} view state
 */
function reconstruct(parsed, image) {
    const out = {
        mode: parsed.mode ?? 0,
        shiftX: 0,
        shiftY: 0,
        alignTransform: IDENTITY.slice(),
        cropX: 0,
        cropY: 0,
        offsetX: 0,
        offsetY: 0,
    };

    const hasRotZoom = parsed.rotation !== null || parsed.zoom !== null;
    const baseAlign = hasRotZoom
        ? rotZoomToAlignTransform(parsed.rotation ?? 0, parsed.zoom ?? 0)
        : null;

    if (parsed.x !== null) out.shiftX = parsed.x / image.width;

    if (parsed.y !== null) {
        const normalizedY = parsed.y / image.height;
        const split = splitVerticalShift(normalizedY, baseAlign ?? IDENTITY.slice(), MAX_SHIFT_UV);
        out.shiftY = split.shiftY;
        out.alignTransform = split.alignTransform;
    } else if (baseAlign) {
        out.alignTransform = baseAlign;
    }

    if (parsed.crop) {
        out.cropX = parsed.crop.cropX;
        out.cropY = parsed.crop.cropY;
        out.offsetX = parsed.crop.offsetX;
        out.offsetY = parsed.crop.offsetY;
    }

    return out;
}

/**
 * Run every parser over the keys of a viewer link.
 *
 * @param {string} link
 * @returns {Object}
 */
function parseViewerLink(link) {
    const query = new URL(link).searchParams;
    const value = (key) => (query.has(key) ? query.get(key) : null);
    const shiftX = value('x') === null ? null : parseShiftParam(value('x'));
    const shiftY = value('y') === null ? null : parseShiftParam(value('y'));
    const rotation = value('r') === null ? null : parseRotationParam(value('r'));
    const zoom = value('z') === null ? null : parseZoomParam(value('z'));
    const crop = value('crop') === null ? null : parseCropParam(value('crop'));
    return {
        format: value('format') === null ? null : parseFormatParam(value('format')),
        mode: value('mode') === null ? null : parseModeParam(value('mode')),
        x: shiftX ? shiftX.value : null,
        y: shiftY ? shiftY.value : null,
        rotation: rotation ? rotation.value : null,
        zoom: zoom ? zoom.value : null,
        crop,
        clamped: Boolean(
            shiftX?.clamped || shiftY?.clamped || rotation?.clamped || zoom?.clamped || crop?.clamped,
        ),
    };
}

/**
 * Run every parser over the key=value tokens of a URL-list line, following the
 * tokenizer in js/ui/ui-viewer.js.
 *
 * @param {string} line
 * @returns {Object}
 */
function parseListLine(line) {
    const parsed = {
        format: null, mode: null, x: null, y: null, rotation: null, zoom: null,
        crop: null, clamped: false,
    };
    // The first field is the URL; the rest are key=value tokens.
    for (const part of line.split(' ').slice(1)) {
        const trimmed = part.trim();
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex < 0) continue;
        const key = trimmed.substring(0, eqIndex).trim().toLowerCase();
        const raw = trimmed.substring(eqIndex + 1).trim();
        if (key === 'format') {
            const v = parseFormatParam(raw);
            if (v !== null) parsed.format = v;
        } else if (key === 'x' || key === 'y') {
            const v = parseShiftParam(raw);
            if (v !== null) {
                parsed[key] = v.value;
                parsed.clamped ||= v.clamped;
            }
        } else if (key === 'r') {
            const v = parseRotationParam(raw);
            if (v !== null) {
                parsed.rotation = v.value;
                parsed.clamped ||= v.clamped;
            }
        } else if (key === 'z') {
            const v = parseZoomParam(raw);
            if (v !== null) {
                parsed.zoom = v.value;
                parsed.clamped ||= v.clamped;
            }
        } else if (key === 'crop') {
            const v = parseCropParam(raw);
            if (v !== null) {
                parsed.crop = v;
                parsed.clamped ||= v.clamped;
            }
        } else if (key === 'mode') {
            const v = parseModeParam(raw);
            if (v !== null) parsed.mode = v;
        }
    }
    return parsed;
}

/** Parameters compared after each round trip. */
const COMPARED = ['shiftX', 'verticalUv', 'rotationDeg', 'zoomPct', 'cropX', 'cropY', 'offsetX', 'offsetY'];

/**
 * The error the serialization format admits for each parameter, given the image
 * size the pixel-valued ones were written against.
 *
 *   shiftX, verticalUv  written as whole pixels, so half a pixel in normalized
 *                       units
 *   rotationDeg, zoomPct four decimals, and dropped entirely below
 *                       ALIGN_EXPORT_EPS, so the larger of the two
 *   cropX, cropY        five decimals
 *   offsetX, offsetY    five decimals, plus the same again because
 *                       clampCropWindow bounds the offset by a cropX/cropY that
 *                       has itself been rounded
 *
 * @param {{width:number, height:number}} image
 * @returns {Object<string, number>}
 */
function analyticalBounds(image) {
    return {
        shiftX: 0.5 / image.width,
        verticalUv: 0.5 / image.height,
        rotationDeg: Math.max(5e-5, ALIGN_EXPORT_EPS),
        zoomPct: Math.max(5e-5, ALIGN_EXPORT_EPS),
        cropX: 5e-6,
        cropY: 5e-6,
        offsetX: 1e-5,
        offsetY: 1e-5,
    };
}

/**
 * Drive one population of states through one link format at one image size.
 *
 * @param {Object} options
 * @returns {{rows:Array<Object>, splitChanged:number, constantMaxDeviation:number, modeMismatches:number, formatMismatches:number}}
 */
function measureRoundTrip({ rng, image, population, linkFormat, samples }) {
    const errors = Object.fromEntries(COMPARED.map((p) => [p, []]));
    let clampedCount = 0;
    let splitChanged = 0;
    let constantMaxDeviation = 0;
    let modeMismatches = 0;
    let formatMismatches = 0;

    for (let i = 0; i < samples; i++) {
        const { params, format } = randomState(rng, image, population);
        const link = linkFormat === 'viewer'
            ? buildViewerUrl({ baseUrl: BASE_URL, url: IMAGE_URL, params, format, image })
            : buildListLine({ url: IMAGE_URL, params, format, image });
        const parsed = linkFormat === 'viewer' ? parseViewerLink(link) : parseListLine(link);
        if (parsed.clamped) clampedCount++;

        const rebuilt = reconstruct(parsed, image);
        const before = renderState(params);
        const after = renderState(rebuilt);
        for (const key of COMPARED) errors[key].push(Math.abs(after[key] - before[key]));

        // The vertical value may be apportioned differently between shiftY and
        // the matrix constant; only their combination has to survive.
        if ((params.shiftY ?? 0) !== rebuilt.shiftY) splitChanged++;
        const deviation = Math.abs(
            (rebuilt.alignTransform[7] - rebuilt.shiftY) - (params.alignTransform[7] - params.shiftY),
        );
        if (deviation > constantMaxDeviation) constantMaxDeviation = deviation;

        if ((parsed.mode ?? 0) !== params.mode) modeMismatches++;
        if (parsed.format !== format) formatMismatches++;
    }

    const bounds = analyticalBounds(image);
    // The bound describes what the serialization rounds away. It does not apply
    // to the clamping population, where the loss is the parser enforcing its
    // documented limit, so those rows report the observed error alone.
    const boundsApply = population === 'in-range';
    const rows = COMPARED.map((key) => {
        const sorted = errors[key].slice().sort((a, b) => a - b);
        const max = sorted[sorted.length - 1] ?? 0;
        const bound = bounds[key];
        return {
            link_format: linkFormat,
            population,
            parameter: key,
            image_width: image.width,
            image_height: image.height,
            samples,
            clamped_samples: clampedCount,
            error_median: num(percentile(sorted, 0.5), 12),
            error_p99: num(percentile(sorted, 0.99), 12),
            error_max: num(max, 12),
            analytical_bound: boundsApply ? num(bound, 12) : '',
            within_bound: boundsApply ? String(max <= bound) : '',
        };
    });

    return { rows, splitChanged, constantMaxDeviation, modeMismatches, formatMismatches, clampedCount };
}

/**
 * Check the crop window verticalCropFromSampling returns.
 *
 * The window is the largest range of the cropped vertical coordinate for which
 * the right eye's sample stays inside the source image. Both the crop mapping
 * and the sampling are affine in the cropped coordinate and in u, so testing the
 * four corners tests the whole window.
 *
 * @param {() => number} rng
 * @param {number} samples
 * @returns {{samples:number, violations:number, degenerate:number, maxExcursion:number}}
 */
function checkBlackFreeCrop(rng, samples) {
    let violations = 0;
    let degenerate = 0;
    let maxExcursion = 0;

    for (let i = 0; i < samples; i++) {
        const rotationDeg = randRange(rng, -CONSTANTS.MAX_ROTATION_DEG, CONSTANTS.MAX_ROTATION_DEG);
        const zoomPct = randRange(rng, -CONSTANTS.MAX_ZOOM_PCT, CONSTANTS.MAX_ZOOM_PCT);
        const shiftY = randRange(rng, -MAX_SHIFT_UV, MAX_SHIFT_UV);
        const align = rotZoomToAlignTransform(rotationDeg, zoomPct);
        // Half the cases also carry a folded constant, as an adopted affine does.
        if (rng() > 0.5) align[7] = randRange(rng, -0.25, 0.25);

        const { cropY, offsetY } = verticalCropFromSampling(align, shiftY);
        if (!(cropY < 1)) {
            // No usable window exists for this transform; nothing to sample.
            degenerate++;
            continue;
        }

        const A = align[1];
        const B = align[4];
        const C = align[7] - shiftY;
        let worst = 0;
        for (const baseY of [0, 1]) {
            const originalY = baseY * (1 - cropY) + cropY * 0.5 + offsetY * 0.5;
            for (const u of [0, 1]) {
                const srcY = A * u + B * originalY + C;
                const excursion = Math.max(0 - srcY, srcY - 1, 0);
                if (excursion > worst) worst = excursion;
            }
        }
        if (worst > maxExcursion) maxExcursion = worst;
        // A window computed in floating point can miss the boundary by an ulp or
        // so; anything beyond that is a real excursion outside the source.
        if (worst > 1e-9) violations++;
    }

    return { samples, violations, degenerate, maxExcursion };
}

/**
 * Check that clampCropWindow is idempotent and respects its documented ranges.
 *
 * @param {() => number} rng
 * @param {number} samples
 * @returns {{samples:number, violations:number, nonIdempotent:number}}
 */
function checkCropClamp(rng, samples) {
    let violations = 0;
    let nonIdempotent = 0;
    for (let i = 0; i < samples; i++) {
        const cropX = randRange(rng, -1, 3);
        const cropY = randRange(rng, -1, 3);
        const offsetX = randRange(rng, -3, 3);
        const offsetY = randRange(rng, -3, 3);
        const first = clampCropWindow(cropX, cropY, offsetX, offsetY, CONSTANTS.MAX_CROP_RATIO);
        if (!first) continue;
        const inRange =
            first.cropX >= 0 && first.cropX <= CONSTANTS.MAX_CROP_RATIO &&
            first.cropY >= 0 && first.cropY <= CONSTANTS.MAX_CROP_RATIO &&
            Math.abs(first.offsetX) <= first.cropX + 1e-12 &&
            Math.abs(first.offsetY) <= first.cropY + 1e-12;
        if (!inRange) violations++;
        const second = clampCropWindow(first.cropX, first.cropY, first.offsetX, first.offsetY, CONSTANTS.MAX_CROP_RATIO);
        if (!second
            || second.cropX !== first.cropX || second.cropY !== first.cropY
            || second.offsetX !== first.offsetX || second.offsetY !== first.offsetY) {
            nonIdempotent++;
        }
    }
    return { samples, violations, nonIdempotent };
}

/** Fixed hostile inputs every parser is fed, alongside generated ones. */
const FUZZ_LITERALS = [
    '', ' ', '\t', '\n', 'NaN', 'Infinity', '-Infinity', 'null', 'undefined',
    'true', 'false', '0x10', '1e400', '-1e400', '1e-400', '.', '-', '+', 'e',
    '1,2', '1,2,3', '1,2,3,4,5', '1,,3,4', ',,,', '1;2;3;4',
    '１２３', '٣', '½', ' ', '￿', 'anaglyph ', '<script>alert(1)</script>',
    '../../etc/passwd', '%2e%2e%2f', 'Infinity,Infinity,Infinity,Infinity',
    'a'.repeat(4096), '9'.repeat(400), '-0', '0.0000000000000000001',
    '  12  ', '12abc', 'abc12', '1 2', 'full_sbs', 'FULL_SBS', 'parallel',
];

/**
 * Feed malformed input to every parser and record what came back.
 *
 * Every parser is documented to return null for input it does not accept, so a
 * thrown exception, a non-finite number or an out-of-range value would each be a
 * departure from that contract.
 *
 * @param {() => number} rng
 * @param {number} samples
 * @returns {Array<Object>} one row per parser
 */
function fuzzParsers(rng, samples) {
    const randomString = () => {
        const length = randInt(rng, 0, 24);
        let s = '';
        for (let i = 0; i < length; i++) s += String.fromCodePoint(randInt(rng, 0, 0x2fff));
        return s;
    };

    const parsers = [
        {
            name: 'parseShiftParam',
            run: parseShiftParam,
            accept: (r) => Number.isFinite(r.value) && Math.abs(r.value) <= CONSTANTS.MAX_SHIFT_PX,
        },
        {
            name: 'parseRotationParam',
            run: parseRotationParam,
            accept: (r) => Number.isFinite(r.value) && Math.abs(r.value) <= CONSTANTS.MAX_ROTATION_DEG,
        },
        {
            name: 'parseZoomParam',
            run: parseZoomParam,
            accept: (r) => Number.isFinite(r.value) && Math.abs(r.value) <= CONSTANTS.MAX_ZOOM_PCT,
        },
        {
            name: 'parseCropParam',
            run: parseCropParam,
            accept: (r) => [r.cropX, r.cropY, r.offsetX, r.offsetY].every(Number.isFinite)
                && r.cropX >= 0 && r.cropX <= CONSTANTS.MAX_CROP_RATIO
                && r.cropY >= 0 && r.cropY <= CONSTANTS.MAX_CROP_RATIO
                && Math.abs(r.offsetX) <= r.cropX + 1e-12
                && Math.abs(r.offsetY) <= r.cropY + 1e-12,
        },
        {
            name: 'parseFormatParam',
            run: parseFormatParam,
            accept: (r) => VALID_STEREO_FORMATS.includes(r),
        },
        {
            name: 'parseModeParam',
            run: parseModeParam,
            accept: (r) => Number.isInteger(r) && MODE_NUMBERS.includes(r),
        },
    ];

    return parsers.map(({ name, run, accept }) => {
        let exceptions = 0;
        let nulls = 0;
        let accepted = 0;
        let contractViolations = 0;
        let total = 0;

        const feed = (input) => {
            total++;
            let result;
            try {
                result = run(input);
            } catch {
                exceptions++;
                return;
            }
            if (result === null || result === undefined) {
                nulls++;
                return;
            }
            accepted++;
            if (!accept(result)) contractViolations++;
        };

        for (const literal of FUZZ_LITERALS) feed(literal);
        for (let i = 0; i < samples; i++) feed(randomString());
        // Non-string inputs: the parsers are reached from URL parsing, but a
        // list line or a caller could hand them anything.
        for (const value of [null, undefined, 0, -0, NaN, Infinity, -Infinity, [], {}, true]) feed(value);

        return {
            parser: name,
            inputs: total,
            exceptions,
            rejected_null: nulls,
            accepted,
            contract_violations: contractViolations,
        };
    });
}

/** Columns of the per-parameter error table. */
const ERROR_COLUMNS = [
    'link_format', 'population', 'parameter', 'image_width', 'image_height',
    'samples', 'clamped_samples',
    'error_median', 'error_p99', 'error_max', 'analytical_bound', 'within_bound',
];

/** Columns of the invariants table. */
const INVARIANT_COLUMNS = ['invariant', 'samples', 'violations', 'observations', 'max_deviation'];

/** Columns of the fuzz table. */
const FUZZ_COLUMNS = ['parser', 'inputs', 'exceptions', 'rejected_null', 'accepted', 'contract_violations'];

const args = parseArgs(process.argv.slice(2));
const samples = Number(args.samples ?? 200000);
const seed = Number(args.seed ?? 20240917);
const rng = createRng(seed);

const errorRows = [];
const invariantRows = [];

// The per-parameter sweep is split across image sizes and both link formats;
// dividing the sample budget keeps the total work independent of the axes.
const perCell = Math.max(1000, Math.floor(samples / (IMAGE_WIDTHS.length * 2 * 2)));

let totalSplitChanged = 0;
let totalConstantDeviation = 0;
let totalModeMismatches = 0;
let totalFormatMismatches = 0;
let roundTripSamples = 0;

for (const width of IMAGE_WIDTHS) {
    const image = { width, height: Math.round(width * 9 / 16) };
    for (const linkFormat of ['viewer', 'list']) {
        for (const population of ['in-range', 'clamping']) {
            const result = measureRoundTrip({ rng, image, population, linkFormat, samples: perCell });
            errorRows.push(...result.rows);
            totalSplitChanged += result.splitChanged;
            totalConstantDeviation = Math.max(totalConstantDeviation, result.constantMaxDeviation);
            totalModeMismatches += result.modeMismatches;
            totalFormatMismatches += result.formatMismatches;
            roundTripSamples += perCell;
            process.stderr.write(
                `  ${linkFormat} ${population} ${image.width}x${image.height}: ` +
                `${perCell} states, ${result.clampedCount} clamped\n`,
            );
        }
    }
}

invariantRows.push({
    invariant: 'vertical_sampling_constant_preserved',
    samples: roundTripSamples,
    violations: '',
    observations: `shiftY re-split differently in ${totalSplitChanged} states`,
    max_deviation: num(totalConstantDeviation, 12),
});
invariantRows.push({
    invariant: 'mode_round_trips',
    samples: roundTripSamples,
    violations: totalModeMismatches,
    observations: '',
    max_deviation: '',
});
invariantRows.push({
    invariant: 'format_round_trips',
    samples: roundTripSamples,
    violations: totalFormatMismatches,
    observations: '',
    max_deviation: '',
});

const cropSamples = Math.max(1000, Math.floor(samples / 2));
const blackFree = checkBlackFreeCrop(rng, cropSamples);
invariantRows.push({
    invariant: 'auto_crop_window_samples_inside_source',
    samples: blackFree.samples,
    violations: blackFree.violations,
    observations: `${blackFree.degenerate} transforms admit no window`,
    max_deviation: num(blackFree.maxExcursion, 12),
});

const clampCheck = checkCropClamp(rng, cropSamples);
invariantRows.push({
    invariant: 'crop_window_clamped_in_range',
    samples: clampCheck.samples,
    violations: clampCheck.violations,
    observations: '',
    max_deviation: '',
});
invariantRows.push({
    invariant: 'crop_window_clamp_idempotent',
    samples: clampCheck.samples,
    violations: clampCheck.nonIdempotent,
    observations: '',
    max_deviation: '',
});

const fuzzRows = fuzzParsers(rng, Math.max(1000, Math.floor(samples / 10)));

const { csvPaths } = writeTables({
    bench: 'params-roundtrip',
    tables: [
        { name: 'params-roundtrip', columns: ERROR_COLUMNS, rows: errorRows },
        { name: 'params-roundtrip-invariants', columns: INVARIANT_COLUMNS, rows: invariantRows },
        { name: 'params-roundtrip-fuzz', columns: FUZZ_COLUMNS, rows: fuzzRows },
    ],
    parameters: {
        seed,
        requested_samples: samples,
        states_per_cell: perCell,
        crop_invariant_samples: cropSamples,
        image_widths: IMAGE_WIDTHS,
        image_aspect: '16:9',
        link_formats: ['viewer', 'list'],
        populations: ['in-range', 'clamping'],
        base_url: BASE_URL,
        align_export_eps: ALIGN_EXPORT_EPS,
        max_shift_px: CONSTANTS.MAX_SHIFT_PX,
        max_rotation_deg: CONSTANTS.MAX_ROTATION_DEG,
        max_zoom_pct: CONSTANTS.MAX_ZOOM_PCT,
        max_crop_ratio: CONSTANTS.MAX_CROP_RATIO,
        max_shift_uv: MAX_SHIFT_UV,
        mode_count: MODE_NUMBERS.length,
    },
});

const outOfBound = errorRows.filter((r) => r.within_bound === 'false');
process.stderr.write(`\nwrote:\n${csvPaths.map((p) => `  ${p}`).join('\n')}\n`);
process.stderr.write(`parameters above their analytical bound: ${outOfBound.length} of ${errorRows.length}\n`);
for (const row of outOfBound) {
    process.stderr.write(
        `  ${row.link_format} ${row.population} ${row.parameter} @${row.image_width}: ` +
        `max ${row.error_max} > bound ${row.analytical_bound}\n`,
    );
}
process.stderr.write(
    `invariant violations: ${invariantRows.filter((r) => Number(r.violations) > 0).length} of ${invariantRows.length} checks\n`,
);
process.stderr.write(
    `parser contract violations: ${fuzzRows.reduce((s, r) => s + r.exceptions + r.contract_violations, 0)}\n`,
);
