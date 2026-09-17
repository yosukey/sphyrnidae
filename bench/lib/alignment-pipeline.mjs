/**
 * bench/lib/alignment-pipeline.mjs
 *
 * Replica of the OpenCV call sequence that js/rendering/alignment.js runs when
 * the user presses Auto-align.
 *
 * The application's own function cannot be called here: performAutoAlignment()
 * reads the image out of a THREE.js material, reads its options out of the DOM
 * and reports through a toast, so importing js/rendering/alignment.js under Node
 * fails before any of its arithmetic runs. This module therefore reproduces the
 * sequence rather than wrapping it:
 *
 *   matFromArray(CV_8UC4) -> roi() per eye -> cvtColor(RGBA2GRAY)
 *   -> detectAndCompute -> BFMatcher(crossCheck=true).match
 *   -> the `deltas` records the estimators consume
 *
 * The parts that are pure are imported from the application rather than copied:
 * cropWindowToAnalysisRect() decides the analysis window here exactly as it does
 * in the application, and the estimators in alignment-geometry.js and
 * alignment-shift.js are called directly by the benchmarks.
 *
 * Two deliberate differences from the application, both recorded in the
 * benchmark manifests:
 *   - The application reaches the analysis resolution through a canvas
 *     drawImage() downscale; there is no canvas here, so callers that need a
 *     resize use resizeRgba() below, which is cv.resize with INTER_AREA.
 *   - swapLR is always false. The swapped case exchanges the two ROIs and
 *     changes no arithmetic.
 */

import { createHash } from 'node:crypto';
import { CONSTANTS } from '../../js/globals.js';
import { cropWindowToAnalysisRect } from '../../js/rendering/alignment-geometry.js';
import { release } from './opencv.mjs';

/** Detector choices offered by the application's algorithm select. */
export const ALGORITHMS = ['orb', 'akaze', 'sift'];

/** Feature cap the application passes to the ORB constructor. */
export const ORB_FEATURES = 2000;

/**
 * Maximum analysis dimension, taken from the application rather than repeated,
 * so a change there reaches the benchmarks instead of leaving them measuring a
 * resolution the application no longer uses.
 */
export const ANALYSIS_RESIZE_MAX_DIMENSION = CONSTANTS.ANALYSIS_RESIZE_MAX_DIMENSION;

/**
 * The analysis size the application would choose for an image of this size.
 * Mirrors the scale computation in performAutoAlignment(); note that it does not
 * clamp to 1, so an image smaller than the maximum is scaled up.
 *
 * @param {number} width - full frame width (both eyes)
 * @param {number} height
 * @param {number} [maxDimension=ANALYSIS_RESIZE_MAX_DIMENSION]
 * @returns {{width:number, height:number, scale:number}}
 */
export function analysisSize(width, height, maxDimension = ANALYSIS_RESIZE_MAX_DIMENSION) {
    const scale = Math.min(maxDimension / width, maxDimension / height);
    return { width: Math.floor(width * scale), height: Math.floor(height * scale), scale };
}

/**
 * Resample an RGBA buffer with cv.resize(INTER_AREA).
 *
 * @param {Object} cv
 * @param {Buffer|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} outWidth
 * @param {number} outHeight
 * @returns {Buffer} RGBA of the requested size
 */
export function resizeRgba(cv, rgba, width, height, outWidth, outHeight) {
    const src = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
    const dst = new cv.Mat();
    try {
        cv.resize(src, dst, new cv.Size(outWidth, outHeight), 0, 0, cv.INTER_AREA);
        return Buffer.from(dst.data);
    } finally {
        release([src, dst]);
    }
}

/**
 * Construct the detector the application would construct for an algorithm name.
 *
 * @param {Object} cv
 * @param {'orb'|'akaze'|'sift'} algorithm
 * @returns {Object} an OpenCV Feature2D; the caller releases it
 */
function createDetector(cv, algorithm) {
    if (algorithm === 'akaze') return new cv.AKAZE();
    if (algorithm === 'sift') return new cv.SIFT();
    return new cv.ORB(ORB_FEATURES);
}

/** Fields captured per keypoint, in the order extractFeatures packs them. */
export const KEYPOINT_FIELDS = ['x', 'y', 'size', 'angle', 'response', 'octave'];

/**
 * Copy a detector's output out of the WASM heap into plain typed arrays.
 *
 * Keypoint geometry and descriptor bytes are kept apart so a difference between
 * two runs can be attributed to one or the other: a detector that places its
 * keypoints identically but describes them differently is a different situation
 * from one that finds different keypoints.
 *
 * @param {Object} keypoints - cv.KeyPointVector
 * @param {Object} descriptors - cv.Mat
 * @returns {{count:number, geometry:Float64Array, descriptors:Uint8Array, descriptorCols:number}}
 */
export function extractFeatures(keypoints, descriptors) {
    const count = keypoints.size();
    const geometry = new Float64Array(count * KEYPOINT_FIELDS.length);
    for (let i = 0; i < count; i++) {
        const kp = keypoints.get(i);
        const base = i * KEYPOINT_FIELDS.length;
        geometry[base] = kp.pt.x;
        geometry[base + 1] = kp.pt.y;
        geometry[base + 2] = kp.size;
        geometry[base + 3] = kp.angle;
        geometry[base + 4] = kp.response;
        geometry[base + 5] = kp.octave;
    }
    return {
        count,
        geometry,
        descriptors: Uint8Array.from(descriptors.data),
        descriptorCols: descriptors.cols,
    };
}

/**
 * Hex SHA-256 over a typed array's bytes.
 *
 * @param {ArrayBufferView} view
 * @returns {string}
 */
export function digestBytes(view) {
    return createHash('sha256')
        .update(Buffer.from(view.buffer, view.byteOffset, view.byteLength))
        .digest('hex');
}

/**
 * Pack a match list into one array: query index, train index and the exact
 * distance bits for every match.
 *
 * @param {Array<{queryIdx:number, trainIdx:number, distance:number}>} matches
 * @returns {Float64Array}
 */
function packMatches(matches) {
    const packed = new Float64Array(matches.length * 3);
    for (let i = 0; i < matches.length; i++) {
        packed[i * 3] = matches[i].queryIdx;
        packed[i * 3 + 1] = matches[i].trainIdx;
        packed[i * 3 + 2] = matches[i].distance;
    }
    return packed;
}

/**
 * Run detection and matching over one side-by-side RGBA frame.
 *
 * @param {Object} cv
 * @param {Object} options
 * @param {Buffer|Uint8Array} options.rgba - side-by-side frame, RGBA
 * @param {number} options.width - full frame width (both eyes)
 * @param {number} options.height
 * @param {'orb'|'akaze'|'sift'} [options.algorithm='orb']
 * @param {Object} [options.cropParams] - crop window in the application's
 *        normalized form; omitted means the full frame
 * @param {boolean} [options.collectRaw=false] - also return the packed keypoint
 *        geometry, descriptor bytes and match list, so two runs can be diffed
 *        element by element rather than only by digest
 * @returns {{
 *   stages: {cvtColorMs:number, detectLeftMs:number, detectRightMs:number, matchMs:number, pipelineMs:number},
 *   keypointsLeft:number, keypointsRight:number, matchCount:number,
 *   eyeWidth:number, height:number, window:Object,
 *   deltas:Array<Object>,
 *   digests?:{keypointsLeft:string, keypointsRight:string, descriptorsLeft:string, descriptorsRight:string, matches:string},
 *   raw?:{keypointsLeft:Float64Array, keypointsRight:Float64Array, descriptorsLeft:Uint8Array, descriptorsRight:Uint8Array, matches:Float64Array}
 * }}
 *   `digests` and `raw` are present only when collectRaw is set.
 *   `deltas` holds one record per match with the same fields alignment.js
 *   builds: dx, dy, dist, y, gu, gv, gDisp.
 */
export function runPipeline(cv, {
    rgba, width, height, algorithm = 'orb', cropParams = {}, collectRaw = false,
}) {
    if (!ALGORITHMS.includes(algorithm)) {
        throw new Error(`unknown algorithm "${algorithm}"`);
    }
    if (algorithm === 'sift' && typeof cv.SIFT === 'undefined') {
        throw new Error('this OpenCV build was compiled without SIFT');
    }

    const halfW = Math.floor(width / 2);
    const win = cropWindowToAnalysisRect(cropParams, halfW, height);

    const resources = [];
    const pipelineStart = performance.now();
    try {
        const src = cv.matFromArray(height, width, cv.CV_8UC4, rgba);
        resources.push(src);

        const rectL = new cv.Rect(win.x, win.y, win.width, win.height);
        const rectR = new cv.Rect(halfW + win.x, win.y, win.width, win.height);
        const imgL = src.roi(rectL);
        resources.push(imgL);
        const imgR = src.roi(rectR);
        resources.push(imgR);

        const keypoints1 = new cv.KeyPointVector();
        resources.push(keypoints1);
        const keypoints2 = new cv.KeyPointVector();
        resources.push(keypoints2);
        const descriptors1 = new cv.Mat();
        resources.push(descriptors1);
        const descriptors2 = new cv.Mat();
        resources.push(descriptors2);

        const detector = createDetector(cv, algorithm);
        resources.push(detector);

        const maskL = new cv.Mat();
        resources.push(maskL);
        const maskR = new cv.Mat();
        resources.push(maskR);

        const grayL = new cv.Mat();
        resources.push(grayL);
        const grayR = new cv.Mat();
        resources.push(grayR);

        const tCvt = performance.now();
        cv.cvtColor(imgL, grayL, cv.COLOR_RGBA2GRAY);
        cv.cvtColor(imgR, grayR, cv.COLOR_RGBA2GRAY);
        const tDetectL = performance.now();
        detector.detectAndCompute(grayL, maskL, keypoints1, descriptors1);
        const tDetectR = performance.now();
        detector.detectAndCompute(grayR, maskR, keypoints2, descriptors2);
        const tMatch = performance.now();

        if (keypoints1.size() === 0 || keypoints2.size() === 0) {
            throw new Error('no features found');
        }

        const normType = algorithm === 'sift' ? cv.NORM_L2 : cv.NORM_HAMMING;
        const bf = new cv.BFMatcher(normType, true);
        resources.push(bf);
        const matchVector = new cv.DMatchVector();
        resources.push(matchVector);
        bf.match(descriptors1, descriptors2, matchVector);
        const tEnd = performance.now();

        const matchCount = matchVector.size();
        const matches = new Array(matchCount);
        const deltas = new Array(matchCount);
        for (let i = 0; i < matchCount; i++) {
            const m = matchVector.get(i);
            matches[i] = { queryIdx: m.queryIdx, trainIdx: m.trainIdx, distance: m.distance };
            const kp1 = keypoints1.get(m.queryIdx);
            const kp2 = keypoints2.get(m.trainIdx);
            const dx = kp2.pt.x - kp1.pt.x;
            const dy = kp2.pt.y - kp1.pt.y;
            deltas[i] = {
                dx,
                dy,
                dist: m.distance,
                y: win.y + kp1.pt.y,
                gu: (win.x + kp1.pt.x) / halfW,
                gv: 1 - (win.y + kp1.pt.y) / height,
                gDisp: dy / height,
            };
        }

        // Copying the keypoints and descriptors off the WASM heap, and hashing
        // them, costs as much as a detector pass on a large frame. It is work
        // the application never does, and only the run that captures the output
        // needs it, so a timed run skips it entirely rather than spending a
        // caller's time budget on it.
        const featuresL = collectRaw ? extractFeatures(keypoints1, descriptors1) : null;
        const featuresR = collectRaw ? extractFeatures(keypoints2, descriptors2) : null;
        const packedMatches = collectRaw ? packMatches(matches) : null;

        const result = {
            stages: {
                cvtColorMs: tDetectL - tCvt,
                detectLeftMs: tDetectR - tDetectL,
                detectRightMs: tMatch - tDetectR,
                matchMs: tEnd - tMatch,
                pipelineMs: tEnd - pipelineStart,
            },
            keypointsLeft: keypoints1.size(),
            keypointsRight: keypoints2.size(),
            matchCount,
            eyeWidth: halfW,
            height,
            window: { x: win.x, y: win.y, width: win.width, height: win.height, restricted: win.restricted },
            deltas,
        };
        if (collectRaw) {
            result.digests = {
                keypointsLeft: digestBytes(featuresL.geometry),
                keypointsRight: digestBytes(featuresR.geometry),
                descriptorsLeft: digestBytes(featuresL.descriptors),
                descriptorsRight: digestBytes(featuresR.descriptors),
                matches: digestBytes(packedMatches),
            };
            result.raw = {
                keypointsLeft: featuresL.geometry,
                keypointsRight: featuresR.geometry,
                descriptorsLeft: featuresL.descriptors,
                descriptorsRight: featuresR.descriptors,
                matches: packedMatches,
            };
        }
        return result;
    } finally {
        release(resources);
    }
}

/**
 * Convert the pipeline's `deltas` into the point records estimateVerticalAffine
 * consumes, exactly as alignment.js does before calling it.
 *
 * @param {Array<Object>} deltas
 * @returns {Array<{u:number, v:number, t:number, dist:number}>}
 */
export function deltasToAffinePoints(deltas) {
    return deltas.map((d) => ({ u: d.gu, v: d.gv, t: d.gDisp, dist: d.dist }));
}

/**
 * Compare two numeric arrays element by element.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {{sameLength:boolean, length:number, differing:number, maxAbsDiff:number}}
 *          When the lengths differ, only the common prefix is compared and
 *          sameLength reports false.
 */
function compareArrays(a, b) {
    const n = Math.min(a.length, b.length);
    let differing = 0;
    let maxAbsDiff = 0;
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) {
            differing++;
            const d = Math.abs(a[i] - b[i]);
            if (d > maxAbsDiff) maxAbsDiff = d;
        }
    }
    return { sameLength: a.length === b.length, length: n, differing, maxAbsDiff };
}

/**
 * Quantify the difference between two raw pipeline captures of the same input.
 *
 * Reported per component rather than as one verdict, because the components
 * answer different questions: whether the detector placed its keypoints in the
 * same positions, whether it described them with the same bytes, and whether
 * the matcher then paired them the same way.
 *
 * @param {Object} a - the `raw` field of one runPipeline result
 * @param {Object} b - the `raw` field of another
 * @returns {Object} one entry per component
 */
export function compareRaw(a, b) {
    return {
        keypointsLeft: compareArrays(a.keypointsLeft, b.keypointsLeft),
        keypointsRight: compareArrays(a.keypointsRight, b.keypointsRight),
        descriptorsLeft: compareArrays(a.descriptorsLeft, b.descriptorsLeft),
        descriptorsRight: compareArrays(a.descriptorsRight, b.descriptorsRight),
        matches: compareArrays(a.matches, b.matches),
    };
}
