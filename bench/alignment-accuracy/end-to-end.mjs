/**
 * bench/alignment-accuracy/end-to-end.mjs
 *
 * Measures auto-alignment on real stereo photographs whose true correspondence
 * is known, through the whole path the application takes.
 *
 * Corpus
 *   The half-resolution MiddEval3 training set (bench/alignment-accuracy/
 *   fetch-datasets.mjs). Each scene is a rectified stereo pair, so it starts
 *   with no vertical disparity, plus a floating-point disparity map giving the
 *   exact horizontal correspondence for almost every pixel and a mask marking
 *   which pixels are visible in both views.
 *
 *   When that corpus has not been downloaded, or when --corpus=synthetic asks
 *   for it, the scenes come from bench/lib/stereo-scene.mjs instead. Those are
 *   stacks of fronto-parallel planes, so their disparity and their visibility
 *   mask are exact by construction; they carry none of what a photograph
 *   carries beyond texture, so they stand in for the corpus rather than
 *   replacing it. Which one a run used is recorded in the manifest.
 *
 * Procedure
 *   The two views are laid out as one side-by-side frame. A known vertical
 *   misalignment is then applied to the right eye alone, as a camera rig's roll
 *   and vertical-scale error would be: the warp is a function of right-image
 *   coordinates, not of the left. The frame is downscaled the way the
 *   application downscales it, and handed to the same detector, matcher and
 *   estimators the application uses.
 *
 * Because the disparity map gives the true correspondence of every pixel, the
 * vertical disparity each pixel actually carries after the warp is known
 * exactly, and so is what remains of it after a correction. Measurements are
 * taken over those correspondences rather than over the feature matches, which
 * are a biased sample of the frame.
 *
 * Three corrections are compared at each condition:
 *   uncorrected   the vertical disparity the warp introduced
 *   shift-only    the application's default path: one constant, from
 *                 estimateDisparityComfortShift
 *   affine        the optional refinement: the field from
 *                 estimateVerticalAffine, when its gate adopts it, and the
 *                 shift-only result when it does not
 *
 * A fourth number, the best-fit residual, is the least-squares fit of the same
 * three-parameter field to the true correspondences. It is the smallest
 * residual this family of corrections admits for the scene, whatever estimator
 * produced it.
 *
 * Horizontal disparity
 *   The second table records how much each correction changes the scene's
 *   horizontal disparity, which is what carries its depth. Three corrections are
 *   measured the same way, over the same correspondences:
 *     vertical-affine     the matrix estimateVerticalAffine returned, read as
 *                         the display-to-source map the shader applies
 *     estimate-affine-2d  the affine cv.estimateAffine2D fits from the right
 *                         eye's matched keypoints to the left eye's
 *     find-homography     the projective transform cv.findHomography fits from
 *                         the same matches, with RANSAC
 *   A correction that shifts the whole scene horizontally moves it towards or
 *   away from the viewer without altering relative depth, so the median change
 *   is removed and the remaining spread is what is reported. The scene's own
 *   disparity spread is reported alongside, in the same pixels.
 *
 * Out-of-model input
 *   A final condition applies a perspective warp, which this family cannot
 *   represent, and records what the estimator's gate decided.
 *
 * Outputs
 *   alignment-accuracy-end-to-end.csv   one row per (scene, condition, algorithm)
 *   alignment-accuracy-depth.csv        horizontal-disparity change per method
 *
 * Usage
 *   node bench/alignment-accuracy/end-to-end.mjs
 *     [--corpus=middlebury|synthetic] [--scenes=4]
 *     [--algorithms=orb,akaze,sift] [--build=simd] [--stride=2]
 */

import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadOpenCV, release } from '../lib/opencv.mjs';
import { decodePng, toRgba } from '../lib/png.mjs';
import { decodePfm } from '../lib/pfm.mjs';
import {
    ALGORITHMS,
    analysisSize,
    deltasToAffinePoints,
    resizeRgba,
    runPipeline,
} from '../lib/alignment-pipeline.mjs';
import { estimateVerticalAffine } from '../../js/rendering/alignment-geometry.js';
import { estimateDisparityComfortShift } from '../../js/rendering/alignment-shift.js';
import { percentile, num } from '../lib/stats.mjs';
import { writeTables } from '../lib/run-manifest.mjs';
import { renderStereoScene } from '../lib/stereo-scene.mjs';
import { SCENE_FILES, TRAINING_DIR } from './fetch-datasets.mjs';

/**
 * Vertical misalignments applied to the right eye. roll and zoom are the
 * quantities the application reports; dy is a constant vertical offset in
 * pixels of the full-resolution frame.
 */
const WARP_CONDITIONS = [
    { name: 'none', rollDeg: 0, zoomPct: 0, dyPx: 0 },
    { name: 'shift-only', rollDeg: 0, zoomPct: 0, dyPx: 8 },
    { name: 'roll-small', rollDeg: 1, zoomPct: 0, dyPx: 3 },
    { name: 'roll-large', rollDeg: 4, zoomPct: 0, dyPx: -5 },
    { name: 'zoom', rollDeg: 0, zoomPct: 2, dyPx: 4 },
    { name: 'roll-and-zoom', rollDeg: 2.5, zoomPct: 1.5, dyPx: 6 },
];

/**
 * Out-of-model condition: a perspective warp of the right eye, whose vertical
 * disparity varies as a ratio rather than linearly.
 */
const KEYSTONE_CONDITION = { name: 'keystone', rollDeg: 2, zoomPct: 1, dyPx: 4, keystone: 6e-5 };

/** Mask value marking a pixel visible in both views. */
const MASK_NON_OCCLUDED = 255;

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

/** Scenes the MiddEval3 training archive contains, for a completeness warning. */
const EXPECTED_MIDDLEBURY_SCENES = 15;

/** Seeds of the generated scenes, used when the corpus is `synthetic`. */
const SYNTHETIC_SEEDS = [11, 22, 33, 44, 55, 66, 77, 88];

/** Per-eye size of a generated scene. */
const SYNTHETIC_EYE_WIDTH = 900;
const SYNTHETIC_HEIGHT = 700;

/**
 * Whether the downloaded corpus is present.
 *
 * @returns {boolean}
 */
function middleburyAvailable() {
    return existsSync(TRAINING_DIR)
        && readdirSync(TRAINING_DIR, { withFileTypes: true })
            .some((e) => e.isDirectory() && SCENE_FILES.every((f) => existsSync(join(TRAINING_DIR, e.name, f))));
}

/**
 * List the scenes of a corpus.
 *
 * @param {'middlebury'|'synthetic'} corpus
 * @returns {string[]} scene names, sorted
 */
function listScenes(corpus) {
    if (corpus === 'synthetic') {
        return SYNTHETIC_SEEDS.map((seed) => `synthetic-${seed}`);
    }
    if (!existsSync(TRAINING_DIR)) {
        throw new Error(
            `corpus not found at ${TRAINING_DIR}; run bench/alignment-accuracy/fetch-datasets.mjs first, ` +
            'or pass --corpus=synthetic to measure against generated scenes instead',
        );
    }
    return readdirSync(TRAINING_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => SCENE_FILES.every((f) => existsSync(join(TRAINING_DIR, name, f))))
        .sort();
}

/**
 * Build a scene from bench/lib/stereo-scene.mjs, in the same shape a
 * Middlebury scene is loaded into.
 *
 * The generated scene is a stack of fronto-parallel planes, so its disparity is
 * exact rather than measured, and its visibility mask is exact too. It carries
 * less of what a photograph carries — no slanted surfaces, no specular
 * highlights, no sensor noise beyond what is asked for — so it stands in for the
 * corpus rather than replacing it.
 *
 * @param {string} name - `synthetic-<seed>`
 * @returns {Object}
 */
function buildSyntheticScene(name) {
    const seed = Number(name.split('-')[1]);
    const scene = renderStereoScene({
        eyeWidth: SYNTHETIC_EYE_WIDTH,
        height: SYNTHETIC_HEIGHT,
        seed,
        content: 'textured',
    });
    // The Middlebury mask marks a co-visible pixel with 255; match that, so the
    // correspondence collector needs no special case.
    const mask = Buffer.alloc(scene.eyeWidth * scene.height);
    for (let i = 0; i < mask.length; i++) mask[i] = scene.visible[i] ? MASK_NON_OCCLUDED : 0;

    return {
        name,
        eyeWidth: scene.eyeWidth,
        height: scene.height,
        width: scene.width,
        leftRgba: scene.left,
        rightRgba: scene.right,
        disparity: scene.disparity,
        mask,
        maskChannels: 1,
    };
}

/**
 * Load one scene and lay its two views out as a side-by-side frame.
 *
 * @param {string} name
 * @returns {{
 *   name:string, width:number, height:number, eyeWidth:number,
 *   sbs:Buffer, right:Buffer, disparity:Float32Array, mask:Buffer
 * }}
 */
function loadScene(name) {
    if (name.startsWith('synthetic-')) return buildSyntheticScene(name);
    const dir = join(TRAINING_DIR, name);
    const left = decodePng(readFileSync(join(dir, 'im0.png')));
    const right = decodePng(readFileSync(join(dir, 'im1.png')));
    const disp = decodePfm(readFileSync(join(dir, 'disp0GT.pfm')));
    const mask = decodePng(readFileSync(join(dir, 'mask0nocc.png')));

    if (left.width !== right.width || left.height !== right.height) {
        throw new Error(`${name}: the two views differ in size`);
    }
    if (disp.width !== left.width || disp.height !== left.height) {
        throw new Error(`${name}: disparity map does not match the image size`);
    }

    const eyeWidth = left.width;
    const height = left.height;
    const leftRgba = toRgba(left);
    const rightRgba = toRgba(right);

    return {
        name,
        eyeWidth,
        height,
        width: eyeWidth * 2,
        leftRgba,
        rightRgba,
        disparity: disp.data,
        mask: mask.channels === 1 ? mask.data : toRgba(mask),
        maskChannels: mask.channels === 1 ? 1 : 4,
    };
}

/**
 * The forward affine that turns the aligned right eye into a misaligned one.
 *
 * The vertical disparity it introduces, written in the coordinates the
 * estimator fits in (u across the eye, v up the frame), is
 *
 *   disp(u, v) = d * u + e * v + f,  d = tan(roll), e = zoom/100, f = dy / height
 *
 * which rearranges to the affine below. The top row is the identity, so the warp
 * is purely vertical and the pair's horizontal disparity is untouched.
 *
 * @param {{rollDeg:number, zoomPct:number, dyPx:number}} condition
 * @param {number} eyeWidth
 * @param {number} height
 * @returns {{a:number, b:number, c:number, d:number, e:number, f:number}}
 *          a, b, c are the second row of the 2x3 forward affine; d, e, f are the
 *          disparity-field coefficients the estimator should recover
 */
function warpMatrix(condition, eyeWidth, height) {
    const d = Math.tan(condition.rollDeg * Math.PI / 180);
    const e = condition.zoomPct / 100;
    const f = condition.dyPx / height;
    return {
        a: (height * d) / eyeWidth,
        b: 1 - e,
        c: height * e + condition.dyPx,
        d,
        e,
        f,
    };
}

/**
 * Apply the misalignment to the right eye and assemble the side-by-side frame.
 *
 * @param {Object} cv
 * @param {Object} scene
 * @param {Object} condition
 * @returns {{sbs:Buffer, matrix:Object}}
 */
function buildMisalignedFrame(cv, scene, condition) {
    const { eyeWidth, height } = scene;
    const matrix = warpMatrix(condition, eyeWidth, height);

    const src = cv.matFromArray(height, eyeWidth, cv.CV_8UC4, scene.rightRgba);
    const dst = new cv.Mat();
    const resources = [src, dst];
    let warpedRight;
    try {
        if (condition.keystone) {
            // A perspective warp: the same vertical affine plus a denominator
            // that varies across the frame, so the vertical disparity is a ratio
            // rather than a linear function and no member of the fitted family
            // reproduces it.
            const m = cv.matFromArray(3, 3, cv.CV_64F, [
                1, 0, 0,
                matrix.a, matrix.b, matrix.c,
                condition.keystone, 0, 1,
            ]);
            resources.push(m);
            cv.warpPerspective(src, dst, m, new cv.Size(eyeWidth, height),
                cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
        } else {
            const m = cv.matFromArray(2, 3, cv.CV_64F, [
                1, 0, 0,
                matrix.a, matrix.b, matrix.c,
            ]);
            resources.push(m);
            cv.warpAffine(src, dst, m, new cv.Size(eyeWidth, height),
                cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
        }
        warpedRight = Buffer.from(dst.data);
    } finally {
        release(resources);
    }

    const width = eyeWidth * 2;
    const sbs = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        scene.leftRgba.copy(sbs, y * width * 4, y * eyeWidth * 4, (y + 1) * eyeWidth * 4);
        warpedRight.copy(sbs, (y * width + eyeWidth) * 4, y * eyeWidth * 4, (y + 1) * eyeWidth * 4);
    }
    return { sbs, matrix };
}

/**
 * Where a right-eye point lands after the applied warp.
 *
 * @param {Object} condition
 * @param {Object} matrix - from warpMatrix()
 * @param {number} x
 * @param {number} y
 * @returns {{x:number, y:number}}
 */
function applyWarp(condition, matrix, x, y) {
    const yPrime = matrix.a * x + matrix.b * y + matrix.c;
    if (!condition.keystone) return { x, y: yPrime };
    const w = condition.keystone * x + 1;
    return { x: x / w, y: yPrime / w };
}

/**
 * Collect the true correspondences of a scene, expressed in the coordinates the
 * estimator works in.
 *
 * @param {Object} scene
 * @param {Object} condition
 * @param {Object} matrix
 * @param {number} stride - sample every `stride`-th pixel on each axis
 * @returns {{u:Float64Array, v:Float64Array, t:Float64Array,
 *            rightX:Float64Array, rightY:Float64Array, leftU:Float64Array,
 *            horizontalUv:Float64Array, count:number}}
 */
function collectCorrespondences(scene, condition, matrix, stride) {
    const { eyeWidth, height, disparity, mask, maskChannels } = scene;
    const capacity = Math.ceil(height / stride) * Math.ceil(eyeWidth / stride);
    const u = new Float64Array(capacity);
    const v = new Float64Array(capacity);
    const t = new Float64Array(capacity);
    const rightX = new Float64Array(capacity);
    const rightY = new Float64Array(capacity);
    const horizontalUv = new Float64Array(capacity);
    let count = 0;

    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < eyeWidth; x += stride) {
            const index = y * eyeWidth + x;
            if (mask[index * maskChannels] !== MASK_NON_OCCLUDED) continue;
            const d = disparity[index];
            if (!Number.isFinite(d)) continue;
            const xr = x - d;
            if (xr < 0 || xr > eyeWidth - 1) continue;

            const warped = applyWarp(condition, matrix, xr, y);
            u[count] = x / eyeWidth;
            // v is flip-corrected, matching the gv the application computes.
            v[count] = 1 - y / height;
            t[count] = (warped.y - y) / height;
            rightX[count] = warped.x;
            rightY[count] = warped.y;
            horizontalUv[count] = (x - warped.x) / eyeWidth;
            count++;
        }
    }

    return {
        u: u.subarray(0, count),
        v: v.subarray(0, count),
        t: t.subarray(0, count),
        rightX: rightX.subarray(0, count),
        rightY: rightY.subarray(0, count),
        horizontalUv: horizontalUv.subarray(0, count),
        count,
    };
}

/**
 * Least-squares fit of disp = d*u + e*v + f to the true correspondences: the
 * best this family of corrections can do for the scene.
 *
 * @param {Object} correspondences
 * @returns {{d:number, e:number, f:number}|null}
 */
function bestFitField({ u, v, t, count }) {
    let suu = 0, suv = 0, su = 0, svv = 0, sv = 0, sn = count;
    let sut = 0, svt = 0, st = 0;
    for (let i = 0; i < count; i++) {
        const a = u[i];
        const b = v[i];
        const y = t[i];
        suu += a * a; suv += a * b; su += a;
        svv += b * b; sv += b;
        sut += a * y; svt += b * y; st += y;
    }
    const A = [[suu, suv, su], [suv, svv, sv], [su, sv, sn]];
    const rhs = [sut, svt, st];

    // Gaussian elimination with partial pivoting.
    const M = A.map((row, i) => [...row, rhs[i]]);
    for (let col = 0; col < 3; col++) {
        let pivot = col;
        for (let row = col + 1; row < 3; row++) {
            if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
        }
        if (Math.abs(M[pivot][col]) < 1e-12) return null;
        [M[col], M[pivot]] = [M[pivot], M[col]];
        for (let row = col + 1; row < 3; row++) {
            const factor = M[row][col] / M[col][col];
            for (let k = col; k < 4; k++) M[row][k] -= factor * M[col][k];
        }
    }
    const x = [0, 0, 0];
    for (let i = 2; i >= 0; i--) {
        let s = M[i][3];
        for (let k = i + 1; k < 3; k++) s -= M[i][k] * x[k];
        x[i] = s / M[i][i];
    }
    return { d: x[0], e: x[1], f: x[2] };
}

/**
 * Residual statistics of a correction over the true correspondences.
 *
 * @param {Object} correspondences
 * @param {{d:number, e:number, f:number}} field - the correction applied
 * @param {number} height - to express the residual in pixels as well
 * @returns {{rmsUv:number, p95Uv:number, maxUv:number, rmsPx:number, p95Px:number, maxPx:number}}
 */
function residualStats({ u, v, t, count }, field, height) {
    const values = new Float64Array(count);
    let sum = 0;
    for (let i = 0; i < count; i++) {
        const r = t[i] - (field.d * u[i] + field.e * v[i] + field.f);
        values[i] = Math.abs(r);
        sum += r * r;
    }
    const sorted = Array.from(values).sort((a, b) => a - b);
    const rmsUv = Math.sqrt(sum / Math.max(1, count));
    const p95Uv = percentile(sorted, 0.95);
    const maxUv = sorted[sorted.length - 1] ?? 0;
    return {
        rmsUv, p95Uv, maxUv,
        rmsPx: rmsUv * height,
        p95Px: p95Uv * height,
        maxPx: maxUv * height,
    };
}

/**
 * Fit, to the matched keypoints, the transform that maps the right eye onto the
 * left, and return the horizontal coordinate it sends a right-eye point to.
 *
 * Both fits are given the same matches the estimators saw, in per-eye
 * normalized coordinates so the transform does not depend on the analysis
 * resolution.
 *
 * @param {Object} cv
 * @param {Array<Object>} deltas - matches, in analysis pixels
 * @param {number} analysisEyeWidth
 * @param {number} analysisHeight
 * @param {'affine'|'homography'} kind
 * @returns {((rx:number, ry:number) => number)|null} null if the fit failed
 */
function fitRightToLeft(cv, deltas, analysisEyeWidth, analysisHeight, kind) {
    if (deltas.length < 4) return null;

    const rightPts = [];
    const leftPts = [];
    for (const delta of deltas) {
        const leftX = delta.gu;
        const leftY = 1 - delta.gv;
        rightPts.push(leftX + delta.dx / analysisEyeWidth, leftY + delta.dy / analysisHeight);
        leftPts.push(leftX, leftY);
    }

    const srcMat = cv.matFromArray(deltas.length, 1, cv.CV_32FC2, rightPts);
    const dstMat = cv.matFromArray(deltas.length, 1, cv.CV_32FC2, leftPts);
    const resources = [srcMat, dstMat];
    try {
        const fitted = kind === 'homography'
            ? cv.findHomography(srcMat, dstMat, cv.RANSAC, 3 / analysisEyeWidth)
            : cv.estimateAffine2D(srcMat, dstMat);
        resources.push(fitted);
        if (fitted.empty()) return null;
        const m = Array.from(fitted.data64F);
        if (kind === 'homography') {
            return (rx, ry) => (m[0] * rx + m[1] * ry + m[2]) / (m[6] * rx + m[7] * ry + m[8]);
        }
        return (rx, ry) => m[0] * rx + m[1] * ry + m[2];
    } finally {
        release(resources);
    }
}

/**
 * Where the application's own correction sends a right-eye point horizontally.
 *
 * The estimator returns a display-to-source sampling matrix: the shader reads
 * the right eye at M * [u, v, 1]. Solving that for the display position of a
 * given source point gives where the point ends up on screen. This reads the
 * matrix the estimator actually returned rather than assuming its shape.
 *
 * @param {number[]|null} matrix - column-major mat3, or null when the estimator
 *        did not adopt one and the shift-only path applies
 * @returns {(rx:number, ry:number) => number}
 */
function verticalAffineMapper(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 9) {
        // Shift-only: the correction is a constant vertical offset.
        return (rx) => rx;
    }
    // Column-major: the display-to-source map's horizontal row is
    // (m[0], m[3], m[6]), so srcX = m00 * u + m01 * v + m02 and the display u of
    // a source point needs that row solved for u.
    //
    // v there is the display's vertical coordinate, measured upward, while the
    // caller passes source coordinates measured downward. Solving for u in
    // general would need the vertical row solved first, so the two are only
    // separable when the horizontal row has no v term. Rather than silently
    // assume that, the general case is refused: alignment-geometry.js builds a
    // matrix whose horizontal row is the identity, and a matrix that ever gains
    // a horizontal term needs this rewritten, not approximated.
    const [m00, , , m01, , , m02] = matrix;
    if (m01 !== 0) {
        throw new Error(
            'the alignment matrix has a horizontal dependence on the vertical coordinate; '
            + 'this mapper cannot invert it without solving the vertical row first',
        );
    }
    if (m00 === 0) throw new Error('the alignment matrix collapses the horizontal coordinate');
    return (rx) => (rx - m02) / m00;
}

/**
 * Measure how much a correction changes the scene's horizontal disparity.
 *
 * A single global shift moves the whole scene towards or away from the viewer
 * without altering relative depth, so it is removed before the spread is
 * reported; what remains is the part that changes the scene's depth structure.
 *
 * @param {(rx:number, ry:number) => number} mapX
 * @param {Object} correspondences
 * @param {Object} scene
 * @returns {{spreadUv:number, maxUv:number, spreadPx:number, maxPx:number}}
 */
function horizontalDisparityChange(mapX, correspondences, scene) {
    const { u, rightX, rightY, horizontalUv, count } = correspondences;
    const { eyeWidth, height } = scene;
    const changes = new Float64Array(count);
    for (let i = 0; i < count; i++) {
        const mappedX = mapX(rightX[i] / eyeWidth, rightY[i] / height);
        changes[i] = (u[i] - mappedX) - horizontalUv[i];
    }

    const centre = percentile(Array.from(changes).sort((a, b) => a - b), 0.5);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < count; i++) {
        const deviation = changes[i] - centre;
        sum += deviation * deviation;
        const abs = Math.abs(deviation);
        if (abs > max) max = abs;
    }
    const spreadUv = Math.sqrt(sum / Math.max(1, count));
    return { spreadUv, maxUv: max, spreadPx: spreadUv * eyeWidth, maxPx: max * eyeWidth };
}

/**
 * Spread of the scene's own horizontal disparity, which is the quantity the
 * corrections are being measured against.
 *
 * @param {Object} correspondences
 * @param {Object} scene
 * @returns {{rmsPx:number, rangePx:number}}
 */
function horizontalDisparitySpread({ horizontalUv, count }, scene) {
    const values = Array.from(horizontalUv.subarray(0, count)).sort((a, b) => a - b);
    const centre = percentile(values, 0.5);
    let sum = 0;
    for (const value of values) sum += (value - centre) * (value - centre);
    return {
        rmsPx: Math.sqrt(sum / Math.max(1, count)) * scene.eyeWidth,
        rangePx: (percentile(values, 0.95) - percentile(values, 0.05)) * scene.eyeWidth,
    };
}

/** Columns of the residual table. */
const RESIDUAL_COLUMNS = [
    'scene', 'condition', 'algorithm', 'eye_width', 'height',
    'analysis_width', 'analysis_height', 'correspondences', 'matches',
    'applied_roll_deg', 'applied_zoom_pct', 'applied_dy_px',
    'adopted', 'reason',
    'recovered_roll_deg', 'recovered_zoom_pct',
    'best_fit_roll_deg', 'best_fit_zoom_pct',
    'err_roll_deg', 'err_zoom_pct',
    'uncorrected_rms_px', 'uncorrected_p95_px',
    'shift_only_rms_px', 'shift_only_p95_px',
    'affine_rms_px', 'affine_p95_px',
    'best_fit_rms_px', 'best_fit_p95_px',
    'uncorrected_rms_uv', 'shift_only_rms_uv', 'affine_rms_uv', 'best_fit_rms_uv',
];

/** Columns of the horizontal-disparity table. */
const DEPTH_COLUMNS = [
    'scene', 'condition', 'algorithm', 'method', 'correspondences',
    'scene_disparity_rms_px', 'scene_disparity_p05_p95_range_px',
    'horizontal_disparity_change_rms_px', 'horizontal_disparity_change_max_px',
    'horizontal_disparity_change_rms_uv', 'horizontal_disparity_change_max_uv',
    'fitted',
];

const args = parseArgs(process.argv.slice(2));
const build = args.build ?? 'simd';
const stride = Number(args.stride ?? 2);
const algorithms = args.algorithms
    ? String(args.algorithms).split(',').map((a) => a.trim()).filter((a) => ALGORITHMS.includes(a))
    : ['orb'];

// The corpus is chosen explicitly. Falling back to generated scenes when the
// download is missing would write synthetic numbers into the files that hold
// the Middlebury results, under the same names, on the strength of one line of
// stderr; a run that cannot measure what was asked for stops instead.
const corpus = args.corpus ?? 'middlebury';
if (!['middlebury', 'synthetic'].includes(corpus)) {
    throw new Error(`unknown corpus "${corpus}"; expected middlebury or synthetic`);
}
if (corpus === 'middlebury' && !middleburyAvailable()) {
    throw new Error(
        `the Middlebury corpus is not present at ${TRAINING_DIR}.\n`
        + 'Run bench/alignment-accuracy/fetch-datasets.mjs to download it (about 160 MB), '
        + 'or pass --corpus=synthetic to measure against generated scenes instead. '
        + 'The two write to the same result files, so the corpus is never chosen implicitly.',
    );
}
const allScenes = listScenes(corpus);
const sceneLimit = args.scenes ? Number(args.scenes) : allScenes.length;
const scenes = allScenes.slice(0, sceneLimit);
if (!scenes.length) throw new Error('no usable scenes found in the corpus');
if (corpus === 'middlebury' && !args.scenes && allScenes.length < EXPECTED_MIDDLEBURY_SCENES) {
    process.stderr.write(
        `warning: ${allScenes.length} of the ${EXPECTED_MIDDLEBURY_SCENES} expected scenes are present; `
        + 'the archive may be partly extracted\n',
    );
}
process.stderr.write(`corpus: ${corpus} (${scenes.length} scenes)\n`);

const { cv } = await loadOpenCV(build);

const residualRows = [];
const depthRows = [];
const conditions = [...WARP_CONDITIONS, KEYSTONE_CONDITION];

for (const sceneName of scenes) {
    const scene = loadScene(sceneName);
    const analysis = analysisSize(scene.width, scene.height);
    process.stderr.write(
        `${sceneName} (${scene.eyeWidth}x${scene.height} per eye -> ` +
        `${analysis.width}x${analysis.height} analysis)\n`,
    );

    for (const condition of conditions) {
        const { sbs, matrix } = buildMisalignedFrame(cv, scene, condition);
        const correspondences = collectCorrespondences(scene, condition, matrix, stride);
        const best = bestFitField(correspondences) ?? { d: 0, e: 0, f: 0 };

        const resized = resizeRgba(cv, sbs, scene.width, scene.height, analysis.width, analysis.height);

        for (const algorithm of algorithms) {
            let pipeline;
            try {
                pipeline = runPipeline(cv, {
                    rgba: resized,
                    width: analysis.width,
                    height: analysis.height,
                    algorithm,
                });
            } catch (err) {
                process.stderr.write(`  ${condition.name} ${algorithm}: ${err.message}\n`);
                continue;
            }

            const shift = estimateDisparityComfortShift(pipeline.deltas, {});
            // alignment.js converts the analysis-pixel correction into the
            // normalized units the shader uses by dividing by the analysis
            // height; the same conversion applies here.
            const shiftOnlyField = { d: 0, e: 0, f: shift.dyCorrection / analysis.height };

            const geometry = estimateVerticalAffine(deltasToAffinePoints(pipeline.deltas));
            const appliedField = geometry.adopted
                ? { d: geometry.d, e: geometry.e, f: geometry.f }
                : shiftOnlyField;

            const uncorrected = residualStats(correspondences, { d: 0, e: 0, f: 0 }, scene.height);
            const shiftOnly = residualStats(correspondences, shiftOnlyField, scene.height);
            const affine = residualStats(correspondences, appliedField, scene.height);
            const bestFit = residualStats(correspondences, best, scene.height);

            const bestRollDeg = Math.atan(best.d) * 180 / Math.PI;
            const bestZoomPct = best.e * 100;

            residualRows.push({
                scene: sceneName,
                condition: condition.name,
                algorithm,
                eye_width: scene.eyeWidth,
                height: scene.height,
                analysis_width: analysis.width,
                analysis_height: analysis.height,
                correspondences: correspondences.count,
                matches: pipeline.matchCount,
                applied_roll_deg: num(condition.rollDeg, 6),
                applied_zoom_pct: num(condition.zoomPct, 6),
                applied_dy_px: num(condition.dyPx, 6),
                adopted: String(geometry.adopted),
                reason: geometry.reason,
                recovered_roll_deg: geometry.adopted ? num(geometry.rollDeg, 6) : '',
                recovered_zoom_pct: geometry.adopted ? num(geometry.zoomPct, 6) : '',
                best_fit_roll_deg: num(bestRollDeg, 6),
                best_fit_zoom_pct: num(bestZoomPct, 6),
                err_roll_deg: geometry.adopted ? num(Math.abs(geometry.rollDeg - bestRollDeg), 6) : '',
                err_zoom_pct: geometry.adopted ? num(Math.abs(geometry.zoomPct - bestZoomPct), 6) : '',
                uncorrected_rms_px: num(uncorrected.rmsPx, 6),
                uncorrected_p95_px: num(uncorrected.p95Px, 6),
                shift_only_rms_px: num(shiftOnly.rmsPx, 6),
                shift_only_p95_px: num(shiftOnly.p95Px, 6),
                affine_rms_px: num(affine.rmsPx, 6),
                affine_p95_px: num(affine.p95Px, 6),
                best_fit_rms_px: num(bestFit.rmsPx, 6),
                best_fit_p95_px: num(bestFit.p95Px, 6),
                uncorrected_rms_uv: num(uncorrected.rmsUv, 9),
                shift_only_rms_uv: num(shiftOnly.rmsUv, 9),
                affine_rms_uv: num(affine.rmsUv, 9),
                best_fit_rms_uv: num(bestFit.rmsUv, 9),
            });

            const analysisEyeWidth = Math.floor(analysis.width / 2);
            const spread = horizontalDisparitySpread(correspondences, scene);
            const mappers = [
                ['vertical-affine', verticalAffineMapper(geometry.adopted ? geometry.matrix : null)],
                ['estimate-affine-2d', fitRightToLeft(cv, pipeline.deltas, analysisEyeWidth, analysis.height, 'affine')],
                ['find-homography', fitRightToLeft(cv, pipeline.deltas, analysisEyeWidth, analysis.height, 'homography')],
            ];
            for (const [name, mapX] of mappers) {
                const result = mapX
                    ? horizontalDisparityChange(mapX, correspondences, scene)
                    : { spreadUv: NaN, maxUv: NaN, spreadPx: NaN, maxPx: NaN };
                depthRows.push({
                    scene: sceneName,
                    condition: condition.name,
                    algorithm,
                    method: name,
                    correspondences: correspondences.count,
                    scene_disparity_rms_px: num(spread.rmsPx, 6),
                    scene_disparity_p05_p95_range_px: num(spread.rangePx, 6),
                    horizontal_disparity_change_rms_px: num(result.spreadPx, 9),
                    horizontal_disparity_change_max_px: num(result.maxPx, 9),
                    horizontal_disparity_change_rms_uv: num(result.spreadUv, 12),
                    horizontal_disparity_change_max_uv: num(result.maxUv, 12),
                    fitted: String(Boolean(mapX)),
                });
            }

            process.stderr.write(
                `  ${condition.name.padEnd(14)} ${algorithm.padEnd(5)} ` +
                `matches=${String(pipeline.matchCount).padStart(4)} ` +
                `adopted=${String(geometry.adopted).padEnd(5)} ` +
                `${geometry.reason.padEnd(15)} ` +
                `residual px: ${uncorrected.rmsPx.toFixed(2)} -> ` +
                `${shiftOnly.rmsPx.toFixed(2)} (shift) -> ` +
                `${affine.rmsPx.toFixed(2)} (applied), floor ${bestFit.rmsPx.toFixed(2)}\n`,
            );
        }
    }
}

const { csvPaths } = writeTables({
    bench: 'alignment-accuracy-end-to-end',
    tables: [
        { name: 'alignment-accuracy-end-to-end', columns: RESIDUAL_COLUMNS, rows: residualRows },
        { name: 'alignment-accuracy-depth', columns: DEPTH_COLUMNS, rows: depthRows },
    ],
    parameters: {
        corpus,
        corpus_description: corpus === 'middlebury'
            ? 'MiddEval3 trainingH (half resolution), https://vision.middlebury.edu/stereo/submit3/'
            : `generated by bench/lib/stereo-scene.mjs at ${SYNTHETIC_EYE_WIDTH}x${SYNTHETIC_HEIGHT} per eye`,
        scenes,
        conditions: conditions.map((c) => ({ ...c })),
        algorithms,
        opencv_build: build,
        correspondence_stride: stride,
        mask: 'mask0nocc.png, pixels valued 255 (visible in both views)',
        analysis_resize_max_dimension: 1024,
        resize_interpolation: 'INTER_AREA',
        warp_interpolation: 'INTER_LINEAR, BORDER_REPLICATE',
    },
});

process.stderr.write(`\nwrote:\n${csvPaths.map((p) => `  ${p}`).join('\n')}\n`);
