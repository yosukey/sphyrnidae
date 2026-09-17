/**
 * bench/lib/run-manifest.mjs
 *
 * Writes a benchmark's result table and the provenance record that belongs with
 * it.
 *
 * Every result file is accompanied by a manifest naming the code the numbers
 * were produced by and the machine that produced them, because a timing or
 * tolerance figure is only meaningful together with those. The machine
 * description is derived from process.report.getReport().header, which is
 * available in every supported Node version without a dependency.
 *
 * The code is identified two ways. `commit` names the commit the checkout was
 * at, which is the useful form when the results are committed after the code
 * they measure. `source_digest` hashes the measured files themselves, which is
 * the form that survives what `commit` cannot express: results committed
 * *alongside* the code, where the commit that holds them is the one being
 * created and so cannot be named from inside it. The digest is reproducible
 * from any checkout — sourceDigest() recomputes it — so a reader can confirm a
 * result file came from the code sitting next to it whichever way it was
 * committed.
 *
 * Fields deliberately not recorded: the report's `host`, `cwd`, `commandLine`
 * and `networkInterfaces`. They identify the machine and its filesystem layout
 * rather than describing the measurement conditions, and result files are
 * committed to a public repository.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { totalmem } from 'node:os';
import { formatCsv } from './stats.mjs';

const BENCH_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(BENCH_ROOT);
export const RESULTS_DIR = join(BENCH_ROOT, 'results');

/**
 * What the digest covers: the benchmarks themselves and the application code
 * they measure.
 */
const DIGEST_ROOTS = ['bench', 'js', 'sw.js'];

/**
 * Directories the digest skips: the results it is being written into, the
 * downloaded corpora, and installed dependencies. The first would make the
 * digest depend on itself; the others are not code and are not committed.
 */
const DIGEST_SKIP = new Set(['results', 'datasets', 'node_modules']);

/**
 * Read the current commit, and whether anything that could have affected the
 * measurement differs from it.
 *
 * The results directory is excluded from that judgement. A benchmark writes its
 * results into the working tree, so by the time a manifest is written the tree
 * always differs from the commit by at least the files being written; counting
 * those would make the flag true for every run and tell the reader nothing.
 * Excluding them leaves it meaning what it is for: whether the code and data
 * that produced these numbers were the committed ones.
 *
 * Returns nulls when git is unavailable or this is not a checkout — a
 * downloaded archive, for instance.
 *
 * @returns {{commit: string|null, dirty: boolean|null}}
 */
function readGitState() {
    try {
        const git = (args) => execFileSync('git', args, {
            cwd: BENCH_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        const commit = git(['rev-parse', 'HEAD']).trim();
        const changed = git(['status', '--porcelain', '--', ':/', ':(exclude,top)bench/results'])
            .split('\n')
            .filter((line) => line.trim().length > 0);
        return { commit, dirty: changed.length > 0 };
    } catch {
        return { commit: null, dirty: null };
    }
}

/**
 * Every file under a root that the digest covers, as repository-relative paths
 * with forward slashes, sorted so the order does not depend on the filesystem.
 *
 * @param {string} root - repository-relative
 * @returns {string[]}
 */
function digestFiles(root) {
    const absolute = join(REPO_ROOT, root);
    let entry;
    try {
        entry = statSync(absolute);
    } catch {
        return [];
    }
    if (!entry.isDirectory()) return [root];

    const out = [];
    const walk = (dir) => {
        for (const item of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (item.name.startsWith('.') || DIGEST_SKIP.has(item.name)) continue;
            const path = join(dir, item.name);
            if (item.isDirectory()) walk(path);
            else out.push(relative(REPO_ROOT, path).split(sep).join('/'));
        }
    };
    walk(absolute);
    return out.sort();
}

/**
 * A digest of the code a run measured: the benchmarks and the application,
 * excluding results, corpora and dependencies.
 *
 * Each file contributes its path and the hash of its bytes, so a renamed file
 * changes the digest as surely as an edited one. Reproducible from any checkout
 * of the same files on any machine.
 *
 * @returns {{digest: string, file_count: number, roots: string[]}}
 */
export function sourceDigest() {
    const hash = createHash('sha256');
    let count = 0;
    for (const root of DIGEST_ROOTS) {
        for (const file of digestFiles(root)) {
            hash.update(file);
            hash.update('\0');
            hash.update(createHash('sha256').update(readFileSync(join(REPO_ROOT, file))).digest());
            hash.update('\n');
            count++;
        }
    }
    return { digest: hash.digest('hex'), file_count: count, roots: DIGEST_ROOTS };
}

/**
 * Describe the machine and runtime the benchmark ran on.
 *
 * @returns {Object}
 */
export function describeEnvironment() {
    const header = process.report.getReport().header;
    const cpus = header.cpus ?? [];
    return {
        node_version: header.nodejsVersion,
        v8_version: header.componentVersions?.v8 ?? null,
        platform: header.platform,
        arch: header.arch,
        os_name: header.osName,
        os_release: header.osRelease,
        cpu_model: cpus[0]?.model ?? null,
        cpu_count: cpus.length,
        total_memory_bytes: totalmem(),
    };
}

/**
 * Build the manifest object for one benchmark run.
 *
 * @param {string} bench - benchmark name, matching its directory
 * @param {Object} [extra] - benchmark-specific parameters worth recording
 *        (seeds, repetition counts, corpus identifiers)
 * @returns {Object}
 */
export function buildManifest(bench, extra = {}) {
    const git = readGitState();
    const source = sourceDigest();
    return {
        bench,
        generated_at: new Date().toISOString(),
        commit: git.commit,
        working_tree_dirty: git.dirty,
        source_digest: source.digest,
        source_files: source.file_count,
        source_roots: source.roots,
        environment: describeEnvironment(),
        parameters: extra,
    };
}

/**
 * Write one or more result tables plus the single manifest that covers them.
 *
 * A benchmark may produce tables with different units of observation — one row
 * per measured condition in one table, one row per compared pair in another —
 * and mixing those in a single table would leave columns undefined for half the
 * rows. Each table becomes its own CSV; the manifest lists them all, so one
 * provenance record still covers the whole run.
 *
 * @param {Object} options
 * @param {string} options.bench - benchmark name; the manifest basename, and
 *        the basename of the table named the same as the benchmark
 * @param {Array<{name:string, columns:string[], rows:Array<Object>}>} options.tables
 * @param {Object} [options.parameters] - recorded in the manifest
 * @returns {{csvPaths: string[], manifestPath: string}}
 */
export function writeTables({ bench, tables, parameters = {} }) {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const csvPaths = [];
    const tableSummary = [];
    for (const table of tables) {
        const csvPath = join(RESULTS_DIR, `${table.name}.csv`);
        writeFileSync(csvPath, formatCsv(table.columns, table.rows), 'utf8');
        csvPaths.push(csvPath);
        tableSummary.push({
            file: `${table.name}.csv`,
            columns: table.columns,
            row_count: table.rows.length,
        });
    }
    const manifestPath = join(RESULTS_DIR, `${bench}.manifest.json`);
    writeFileSync(
        manifestPath,
        JSON.stringify(buildManifest(bench, { ...parameters, tables: tableSummary }), null, 2) + '\n',
        'utf8',
    );
    return { csvPaths, manifestPath };
}
