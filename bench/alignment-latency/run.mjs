/**
 * bench/alignment-latency/run.mjs
 *
 * Measures how long the auto-alignment feature pipeline takes.
 *
 * The pipeline is the sequence js/rendering/alignment.js runs on the main
 * thread when the user presses Auto-align: colour conversion, feature detection
 * and description on each eye, then brute-force descriptor matching with cross
 * checking. bench/lib/alignment-pipeline.mjs reproduces that sequence; the two
 * estimators that consume its output are the application's own modules and are
 * timed alongside it.
 *
 * Factors
 *   build       which of the two shipped OpenCV.js builds executes the work,
 *               opencv/wasm (plain WebAssembly) or opencv/simd (WebAssembly
 *               with fixed-width SIMD). The application selects between them at
 *               runtime with wasm-feature-detect; here the choice is pinned.
 *   algorithm   orb, akaze or sift, the three entries in the application's
 *               algorithm select.
 *   frame size  the side-by-side frame the pipeline receives. 1024x512 is the
 *               size the application's own downscale produces for a 2:1 source,
 *               since ANALYSIS_RESIZE_MAX_DIMENSION is 1024.
 *   content     textured, low-texture or noisy. Detector cost and, through the
 *               keypoint count, matcher cost both depend on how much structure
 *               the frame carries.
 *
 * Two sweeps are run rather than the full factorial: one varies frame size with
 * content fixed, the other varies content with frame size fixed at the
 * application's operating point. The condition they share is measured once and
 * appears in both.
 *
 * Process layout
 *   Both OpenCV builds install the same Emscripten runtime, so a process that
 *   loaded one cannot load the other. This file is therefore its own worker: the
 *   parent spawns `node run.mjs --worker --build=<name>` once per build and
 *   merges what the children report.
 *
 * Outputs
 *   alignment-latency.csv             one row per (sweep, build, condition)
 *   alignment-latency-equivalence.csv one row per condition, comparing what the
 *                                     two builds computed for it
 *
 *   The equivalence table exists because the timing comparison is only
 *   like-for-like if both builds did the same work. Each worker keeps the raw
 *   keypoint geometry, descriptor bytes and match list from its last measured
 *   run of every condition; the parent reads both builds' copies back and
 *   compares them element by element, per component.
 *
 * Usage
 *   node bench/alignment-latency/run.mjs
 *     [--runs=30] [--warmup=3] [--budget-ms=20000]
 *     [--widths=512,1024,2048,4096] [--algorithms=orb,akaze,sift]
 */

import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILDS, buildPath, buildSizeBytes, loadOpenCV } from '../lib/opencv.mjs';
import { renderStereoScene, CONTENT_CLASSES } from '../lib/stereo-scene.mjs';
import { ALGORITHMS, runPipeline, deltasToAffinePoints, compareRaw } from '../lib/alignment-pipeline.mjs';
import { estimateVerticalAffine } from '../../js/rendering/alignment-geometry.js';
import { estimateDisparityComfortShift } from '../../js/rendering/alignment-shift.js';
import { summarize, num } from '../lib/stats.mjs';
import { writeTables } from '../lib/run-manifest.mjs';

const SELF = fileURLToPath(import.meta.url);

/** Side-by-side frame widths for the size sweep; height is always half. */
const FRAME_WIDTHS = [512, 1024, 2048, 4096];

/** The application's operating point: what a 2:1 source downscales to. */
const OPERATING_WIDTH = 1024;

/** Content class held fixed while frame size varies. */
const BASE_CONTENT = 'textured';

/** Seed for every generated frame, so all conditions see the same scene. */
const SCENE_SEED = 20240917;

/** gzip level used for the transfer-size columns. */
const GZIP_LEVEL = 9;

/**
 * Parse `--name=value` and `--name` arguments.
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
 * Resolve the frame widths and algorithms to sweep, honouring the CLI overrides
 * that let a smoke run cover the code path without paying for the full matrix.
 *
 * @param {Object} args
 * @returns {{widths:number[], algorithms:string[]}}
 */
function resolveAxes(args) {
    const widths = args.widths
        ? String(args.widths).split(',').map((v) => Number(v.trim())).filter(Number.isFinite)
        : FRAME_WIDTHS;
    const algorithms = args.algorithms
        ? String(args.algorithms).split(',').map((v) => v.trim()).filter((v) => ALGORITHMS.includes(v))
        : ALGORITHMS;
    if (!widths.length) throw new Error('--widths selected no frame width');
    if (!algorithms.length) throw new Error('--algorithms selected no algorithm');
    return { widths, algorithms };
}

/**
 * Stable identifier for a condition, used as a map key and a filename.
 *
 * @param {{algorithm:string, width:number, content:string}} condition
 * @returns {string}
 */
function conditionKey({ algorithm, width, content }) {
    return `${algorithm}_${width}_${content}`;
}

/**
 * The conditions to measure, as a flat list. Each entry names its sweep so the
 * shared condition can be attributed to both.
 *
 * @param {Object} args
 * @returns {Array<{sweeps:string[], algorithm:string, width:number, content:string}>}
 */
function buildConditions(args) {
    const { widths, algorithms } = resolveAxes(args);
    const conditions = new Map();
    const add = (sweep, algorithm, width, content) => {
        const k = conditionKey({ algorithm, width, content });
        if (!conditions.has(k)) conditions.set(k, { sweeps: [], algorithm, width, content });
        conditions.get(k).sweeps.push(sweep);
    };
    const operatingWidth = widths.includes(OPERATING_WIDTH) ? OPERATING_WIDTH : widths[0];
    for (const algorithm of algorithms) {
        for (const width of widths) add('frame-size', algorithm, width, BASE_CONTENT);
        for (const content of CONTENT_CLASSES) add('content', algorithm, operatingWidth, content);
    }
    return [...conditions.values()];
}

/**
 * Serialise a set of typed arrays: a little-endian header length, a JSON header
 * naming each array's type and byte count, then the payloads back to back.
 *
 * @param {string} path
 * @param {Object<string, ArrayBufferView>} raw
 */
function writeArtifact(path, raw) {
    const header = {};
    const payloads = [];
    for (const [key, view] of Object.entries(raw)) {
        const buf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
        header[key] = { type: view.constructor.name, bytes: buf.length };
        payloads.push(buf);
    }
    const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32LE(headerBuf.length, 0);
    writeFileSync(path, Buffer.concat([lengthBuf, headerBuf, ...payloads]));
}

/** Typed-array constructors writeArtifact is allowed to round-trip. */
const ARTIFACT_TYPES = { Float64Array, Uint8Array };

/**
 * Read back what writeArtifact wrote.
 *
 * @param {string} path
 * @returns {Object<string, ArrayBufferView>}
 */
function readArtifact(path) {
    const buf = readFileSync(path);
    const headerLength = buf.readUInt32LE(0);
    const header = JSON.parse(buf.toString('utf8', 4, 4 + headerLength));
    let offset = 4 + headerLength;
    const out = {};
    for (const [key, { type, bytes }] of Object.entries(header)) {
        const Ctor = ARTIFACT_TYPES[type];
        if (!Ctor) throw new Error(`artifact ${path} declares unknown type ${type}`);
        // Copy into a fresh buffer: a Float64Array view needs 8-byte alignment,
        // which an arbitrary offset into the file buffer does not guarantee.
        const copy = Uint8Array.prototype.slice.call(buf, offset, offset + bytes);
        offset += bytes;
        out[key] = new Ctor(copy.buffer);
    }
    return out;
}

/**
 * Measure every condition under one OpenCV build, write its raw captures into
 * the artifact directory, and print the records as JSON on stdout. Runs in a
 * child process.
 *
 * @param {Object} args - parsed CLI arguments
 */
async function runWorker(args) {
    const build = args.build;
    const maxRuns = Number(args.runs ?? 30);
    const warmup = Number(args.warmup ?? 3);
    const budgetMs = Number(args['budget-ms'] ?? 20000);
    const artifactDir = args['artifact-dir'];

    const { cv, loadMs } = await loadOpenCV(build);

    // Emscripten exposes its linear memory through the typed-array views. The
    // size is recorded twice, here and again once the sweep has finished, so
    // the pair says what the module started with and what the work grew it to.
    const heapBytesAtLoad = cv.HEAP8?.buffer?.byteLength ?? null;

    const records = [];
    for (const condition of buildConditions(args)) {
        const { algorithm, width, content } = condition;
        const scene = renderStereoScene({
            eyeWidth: width / 2,
            height: width / 2,
            seed: SCENE_SEED,
            content,
        });

        const once = (collectRaw) => {
            const r = runPipeline(cv, {
                rgba: scene.sbs,
                width: scene.width,
                height: scene.height,
                algorithm,
                collectRaw,
            });
            const tEst = performance.now();
            estimateDisparityComfortShift(r.deltas, {});
            estimateVerticalAffine(deltasToAffinePoints(r.deltas));
            r.stages.estimatorMs = performance.now() - tEst;
            return r;
        };

        for (let i = 0; i < warmup; i++) once(false);

        const samples = [];
        const started = performance.now();
        while (samples.length < maxRuns) {
            samples.push(once(false).stages);
            if (performance.now() - started > budgetMs) break;
        }

        // One extra run captures the raw output. It is kept out of the timing
        // samples because copying the keypoints and descriptors off the WASM
        // heap is work the application never does.
        const captured = once(true);
        if (artifactDir) {
            writeArtifact(join(artifactDir, `${build}__${conditionKey(condition)}.bin`), captured.raw);
        }

        const pick = (field) => samples.map((s) => s[field]);
        const pipeline = summarize(pick('pipelineMs'));
        records.push({
            sweeps: condition.sweeps,
            key: conditionKey(condition),
            build,
            algorithm,
            frame_width: scene.width,
            frame_height: scene.height,
            content,
            runs: samples.length,
            warmup_runs: warmup,
            keypoints_left: captured.keypointsLeft,
            keypoints_right: captured.keypointsRight,
            match_count: captured.matchCount,
            pipeline_ms_median: pipeline.median,
            pipeline_ms_p25: pipeline.p25,
            pipeline_ms_p75: pipeline.p75,
            pipeline_ms_iqr: pipeline.iqr,
            pipeline_ms_min: pipeline.min,
            pipeline_ms_max: pipeline.max,
            cvt_color_ms_median: summarize(pick('cvtColorMs')).median,
            detect_left_ms_median: summarize(pick('detectLeftMs')).median,
            detect_right_ms_median: summarize(pick('detectRightMs')).median,
            match_ms_median: summarize(pick('matchMs')).median,
            estimator_ms_median: summarize(pick('estimatorMs')).median,
            digests: captured.digests,
        });

        process.stderr.write(
            `  ${build} ${algorithm} ${scene.width}x${scene.height} ${content}: ` +
            `${pipeline.median.toFixed(1)} ms (n=${samples.length})\n`,
        );
    }

    process.stdout.write(JSON.stringify({
        build,
        load_ms: loadMs,
        heap_bytes_at_load: heapBytesAtLoad,
        heap_bytes_after_sweep: cv.HEAP8?.buffer?.byteLength ?? null,
        records,
    }));
}

/**
 * Run one worker and collect its JSON payload.
 *
 * @param {string} build
 * @param {Object} args
 * @param {string} artifactDir
 * @returns {Promise<Object>}
 */
function spawnWorker(build, args, artifactDir) {
    return new Promise((resolve, reject) => {
        const argv = [
            SELF,
            '--worker',
            `--build=${build}`,
            `--runs=${args.runs ?? 30}`,
            `--warmup=${args.warmup ?? 3}`,
            `--budget-ms=${args['budget-ms'] ?? 20000}`,
            `--artifact-dir=${artifactDir}`,
        ];
        if (args.widths) argv.push(`--widths=${args.widths}`);
        if (args.algorithms) argv.push(`--algorithms=${args.algorithms}`);
        const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'inherit'] });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code !== 0) return reject(new Error(`worker for build "${build}" exited with ${code}`));
            try {
                resolve(JSON.parse(out));
            } catch (err) {
                reject(new Error(`worker for build "${build}" produced unparseable output: ${err.message}`));
            }
        });
    });
}

/** Columns of the timing table; one row per (sweep, build, condition). */
const TIMING_COLUMNS = [
    'sweep', 'build', 'algorithm', 'frame_width', 'frame_height', 'content',
    'runs', 'warmup_runs',
    'keypoints_left', 'keypoints_right', 'match_count',
    'pipeline_ms_median', 'pipeline_ms_p25', 'pipeline_ms_p75', 'pipeline_ms_iqr',
    'pipeline_ms_min', 'pipeline_ms_max',
    'cvt_color_ms_median', 'detect_left_ms_median', 'detect_right_ms_median',
    'match_ms_median', 'estimator_ms_median',
    'module_load_ms', 'wasm_heap_bytes_at_load', 'wasm_heap_bytes_after_sweep',
    'build_bytes', 'build_bytes_gzip',
];

/** Columns of the equivalence table; one row per condition. */
const EQUIVALENCE_COLUMNS = [
    'algorithm', 'frame_width', 'content', 'build_a', 'build_b',
    'keypoint_count_left', 'keypoint_count_right', 'match_count',
    'keypoints_left_equal', 'keypoints_right_equal',
    'descriptors_left_equal', 'descriptors_right_equal', 'matches_equal',
    'keypoint_values_differing', 'keypoint_values_total', 'keypoint_max_abs_diff',
    'descriptor_bytes_differing', 'descriptor_bytes_total',
    'match_values_differing', 'match_values_total', 'match_max_abs_diff',
    'digest_keypoints_left_a', 'digest_keypoints_left_b',
    'digest_keypoints_right_a', 'digest_keypoints_right_b',
    'digest_descriptors_left_a', 'digest_descriptors_left_b',
    'digest_descriptors_right_a', 'digest_descriptors_right_b',
    'digest_matches_a', 'digest_matches_b',
];

/**
 * Compare what two builds produced for every condition they share.
 *
 * @param {Object} payloads - keyed by build name
 * @param {string} artifactDir
 * @returns {Array<Object>} rows for the equivalence table
 */
function buildEquivalenceRows(payloads, artifactDir) {
    const [buildA, buildB] = BUILDS;
    const indexB = new Map(payloads[buildB].records.map((r) => [r.key, r]));
    const rows = [];

    for (const recordA of payloads[buildA].records) {
        const recordB = indexB.get(recordA.key);
        if (!recordB) continue;
        const rawA = readArtifact(join(artifactDir, `${buildA}__${recordA.key}.bin`));
        const rawB = readArtifact(join(artifactDir, `${buildB}__${recordA.key}.bin`));
        const cmp = compareRaw(rawA, rawB);

        const keypointValuesDiffering = cmp.keypointsLeft.differing + cmp.keypointsRight.differing;
        const keypointValuesTotal = cmp.keypointsLeft.length + cmp.keypointsRight.length;
        const descriptorBytesDiffering = cmp.descriptorsLeft.differing + cmp.descriptorsRight.differing;
        const descriptorBytesTotal = cmp.descriptorsLeft.length + cmp.descriptorsRight.length;

        rows.push({
            algorithm: recordA.algorithm,
            frame_width: recordA.frame_width,
            content: recordA.content,
            build_a: buildA,
            build_b: buildB,
            keypoint_count_left: recordA.keypoints_left,
            keypoint_count_right: recordA.keypoints_right,
            match_count: recordA.match_count,
            keypoints_left_equal: String(cmp.keypointsLeft.sameLength && cmp.keypointsLeft.differing === 0),
            keypoints_right_equal: String(cmp.keypointsRight.sameLength && cmp.keypointsRight.differing === 0),
            descriptors_left_equal: String(cmp.descriptorsLeft.sameLength && cmp.descriptorsLeft.differing === 0),
            descriptors_right_equal: String(cmp.descriptorsRight.sameLength && cmp.descriptorsRight.differing === 0),
            matches_equal: String(cmp.matches.sameLength && cmp.matches.differing === 0),
            keypoint_values_differing: keypointValuesDiffering,
            keypoint_values_total: keypointValuesTotal,
            keypoint_max_abs_diff: num(Math.max(cmp.keypointsLeft.maxAbsDiff, cmp.keypointsRight.maxAbsDiff), 9),
            descriptor_bytes_differing: descriptorBytesDiffering,
            descriptor_bytes_total: descriptorBytesTotal,
            match_values_differing: cmp.matches.differing,
            match_values_total: cmp.matches.length,
            match_max_abs_diff: num(cmp.matches.maxAbsDiff, 9),
            digest_keypoints_left_a: recordA.digests.keypointsLeft,
            digest_keypoints_left_b: recordB.digests.keypointsLeft,
            digest_keypoints_right_a: recordA.digests.keypointsRight,
            digest_keypoints_right_b: recordB.digests.keypointsRight,
            digest_descriptors_left_a: recordA.digests.descriptorsLeft,
            digest_descriptors_left_b: recordB.digests.descriptorsLeft,
            digest_descriptors_right_a: recordA.digests.descriptorsRight,
            digest_descriptors_right_b: recordB.digests.descriptorsRight,
            digest_matches_a: recordA.digests.matches,
            digest_matches_b: recordB.digests.matches,
        });
    }

    rows.sort((a, b) =>
        a.algorithm.localeCompare(b.algorithm) ||
        a.frame_width - b.frame_width ||
        a.content.localeCompare(b.content));
    return rows;
}

/**
 * Spawn one worker per build, compare their output and write the result tables.
 *
 * @param {Object} args
 */
async function runOrchestrator(args) {
    const artifactDir = mkdtempSync(join(tmpdir(), 'alignment-latency-'));
    mkdirSync(artifactDir, { recursive: true });
    try {
        const payloads = {};
        for (const build of BUILDS) {
            process.stderr.write(`build "${build}":\n`);
            payloads[build] = await spawnWorker(build, args, artifactDir);
        }

        const buildBytes = {};
        for (const build of BUILDS) {
            buildBytes[build] = {
                raw: buildSizeBytes(build),
                gzip: gzipSync(readFileSync(buildPath(build)), { level: GZIP_LEVEL }).length,
            };
        }

        const timingRows = [];
        for (const build of BUILDS) {
            for (const record of payloads[build].records) {
                for (const sweep of record.sweeps) {
                    timingRows.push({
                        sweep,
                        build,
                        algorithm: record.algorithm,
                        frame_width: record.frame_width,
                        frame_height: record.frame_height,
                        content: record.content,
                        runs: record.runs,
                        warmup_runs: record.warmup_runs,
                        keypoints_left: record.keypoints_left,
                        keypoints_right: record.keypoints_right,
                        match_count: record.match_count,
                        pipeline_ms_median: num(record.pipeline_ms_median, 3),
                        pipeline_ms_p25: num(record.pipeline_ms_p25, 3),
                        pipeline_ms_p75: num(record.pipeline_ms_p75, 3),
                        pipeline_ms_iqr: num(record.pipeline_ms_iqr, 3),
                        pipeline_ms_min: num(record.pipeline_ms_min, 3),
                        pipeline_ms_max: num(record.pipeline_ms_max, 3),
                        cvt_color_ms_median: num(record.cvt_color_ms_median, 3),
                        detect_left_ms_median: num(record.detect_left_ms_median, 3),
                        detect_right_ms_median: num(record.detect_right_ms_median, 3),
                        match_ms_median: num(record.match_ms_median, 3),
                        estimator_ms_median: num(record.estimator_ms_median, 3),
                        module_load_ms: num(payloads[build].load_ms, 1),
                        wasm_heap_bytes_at_load: payloads[build].heap_bytes_at_load ?? '',
                        wasm_heap_bytes_after_sweep: payloads[build].heap_bytes_after_sweep ?? '',
                        build_bytes: buildBytes[build].raw,
                        build_bytes_gzip: buildBytes[build].gzip,
                    });
                }
            }
        }
        timingRows.sort((a, b) =>
            a.sweep.localeCompare(b.sweep) ||
            a.algorithm.localeCompare(b.algorithm) ||
            a.frame_width - b.frame_width ||
            a.content.localeCompare(b.content) ||
            a.build.localeCompare(b.build));

        const equivalenceRows = buildEquivalenceRows(payloads, artifactDir);
        const axes = resolveAxes(args);

        const { csvPaths } = writeTables({
            bench: 'alignment-latency',
            tables: [
                { name: 'alignment-latency', columns: TIMING_COLUMNS, rows: timingRows },
                { name: 'alignment-latency-equivalence', columns: EQUIVALENCE_COLUMNS, rows: equivalenceRows },
            ],
            parameters: {
                builds: BUILDS,
                algorithms: axes.algorithms,
                frame_widths: axes.widths,
                operating_width: OPERATING_WIDTH,
                content_classes: CONTENT_CLASSES,
                base_content: BASE_CONTENT,
                scene_seed: SCENE_SEED,
                max_runs: Number(args.runs ?? 30),
                warmup_runs: Number(args.warmup ?? 3),
                per_condition_budget_ms: Number(args['budget-ms'] ?? 20000),
                gzip_level: GZIP_LEVEL,
                orb_features: 2000,
            },
        });

        const differing = equivalenceRows.filter((r) =>
            [r.keypoints_left_equal, r.keypoints_right_equal, r.descriptors_left_equal,
                r.descriptors_right_equal, r.matches_equal].includes('false'));
        process.stderr.write(`\nwrote:\n${csvPaths.map((p) => `  ${p}`).join('\n')}\n`);
        process.stderr.write(
            `conditions where the two builds differ: ${differing.length} of ${equivalenceRows.length}\n`,
        );
        for (const row of differing) {
            process.stderr.write(
                `  ${row.algorithm} ${row.frame_width} ${row.content}: ` +
                `keypoints ${row.keypoint_values_differing}/${row.keypoint_values_total} values, ` +
                `descriptors ${row.descriptor_bytes_differing}/${row.descriptor_bytes_total} bytes, ` +
                `matches ${row.match_values_differing}/${row.match_values_total} values\n`,
            );
        }
    } finally {
        rmSync(artifactDir, { recursive: true, force: true });
    }
}

const args = parseArgs(process.argv.slice(2));
if (args.worker) {
    await runWorker(args);
} else {
    await runOrchestrator(args);
}
