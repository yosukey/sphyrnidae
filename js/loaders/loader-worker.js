/**
 * loader-worker.js
 * Web Worker management module
 * Handles communication with the image processing Web Worker
 */

import { CONSTANTS } from '../globals.js';
import * as logger from '../utils/logger.js';

// Web Worker initialization
let imageProcessingWorker = null;
let requestId = 0;  // Request ID issuance
const pendingRequests = new Map();  // Request ID => { resolve, reject, cleanup }
const MAX_PENDING_REQUESTS = 5;  // Limit concurrent worker requests to prevent queue overflow

/**
 * Get the image processing Web Worker (singleton)
 * @returns {Worker} Web Worker instance, or null if initialization fails
 * @throws {Error} If Worker fails to initialize
 */
export function getImageProcessingWorker() {
    if (!imageProcessingWorker) {
        try {
            imageProcessingWorker = new Worker('js/workers/image-processing-worker.js', { type: 'module' });
            // Set the global message handler (once)
            imageProcessingWorker.addEventListener('message', handleWorkerMessage);
            // Set error handler (capture init/runtime errors)
            imageProcessingWorker.addEventListener('error', handleWorkerError);
            // Set deserialization-error handler (a response that fails structured
            // clone would otherwise be dropped, stalling the request until timeout)
            imageProcessingWorker.addEventListener('messageerror', handleWorkerMessageError);

            logger.info('Worker', 'Successfully initialized image processing worker');
        } catch (err) {
            logger.error('Worker', 'Failed to initialize Web Worker:', err);
            imageProcessingWorker = null;

            // Allows graceful fallback to main-thread processing
            try {
                window.dispatchEvent(new CustomEvent('worker-init-failed', {
                    detail: {
                        error: err.message
                    }
                }));
            } catch (notifyErr) {
                logger.warn('Worker', 'Failed to dispatch worker-init-failed event:', notifyErr);
            }

            throw new Error(`Worker initialization failed: ${err.message}`);
        }
    }
    return imageProcessingWorker;
}

/**
 * Worker message handler (dispatch by request ID)
 * Use addEventListener instead of overwriting onmessage to support parallel requests
 * @param {MessageEvent} event - Message event from the Worker
 */
function handleWorkerMessage(event) {
    const { requestId: respRequestId, type, ...data } = event.data;

    // Ignore if requestId is missing or there is no matching request
    // (Possible stale messages during initialization or page reload)
    if (!respRequestId || !pendingRequests.has(respRequestId)) {
        return;
    }

    const request = pendingRequests.get(respRequestId);

    try {
        // Determine whether this is a completion or progress/error message
        if (type && type.endsWith('-complete')) {
            // Complete: delete request and resolve
            pendingRequests.delete(respRequestId);
            request.resolve({ type, ...data });
            if (request.cleanup) {
                request.cleanup();
            }
        } else if (type === 'error') {
            // Error: delete request and reject
            pendingRequests.delete(respRequestId);
            request.reject(new Error(data.error || 'Worker error'));
            if (request.cleanup) {
                request.cleanup();
            }
        } else if (type === 'progress') {
            // Progress: call callback (do not delete pendingRequests)
            if (request.onProgress) {
                request.onProgress(data);
            }
        } else {
            // Other messages: call custom handler
            if (request.onCustom) {
                request.onCustom({ type, ...data });
            }
        }
    } catch (err) {
        logger.error('Worker', 'Error handling worker message:', err);
        // Clean up to prevent timeout timer leak
        if (request.cleanup) {
            request.cleanup();
        }
        pendingRequests.delete(respRequestId);
        // Reject the request so the caller knows something went wrong
        request.reject(err);
    }
}

/**
 * Gracefully terminate worker with cleanup
 * @param {Worker} worker - Worker to terminate
 * @param {number} timeoutMs - Timeout for graceful shutdown (default 500ms)
 * @returns {Promise<void>}
 */
async function gracefullyTerminateWorker(worker, timeoutMs = 500) {
    if (!worker) return;

    try {
        // Send cleanup message to worker and wait for acknowledgement or timeout
        await new Promise((resolve) => {
            const rid = ++requestId;
            const timer = setTimeout(() => {
                pendingRequests.delete(rid);
                resolve();
            }, timeoutMs);

            pendingRequests.set(rid, {
                resolve: () => {
                    clearTimeout(timer);
                    pendingRequests.delete(rid);
                    resolve();
                },
                reject: () => {
                    clearTimeout(timer);
                    pendingRequests.delete(rid);
                    resolve();
                },
                cleanup: () => {
                    clearTimeout(timer);
                }
            });

            worker.postMessage({ requestId: rid, type: 'cleanup' });
        });

        logger.debug('WORKER_LOG', 'Worker', 'Graceful cleanup completed');
    } catch (err) {
        logger.warn('Worker', 'Error during graceful cleanup:', err);
    } finally {
        // Terminate the worker
        try {
            worker.terminate();
            logger.debug('WORKER_LOG', 'Worker', 'Worker terminated');
        } catch (err) {
            logger.warn('Worker', 'Error terminating worker:', err);
        }
    }
}

/**
 * Worker error handler (handle init/runtime errors)
 * Rejects all pending requests and terminates the worker
 * to ensure GPU memory is freed
 * Synchronous function to prevent re-entry issues from browser event handler behavior
 * @param {ErrorEvent} event - Error event from the Worker
 */
function handleWorkerError(event) {
    const errorDetails = {
        message: event.message || 'Unknown error',
        filename: event.filename || 'Unknown file',
        lineno: event.lineno || 'Unknown line',
        colno: event.colno || 'Unknown column',
        error: event.error ? {
            name: event.error.name,
            message: event.error.message,
            stack: event.error.stack
        } : 'No error object available',
        timestamp: new Date().toISOString(),
        pendingRequests: pendingRequests.size
    };

    logger.error('Worker', 'Worker error (detailed):', errorDetails);

    // CRITICAL: Reject ALL pending requests and reset worker state SYNCHRONOUSLY
    // (before any async operations to prevent re-entry issues)
    pendingRequests.forEach((request) => {
        request.reject(new Error(`Worker error: ${event.message}`));
        if (request.cleanup) {
            request.cleanup();
        }
    });
    pendingRequests.clear();

    // Reset the Worker so it can be re-initialized on next request
    const workerToTerminate = imageProcessingWorker;
    imageProcessingWorker = null;

    // Fire-and-forget: Gracefully terminate the worker to free GPU memory
    // (error may indicate resource exhaustion or partial GPU allocation)
    if (workerToTerminate) {
        gracefullyTerminateWorker(workerToTerminate, 300).catch(() => {
            // Silently ignore termination errors
        });
    }

    // This allows UI to transition to main-thread processing or show error message
    try {
        window.dispatchEvent(new CustomEvent('worker-fatal-error', {
            detail: errorDetails
        }));
    } catch (notifyErr) {
        logger.warn('Worker', 'Failed to dispatch worker-fatal-error event:', notifyErr);
    }
}

/**
 * Worker message deserialization error handler ('messageerror')
 * Fired when a response cannot be deserialized (structured-clone failure).
 * Rejects the affected request when it can be identified, otherwise rejects all
 * pending requests, mirroring handleWorkerError's reject-all fallback, so a
 * dropped response does not stall its awaiter until the request timeout.
 * @param {MessageEvent} event - Message error event from the Worker
 */
function handleWorkerMessageError(event) {
    // event.data is usually unavailable after a failed deserialization, but check
    // for a requestId in case the runtime still exposes a partial payload.
    const respRequestId = event?.data?.requestId;

    logger.error('Worker', 'Worker message deserialization error (messageerror):', {
        requestId: respRequestId ?? 'unknown',
        pendingRequests: pendingRequests.size
    });

    // Affected request is identifiable: reject only that one
    if (respRequestId && pendingRequests.has(respRequestId)) {
        const request = pendingRequests.get(respRequestId);
        pendingRequests.delete(respRequestId);
        request.reject(new Error('Worker message could not be deserialized'));
        if (request.cleanup) {
            request.cleanup();
        }
        return;
    }

    // Unidentifiable: reject ALL pending requests so no caller stalls until timeout
    pendingRequests.forEach((request) => {
        request.reject(new Error('Worker message could not be deserialized'));
        if (request.cleanup) {
            request.cleanup();
        }
    });
    pendingRequests.clear();
}

/**
 * Send a message to the Worker (Promise wrapper)
 * Includes timeout handling with forced worker termination
 * Enforces maximum concurrent requests to prevent queue overflow
 * @param {Object} message - Message to send to the Worker
 * @param {Function} onProgress - Progress callback (optional)
 * @param {Function} onCustom - Custom message callback (optional)
 * @param {Array} transferable - List of Transferable objects (optional)
 * @param {Object} [transferResult] - Optional mutable object; its `transferred`
 *   property is set to true only when postMessage actually succeeds with a
 *   non-empty transferable list (i.e. the objects were truly neutered). Lets the
 *   caller decide whether it must still release the transferables on failure.
 * @returns {Promise} Promise containing the Worker response
 * @throws {Error} If queue is full or Worker initialization fails
 */
export function sendWorkerMessage(message, onProgress = null, onCustom = null, transferable = null, transferResult = null) {
    // Prevent queue overflow: reject if too many pending requests
    if (pendingRequests.size >= MAX_PENDING_REQUESTS) {
        logger.warn('Worker', `Worker request queue full (${pendingRequests.size}/${MAX_PENDING_REQUESTS} pending)`);

        window.dispatchEvent(new CustomEvent('worker-queue-full', {
            detail: {
                pendingCount: pendingRequests.size,
                maxQueue: MAX_PENDING_REQUESTS
            }
        }));

        return Promise.reject(new Error('Worker request queue is full, please try again'));
    }

    let worker;
    try {
        worker = getImageProcessingWorker();
    } catch (err) {
        logger.error('Worker', 'Cannot send worker message:', err);
        return Promise.reject(err);
    }

    const rid = ++requestId;

    // Scale the main-thread timeout to the payload size. The worker scales its own
    // convertToBlob timeout up to 120s for large canvases (base 30s + 1s/megapixel;
    // see image-processing-worker.js). A fixed 60s main-thread timeout would
    // hard-terminate the worker mid-encode of a large image — killing every other
    // pending request too — even though the worker's own budget had not expired.
    // Derive the same worker budget from the message dimensions and always wait
    // longer than it (plus margin for decode/transfer/pre-encode work), so the
    // main thread never pre-empts a still-valid encode. Messages without
    // dimensions (e.g. MPO extraction) keep the base timeout.
    let requestTimeoutMs = CONSTANTS.FILE_LOAD_TIMEOUT_MS;
    // Derive the worker's encode-canvas dimensions from the message. processImage
    // carries width/height at the payload root; createSBSFromDualImages instead
    // carries leftImageData, and the worker composes a canvas twice as wide as one
    // eye (evenEyeWidth*2 x evenHeight; see image-processing-worker.js). Reading
    // only payload.width would leave every SBS request on the base 60s timeout even
    // though the worker's own budget scales past it for large pairs — the exact
    // premature terminate() the scaling exists to prevent. (Width/height are plain
    // number properties, still readable after the pixel buffers are transferred.)
    let encodeW = message?.payload?.width;
    let encodeH = message?.payload?.height;
    const leftImageData = message?.payload?.leftImageData;
    if ((!Number.isFinite(encodeW) || !Number.isFinite(encodeH)) && leftImageData) {
        encodeW = leftImageData.width * 2;
        encodeH = leftImageData.height;
    }
    if (Number.isFinite(encodeW) && Number.isFinite(encodeH) && encodeW > 0 && encodeH > 0) {
        const megapixels = (encodeW * encodeH) / (1024 * 1024);
        const workerBlobBudgetMs = Math.min(120000, Math.max(30000, 30000 + megapixels * 1000));
        requestTimeoutMs = Math.max(requestTimeoutMs, workerBlobBudgetMs + 60000);
    }

    return new Promise((resolve, reject) => {
        let didTimeout = false;

        const timeout = setTimeout(() => {
            didTimeout = true;
            logger.warn('Worker', `Worker request timeout (${requestTimeoutMs}ms) for requestId ${rid}`);

            // CRITICAL: Terminate worker immediately to free GPU memory
            // Then clean up pending requests
            if (worker) {
                try {
                    worker.terminate(); // Immediate termination
                    imageProcessingWorker = null;
                    logger.debug('WORKER_LOG', 'Worker', 'Worker terminated due to timeout');
                } catch (err) {
                    logger.error('Worker', 'Error terminating worker:', err);
                }
            }

            // Clean up ALL pending requests (worker was terminated, not just this one)
            for (const [pendingRid, pendingReq] of pendingRequests.entries()) {
                if (pendingRid === rid) continue; // Handle the timed-out request separately
                if (pendingReq && pendingReq.cleanup) {
                    try {
                        pendingReq.cleanup();
                    } catch (cleanupErr) {
                        logger.error('Worker', 'Error during orphaned request cleanup:', cleanupErr);
                    }
                }
                if (pendingReq && pendingReq.reject) {
                    try {
                        pendingReq.reject(new Error('Worker terminated due to another request timeout'));
                    } catch (rejectErr) {
                        // Ignore rejection errors
                    }
                }
            }
            // Clean up the timed-out request itself
            const request = pendingRequests.get(rid);
            if (request && request.cleanup) {
                try {
                    request.cleanup();
                } catch (cleanupErr) {
                    logger.error('Worker', 'Error during request cleanup:', cleanupErr);
                }
            }
            pendingRequests.clear();

            reject(new Error('Worker request timeout'));
        }, requestTimeoutMs);

        pendingRequests.set(rid, {
            resolve: (result) => {
                if (didTimeout) return;  // Ignore if timeout already occurred
                clearTimeout(timeout);
                resolve(result);
            },
            reject: (error) => {
                if (didTimeout) return;  // Ignore if timeout already occurred
                clearTimeout(timeout);
                reject(error);
            },
            onProgress,
            onCustom,
            cleanup: () => {
                clearTimeout(timeout);
            }
        });

        const msgToSend = { requestId: rid, ...message };
        try {
            if (transferable && transferable.length > 0) {
                worker.postMessage(msgToSend, transferable);
                // postMessage succeeded with a transfer list: the transferables are
                // now neutered. Report this so the caller skips its own close().
                if (transferResult) {
                    transferResult.transferred = true;
                }
            } else {
                worker.postMessage(msgToSend);
            }
        } catch (err) {
            // postMessage can throw if the worker is terminated
            // or the transferable list is invalid
            logger.error('Worker', 'Error posting message to worker:', err);
            pendingRequests.delete(rid);
            clearTimeout(timeout);
            reject(new Error(`Failed to send message to worker: ${err.message}`));
        }
    });
}

/**
 * Clear all pending requests (for cleanup)
 */
export function clearPendingRequests() {
    // Reject each request (so any in-flight sendWorkerMessage() awaiter is settled
    // rather than left pending forever after the worker is terminated) and call
    // cleanup() before clearing timers.
    pendingRequests.forEach((request) => {
        if (request.reject) {
            request.reject(new Error('Worker terminated'));
        }
        if (request.cleanup) {
            request.cleanup();
        }
    });
    pendingRequests.clear();
}

/**
 * Clean up the Worker (for tests and app shutdown)
 */
export async function terminateWorker() {
    if (imageProcessingWorker) {
        await gracefullyTerminateWorker(imageProcessingWorker, 500);
        imageProcessingWorker = null;
    }
    clearPendingRequests();
}
