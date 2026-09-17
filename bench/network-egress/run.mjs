/**
 * bench/network-egress/run.mjs
 *
 * Records every network request the application makes while a workflow runs in
 * a real browser, and what remains in the browser's storage afterwards.
 *
 * The application states that images are processed in the browser and are not
 * uploaded. This benchmark drives the workflow that claim is about — open a
 * local file, detect its format, auto-align it, change the display mode, export
 * it — with every request the page, its workers and its Service Worker make
 * captured before it leaves.
 *
 * Scenarios
 *   local-file       a stereo image opened from disk, taken through the whole
 *                    workflow. Nothing in it asks for a network resource.
 *   external-src     the same image requested through ?src=, from a second
 *                    local origin standing in for a third-party image host. The
 *                    application documents this as a network fetch; the
 *                    scenario records which origin was contacted and with what.
 *
 * What each request is classified as
 *   app-origin       the origin the application is served from
 *   pinned-cdn       one of the CDN URLs listed in CDN_PRECACHE_URLS in sw.js,
 *                    each of which index.html, its import map or
 *                    js/ui/ui-export.js pins with an integrity hash
 *   image-origin     the origin named in the ?src= parameter
 *   other            anything else
 *
 * Serving the pinned CDN assets
 *   Requests for the pinned URLs are answered from the local mirror
 *   bench/network-egress/mirror.mjs builds, whose bytes are checked against the
 *   integrity hashes the application declares. The request is recorded before it
 *   is answered, so which URLs were requested and what was sent with them is
 *   measured as it would be otherwise; only the response's origin differs.
 *
 * Storage
 *   The test image carries a random marker in an uncompressed PNG text chunk.
 *   After the workflow, every Cache Storage entry, localStorage and
 *   sessionStorage value is searched for that marker, and the IndexedDB
 *   databases are listed.
 *
 * Engines
 *   Whichever of Chromium, Firefox and WebKit Playwright can launch. The
 *   manifest records which ran.
 *
 *   Playwright routes Service Worker requests in Chromium only. On the other
 *   engines a registered Service Worker's fetches bypass the route handler and
 *   are neither recorded nor answered from the mirror, so a run there sees the
 *   page's own requests and not the worker's. Since the application precaches
 *   its whole shell through a Service Worker, that is most of its traffic. Each
 *   row therefore carries `service_worker_visibility`, and a row that reads
 *   `not-observable` is not evidence that no worker traffic occurred.
 *
 * Usage
 *   node bench/network-egress/run.mjs [--engines=chromium,firefox,webkit] [--headed]
 */

import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, dirname, join, normalize, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { renderStereoScene } from '../lib/stereo-scene.mjs';
import { encodePng } from '../lib/png.mjs';
import { buildListLine } from '../../js/core/export-params.js';
import { writeTables } from '../lib/run-manifest.mjs';
import { ensureMirror, pinnedCdnUrls } from './mirror.mjs';

const BENCH_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(BENCH_ROOT);

/** Engines to try, in order. */
const ENGINES = { chromium, firefox, webkit };

/** Chromium is present in some environments only at this path. */
const CHROMIUM_FALLBACK = '/opt/pw-browsers/chromium';

/** Content types the static server needs. */
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.webmanifest': 'application/manifest+json',
};

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
 * Read the response headers the deployed site sends for every path, from the
 * `_headers` file Cloudflare Pages uses. Serving them locally means the page
 * runs under the same Content-Security-Policy it runs under in production.
 *
 * @returns {Object<string, string>}
 */
function globalResponseHeaders() {
    const text = readFileSync(join(REPO_ROOT, '_headers'), 'utf8');
    const headers = {};
    let inGlobalBlock = false;
    for (const line of text.split('\n')) {
        if (line.startsWith('#')) continue;
        if (/^\S/.test(line)) {
            inGlobalBlock = line.trim() === '/*';
            continue;
        }
        if (!inGlobalBlock) continue;
        const match = /^\s+([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
        if (match) headers[match[1]] = match[2];
    }
    return headers;
}

/**
 * Serve a directory over HTTP on an ephemeral port.
 *
 * @param {string} root
 * @param {Object<string, string>} [headers] - added to every response
 * @returns {Promise<{origin:string, close:() => Promise<void>}>}
 */
function startServer(root, headers = {}) {
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';
        const target = resolve(root, `.${normalize(pathname)}`);
        // Refuse anything that escapes the served directory.
        if (!target.startsWith(root + sep) && target !== root) {
            res.writeHead(403).end();
            return;
        }
        if (!existsSync(target)) {
            res.writeHead(404).end();
            return;
        }
        const body = readFileSync(target);
        res.writeHead(200, {
            ...headers,
            'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
            'Content-Length': body.length,
        });
        res.end(body);
    });

    return new Promise((resolvePromise) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolvePromise({
                origin: `http://127.0.0.1:${port}`,
                close: () => new Promise((done) => server.close(done)),
            });
        });
    });
}

/**
 * Insert an uncompressed tEXt chunk into a PNG, so the marker it carries can be
 * found by a plain byte search of anything that stored the file.
 *
 * @param {Buffer} png
 * @param {string} keyword
 * @param {string} text
 * @returns {Buffer}
 */
function addPngTextChunk(png, keyword, text) {
    const payload = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
    const chunk = Buffer.alloc(payload.length + 12);
    chunk.writeUInt32BE(payload.length, 0);
    chunk.write('tEXt', 4, 'ascii');
    payload.copy(chunk, 8);
    // CRC over the type and payload.
    let crc = 0xffffffff;
    const crcInput = chunk.subarray(4, 8 + payload.length);
    for (let i = 0; i < crcInput.length; i++) {
        crc ^= crcInput[i];
        for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.length);

    // The chunk goes after IHDR, which always occupies bytes 8..32.
    const insertAt = 33;
    return Buffer.concat([png.subarray(0, insertAt), chunk, png.subarray(insertAt)]);
}

/**
 * Write the side-by-side test image, carrying a marker unique to this run.
 *
 * @param {string} dir
 * @param {string} marker
 * @returns {{path:string, marker:string, width:number, height:number}}
 */
function writeTestImage(dir, marker) {
    const scene = renderStereoScene({ eyeWidth: 640, height: 640, seed: 4242, content: 'textured' });
    const png = encodePng({ width: scene.width, height: scene.height, channels: 4, data: scene.sbs });
    const withMarker = addPngTextChunk(png, 'Comment', marker);
    const path = join(dir, 'stereo-test.png');
    writeFileSync(path, withMarker);
    return { path, marker, width: scene.width, height: scene.height };
}

/**
 * Classify a request URL against the origins and the pinned CDN list.
 *
 * @param {string} url
 * @param {{appOrigin:string, imageOrigin:string|null, pinned:Set<string>}} context
 * @returns {string}
 */
function classify(url, { appOrigin, imageOrigin, pinned }) {
    if (pinned.has(url)) return 'pinned-cdn';
    // Compared as parsed origins rather than as a string prefix, so one origin
    // cannot be mistaken for another whose port number it begins with.
    let origin;
    try {
        origin = new URL(url).origin;
    } catch {
        return 'other';
    }
    if (origin === appOrigin) return 'app-origin';
    if (imageOrigin && origin === imageOrigin) return 'image-origin';
    return 'other';
}

/**
 * Drive one scenario in one browser and record what it sent.
 *
 * @param {Object} options
 * @returns {Promise<Object>} the scenario's record
 */
async function runScenario({
    browser, engine, scenario, appOrigin, imageOrigin, imageUrl, pinned, mirror, image, steps,
}) {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
        serviceWorkers: 'allow',
    });

    const requests = [];
    const record = (request, servedFromMirror) => {
        let postBytes = 0;
        try {
            postBytes = request.postDataBuffer()?.length ?? 0;
        } catch {
            postBytes = 0;
        }
        const url = request.url();
        requests.push({
            url,
            method: request.method(),
            resource_type: request.resourceType(),
            classification: classify(url, { appOrigin, imageOrigin, pinned }),
            post_bytes: postBytes,
            from_service_worker: Boolean(request.serviceWorker?.()),
            served_from_mirror: servedFromMirror,
        });
    };

    // Every request the engine surfaces is routed, so none of those reaches the
    // network unobserved. Service Worker requests are surfaced by Chromium only;
    // the summary row records which was the case.
    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        if (pinned.has(url) && mirror.has(url)) {
            record(request, true);
            await route.fulfill({
                status: 200,
                headers: { 'Content-Type': 'text/javascript; charset=utf-8' },
                body: readFileSync(mirror.get(url).path),
            });
            return;
        }
        // The stand-in image host. The application's Content-Security-Policy
        // permits image and fetch requests to https origins only, so the host
        // has to be an https one; answering it here keeps the request, its
        // method and its body exactly as the application issued them while
        // nothing leaves this machine. The hostname is under .invalid, which is
        // reserved and never resolves.
        if (imageUrl && url === imageUrl) {
            record(request, true);
            await route.fulfill({
                status: 200,
                headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
                body: readFileSync(image.path),
            });
            return;
        }
        record(request, false);
        await route.continue();
    });

    const consoleErrors = [];
    const page = await context.newPage();
    page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300));
    });
    page.on('download', (download) => download.cancel().catch(() => {}));

    const stepResults = [];
    for (const step of steps) {
        const started = Date.now();
        try {
            await step.run(page);
            stepResults.push({ step: step.name, completed: true, ms: Date.now() - started, note: '' });
        } catch (err) {
            stepResults.push({
                step: step.name,
                completed: false,
                ms: Date.now() - started,
                note: String(err.message).split('\n')[0].slice(0, 200),
            });
        }
    }

    const storage = await auditStorage(page, image.marker);
    await context.close();

    return { engine, scenario, requests, steps: stepResults, storage, consoleErrors };
}

/**
 * Search the browser's storage for the marker the test image carries, and list
 * what is stored.
 *
 * @param {import('playwright').Page} page
 * @param {string} marker
 * @returns {Promise<Object>}
 */
function auditStorage(page, marker) {
    return page.evaluate(async (markerText) => {
        const encoder = new TextEncoder();
        const needle = encoder.encode(markerText);

        /** Find a byte sequence inside a buffer. */
        const contains = (haystack) => {
            outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
                for (let j = 0; j < needle.length; j++) {
                    if (haystack[i + j] !== needle[j]) continue outer;
                }
                return true;
            }
            return false;
        };

        const result = {
            cache_names: [],
            cache_entries: 0,
            cache_bytes: 0,
            cache_entries_with_marker: [],
            cache_entries_unreadable: 0,
            local_storage_keys: [],
            session_storage_keys: [],
            web_storage_with_marker: false,
            indexeddb_databases: [],
        };

        if (typeof caches !== 'undefined') {
            for (const name of await caches.keys()) {
                result.cache_names.push(name);
                const cache = await caches.open(name);
                for (const request of await cache.keys()) {
                    result.cache_entries++;
                    try {
                        const response = await cache.match(request);
                        if (!response) continue;
                        const buffer = new Uint8Array(await response.arrayBuffer());
                        result.cache_bytes += buffer.length;
                        if (contains(buffer)) result.cache_entries_with_marker.push(request.url);
                    } catch {
                        result.cache_entries_unreadable++;
                    }
                }
            }
        }

        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                result.local_storage_keys.push(key);
                if ((localStorage.getItem(key) ?? '').includes(markerText)) result.web_storage_with_marker = true;
            }
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                result.session_storage_keys.push(key);
                if ((sessionStorage.getItem(key) ?? '').includes(markerText)) result.web_storage_with_marker = true;
            }
        } catch {
            // Storage can be unavailable; the keys simply stay unlisted.
        }

        try {
            if (indexedDB.databases) {
                result.indexeddb_databases = (await indexedDB.databases()).map((d) => d.name);
            }
        } catch {
            // Not all engines implement databases().
        }

        return result;
    }, marker);
}

/**
 * The workflow steps of the local-file scenario.
 *
 * @param {Object} options
 * @returns {Array<{name:string, run:Function}>}
 */
function localFileSteps({ appOrigin, imagePath }) {
    return [
        {
            name: 'open-application',
            run: async (page) => {
                await page.goto(`${appOrigin}/index.html`, { waitUntil: 'load', timeout: 60000 });
                await page.waitForFunction(() => Boolean(document.getElementById('fileInput')), null, { timeout: 30000 });
            },
        },
        {
            name: 'wait-for-opencv',
            run: async (page) => {
                await page.waitForFunction(() => Boolean(window.cv?.Mat), null, { timeout: 120000 });
            },
        },
        {
            name: 'open-local-stereo-image',
            run: async (page) => {
                await page.setInputFiles('#fileInput', imagePath);
                await page.waitForFunction(async () => {
                    const globals = await import('/js/globals.js');
                    return Boolean(globals.state?.material?.uniforms?.map?.value?.image);
                }, null, { timeout: 60000 });
            },
        },
        {
            name: 'auto-align',
            run: async (page) => {
                await page.click('#autoAlignBtn', { timeout: 15000 });
                await page.waitForFunction(
                    () => document.getElementById('autoAlignBtn')?.disabled === false,
                    null,
                    { timeout: 60000 },
                );
            },
        },
        {
            name: 'change-display-mode',
            run: async (page) => {
                await page.selectOption('#displayMode', { index: 3 }, { timeout: 15000 });
                await page.waitForTimeout(500);
            },
        },
        {
            name: 'open-export-panel',
            run: async (page) => {
                // The controls live in a slide-out drawer; the save button is
                // only reachable once its panel is the active one.
                await page.click('.menu-card[data-submenu="export-menu"]', { timeout: 15000 });
                await page.waitForSelector('#export-menu.active', { timeout: 15000 });
            },
        },
        {
            name: 'export-image',
            run: async (page) => {
                await page.click('#saveBtn', { timeout: 20000 });
                await page.waitForTimeout(5000);
            },
        },
        {
            name: 'settle',
            run: async (page) => {
                await page.waitForTimeout(3000);
            },
        },
    ];
}

/**
 * The workflow steps of the external-src scenario, which also compares the
 * clipboard line the application produces with the one js/core/export-params.js
 * produces from the same state.
 *
 * @param {Object} options
 * @returns {{steps:Array, parity:Object}} `parity` is filled in as the steps run
 */
function externalSrcSteps({ appOrigin, imageUrl, parity }) {
    return [
        {
            name: 'open-application-with-src',
            run: async (page) => {
                await page.goto(
                    `${appOrigin}/index.html?src=${encodeURIComponent(imageUrl)}&mode=parallel`,
                    { waitUntil: 'load', timeout: 60000 },
                );
                await page.waitForFunction(async () => {
                    const globals = await import('/js/globals.js');
                    return Boolean(globals.state?.material?.uniforms?.map?.value?.image);
                }, null, { timeout: 90000 });
            },
        },
        {
            name: 'read-clipboard-line',
            run: async (page) => {
                const captured = await page.evaluate(async () => {
                    const exporter = await import('/js/ui/ui-export.js');
                    const globals = await import('/js/globals.js');
                    const image = globals.state.material?.uniforms?.map?.value?.image;
                    return {
                        line: exporter.generateClipboardListFormat(),
                        viewer: exporter.generateClipboardViewerFormat(),
                        params: JSON.parse(JSON.stringify(globals.state.params)),
                        format: globals.state.currentImageFormat,
                        url: globals.state.externalImageUrl,
                        imageWidth: image?.width ?? null,
                        imageHeight: image?.height ?? null,
                    };
                });
                Object.assign(parity, captured);
            },
        },
        {
            name: 'settle',
            run: async (page) => {
                await page.waitForTimeout(3000);
            },
        },
    ];
}

/** Columns of the per-request table. */
const REQUEST_COLUMNS = [
    'engine', 'scenario', 'classification', 'method', 'resource_type',
    'from_service_worker', 'served_from_mirror', 'requests', 'post_bytes_total', 'distinct_urls',
];

/** Columns of the per-scenario summary. */
const SUMMARY_COLUMNS = [
    'engine', 'scenario', 'steps_completed', 'steps_total',
    'requests_total', 'post_bytes_total',
    'requests_app_origin', 'requests_pinned_cdn', 'requests_image_origin', 'requests_other',
    'service_worker_requests', 'service_worker_visibility',
    'cache_names', 'cache_entries', 'cache_bytes', 'cache_entries_with_marker',
    'web_storage_with_marker', 'indexeddb_databases', 'console_errors',
];

/** Columns of the export-parity table. */
const PARITY_COLUMNS = [
    'engine', 'checked', 'application_line', 'module_line', 'identical',
];

const args = parseArgs(process.argv.slice(2));
const requestedEngines = args.engines
    ? String(args.engines).split(',').map((e) => e.trim())
    : Object.keys(ENGINES);

// Resolved before any browser is driven: a version string that cannot be found
// must not be what discards a finished run. It is also resolved through the
// module system rather than by assuming a directory layout, so a hoisted or
// linked install still reports it.
let playwrightVersion = null;
try {
    playwrightVersion = JSON.parse(
        readFileSync(createRequire(import.meta.url).resolve('playwright/package.json'), 'utf8'),
    ).version;
} catch {
    playwrightVersion = 'unknown';
}

process.stderr.write('preparing the pinned-asset mirror\n');
const mirror = await ensureMirror();
const unverified = [...mirror.entries()].filter(([, info]) => info.integrityVerified !== true);
if (unverified.length) {
    throw new Error(
        `mirror not usable: ${unverified.length} file(s) could not be checked against a declared integrity hash`,
    );
}
const pinned = new Set(pinnedCdnUrls());

const workDir = join(tmpdir(), `network-egress-${randomUUID()}`);
mkdirSync(workDir, { recursive: true });
const marker = `sphyrnidae-bench-marker-${randomUUID()}`;
const image = writeTestImage(workDir, marker);

const appServer = await startServer(REPO_ROOT, globalResponseHeaders());
// A reserved hostname that never resolves, answered inside the browser context
// so the request is recorded exactly as issued without leaving the machine.
const imageUrl = 'https://image-host.invalid/stereo-test.png';
const imageOrigin = new URL(imageUrl).origin;
process.stderr.write(`application served at ${appServer.origin}\n`);
process.stderr.write(`stand-in image host: ${imageOrigin}\n`);

const scenarioRecords = [];
const parityRows = [];
const enginesRun = [];

try {
    for (const engineName of requestedEngines) {
        const engine = ENGINES[engineName];
        if (!engine) {
            process.stderr.write(`  ${engineName}: not a Playwright engine, skipped\n`);
            continue;
        }
        let browser;
        try {
            browser = await engine.launch({ headless: !args.headed });
        } catch (err) {
            if (engineName === 'chromium' && existsSync(CHROMIUM_FALLBACK)) {
                browser = await engine.launch({ headless: !args.headed, executablePath: CHROMIUM_FALLBACK });
            } else {
                process.stderr.write(
                    `  ${engineName}: not available in this environment (${String(err.message).split('\n')[0].slice(0, 90)})\n`,
                );
                continue;
            }
        }
        enginesRun.push({ engine: engineName, version: browser.version() });
        process.stderr.write(`\n${engineName} ${browser.version()}\n`);

        try {
            const local = await runScenario({
                browser,
                engine: engineName,
                scenario: 'local-file',
                appOrigin: appServer.origin,
                imageOrigin: null,
                imageUrl: null,
                pinned,
                mirror,
                image,
                steps: localFileSteps({ appOrigin: appServer.origin, imagePath: image.path }),
            });
            scenarioRecords.push(local);
            for (const step of local.steps) {
                process.stderr.write(
                    `  local-file ${step.step.padEnd(26)} ${step.completed ? 'ok' : 'FAILED'} ` +
                    `${String(step.ms).padStart(6)} ms ${step.note}\n`,
                );
            }

            const parity = {};
            const external = await runScenario({
                browser,
                engine: engineName,
                scenario: 'external-src',
                appOrigin: appServer.origin,
                imageOrigin,
                imageUrl,
                pinned,
                mirror,
                image,
                steps: externalSrcSteps({ appOrigin: appServer.origin, imageUrl, parity }),
            });
            scenarioRecords.push(external);
            for (const step of external.steps) {
                process.stderr.write(
                    `  external-src ${step.step.padEnd(24)} ${step.completed ? 'ok' : 'FAILED'} ` +
                    `${String(step.ms).padStart(6)} ms ${step.note}\n`,
                );
            }

            // The application builds its clipboard line through
            // js/core/export-params.js; recomputing it here from the state the
            // page reported checks that the module produces the same text when
            // called outside the browser, which is how params-roundtrip uses it.
            if (parity.line && parity.params) {
                const moduleLine = buildListLine({
                    url: parity.url,
                    params: parity.params,
                    format: parity.format || 'half_sbs',
                    image: parity.imageWidth
                        ? { width: parity.imageWidth, height: parity.imageHeight }
                        : null,
                });
                parityRows.push({
                    engine: engineName,
                    checked: 'true',
                    application_line: parity.line,
                    module_line: moduleLine,
                    identical: String(moduleLine === parity.line),
                });
            } else {
                parityRows.push({
                    engine: engineName,
                    checked: 'false',
                    application_line: '',
                    module_line: '',
                    identical: '',
                });
            }
        } finally {
            await browser.close();
        }
    }
} finally {
    await appServer.close();
}

if (!enginesRun.length) throw new Error('no browser engine could be launched');

// One row per (engine, scenario, classification, method, resource type), so the
// table says what was contacted without listing every individual request.
const requestRows = [];
const summaryRows = [];
for (const record of scenarioRecords) {
    const groups = new Map();
    for (const request of record.requests) {
        const key = [
            request.classification, request.method, request.resource_type,
            request.from_service_worker, request.served_from_mirror,
        ].join('|');
        if (!groups.has(key)) {
            groups.set(key, { ...request, requests: 0, post_bytes_total: 0, urls: new Set() });
        }
        const group = groups.get(key);
        group.requests++;
        group.post_bytes_total += request.post_bytes;
        group.urls.add(request.url);
    }
    for (const group of groups.values()) {
        requestRows.push({
            engine: record.engine,
            scenario: record.scenario,
            classification: group.classification,
            method: group.method,
            resource_type: group.resource_type,
            from_service_worker: String(group.from_service_worker),
            served_from_mirror: String(group.served_from_mirror),
            requests: group.requests,
            post_bytes_total: group.post_bytes_total,
            distinct_urls: group.urls.size,
        });
    }

    const countBy = (classification) =>
        record.requests.filter((r) => r.classification === classification).length;
    summaryRows.push({
        engine: record.engine,
        scenario: record.scenario,
        steps_completed: record.steps.filter((s) => s.completed).length,
        steps_total: record.steps.length,
        requests_total: record.requests.length,
        post_bytes_total: record.requests.reduce((sum, r) => sum + r.post_bytes, 0),
        requests_app_origin: countBy('app-origin'),
        requests_pinned_cdn: countBy('pinned-cdn'),
        requests_image_origin: countBy('image-origin'),
        requests_other: countBy('other'),
        service_worker_requests: record.requests.filter((r) => r.from_service_worker).length,
        service_worker_visibility: record.engine === 'chromium' ? 'observed' : 'not-observable',
        cache_names: record.storage.cache_names.length,
        cache_entries: record.storage.cache_entries,
        cache_bytes: record.storage.cache_bytes,
        cache_entries_with_marker: record.storage.cache_entries_with_marker.length,
        web_storage_with_marker: String(record.storage.web_storage_with_marker),
        indexeddb_databases: record.storage.indexeddb_databases.length,
        console_errors: record.consoleErrors.length,
    });
}

const { csvPaths } = writeTables({
    bench: 'network-egress',
    tables: [
        { name: 'network-egress', columns: SUMMARY_COLUMNS, rows: summaryRows },
        { name: 'network-egress-requests', columns: REQUEST_COLUMNS, rows: requestRows },
        { name: 'network-egress-export-parity', columns: PARITY_COLUMNS, rows: parityRows },
    ],
    parameters: {
        engines_requested: requestedEngines,
        engines_run: enginesRun,
        playwright_version: playwrightVersion,
        pinned_cdn_urls: [...pinned],
        pinned_assets_served_from: 'local mirror, bytes checked against the integrity hashes the application declares',
        response_headers: 'the /* block of the repository _headers file, so the page runs under the deployed CSP',
        test_image: {
            width: image.width,
            height: image.height,
            format: 'PNG, side-by-side, with a tEXt marker chunk',
        },
        scenarios: ['local-file', 'external-src'],
        marker_recorded: false,
    },
});

// A detailed record of every request, for anything the grouped table does not answer.
const detailPath = join(BENCH_ROOT, 'results', 'network-egress-detail.json');
writeFileSync(detailPath, JSON.stringify(
    scenarioRecords.map((record) => ({
        engine: record.engine,
        scenario: record.scenario,
        steps: record.steps,
        storage: record.storage,
        console_errors: record.consoleErrors,
        requests: record.requests,
    })),
    null,
    2,
) + '\n');

process.stderr.write(`\nwrote:\n${csvPaths.map((p) => `  ${p}`).join('\n')}\n  ${detailPath}\n`);
for (const row of summaryRows) {
    process.stderr.write(
        `  ${row.engine} ${row.scenario}: steps ${row.steps_completed}/${row.steps_total}, ` +
        `${row.requests_total} requests (${row.requests_other} unclassified), ` +
        `${row.post_bytes_total} bytes sent, ` +
        `${row.cache_entries_with_marker} cache entries carrying the image marker\n`,
    );
}
process.stderr.write(`export parity: ${parityRows.map((r) => `${r.engine}=${r.identical || 'not checked'}`).join(', ')}\n`);
