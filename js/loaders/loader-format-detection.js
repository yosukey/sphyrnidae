/**
 * loader-format-detection.js
 * Automatic format detection module
 * Automatically detects interlace, SBS, TaB, and other image formats
 */

import { DEBUG, CONSTANTS } from '../globals.js';
import * as logger from '../utils/logger.js';

/**
 * Create a Result object representing detection output
 * @param {boolean} detected - Whether detection succeeded
 * @param {string|null} format - Detected format
 * @param {number|null} confidence - Confidence (0.0-1.0)
 * @param {string|null} reason - Failure reason
 * @param {*} details - Additional details
 * @returns {Object} Detection result object
 */
function createDetectionResult(detected, format = null, confidence = null, reason = null, details = null) {
    return {
        detected,
        format,
        confidence,
        reason,
        details
    };
}

/**
 * Clean up detection resources (canvas and image)
 * @param {HTMLCanvasElement|null} canvas - Canvas to cleanup
 * @param {HTMLImageElement|null} img - Image to cleanup
 */
export function cleanupDetectionResources(canvas, img) {
    // Clean up canvas
    if (canvas) {
        try {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
            canvas.width = 0;
            canvas.height = 0;
        } catch (err) {
            logger.warn('FormatDetection', 'Error cleaning up canvas:', err);
        }
    }

    if (img) {
        try {
            // Remove event listeners to prevent memory leaks
            img.onload = null;
            img.onerror = null;
            img.onabort = null;

            // Clear src to release image data
            if (img.src) {
                img.src = '';
            }

            // Note: Caller should set img = null after this function returns
        } catch (err) {
            logger.warn('FormatDetection', 'Error cleaning up image:', err);
        }
    }
}

/**
 * Read a file as a Data URL (async/await version)
 * @param {File} file - File to read
 * @returns {Promise<string>} Data URL string
 */
async function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        let reader = new FileReader();
        let isSettled = false; // Flag to prevent double settlement

        const cleanup = () => {
            clearTimeout(timeoutId);
            if (reader) {
                reader.onload = null;
                reader.onerror = null;
                reader.onabort = null;
                reader = null;
            }
        };

        // Timeout protection (10s; callers also have external timeouts)
        const timeoutId = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            if (reader) {
                try { reader.abort(); } catch (_) { /* ignore */ }
            }
            cleanup();
            reject(new Error('FileReader timeout (readAsDataURL)'));
        }, 10000);

        reader.onerror = () => {
            if (isSettled) return;
            isSettled = true;
            const errorMessage = reader?.error?.message || 'Unknown FileReader error';
            cleanup();
            reject(new Error(errorMessage));
        };
        reader.onabort = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error('FileReader aborted'));
        };
        reader.onload = (e) => {
            if (isSettled) return;
            isSettled = true;
            const result = e.target.result;
            cleanup();
            resolve(result);
        };
        reader.readAsDataURL(file);
    });
}

/**
 * Load an image from a URL (async/await version)
 * @param {string} url - Image URL (Data URL, etc.)
 * @returns {Promise<HTMLImageElement>} Loaded image
 */
async function loadImageFromDataURL(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let isSettled = false;

        const cleanup = () => {
            clearTimeout(timeoutId);
            img.onerror = null;
            img.onload = null;
            img.onabort = null;
        };

        // Timeout protection (10s; data URL loading is typically near-instant)
        const timeoutId = setTimeout(() => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            img.src = '';  // Cancel loading
            reject(new Error('Image load timeout'));
        }, 10000);

        img.onerror = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error('Image load error'));
        };
        img.onabort = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            reject(new Error('Image load aborted'));
        };
        img.onload = () => {
            if (isSettled) return;
            isSettled = true;
            cleanup();
            resolve(img);
        };
        img.src = url;
    });
}

/**
 * Downscale an image with iterative halving to reduce aliasing artifacts.
 * Instead of directly scaling from source to target (which causes aliasing
 * that inflates adjacent-line diffs and triggers interlace false positives),
 * this repeatedly halves the image until close to the target, then does
 * a final resize. This effectively applies a box filter.
 * @param {HTMLImageElement} img - Source image
 * @param {number} targetWidth - Target width
 * @param {number} targetHeight - Target height
 * @returns {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D}|null}
 */
function drawImageAntiAliased(img, targetWidth, targetHeight) {
    if (targetWidth < 4 || targetHeight < 4) {
        return null;
    }

    let currentWidth = img.width;
    let currentHeight = img.height;

    // If no significant downscale needed (less than 2x), draw directly
    if (currentWidth <= targetWidth * 2 && currentHeight <= targetHeight * 2) {
        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
        return { canvas, ctx };
    }

    // Iterative halving: halve dimensions each step until close to target
    // First step: draw img directly to half-size canvas (skip full-resolution intermediate)
    let srcCanvas = null;
    let isFirstStep = true;

    while (currentWidth > targetWidth * 2 || currentHeight > targetHeight * 2) {
        const halfWidth = Math.max(targetWidth, Math.ceil(currentWidth / 2));
        const halfHeight = Math.max(targetHeight, Math.ceil(currentHeight / 2));

        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = halfWidth;
        tmpCanvas.height = halfHeight;
        const tmpCtx = tmpCanvas.getContext('2d');
        if (!tmpCtx) {
            if (srcCanvas) {
                srcCanvas.width = 0;
                srcCanvas.height = 0;
            }
            return null;
        }

        // First iteration: draw img directly (HTMLImageElement)
        // Subsequent iterations: draw from the canvas produced in the prior step
        if (isFirstStep) {
            tmpCtx.drawImage(img, 0, 0, halfWidth, halfHeight);
            isFirstStep = false;
        } else {
            tmpCtx.drawImage(srcCanvas, 0, 0, halfWidth, halfHeight);
            // Cleanup the intermediate canvas from the prior step
            srcCanvas.width = 0;
            srcCanvas.height = 0;
        }

        srcCanvas = tmpCanvas;
        currentWidth = halfWidth;
        currentHeight = halfHeight;
    }

    // Final draw to exact target size
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = targetWidth;
    finalCanvas.height = targetHeight;
    const finalCtx = finalCanvas.getContext('2d');
    if (!finalCtx) {
        srcCanvas.width = 0;
        srcCanvas.height = 0;
        return null;
    }
    finalCtx.drawImage(srcCanvas, 0, 0, targetWidth, targetHeight);

    // Cleanup intermediate
    srcCanvas.width = 0;
    srcCanvas.height = 0;

    return { canvas: finalCanvas, ctx: finalCtx };
}

/**
 * Build an analysis sample that preserves one axis at full resolution while
 * downscaling only the cross axis.
 *
 * Interlace detection relies on the even/odd periodicity ALONG the split axis
 * (adjacent rows for interlace_h, adjacent columns for interlace_v). The regular
 * anti-aliased square downscale (drawImageAntiAliased) blends adjacent rows/cols
 * together, which destroys that periodicity — a full-resolution line-interleaved
 * 1920x1080 image, for example, gets its left/right rows averaged into each other
 * and becomes undetectable. To avoid that, interlace detection runs on a sample
 * that keeps the split axis at native resolution and only shrinks the orthogonal
 * axis (whose detail interlace detection averages away anyway).
 *
 * @param {HTMLImageElement} img - Source image (must still be decoded)
 * @param {string} splitDirection - 'horizontal' (keep rows) or 'vertical' (keep columns)
 * @param {number} crossMax - Max size of the cross (non-preserved) axis
 * @returns {ImageData|null} Sample image data, or null on failure
 */
function buildInterlaceSample(img, splitDirection, crossMax) {
    const w = img.width;
    const h = img.height;
    if (w < 2 || h < 2) return null;

    // Keep the split axis full-res; shrink only the orthogonal axis.
    const targetW = splitDirection === 'horizontal' ? Math.min(w, crossMax) : w;
    const targetH = splitDirection === 'horizontal' ? h : Math.min(h, crossMax);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        canvas.width = 0;
        canvas.height = 0;
        return null;
    }

    // Smoothing blends only the cross axis (the sole axis being downscaled),
    // leaving the preserved-axis lines pixel-accurate.
    ctx.drawImage(img, 0, 0, w, h, 0, 0, targetW, targetH);

    let data = null;
    try {
        data = ctx.getImageData(0, 0, targetW, targetH);
    } catch (err) {
        logger.warn('FormatDetection', 'buildInterlaceSample getImageData failed:', err);
        data = null;
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
    return data;
}

/**
 * Prepare image for format detection (shared preprocessing)
 * Performs file reading, image decoding, and downscaling once for reuse by both
 * interlace and stereo detection functions.
 * @param {File} file - File to prepare
 * @param {AbortSignal|null} signal - Abort signal
 * @returns {Promise<Object>} { img, canvas, ctx, imageData, analysisWidth, analysisHeight, dataURL } or null on abort/error
 */
export async function prepareImageForDetection(file, signal = null) {
    let img = null;
    let canvas = null;

    try {
        if (signal?.aborted) {
            return null;
        }

        // Read file as Data URL
        const dataURL = await readFileAsDataURL(file);

        if (signal?.aborted) {
            return null;
        }

        // Load image
        img = await loadImageFromDataURL(dataURL);

        // Capture original dimensions before any manipulation
        // (img.width/height become 0 after img.src is cleared below)
        const originalWidth = img.width;
        const originalHeight = img.height;

        if (signal?.aborted) {
            cleanupDetectionResources(null, img);
            return null;
        }

        // Skip analysis for images whose pixel count is too large. The file-size
        // gate in handleFile only bounds the encoded bytes; a highly compressed
        // image can still decode to a huge pixel buffer and OOM the analysis
        // canvas / getImageData. Bail before allocating any analysis buffers so
        // the caller falls back to manual format selection.
        const megapixels = (originalWidth * originalHeight) / 1_000_000;
        if (megapixels > CONSTANTS.SKIP_FORMAT_DETECTION_MP) {
            logger.warn('FormatDetection', `Image too large for analysis (${megapixels.toFixed(1)}MP > ${CONSTANTS.SKIP_FORMAT_DETECTION_MP}MP), skipping detection`);
            cleanupDetectionResources(null, img);
            return null;
        }

        // Anti-aliased downscale to reduce aliasing artifacts
        const maxSize = CONSTANTS.FORMAT_DETECTION_MAX_SIZE;
        const scale = Math.min(1.0, maxSize / Math.max(img.width, img.height));
        let analysisWidth = Math.floor(img.width * scale);
        let analysisHeight = Math.floor(img.height * scale);

        // Ensure even dimensions for even/odd pair analysis (interlace detection)
        analysisWidth -= analysisWidth % 2;
        analysisHeight -= analysisHeight % 2;

        const drawResult = drawImageAntiAliased(img, analysisWidth, analysisHeight);
        if (!drawResult) {
            logger.warn('FormatDetection', 'Failed to create analysis canvas');
            cleanupDetectionResources(null, img);
            return null;
        }
        canvas = drawResult.canvas;
        const ctx = drawResult.ctx;

        const imageData = ctx.getImageData(0, 0, analysisWidth, analysisHeight);

        // Build dedicated interlace samples that preserve the split axis at full
        // resolution (see buildInterlaceSample). Must run BEFORE img.src is cleared.
        const interlaceHData = buildInterlaceSample(img, 'horizontal', CONSTANTS.INTERLACE_CROSS_AXIS_MAX);
        const interlaceVData = buildInterlaceSample(img, 'vertical', CONSTANTS.INTERLACE_CROSS_AXIS_MAX);

        // Release the large dataURL string early — pixel data is already in imageData
        if (img.src) {
            img.src = '';
        }

        if (signal?.aborted) {
            cleanupDetectionResources(canvas, img);
            return null;
        }

        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `Image prepared: ${originalWidth}x${originalHeight}, analysis size: ${analysisWidth}x${analysisHeight}`);

        return {
            img,
            canvas,
            ctx,
            imageData,
            analysisWidth,
            analysisHeight,
            originalWidth,
            originalHeight,
            interlaceHData,
            interlaceVData
        };
    } catch (err) {
        cleanupDetectionResources(canvas, img);
        logger.warn('FormatDetection', 'prepareImageForDetection error:', err);
        return null;
    }
}

/**
 * Auto-detect interlace format
 * Uses multi-signal analysis:
 *  1. Adjacent even-odd line diff rate (original signal)
 *  2. Periodicity check: even-odd diff vs same-parity diff ratio
 *  3. SBS/TaB cross-check to veto false positives
 *
 * Requires preprocessed data from prepareImageForDetection(); the caller owns
 * and cleans up the underlying canvas/image resources.
 * @param {Object} prepared - Preprocessed data from prepareImageForDetection()
 * @param {number} expectedToken - Token to guard against races
 * @param {Function} currentToken - Function returning the current token
 * @param {AbortSignal|null} signal - Abort signal
 * @returns {Promise<Object>} Detection result { detected, format, confidence, reason, details }
 */
export async function detectInterlaceFormat(prepared, expectedToken, currentToken, signal = null) {
    try {
        if (signal?.aborted) {
            return createDetectionResult(false, null, null, 'aborted', null);
        }

        if (!prepared || !prepared.imageData) {
            logger.warn('FormatDetection', 'detectInterlaceFormat called without prepared image data');
            return createDetectionResult(false, null, null, 'invalid_input', null);
        }

        // Caller (prepareImageForDetection) owns canvas/img and cleans them up.
        const imageData = prepared.imageData;

        // Interlace periodicity is destroyed by the shared anti-aliased downscale,
        // so prefer the dedicated full-resolution split-axis samples. Fall back to
        // the shared (blended) image only if a sample could not be built.
        const hSample = prepared.interlaceHData || imageData;
        const vSample = prepared.interlaceVData || imageData;

        // Step 1: Detect interlace with periodicity analysis.
        // detectInterlaceCommon returns: { highDiffRate, periodicityRatio, periodicityFactor, combinedScore, ... }
        const interlaceH = detectInterlaceCommon(hSample.data, hSample.width, hSample.height, 'horizontal');

        if (signal?.aborted) {
            return createDetectionResult(false, null, null, 'aborted', null);
        }

        const interlaceV = detectInterlaceCommon(vSample.data, vSample.width, vSample.height, 'vertical');

        if (signal?.aborted) {
            return createDetectionResult(false, null, null, 'aborted', null);
        }

        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `interlace_h combined: ${interlaceH.combinedScore.toFixed(3)}, interlace_v combined: ${interlaceV.combinedScore.toFixed(3)}`);

        // Select the stronger candidate direction using combined score
        // The combined score already incorporates both highDiffRate and periodicity
        let candidate = null;
        let candidateResult = null;
        const combinedThreshold = CONSTANTS.INTERLACE_COMBINED_SCORE_THRESHOLD;

        if (interlaceV.combinedScore > combinedThreshold && interlaceV.combinedScore > interlaceH.combinedScore) {
            candidate = 'interlace_v';
            candidateResult = interlaceV;
        } else if (interlaceH.combinedScore > combinedThreshold) {
            candidate = 'interlace_h';
            candidateResult = interlaceH;
        }

        if (!candidate) {
            // No candidate passed the combined threshold
            logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `✗ Not interlaced (combined scores below ${combinedThreshold})`);
            return createDetectionResult(false, null, Math.max(interlaceH.combinedScore, interlaceV.combinedScore), 'below_threshold', {
                hResult: interlaceH,
                vResult: interlaceV,
                threshold: combinedThreshold
            });
        }

        // Step 2: Cross-check with SBS/TaB half-similarity.
        // True interlace images have low global half-similarity because left/right eyes
        // are interleaved. SBS/TaB images have high half-similarity because each half
        // contains a complete view of a similar scene.
        const lrSimilarity = compareSides(imageData, 'horizontal');
        const tbSimilarity = compareSides(imageData, 'vertical');
        const maxSimilarity = Math.max(lrSimilarity, tbSimilarity);

        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `Cross-check: LR similarity: ${lrSimilarity.toFixed(3)}, TB similarity: ${tbSimilarity.toFixed(3)}`);

        if (maxSimilarity > CONSTANTS.INTERLACE_SBS_VETO_SIMILARITY) {
            // High SBS/TaB similarity → this is likely SBS/TaB, not interlace
            const vetoDirection = lrSimilarity > tbSimilarity ? 'SBS' : 'TaB';
            logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `✗ Interlace vetoed: high ${vetoDirection} similarity (${maxSimilarity.toFixed(3)} > ${CONSTANTS.INTERLACE_SBS_VETO_SIMILARITY})`);
            return createDetectionResult(false, null, candidateResult.combinedScore, 'vetoed_by_sbs_tab', {
                candidate,
                candidateResult,
                lrSimilarity,
                tbSimilarity,
                vetoDirection,
                vetoThreshold: CONSTANTS.INTERLACE_SBS_VETO_SIMILARITY
            });
        }

        // Race check: discard if a new file has been loaded
        if (currentToken() !== expectedToken) {
            logger.debug('RENDER_ERROR_LOG', 'FormatDetection', 'Token mismatch, discarding result');
            return createDetectionResult(false, null, null, 'token_mismatch', { expectedToken, actualToken: currentToken() });
        }

        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `✓ Detected as ${candidate} (combined: ${candidateResult.combinedScore.toFixed(3)}, periodicity: ${candidateResult.periodicityRatio.toFixed(2)})`);
        return createDetectionResult(true, candidate, candidateResult.combinedScore, null, {
            hResult: interlaceH,
            vResult: interlaceV,
            lrSimilarity,
            tbSimilarity
        });
    } catch (err) {
        logger.warn('FormatDetection', 'Error:', err);
        return createDetectionResult(false, null, null, 'processing_error', { error: err.message });
    }
}

/**
 * Unified function to auto-detect SBS/TaB formats
 *
 * Requires preprocessed data from prepareImageForDetection(); the caller owns
 * and cleans up the underlying canvas/image resources.
 * @param {Object} prepared - Preprocessed data from prepareImageForDetection()
 * @param {number} expectedToken - Token to guard against races
 * @param {Function} currentToken - Function returning the current token
 * @param {AbortSignal|null} signal - Abort signal
 * @returns {Promise<Object>} Detection result { detected, format, confidence, reason, details }
 */
export async function detectStereoFormat(prepared, expectedToken, currentToken, signal = null) {
    try {
        if (signal?.aborted) {
            return createDetectionResult(false, null, null, 'aborted', null);
        }

        if (!prepared || !prepared.imageData) {
            logger.warn('FormatDetection', 'detectStereoFormat called without prepared image data');
            return createDetectionResult(false, null, null, 'invalid_input', null);
        }

        // Caller (prepareImageForDetection) owns canvas/img and cleans them up.
        // Aspect ratio uses original dimensions; similarity/gradient use the
        // downscaled analysis image.
        const imageData = prepared.imageData;
        const width = prepared.originalWidth;
        const height = prepared.originalHeight;

        // Phase 1: compute left/right and top/bottom similarity
        const lrSimilarity = compareSides(imageData, 'horizontal');
        const tbSimilarity = compareSides(imageData, 'vertical');

        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `LR similarity: ${lrSimilarity.toFixed(3)}, TB similarity: ${tbSimilarity.toFixed(3)}`);

        // If similarity difference is too small, decision is difficult
        const similarityDiff = Math.abs(lrSimilarity - tbSimilarity);
        if (similarityDiff < CONSTANTS.SIMILARITY_DIFFERENCE_THRESHOLD) {
            logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `✗ Similarity difference too small (${similarityDiff.toFixed(3)})`);
            return createDetectionResult(false, null, null, 'similarity_difference_too_small', {
                lrSimilarity,
                tbSimilarity,
                difference: similarityDiff,
                threshold: CONSTANTS.SIMILARITY_DIFFERENCE_THRESHOLD
            });
        }

        // Select the higher similarity
        const direction = lrSimilarity > tbSimilarity ? 'SBS' : 'TaB';
        const directionConfidence = Math.max(lrSimilarity, tbSimilarity);

        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `Direction: ${direction} (confidence: ${directionConfidence.toFixed(3)})`);

        // Phase 2: Full vs Half decision (aspect ratio + gradient squash analysis)
        const fullHalfResult = determineFullOrHalf(width, height, direction, imageData);
        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `Full/Half: ${fullHalfResult.isHalf ? 'Half' : 'Full'} (confidence: ${fullHalfResult.confidence.toFixed(2)})`);

        // Race check: discard if a new file has been loaded
        if (currentToken() !== expectedToken) {
            logger.debug('RENDER_ERROR_LOG', 'FormatDetection', 'Token mismatch, discarding result');
            return createDetectionResult(false, null, null, 'token_mismatch', { expectedToken, actualToken: currentToken() });
        }

        // Final format decision
        let format;
        if (direction === 'SBS') {
            format = fullHalfResult.isHalf ? 'half_sbs' : 'full_sbs';
        } else {
            format = fullHalfResult.isHalf ? 'half_tab' : 'full_tab';
        }

        // Compute overall confidence
        const totalConfidence = (directionConfidence * 0.6) + (fullHalfResult.confidence * 0.4);
        logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `Final format: ${format} (total confidence: ${totalConfidence.toFixed(2)})`);

        // If confidence is low, detection fails (fallback to manual selection)
        if (totalConfidence < CONSTANTS.FORMAT_DETECTION_CONFIDENCE_THRESHOLD) {
            logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', '✗ Confidence too low, fallback to manual selection');
            return createDetectionResult(false, null, totalConfidence, 'confidence_too_low', {
                format,
                direction,
                directionConfidence,
                fullHalfConfidence: fullHalfResult.confidence,
                totalConfidence,
                threshold: CONSTANTS.FORMAT_DETECTION_CONFIDENCE_THRESHOLD
            });
        } else {
            logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `✓ Auto-detected as ${format}`);
            return createDetectionResult(true, format, totalConfidence, null, {
                direction,
                isHalf: fullHalfResult.isHalf,
                lrSimilarity,
                tbSimilarity,
                directionConfidence,
                fullHalfConfidence: fullHalfResult.confidence
            });
        }
    } catch (err) {
        logger.warn('FormatDetection', 'Error:', err);
        return createDetectionResult(false, null, null, 'processing_error', { error: err.message });
    }
}

/**
 * Calculate left/right or top/bottom similarity
 * @param {ImageData} imageData - Image data
 * @param {string} splitDirection - 'horizontal' (left/right) or 'vertical' (top/bottom)
 * @returns {number} Similarity (0.0-1.0)
 */
function compareSides(imageData, splitDirection) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    const sampleCount = CONSTANTS.FORMAT_DETECTION_SAMPLE_COUNT;
    let totalDiff = 0;
    let samples = 0;

    // Deterministic sampling: use grid-based evenly distributed samples
    // Avoid Math.random() to get consistent results from the same image
    const gridSize = Math.ceil(Math.sqrt(sampleCount));

    if (splitDirection === 'horizontal') {
        // Left/right comparison (SBS detection)
        const halfWidth = Math.floor(width / 2);

        for (let gy = 0; gy < gridSize; gy++) {
            for (let gx = 0; gx < gridSize; gx++) {
                if (samples >= sampleCount) break;

                // Compute the center of each grid cell
                const y = Math.floor((gy + 0.5) * height / gridSize);
                const x = Math.floor((gx + 0.5) * halfWidth / gridSize);

                const leftIdx = (y * width + x) * 4;
                const rightIdx = (y * width + (x + halfWidth)) * 4;

                const diff = (
                    Math.abs(data[leftIdx] - data[rightIdx]) +
                    Math.abs(data[leftIdx + 1] - data[rightIdx + 1]) +
                    Math.abs(data[leftIdx + 2] - data[rightIdx + 2])
                ) / 3;

                totalDiff += diff;
                samples++;
            }
            if (samples >= sampleCount) break;
        }
    } else {
        // Top/bottom comparison (TaB detection)
        const halfHeight = Math.floor(height / 2);

        for (let gy = 0; gy < gridSize; gy++) {
            for (let gx = 0; gx < gridSize; gx++) {
                if (samples >= sampleCount) break;

                // Compute the center of each grid cell
                const y = Math.floor((gy + 0.5) * halfHeight / gridSize);
                const x = Math.floor((gx + 0.5) * width / gridSize);

                const topIdx = (y * width + x) * 4;
                const bottomIdx = ((y + halfHeight) * width + x) * 4;

                const diff = (
                    Math.abs(data[topIdx] - data[bottomIdx]) +
                    Math.abs(data[topIdx + 1] - data[bottomIdx + 1]) +
                    Math.abs(data[topIdx + 2] - data[bottomIdx + 2])
                ) / 3;

                totalDiff += diff;
                samples++;
            }
            if (samples >= sampleCount) break;
        }
    }

    if (samples === 0) return 0.0;
    const avgDiff = totalDiff / samples;
    const similarity = 1.0 - (avgDiff / 255);

    return similarity;
}

/**
 * Compute directional gradient energy ratio within one eye region.
 *
 * In Half SBS, content is horizontally compressed by 2x, so horizontal pixel
 * gradients are roughly doubled compared to vertical (same scene detail packed
 * into half the horizontal pixels). In Full SBS, gradients are balanced.
 *
 * Similarly, Half TaB compresses vertically, doubling vertical gradients.
 *
 * @param {ImageData} imageData - Analysis image data
 * @param {string} direction - 'SBS' or 'TaB'
 * @returns {number} Squash ratio. >1 suggests Half (compressed), ~1 suggests Full (natural).
 *                   For SBS: hEnergy/vEnergy. For TaB: vEnergy/hEnergy.
 */
function computeSquashRatio(imageData, direction) {
    const data = imageData.data;
    const w = imageData.width;
    const h = imageData.height;

    let hEnergy = 0;
    let vEnergy = 0;
    let samples = 0;

    // Analyze one eye region (first half)
    const regionW = direction === 'SBS' ? Math.floor(w / 2) : w;
    const regionH = direction === 'TaB' ? Math.floor(h / 2) : h;

    const margin = 2;
    const gridSize = 20; // 20x20 = 400 sample points

    for (let gy = 0; gy < gridSize; gy++) {
        for (let gx = 0; gx < gridSize; gx++) {
            const x = margin + Math.floor((gx + 0.5) * (regionW - 2 * margin) / gridSize);
            const y = margin + Math.floor((gy + 0.5) * (regionH - 2 * margin) / gridSize);

            if (x + 1 >= w || y + 1 >= h) continue;

            const idx = (y * w + x) * 4;
            const idxRight = (y * w + (x + 1)) * 4;
            const idxDown = ((y + 1) * w + x) * 4;

            const hDiff = (
                Math.abs(data[idx] - data[idxRight]) +
                Math.abs(data[idx + 1] - data[idxRight + 1]) +
                Math.abs(data[idx + 2] - data[idxRight + 2])
            ) / 3;

            const vDiff = (
                Math.abs(data[idx] - data[idxDown]) +
                Math.abs(data[idx + 1] - data[idxDown + 1]) +
                Math.abs(data[idx + 2] - data[idxDown + 2])
            ) / 3;

            hEnergy += hDiff;
            vEnergy += vDiff;
            samples++;
        }
    }

    if (samples === 0) return 1.0;

    // Avoid division by zero with minimum energy floor
    const minEnergy = 0.01 * samples;
    hEnergy = Math.max(hEnergy, minEnergy);
    vEnergy = Math.max(vEnergy, minEnergy);

    // For SBS: Half compresses horizontally → hEnergy/vEnergy > 1
    // For TaB: Half compresses vertically → vEnergy/hEnergy > 1
    return direction === 'SBS' ? hEnergy / vEnergy : vEnergy / hEnergy;
}

/**
 * Determine Full vs Half
 *
 * Uses two complementary signals:
 *  1. Aspect ratio: check if eye aspect matches standard ratios (Full) or half-ratios (Half)
 *  2. Gradient squash ratio: detect whether content is compressed by analyzing
 *     horizontal vs vertical gradient energy within one eye region
 *
 * @param {number} width - Original image width
 * @param {number} height - Original image height
 * @param {string} direction - 'SBS' or 'TaB'
 * @param {ImageData|null} imageData - Analysis image data (for gradient analysis)
 * @returns {Object} { isHalf: boolean, confidence: number }
 */
function determineFullOrHalf(width, height, direction, imageData = null) {
    const aspect = width / height;

    // Standard aspect ratio list
    const standardAspects = [
        16/9,   // 1.778
        4/3,    // 1.333
        3/2,    // 1.500
        16/10,  // 1.600
        5/4,    // 1.250
        9/16,   // 0.563
        3/4,    // 0.750
        2/3,    // 0.667
        10/16,  // 0.625
        4/5,    // 0.800
        1/1     // 1.000
    ];

    // Compute single-eye aspect ratio (assuming Full)
    let eyeAspect;
    if (direction === 'SBS') {
        eyeAspect = (width / 2) / height;
    } else {
        eyeAspect = width / (height / 2);
    }

    const aspectTolerance = 0.15; // ±15% tolerance

    // --- Phase 1: Aspect ratio analysis ---
    // Compare how closely the single-eye aspect matches a standard ratio (→Full)
    // versus half/double of a standard ratio (→Half), and trust whichever is
    // closer. Checking "Full" first and breaking on the first match would
    // misclassify the common Half-SBS 1920x1080 case: its eyeAspect (960/1080 =
    // 0.889) falls within tolerance of 4:5 = 0.8 (~11%), yet is an exact match
    // for half of 16:9 (0.889) — i.e. Half.
    let aspectResult = null;

    let bestFullDiff = Infinity;
    for (const stdAspect of standardAspects) {
        const diff = Math.abs(eyeAspect - stdAspect) / stdAspect;
        if (diff < bestFullDiff) bestFullDiff = diff;
    }

    const halfFactors = direction === 'SBS'
        ? standardAspects.map(a => a / 2)
        : standardAspects.map(a => a * 2);
    let bestHalfDiff = Infinity;
    for (const expected of halfFactors) {
        const diff = Math.abs(eyeAspect - expected) / expected;
        if (diff < bestHalfDiff) bestHalfDiff = diff;
    }

    if (bestFullDiff < aspectTolerance || bestHalfDiff < aspectTolerance) {
        // Whichever interpretation fits a standard ratio more tightly wins.
        aspectResult = { isHalf: bestHalfDiff < bestFullDiff, confidence: 0.85 };
    }

    // Extreme aspect ratio fallback
    if (!aspectResult) {
        if (direction === 'SBS') {
            if (aspect > 3.0) {
                aspectResult = { isHalf: false, confidence: 0.7 };
            } else if (aspect >= 1.3 && aspect <= 2.3) {
                aspectResult = { isHalf: true, confidence: 0.6 };
            }
        } else {
            if (aspect < 0.7) {
                aspectResult = { isHalf: false, confidence: 0.7 };
            } else if (aspect >= 0.8 && aspect <= 2.0) {
                aspectResult = { isHalf: true, confidence: 0.6 };
            }
        }
    }

    // Default: Half (statistically most common)
    if (!aspectResult) {
        aspectResult = { isHalf: true, confidence: 0.5 };
    }

    // --- Phase 2: Gradient squash analysis ---
    // Detects whether content is horizontally/vertically compressed by comparing
    // gradient energy in each axis within one eye region.
    // This provides a content-based signal independent of aspect ratio.
    if (!imageData) {
        return aspectResult;
    }

    const squashRatio = computeSquashRatio(imageData, direction);
    logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `eyeAspect: ${eyeAspect.toFixed(3)}, squashRatio: ${squashRatio.toFixed(3)}, aspectSuggests: ${aspectResult.isHalf ? 'Half' : 'Full'} (${aspectResult.confidence.toFixed(2)})`);

    // squashRatio interpretation:
    //   > 1.5  → strong evidence of Half (content compressed in split axis)
    //   < 1.15 → strong evidence of Full (natural proportions)
    //   1.15 - 1.5 → ambiguous, fall back to aspect ratio
    const SQUASH_HALF_THRESHOLD = 1.5;
    const SQUASH_FULL_THRESHOLD = 1.15;

    if (squashRatio > SQUASH_HALF_THRESHOLD) {
        // Gradient strongly suggests Half
        const gradientConf = Math.min(0.9, 0.7 + (squashRatio - SQUASH_HALF_THRESHOLD) * 0.2);
        if (aspectResult.isHalf) {
            // Both agree: Half → boost confidence
            return { isHalf: true, confidence: Math.min(0.95, Math.max(aspectResult.confidence, gradientConf) + 0.05) };
        } else {
            // Conflict: aspect says Full, gradient says Half → trust gradient (content-based)
            logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `Aspect says Full but gradient indicates Half (squash: ${squashRatio.toFixed(3)}), overriding to Half`);
            return { isHalf: true, confidence: Math.max(0.55, gradientConf - 0.1) };
        }
    } else if (squashRatio < SQUASH_FULL_THRESHOLD) {
        // Gradient strongly suggests Full (natural proportions)
        const gradientConf = Math.min(0.85, 0.65 + (SQUASH_FULL_THRESHOLD - squashRatio) * 0.5);
        if (!aspectResult.isHalf) {
            // Both agree: Full → boost confidence
            return { isHalf: false, confidence: Math.min(0.95, Math.max(aspectResult.confidence, gradientConf) + 0.05) };
        } else {
            // Conflict: aspect says Half, gradient says Full → trust gradient
            logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `Aspect says Half but gradient indicates Full (squash: ${squashRatio.toFixed(3)}), overriding to Full`);
            return { isHalf: false, confidence: Math.max(0.55, gradientConf - 0.1) };
        }
    }

    // Ambiguous gradient → use aspect ratio only
    return aspectResult;
}

/**
 * Shared logic for interlace detection with periodicity analysis.
 *
 * In addition to the "high diff rate" between adjacent even-odd line pairs, this
 * computes a periodicity ratio:
 *   periodicityRatio = avgEvenOddDiff / avgSameParityDiff
 *
 * True interlace has strong periodicity (even lines from one eye, odd from another):
 *   - Even-odd diffs are high (different eye content)
 *   - Same-parity diffs (row N vs row N+2) are low (same eye, nearby content)
 *   → periodicityRatio >> 1
 *
 * Natural high-frequency images have high adjacent-line diffs but no periodicity:
 *   - Even-odd diffs and same-parity diffs are both high
 *   → periodicityRatio ≈ 1
 *
 * The combined score weighs highDiffRate by the periodicity evidence,
 * providing adaptive thresholding that normalizes against image noise.
 *
 * @param {Uint8ClampedArray} data - Pixel data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {string} direction - 'horizontal' (row-based) or 'vertical' (column-based)
 * @returns {Object} { highDiffRate, periodicityRatio, periodicityFactor, combinedScore, avgEvenOddDiff, avgSameParityDiff }
 */
function detectInterlaceCommon(data, width, height, direction) {
    let evenOddDiffSum = 0;
    let evenOddCount = 0;
    let highDiffCount = 0;

    let sameParityDiffSum = 0;
    let sameParityCount = 0;

    const samplesPerLine = 50;

    if (direction === 'horizontal') {
        const step = Math.max(1, Math.floor(width / samplesPerLine));

        // Even-odd row pairs: (0,1), (2,3), (4,5), ...
        for (let y = 0; y < height - 1; y += 2) {
            let diffSum = 0;
            let pixelCount = 0;

            for (let x = 0; x < width; x += step) {
                const idx1 = (y * width + x) * 4;
                const idx2 = ((y + 1) * width + x) * 4;

                const diff = (
                    Math.abs(data[idx1] - data[idx2]) +
                    Math.abs(data[idx1 + 1] - data[idx2 + 1]) +
                    Math.abs(data[idx1 + 2] - data[idx2 + 2])
                ) / 3;

                diffSum += diff;
                pixelCount++;
            }

            const avgDiff = pixelCount > 0 ? diffSum / pixelCount : 0;
            evenOddDiffSum += avgDiff;
            evenOddCount++;

            if (avgDiff > CONSTANTS.PIXEL_DIFF_THRESHOLD) {
                highDiffCount++;
            }
        }

        // Same-parity pairs: row N vs row N+2 (same eye in true interlace)
        // Sample a subset for efficiency (every parityStep rows)
        const parityStep = Math.max(1, Math.floor(height / 100));
        for (let y = 0; y < height - 2; y += parityStep) {
            let diffSum = 0;
            let pixelCount = 0;

            for (let x = 0; x < width; x += step) {
                const idx1 = (y * width + x) * 4;
                const idx2 = ((y + 2) * width + x) * 4;

                const diff = (
                    Math.abs(data[idx1] - data[idx2]) +
                    Math.abs(data[idx1 + 1] - data[idx2 + 1]) +
                    Math.abs(data[idx1 + 2] - data[idx2 + 2])
                ) / 3;

                diffSum += diff;
                pixelCount++;
            }

            const avgDiff = pixelCount > 0 ? diffSum / pixelCount : 0;
            sameParityDiffSum += avgDiff;
            sameParityCount++;
        }
    } else {
        // Vertical direction
        const step = Math.max(1, Math.floor(height / samplesPerLine));

        // Even-odd column pairs: (0,1), (2,3), (4,5), ...
        for (let x = 0; x < width - 1; x += 2) {
            let diffSum = 0;
            let pixelCount = 0;

            for (let y = 0; y < height; y += step) {
                const idx1 = (y * width + x) * 4;
                const idx2 = (y * width + (x + 1)) * 4;

                const diff = (
                    Math.abs(data[idx1] - data[idx2]) +
                    Math.abs(data[idx1 + 1] - data[idx2 + 1]) +
                    Math.abs(data[idx1 + 2] - data[idx2 + 2])
                ) / 3;

                diffSum += diff;
                pixelCount++;
            }

            const avgDiff = pixelCount > 0 ? diffSum / pixelCount : 0;
            evenOddDiffSum += avgDiff;
            evenOddCount++;

            if (avgDiff > CONSTANTS.PIXEL_DIFF_THRESHOLD) {
                highDiffCount++;
            }
        }

        // Same-parity column pairs: col N vs col N+2
        const parityStep = Math.max(1, Math.floor(width / 100));
        for (let x = 0; x < width - 2; x += parityStep) {
            let diffSum = 0;
            let pixelCount = 0;

            for (let y = 0; y < height; y += step) {
                const idx1 = (y * width + x) * 4;
                const idx2 = (y * width + (x + 2)) * 4;

                const diff = (
                    Math.abs(data[idx1] - data[idx2]) +
                    Math.abs(data[idx1 + 1] - data[idx2 + 1]) +
                    Math.abs(data[idx1 + 2] - data[idx2 + 2])
                ) / 3;

                diffSum += diff;
                pixelCount++;
            }

            const avgDiff = pixelCount > 0 ? diffSum / pixelCount : 0;
            sameParityDiffSum += avgDiff;
            sameParityCount++;
        }
    }

    const highDiffRate = evenOddCount > 0 ? highDiffCount / evenOddCount : 0;
    const avgEvenOddDiff = evenOddCount > 0 ? evenOddDiffSum / evenOddCount : 0;
    const avgSameParityDiff = sameParityCount > 0 ? sameParityDiffSum / sameParityCount : 0;

    // Periodicity ratio: how much stronger even-odd diffs are compared to same-parity diffs
    // Guard against division by zero: if same-parity diff is negligible, use a fallback
    let periodicityRatio;
    if (avgSameParityDiff > 0.5) {
        periodicityRatio = avgEvenOddDiff / avgSameParityDiff;
    } else {
        // Both diffs are near zero → flat/uniform image → no interlace signal
        periodicityRatio = avgEvenOddDiff > 1 ? 10.0 : 1.0;
    }

    // Combined score: weight highDiffRate by periodicity evidence
    // periodicityFactor: 0 when ratio<=1 (no periodicity), 1 when ratio>=threshold
    const periodicityThreshold = CONSTANTS.INTERLACE_PERIODICITY_THRESHOLD;
    const periodicityFactor = Math.max(0, Math.min(1, (periodicityRatio - 1.0) / (periodicityThreshold - 1.0)));
    const combinedScore = highDiffRate * periodicityFactor;

    const directionLabel = direction === 'horizontal' ? 'Horizontal' : 'Vertical';
    logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `detect${directionLabel}Interlace avgEvenOddDiff: ${avgEvenOddDiff.toFixed(2)}, avgSameParityDiff: ${avgSameParityDiff.toFixed(2)}, periodicityRatio: ${periodicityRatio.toFixed(2)}`);
    logger.debug('FORMAT_DETECTION_LOG', 'FormatDetection', `detect${directionLabel}Interlace highDiffRate: ${(highDiffRate * 100).toFixed(1)}%, periodicityFactor: ${periodicityFactor.toFixed(2)}, combinedScore: ${(combinedScore * 100).toFixed(1)}%`);

    return {
        highDiffRate,
        periodicityRatio,
        periodicityFactor,
        combinedScore,
        avgEvenOddDiff,
        avgSameParityDiff
    };
}
