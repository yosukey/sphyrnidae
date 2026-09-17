/**
 * bench/lib/opencv.mjs
 *
 * Loads one of the two OpenCV.js builds the application ships.
 *
 * The application picks between opencv/simd/opencv.js and opencv/wasm/opencv.js
 * at runtime through wasm-feature-detect (see js/opencv-init.js). A benchmark
 * that wants to compare the two must pin the choice instead, and must load only
 * one of them per process: both builds are Emscripten modules that install the
 * same global runtime, so instantiating the second one in a live process would
 * measure a mixture of the two. loadOpenCV() therefore refuses a second,
 * different build and the callers run one child process per build.
 *
 * The returned object is the same `cv` namespace the browser sees, minus the
 * entry points that need a DOM: this custom build's whitelist omits imdecode and
 * imencode, so pixels come from bench/lib/png.mjs instead.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The build variants shipped in opencv/. */
export const BUILDS = ['wasm', 'simd'];

let loadedBuild = null;
let loadedCv = null;
let loadMs = null;

/**
 * Resolve the on-disk path of a build.
 *
 * @param {'wasm'|'simd'} build
 * @returns {string}
 */
export function buildPath(build) {
    if (!BUILDS.includes(build)) {
        throw new Error(`unknown OpenCV build "${build}"; expected one of ${BUILDS.join(', ')}`);
    }
    return join(REPO_ROOT, 'opencv', build, 'opencv.js');
}

/**
 * Size in bytes of a build as it sits in the repository.
 *
 * @param {'wasm'|'simd'} build
 * @returns {number}
 */
export function buildSizeBytes(build) {
    return readFileSync(buildPath(build)).length;
}

/**
 * Load a build and wait for its WebAssembly runtime to finish initialising.
 *
 * @param {'wasm'|'simd'} build
 * @returns {Promise<{cv: Object, loadMs: number, build: string}>}
 *          loadMs covers reading, compiling and instantiating the module
 */
export async function loadOpenCV(build) {
    if (loadedBuild && loadedBuild !== build) {
        throw new Error(
            `this process already loaded the "${loadedBuild}" build; ` +
            'run one build per process so the measurement is not a mixture',
        );
    }
    if (loadedCv) return { cv: loadedCv, loadMs, build: loadedBuild };

    const start = performance.now();
    const mod = await import(buildPath(build));
    const candidate = mod.default ?? globalThis.cv;
    const cv = candidate && typeof candidate.then === 'function' ? await candidate : candidate;
    if (!cv || typeof cv.Mat !== 'function') {
        throw new Error(`the "${build}" build did not expose a usable cv namespace`);
    }
    loadMs = performance.now() - start;
    loadedBuild = build;
    loadedCv = cv;
    return { cv, loadMs, build };
}

/**
 * Delete a list of OpenCV objects, ignoring ones that are already released.
 * OpenCV.js objects are WASM heap allocations that the JavaScript garbage
 * collector does not reclaim, so every benchmark iteration must release its own.
 *
 * @param {Array<{delete: Function}>} objects
 */
export function release(objects) {
    for (const o of objects) {
        try {
            o?.delete?.();
        } catch {
            // Already deleted, or never constructed because an earlier
            // constructor threw. Nothing to release either way.
        }
    }
}
