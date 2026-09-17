/**
 * bench/lib/stereo-scene.mjs
 *
 * Generates a synthetic side-by-side stereo frame together with its exact
 * horizontal disparity map.
 *
 * Two benchmarks need inputs that no download can supply. alignment-latency
 * needs frames whose texture content it controls directly, because the cost of
 * feature detection and of brute-force matching both scale with how many
 * keypoints an image yields. alignment-accuracy takes these scenes as its
 * corpus when the Middlebury archives have not been downloaded, which is what
 * `--corpus=synthetic` selects explicitly.
 *
 * The scene is a stack of fronto-parallel rectangles. A fronto-parallel surface
 * at depth Z has a single disparity d = f*B/Z across its whole extent, so the
 * right view of each rectangle is its left view translated by exactly d pixels
 * and the correspondence (x, y) <-> (x - d, y) is exact rather than resampled.
 * Rectangles are painted far-to-near in both views independently, which
 * reproduces occlusion without any depth test. The result has zero vertical
 * disparity by construction, which is the same starting condition a rectified
 * Middlebury pair provides.
 *
 * Every value derives from the seed, so a frame is reproducible from the seed
 * recorded in the result manifest.
 */

import { createRng, randInt, randRange } from './stats.mjs';

/** Texture regimes, chosen to span the keypoint yields the pipeline can meet. */
export const CONTENT_CLASSES = ['textured', 'low-texture', 'noisy'];

/**
 * Build a value-noise sampler: a lattice of random values, bilinearly
 * interpolated, summed over octaves.
 *
 * Octave amplitudes fall by `persistence` rather than by half. A halving
 * schedule puts almost all the energy in the coarsest octave, which produces
 * smooth blobs that a corner detector largely ignores; keeping the fine octaves
 * strong is what gives the detector something to find.
 *
 * @param {() => number} rng
 * @param {number} octaves
 * @param {number} baseCell - lattice spacing in pixels for the first octave
 * @param {number} [persistence=0.8] - amplitude ratio between successive octaves
 * @returns {(x:number, y:number) => number} value in [0, 1]
 */
function makeValueNoise(rng, octaves, baseCell, persistence = 0.8) {
    const layers = [];
    let cell = baseCell;
    let amplitude = 1;
    let total = 0;
    for (let o = 0; o < octaves; o++) {
        const size = 64;
        const grid = new Float32Array(size * size);
        for (let i = 0; i < grid.length; i++) grid[i] = rng();
        layers.push({ grid, size, cell, amplitude });
        total += amplitude;
        cell = Math.max(2, cell / 2);
        amplitude *= persistence;
    }
    return (x, y) => {
        let sum = 0;
        for (const { grid, size, cell: c, amplitude: a } of layers) {
            const fx = x / c;
            const fy = y / c;
            const x0 = Math.floor(fx);
            const y0 = Math.floor(fy);
            const tx = fx - x0;
            const ty = fy - y0;
            const i00 = ((y0 % size) + size) % size;
            const i10 = ((( y0 + 1) % size) + size) % size;
            const j00 = ((x0 % size) + size) % size;
            const j10 = (((x0 + 1) % size) + size) % size;
            const v00 = grid[i00 * size + j00];
            const v01 = grid[i00 * size + j10];
            const v10 = grid[i10 * size + j00];
            const v11 = grid[i10 * size + j10];
            const top = v00 * (1 - tx) + v01 * tx;
            const bottom = v10 * (1 - tx) + v11 * tx;
            sum += (top * (1 - ty) + bottom * ty) * a;
        }
        return sum / total;
    };
}

/**
 * Per-content-class texture parameters. `noise` is additive white noise applied
 * per pixel, which raises the detector's response floor without adding
 * repeatable structure.
 */
const CONTENT_PARAMS = {
    'textured': { octaves: 5, baseCell: 32, persistence: 0.85, contrast: 150, noise: 4 },
    'low-texture': { octaves: 2, baseCell: 220, persistence: 0.45, contrast: 26, noise: 2 },
    'noisy': { octaves: 5, baseCell: 32, persistence: 0.85, contrast: 120, noise: 40 },
};

/**
 * Render a synthetic stereo frame.
 *
 * @param {Object} options
 * @param {number} options.eyeWidth - width of one eye in pixels
 * @param {number} options.height - frame height in pixels
 * @param {number} options.seed
 * @param {string} [options.content='textured'] - one of CONTENT_CLASSES
 * @param {number} [options.layerCount=8] - rectangles drawn in front of the background
 * @returns {{
 *   eyeWidth:number, height:number, width:number,
 *   sbs:Buffer, left:Buffer, right:Buffer,
 *   disparity:Float32Array, visible:Uint8Array
 * }} `sbs` is the RGBA side-by-side frame (left eye then right eye), `left` and
 *    `right` the per-eye RGBA buffers, `disparity` the per-left-pixel
 *    horizontal disparity in pixels, and `visible` a 1 for each left pixel that
 *    is also visible in the right view. Measurements over correspondences must
 *    use `visible`: the remainder are occluded, and there is nothing in the
 *    right view for their disparity to point at.
 */
export function renderStereoScene({ eyeWidth, height, seed, content = 'textured', layerCount = 8 }) {
    if (!CONTENT_CLASSES.includes(content)) {
        throw new Error(`unknown content class "${content}"`);
    }
    const params = CONTENT_PARAMS[content];
    const rng = createRng(seed);

    // Background sits farthest away, so it carries the smallest disparity.
    const layers = [{
        x0: 0, y0: 0, x1: eyeWidth, y1: height,
        disparity: 2,
        noise: makeValueNoise(rng, params.octaves, params.baseCell, params.persistence),
        tint: [1, 1, 1],
        base: 118,
    }];

    for (let i = 0; i < layerCount; i++) {
        const w = randInt(rng, Math.floor(eyeWidth * 0.12), Math.floor(eyeWidth * 0.42));
        const h = randInt(rng, Math.floor(height * 0.12), Math.floor(height * 0.46));
        const x0 = randInt(rng, 0, Math.max(0, eyeWidth - w));
        const y0 = randInt(rng, 0, Math.max(0, height - h));
        layers.push({
            x0, y0, x1: x0 + w, y1: y0 + h,
            // Nearer rectangles get larger disparity. The range stays inside the
            // comfort limits the application works with on a frame this size.
            disparity: Math.round(randRange(rng, 6, Math.max(10, eyeWidth * 0.05))),
            noise: makeValueNoise(rng, params.octaves, params.baseCell, params.persistence),
            tint: [randRange(rng, 0.6, 1), randRange(rng, 0.6, 1), randRange(rng, 0.6, 1)],
            base: randRange(rng, 70, 170),
        });
    }
    // Paint far to near so the nearer rectangle wins where they overlap.
    layers.sort((a, b) => a.disparity - b.disparity);

    const left = Buffer.alloc(eyeWidth * height * 4, 255);
    const right = Buffer.alloc(eyeWidth * height * 4, 255);
    const disparity = new Float32Array(eyeWidth * height);
    // Which layer ends up visible at each pixel of each view. Two rectangles at
    // different depths overlap differently in the two views, so a left pixel
    // whose corresponding right pixel belongs to a different layer is occluded:
    // genuinely so, as it would be in a photographed pair. Recording the winner
    // per view is what lets those pixels be identified afterwards.
    const leftLayer = new Int32Array(eyeWidth * height).fill(-1);
    const rightLayer = new Int32Array(eyeWidth * height).fill(-1);

    // White noise uses its own generator so that changing the layer geometry
    // does not shift the per-pixel noise sequence.
    const noiseRng = createRng(seed ^ 0x5f3a7c1d);
    const jitter = new Float32Array(eyeWidth * height);
    for (let i = 0; i < jitter.length; i++) jitter[i] = (noiseRng() - 0.5) * 2;

    const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

    const paint = (target, owner, isRight) => {
        for (const [index, layer] of layers.entries()) {
            const { x0, y0, x1, y1, disparity: d, noise, tint, base } = layer;
            // In the right view the rectangle appears shifted left by d, so the
            // texture coordinate of output column x is x + d.
            const outX0 = isRight ? Math.max(0, x0 - d) : x0;
            const outX1 = isRight ? Math.min(eyeWidth, x1 - d) : x1;
            for (let y = y0; y < y1; y++) {
                for (let x = outX0; x < outX1; x++) {
                    const tx = isRight ? x + d : x;
                    const value = base + (noise(tx, y) - 0.5) * params.contrast;
                    const idx = (y * eyeWidth + x) * 4;
                    const n = jitter[y * eyeWidth + (isRight ? Math.min(eyeWidth - 1, tx) : x)] * params.noise;
                    target[idx] = clamp8(value * tint[0] + n);
                    target[idx + 1] = clamp8(value * tint[1] + n);
                    target[idx + 2] = clamp8(value * tint[2] + n);
                    target[idx + 3] = 255;
                    owner[y * eyeWidth + x] = index;
                    if (!isRight) disparity[y * eyeWidth + x] = d;
                }
            }
        }
    };

    paint(left, leftLayer, false);
    paint(right, rightLayer, true);

    // A left pixel is visible in both views when the right view, at the
    // position its disparity points to, still shows the same layer.
    const visible = new Uint8Array(eyeWidth * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < eyeWidth; x++) {
            const i = y * eyeWidth + x;
            const xr = x - disparity[i];
            if (xr < 0 || xr > eyeWidth - 1) continue;
            if (rightLayer[y * eyeWidth + Math.round(xr)] === leftLayer[i]) visible[i] = 1;
        }
    }

    // Interleave into one side-by-side RGBA frame, which is the layout the
    // application's analysis path receives.
    const width = eyeWidth * 2;
    const sbs = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        left.copy(sbs, y * width * 4, y * eyeWidth * 4, (y + 1) * eyeWidth * 4);
        right.copy(sbs, (y * width + eyeWidth) * 4, y * eyeWidth * 4, (y + 1) * eyeWidth * 4);
    }

    return { eyeWidth, height, width, sbs, left, right, disparity, visible };
}
