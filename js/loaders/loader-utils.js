/**
 * loader-utils.js
 * Utility functions module
 * General-purpose functions for file loading, image loading, etc.
 */

import { CONSTANTS } from '../globals.js';
import * as logger from '../utils/logger.js';

/**
 * Helper function to use FileReader with Promises
 * @param {File} file - File to read
 * @param {function} onProgress - Progress callback (optional)
 * @returns {Promise<ArrayBuffer>} File contents
 */
export function readFileAsArrayBuffer(file, onProgress = null) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        let isSettled = false;

        const cleanup = () => {
            clearTimeout(timeoutId);
            reader.onload = null;
            reader.onerror = null;
            reader.onabort = null;
            reader.onprogress = null;
        };

        // Timeout protection (30s; local file reads are typically fast)
        const timeoutId = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            try { reader.abort(); } catch (_) { /* ignore */ }
            cleanup();
            reject(new Error('FileReader timeout (readAsArrayBuffer)'));
        }, 30000);

        if (onProgress) {
            reader.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress(event.loaded, event.total);
                }
            };
        }
        reader.onload = (e) => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            resolve(e.target.result);
        };
        reader.onerror = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error('File read error'));
        };
        reader.onabort = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error('File read aborted'));
        };
        reader.readAsArrayBuffer(file);
    });
}

/**
 * Helper function to load an image URL as an Image object
 * @param {string} url - Image URL
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<HTMLImageElement>} Loaded image
 */
export function loadImageFromUrl(url, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let isSettled = false;

        const cleanup = () => {
            clearTimeout(timeoutId);
            img.onload = null;
            img.onerror = null;
            img.onabort = null;
        };

        const timeoutId = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            img.src = '';  // Cancel loading
            reject(new Error(`Image load timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        img.onload = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            resolve(img);
        };
        img.onerror = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error('Image load failed'));
        };
        img.onabort = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error('Image load aborted'));
        };
        img.src = url;
    });
}

/**
 * Test whether a URL uses an http/https scheme.
 * Shared boolean validator for the entry points that want to warn/skip rather
 * than throw (URL-list parsing, ?src/?list query handling). fetchImageAsFile
 * uses the throwing validateUrlScheme() below for its richer error message.
 * @param {string} url - URL to validate
 * @param {string} [base] - Optional base for resolving relative URLs. Omit to
 *   require an absolute URL (used by the per-line URL-list parser).
 * @returns {boolean} true if the resolved URL is http: or https:
 */
export function isHttpUrl(url, base) {
    try {
        const urlObj = base !== undefined ? new URL(url, base) : new URL(url);
        const scheme = urlObj.protocol.toLowerCase();
        return scheme === 'http:' || scheme === 'https:';
    } catch (_) {
        return false;
    }
}

/**
 * Strip the query string (and credentials/hash) from a URL for safe display,
 * leaving only origin + pathname. Prevents leaking sensitive query params
 * (API keys, tokens) in user-facing error toasts. Returns the original string
 * unchanged if it cannot be parsed.
 * @param {string} url - URL to sanitize for display
 * @returns {string} origin + pathname, or the original url if unparseable
 */
export function sanitizeDisplayUrl(url) {
    try {
        const urlObj = new URL(url, window.location.href);
        return `${urlObj.origin}${urlObj.pathname}`;
    } catch (_) {
        return url;
    }
}

/**
 * Classify whether an error thrown during an image/text fetch is a CORS or
 * network-level failure (as opposed to a decode error, an HTTP error status, or
 * a size/content-type rejection). Cross-origin failures, offline/DNS failures,
 * and mixed-content blocks all surface as a TypeError from fetch() in every
 * browser, but the message text differs — Chrome "Failed to fetch", Firefox
 * "NetworkError when attempting to fetch resource", Safari "Load failed" — so
 * message-substring matching alone silently misses Safari and shows the generic
 * "failed to load" text instead of the CORS hint. Checking err.name ===
 * 'TypeError' covers all three engines; the substring list is kept as a fallback
 * for failures re-wrapped as a plain Error (e.g. the explicit CORS_ERROR marker
 * thrown by fetchImageAsFile).
 * @param {*} err - The caught error
 * @returns {boolean} true if the failure looks like a CORS/network error
 */
export function isCorsOrNetworkError(err) {
    if (!err) return false;
    // fetch() rejects with a TypeError for CORS, network, and mixed-content
    // failures in every major browser — this single check covers Chrome
    // ("Failed to fetch"), Firefox ("NetworkError…") and Safari ("Load failed"),
    // the last of which isn't caught by a plain substring list.
    if (err.name === 'TypeError') return true;
    // Fallback for a failure re-wrapped as a plain Error while keeping a
    // recognisable message — notably the explicit CORS_ERROR marker thrown by
    // fetchImageAsFile. Deliberately does NOT match "Failed to fetch": the app's
    // own HTTP-status error ("Failed to fetch image: 404 …") embeds that phrase
    // and must stay classified as a plain load failure, not a CORS problem.
    const message = typeof err.message === 'string' ? err.message : '';
    return message.includes('CORS') || message.includes('NetworkError');
}

/**
 * decodeURIComponent that never throws. Malformed percent-encoding in a URL
 * path segment (e.g. a bare "%" or a truncated "%E0%A4") makes decodeURIComponent
 * raise a URIError; callers deriving a display/filename from a URL want the raw
 * segment in that case rather than an exception that discards the whole name.
 * @param {string} s - Possibly percent-encoded string
 * @returns {string} Decoded string, or the original if decoding fails
 */
export function safeDecodeURIComponent(s) {
    try {
        return decodeURIComponent(s);
    } catch (_) {
        return s;
    }
}

/**
 * Reduce a candidate filename to a safe basename: strip any path components so a
 * server-supplied name cannot smuggle a directory path, and drop control
 * characters. Returns null when nothing usable remains.
 * @param {string} name - Raw filename candidate
 * @returns {string|null} Sanitized basename, or null
 */
function toSafeBasename(name) {
    if (typeof name !== 'string') return null;
    // Take the last path segment for either separator, then remove control chars.
    const lastSegment = name.split(/[\\/]/).pop() || '';
    // eslint-disable-next-line no-control-regex
    const cleaned = lastSegment.replace(/[\x00-\x1f\x7f]/g, '').trim();
    return cleaned || null;
}

/**
 * Extract a filename from a Content-Disposition response header, if present.
 * Prefers the RFC 5987 `filename*=UTF-8''…` form (percent-decoded) over the
 * plain `filename="…"`. Returns null when the header is absent or carries no
 * usable name. Note: for cross-origin responses this header is only readable
 * when the server lists it in Access-Control-Expose-Headers, so this is a
 * best-effort enhancement over the URL-derived name, not a guarantee.
 * @param {string|null} header - Content-Disposition header value
 * @returns {string|null} Filename, or null
 */
export function filenameFromContentDisposition(header) {
    if (!header || typeof header !== 'string') return null;
    // RFC 5987 extended form takes precedence (handles non-ASCII names).
    const extMatch = /filename\*\s*=\s*(?:UTF-8|utf-8|ISO-8859-1)?''([^;]+)/i.exec(header);
    if (extMatch) {
        const base = toSafeBasename(safeDecodeURIComponent(extMatch[1].trim()));
        if (base) return base;
    }
    // Plain quoted or bare form. Strip any surrounding double quotes so a
    // degenerate `filename=""` collapses to empty (→ null) rather than a name
    // made of quote characters.
    const match = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(header);
    if (match) {
        const raw = (match[1] ?? match[2] ?? '').trim().replace(/^"+|"+$/g, '');
        const base = toSafeBasename(raw);
        if (base) return base;
    }
    return null;
}

/**
 * Validate URL scheme (allow only http/https)
 * @param {string} url - URL to validate
 * @throws {Error} If the scheme is invalid
 */
function validateUrlScheme(url) {
    try {
        const urlObj = new URL(url, window.location.href);
        const scheme = urlObj.protocol.toLowerCase();

        // Allow only http/https (reject javascript:, data:, file:, blob:, etc.)
        if (scheme !== 'http:' && scheme !== 'https:') {
            throw new Error(`Invalid URL scheme: ${scheme}. Only http and https are allowed.`);
        }
    } catch (e) {
        // URL parse failed
        throw new Error(`Invalid URL: ${e.message}`);
    }
}

/**
 * Validate that Content-Type is an image format
 * @param {string} contentType - Content-Type header value
 * @throws {Error} If it is not an image format
 */
function validateContentType(contentType) {
    const allowedTypes = [
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/tiff',
        'image/mpo',   // Multi-Picture Object (3D image)
        'image/jps'    // JPEG Stereo (stereo JPEG)
    ];

    // Get the leading part of Content-Type (strip parameters like ;charset=utf-8)
    const baseType = (contentType || '').split(';')[0].trim().toLowerCase();

    if (!baseType || !allowedTypes.includes(baseType)) {
        throw new Error(`Invalid Content-Type: ${baseType || 'not specified'}. Expected image type.`);
    }
}

/**
 * Read a fetch Response body into a Blob while enforcing a maximum size
 * incrementally. Streams the body so reading stops as soon as the running total
 * exceeds maxSize, avoiding buffering an oversized (or unbounded) response fully
 * into memory. Falls back to response.blob() when the body stream is unavailable.
 * @param {Response} response - Fetch response
 * @param {number} maxSize - Maximum allowed size in bytes
 * @param {string|null} contentType - Content-Type for the resulting Blob
 * @param {AbortSignal|null} [signal=null] - Optional signal used to abort body reads
 * @returns {Promise<Blob>}
 * @throws {Error} If the body exceeds maxSize
 */
export async function readResponseWithSizeLimit(response, maxSize, contentType, signal = null) {
    const type = contentType || '';

    if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
    }

    // Fallback when ReadableStream body is not exposed (older browsers, etc.)
    if (!response.body || typeof response.body.getReader !== 'function') {
        const blob = await response.blob();
        if (blob.size > maxSize) {
            throw new Error(`File too large: ${blob.size} bytes exceeds maximum ${maxSize} bytes`);
        }
        return blob;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let abortHandler = null;

    try {
        if (signal) {
            abortHandler = () => {
                try {
                    reader.cancel();
                } catch (_) {
                    // Ignore cancellation errors
                }
            };
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        while (true) {
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }
            const { done, value } = await reader.read();
            if (signal?.aborted) {
                throw new DOMException('The operation was aborted.', 'AbortError');
            }
            if (done) break;
            if (!value) continue;
            received += value.byteLength;
            if (received > maxSize) {
                // Stop early and release the underlying stream/connection
                try {
                    await reader.cancel();
                } catch (_) {
                    // Ignore cancellation errors
                }
                throw new Error(`File too large: exceeds maximum ${maxSize} bytes`);
            }
            chunks.push(value);
        }
    } finally {
        if (signal && abortHandler) {
            signal.removeEventListener('abort', abortHandler);
        }
        try {
            reader.releaseLock();
        } catch (_) {
            // Ignore if already released
        }
    }

    return new Blob(chunks, { type });
}

/**
 * Fetch a text resource from a URL with a timeout and an incremental size cap.
 * Mirrors fetchImageAsFile's AbortController + Content-Length + streaming
 * readResponseWithSizeLimit pattern so the URL-list loader does not have to
 * reimplement the same fetch boilerplate inline. The caller is responsible for
 * validating the URL scheme beforehand (see isHttpUrl).
 * @param {string} url - URL of the text resource
 * @param {Object} [opts]
 * @param {number} [opts.maxBytes=CONSTANTS.URL_LIST_MAX_BYTES] - Maximum allowed body size in bytes
 * @param {number} [opts.timeout=CONSTANTS.URL_LIST_FETCH_TIMEOUT] - Timeout in milliseconds
 * @returns {Promise<string>} The response body decoded as text
 * @throws {Error} On timeout, non-OK status, or size-limit exceeded
 */
export async function fetchTextWithSizeLimit(url, { maxBytes = CONSTANTS.URL_LIST_MAX_BYTES, timeout = CONSTANTS.URL_LIST_FETCH_TIMEOUT } = {}) {
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
        didTimeout = true;
        controller.abort();
    }, timeout);

    try {
        const response = await fetch(url, { signal: controller.signal });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Reject oversized bodies early via Content-Length when the server provides it.
        const contentLength = response.headers.get('content-length');
        if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
            throw new Error(`Response too large: ${contentLength} bytes exceeds maximum ${maxBytes} bytes`);
        }

        // Stream the body with an incremental byte cap under the same timeout as
        // the initial fetch. Servers can send headers quickly and then stall the
        // body, so clearing the timer before this read would leave callers stuck.
        const blob = await readResponseWithSizeLimit(response, maxBytes, null, controller.signal);
        return await blob.text();
    } catch (fetchErr) {
        if (didTimeout || fetchErr?.name === 'AbortError') {
            throw new Error(`Fetch timeout after ${timeout}ms`);
        }
        throw fetchErr;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Fetch an image from a URL and return it as a File object
 * Security measures: URL scheme validation, Content-Type check, size limit, timeout
 * @param {string} url - Image URL
 * @param {number} maxSize - Max file size (bytes), default 50MB
 * @param {number} timeout - Timeout (milliseconds), default 30 seconds
 * @param {AbortSignal|null} [externalSignal=null] - Optional caller-owned cancellation signal
 * @returns {Promise<File>} - Retrieved image File object
 * @throws {Error} On URL validation failure, timeout, or size limit exceeded
 */
export async function fetchImageAsFile(url, maxSize = CONSTANTS.IMAGE_FETCH_MAX_SIZE, timeout = CONSTANTS.IMAGE_FETCH_TIMEOUT, externalSignal = null) {
    // 1. URL scheme validation (http/https only)
    validateUrlScheme(url);

    // 2. Timeout implementation
    const controller = new AbortController();
    let timeoutId;
    let didTimeout = false;
    let externalAbortHandler = null;
    try {
        if (externalSignal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (externalSignal) {
            externalAbortHandler = () => controller.abort();
            externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
        }
        // Execute fetch with a timeout
        timeoutId = setTimeout(() => {
            didTimeout = true;
            controller.abort();
        }, timeout);
        const fetchPromise = fetch(url, {
            mode: 'cors',
            credentials: 'omit',
            signal: controller.signal
        });

        const response = await fetchPromise;

        // Check response.type first (more reliable for CORS errors)
        // response.type is 'error' for CORS failures, 'basic'/'cors' for success
        if (response.type === 'error' || response.status === 0) {
            throw new Error('CORS_ERROR: Failed to fetch due to CORS policy or network error');
        }

        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
        }

        // 3. Content-Type validation
        const contentType = response.headers.get('content-type');
        validateContentType(contentType);

        // 4. Content-Length check (if provided by the server)
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSize) {
            throw new Error(`File too large: ${contentLength} bytes exceeds maximum ${maxSize} bytes`);
        }

        // 5. Read the body with an incremental size cap. Streaming lets us abort
        // as soon as the running total exceeds maxSize, so a response without a
        // (trustworthy) Content-Length header cannot be fully buffered into memory
        // before the size check. Falls back to response.blob() if streaming is
        // unavailable.
        const blob = await readResponseWithSizeLimit(response, maxSize, contentType, controller.signal);

        // Derive a filename. Prefer a server-supplied Content-Disposition name
        // (handles endpoints that serve an image from an extensionless, query-
        // driven URL) and fall back to the URL's last path segment. For a
        // cross-origin response the header is only readable when the server
        // exposes it via Access-Control-Expose-Headers, so this stays a best-
        // effort win over the URL-derived name.
        let filename = filenameFromContentDisposition(response.headers.get('content-disposition'));
        if (!filename) {
            filename = 'external-image';
            try {
                const urlObj = new URL(url);
                const pathname = urlObj.pathname;
                const lastSegment = pathname.split('/').pop();
                if (lastSegment && lastSegment.includes('.')) {
                    // safeDecodeURIComponent so a malformed %-escape in the path
                    // falls back to the raw segment instead of dropping the name.
                    filename = safeDecodeURIComponent(lastSegment);
                }
            } catch (e) {
                // Use a default filename if URL parsing fails
            }
        }

        // Create a File object from the Blob
        return new File([blob], filename, { type: blob.type || 'image/jpeg' });
    } catch (err) {
        if (err && err.name === 'AbortError') {
            if (didTimeout) {
                throw new Error(`Fetch timeout after ${timeout}ms`);
            }
            throw new Error('Image fetch was aborted. Please try again.');
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
        if (externalSignal && externalAbortHandler) {
            externalSignal.removeEventListener('abort', externalAbortHandler);
        }
    }
}

/**
 * Convert canvas to Blob asynchronously
 * @param {HTMLCanvasElement} canvas - Canvas to convert
 * @param {string} type - MIME type (default: 'image/png')
 * @param {number} quality - Quality (0.0-1.0, for lossy formats like JPEG)
 * @returns {Promise<Blob>} Canvas as Blob
 */
export function canvasToBlobAsync(canvas, type = 'image/png', quality = undefined) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Failed to create blob from canvas'));
                }
            },
            type,
            quality
        );
    });
}
