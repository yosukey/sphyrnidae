/**
* alignment.js
* Auto-alignment logic (ORB/AKAZE) using OpenCV.js
*
* - The logical left eye image is fixed (reference)
* - Shifts (shiftX, shiftY) are applied only to the logical right eye image
*
* swapLR (swap left/right eyes) effects:
*   - swapLR=false: physical left = logical left, physical right = logical right
*   - swapLR=true: physical left = logical right, physical right = logical left
*   ※ When swapLR is true, swap the reference and target images for matching.
*/
import { state, CONSTANTS } from '../globals.js';
import { showToast } from '../ui/ui-toast.js';
import * as logger from '../utils/logger.js';
import { estimateVerticalAffine, cropWindowToAnalysisRect } from './alignment-geometry.js';

/**
* i18n helper: safely call window.t()
* Falls back to the key name itself when i18n has not been initialized, rather
* than maintaining a parallel English dictionary here that could drift out of
* sync with locales/en.json — the raw key is a clear signal that translation
* is unavailable.
*/
function safeT(key, params = {}) {
    return window.t?.(key, params) ?? key;
}

/**
* Shared helper to display a status message
* @param {string} message - Message to display
* @param {string} color - Message color (default: '#ff9800' warning color)
* @param {number} timeout - Display duration in ms (default: 5000)
* @param {boolean} preWrap - Whether to apply pre-line style (default: false)
*/
function showStatus(message, color = '#ff9800', timeout = 5000, preWrap = false) {
    const statusEl = document.getElementById('alignmentStatus');
    if (statusEl) {
        // Cancel the previous auto-hide timer before starting a new one.
        // Without this, rapid successive calls accumulate timers that hide the
        // most-recent message too early.
        if (statusHideTimerId !== null) {
            clearTimeout(statusHideTimerId);
            statusHideTimerId = null;
        }
        statusEl.textContent = message;
        statusEl.style.color = color;
        statusEl.style.display = 'block';
        statusEl.style.whiteSpace = preWrap ? 'pre-line' : 'normal';
        statusHideTimerId = setTimeout(() => {
            statusEl.style.display = 'none';
            statusHideTimerId = null;
        }, timeout);
    } else {
        // No #alignmentStatus element exists in the DOM, so fall back to a toast.
        // Map the intended status color to the matching toast type and preserve
        // the caller's timeout, so success/failure keep their styling and
        // duration instead of all being flattened to a generic 6s "info" toast.
        const type = color === '#4CAF50' ? 'success'
            : color === '#f44336' ? 'error'
            : color === '#ff9800' ? 'warning'
            : 'info';
        showToast(message, type, timeout);
    }
}

// Timer ID for the auto-hide timeout of the status element.
// Stored so that a subsequent call cancels the previous timer before starting a new one,
// preventing stale timers from hiding a more-recent message prematurely.
let statusHideTimerId = null;

// Reentrancy guard: prevent concurrent alignment runs
let isAlignmentRunning = false;

/**
* Run auto-alignment
* @param {Function} updateParamsCallback - Callback to apply results to the UI (key, value) => void
* @param {Function} onSuccessCallback - Callback invoked on success (optional)
*/
export function performAutoAlignment(updateParamsCallback, onSuccessCallback) {
    // Reentrancy guard: reject if already running
    if (isAlignmentRunning) {
        logger.warn('AutoAlign', 'Alignment already in progress, ignoring duplicate call');
        return;
    }

    // 1. Basic checks
    if (typeof cv === 'undefined' || !cv.Mat) {
        showStatus(safeT('messages.opencvNotLoaded'));
        return;
    }

    // Guard .uniforms too: after a failed WebGL context restore the renderer
    // installs a plain MeshBasicMaterial (no .uniforms), so dereferencing
    // .uniforms.map here would throw a TypeError out of the click handler.
    if (!state.material || !state.material.uniforms || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image) {
        showStatus(safeT('messages.noImageLoaded'));
        return;
    }

    // Get algorithm selected in UI
    const algoSelect = document.getElementById('alignAlgorithm');
    const algoType = algoSelect ? algoSelect.value : 'orb';

    // Depth-placement preset (read from the DOM like the algorithm select, so
    // the UI stays the single source of truth). 'windowSafe' places the nearest
    // reliable content slightly behind the screen so nothing pops out — window
    // violations at the lateral frame edges become structurally impossible.
    // 'standard' (default) keeps the comfort straddle placement.
    const placementSelect = document.getElementById('depthPlacement');
    const windowSafe = !!(placementSelect && placementSelect.value === 'windowSafe');

    // Pre-checks when AKAZE is selected
    if (algoType === 'akaze' && typeof cv.AKAZE === 'undefined') {
        showStatus(safeT('messages.akazeNotAvailable'));
        return;
    }

    // Pre-checks when SIFT is selected
    // SIFT is only available when the loaded OpenCV.js build was compiled with it
    // (the default build whitelist omits SIFT). Bail out gracefully otherwise.
    if (algoType === 'sift' && typeof cv.SIFT === 'undefined') {
        showStatus(safeT('messages.siftNotAvailable'));
        return;
    }

    isAlignmentRunning = true;

    // --- UI update: indicate processing ---
    const btn = document.getElementById('autoAlignBtn');
    const originalBtnText = btn ? btn.textContent : '';
    if (btn) {
        btn.textContent = safeT('alignment.processing');
        btn.disabled = true;
    }
    document.body.style.cursor = 'wait';

    // Use setTimeout to avoid blocking the UI
    // Reason: OpenCV feature extraction/matching is synchronous and CPU intensive,
    // which can block the main thread and freeze the UI.
    // Delay 50ms to let DOM updates (e.g., disabling buttons) complete before processing
    setTimeout(() => {
        const startTime = performance.now();

        // Memory release list
        const resources = [];
        
        try {
            // Re-validate: the image may have been cleared, or the material swapped
            // to a non-shader fallback / the texture disposed during the setTimeout
            // window. Bail gracefully instead of throwing a raw TypeError reported
            // as "alignment failed".
            if (!state.material || !state.material.uniforms || !state.material.uniforms.map
                || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image) {
                showStatus(safeT('messages.noImageLoaded'));
                return;
            }
            // --- 2. Get image data (via canvas) ---
            const texture = state.material.uniforms.map.value;
            const img = texture.image;

            // Validate image dimensions to prevent NaN/Infinity propagation
            if (!img.width || !img.height || !Number.isFinite(img.width) || !Number.isFinite(img.height)) {
                throw new Error(`Invalid image dimensions: ${img.width}x${img.height}`);
            }

            // Draw to a smaller canvas for analysis (speed)
            // Resize long edge to target size to avoid too small inputs
            const scale = Math.min(CONSTANTS.ANALYSIS_RESIZE_MAX_DIMENSION / img.width, CONSTANTS.ANALYSIS_RESIZE_MAX_DIMENSION / img.height);
            const w = Math.floor(img.width * scale);
            const h = Math.floor(img.height * scale);

            logger.debug('ALIGNMENT_LOG', 'AutoAlign', 'Analysis image scaling:', {
                originalSize: `${img.width}x${img.height}`,
                analysisSize: `${w}x${h}`,
                scale: scale.toFixed(4),
                halfWidth: Math.floor(w / 2),
            });

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                throw new Error('Failed to get 2D canvas context');
            }
            ctx.drawImage(img, 0, 0, w, h);

            const imageData = ctx.getImageData(0, 0, w, h);
            
            // Create Mat
            const src = cv.matFromImageData(imageData);
            resources.push(src);

            // --- 3. Split left/right images ---
            // Assuming SBS format: left and right halves
            const width = src.cols;
            const height = src.rows;
            const halfW = Math.floor(width / 2);

            // Restrict analysis to the user's crop window: features in
            // cropped-away regions (borders, subtitles, ...) must not drive the
            // alignment. The window is identical for both eyes (it lives in
            // originalUv space, before the per-eye shift), so the dx/dy deltas
            // need no correction — only absolute positions (gu/gv/y) get the
            // window origin added back below. Falls back to the full frame for
            // no/degenerate/too-small crops.
            const win = cropWindowToAnalysisRect(state.params, halfW, height);
            if (win.restricted) {
                logger.info('AutoAlign', 'Analysis restricted to crop window:', {
                    x: win.x, y: win.y, width: win.width, height: win.height,
                });
            } else if (win.reason === 'too_small_fallback') {
                logger.warn('AutoAlign', 'Crop window too small for analysis; using full frame');
            }

            const rectL = new cv.Rect(win.x, win.y, win.width, win.height);
            const rectR = new cv.Rect(halfW + win.x, win.y, win.width, win.height); // Right side

            // Determine logical left/right eye considering swapLR
            // swapLR=false: physical left = logical left (reference), physical right = logical right (shift target)
            // swapLR=true: physical left = logical right (shift target), physical right = logical left (reference)
            const swapped = state.params.swapLR;

            // Set reference image (logical left) and shift target (logical right).
            // Push each ROI immediately so that if the second src.roi() throws,
            // the finally block can still release the first one.
            const imgL = swapped ? src.roi(rectR) : src.roi(rectL);  // Logical left (reference)
            resources.push(imgL);
            const imgR = swapped ? src.roi(rectL) : src.roi(rectR);  // Logical right (shift target)
            resources.push(imgR);

            // --- 4. Feature detection and matching ---
            // Push each OpenCV object into `resources` immediately after construction so that
            // if any subsequent `new cv.*` throws, the finally block can still release the ones
            // that were already created.
            let orb = null;
            const keypoints1 = new cv.KeyPointVector();
            resources.push(keypoints1);
            const keypoints2 = new cv.KeyPointVector();
            resources.push(keypoints2);
            const descriptors1 = new cv.Mat();
            resources.push(descriptors1);
            const descriptors2 = new cv.Mat();
            resources.push(descriptors2);

            if (algoType === 'akaze') {
                orb = new cv.AKAZE();
            } else if (algoType === 'sift') {
                // SIFT (high accuracy, float descriptors)
                orb = new cv.SIFT();
            } else {
                // ORB (Default)
                // nfeatures: max feature count (default 500 -> 2000)
                orb = new cv.ORB(2000);
            }
            resources.push(orb);

            // Create empty mask matrices (track individually to prevent leaks
            // if the second constructor throws)
            const maskL = new cv.Mat();
            resources.push(maskL);
            const maskR = new cv.Mat();
            resources.push(maskR);

            // Convert ROIs to grayscale before feature detection.
            // matFromImageData() yields an RGBA (CV_8UC4) Mat; passing that directly to
            // ORB/AKAZE relies on their internal BGR2GRAY conversion, which mis-weights
            // the R/B channels for RGBA input. Convert explicitly with RGBA2GRAY.
            const grayL = new cv.Mat();
            resources.push(grayL);
            const grayR = new cv.Mat();
            resources.push(grayR);
            cv.cvtColor(imgL, grayL, cv.COLOR_RGBA2GRAY);
            cv.cvtColor(imgR, grayR, cv.COLOR_RGBA2GRAY);

            // Detect & describe
            orb.detectAndCompute(grayL, maskL, keypoints1, descriptors1);
            orb.detectAndCompute(grayR, maskR, keypoints2, descriptors2);

            if (keypoints1.size() === 0 || keypoints2.size() === 0) {
                throw new Error(safeT('messages.noFeaturesFound'));
            }

            // Matching (BFMatcher: Brute Force)
            // SIFT produces floating-point descriptors (CV_32F) and requires the L2
            // norm; ORB/AKAZE produce binary descriptors and use Hamming distance.
            const normType = (algoType === 'sift') ? cv.NORM_L2 : cv.NORM_HAMMING;
            const bf = new cv.BFMatcher(normType, true);
            resources.push(bf);
            const matches = new cv.DMatchVector();
            resources.push(matches);

            bf.match(descriptors1, descriptors2, matches);

            // Guard against degenerate match counts. With fewer than 4 matches the
            // estimator can only return a zero shift, which would otherwise be
            // reported as a successful (but meaningless) alignment.
            if (matches.size() < 4) {
                throw new Error(safeT('messages.noFeaturesFound'));
            }

            // --- 5. Alignment pipeline (Disparity Comfort Alignment) ---
            const totalMatches = matches.size();
            const imgHalfWidth = img.width / 2;
            const pipelineUsed = 'disparity_comfort';
            logger.info('AutoAlign', 'Pipeline: DISPARITY_COMFORT (single path)');

            // Collect deltas from feature matches.
            // Keypoint coordinates are local to the analysis ROI (the crop
            // window), so absolute per-eye positions add the window origin
            // (win.x, win.y). dx/dy need no correction: both eyes share the
            // same window, so the common origin cancels in the differences.
            // For the optional geometric refinement we also keep, per match, the
            // LEFT/display position in shader-UV space and the vertical disparity:
            //   gu = (win.x + left.x) / halfW      (x in [0,1], not flipped)
            //   gv = 1 - (win.y + left.y) / height (y in [0,1], flip-corrected for
            //                                        the texture's flipY=true)
            //   gDisp = (right.y - left.y) / height (vertical disparity in UV)
            // gu/gv stay normalized by the FULL frame because the shader's
            // alignTransform operates in full-frame per-eye UV.
            // The field disp ~ d*gu + e*gv + f generalizes the shift-only shiftY,
            // so its constant reproduces the known-correct vertical sign. The
            // shift-only path still uses only dx/dy/dist/y, exactly as before.
            const deltas = [];
            for (let i = 0; i < matches.size(); i++) {
                const m = matches.get(i);
                const kp1 = keypoints1.get(m.queryIdx);
                const kp2 = keypoints2.get(m.trainIdx);
                const dx = kp2.pt.x - kp1.pt.x;
                const dy = kp2.pt.y - kp1.pt.y;
                deltas.push({
                    dx, dy, dist: m.distance, y: win.y + kp1.pt.y,
                    gu: (win.x + kp1.pt.x) / halfW,
                    gv: 1 - (win.y + kp1.pt.y) / height,
                    gDisp: dy / height,
                });
            }

            const est = estimateDisparityComfortShift(deltas, {
                keepRatio: 0.60,
                minKeep: 80,
                maxKeep: 900,
                dyMadK: 2.5,
                dyMinTol: 1.0,
                // comfort limits in analysis pixel space
                comfortNegLimitPx: Math.max(8, halfW * 0.06),
                comfortPosLimitPx: Math.max(10, halfW * 0.10),
                // Depth placement presets (see #depthPlacement in the UI):
                // - standard: zero plane at p45 with a slight pop-out bias.
                //   The scene straddles the screen for stronger depth. The
                //   fixed pixel bias inside the comfort score is
                //   shift-invariant: unlike a multiplicative dxGain, the
                //   result does not depend on the arbitrary horizontal
                //   offset (framing/convergence) baked into the source pair.
                // - windowSafe: the robust nearest content (p05) goes slightly
                //   BEHIND the screen (positive bias as a safety margin), so
                //   nothing carries crossed disparity and objects cut by the
                //   lateral frame edges cannot violate the stereo window.
                targetZeroPercentile: windowSafe ? 0.05 : 0.45,
                zeroPlaneBiasPx: windowSafe
                    ? Math.max(1, halfW * 0.005)
                    : -Math.max(1, halfW * 0.01),
            });

            logger.debug('ALIGNMENT_LOG', 'AutoAlign', 'Disparity comfort details:', {
                method: est.method,
                dyInliers: est.dyInlierCount,
                dxSamples: est.dxSampleCount,
                dxShift: est.dxShift,
                dyCorrection: est.dyCorrection,
                comfortScore: est.comfortScore,
                disparityStats: est.disparityStats
            });

            const scaleFactor = 1.0 / scale;
            const realDx = est.dxShift * scaleFactor;
            const realDy = est.dyCorrection * scaleFactor;

            // Convert to UV units and apply as shiftX/shiftY
            const uvShiftX = realDx / imgHalfWidth;
            const uvShiftY = realDy / img.height;
            const targetShiftX = -(uvShiftX / 2.0);
            const targetShiftY = uvShiftY;

            // Optional geometric refinement (experimental, default OFF).
            // The toggle is read from the DOM the same way the algorithm select
            // is, so the UI stays the single source of truth (no persisted param).
            const geoToggle = document.getElementById('geometricRefineToggle');
            const geometricRefine = !!(geoToggle && geoToggle.checked);

            let geometryInfo = null;
            let geometryApplied = false;
            if (geometricRefine) {
                geometryInfo = estimateVerticalAffine(
                    deltas.map(d => ({ u: d.gu, v: d.gv, t: d.gDisp, dist: d.dist }))
                );
                logger.debug('ALIGNMENT_LOG', 'AutoAlign', 'Geometric refinement:', {
                    adopted: geometryInfo.adopted,
                    reason: geometryInfo.reason,
                    rollDeg: geometryInfo.rollDeg?.toFixed(3),
                    zoomPct: geometryInfo.zoomPct?.toFixed(3),
                    residualTier0: geometryInfo.residualTier0,
                    residualTier1: geometryInfo.residualTier1,
                    inlierCount: geometryInfo.inlierCount,
                    usedCount: geometryInfo.usedCount,
                    minSpreadStd: geometryInfo.minSpreadStd?.toFixed(3),
                });
            }

            if (updateParamsCallback) {
                if (geometryInfo && geometryInfo.adopted) {
                    // Adopted affine: the matrix carries the full vertical
                    // correction (including the constant), so shiftY must be 0 to
                    // avoid double-applying it. Horizontal stays a pure global
                    // shift (matrix top row is identity) -> depth is preserved.
                    updateParamsCallback('alignTransform', geometryInfo.matrix);
                    updateParamsCallback('shiftX', targetShiftX);
                    updateParamsCallback('shiftY', 0);
                    geometryApplied = true;
                } else {
                    // Shift-only path (unchanged): reset geometric transform.
                    updateParamsCallback('alignTransform', [1, 0, 0, 0, 1, 0, 0, 0, 1]);
                    updateParamsCallback('shiftX', targetShiftX);
                    updateParamsCallback('shiftY', targetShiftY);
                }
            }

            // Vertical value for the completion toast. When the affine matrix is
            // adopted it carries the vertical correction (shiftY is 0), and its
            // constant comes from the IRLS fit, not dyCorrection — report the
            // applied field evaluated at frame center instead of the unused
            // shift-only estimate.
            const appliedRealDy = (geometryInfo && geometryInfo.adopted)
                ? (geometryInfo.d * 0.5 + geometryInfo.e * 0.5 + geometryInfo.f) * img.height
                : realDy;

            const endTime = performance.now();
            const elapsedMs = (endTime - startTime).toFixed(0);

            logger.info('AutoAlign', 'Disparity comfort result:', {
                algorithm: algoType.toUpperCase(),
                pipeline: pipelineUsed,
                placement: windowSafe ? 'window_safe' : 'standard',
                timeMs: elapsedMs,
                adoptedPoints: est.dyInlierCount,
                totalMatches,
                dx: realDx.toFixed(1),
                dy: realDy.toFixed(1),
                comfortScore: est.comfortScore.toFixed(3),
                disparityStats: est.disparityStats,
                geometricRefine,
                geometryApplied,
                geometryReason: geometryInfo ? geometryInfo.reason : 'off',
            });

            setTimeout(() => {
                const stats = est.disparityStats || {};
                // Make the narrowed analysis region visible to the user (in
                // original-image pixels per eye); omit the line for full-frame
                // analysis so the default message is unchanged.
                const regionLine = win.restricted
                    ? safeT('alignment.analysisRegion', {
                        width: Math.round(win.width / scale),
                        height: Math.round(win.height / scale),
                    }) + '\n'
                    : '';
                const message =
                    safeT('alignment.complete', { algorithm: algoType.toUpperCase() }) + '\n' +
                    safeT('alignment.pipeline') + '\n' +
                    regionLine +
                    safeT('alignment.processingTime', { time: elapsedMs }) + '\n' +
                    safeT('alignment.separator') + '\n' +
                    safeT('alignment.adoptedPoints', { valid: est.dyInlierCount, total: totalMatches }) + '\n' +
                    safeT('alignment.verticalShift', { value: appliedRealDy.toFixed(1) }) + '\n' +
                    safeT('alignment.horizontalShift', { value: realDx.toFixed(1) }) + '\n' +
                    safeT('alignment.dxRange', {
                        min: (stats.min ?? 0).toFixed(1),
                        max: (stats.max ?? 0).toFixed(1)
                    }) + '\n' +
                    safeT('alignment.zeroPlane', {
                        percentile: Math.round((stats.targetZeroPercentile ?? 0.45) * 100),
                        value: (stats.zeroPlaneEstimate ?? 0).toFixed(1)
                    }) + '\n' +
                    safeT('alignment.comfortScore', { value: est.comfortScore.toFixed(3) });

                // Append a geometric-refinement line only when the option was used,
                // so the default shift-only result message is unchanged.
                let finalMessage = message;
                if (geometricRefine) {
                    finalMessage += '\n' + (geometryApplied
                        ? safeT('alignment.geometryApplied', {
                            roll: geometryInfo.rollDeg.toFixed(2),
                            zoom: geometryInfo.zoomPct.toFixed(2),
                        })
                        : safeT('alignment.geometrySkipped', {
                            reason: geometryInfo ? geometryInfo.reason : 'off',
                        }));
                }

                showStatus(finalMessage, '#4CAF50', 10000, true);
            }, 50);

            // Run success callback (crop, etc.) if provided
            // Not run if ui.js passes null
            if (onSuccessCallback) {
                onSuccessCallback();
            }

        } catch (err) {
            logger.error('AutoAlign', 'Error:', err);
            // Reason: delay DOM ops after errors to prioritize rendering
            setTimeout(() => {
                const message = safeT('messages.alignmentFailed', { algorithm: algoType, error: err.message });
                showStatus(message, '#f44336', 10000, true);
            }, 50);
        } finally {
            // --- 7. Cleanup and UI restore ---
            // Release OpenCV.js resources (safe without relying on isDeleted())
            let deletedCount = 0;
            while (resources.length > 0) {
                const obj = resources.pop();
                if (!obj) continue;

                try {
                    // Skip if isDeleted() exists and already deleted
                    if (typeof obj.isDeleted === 'function' && obj.isDeleted()) {
                        continue;
                    }

                    // Call delete() only if it exists
                    if (typeof obj.delete === 'function') {
                        obj.delete();
                        deletedCount++;
                    }
                } catch (e) {
                    logger.error('AutoAlign', 'Cleanup error:', e);
                }
            }

            isAlignmentRunning = false;
            if (btn) {
                btn.textContent = originalBtnText;
                btn.disabled = false;
            }
            document.body.style.cursor = 'default';
        }
    }, 50);
}


// ------------------------------
// Helpers: estimation methods
// ------------------------------

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function medianSorted(arrSorted) {
    const n = arrSorted.length;
    if (!n) return 0;
    const mid = (n / 2) | 0;
    return (n % 2) ? arrSorted[mid] : (arrSorted[mid - 1] + arrSorted[mid]) / 2;
}

// Precondition: arrSorted is sorted ascending and contains only finite numbers
// (all callers pass keypoint-derived values, which are always finite). A NaN
// filter here would be too late anyway: a NaN would already have corrupted the
// caller's comparator-based sort, leaving the array unsorted.
function percentileSorted(arrSorted, q) {
    const n = arrSorted.length;
    if (!n) return 0;
    const qq = clamp(q, 0, 1);
    const idx = (n - 1) * qq;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return arrSorted[lo];
    const t = idx - lo;
    return arrSorted[lo] * (1 - t) + arrSorted[hi] * t;
}

function medianAbsDeviation(values, med) {
    if (!values.length) return 0;
    const dev = values.map(v => Math.abs(v - med)).sort((a, b) => a - b);
    return medianSorted(dev);
}

/**
 * Estimate shift-only correction focused on viewing comfort.
 *
 * - dy: robustly estimate mechanical vertical misalignment.
 * - dx: preserve disparity structure and find a single horizontal shift
 *       minimizing comfort penalties (range overflow + zero-plane target,
 *       optionally biased by zeroPlaneBiasPx toward pop-out/recess). The score
 *       depends on the disparities only through dx − s, so the result is
 *       invariant to the input pair's arbitrary horizontal framing offset.
 *
 * @param {Array<{dx:number,dy:number,dist?:number,y?:number}>} deltas
 * @param {Object} opts
 * @returns {{method:string,dyCorrection:number,dxShift:number,dyInlierCount:number,dxSampleCount:number,comfortScore:number,disparityStats:Object}}
 */
function estimateDisparityComfortShift(deltas, opts = {}) {
    const o = {
        keepRatio: 0.60,
        minKeep: 80,
        maxKeep: 900,
        dyMadK: 2.5,
        dyMinTol: 1.0,
        comfortNegLimitPx: 24,
        comfortPosLimitPx: 40,
        targetZeroPercentile: 0.45,
        zeroWeight: 0.25,
        // Target disparity (px) for the zero-plane percentile after the shift;
        // negative places it slightly in front of the screen (pop-out). Being a
        // fixed pixel offset inside the score, it is invariant to the input
        // pair's arbitrary horizontal framing offset.
        zeroPlaneBiasPx: 0,
        ...opts
    };

    if (!Array.isArray(deltas) || deltas.length < 4) {
        return {
            method: 'disparity_comfort',
            dyCorrection: 0,
            dxShift: 0,
            dyInlierCount: 0,
            dxSampleCount: 0,
            comfortScore: 0,
            disparityStats: {
                min: 0, max: 0, p10: 0, p50: 0, p90: 0,
                zeroPlaneEstimate: 0,
                targetZeroPercentile: o.targetZeroPercentile
            }
        };
    }

    // Distance prefilter
    const byDist = deltas.slice().sort((a, b) => ((a.dist ?? 1e9) - (b.dist ?? 1e9)));
    const target = Math.floor(byDist.length * clamp(o.keepRatio, 0.05, 1.0));
    const nKeep = clamp(target, Math.min(o.minKeep | 0, byDist.length), Math.min(o.maxKeep | 0, byDist.length));
    const work = byDist.slice(0, Math.max(4, nKeep));

    // Robust dy estimation
    const dySorted = work.map(d => d.dy).sort((a, b) => a - b);
    const dyMedian = medianSorted(dySorted);
    const dyMad = medianAbsDeviation(work.map(d => d.dy), dyMedian);
    const tolY = Math.max(o.dyMinTol, o.dyMadK * (1.4826 * dyMad));

    let dyInliers = work.filter(d => Math.abs(d.dy - dyMedian) <= tolY);
    if (dyInliers.length < Math.max(8, Math.floor(work.length * 0.15))) {
        dyInliers = work.filter(d => Math.abs(d.dy - dyMedian) <= Math.max(tolY, 3.0));
    }
    if (dyInliers.length < 4) dyInliers = work.slice();

    const inlierDySorted = dyInliers.map(d => d.dy).sort((a, b) => a - b);
    const dyCorrection = medianSorted(inlierDySorted);

    const dxArr = dyInliers.map(d => d.dx).sort((a, b) => a - b);
    if (dxArr.length < 4) {
        return {
            method: 'disparity_comfort',
            dyCorrection,
            dxShift: 0,
            dyInlierCount: dyInliers.length,
            dxSampleCount: dxArr.length,
            comfortScore: 0,
            disparityStats: {
                min: 0, max: 0, p10: 0, p50: 0, p90: 0,
                zeroPlaneEstimate: 0,
                targetZeroPercentile: o.targetZeroPercentile
            }
        };
    }

    const p10 = percentileSorted(dxArr, 0.10);
    const p50 = percentileSorted(dxArr, 0.50);
    const p90 = percentileSorted(dxArr, 0.90);
    const p95 = percentileSorted(dxArr, 0.95);
    const p05 = percentileSorted(dxArr, 0.05);

    // Percentiles are translation-equivariant: P_q(dx − s) = P_q(dx) − s, so the
    // zero-plane position for every candidate shift comes from one precomputed
    // percentile — no per-candidate re-sort. This also shows the zero term is an
    // exact convex quadratic in s; the overflow term is convex too, so the whole
    // score is convex and the coarse+local search cannot be trapped in a local
    // minimum.
    const pZero = percentileSorted(dxArr, o.targetZeroPercentile);

    const evalShift = (s) => {
        let overflow = 0;
        for (const dx of dxArr) {
            const d = dx - s;
            const overNeg = Math.max(0, -o.comfortNegLimitPx - d);
            const overPos = Math.max(0, d - o.comfortPosLimitPx);
            overflow += overNeg * overNeg + overPos * overPos;
        }
        const zeroPlane = pZero - s;
        const zeroDev = zeroPlane - o.zeroPlaneBiasPx;
        return {
            score: overflow / dxArr.length + o.zeroWeight * zeroDev * zeroDev,
            zeroPlane
        };
    };

    // Search range driven by current disparity distribution and comfort limits.
    const sMin = p05 - o.comfortPosLimitPx;
    const sMax = p95 + o.comfortNegLimitPx;

    let bestS = p50;
    let best = evalShift(bestS);

    const coarseSteps = 60;
    const span = Math.max(1e-6, sMax - sMin);
    for (let i = 0; i <= coarseSteps; i++) {
        const s = sMin + (span * i) / coarseSteps;
        const cur = evalShift(s);
        if (cur.score < best.score) {
            best = cur;
            bestS = s;
        }
    }

    // Local refinement around best coarse candidate.
    const localHalf = span / coarseSteps;
    for (let i = 0; i < 24; i++) {
        const step = localHalf / Math.pow(1.5, i / 4);
        const l = evalShift(bestS - step);
        const r = evalShift(bestS + step);
        if (l.score < best.score) {
            best = l;
            bestS -= step;
        } else if (r.score < best.score) {
            best = r;
            bestS += step;
        }
    }

    // The viewer-preference bias is part of the score itself (zeroPlaneBiasPx),
    // so the search optimum needs no post-hoc scaling. A multiplicative dxGain
    // would instead scale the absolute shift and make the final placement
    // depend on the input pair's arbitrary framing offset.
    return {
        method: 'disparity_comfort',
        dyCorrection,
        dxShift: bestS,
        dyInlierCount: dyInliers.length,
        dxSampleCount: dxArr.length,
        comfortScore: best.score,
        disparityStats: {
            min: dxArr[0],
            max: dxArr[dxArr.length - 1],
            p10,
            p50,
            p90,
            zeroPlaneEstimate: best.zeroPlane,
            zeroPlaneBiasPx: o.zeroPlaneBiasPx,
            targetZeroPercentile: o.targetZeroPercentile
        }
    };
}
