/* sw.js - update-friendly version
* Strategy:
* - App shell (HTML + precached JS/CSS/locales): cache-first from the versioned
*   static cache. The shell is served as one consistent unit per SW version, so
*   a page never runs new HTML against old modules (or vice versa). New versions
*   arrive atomically via the SW update flow: a release changes version-config.js,
*   the new SW installs its own versioned precache, and activation (update banner
*   accept / all tabs closed) swaps the whole shell at once, followed by a reload
*   from sw-register.js's controllerchange handler.
* - version.json: network-first with an offline marker fallback (drives update checks)
* - CDN resources: cache-first (precached at install, runtime-cached on miss)
 * - Non-precached same-origin resources: stale-while-revalidate
 * - Arbitrary third-party URLs: network-only. User images may contain signed
 *   URLs or private content and must not silently persist in Cache Storage.
* - Update activation: skipWaiting on user accept + clients.claim
*/

// Load shared version constant (single source of truth)
importScripts('./version-config.js');

// APP_VERSION is defined by version-config.js (default: '0.0.0-dev', replaced by GitHub Actions)
const VERSION = APP_VERSION;
// A release can be rebuilt with the same SemVer tag on the SAME commit (delete and
// re-push the tag), which leaves VERSION and COMMIT_SHA identical and changes only
// BUILD_DATE. Include BUILD_DATE unconditionally (not just as a COMMIT_SHA
// fallback) so the rebuilt worker gets a distinct cache name and never writes into
// the active worker's cache.
const CACHE_REVISION = `${VERSION}-${COMMIT_SHA || 'nosha'}-${BUILD_DATE || 'dev'}`.replace(/[^a-zA-Z0-9._-]/g, '_');
const STATIC_CACHE = `sphyrnidae-static-${CACHE_REVISION}`;
const RUNTIME_CACHE = `sphyrnidae-runtime-${CACHE_REVISION}`;
const CACHE_PREFIX = 'sphyrnidae-';

// App shell: all files needed for offline operation
const PRECACHE_URLS = [
  './',
  './index.html',
  './css/base.css',
  './css/layout.css',
  './css/controls.css',
  './css/viewer.css',
  './css/dialogs.css',
  './css/utilities.css',
  './manifest.json',
  // Icons
  './favicon.ico',
  './icons/icon-192x192.png',
  './icons/icon-512x512.png',
  // Translation files
  './locales/ja.json',
  './locales/en.json',
  // Main files
  './js/main.js',
  './js/globals.js',
  './js/i18n.js',
  './debug-config.js',
  './version-config.js',
  './js/version.js',
  './js/mode-utils.js',
  './js/url-params.js',
  './js/opencv-init.js',
  // OpenCV custom build (feature detect + loader + WASM variants)
  './wasm-feature-detect.umd.js',
  './opencv/loader.js',
  './opencv/wasm/opencv.js',
  './opencv/simd/opencv.js',
  './js/sw-register.js',
  './js/portrait-guard.js',
  './js/early-viewer-mode.js',
  // Core features
  './js/core/histogram.js',
  './js/core/histogram-math.js',
  './js/core/sphyrnidae-link.js',
  './sphyrnidae-link.js',
  './js/core/versionCheck.js',
  './js/core/offlineDetection.js',
  // Rendering
  './js/rendering/renderer.js',
  './js/rendering/shaders.js',
  './js/rendering/vr.js',
  './js/rendering/vr-input.js',
  './js/rendering/alignment.js',
  './js/rendering/alignment-geometry.js',
  // Loaders
  './js/loaders/loader.js',
  './js/loaders/loader-exif.js',
  './js/loaders/loader-external.js',
  './js/loaders/loader-format-detection.js',
  './js/loaders/loader-image-creation.js',
  './js/loaders/loader-image-processing.js',
  './js/loaders/loader-mpo.js',
  './js/loaders/loader-pixel-validation.js',
  './js/loaders/loader-state.js',
  './js/loaders/loader-ui-progress.js',
  './js/loaders/loader-utils.js',
  './js/loaders/loader-viewer.js',
  './js/loaders/loader-worker.js',
  // UI
  './js/ui/ui.js',
  './js/ui/ui-alignment.js',
  './js/ui/ui-color-adjust-config.js',
  './js/ui/ui-color-adjustments.js',
  './js/ui/ui-crop.js',
  './js/ui/ui-exif.js',
  './js/ui/ui-export.js',
  './js/ui/ui-file-loading.js',
  './js/ui/ui-fullscreen.js',
  './js/ui/ui-histogram.js',
  './js/ui/ui-input.js',
  './js/ui/ui-menu.js',
  './js/ui/ui-mode.js',
  './js/ui/ui-parameters.js',
  './js/ui/ui-text-overlay.js',
  './js/ui/ui-toast.js',
  './js/ui/ui-update-notification.js',
  './js/ui/ui-viewer.js',
  './js/ui/ui-visibility.js',
  './js/ui/ui-zoom.js',
  './js/ui/ui-pointer3d.js',
  // Utils
  './js/utils/logger.js',
  './js/utils/pixel-utils.js',
  './js/utils/safe-storage.js',
  // Workers
  './js/workers/image-processing-worker.js',
  './js/workers/shared-utils.js',
];

// CDN resources needed for offline operation (precache)
// These must be precached so the app works on the very first offline load after install.
// URLs must match those in index.html (including SRI-compatible non-minified variants).
const CDN_PRECACHE_URLS = [
  // Three.js is loaded as an ES module via the import map in index.html. Every
  // rendering module does `import * as THREE from 'three'`, so without this the
  // app cannot start when the first load after install happens to be offline.
  // three.module.min.js re-exports from three.core.min.js via a relative import,
  // so the core chunk must be precached too or offline startup fails to resolve it.
  'https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.module.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.182.0/build/three.core.min.js',
  'https://cdn.jsdelivr.net/npm/i18next@23.7.6/i18next.min.js',
  'https://cdn.jsdelivr.net/npm/exifreader@4.14.1/dist/exif-reader.js',
  'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js',
  'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js',
  'https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js',
  'https://cdn.jsdelivr.net/npm/upng-js@2.1.0/UPNG.js',
];

// Pathnames of all precached same-origin resources (resolved against the SW
// scope), for O(1) routing in the fetch handler: requests for these are served
// cache-first from the versioned static cache instead of stale-while-revalidate.
const PRECACHE_PATH_SET = new Set(
  PRECACHE_URLS.map((url) => new URL(url, self.location.href).pathname)
);

const RUNTIME_CACHE_MAX_ENTRIES = 120;
const RUNTIME_CACHE_MAX_BYTES = 50 * 1024 * 1024;

// In-memory cache of measured runtime-cache entry sizes, keyed by request URL.
// getEstimatedSize() reads the full (potentially large, cross-origin) body to
// size an entry, so without this cleanupRuntimeCache would re-read every cached
// image body on every pass. Sizes are measured lazily once per entry during
// cleanup and reused thereafter; a put invalidates the URL's entry (its content
// just changed) and cleanup prunes URLs no longer in the cache, so the Map stays
// bounded and correct. A SW restart simply empties it, falling back to a remeasure.
const runtimeSizeCache = new Map();

// Cleanup debounce configuration
// State: 'idle' (nothing scheduled), 'scheduled' (timer running), 'running' (cleanup executing)
let cleanupState = 'idle';
let needsReschedule = false; // Set to true if new schedule request comes during 'running'
const CLEANUP_DEBOUNCE_MS = 5000; // 5-second debounce

// Approximate runtime cache entry count (avoids O(n) cache.keys() on every fetch)
let runtimeCacheCountApprox = 0;

// Incremented each time a cleanup pass actually completes. A scheduled (debounced)
// cleanup uses this to detect that an emergency cleanup ran during its debounce
// wait and skip its own now-redundant full enumeration.
let cleanupGeneration = 0;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);

    // Cache same-origin app shell.
    // These files are REQUIRED for offline operation, so precaching them is
    // treated as all-or-nothing: if any of them fails to fetch (e.g. a partial
    // deploy or a transient error), the whole install is rejected. This prevents
    // a Service Worker from activating with an incomplete shell that would serve a
    // broken app on the first offline load. The SW is retried on a later
    // navigation once all resources are reachable.
    // Explicitly set redirect: 'follow' to avoid redirect errors.
    const failedUrls = [];
    await Promise.all(
      PRECACHE_URLS.map(async (url) => {
        try {
          const response = await fetch(url, {
            cache: 'reload',
            redirect: 'follow'
          });
          if (response.ok) {
            // Re-wrap redirected responses before caching. Cloudflare Pages
            // 308-redirects /index.html -> /, so following it yields a response
            // with redirected: true — and browsers refuse to serve a cached
            // redirected response to a navigation request ("a redirected
            // response was used for a request whose redirect mode is not
            // 'follow'"), which would break the cache-first HTML route.
            // Copying the body into a fresh Response strips the flag.
            const toStore = response.redirected
              ? new Response(await response.blob(), {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                })
              : response;
            await cache.put(url, toStore);
          } else {
            failedUrls.push(`${url} (status ${response.status})`);
          }
        } catch (err) {
          failedUrls.push(`${url} (${err && err.message ? err.message : 'fetch error'})`);
        }
      })
    );
    if (failedUrls.length > 0) {
      // Reject the install so a broken/partial shell is never activated.
      throw new Error(`[SW] App shell precache failed for ${failedUrls.length} resource(s): ${failedUrls.join(', ')}`);
    }

    // Precache CDN resources as well (important for GIF export, etc.). The core
    // Three.js dependency is mandatory; optional CDN helpers remain best-effort
    // and are fetched (and cached) at runtime on a later online request.
    const failedCdnUrls = [];
    await Promise.all(
      CDN_PRECACHE_URLS.map(async (url) => {
        try {
          const response = await fetch(url, {
            cache: 'reload'
          });
          // Only cache successful responses. Opaque responses (status 0) are
          // indistinguishable from errors and should not be persisted permanently.
          if (response.ok) {
            await cache.put(url, response);
            console.log(`[SW] CDN resource cached: ${url}`);
          } else {
            failedCdnUrls.push(url);
            console.warn(`[SW] CDN resource not cached (status ${response.status}): ${url}`);
          }
        } catch (err) {
          failedCdnUrls.push(url);
          console.warn(`[SW] Failed to cache CDN resource ${url}:`, err);
        }
      })
    );
    // Three.js is required to boot the application. Both the entry module AND the
    // core chunk it re-imports (CDN_PRECACHE_URLS[0] and [1]) are mandatory: if only
    // core fails, three.module.min.js is cached but its relative import of
    // three.core.min.js misses on the first offline navigation and the app fails to
    // boot — exactly the state this all-or-nothing guard exists to prevent. Do not
    // activate an "offline" shell that is guaranteed to fail offline.
    const requiredCdnUrls = [CDN_PRECACHE_URLS[0], CDN_PRECACHE_URLS[1]];
    const missingRequired = requiredCdnUrls.filter((u) => failedCdnUrls.includes(u));
    if (missingRequired.length > 0) {
      throw new Error(`[SW] Required Three.js CDN precache failed: ${missingRequired.join(', ')}`);
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Clean up stale caches
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith(CACHE_PREFIX) && ![STATIC_CACHE, RUNTIME_CACHE].includes(k))
        .map((k) => caches.delete(k))
    );

    await self.clients.claim(); // Let the new SW take control of existing tabs

    // Initialize approximate runtime cache counter
    try {
      const cache = await caches.open(RUNTIME_CACHE);
      const requests = await cache.keys();
      runtimeCacheCountApprox = requests.length;
    } catch (err) {
      console.warn('[SW] Failed to initialize cache counter:', err);
    }
  })());
});

// Receive "switch immediately" message from clients
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isHtmlNavigationRequest(request) {
  // mode:navigate is typical; allow SPA detection via Accept:text/html
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

function isNoStore(response) {
  const cacheControl = response.headers.get('cache-control');
  return cacheControl ? /no-store/i.test(cacheControl) : false;
}

function getExpirationTimestamp(response) {
  const cacheControl = response.headers.get('cache-control');
  if (cacheControl) {
    if (/no-store|no-cache/i.test(cacheControl)) {
      return Date.now();
    }
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
    if (maxAgeMatch) {
      const maxAgeSeconds = Number.parseInt(maxAgeMatch[1], 10);
      const dateHeader = response.headers.get('date');
      const baseTime = dateHeader ? Date.parse(dateHeader) : Date.now();
      if (!Number.isNaN(baseTime) && !Number.isNaN(maxAgeSeconds)) {
        return baseTime + maxAgeSeconds * 1000;
      }
    }
  }

  const expiresHeader = response.headers.get('expires');
  if (expiresHeader) {
    const expiresTime = Date.parse(expiresHeader);
    if (!Number.isNaN(expiresTime)) {
      return expiresTime;
    }
  }

  return null;
}

function getStoredTimestamp(response, fallback) {
  const dateHeader = response.headers.get('date');
  const dateTime = dateHeader ? Date.parse(dateHeader) : Number.NaN;
  return Number.isNaN(dateTime) ? fallback : dateTime;
}

async function getEstimatedSize(response) {
  // For cross-origin (?src=) responses the Content-Length header is controlled by
  // a third-party server, which could understate it to slip large bodies past the
  // RUNTIME_CACHE_MAX_BYTES eviction budget. Measure the real body for those.
  // Same-origin responses are trusted, so use the cheap header and avoid reading
  // the whole body. An empty response.url (e.g. synthetic responses) defaults to
  // same-origin, matching the precache case.
  let sameOrigin = true;
  try {
    sameOrigin = new URL(response.url || self.location.href, self.location.href).origin === self.location.origin;
  } catch (_) {
    sameOrigin = true;
  }

  if (sameOrigin) {
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader) {
      const length = Number.parseInt(lengthHeader, 10);
      if (Number.isFinite(length) && length >= 0) {
        return length;
      }
    }
  }

  // Fallback: the server omitted (or sent an invalid) Content-Length, e.g. with
  // chunked transfer encoding, or the response is cross-origin and the header is
  // untrusted. Without this, such entries could miscount and the eviction budget
  // could be silently exceeded. Only non-opaque responses reach the runtime cache,
  // so blob().size reflects the real body length. Clone first so the cached
  // response stays intact.
  try {
    const blob = await response.clone().blob();
    return blob.size;
  } catch (err) {
    return 0;
  }
}

async function cleanupRuntimeCache({
  maxEntries = RUNTIME_CACHE_MAX_ENTRIES,
  maxBytes = RUNTIME_CACHE_MAX_BYTES,
} = {}) {
  const cache = await caches.open(RUNTIME_CACHE);
  const requests = await cache.keys();
  const now = Date.now();
  const entries = [];
  let totalBytes = 0;

  for (const request of requests) {
    const response = await cache.match(request);
    if (!response) continue;

    // Only no-store responses must never persist — hard-delete them on cleanup.
    // Merely-expired entries (no-cache / max-age=0 / past Expires) are kept: they
    // include the same-origin assets Cloudflare serves with max-age=0, which are
    // exactly what makes the app work offline. Deleting them on expiry defeated that
    // (they would vanish shortly after first view). Expiry is instead used only as
    // eviction PRIORITY within the entry/byte budget below. (User-supplied ?src=
    // images never reach this cache — the cross-origin handler serves them
    // network-only.)
    if (isNoStore(response)) {
      await cache.delete(request);
      continue;
    }

    const expiresAt = getExpirationTimestamp(response);
    const isExpired = expiresAt !== null && expiresAt <= now;
    const storedAt = getStoredTimestamp(response, now);
    // Reuse a previously-measured size; only read the body for entries we have
    // not sized yet (newly put since the last cleanup, or after a SW restart).
    let size = runtimeSizeCache.get(request.url);
    if (size === undefined) {
      size = await getEstimatedSize(response);
      runtimeSizeCache.set(request.url, size);
    }
    totalBytes += size;
    entries.push({ request, storedAt, size, isExpired });
  }

  // Evict expired entries first, then oldest-first, until within budget.
  entries.sort((a, b) => {
    if (a.isExpired !== b.isExpired) return a.isExpired ? -1 : 1;
    return a.storedAt - b.storedAt;
  });

  while (
    (maxEntries && entries.length > maxEntries) ||
    (maxBytes && totalBytes > maxBytes)
  ) {
    const entry = entries.shift();
    if (!entry) break;
    await cache.delete(entry.request);
    totalBytes -= entry.size;
  }

  // Prune size-cache entries that are no longer in the runtime cache (evicted
  // above, hard-deleted as no-store, or dropped by the browser under quota) so
  // the Map cannot grow unbounded across the SW's lifetime. The surviving
  // entries are exactly what remains in `entries` after eviction.
  const liveUrls = new Set(entries.map((e) => e.request.url));
  for (const url of runtimeSizeCache.keys()) {
    if (!liveUrls.has(url)) {
      runtimeSizeCache.delete(url);
    }
  }

  // Return the actual remaining entry count so callers can resync the
  // approximate counter (which otherwise only ever increments per fetch).
  return entries.length;
}

/**
 * Schedule cleanup (debounced with improved state management)
 *
 * Even if multiple cache additions happen quickly, run cleanup only once.
 * If new schedule requests come during cleanup execution, re-run after completion.
 *
 * State machine:
 * - 'idle' → 'scheduled' (debounce timer started)
 * - 'scheduled' → 'running' (cleanup executing)
 * - 'running' → 'idle' (cleanup completed, or → 'running' if needsReschedule)
 *
 * Emergency cleanup bypasses debounce when cache size exceeds threshold.
 *
 * Returns a Promise for event.waitUntil() integration
 */
function scheduleCleanup() {
  const cleanupPromise = (async () => {
    // Increment approximate counter (avoids O(n) cache.keys() on every fetch)
    runtimeCacheCountApprox++;

    const emergencyThreshold = Math.floor(RUNTIME_CACHE_MAX_ENTRIES * 1.5);

    // Only do the expensive cache.keys() enumeration if the counter suggests
    // we might be near the emergency threshold
    if (runtimeCacheCountApprox > emergencyThreshold) {
      const cache = await caches.open(RUNTIME_CACHE);
      const requests = await cache.keys();
      const currentEntryCount = requests.length;
      // Sync counter with actual count
      runtimeCacheCountApprox = currentEntryCount;

      if (currentEntryCount > emergencyThreshold) {
        // Emergency cleanup: run immediately (bypasses debounce but respects state machine)
        if (cleanupState === 'running') {
          // Another cleanup is already executing; mark for re-run
          needsReschedule = true;
          return;
        }
        console.log(`[SW] Emergency cleanup triggered: ${currentEntryCount} entries (threshold: ${emergencyThreshold})`);
        cleanupState = 'running';
        try {
          const remaining = await cleanupRuntimeCache();
          // Sync to the real remaining count instead of an approximate decrement.
          if (typeof remaining === 'number') {
            runtimeCacheCountApprox = remaining;
          }
          cleanupGeneration++;
        } catch (err) {
          console.error('[SW] Emergency cleanup failed:', err);
        } finally {
          cleanupState = 'idle';
        }
        // Consume any reschedule request that arrived while this emergency
        // cleanup was running, so it isn't silently dropped. Re-run via the
        // debounced path (state is now 'idle', so this won't recurse here).
        if (needsReschedule) {
          needsReschedule = false;
          scheduleCleanup();
        }
        return;
      }
    }

    // Normal debounced cleanup with improved state management
    if (cleanupState === 'running') {
      // Cleanup is currently executing, mark for re-run after completion
      needsReschedule = true;
      return;
    }

    if (cleanupState === 'scheduled') {
      // Already scheduled (debounce timer running), no need to schedule again
      return;
    }

    // Schedule new cleanup
    cleanupState = 'scheduled';

    // Snapshot the cleanup generation so we can detect an emergency cleanup that
    // completes while we wait out the debounce below.
    const generationBeforeDebounce = cleanupGeneration;

    // Wait debounce time before executing
    await new Promise(resolve => {
      setTimeout(resolve, CLEANUP_DEBOUNCE_MS);
    });

    // If an emergency cleanup started during the debounce wait and is STILL running
    // (its generation increment hasn't happened yet), do not start a concurrent
    // enumeration. Flag a reschedule so the running pass re-runs cleanup when it
    // finishes (its finally-path consumes needsReschedule). The generation check
    // below only catches an emergency that already *completed*, not one mid-flight.
    if (cleanupState === 'running') {
      needsReschedule = true;
      return;
    }

    // If an emergency cleanup completed during the debounce wait (and no reschedule
    // was requested), the cache is already fresh — running another full enumeration
    // here would just repeat the expensive cache.keys()/match() work for nothing.
    if (cleanupGeneration !== generationBeforeDebounce && !needsReschedule) {
      cleanupState = 'idle';
      return;
    }

    // Run cleanup loop (handles reschedule requests during execution)
    do {
      needsReschedule = false;
      cleanupState = 'running';

      try {
        const remaining = await cleanupRuntimeCache();
        // Resync the approximate counter to the real post-cleanup count so it
        // does not drift upward across many cached fetches (it is otherwise only
        // incremented per response), which would trigger the O(n) cache.keys()
        // emergency enumeration far more often than necessary.
        if (typeof remaining === 'number') {
          runtimeCacheCountApprox = remaining;
        }
        cleanupGeneration++;
      } catch (err) {
        console.error('[SW] Scheduled cleanup failed:', err);
      }

      // If a reschedule was requested during execution, wait debounce time again
      if (needsReschedule) {
        cleanupState = 'scheduled'; // Transition back to scheduled for the re-run
        await new Promise(resolve => {
          setTimeout(resolve, CLEANUP_DEBOUNCE_MS);
        });
      }
    } while (needsReschedule);

    // Reset state to idle
    cleanupState = 'idle';
  })();

  return cleanupPromise;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Ignore anything other than GET
  if (req.method !== 'GET') return;

  // Let ranged requests go straight to the network. Serving a full cached 200 to a
  // request that carries a Range header breaks media elements (and any future
  // <video>/<audio>/PDF range request) that expect a 206 partial response. No
  // current precached asset uses ranges, so this only guards future additions.
  if (req.headers.has('range')) return;

  const url = new URL(req.url);

  // Cache API only supports http/https requests
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }

  // Cross-origin requests: immutable CDN libraries vs. user-supplied content.
  if (!isSameOrigin(url)) {
    // Versioned CDN assets (Three.js/i18next/etc.) are immutable, so cache-first
    // is correct and provides offline support. Arbitrary cross-origin content —
    // most importantly user-supplied ?src= images — is deliberately NOT cached at
    // all (the network-only branch below): even transiently storing a remote image
    // could retain signed URLs / private images in Cache Storage on a shared device
    // without the user's consent.
    //
    // Only the app's own pinned CDN dependencies (exact CDN_PRECACHE_URLS entries)
    // are treated as immutable. Matching the whole cdn.jsdelivr.net host was wrong:
    // a user could pass ?src=https://cdn.jsdelivr.net/... (e.g. a mutable /gh/ or
    // @latest path) and have that image frozen forever, contradicting the intent
    // above. Any other cross-origin URL — jsDelivr or not — falls through to the
    // network-only branch below.
    const isImmutableCdn = CDN_PRECACHE_URLS.includes(url.href);

    if (isImmutableCdn) {
      // Cache-first. Check RUNTIME_CACHE and STATIC_CACHE (CDN precache lives there).
      event.respondWith((async () => {
        const runtimeCache = await caches.open(RUNTIME_CACHE);
        const cached = await runtimeCache.match(req);
        if (cached) {
          return cached;
        }

        const staticCache = await caches.open(STATIC_CACHE);
        const staticCached = await staticCache.match(req);
        if (staticCached) {
          return staticCached;
        }

        try {
          const response = await fetch(req);
          // Cache only successful responses (skip 4xx/5xx errors and opaque
          // responses, which have status 0 and are indistinguishable from errors).
          if (response && response.ok) {
            try {
              await runtimeCache.put(req, response.clone());
              // The cached body for this URL just changed; drop its stale size.
              runtimeSizeCache.delete(req.url);
              event.waitUntil(scheduleCleanup());
            } catch (cacheErr) {
              console.warn('[SW] Skipped runtime cache put for unsupported request:', req.url, cacheErr);
            }
          }
          return response;
        } catch (err) {
          return new Response('', { status: 504, statusText: 'Gateway Timeout' });
        }
      })());
      return;
    }

    // User-provided remote images and URL lists are intentionally network-only.
    // Caching a Request preserves its full query string and response body, which
    // can retain signed URLs/private images on shared devices without consent.
    event.respondWith(fetch(req).catch(() => new Response('', {
      status: 504,
      statusText: 'Gateway Timeout'
    })));
    return;
  }

  // Always fetch latest version.json (network-first with offline fallback).
  // Match the app's own version.json by its exact resolved path (mirrors the HTML
  // route below), not a trailing-`/version.json` suffix: a suffix match would also
  // capture an unrelated same-origin sibling app's /other/version.json and answer it
  // with this app's synthetic offline marker.
  const versionJsonPath = new URL('./version.json', self.location.href).pathname;
  if (url.pathname === versionJsonPath) {
    event.respondWith((async () => {
      try {
        return await fetch(req.url, {
          cache: 'no-store',
          redirect: 'follow'
        });
      } catch (err) {
        // Offline fallback: return a minimal response so the app doesn't crash
        return new Response(JSON.stringify({ version: 'offline', offline: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  // 1) HTML (navigation): cache-first from the versioned static cache.
  // Serving HTML from the same precache as the JS/CSS guarantees the page and
  // its modules always come from one release. Freshness is provided by the SW
  // update flow (sw-register.js polls registration.update(); the new SW
  // precaches the next version and the swap happens atomically on activation),
  // NOT by fetching HTML from the network on every navigation — that would produce
  // mixed-version shells (fresh HTML + stale revalidated assets).
  const appRootPath = new URL('./', self.location.href).pathname;
  const indexPath = new URL('./index.html', self.location.href).pathname;
  if (isHtmlNavigationRequest(req) && (url.pathname === appRootPath || url.pathname === indexPath)) {
    event.respondWith((async () => {
      const staticCache = await caches.open(STATIC_CACHE);
      // The app root accepts query strings such as ?src=..., but other same-origin
      // paths must reach the network so relative assets/pages are not replaced by
      // this app shell.
      const cached =
        (await staticCache.match('./index.html')) ||
        (await staticCache.match('./'));
      if (cached) return cached;

      // Precache miss (navigation raced install, or the browser evicted the
      // cache): fall back to the network so the app still loads.
      try {
        return await fetch(req.url, {
          cache: 'no-store',
          redirect: 'follow',
          credentials: 'same-origin'
        });
      } catch (err) {
        return new Response('Offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 2) Precached app-shell assets: cache-first from the versioned static cache,
  // with NO background revalidation. Per-file revalidation is what allowed
  // mixed-version shells (each file updating independently of the HTML); shell
  // files now change only via an atomic SW version swap.
  if (PRECACHE_PATH_SET.has(url.pathname)) {
    event.respondWith((async () => {
      const staticCache = await caches.open(STATIC_CACHE);
      const cached = await staticCache.match(req, { ignoreSearch: true });
      if (cached) return cached;

      // Abnormal: the entry was evicted or the request raced install. Fetch from
      // the network and repair the precache so subsequent loads are consistent
      // again. This may momentarily serve a newer deploy's file, but a missing
      // shell entry is already an inconsistent state; best effort beats a 504.
      try {
        // Bypass the HTTP cache for the repair fetch (like the navigation fallback).
        // With the default cache mode a stale HTTP-cached copy of a *previous* deploy's
        // file could be written durably into this version's static cache, recreating
        // the mixed-version shell the atomic-swap design eliminates.
        const res = await fetch(req, { cache: 'no-store' });
        if (res && res.ok) {
          try {
            await staticCache.put(req, res.clone());
          } catch (cacheErr) {
            console.warn('[SW] Failed to repair precache entry:', req.url, cacheErr);
          }
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // 3) Non-precached same-origin resources (favicon, icon sources, dynamic
  // JSON, etc.) use stale-while-revalidate
  event.respondWith((async () => {
    const runtimeCache = await caches.open(RUNTIME_CACHE);

    // Check runtime cache first; only open static cache on miss
    const cached = await runtimeCache.match(req)
      || await (await caches.open(STATIC_CACHE)).match(req);

    const fetchPromise = (async () => {
      try {
        const res = await fetch(req);
        // Store only ok (200-range). Opaque shouldn't occur for same-origin, but keep safe
        if (res && res.ok) {
          if (isNoStore(res)) {
            // A no-store response must never persist (same invariant cleanupRuntimeCache
            // enforces). Don't cache it here, and evict any entry a prior cacheable
            // response for this URL left behind so the stale copy can't be served
            // offline — otherwise the "must never persist" resource would linger in
            // Cache Storage until some unrelated put triggered the next cleanup pass.
            try {
              await runtimeCache.delete(req);
              runtimeSizeCache.delete(req.url);
            } catch (delErr) {
              console.warn('[SW] Failed to evict no-store entry:', delErr);
            }
          } else {
            try {
              await runtimeCache.put(req, res.clone());
              // The cached body for this URL just changed; drop its stale size.
              runtimeSizeCache.delete(req.url);
              // Schedule cleanup and ensure it completes via event.waitUntil()
              event.waitUntil(scheduleCleanup());
            } catch (cacheErr) {
              console.warn('[SW] Failed to cache resource:', cacheErr);
            }
          }
        }
        return res;
      } catch (e) {
        return null;
      }
    })();

    // Return cache immediately and update in background
    if (cached) {
      event.waitUntil(fetchPromise);
      return cached;
    }

    // If no cache, use network; fallback to 504 if it fails
    const network = await fetchPromise;
    if (network) return network;

    return new Response('', { status: 504 });
  })());
});
