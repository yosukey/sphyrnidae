/**
 * bench/alignment-accuracy/fetch-datasets.mjs
 *
 * Downloads the Middlebury stereo corpus that end-to-end.mjs measures against.
 *
 * The corpus is the half-resolution MiddEval3 training set: fifteen rectified
 * stereo pairs, each with a floating-point ground-truth disparity map and a mask
 * marking the pixels visible in both views. Rectified means the pair starts with
 * no vertical disparity, which is the condition end-to-end.mjs needs before it
 * introduces a vertical misalignment of its own.
 *
 * The archives are not redistributed from this repository. They land in
 * bench/datasets/, which .gitignore excludes, and the script is idempotent: an
 * archive whose checksum already matches is neither downloaded nor re-extracted.
 *
 * The data is published by Middlebury College and is subject to their terms;
 * see https://vision.middlebury.edu/stereo/data/scenes2014/ for the dataset and
 * the papers describing it.
 *
 * Usage
 *   node bench/alignment-accuracy/fetch-datasets.mjs [--force]
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const BENCH_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where the archives and their extracted contents live. */
export const DATASET_DIR = join(BENCH_ROOT, 'datasets', 'middlebury');

/** Root of the extracted training set. */
export const TRAINING_DIR = join(DATASET_DIR, 'MiddEval3', 'trainingH');

/**
 * The archives, with the digest each is expected to have. A mismatch is an
 * error rather than a warning: a corpus that is not the one the recorded
 * results were produced from would make those results unreproducible without
 * saying so.
 */
const ARCHIVES = [
    {
        name: 'MiddEval3-data-H.zip',
        url: 'https://vision.middlebury.edu/stereo/submit3/zip/MiddEval3-data-H.zip',
        bytes: 109900544,
        sha256: '2fc24f494a1e62066d0519cf86b759f344fc7bf0f49785632b582763fb0770a8',
    },
    {
        name: 'MiddEval3-GT0-H.zip',
        url: 'https://vision.middlebury.edu/stereo/submit3/zip/MiddEval3-GT0-H.zip',
        bytes: 53097428,
        sha256: 'c6537f6ee9debcf2a2ec605e69950b5feecb3c5df369f313bb22761acf74025c',
    },
];

/** Files every usable scene directory must contain. */
export const SCENE_FILES = ['im0.png', 'im1.png', 'disp0GT.pfm', 'mask0nocc.png'];

/** Attempts per archive; the transfer can be cut short by an intermediary. */
const MAX_ATTEMPTS = 5;

/**
 * SHA-256 of a file, or null when it does not exist.
 *
 * @param {string} path
 * @returns {Promise<string|null>}
 */
async function digestOf(path) {
    try {
        return createHash('sha256').update(await readFile(path)).digest('hex');
    } catch {
        return null;
    }
}

/**
 * Download one archive, resuming a partial file where the server allows it, and
 * verify the result against the expected digest.
 *
 * @param {{name:string, url:string, bytes:number, sha256:string}} archive
 * @param {boolean} force - re-download even when the file already verifies
 * @returns {Promise<string>} path of the verified archive
 */
async function fetchArchive(archive, force) {
    const path = join(DATASET_DIR, archive.name);

    if (!force && (await digestOf(path)) === archive.sha256) {
        process.stderr.write(`  ${archive.name}: already present and verified\n`);
        return path;
    }
    if (force) await rm(path, { force: true });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let have = 0;
        try {
            have = (await stat(path)).size;
        } catch {
            have = 0;
        }
        if (have >= archive.bytes) {
            // Long enough to be complete. If its contents are right the loop is
            // done; if they are not, the file is wrong rather than short — an
            // error page appended to a partial download, say — and resuming
            // cannot repair it. Start it over rather than leaving a file that
            // every later run would accept as complete and then reject.
            if ((await digestOf(path)) === archive.sha256) break;
            process.stderr.write(`    complete but does not match its checksum; starting over\n`);
            await rm(path, { force: true });
            have = 0;
        }

        const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
        process.stderr.write(
            `  ${archive.name}: attempt ${attempt}, have ${have} of ${archive.bytes} bytes\n`,
        );
        try {
            const response = await fetch(archive.url, { headers });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            // A server that ignores the Range header restarts the body at zero,
            // so appending would corrupt the file; truncate instead.
            const append = have > 0 && response.status === 206;
            await pipeline(
                Readable.fromWeb(response.body),
                createWriteStream(path, { flags: append ? 'a' : 'w' }),
            );
        } catch (err) {
            process.stderr.write(`    transfer failed: ${err.message}\n`);
        }
    }

    const digest = await digestOf(path);
    if (digest !== archive.sha256) {
        throw new Error(
            `${archive.name} did not download correctly: expected sha256 ${archive.sha256}, got ${digest}`,
        );
    }
    process.stderr.write(`  ${archive.name}: verified\n`);
    return path;
}

/**
 * Extract an archive into the dataset directory.
 *
 * @param {string} path
 */
function extract(path) {
    execFileSync('unzip', ['-q', '-o', path, '-d', DATASET_DIR], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/**
 * Ensure the corpus is present, downloading and extracting it if needed.
 *
 * @param {{force?: boolean}} [options]
 * @returns {Promise<string>} the training-set directory
 */
export async function ensureDatasets({ force = false } = {}) {
    await mkdir(DATASET_DIR, { recursive: true });
    for (const archive of ARCHIVES) {
        const path = await fetchArchive(archive, force);
        extract(path);
    }
    return TRAINING_DIR;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const force = process.argv.includes('--force');
    const dir = await ensureDatasets({ force });
    process.stderr.write(`\ncorpus ready at ${dir}\n`);
}
