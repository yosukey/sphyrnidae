/**
 * ui-crop.js
 * Crop (rectangle selection) features
 */
import { showToast } from './ui-toast.js';
import { state, CONSTANTS, isCropSelectionAllowed } from '../globals.js';
import { updateUniforms, updateMeshTransform, updateCroppedResolution } from '../rendering/renderer.js';
import { ensureEven, adjustCropRatioForEven } from '../utils/pixel-utils.js';
import { isIdentityAlign, verticalCropFromSampling, composeManualCropWindow } from '../rendering/alignment-geometry.js';
import * as logger from '../utils/logger.js';

/**
 * Compare two alignTransform arrays (9-element mat3) for equality within eps.
 * Used so the crop "already cropped?" gate notices a re-run that changed only
 * the geometric matrix while shiftX/shiftY stayed the same.
 */
function alignEquals(a, b, eps = 1e-9) {
    if (a === b) return true;
    if (!Array.isArray(a) || !Array.isArray(b) || a.length < 9 || b.length < 9) return false;
    for (let i = 0; i < 9; i++) {
        if (Math.abs(a[i] - b[i]) > eps) return false;
    }
    return true;
}

// Cached canvas container element (avoid repeated getElementById in hot paths)
let cachedCanvasContainer = null;
function getCanvasContainer() {
    if (!cachedCanvasContainer || !cachedCanvasContainer.isConnected) {
        cachedCanvasContainer = document.getElementById('canvas-container');
    }
    return cachedCanvasContainer;
}

// Flag to prevent duplicate event listener registration
let cropSelectionInitialized = false;

// Crop selection event listener reference (prevent memory leaks)
let cropSelectionListeners = {
    windowMouseMove: null,
    windowTouchMove: null,
    windowMouseUp: null,
    windowTouchEnd: null,
    windowMouseMovePan: null
};

// AbortController for window event listeners (enhanced cleanup)
let windowEventAbortController = null;

// Local crop selection state (shared across event handlers)
let cropSelectionState = {
    isSelecting: false,
    isPanning: false,
    selectionStart: null,
    panStart: { x: 0, y: 0 }
};

// Cached DOM element references (initialized in setupCropSelection)
let cropDomRefs = {
    overlay: null,
    rect: null,
    infoDiv: null,
    actionsDiv: null,
    canvas: null,
    toggleBtn: null,
    applyBtn: null,
    clearBtn: null,
    modeRadios: null,
    aspectRatioSettings: null,
    fixedSizeSettings: null,
    cropAspectWidth: null,
    cropAspectHeight: null,
    cropFixedWidth: null,
    cropFixedHeight: null,
};

// Callback function (set from ui.js)
let callbacks = {
    updateZoomDisplay: null,
    updateExportResolution: null,
    updateHistogramPanelIfVisible: null
};

/**
 * Set callback function
 */
export function setCropCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

/**
 * Clean up crop selection event listeners (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guards and try-catch)
 */
export function cleanupCropSelectionListeners() {
    // Use AbortController for guaranteed cleanup
    if (windowEventAbortController) {
        try {
            windowEventAbortController.abort();
        } catch (err) {
            // AbortController.abort() should never throw, but protect against edge cases
            logger.warn('UICrop', 'Error aborting event controller:', err);
        }
        windowEventAbortController = null;
    }

    // Fallback: Remove listeners manually to ensure complete cleanup
    // This handles cases where AbortController may not have been used or failed
    if (cropSelectionListeners.windowMouseMove) {
        try {
            window.removeEventListener('mousemove', cropSelectionListeners.windowMouseMove);
        } catch (err) {
            logger.warn('UICrop', 'Error removing mousemove listener:', err);
        }
        cropSelectionListeners.windowMouseMove = null;
    }
    if (cropSelectionListeners.windowTouchMove) {
        try {
            window.removeEventListener('touchmove', cropSelectionListeners.windowTouchMove);
        } catch (err) {
            logger.warn('UICrop', 'Error removing touchmove listener:', err);
        }
        cropSelectionListeners.windowTouchMove = null;
    }
    if (cropSelectionListeners.windowMouseUp) {
        try {
            window.removeEventListener('mouseup', cropSelectionListeners.windowMouseUp);
        } catch (err) {
            logger.warn('UICrop', 'Error removing mouseup listener:', err);
        }
        cropSelectionListeners.windowMouseUp = null;
    }
    if (cropSelectionListeners.windowTouchEnd) {
        try {
            window.removeEventListener('touchend', cropSelectionListeners.windowTouchEnd);
        } catch (err) {
            logger.warn('UICrop', 'Error removing touchend listener:', err);
        }
        cropSelectionListeners.windowTouchEnd = null;
    }
    if (cropSelectionListeners.windowMouseMovePan) {
        try {
            window.removeEventListener('mousemove', cropSelectionListeners.windowMouseMovePan);
        } catch (err) {
            logger.warn('UICrop', 'Error removing mousemove pan listener:', err);
        }
        cropSelectionListeners.windowMouseMovePan = null;
    }

    // This ensures cleanup is truly complete and allows re-initialization if needed
    cropSelectionInitialized = false;
}

/**
 * Reset only the internal crop selection state
 * Called by an event from loader.js when a new image is loaded
 */
export function resetCropSelectionInternalState() {
    // NOTE: Do NOT call cleanupCropSelectionListeners() here. The drag/pan
    // listeners are resident (registered once in setupCropSelection and self-gated
    // on state.cropSelectionMode). setupCropSelection() runs only once at startup,
    // so aborting the listeners here would permanently disable rectangle selection
    // until a full page reload. Listener teardown belongs to cleanupUI() only.
    cropSelectionState.isSelecting = false;
    cropSelectionState.isPanning = false;
    cropSelectionState.selectionStart = null;
    cropSelectionState.panStart = { x: 0, y: 0 };
}

/**
 * Update crop button enabled state and tooltip
 */
export function updateCropButtonState() {
    const btn = document.getElementById('manualCropBtn');
    const resetAllBtn = document.getElementById('resetAllCropBtn');

    const shiftX = Math.abs(state.params.shiftX);
    const shiftY = Math.abs(state.params.shiftY);

    // A non-identity alignTransform (adopted geometric refinement) is alignment
    // too, even when shiftY is 0 because the vertical correction lives in the
    // matrix. Treat it as "alignment present" so the crop button is offered.
    const hasGeometry = !isIdentityAlign(state.params.alignTransform);

    // Conditions where crop is not needed
    const noAlignment = (shiftX === 0 && shiftY === 0 && !hasGeometry);
    const alreadyCropped = (
        state.lastCroppedShiftX !== null &&
        state.lastCroppedShiftY !== null &&
        Math.abs(state.lastCroppedShiftX - state.params.shiftX) < 0.00001 &&
        Math.abs(state.lastCroppedShiftY - state.params.shiftY) < 0.00001 &&
        alignEquals(state.lastCroppedAlign, state.params.alignTransform)
    );
    const hasCrop = state.params.cropX > 0 || state.params.cropY > 0;

    if (btn) {
        if (noAlignment) {
            btn.disabled = true;
            btn.title = window.t?.('tooltips.cropBeforeAlign') ?? 'Crop before align';
            btn.style.opacity = "0.5";
            btn.style.cursor = "not-allowed";
        } else if (alreadyCropped) {
            btn.disabled = true;
            btn.title = window.t?.('tooltips.alreadyCropped') ?? 'Already cropped';
            btn.style.opacity = "0.5";
            btn.style.cursor = "not-allowed";
        } else {
            btn.disabled = false;
            btn.title = window.t?.('tooltips.readyToCrop') ?? 'Ready to crop';
            btn.style.opacity = "1";
            btn.style.cursor = "pointer";
        }
    }

    if (resetAllBtn) {
        if (hasCrop) {
            resetAllBtn.disabled = false;
            resetAllBtn.title = window.t?.('tooltips.removeAllCrop') ?? 'Remove all crop';
            resetAllBtn.style.opacity = "1";
            resetAllBtn.style.cursor = "pointer";
        } else {
            resetAllBtn.disabled = true;
            resetAllBtn.title = window.t?.('tooltips.noCropApplied') ?? 'No crop applied';
            resetAllBtn.style.opacity = "0.5";
            resetAllBtn.style.cursor = "not-allowed";
        }
    }
}


export function reset3DTVVirtualWindow() {
    state.params.tvCropX = 0.0;
    state.params.tvCropY = 0.0;
    state.params.tvOffsetX = 0.0;
    state.params.tvOffsetY = 0.0;
}

/**
 * Manual crop (auto crop)
 * Adjust so the cropped size is an even number of pixels
 */
export function applyManualCrop() {
    const shiftX = Math.abs(state.params.shiftX);

    // Vertical crop must account for BOTH the shiftY uniform and an adopted
    // geometric-refinement matrix (which carries the vertical correction with
    // shiftY=0). verticalCropFromSampling derives the exact trim window from the
    // shader's crop+sampling math and reduces to (|shiftY|, shiftY) for identity.
    const vCrop = verticalCropFromSampling(state.params.alignTransform, state.params.shiftY);

    // Validate input values to prevent invalid crop
    if (!Number.isFinite(shiftX) || !Number.isFinite(vCrop.cropY) || !Number.isFinite(vCrop.offsetY)) {
        logger.error('UICrop', 'Invalid shift/crop values:', { shiftX, vCrop });
        return;
    }

    // Compose the alignment trim with the CURRENT crop window (intersection)
    // instead of replacing it, so a rectangle-selection crop applied beforehand
    // is preserved — Auto Crop only trims the alignment black bands that still
    // overlap the visible window. The 1.001 safety margin is applied to the
    // alignment trim amounts BEFORE snapping to an even cropped size (applying it
    // after the snap pushed the result back off the even boundary).
    const composed = composeManualCropWindow(state.params, state.params.shiftX, vCrop, 1.001);
    if (!composed) {
        showToast(window.t?.('messages.cropTooLarge') ?? 'Crop area is too large', 'warning');
        return;
    }

    let marginedCropX = composed.cropX;
    let marginedCropY = composed.cropY;

    // Ensure even pixels: adjust crop ratio
    if (state.material && state.material.uniforms.map.value) {
        const texture = state.material.uniforms.map.value;
        const eyeWidth = Math.floor(texture.image.width / 2);
        const eyeHeight = texture.image.height;

        // Validate image dimensions
        if (eyeWidth <= 0 || eyeHeight <= 0 || !Number.isFinite(eyeWidth) || !Number.isFinite(eyeHeight)) {
            logger.error('UICrop', 'Invalid image dimensions:', { eyeWidth, eyeHeight });
            return;
        }

        // Reject when the remaining window is too small to hold an even-pixel
        // crop (ensureEven would otherwise force a 2px minimum that re-exposes
        // the alignment bands).
        if (Math.floor(eyeWidth * (1 - marginedCropX)) < 2 || Math.floor(eyeHeight * (1 - marginedCropY)) < 2) {
            showToast(window.t?.('messages.cropTooLarge') ?? 'Crop area is too large', 'warning');
            return;
        }

        // Adjust crop ratio so cropped size is even. ensureEven only floors, so
        // the window can only shrink — the composed offset (window center) stays
        // valid (|offset| <= crop is preserved as crop grows).
        marginedCropX = adjustCropRatioForEven(marginedCropX, eyeWidth);
        marginedCropY = adjustCropRatioForEven(marginedCropY, eyeHeight);
    }

    // Additional validation: ensure crop values are within valid range [0, 1)
    if (!Number.isFinite(marginedCropX) || !Number.isFinite(marginedCropY) ||
        marginedCropX < 0 || marginedCropX >= 1 || marginedCropY < 0 || marginedCropY >= 1) {
        logger.error('UICrop', 'Invalid crop values:', { marginedCropX, marginedCropY });
        return;
    }

    state.params.offsetX = composed.offsetX;
    state.params.offsetY = composed.offsetY;

    state.params.cropX = marginedCropX;
    state.params.cropY = marginedCropY;

    state.lastCroppedShiftX = state.params.shiftX;
    state.lastCroppedShiftY = state.params.shiftY;
    // Snapshot the matrix too, so re-running geometric refinement to a different
    // matrix (with unchanged shiftX/shiftY) re-enables the crop button.
    state.lastCroppedAlign = Array.isArray(state.params.alignTransform)
        ? state.params.alignTransform.slice()
        : null;

    updateUniforms();
    updateMeshTransform();

    if (state.material && state.material.uniforms.map.value) {
        const texture = state.material.uniforms.map.value;
        const imageWidth = texture.image.width;
        const imageHeight = texture.image.height;
        const eyeWidth = Math.floor(imageWidth / 2);
        const eyeHeight = imageHeight;
        updateCroppedResolution(eyeWidth, eyeHeight);
        if (callbacks.updateZoomDisplay) callbacks.updateZoomDisplay();
        if (callbacks.updateExportResolution) callbacks.updateExportResolution();
    }

    updateCropButtonState();
    if (callbacks.updateHistogramPanelIfVisible) callbacks.updateHistogramPanelIfVisible();
}

/**
 * Convert screen coordinates to UV coordinates
 */
function screenToUV(screenX, screenY, screenWidth, screenHeight) {
    if (!state.material || !state.material.uniforms.map.value || !state.mesh) {
        logger.warn('UICrop', 'screenToUV: Missing required objects');
        return null;
    }

    const canvas = state.renderer.domElement;
    const canvasRect = canvas.getBoundingClientRect();

    // Guard against zero-dimension canvas (element hidden or not yet rendered)
    if (!canvasRect.width || !canvasRect.height) {
        logger.warn('UICrop', 'screenToUV: canvas has zero dimensions');
        return null;
    }

    // Step 1: Screen coordinates → canvas-relative coordinates
    const canvasX = screenX - canvasRect.left;
    const canvasY = screenY - canvasRect.top;

    // Step 2: Canvas coordinates → NDC coordinates (-1 to 1)
    const ndcX1 = (canvasX / canvasRect.width) * 2 - 1;
    const ndcY1 = -(canvasY / canvasRect.height) * 2 + 1;
    const ndcX2 = ((canvasX + screenWidth) / canvasRect.width) * 2 - 1;
    const ndcY2 = -((canvasY + screenHeight) / canvasRect.height) * 2 + 1;

    // Step 3: NDC coordinates → world coordinates
    const frustumHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
    const aspect = canvasRect.width / canvasRect.height;
    const frustumWidth = frustumHeight * aspect;

    const worldX1 = ndcX1 * (frustumWidth / 2);
    const worldY1 = ndcY1 * (frustumHeight / 2);
    const worldX2 = ndcX2 * (frustumWidth / 2);
    const worldY2 = ndcY2 * (frustumHeight / 2);

    // Step 4: World coordinates → mesh local coordinates
    const geomParams = state.mesh.geometry.parameters;
    if (!geomParams) {
        logger.warn('UICrop', 'geometry.parameters is null (non-parametric geometry)');
        return null;
    }
    const geomW = geomParams.width;
    const geomH = geomParams.height;
    const baseScaleX = state.mesh.userData.baseScaleX || 1.0;
    const baseScaleY = state.mesh.userData.baseScaleY || 1.0;

    const cropRatioX = 1.0 - state.params.cropX;
    const cropRatioY = 1.0 - state.params.cropY;
    const meshWorldWidth = geomW * baseScaleX * state.params.scale * cropRatioX;
    const meshWorldHeight = geomH * baseScaleY * state.params.scale * cropRatioY;

    logger.debug('CROP_LOG', 'UICrop', 'screenToUV debug:', {
        screenInput: { x: screenX, y: screenY, w: screenWidth, h: screenHeight },
        cropParams: { cropX: state.params.cropX, cropY: state.params.cropY,
                     offsetX: state.params.offsetX, offsetY: state.params.offsetY },
        meshScale: { current: state.mesh.scale.toArray(),
                    calculated: { w: meshWorldWidth, h: meshWorldHeight } }
    });

    const meshCenterX = state.params.panX;
    const meshCenterY = state.params.panY;
    const meshLeft = meshCenterX - meshWorldWidth / 2;
    const meshBottom = meshCenterY - meshWorldHeight / 2;

    const meshRelX1 = worldX1 - meshLeft;
    const meshRelY1 = worldY1 - meshBottom;
    const meshRelX2 = worldX2 - meshLeft;
    const meshRelY2 = worldY2 - meshBottom;

    // Step 5: Mesh local coordinates → displayUv (0-1)
    const displayUvX1 = meshRelX1 / meshWorldWidth;
    const displayUvY1 = meshRelY1 / meshWorldHeight;
    const displayUvX2 = meshRelX2 / meshWorldWidth;
    const displayUvY2 = meshRelY2 / meshWorldHeight;

    const clampedDisplayX1 = Math.max(0, Math.min(1, Math.min(displayUvX1, displayUvX2)));
    const clampedDisplayY1 = Math.max(0, Math.min(1, Math.min(displayUvY1, displayUvY2)));
    const clampedDisplayX2 = Math.max(0, Math.min(1, Math.max(displayUvX1, displayUvX2)));
    const clampedDisplayY2 = Math.max(0, Math.min(1, Math.max(displayUvY1, displayUvY2)));

    // Step 6: displayUv → original image UV coordinates
    const offsetXInUv = state.params.offsetX * 0.5;
    const offsetYInUv = state.params.offsetY * 0.5;

    const originalUvX1 = clampedDisplayX1 * cropRatioX + state.params.cropX / 2 + offsetXInUv;
    const originalUvX2 = clampedDisplayX2 * cropRatioX + state.params.cropX / 2 + offsetXInUv;
    const originalUvY1 = clampedDisplayY1 * cropRatioY + state.params.cropY / 2 + offsetYInUv;
    const originalUvY2 = clampedDisplayY2 * cropRatioY + state.params.cropY / 2 + offsetYInUv;

    const finalX1 = Math.max(0, Math.min(1, Math.min(originalUvX1, originalUvX2)));
    const finalY1 = Math.max(0, Math.min(1, Math.min(originalUvY1, originalUvY2)));
    const finalX2 = Math.max(0, Math.min(1, Math.max(originalUvX1, originalUvX2)));
    const finalY2 = Math.max(0, Math.min(1, Math.max(originalUvY1, originalUvY2)));

    const uvWidth = finalX2 - finalX1;
    const uvHeight = finalY2 - finalY1;

    logger.debug('CROP_LOG', 'UICrop', 'screenToUV result:', {
        finalUV: { x1: finalX1, y1: finalY1, x2: finalX2, y2: finalY2 },
        uvSize: { width: uvWidth, height: uvHeight },
        valid: uvWidth >= 0.01 && uvHeight >= 0.01
    });

    // Reject only genuinely degenerate selections (e.g. an accidental click with no
    // drag). finalX/finalY are full-source-image UV, so convert to source pixels and
    // use a fixed pixel floor. The old 1%-of-image UV threshold scaled with image
    // size and wrongly rejected legitimate small crops on large images (a 100px crop
    // on a 12000px-wide pano is ~0.008 UV < 0.01).
    const MIN_SELECTION_PX = 8;
    const img = state.material.uniforms.map.value.image;
    if (img && img.width > 0 && img.height > 0) {
        const eyeWidth = Math.max(1, Math.floor(img.width / 2));
        const eyeHeight = Math.max(1, img.height);
        if (uvWidth * eyeWidth < MIN_SELECTION_PX || uvHeight * eyeHeight < MIN_SELECTION_PX) {
            logger.warn('UICrop', 'screenToUV: Selection too small, rejected');
            return null;
        }
    } else if (uvWidth < 0.01 || uvHeight < 0.01) {
        // Image dimensions unavailable: fall back to the normalized floor.
        logger.warn('UICrop', 'screenToUV: Selection too small, rejected');
        return null;
    }

    return {
        x: finalX1,
        y: finalY1,
        width: uvWidth,
        height: uvHeight
    };
}

/**
 * Compute the applied (even-snapped) single-eye pixel size for a UV selection.
 * Mirrors the rounding + fixedSize snap used by applyCropSelection() so the live
 * readout never reports a size that differs from what Apply actually produces.
 * @param {{width:number,height:number}} selection - UV-space selection
 * @param {number} eyeWidth - Single-eye width in pixels
 * @param {number} eyeHeight - Single-eye height in pixels
 * @returns {{width:number,height:number}} Even pixel dimensions
 */
function computeAppliedSelectionSize(selection, eyeWidth, eyeHeight) {
    let widthPx;
    let heightPx;
    // In fixedSize mode Apply snaps straight to the requested pixel dimensions
    // (clamped to the eye); otherwise it rounds the UV size to the nearest pixel.
    if (state.cropRectMode === 'fixedSize' && state.cropFixedWidth && state.cropFixedHeight) {
        widthPx = Math.min(state.cropFixedWidth, eyeWidth);
        heightPx = Math.min(state.cropFixedHeight, eyeHeight);
    } else {
        widthPx = Math.round(selection.width * eyeWidth);
        heightPx = Math.round(selection.height * eyeHeight);
    }
    return {
        width: ensureEven(widthPx),
        height: ensureEven(heightPx)
    };
}

/**
 * Show selection info
 */
function updateSelectionInfo(screenX, screenY, screenWidth, screenHeight) {
    const coordsEl = document.getElementById('cropSelectionCoords');
    const sizeEl = document.getElementById('cropSelectionSize');

    if (!coordsEl || !sizeEl) {
        return;
    }

    if (!state.material || !state.material.uniforms.map.value) {
        return;
    }

    const selection = screenToUV(screenX, screenY, screenWidth, screenHeight);
    if (!selection) {
        coordsEl.textContent = '-';
        sizeEl.textContent = '-';
        return;
    }

    const texture = state.material.uniforms.map.value;
    const imgWidth = texture.image.width;
    const imgHeight = texture.image.height;
    // Use floor to match applyCropSelection()/createStereoMesh(), which derive the
    // single-eye width as floor(width/2). Otherwise odd-width SBS input would make
    // the displayed pixel size disagree with the size actually applied on Apply.
    const eyeWidth = Math.floor(imgWidth / 2);
    const eyeHeight = imgHeight;

    const pixelX = Math.round(selection.x * eyeWidth);
    // selection.y is in the texture's flipY UV space (bottom-left origin), so the
    // raw value measures from the image BOTTOM. Convert to the top-left origin that
    // every image editor uses, so a strip at the visual top reads a small Y instead
    // of ~height. (selection.y is the bottom edge; +height gives the top edge.)
    const pixelY = Math.round(eyeHeight - (selection.y + selection.height) * eyeHeight);
    // Use the exact same rounding + fixedSize snap as applyCropSelection() so the
    // overlay never reports a size that differs from what Apply actually produces.
    const { width: pixelWidth, height: pixelHeight } = computeAppliedSelectionSize(selection, eyeWidth, eyeHeight);

    coordsEl.textContent = `(${pixelX}, ${pixelY})`;
    sizeEl.textContent = `${pixelWidth} × ${pixelHeight}px`;
}

/**
 * Apply rectangle selection and crop
 * Adjust so the cropped size is an even number of pixels
 */
function applyCropSelection() {
    if (!state.cropSelection) return;

    const mode = state.params.mode;
    if (!isCropSelectionAllowed(mode)) {
        showToast(window.t?.('messages.rectangularWarning') ?? 'Rectangular crop is not allowed in this mode', 'warning');
        return;
    }

    let selection = { ...state.cropSelection };

    // Ensure even pixels: adjust selection size
    if (state.material && state.material.uniforms.map.value) {
        const texture = state.material.uniforms.map.value;
        const eyeWidth = Math.floor(texture.image.width / 2);
        const eyeHeight = texture.image.height;

        // Calculate pixel size of the selection.
        // In fixedSize mode, snap straight to the requested pixel dimensions
        // (clamped to the eye) instead of round-tripping through the lossy
        // pixel->screen->CSS->UV chain, which lands at requested +/- epsilon and,
        // with Math.floor + ensureEven, silently delivered a size up to 2px short.
        // Otherwise round (not floor) to the nearest pixel before the even-snap.
        // Shared with the live readout via computeAppliedSelectionSize() so both agree.
        const { width: selectionWidthPx, height: selectionHeightPx } =
            computeAppliedSelectionSize(selection, eyeWidth, eyeHeight);

        // Convert back to UV coordinates
        selection.width = selectionWidthPx / eyeWidth;
        selection.height = selectionHeightPx / eyeHeight;

        // Keep the crop window inside the original image. In fixedSize mode the
        // size above is forced to the requested pixels independent of the marquee,
        // so a fixed size larger than the currently-visible (already-cropped)
        // region — or a marquee dragged to the edge — could push
        // selection.x/y so that selection.x + selection.width exceeds 1.0, making
        // the shader sample outside [0,1] (clamped-edge / black band). Clamp the
        // size to the image and slide the window back in-bounds.
        selection.width = Math.min(selection.width, 1.0);
        selection.height = Math.min(selection.height, 1.0);
        selection.x = Math.max(0, Math.min(selection.x, 1.0 - selection.width));
        selection.y = Math.max(0, Math.min(selection.y, 1.0 - selection.height));
    }

    state.params.cropX = 1.0 - selection.width;
    state.params.cropY = 1.0 - selection.height;

    const offsetXInUv = selection.x - state.params.cropX / 2;
    const offsetYInUv = selection.y - state.params.cropY / 2;

    state.params.offsetX = offsetXInUv * 2.0;
    state.params.offsetY = offsetYInUv * 2.0;

    // A rectangle crop replaces any alignment-based (Manual Crop) trim, so clear
    // the manual-crop snapshot. Otherwise updateCropButtonState() still reports
    // "Already cropped" (the snapshot matches the unchanged shift/matrix) and the
    // Manual Crop button stays disabled even though its trim was just overwritten.
    state.lastCroppedShiftX = null;
    state.lastCroppedShiftY = null;
    state.lastCroppedAlign = null;

    updateUniforms();
    updateMeshTransform();

    if (state.material && state.material.uniforms.map.value) {
        const texture = state.material.uniforms.map.value;
        const imageWidth = texture.image.width;
        const imageHeight = texture.image.height;
        const eyeWidth = Math.floor(imageWidth / 2);
        const eyeHeight = imageHeight;
        updateCroppedResolution(eyeWidth, eyeHeight);
        if (callbacks.updateZoomDisplay) callbacks.updateZoomDisplay();
        if (callbacks.updateExportResolution) callbacks.updateExportResolution();
    }

    clearCropSelection();
    exitCropSelectionMode();
    updateCropButtonState();
    if (callbacks.updateHistogramPanelIfVisible) callbacks.updateHistogramPanelIfVisible();
}

/**
 * Fully reset rectangle selection state
 */
export function resetCropSelection() {
    state.cropSelection = null;
    state.cropSelectionMode = false;

    // NOTE: Do NOT call cleanupCropSelectionListeners() here. These listeners are
    // resident and self-gate on state.cropSelectionMode; they are only re-registered
    // by setupCropSelection() which runs once at startup. Destroying them here would
    // permanently break rectangle selection (drag stops producing a marquee) until a
    // page reload. Full listener teardown is handled by cleanupUI().
    cropSelectionState.isSelecting = false;
    cropSelectionState.isPanning = false;
    cropSelectionState.selectionStart = null;
    cropSelectionState.panStart = { x: 0, y: 0 };

    const overlay = document.getElementById('crop-selection-overlay');
    const rect = document.getElementById('crop-selection-rect');
    const infoDiv = document.getElementById('cropSelectionInfo');
    const actionsDiv = document.getElementById('cropSelectionActions');
    const toggleBtn = document.getElementById('toggleCropSelectionBtn');
    const canvasContainer = getCanvasContainer();

    if (overlay) overlay.style.display = 'none';
    if (rect) {
        rect.style.width = '0';
        rect.style.height = '0';
    }
    if (infoDiv) infoDiv.style.display = 'none';
    if (actionsDiv) actionsDiv.style.display = 'none';

    if (toggleBtn) {
        toggleBtn.classList.remove('active');
        toggleBtn.textContent = window.t?.('controls.rectangularMode') || 'Rectangular selection';
    }

    if (canvasContainer) canvasContainer.style.cursor = 'default';

    if (state.renderer?.domElement) {
        state.renderer.domElement.style.cursor = 'default';
    }

    const modeRadios = document.querySelectorAll('input[name="cropRectMode"]');
    const cropAspectWidth = document.getElementById('cropAspectWidth');
    const cropAspectHeight = document.getElementById('cropAspectHeight');
    const cropFixedWidth = document.getElementById('cropFixedWidth');
    const cropFixedHeight = document.getElementById('cropFixedHeight');

    modeRadios.forEach(radio => {
        radio.disabled = false;
        const label = radio.closest('label');
        if (label) {
            label.style.opacity = '1';
            label.style.cursor = 'pointer';
        }
    });
    if (cropAspectWidth) cropAspectWidth.disabled = false;
    if (cropAspectHeight) cropAspectHeight.disabled = false;
    if (cropFixedWidth) cropFixedWidth.disabled = false;
    if (cropFixedHeight) cropFixedHeight.disabled = false;
}

/**
 * Clear rectangle selection (clear state only; keep event listeners)
 */
function clearCropSelection() {
    state.cropSelection = null;

    const overlay = document.getElementById('crop-selection-overlay');
    const rect = document.getElementById('crop-selection-rect');
    const infoDiv = document.getElementById('cropSelectionInfo');
    const actionsDiv = document.getElementById('cropSelectionActions');

    if (overlay) overlay.style.display = 'none';
    if (rect) {
        rect.style.width = '0';
        rect.style.height = '0';
    }
    if (infoDiv) infoDiv.style.display = 'none';
    if (actionsDiv) actionsDiv.style.display = 'none';

    cropSelectionState.isSelecting = false;
    cropSelectionState.selectionStart = null;
}

/**
 * Exit crop selection mode programmatically
 */
function exitCropSelectionMode() {
    if (!state.cropSelectionMode) return;

    state.cropSelectionMode = false;

    // This ensures state consistency between UI and internal variables
    cropSelectionState.isSelecting = false;
    cropSelectionState.isPanning = false;
    cropSelectionState.selectionStart = null;
    cropSelectionState.panStart = { x: 0, y: 0 };

    const toggleBtn = document.getElementById('toggleCropSelectionBtn');
    const overlay = document.getElementById('crop-selection-overlay');
    const rect = document.getElementById('crop-selection-rect');
    const infoDiv = document.getElementById('cropSelectionInfo');
    const actionsDiv = document.getElementById('cropSelectionActions');

    // Update UI
    if (toggleBtn) {
        toggleBtn.classList.remove('active');
        toggleBtn.textContent = window.t?.('controls.rectangularMode') || 'Rectangular selection';
    }

    // Reset cursor
    const canvas = state.renderer?.domElement;
    if (canvas) {
        canvas.style.cursor = 'default';
    }

    // Hide overlays and reset rect
    if (overlay) overlay.style.display = 'none';
    if (rect) {
        rect.style.width = '0';
        rect.style.height = '0';
    }
    if (infoDiv) infoDiv.style.display = 'none';
    if (actionsDiv) actionsDiv.style.display = 'none';

    // Re-enable mode controls
    const modeRadios = document.querySelectorAll('input[name="cropRectMode"]');
    modeRadios.forEach(radio => {
        radio.disabled = false;
        const label = radio.closest('label');
        if (label) {
            label.style.opacity = '1';
            label.style.cursor = 'pointer';
        }
    });

    const cropAspectWidth = document.getElementById('cropAspectWidth');
    const cropAspectHeight = document.getElementById('cropAspectHeight');
    const cropFixedWidth = document.getElementById('cropFixedWidth');
    const cropFixedHeight = document.getElementById('cropFixedHeight');

    if (cropAspectWidth) cropAspectWidth.disabled = false;
    if (cropAspectHeight) cropAspectHeight.disabled = false;
    if (cropFixedWidth) cropFixedWidth.disabled = false;
    if (cropFixedHeight) cropFixedHeight.disabled = false;
}


// ============================================================
// Crop selection helper functions
// ============================================================

/**
 * Initialize cached DOM element references
 */
function initCropDomRefs() {
    cropDomRefs.overlay = document.getElementById('crop-selection-overlay');
    cropDomRefs.rect = document.getElementById('crop-selection-rect');
    cropDomRefs.infoDiv = document.getElementById('cropSelectionInfo');
    cropDomRefs.actionsDiv = document.getElementById('cropSelectionActions');
    cropDomRefs.canvas = state.renderer?.domElement;
    cropDomRefs.toggleBtn = document.getElementById('toggleCropSelectionBtn');
    cropDomRefs.applyBtn = document.getElementById('applyCropSelectionBtn');
    cropDomRefs.clearBtn = document.getElementById('clearCropSelectionBtn');
    cropDomRefs.modeRadios = document.querySelectorAll('input[name="cropRectMode"]');
    cropDomRefs.aspectRatioSettings = document.getElementById('aspectRatioSettings');
    cropDomRefs.fixedSizeSettings = document.getElementById('fixedSizeSettings');
    cropDomRefs.cropAspectWidth = document.getElementById('cropAspectWidth');
    cropDomRefs.cropAspectHeight = document.getElementById('cropAspectHeight');
    cropDomRefs.cropFixedWidth = document.getElementById('cropFixedWidth');
    cropDomRefs.cropFixedHeight = document.getElementById('cropFixedHeight');
}

/**
 * Get image display bounds in screen coordinates
 */
function getImageBounds(clamp = true) {
    if (!state.mesh || !state.renderer) return null;

    const canvas = state.renderer.domElement;
    const canvasRect = canvas.getBoundingClientRect();
    const frustumHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
    const aspect = canvasRect.width / canvasRect.height;
    const frustumWidth = frustumHeight * aspect;

    const geomParams = state.mesh.geometry.parameters;
    if (!geomParams) {
        logger.warn('UICrop', 'getImageBounds: geometry.parameters is null (non-parametric geometry)');
        return null;
    }
    const geomW = geomParams.width;
    const geomH = geomParams.height;
    const baseScaleX = state.mesh.userData.baseScaleX || 1.0;
    const baseScaleY = state.mesh.userData.baseScaleY || 1.0;

    const cropRatioX = 1.0 - state.params.cropX;
    const cropRatioY = 1.0 - state.params.cropY;
    const meshWorldWidth = geomW * baseScaleX * state.params.scale * cropRatioX;
    const meshWorldHeight = geomH * baseScaleY * state.params.scale * cropRatioY;

    logger.debug('CROP_LOG', 'UICrop', 'getImageBounds calculation:', {
        cropParams: { cropX: state.params.cropX, cropY: state.params.cropY },
        meshWorld: { width: meshWorldWidth, height: meshWorldHeight },
        meshScale: state.mesh.scale.toArray()
    });

    const meshCenterX = state.params.panX;
    const meshCenterY = state.params.panY;

    const meshLeft = meshCenterX - meshWorldWidth / 2;
    const meshRight = meshCenterX + meshWorldWidth / 2;
    const meshBottom = meshCenterY - meshWorldHeight / 2;
    const meshTop = meshCenterY + meshWorldHeight / 2;

    const ndcLeft = meshLeft / (frustumWidth / 2);
    const ndcRight = meshRight / (frustumWidth / 2);
    const ndcBottom = meshBottom / (frustumHeight / 2);
    const ndcTop = meshTop / (frustumHeight / 2);

    const screenLeft = ((ndcLeft + 1) / 2) * canvasRect.width + canvasRect.left;
    const screenRight = ((ndcRight + 1) / 2) * canvasRect.width + canvasRect.left;
    const screenTop = ((1 - ndcTop) / 2) * canvasRect.height + canvasRect.top;
    const screenBottom = ((1 - ndcBottom) / 2) * canvasRect.height + canvasRect.top;

    // Unclamped (full on-screen extent of the image, including any part that
    // extends past the canvas via pan/zoom). Used for the pixel<->screen ratio so
    // a fixed-size crop maps to the correct number of image pixels regardless of
    // how much of the image is currently visible.
    if (!clamp) {
        return {
            left: screenLeft,
            right: screenRight,
            top: screenTop,
            bottom: screenBottom
        };
    }

    // Clamped to the canvas — used for marquee confinement / positioning.
    return {
        left: Math.max(canvasRect.left, screenLeft),
        right: Math.min(canvasRect.right, screenRight),
        top: Math.max(canvasRect.top, screenTop),
        bottom: Math.min(canvasRect.bottom, screenBottom)
    };
}

/**
 * Convert screen (client) coordinates to container-relative coordinates clamped to image bounds
 * @param {number} clientX - Screen X coordinate (e.g. event.clientX)
 * @param {number} clientY - Screen Y coordinate (e.g. event.clientY)
 * @returns {{ x: number, y: number, containerRect: DOMRect } | null}
 */
function screenToImageCoords(clientX, clientY) {
    const canvasContainerEl = getCanvasContainer();
    if (!canvasContainerEl) return null;
    const containerRect = canvasContainerEl.getBoundingClientRect();

    let x = clientX - containerRect.left;
    let y = clientY - containerRect.top;

    const imageBounds = getImageBounds();
    if (imageBounds) {
        const imageLeft = imageBounds.left - containerRect.left;
        const imageRight = imageBounds.right - containerRect.left;
        const imageTop = imageBounds.top - containerRect.top;
        const imageBottom = imageBounds.bottom - containerRect.top;

        x = Math.max(imageLeft, Math.min(imageRight, x));
        y = Math.max(imageTop, Math.min(imageBottom, y));
    }

    return { x, y, containerRect };
}

/**
 * Convert container-relative coordinates to screen (viewport) coordinates
 * @param {number} containerX - Container-relative X coordinate
 * @param {number} containerY - Container-relative Y coordinate
 * @param {DOMRect} [containerRect] - Optional pre-computed container rect (avoids DOM query)
 * @returns {{ x: number, y: number } | null}
 */
function imageToScreenCoords(containerX, containerY, containerRect) {
    if (!containerRect) {
        const canvasContainerEl = getCanvasContainer();
        if (!canvasContainerEl) return null;
        containerRect = canvasContainerEl.getBoundingClientRect();
    }
    return {
        x: containerX + containerRect.left,
        y: containerY + containerRect.top
    };
}

/**
 * Adjust selection to match aspect ratio/fixed size
 * @param {number} startX - Selection start X (container-relative)
 * @param {number} startY - Selection start Y (container-relative)
 * @param {number} currentX - Current pointer X (container-relative)
 * @param {number} currentY - Current pointer Y (container-relative)
 * @returns {{ x: number, y: number }} Adjusted end coordinates
 */
function adjustSelectionForAspectRatio(startX, startY, currentX, currentY) {
    const mode = state.cropRectMode;

    if (mode === 'free') {
        return { x: currentX, y: currentY };
    }

    // In fixedSize mode, convert fixed size (image pixels) to screen coordinates
    if (mode === 'fixedSize') {
        if (!state.material || !state.material.uniforms.map.value) {
            return { x: currentX, y: currentY };
        }

        const texture = state.material.uniforms.map.value;
        const imgWidth = texture.image.width;
        const imgHeight = texture.image.height;
        const eyeWidth = Math.floor(imgWidth / 2);
        const eyeHeight = imgHeight;

        // Calculate conversion ratio from image pixels to screen coordinates
        const imageBounds = getImageBounds();
        if (!imageBounds) {
            return { x: currentX, y: currentY };
        }

        const canvasContainerEl = getCanvasContainer();
        if (!canvasContainerEl) return { x: currentX, y: currentY };
        const containerRect = canvasContainerEl.getBoundingClientRect();
        // Use the UNCLAMPED image extent for the pixel<->screen ratio. When the
        // image is panned/zoomed partly off-canvas, the canvas-clamped bounds
        // understate its on-screen width/height, so a fixed-size crop derived from
        // them would map to fewer image pixels than the user requested.
        const fullBounds = getImageBounds(false) || imageBounds;
        const screenWidth = fullBounds.right - fullBounds.left;
        const screenHeight = fullBounds.bottom - fullBounds.top;
        // Map a source-pixel size onto the CURRENTLY DISPLAYED image. When a crop
        // is already applied, the visible mesh spans only eyeWidth*(1-cropX) source
        // pixels (getImageBounds folds cropRatioX into its extent), so dividing the
        // on-screen extent by the FULL eye size would draw a fixed-size marquee
        // (1-cropX)x too small. Divide by the cropped extent instead.
        const croppedEyeWidth = Math.max(1, eyeWidth * (1.0 - state.params.cropX));
        const croppedEyeHeight = Math.max(1, eyeHeight * (1.0 - state.params.cropY));
        const pixelToScreenX = screenWidth / croppedEyeWidth;
        const pixelToScreenY = screenHeight / croppedEyeHeight;

        // Convert fixed size to screen coordinates
        const fixedScreenWidth = state.cropFixedWidth * pixelToScreenX;
        const fixedScreenHeight = state.cropFixedHeight * pixelToScreenY;

        // Warn if fixed size exceeds image size
        if (state.cropFixedWidth > eyeWidth || state.cropFixedHeight > eyeHeight) {
            logger.warn('UICrop', `Fixed size (${state.cropFixedWidth}x${state.cropFixedHeight}) exceeds image size (${eyeWidth}x${eyeHeight})`);
        }

        // Determine drag direction
        const dx = currentX - startX;
        const dy = currentY - startY;

        // Calculate end coordinates for fixed size
        let endX = startX + (dx >= 0 ? fixedScreenWidth : -fixedScreenWidth);
        let endY = startY + (dy >= 0 ? fixedScreenHeight : -fixedScreenHeight);

        // Adjust to stay within image bounds
        const imageLeft = imageBounds.left - containerRect.left;
        const imageRight = imageBounds.right - containerRect.left;
        const imageTop = imageBounds.top - containerRect.top;
        const imageBottom = imageBounds.bottom - containerRect.top;

        // Calculate top-left and bottom-right of selection
        const selectionLeft = Math.min(startX, endX);
        const selectionRight = Math.max(startX, endX);
        const selectionTop = Math.min(startY, endY);
        const selectionBottom = Math.max(startY, endY);

        // Adjust start position if it exceeds image bounds
        if (selectionLeft < imageLeft) {
            const offset = imageLeft - selectionLeft;
            endX += offset;
        }
        if (selectionRight > imageRight) {
            const offset = selectionRight - imageRight;
            endX -= offset;
        }
        if (selectionTop < imageTop) {
            const offset = imageTop - selectionTop;
            endY += offset;
        }
        if (selectionBottom > imageBottom) {
            const offset = selectionBottom - imageBottom;
            endY -= offset;
        }

        return { x: endX, y: endY };
    }

    // Maintain aspect ratio in aspectRatio mode
    let aspectRatio;
    if (mode === 'aspectRatio') {
        // Guard against division by zero from invalid user input
        if (!(state.cropAspectHeight > 0) || !(state.cropAspectWidth > 0)) {
            return { x: currentX, y: currentY };
        }
        aspectRatio = state.cropAspectWidth / state.cropAspectHeight;
    } else {
        return { x: currentX, y: currentY };
    }

    const imageBounds = getImageBounds();
    if (!imageBounds) {
        return { x: currentX, y: currentY };
    }

    const canvasContainerEl = getCanvasContainer();
    if (!canvasContainerEl) return { x: currentX, y: currentY };
    const containerRect = canvasContainerEl.getBoundingClientRect();
    const imageLeft = imageBounds.left - containerRect.left;
    const imageRight = imageBounds.right - containerRect.left;
    const imageTop = imageBounds.top - containerRect.top;
    const imageBottom = imageBounds.bottom - containerRect.top;

    const dx = currentX - startX;
    const dy = currentY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    let newWidth, newHeight;
    if (absDx / aspectRatio > absDy) {
        newWidth = absDx;
        newHeight = absDx / aspectRatio;
    } else {
        newHeight = absDy;
        newWidth = absDy * aspectRatio;
    }

    let endX = startX + (dx >= 0 ? newWidth : -newWidth);
    let endY = startY + (dy >= 0 ? newHeight : -newHeight);

    // Calculate top-left and bottom-right of selection
    const selectionLeft = Math.min(startX, endX);
    const selectionRight = Math.max(startX, endX);
    const selectionTop = Math.min(startY, endY);
    const selectionBottom = Math.max(startY, endY);
    const selectionWidth = selectionRight - selectionLeft;
    const selectionHeight = selectionBottom - selectionTop;

    // If it exceeds image bounds, shrink while maintaining aspect ratio
    let scale = 1.0;

    if (selectionLeft < imageLeft) {
        const availableWidth = selectionRight - imageLeft;
        scale = Math.min(scale, availableWidth / selectionWidth);
    }
    if (selectionRight > imageRight) {
        const availableWidth = imageRight - selectionLeft;
        scale = Math.min(scale, availableWidth / selectionWidth);
    }
    if (selectionTop < imageTop) {
        const availableHeight = selectionBottom - imageTop;
        scale = Math.min(scale, availableHeight / selectionHeight);
    }
    if (selectionBottom > imageBottom) {
        const availableHeight = imageBottom - selectionTop;
        scale = Math.min(scale, availableHeight / selectionHeight);
    }

    // Apply scale
    if (scale < 1.0) {
        const scaledWidth = newWidth * scale;
        const scaledHeight = newHeight * scale;
        endX = startX + (dx >= 0 ? scaledWidth : -scaledWidth);
        endY = startY + (dy >= 0 ? scaledHeight : -scaledHeight);
    }

    return { x: endX, y: endY };
}


// ============================================================
// Event handlers (extracted from setupCropSelection)
// ============================================================

/**
 * Handle mouse down on canvas for crop selection
 */
function handleCropMouseDown(e) {
    if (!state.cropSelectionMode) return;
    if (e.button !== 0) return;

    // A crop selection is meaningless without a live image/mesh. Bail before setting
    // selectionStart or showing the overlay, so a mousedown during teardown (mesh or
    // material disposed while crop mode is still on) cannot leave an orphaned marquee
    // displaying the stale previous selection. screenToImageCoords still returns coords
    // when the mesh is gone (it just skips clamping), so it does not guard this alone.
    if (!state.material || !state.material.uniforms || !state.material.uniforms.map.value?.image || !state.mesh) {
        return;
    }

    const coords = screenToImageCoords(e.clientX, e.clientY);
    if (!coords) return;
    const { x: clickX, y: clickY, containerRect } = coords;

    cropSelectionState.selectionStart = { x: clickX, y: clickY };
    cropDomRefs.overlay.style.display = 'block';

    // In fixedSize mode, show fixed-size box immediately on click
    if (state.cropRectMode === 'fixedSize') {
        if (!state.material || !state.material.uniforms.map.value) {
            return;
        }

        const texture = state.material.uniforms.map.value;
        const imgWidth = texture.image.width;
        const imgHeight = texture.image.height;
        const eyeWidth = Math.floor(imgWidth / 2);
        const eyeHeight = imgHeight;

        // Calculate conversion ratio from image pixels to screen coordinates
        const imageBounds = getImageBounds();
        if (!imageBounds) {
            return;
        }

        // Use the UNCLAMPED image extent for the pixel<->screen ratio. When the
        // image is panned/zoomed partly off-canvas, the canvas-clamped bounds
        // understate its on-screen width/height, so a fixed-size crop derived from
        // them would map to fewer image pixels than the user requested.
        const fullBounds = getImageBounds(false) || imageBounds;
        const screenWidth = fullBounds.right - fullBounds.left;
        const screenHeight = fullBounds.bottom - fullBounds.top;
        // Map a source-pixel size onto the CURRENTLY DISPLAYED image. When a crop
        // is already applied, the visible mesh spans only eyeWidth*(1-cropX) source
        // pixels (getImageBounds folds cropRatioX into its extent), so dividing the
        // on-screen extent by the FULL eye size would draw a fixed-size marquee
        // (1-cropX)x too small. Divide by the cropped extent instead.
        const croppedEyeWidth = Math.max(1, eyeWidth * (1.0 - state.params.cropX));
        const croppedEyeHeight = Math.max(1, eyeHeight * (1.0 - state.params.cropY));
        const pixelToScreenX = screenWidth / croppedEyeWidth;
        const pixelToScreenY = screenHeight / croppedEyeHeight;

        // Convert fixed size to screen coordinates
        const fixedScreenWidth = state.cropFixedWidth * pixelToScreenX;
        const fixedScreenHeight = state.cropFixedHeight * pixelToScreenY;

        const imageLeft = imageBounds.left - containerRect.left;
        const imageRight = imageBounds.right - containerRect.left;
        const imageTop = imageBounds.top - containerRect.top;
        const imageBottom = imageBounds.bottom - containerRect.top;

        // Center the box on the click (adjust to fit within image bounds)
        let left = clickX - fixedScreenWidth / 2;
        let top = clickY - fixedScreenHeight / 2;

        // Bounds check
        if (left < imageLeft) left = imageLeft;
        if (left + fixedScreenWidth > imageRight) left = imageRight - fixedScreenWidth;
        if (top < imageTop) top = imageTop;
        if (top + fixedScreenHeight > imageBottom) top = imageBottom - fixedScreenHeight;

        // Warn and abort only if the requested fixed size genuinely exceeds the
        // image's (cropped) pixel dimensions. Comparing screen extents against the
        // canvas-clamped visible bounds wrongly rejected valid crops whenever zoom
        // pushed the image past the canvas edges (the clamped width understates it).
        if (state.cropFixedWidth > croppedEyeWidth || state.cropFixedHeight > croppedEyeHeight) {
            showToast(window.t?.('messages.fixedSizeTooLarge') ?? 'The fixed size is larger than the image size', 'warning');
            cropDomRefs.overlay.style.display = 'none';
            cropSelectionState.selectionStart = null;
            return;
        }

        cropDomRefs.rect.style.left = `${left}px`;
        cropDomRefs.rect.style.top = `${top}px`;
        cropDomRefs.rect.style.width = `${fixedScreenWidth}px`;
        cropDomRefs.rect.style.height = `${fixedScreenHeight}px`;

        const viewport = imageToScreenCoords(left, top, containerRect);
        if (viewport) {
            updateSelectionInfo(viewport.x, viewport.y, fixedScreenWidth, fixedScreenHeight);
        }
        cropDomRefs.infoDiv.style.display = 'block';

        // In fixedSize mode, set isSelecting to false to disable drag
        cropSelectionState.isSelecting = false;
    } else {
        // In normal mode (free, aspectRatio), start drag as before
        cropSelectionState.isSelecting = true;
        cropDomRefs.rect.style.left = `${clickX}px`;
        cropDomRefs.rect.style.top = `${clickY}px`;
        cropDomRefs.rect.style.width = '0';
        cropDomRefs.rect.style.height = '0';
        cropDomRefs.infoDiv.style.display = 'none';
        cropDomRefs.actionsDiv.style.display = 'none';
    }

    e.preventDefault();
}

/**
 * Handle mouse move during crop selection drag
 */
function handleCropMouseMove(e) {
    if (!cropSelectionState.isSelecting || !cropSelectionState.selectionStart) return;

    // Self-heal a stuck selection: if we are still "selecting" but no mouse button is
    // held, the mouseup that ends the drag was lost (released outside the window).
    // Reset the drag state so the marquee stops following the cursor with no button
    // down; the next mousedown starts a fresh selection. Mirrors the pan handler's
    // e.buttons === 0 guard in ui-input.js.
    if (e.buttons === 0) {
        cropSelectionState.isSelecting = false;
        cropSelectionState.selectionStart = null;
        return;
    }

    const canvasContainerEl = getCanvasContainer();
    if (!canvasContainerEl) return;
    const containerRect = canvasContainerEl.getBoundingClientRect();
    const imageBounds = getImageBounds();
    if (!imageBounds) return;

    let currentX = e.clientX - containerRect.left;
    let currentY = e.clientY - containerRect.top;

    currentX = Math.max(imageBounds.left - containerRect.left, Math.min(imageBounds.right - containerRect.left, currentX));
    currentY = Math.max(imageBounds.top - containerRect.top, Math.min(imageBounds.bottom - containerRect.top, currentY));

    const adjusted = adjustSelectionForAspectRatio(
        cropSelectionState.selectionStart.x,
        cropSelectionState.selectionStart.y,
        currentX,
        currentY
    );
    currentX = adjusted.x;
    currentY = adjusted.y;

    const x = Math.min(cropSelectionState.selectionStart.x, currentX);
    const y = Math.min(cropSelectionState.selectionStart.y, currentY);
    const width = Math.abs(currentX - cropSelectionState.selectionStart.x);
    const height = Math.abs(currentY - cropSelectionState.selectionStart.y);

    cropDomRefs.rect.style.left = `${x}px`;
    cropDomRefs.rect.style.top = `${y}px`;
    cropDomRefs.rect.style.width = `${width}px`;
    cropDomRefs.rect.style.height = `${height}px`;

    const viewport = imageToScreenCoords(x, y, containerRect);
    if (viewport) {
        updateSelectionInfo(viewport.x, viewport.y, width, height);
    }
    cropDomRefs.infoDiv.style.display = 'block';
}

/**
 * Re-derive state.cropSelection from the crop box's current on-screen position.
 *
 * Used after a pan (right-drag / two-finger) moves the image beneath a finalized
 * free/aspectRatio selection: the overlay box stays fixed in container space while
 * the image scrolls under it (handleCropPan only moves the mesh), so the stored UV
 * region no longer matches what the box frames. Without this, Apply would crop the
 * pre-pan content. fixedSize mode already re-derives on every mouseup/touchend, so
 * this only handles the free/aspectRatio modes. No-op if no finalized selection is
 * shown. Returns true if the selection was successfully recomputed.
 */
function rederiveCropSelectionAfterPan() {
    if (state.cropRectMode === 'fixedSize') return false;
    if (cropSelectionState.isSelecting) return false;
    if (!state.cropSelection) return false;
    if (!cropDomRefs.overlay || cropDomRefs.overlay.style.display === 'none') return false;

    const canvasContainerEl = getCanvasContainer();
    if (!canvasContainerEl) return false;
    const containerRect = canvasContainerEl.getBoundingClientRect();
    const rectStyle = cropDomRefs.rect.style;
    const rectLeft = parseFloat(rectStyle.left) || 0;
    const rectTop = parseFloat(rectStyle.top) || 0;
    const rectWidth = parseFloat(rectStyle.width) || 0;
    const rectHeight = parseFloat(rectStyle.height) || 0;

    const viewport = imageToScreenCoords(rectLeft, rectTop, containerRect);
    if (!viewport) return false;
    const selection = screenToUV(viewport.x, viewport.y, rectWidth, rectHeight);
    if (!selection) return false;

    state.cropSelection = selection;
    updateSelectionInfo(viewport.x, viewport.y, rectWidth, rectHeight);
    logger.debug('CROP_LOG', 'UICrop', 'Crop selection re-derived after pan');
    return true;
}

/**
 * Handle mouse up to finalize crop selection
 */
function handleCropMouseUp(e) {
    logger.debug('CROP_LOG', 'UICrop', 'Mouse up event, mode:', state.cropRectMode);

    // End right-click pan if active, so the image stops following the cursor after a
    // right-drag. Run before the branch returns below.
    const wasPanning = cropSelectionState.isPanning;
    if (cropSelectionState.isPanning) {
        cropSelectionState.isPanning = false;
        const panCanvas = state.renderer?.domElement;
        if (panCanvas) {
            panCanvas.style.cursor = state.cropSelectionMode ? 'crosshair' : 'default';
        }
    }

    // A pan that moved the image under a finalized free/aspectRatio selection must
    // recompute the stored UV region from the box's new relative position (fixedSize
    // is handled by its own re-derive block below). isSelecting is false here, so the
    // normal-mode path below would otherwise return without updating the selection.
    if (wasPanning && rederiveCropSelectionAfterPan()) {
        return;
    }

    // In fixedSize mode, the box is already drawn on mousedown
    // The selection box is the #crop-selection-rect child of #crop-selection-overlay;
    // its visibility is controlled by toggling overlay.style.display (rect.style.display
    // is never assigned), so gate on the overlay, not the rect.
    if (state.cropRectMode === 'fixedSize' && cropDomRefs.overlay.style.display !== 'none' && parseFloat(cropDomRefs.rect.style.width) > 0) {
        const canvasContainerEl = getCanvasContainer();
        if (!canvasContainerEl) return;
        const containerRect = canvasContainerEl.getBoundingClientRect();
        const rectStyle = cropDomRefs.rect.style;
        const rectLeft = parseFloat(rectStyle.left) || 0;
        const rectTop = parseFloat(rectStyle.top) || 0;
        const rectWidth = parseFloat(rectStyle.width) || 0;
        const rectHeight = parseFloat(rectStyle.height) || 0;

        logger.debug('CROP_LOG', 'UICrop', 'Fixed size mode rect:', { left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight });

        const viewport = imageToScreenCoords(rectLeft, rectTop, containerRect);
        if (!viewport) return;

        const selection = screenToUV(viewport.x, viewport.y, rectWidth, rectHeight);

        if (selection) {
            state.cropSelection = selection;
            cropDomRefs.actionsDiv.style.display = 'grid';
            logger.debug('CROP_LOG', 'UICrop', 'Fixed size selection accepted');
        } else {
            logger.warn('UICrop', 'Fixed size selection rejected by screenToUV');
        }

        cropSelectionState.selectionStart = null;
        return;
    }

    // Handling for normal mode (free, aspectRatio)
    if (!cropSelectionState.isSelecting) return;
    // Finalize the marquee only on the left-button release that ends the drag. A
    // right-button release (which ends a pan) fires this same window handler while
    // the left button is still held; committing the half-drawn selection there
    // corrupts the stored region. Leave isSelecting set so the eventual left-button
    // release finalizes normally.
    if (e.button !== 0) return;
    cropSelectionState.isSelecting = false;

    const canvasContainerEl = getCanvasContainer();
    if (!canvasContainerEl) return;
    const containerRect = canvasContainerEl.getBoundingClientRect();
    const rectStyle = cropDomRefs.rect.style;
    const rectLeft = parseFloat(rectStyle.left) || 0;
    const rectTop = parseFloat(rectStyle.top) || 0;
    const rectWidth = parseFloat(rectStyle.width) || 0;
    const rectHeight = parseFloat(rectStyle.height) || 0;

    logger.debug('CROP_LOG', 'UICrop', 'Normal mode rect:', { left: rectLeft, top: rectTop, width: rectWidth, height: rectHeight });

    if (rectWidth < CONSTANTS.MIN_SELECTION_SIZE || rectHeight < CONSTANTS.MIN_SELECTION_SIZE) {
        logger.warn('UICrop', 'Selection too small, rejected by MIN_SELECTION_SIZE');
        cropDomRefs.overlay.style.display = 'none';
        cropDomRefs.infoDiv.style.display = 'none';
        cropDomRefs.actionsDiv.style.display = 'none';
        state.cropSelection = null;
        cropSelectionState.selectionStart = null;
        return;
    }

    const viewport = imageToScreenCoords(rectLeft, rectTop, containerRect);
    if (!viewport) return;

    const selection = screenToUV(viewport.x, viewport.y, rectWidth, rectHeight);

    if (selection) {
        state.cropSelection = selection;
        updateSelectionInfo(viewport.x, viewport.y, rectWidth, rectHeight);
        cropDomRefs.infoDiv.style.display = 'block';
        cropDomRefs.actionsDiv.style.display = 'grid';
        logger.debug('CROP_LOG', 'UICrop', 'Normal mode selection accepted');
    } else {
        logger.warn('UICrop', 'Normal mode selection rejected by screenToUV');
        cropDomRefs.overlay.style.display = 'none';
        cropDomRefs.infoDiv.style.display = 'none';
        cropDomRefs.actionsDiv.style.display = 'none';
        state.cropSelection = null;
    }

    cropSelectionState.selectionStart = null;
}

/**
 * Handle touch start on canvas for crop selection
 */
function handleCropTouchStart(e) {
    if (!state.cropSelectionMode) return;
    if (e.touches.length === 2) {
        cropSelectionState.isPanning = true;
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        cropSelectionState.panStart.x = (touch1.clientX + touch2.clientX) / 2;
        cropSelectionState.panStart.y = (touch1.clientY + touch2.clientY) / 2;
        e.preventDefault();
        return;
    }
    if (e.touches.length !== 1) return;

    // As in handleCropMouseDown: bail before showing the overlay if the image/mesh is
    // gone, so a single-touch during teardown cannot leave an orphaned stale marquee.
    if (!state.material || !state.material.uniforms || !state.material.uniforms.map.value?.image || !state.mesh) {
        return;
    }

    const touch = e.touches[0];
    const coords = screenToImageCoords(touch.clientX, touch.clientY);
    if (!coords) return;
    const { x: touchX, y: touchY, containerRect } = coords;

    cropSelectionState.selectionStart = { x: touchX, y: touchY };
    cropDomRefs.overlay.style.display = 'block';

    // In fixedSize mode, show fixed-size box immediately on touch
    if (state.cropRectMode === 'fixedSize') {
        if (!state.material || !state.material.uniforms.map.value) {
            return;
        }

        const texture = state.material.uniforms.map.value;
        const imgWidth = texture.image.width;
        const imgHeight = texture.image.height;
        const eyeWidth = Math.floor(imgWidth / 2);
        const eyeHeight = imgHeight;

        const imageBounds = getImageBounds();
        if (!imageBounds) {
            return;
        }

        // Use the UNCLAMPED image extent for the pixel<->screen ratio. When the
        // image is panned/zoomed partly off-canvas, the canvas-clamped bounds
        // understate its on-screen width/height, so a fixed-size crop derived from
        // them would map to fewer image pixels than the user requested.
        const fullBounds = getImageBounds(false) || imageBounds;
        const screenWidth = fullBounds.right - fullBounds.left;
        const screenHeight = fullBounds.bottom - fullBounds.top;
        // Map a source-pixel size onto the CURRENTLY DISPLAYED image. When a crop
        // is already applied, the visible mesh spans only eyeWidth*(1-cropX) source
        // pixels (getImageBounds folds cropRatioX into its extent), so dividing the
        // on-screen extent by the FULL eye size would draw a fixed-size marquee
        // (1-cropX)x too small. Divide by the cropped extent instead.
        const croppedEyeWidth = Math.max(1, eyeWidth * (1.0 - state.params.cropX));
        const croppedEyeHeight = Math.max(1, eyeHeight * (1.0 - state.params.cropY));
        const pixelToScreenX = screenWidth / croppedEyeWidth;
        const pixelToScreenY = screenHeight / croppedEyeHeight;

        const fixedScreenWidth = state.cropFixedWidth * pixelToScreenX;
        const fixedScreenHeight = state.cropFixedHeight * pixelToScreenY;

        const imageLeft = imageBounds.left - containerRect.left;
        const imageRight = imageBounds.right - containerRect.left;
        const imageTop = imageBounds.top - containerRect.top;
        const imageBottom = imageBounds.bottom - containerRect.top;

        let left = touchX - fixedScreenWidth / 2;
        let top = touchY - fixedScreenHeight / 2;

        if (left < imageLeft) left = imageLeft;
        if (left + fixedScreenWidth > imageRight) left = imageRight - fixedScreenWidth;
        if (top < imageTop) top = imageTop;
        if (top + fixedScreenHeight > imageBottom) top = imageBottom - fixedScreenHeight;

        // Compare in image-pixel space, not screen space: a zoomed image extends past
        // the canvas-clamped bounds, so a screen-extent check falsely rejected valid
        // fixed crops. (Mirrors the mouse handler.)
        if (state.cropFixedWidth > croppedEyeWidth || state.cropFixedHeight > croppedEyeHeight) {
            showToast(window.t?.('messages.fixedSizeTooLarge') ?? 'The fixed size is larger than the image size', 'warning');
            cropDomRefs.overlay.style.display = 'none';
            cropSelectionState.selectionStart = null;
            return;
        }

        cropDomRefs.rect.style.left = `${left}px`;
        cropDomRefs.rect.style.top = `${top}px`;
        cropDomRefs.rect.style.width = `${fixedScreenWidth}px`;
        cropDomRefs.rect.style.height = `${fixedScreenHeight}px`;

        const viewport = imageToScreenCoords(left, top, containerRect);
        if (viewport) {
            updateSelectionInfo(viewport.x, viewport.y, fixedScreenWidth, fixedScreenHeight);
        }
        cropDomRefs.infoDiv.style.display = 'block';

        cropSelectionState.isSelecting = false;
    } else {
        cropSelectionState.isSelecting = true;
        cropDomRefs.rect.style.left = `${touchX}px`;
        cropDomRefs.rect.style.top = `${touchY}px`;
        cropDomRefs.rect.style.width = '0';
        cropDomRefs.rect.style.height = '0';
        cropDomRefs.infoDiv.style.display = 'none';
        cropDomRefs.actionsDiv.style.display = 'none';
    }

    e.preventDefault();
}

/**
 * Handle touch move during crop selection drag or pan
 */
function handleCropTouchMove(e) {
    if (cropSelectionState.isPanning && e.touches.length === 2) {
        const touch1 = e.touches[0];
        const touch2 = e.touches[1];
        const centerX = (touch1.clientX + touch2.clientX) / 2;
        const centerY = (touch1.clientY + touch2.clientY) / 2;

        const dx = centerX - cropSelectionState.panStart.x;
        const dy = centerY - cropSelectionState.panStart.y;

        cropSelectionState.panStart.x = centerX;
        cropSelectionState.panStart.y = centerY;

        const canvas = state.renderer.domElement;
        const canvasRect = canvas.getBoundingClientRect();
        const worldHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        const worldDy = -dy * (worldHeight / canvasRect.height);
        const aspect = canvasRect.width / canvasRect.height;
        const worldWidth = worldHeight * aspect;
        const worldDx = dx * (worldWidth / canvasRect.width);

        state.params.panX += worldDx;
        state.params.panY += worldDy;

        updateMeshTransform();
        e.preventDefault();
        return;
    }

    if (!cropSelectionState.isSelecting || !cropSelectionState.selectionStart) return;
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    const canvasContainerEl = getCanvasContainer();
    if (!canvasContainerEl) return;
    const containerRect = canvasContainerEl.getBoundingClientRect();
    const imageBounds = getImageBounds();
    if (!imageBounds) return;

    let currentX = touch.clientX - containerRect.left;
    let currentY = touch.clientY - containerRect.top;

    currentX = Math.max(imageBounds.left - containerRect.left, Math.min(imageBounds.right - containerRect.left, currentX));
    currentY = Math.max(imageBounds.top - containerRect.top, Math.min(imageBounds.bottom - containerRect.top, currentY));

    const adjusted = adjustSelectionForAspectRatio(
        cropSelectionState.selectionStart.x,
        cropSelectionState.selectionStart.y,
        currentX,
        currentY
    );
    currentX = adjusted.x;
    currentY = adjusted.y;

    const x = Math.min(cropSelectionState.selectionStart.x, currentX);
    const y = Math.min(cropSelectionState.selectionStart.y, currentY);
    const width = Math.abs(currentX - cropSelectionState.selectionStart.x);
    const height = Math.abs(currentY - cropSelectionState.selectionStart.y);

    cropDomRefs.rect.style.left = `${x}px`;
    cropDomRefs.rect.style.top = `${y}px`;
    cropDomRefs.rect.style.width = `${width}px`;
    cropDomRefs.rect.style.height = `${height}px`;

    const viewport = imageToScreenCoords(x, y, containerRect);
    if (viewport) {
        updateSelectionInfo(viewport.x, viewport.y, width, height);
    }
    cropDomRefs.infoDiv.style.display = 'block';

    e.preventDefault();
}

/**
 * Handle touch end to finalize crop selection
 */
function handleCropTouchEnd(e) {
    // In fixedSize mode, the box is already drawn on touchstart.
    // Gate on the overlay's visibility (rect.style.display is never assigned;
    // the box is shown/hidden via overlay.style.display).
    if (state.cropRectMode === 'fixedSize' && e.touches.length === 0 && cropDomRefs.overlay.style.display !== 'none' && parseFloat(cropDomRefs.rect.style.width) > 0) {
        const canvasContainerEl = getCanvasContainer();
        if (!canvasContainerEl) return;
        const containerRect = canvasContainerEl.getBoundingClientRect();
        const rectStyle = cropDomRefs.rect.style;
        const rectLeft = parseFloat(rectStyle.left) || 0;
        const rectTop = parseFloat(rectStyle.top) || 0;
        const rectWidth = parseFloat(rectStyle.width) || 0;
        const rectHeight = parseFloat(rectStyle.height) || 0;

        const viewport = imageToScreenCoords(rectLeft, rectTop, containerRect);
        if (!viewport) return;

        const selection = screenToUV(viewport.x, viewport.y, rectWidth, rectHeight);

        if (selection) {
            state.cropSelection = selection;
            cropDomRefs.actionsDiv.style.display = 'grid';
        }

        cropSelectionState.selectionStart = null;
        // Continue to isPanning handling
    }

    // Handling for normal mode (free, aspectRatio)
    if (cropSelectionState.isSelecting && e.touches.length === 0) {
        cropSelectionState.isSelecting = false;

        const canvasContainerEl = getCanvasContainer();
        if (!canvasContainerEl) return;
        const containerRect = canvasContainerEl.getBoundingClientRect();
        const rectStyle = cropDomRefs.rect.style;
        const rectLeft = parseFloat(rectStyle.left) || 0;
        const rectTop = parseFloat(rectStyle.top) || 0;
        const rectWidth = parseFloat(rectStyle.width) || 0;
        const rectHeight = parseFloat(rectStyle.height) || 0;

        if (rectWidth < CONSTANTS.MIN_SELECTION_SIZE || rectHeight < CONSTANTS.MIN_SELECTION_SIZE) {
            cropDomRefs.overlay.style.display = 'none';
            cropDomRefs.infoDiv.style.display = 'none';
            cropDomRefs.actionsDiv.style.display = 'none';
            state.cropSelection = null;
            cropSelectionState.selectionStart = null;
            return;
        }

        const viewport = imageToScreenCoords(rectLeft, rectTop, containerRect);
        if (!viewport) return;

        const selection = screenToUV(viewport.x, viewport.y, rectWidth, rectHeight);

        if (selection) {
            state.cropSelection = selection;
            updateSelectionInfo(viewport.x, viewport.y, rectWidth, rectHeight);
            cropDomRefs.infoDiv.style.display = 'block';
            cropDomRefs.actionsDiv.style.display = 'grid';
        } else {
            cropDomRefs.overlay.style.display = 'none';
            cropDomRefs.infoDiv.style.display = 'none';
            cropDomRefs.actionsDiv.style.display = 'none';
            state.cropSelection = null;
        }

        cropSelectionState.selectionStart = null;
    }

    if (cropSelectionState.isPanning) {
        cropSelectionState.isPanning = false;
        const canvas = state.renderer?.domElement;
        if (canvas) canvas.style.cursor = state.cropSelectionMode ? 'crosshair' : 'default';

        // Two-finger pan moved the image under a finalized free/aspectRatio selection;
        // recompute the stored UV region from the box's new position once all fingers
        // are up (fixedSize is handled by its own re-derive block above).
        if (e.touches.length === 0) {
            rederiveCropSelectionAfterPan();
        }
    }
}

/**
 * Handle an OS-cancelled touch gesture (touchcancel).
 *
 * Fired when the system takes over an in-progress touch (notification shade,
 * gesture navigation, incoming call). Without this, cropSelectionState.isSelecting /
 * isPanning stay true, so the next touch continues the abandoned marquee/pan from a
 * stale start point instead of beginning a fresh gesture. Reset the drag state.
 */
function handleCropTouchCancel() {
    cropSelectionState.isSelecting = false;
    cropSelectionState.isPanning = false;
    cropSelectionState.selectionStart = null;
}

/**
 * Handle right-click mouse down for pan initiation
 */
function handleCropRightMouseDown(e) {
    if (!state.cropSelectionMode) return;
    if (e.button === 2) {
        // Do not start a pan while a left-button marquee drag is in progress:
        // running both gestures at once (two mousemove handlers moving the box and
        // the image simultaneously) corrupts the selection-to-image relationship.
        if (cropSelectionState.isSelecting) {
            e.preventDefault();
            return;
        }
        cropSelectionState.isPanning = true;
        cropSelectionState.panStart.x = e.clientX;
        cropSelectionState.panStart.y = e.clientY;
        cropDomRefs.canvas.style.cursor = 'move';
        e.preventDefault();
    }
}

/**
 * Handle pan via mouse move (right-click drag)
 *
 * Note: 3DTV virtual-window panning is intentionally not handled here. Panning is
 * only active while rectangle selection mode is on, which is restricted to anaglyph
 * (0, 11, 14, 15) and interlace (1, 2) modes; 3DTV applies to layout modes
 * (7, 8, 9, 10, 16). Those sets are disjoint, so is3DTVActive() can never be true
 * in this code path.
 */
function handleCropPan(e) {
    // Resident listener: ignore stray moves when not in selection mode. This also
    // stops the image from continuing to follow the cursor if isPanning was left set.
    if (!state.cropSelectionMode) return;
    if (!cropSelectionState.isPanning) return;

    // Self-heal a stuck pan: if we are still "panning" but no mouse button is held,
    // the mouseup that ends the right-drag was lost (released outside the window).
    // Stop panning so the image does not keep following the buttonless cursor as it
    // re-enters; the next right-mousedown starts a fresh pan. Mirrors the marquee
    // handler's e.buttons === 0 guard in handleCropMouseMove.
    if (e.buttons === 0) {
        cropSelectionState.isPanning = false;
        const panCanvas = state.renderer?.domElement;
        if (panCanvas) {
            panCanvas.style.cursor = state.cropSelectionMode ? 'crosshair' : 'default';
        }
        return;
    }

    const canvas = state.renderer.domElement;

    const dx = e.clientX - cropSelectionState.panStart.x;
    const dy = e.clientY - cropSelectionState.panStart.y;

    cropSelectionState.panStart.x = e.clientX;
    cropSelectionState.panStart.y = e.clientY;

    const canvasRect = canvas.getBoundingClientRect();
    const worldHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
    const worldDy = -dy * (worldHeight / canvasRect.height);

    const aspect = canvasRect.width / canvasRect.height;
    const worldWidth = worldHeight * aspect;
    const worldDx = dx * (worldWidth / canvasRect.width);

    state.params.panX += worldDx;
    state.params.panY += worldDy;

    updateMeshTransform();
    e.preventDefault();
}

/**
 * Handle context menu suppression in crop selection mode
 */
function handleCropContextMenu(e) {
    if (state.cropSelectionMode) {
        e.preventDefault();
    }
}


// ============================================================
// Setup sub-routines (used by setupCropSelection orchestrator)
// ============================================================

/**
 * Set up crop mode radio buttons and input field listeners
 */
function setupCropModeControls(signal) {
    const { modeRadios, aspectRatioSettings, fixedSizeSettings,
            cropAspectWidth, cropAspectHeight, cropFixedWidth, cropFixedHeight } = cropDomRefs;

    modeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            state.cropRectMode = e.target.value;
            if (aspectRatioSettings && fixedSizeSettings) {
                aspectRatioSettings.style.display = state.cropRectMode === 'aspectRatio' ? 'block' : 'none';
                fixedSizeSettings.style.display = state.cropRectMode === 'fixedSize' ? 'block' : 'none';
            }
        }, { signal });
    });

    if (cropAspectWidth) {
        cropAspectWidth.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (value > 0) state.cropAspectWidth = value;
        }, { signal });
        // Revert the field to the current ratio when focus is lost on an invalid
        // (empty/zero/negative) value, so the DOM and state stay in sync — the input
        // handler intentionally ignores such values (matching the fixed-size fields).
        cropAspectWidth.addEventListener('blur', (e) => {
            if (!(parseInt(e.target.value, 10) > 0)) {
                e.target.value = state.cropAspectWidth;
            }
        }, { signal });
    }
    if (cropAspectHeight) {
        cropAspectHeight.addEventListener('input', (e) => {
            const value = parseInt(e.target.value, 10);
            if (value > 0) state.cropAspectHeight = value;
        }, { signal });
        cropAspectHeight.addEventListener('blur', (e) => {
            if (!(parseInt(e.target.value, 10) > 0)) {
                e.target.value = state.cropAspectHeight;
            }
        }, { signal });
    }
    if (cropFixedWidth) {
        cropFixedWidth.addEventListener('input', (e) => {
            let value = parseInt(e.target.value, 10);
            if (value > 0) {
                // Adjust to even
                value = ensureEven(value);
                state.cropFixedWidth = value;
            }
        }, { signal });
        // Ensure even value when focus is lost
        cropFixedWidth.addEventListener('blur', (e) => {
            let value = parseInt(e.target.value, 10);
            if (value > 0 && value % 2 !== 0) {
                value = ensureEven(value);
                e.target.value = value;
                state.cropFixedWidth = value;
            }
        }, { signal });
    }
    if (cropFixedHeight) {
        cropFixedHeight.addEventListener('input', (e) => {
            let value = parseInt(e.target.value, 10);
            if (value > 0) {
                // Adjust to even
                value = ensureEven(value);
                state.cropFixedHeight = value;
            }
        }, { signal });
        // Ensure even value when focus is lost
        cropFixedHeight.addEventListener('blur', (e) => {
            let value = parseInt(e.target.value, 10);
            if (value > 0 && value % 2 !== 0) {
                value = ensureEven(value);
                e.target.value = value;
                state.cropFixedHeight = value;
            }
        }, { signal });
    }
}

/**
 * Set up the crop selection toggle button
 */
function setupToggleButton(signal) {
    const { toggleBtn, canvas, overlay, rect, infoDiv, actionsDiv,
            modeRadios, cropAspectWidth, cropAspectHeight, cropFixedWidth, cropFixedHeight } = cropDomRefs;

    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', () => {
        const mode = state.params.mode;
        if (!state.cropSelectionMode && !isCropSelectionAllowed(mode)) {
            showToast(window.t?.('messages.rectangularWarning') ?? 'Rectangular crop is not allowed in this mode', 'warning');
            return;
        }

        state.cropSelectionMode = !state.cropSelectionMode;

        if (state.cropSelectionMode) {
            logger.debug('CROP_LOG', 'UICrop', 'Entering crop selection mode');

            toggleBtn.classList.add('active');
            toggleBtn.textContent = window.t?.('controls.rectangularModeActive') || 'Rectangular selection mode (active)';
            canvas.style.cursor = 'crosshair';

            // Clear any active selection when entering selection mode
            state.cropSelection = null;
            if (overlay) overlay.style.display = 'none';
            if (rect) {
                rect.style.width = '0';
                rect.style.height = '0';
                rect.style.left = '0';
                rect.style.top = '0';
            }
            if (infoDiv) infoDiv.style.display = 'none';
            if (actionsDiv) actionsDiv.style.display = 'none';

            // Explicitly reset crop selection state to ensure clean start
            cropSelectionState.isSelecting = false;
            cropSelectionState.isPanning = false;
            cropSelectionState.selectionStart = null;
            cropSelectionState.panStart = { x: 0, y: 0 };
            logger.debug('CROP_LOG', 'UICrop', 'Crop selection state reset');

            modeRadios.forEach(radio => {
                radio.disabled = true;
                const label = radio.closest('label');
                if (label) {
                    label.style.opacity = '0.5';
                    label.style.cursor = 'not-allowed';
                }
            });
            if (cropAspectWidth) cropAspectWidth.disabled = true;
            if (cropAspectHeight) cropAspectHeight.disabled = true;
            if (cropFixedWidth) cropFixedWidth.disabled = true;
            if (cropFixedHeight) cropFixedHeight.disabled = true;
        } else {
            // Disable mode (keep event listeners)
            state.cropSelection = null;

            if (overlay) overlay.style.display = 'none';
            if (infoDiv) infoDiv.style.display = 'none';
            if (actionsDiv) actionsDiv.style.display = 'none';

            toggleBtn.classList.remove('active');
            toggleBtn.textContent = window.t?.('controls.rectangularMode') || 'Rectangular selection';
            canvas.style.cursor = 'default';

            if (state.renderer?.domElement) {
                state.renderer.domElement.style.cursor = 'default';
            }

            modeRadios.forEach(radio => {
                radio.disabled = false;
                const label = radio.closest('label');
                if (label) {
                    label.style.opacity = '1';
                    label.style.cursor = 'pointer';
                }
            });
            if (cropAspectWidth) cropAspectWidth.disabled = false;
            if (cropAspectHeight) cropAspectHeight.disabled = false;
            if (cropFixedWidth) cropFixedWidth.disabled = false;
            if (cropFixedHeight) cropFixedHeight.disabled = false;
        }
    }, { signal });
}

/**
 * Set up apply and clear action buttons
 */
function setupActionButtons(signal) {
    const { applyBtn, clearBtn } = cropDomRefs;

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            if (!state.cropSelection) return;
            applyCropSelection();
        }, { signal });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            clearCropSelection();
            exitCropSelectionMode();
        }, { signal });
    }
}


// ============================================================
// Main setup (orchestrator)
// ============================================================

/**
 * Set up rectangle selection crop (call after renderer initialization)
 *
 * This function serves as the orchestrator that:
 * 1. Validates preconditions and initializes DOM references
 * 2. Sets up crop mode controls (radio buttons, input fields)
 * 3. Sets up the toggle button for entering/exiting crop mode
 * 4. Registers all mouse, touch, and pan event handlers
 * 5. Sets up apply/clear action buttons
 */
export function setupCropSelection() {
    if (cropSelectionInitialized) {
        logger.warn('UICrop', 'setupCropSelection() called multiple times. Skipping duplicate registration.');
        return;
    }

    if (!state.renderer || !state.renderer.domElement) {
        logger.warn('UICrop', 'setupCropSelection: renderer not initialized yet');
        return;
    }

    cleanupCropSelectionListeners();

    // Create AbortController for window event listeners
    windowEventAbortController = new AbortController();
    const signal = windowEventAbortController.signal;

    // Cache DOM references
    initCropDomRefs();

    const { overlay, rect, canvas } = cropDomRefs;

    if (!overlay || !rect || !canvas) {
        logger.warn('UICrop', 'Required crop selection DOM elements not found (overlay, rect, or canvas)');
        // Roll back the AbortController so a later retry can re-initialize cleanly.
        windowEventAbortController = null;
        return;
    }

    // Mark initialized only after the required DOM elements are confirmed present.
    cropSelectionInitialized = true;

    // Reset internal state
    cropSelectionState.isSelecting = false;
    cropSelectionState.isPanning = false;
    cropSelectionState.selectionStart = null;
    cropSelectionState.panStart = { x: 0, y: 0 };

    // Set up crop mode controls (radio buttons, input fields)
    setupCropModeControls(signal);

    // Set up toggle button for entering/exiting crop selection mode
    setupToggleButton(signal);

    // Register mouse event handlers
    canvas.addEventListener('mousedown', handleCropMouseDown, { signal });
    cropSelectionListeners.windowMouseMove = handleCropMouseMove;
    window.addEventListener('mousemove', handleCropMouseMove, { signal });
    cropSelectionListeners.windowMouseUp = handleCropMouseUp;
    window.addEventListener('mouseup', handleCropMouseUp, { signal });

    // Register touch event handlers
    canvas.addEventListener('touchstart', handleCropTouchStart, { passive: false, signal });
    cropSelectionListeners.windowTouchMove = handleCropTouchMove;
    window.addEventListener('touchmove', handleCropTouchMove, { passive: false, signal });
    cropSelectionListeners.windowTouchEnd = handleCropTouchEnd;
    window.addEventListener('touchend', handleCropTouchEnd, { signal });
    // Reset drag state when the OS cancels the touch (notification shade, gesture
    // navigation); otherwise a stale isSelecting/isPanning leaks into the next touch.
    window.addEventListener('touchcancel', handleCropTouchCancel, { signal });

    // Register pan handlers (right-click drag)
    canvas.addEventListener('mousedown', handleCropRightMouseDown, { capture: true, signal });
    canvas.addEventListener('contextmenu', handleCropContextMenu, { signal });
    cropSelectionListeners.windowMouseMovePan = handleCropPan;
    window.addEventListener('mousemove', handleCropPan, { signal });

    // Set up apply/clear action buttons
    setupActionButtons(signal);
}
