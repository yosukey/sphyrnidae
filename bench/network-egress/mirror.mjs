/**
 * bench/network-egress/mirror.mjs
 *
 * Builds a local copy of the third-party assets the application loads from a
 * CDN, so run.mjs can serve them itself.
 *
 * The application pins eight files on cdn.jsdelivr.net, each at an exact version
 * and each carrying a Subresource Integrity hash in index.html. jsdelivr serves
 * the contents of npm packages verbatim, so the same bytes can be obtained from
 * the npm registry with `npm pack`, and the SRI hashes in index.html confirm
 * that they are the same bytes.
 *
 * run.mjs answers requests for the pinned URLs from this mirror rather than
 * letting them reach the network. The requests themselves are still recorded, so
 * what the benchmark measures — which hosts the application contacts, and what
 * it sends them — is unaffected; only where the response came from differs, and
 * the manifest records that it was served locally.
 *
 * The canonical list of assets is CDN_PRECACHE_URLS in sw.js, so the mirror
 * cannot drift from what the application actually loads.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(BENCH_ROOT);

/** Where the mirrored files live; excluded from the repository. */
export const MIRROR_DIR = join(BENCH_ROOT, 'datasets', 'cdn-mirror');

/**
 * The CDN URLs the application precaches, read from sw.js so this list is the
 * application's own.
 *
 * @returns {string[]}
 */
export function pinnedCdnUrls() {
    const sw = readFileSync(join(REPO_ROOT, 'sw.js'), 'utf8');
    const block = sw.match(/const CDN_PRECACHE_URLS = \[([\s\S]*?)\];/);
    if (!block) throw new Error('could not find CDN_PRECACHE_URLS in sw.js');
    return [...block[1].matchAll(/'(https:\/\/[^']+)'/g)].map(([, url]) => url);
}

/**
 * Every integrity hash the application declares for a CDN asset, keyed by URL.
 *
 * The application declares them in three places, because the three assets are
 * loaded in three ways:
 *   - `integrity` on a classic <script> tag, for the directly loaded libraries
 *   - the `integrity` map of the inline import map, for the two three.js chunks
 *   - a hash in js/ui/ui-export.js, for the GIF worker it fetches at runtime
 *
 * @returns {Map<string, string>}
 */
export function declaredIntegrity() {
    const html = readFileSync(join(REPO_ROOT, 'index.html'), 'utf8');
    const map = new Map();

    for (const [, tag] of html.matchAll(/<script\b([^>]*)>/g)) {
        const src = tag.match(/\bsrc\s*=\s*"([^"]+)"/);
        const integrity = tag.match(/\bintegrity\s*=\s*"([^"]+)"/);
        if (src && integrity) map.set(src[1], integrity[1]);
    }

    const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
    if (importMap) {
        try {
            const parsed = JSON.parse(importMap[1]);
            for (const [url, hash] of Object.entries(parsed.integrity ?? {})) map.set(url, hash);
        } catch {
            // A malformed import map is the application's problem, not the
            // mirror's; the affected files simply report no declared hash.
        }
    }

    const exporter = readFileSync(join(REPO_ROOT, 'js', 'ui', 'ui-export.js'), 'utf8');
    const workerUrl = exporter.match(/const workerUrl = '(https:\/\/[^']+)'/);
    const workerHash = exporter.match(/const expectedSriHash = '([^']+)'/);
    if (workerUrl && workerHash) map.set(workerUrl[1], `sha384-${workerHash[1]}`);

    return map;
}

/**
 * Split a jsdelivr npm URL into the package, version and path inside it.
 *
 * @param {string} url
 * @returns {{pkg:string, version:string, path:string}}
 */
function parseJsdelivrUrl(url) {
    const m = /^https:\/\/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/.exec(url);
    if (!m) throw new Error(`not a pinned jsdelivr npm URL: ${url}`);
    return { pkg: m[1], version: m[2], path: m[3] };
}

/**
 * Check a file against an SRI attribute value such as "sha384-....".
 *
 * @param {Buffer} bytes
 * @param {string} integrity
 * @returns {boolean}
 */
function matchesIntegrity(bytes, integrity) {
    const [algorithm, expected] = integrity.split('-');
    const supported = { sha256: 'sha256', sha384: 'sha384', sha512: 'sha512' }[algorithm];
    if (!supported) return false;
    return createHash(supported).update(bytes).digest('base64') === expected;
}

/**
 * Local path a mirrored URL is stored at.
 *
 * @param {string} url
 * @returns {string}
 */
export function mirrorPathFor(url) {
    const { pkg, version, path } = parseJsdelivrUrl(url);
    return join(MIRROR_DIR, `${pkg.replace('/', '__')}@${version}`, path);
}

/**
 * Download and extract the packages the pinned URLs live in, and write each
 * pinned file into the mirror.
 *
 * @param {{force?: boolean}} [options]
 * @returns {Promise<Map<string, {path:string, bytes:number, integrity:string|null, integrityVerified:boolean|null}>>}
 */
export async function ensureMirror({ force = false } = {}) {
    const urls = pinnedCdnUrls();
    const integrity = declaredIntegrity();
    const result = new Map();

    // One tarball can supply several pinned files, so group by package first.
    const byPackage = new Map();
    for (const url of urls) {
        const { pkg, version } = parseJsdelivrUrl(url);
        const key = `${pkg}@${version}`;
        if (!byPackage.has(key)) byPackage.set(key, []);
        byPackage.get(key).push(url);
    }

    mkdirSync(MIRROR_DIR, { recursive: true });

    for (const [spec, packageUrls] of byPackage) {
        const missing = force || packageUrls.some((url) => !existsSync(mirrorPathFor(url)));
        if (missing) {
            const work = join(MIRROR_DIR, '.work');
            rmSync(work, { recursive: true, force: true });
            mkdirSync(work, { recursive: true });
            process.stderr.write(`  fetching ${spec} from the npm registry\n`);
            const packed = execFileSync('npm', ['pack', spec, '--silent'], {
                cwd: work,
                encoding: 'utf8',
            }).trim().split('\n').pop();
            execFileSync('tar', ['-xzf', packed], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] });

            for (const url of packageUrls) {
                const { path } = parseJsdelivrUrl(url);
                const source = join(work, 'package', path);
                if (!existsSync(source)) {
                    throw new Error(`${spec} does not contain ${path}, which ${url} pins`);
                }
                const target = mirrorPathFor(url);
                mkdirSync(dirname(target), { recursive: true });
                writeFileSync(target, readFileSync(source));
            }
            rmSync(work, { recursive: true, force: true });
        }

        for (const url of packageUrls) {
            const target = mirrorPathFor(url);
            const bytes = readFileSync(target);
            const declared = integrity.get(url) ?? null;
            result.set(url, {
                path: target,
                bytes: bytes.length,
                integrity: declared,
                integrityVerified: declared ? matchesIntegrity(bytes, declared) : null,
            });
        }
    }

    return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const mirror = await ensureMirror({ force: process.argv.includes('--force') });
    for (const [url, info] of mirror) {
        const verdict = info.integrity === null
            ? 'no SRI declared in index.html'
            : info.integrityVerified ? 'SRI verified' : 'SRI MISMATCH';
        process.stderr.write(`  ${url}\n    ${info.bytes} bytes, ${verdict}\n`);
    }
    const mismatched = [...mirror.values()].filter((i) => i.integrityVerified === false);
    if (mismatched.length) {
        throw new Error(`${mismatched.length} mirrored file(s) do not match the SRI hash in index.html`);
    }
    process.stderr.write(`\nmirror ready at ${MIRROR_DIR}\n`);
}
