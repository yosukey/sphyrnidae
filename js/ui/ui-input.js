/**
 * ui-input.js
 * Input handler features
 * - Drag and drop
 * - Mouse interactions (pan, drag)
 * - Touch/pinch interactions
 * - Wheel interactions (zoom)
 * - Keyboard interactions
 * - Viewer mode click navigation
 */

import { state, CONSTANTS, isSBSMode, is3DTVActive, getViewerDisplayScale } from '../globals.js';
import { updateUniforms, updateMeshTransform, fitImageToWindow } from '../rendering/renderer.js';
import { handleFile, startViewerMode, clearPreviousImageState } from '../loaders/loader.js';
import { cancelPendingUrlDialogLoad } from './ui-file-loading.js';
import { togglePointer3dMode, updatePointer3dDepthDisplay } from './ui-pointer3d.js';
import { applySwapLR } from './ui-alignment.js';
import { isFullscreenActive, exitFullscreenCompat } from './ui-fullscreen.js';
import * as logger from '../utils/logger.js';

// Callback functions (set from ui.js)
let callbacks = {
    updateParamValue: null,
    updateViewerZoomDisplay: null,
    updateOutputFileNameField: null
};

// ==================== Shared helper functions ====================

/**
 * Shared pan handling
 * @param {number} dx - X-axis delta (pixels)
 * @param {number} dy - Y-axis delta (pixels)
 * @param {DOMRect} rect - Canvas bounding box
 */
function applyPanDelta(dx, dy, rect) {
    const is3dtvTargetMode = is3DTVActive();

    if (is3dtvTargetMode) {
        // In 3DTV mode, pan in any direction when zoomed beyond fit
        if (state.viewerScale >= 1.0) {
            if (rect.width === 0 || rect.height === 0 || state.viewerScale === 0) return true;
            const panSpeedX = 1.0 / (rect.width * state.viewerScale);
            const panSpeedY = 1.0 / (rect.height * state.viewerScale);
            state.viewerPanX += dx * panSpeedX;
            state.viewerPanY -= dy * panSpeedY;

            // In shader, 3DTV pan is additionally multiplied by (viewerScale - 1.0).
            // Keep viewerPan bounded so UVs stay in-range even before final clamp.
            const maxPan = Math.max(0.0, 1.0 / (2.0 * state.viewerScale));
            state.viewerPanX = Math.max(-maxPan, Math.min(maxPan, state.viewerPanX));
            state.viewerPanY = Math.max(-maxPan, Math.min(maxPan, state.viewerPanY));

            updateUniforms();
        }
        return true; // Handled
    }

    if (state.viewerMode && isSBSMode(state.params.mode)) {
        // In viewer mode with SBS, change viewerPan
        if (rect.width === 0 || rect.height === 0 || state.viewerScale === 0) return true;
        const panSpeedX = 1.0 / (rect.width * state.viewerScale);
        const panSpeedY = 1.0 / (rect.height * state.viewerScale);

        state.viewerPanX += dx * panSpeedX;
        state.viewerPanY -= dy * panSpeedY;

        // The shader multiplies viewerPan by (viewerScale - 1), so this is a
        // uniform-space limit, not the final UV-space limit.
        const maxPan = Math.max(0.0, 1.0 / (2.0 * state.viewerScale));
        state.viewerPanX = Math.max(-maxPan, Math.min(maxPan, state.viewerPanX));
        state.viewerPanY = Math.max(-maxPan, Math.min(maxPan, state.viewerPanY));

        updateUniforms();
        return true; // Handled
    }

    // Normal mode
    if (rect.height === 0 || rect.width === 0) return false;
    const worldHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
    const worldDy = -dy * (worldHeight / rect.height);

    const aspect = rect.width / rect.height;
    const worldWidth = worldHeight * aspect;
    const worldDx = dx * (worldWidth / rect.width);

    state.params.panX += worldDx;
    state.params.panY += worldDy;

    updateMeshTransform();
    return false; // Normal mode handling
}

/**
 * Whether a drag should pan in the current state.
 *
 * In viewer mode only SBS and 3DTV-forced (Half/Full TaB) images pan, and only
 * when zoomed beyond fit — applyPanDelta() handles both via its 3DTV and SBS
 * branches. The old drag-start guards keyed on isSBSMode() alone, which excludes
 * the TaB modes (10/16) even though the viewer forces 3DTV on for them, so those
 * images could be zoomed but never panned. is3DTVActive() closes that gap.
 * Outside viewer mode, normal-mode panning is always allowed here.
 * @returns {boolean}
 */
function viewerDragEnabled() {
    if (!state.viewerMode) return true;
    const pannable = isSBSMode(state.params.mode) || is3DTVActive();
    return pannable && state.viewerScale > 1.0;
}

/**
 * Shared zoom handling (SBS/3DTV)
 * @param {number} zoomDelta - Zoom delta
 * @returns {boolean} True if handled
 */
function applyViewerZoom(zoomDelta) {
    const is3dtvTargetMode = is3DTVActive();

    if (!((state.viewerMode && isSBSMode(state.params.mode)) || is3dtvTargetMode)) {
        return false; // Not handled by this handler
    }

    const fitScale = state.viewerFitScale;
    const epsilon = 0.001;

    if (is3dtvTargetMode) {
        // 3DTV mode: control via viewerScale only
        state.params.panX = 0;
        state.params.panY = 0;

        let newViewerScale = state.viewerScale + zoomDelta * 2.0;
        newViewerScale = Math.max(0.2, Math.min(5.0, newViewerScale));

        if (newViewerScale <= 1.0) {
            state.viewerPanX = 0;
            state.viewerPanY = 0;
        }

        state.viewerScale = newViewerScale;
        updateMeshTransform();
        updateUniforms();
        const scaleInput = document.getElementById('scale');
        if (scaleInput) scaleInput.value = newViewerScale;
        callbacks.updateViewerZoomDisplay?.(newViewerScale);
        return true;
    }

    // viewerMode + SBS: composite zoom control
    if (state.viewerScale > 1.0 + epsilon) {
        // viewerScale > 1: adjust viewerScale
        let newViewerScale = state.viewerScale + zoomDelta * 2.0;
        if (newViewerScale <= 1.0 + epsilon) {
            newViewerScale = 1.0;
            state.viewerPanX = 0;
            state.viewerPanY = 0;
        }
        newViewerScale = Math.min(5.0, newViewerScale);

        state.viewerScale = newViewerScale;
        updateUniforms();
        callbacks.updateViewerZoomDisplay?.(state.params.scale * state.viewerScale);
    } else if (state.params.scale < fitScale - epsilon) {
        // scale < fitScale: adjust scale
        let newScale = state.params.scale + zoomDelta;
        newScale = Math.max(0.1, newScale);
        if (newScale >= fitScale - epsilon) {
            newScale = fitScale;
            state.viewerScale = 1.0;
            state.viewerPanX = 0;
            state.viewerPanY = 0;
        }

        state.params.panX = 0;
        state.params.panY = 0;
        callbacks.updateParamValue?.('scale', newScale);
        callbacks.updateViewerZoomDisplay?.(newScale);
    } else {
        // Near fitScale: adjust viewerScale or scale depending on direction
        if (Math.abs(state.viewerScale - 1.0) > epsilon) {
            state.viewerScale = 1.0;
            state.viewerPanX = 0;
            state.viewerPanY = 0;
        }

        if (zoomDelta > 0) {
            // Zoom in: increase viewerScale
            let newViewerScale = state.viewerScale + zoomDelta * 2.0;
            newViewerScale = Math.min(5.0, newViewerScale);

            state.viewerScale = newViewerScale;
            updateUniforms();
            callbacks.updateViewerZoomDisplay?.(state.params.scale * state.viewerScale);
        } else {
            // Zoom out: decrease scale
            let newScale = state.params.scale + zoomDelta;
            newScale = Math.max(0.1, newScale);

            state.params.panX = 0;
            state.params.panY = 0;
            callbacks.updateParamValue?.('scale', newScale);
            callbacks.updateViewerZoomDisplay?.(newScale);
        }
    }

    return true;
}

/**
 * Apply zoom changes for VR-driven input.
 * @param {number} zoomDelta - Zoom delta
 * @returns {boolean} True if handled
 */
export function applyVRZoomDelta(zoomDelta) {
    // For SBS/3DTV, reuse shared handler
    if (applyViewerZoom(zoomDelta)) {
        return true;
    }

    if (state.viewerMode) {
        // Viewer mode (non-SBS): zoom around center
        const oldScale = state.params.scale;
        const newScale = Math.max(0.1, Math.min(10.0, oldScale + zoomDelta));

        state.params.panX = 0;
        state.params.panY = 0;
        callbacks.updateParamValue?.('scale', newScale);
        callbacks.updateViewerZoomDisplay?.(newScale);
        return true;
    }

    // Normal mode: center zoom
    const oldScale = state.params.scale;
    const newScale = Math.max(0.1, Math.min(10.0, oldScale + zoomDelta));
    state.params.panX = 0;
    state.params.panY = 0;
    callbacks.updateParamValue?.('scale', newScale);
    return true;
}

/**
 * Upper bound for normal-view zoom. This is the #scale slider's own max — the same
 * bound updateParamValue() enforces when the scale is applied. The cursor-anchored
 * pan compensation in the wheel/pinch handlers must clamp to this value, not a wider
 * one: otherwise, at the zoom limit, scaleRatio is computed for a scale that never
 * gets applied and the image drifts away from the cursor without zooming.
 * @returns {number} The slider max, or 5.0 if the element is unavailable.
 */
function getNormalScaleMax() {
    const el = document.getElementById('scale');
    const max = el ? parseFloat(el.max) : NaN;
    return Number.isFinite(max) ? max : 5.0;
}

// ==================== Setup functions ====================

/**
 * Set callback functions
 * @param {Object} cbs - Callback function object
 */
export function setInputCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

/**
 * Set up drag and drop
 * @param {AbortSignal} signal - AbortController signal
 */
export function setupDragAndDrop(signal) {
    const body = document.body;
    const canvasContainer = document.getElementById('canvas-container');

    // Track drag enter/leave depth instead of guessing the window boundary from
    // (clientX === 0 && clientY === 0). dragenter/dragleave bubble to window and
    // fire as a +1/-1 pair when the pointer crosses into a child element, so the
    // highlight stays on while inside the window and clears reliably only when
    // the drag truly leaves it (depth returns to 0).
    let dragDepth = 0;
    const setDragOver = (on) => {
        body.classList.toggle('drag-over', on);
        if (canvasContainer) {
            canvasContainer.classList.toggle('drag-over', on);
        }
    };

    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragDepth++;
        setDragOver(true);
    }, { signal });

    window.addEventListener('dragover', (e) => {
        // Required so the drop event fires.
        e.preventDefault();
        // Safety net: if dragenter was missed, treat an active dragover as inside.
        if (dragDepth === 0) {
            dragDepth = 1;
        }
        setDragOver(true);
    }, { signal });

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) {
            setDragOver(false);
        }
    }, { signal });

    // Let modules that own their own drop zone and stop propagation (e.g. the viewer
    // dialog's drag-drop area) resync this shared drag state. Without this, their
    // drop never bubbles to the window handler below, so dragDepth never returns to
    // 0 and the drag-over highlight sticks on body/#canvas-container — and every
    // later drag starts off-by-one.
    window.addEventListener('drag-state-reset', () => {
        dragDepth = 0;
        setDragOver(false);
    }, { signal });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        setDragOver(false);

        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const droppedFiles = Array.from(e.dataTransfer.files);

            // A local drop must take ownership immediately: invalidate any in-flight
            // "Open from URL" fetch so it cannot resolve later and silently overwrite
            // the dropped image (its staleness check keys off this token/abort).
            cancelPendingUrlDialogLoad();

            // If viewer dialog is open, support multiple files and start viewer mode immediately.
            // The dialog is opened by setting inline style.display = 'flex' and closed with
            // 'none'. On a fresh page it is hidden via the `hidden` class with no inline style
            // (style.display === ''), so test for the explicit 'flex' open state rather than
            // `!== 'none'` — otherwise an initial drop is wrongly routed into viewer mode.
            const viewerModeDialog = document.getElementById('viewerModeDialog');
            if (viewerModeDialog && viewerModeDialog.style.display === 'flex') {
                const allowedExtensions = ['.jpg', '.jpeg', '.png', '.mpo', '.jps', '.gif', '.webp', '.bmp', '.tiff', '.tif'];
                const filteredFiles = droppedFiles.filter(file => {
                    const ext = file.name.toLowerCase().match(/\.[^.]*$/)?.[0] || '';
                    return allowedExtensions.includes(ext);
                }).sort((a, b) => a.name.localeCompare(b.name));

                if (filteredFiles.length > 0) {
                    viewerModeDialog.style.display = 'none';
                    // Note: clearPreviousImageState() is called by handleFile()
                    // which is invoked by startViewerMode() indirectly.
                    startViewerMode(filteredFiles);
                }
                return;
            }

            // Normal mode: process only the first file
            const file = droppedFiles[0];
            if (!file) return;
            const nameEl = document.getElementById('infoFileName');
            if (nameEl) {
                nameEl.textContent = file.name;
                nameEl.removeAttribute('data-i18n');
            }

            // Hide second filename row
            const secondaryRow = document.getElementById('infoFileNameSecondaryRow');
            if (secondaryRow) secondaryRow.style.display = 'none';

            const nameParts = file.name.split('.');
            if (nameParts.length > 1) nameParts.pop();
            state.originalFileNameBase = nameParts.join('.');
            callbacks.updateOutputFileNameField?.();
            // Reset the URL-dialog origin flag: a dropped local file is not a
            // URL-loaded image, so URL share/clipboard features must not keep
            // referencing the previously loaded URL.
            handleFile(file, { loadedFromUrlDialog: false });
        }
    }, { signal });
}

/**
 * Set up mouse interactions
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {AbortSignal} signal - AbortController signal
 * @returns {Object} Mouse state object
 */
export function setupMouseHandlers(canvas, signal) {
    let isDragging = false;
    let lastX = 0;
    let lastY = 0;

    canvas.addEventListener('mousedown', (e) => {
        // Skip panning in rectangle selection mode
        if (state.cropSelectionMode) return;

        // In viewer mode, only SBS/3DTV (incl. TaB) images pan, and only beyond fit.
        if (!viewerDragEnabled()) {
            return;
        }

        if (e.button !== 0) return;
        isDragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
        if (!state.pointer3dEnabled) {
            canvas.style.cursor = 'move';
        }
        e.preventDefault();
    }, { signal });

    window.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        // Self-heal a stuck drag: if no button is held the mouseup was missed
        // (button released over an iframe, after an OS focus steal, etc.), so the
        // image would otherwise pan with no button down until the next click.
        if (e.buttons === 0) {
            isDragging = false;
            if (!state.pointer3dEnabled) {
                canvas.style.cursor = 'default';
            }
            return;
        }

        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;

        lastX = e.clientX;
        lastY = e.clientY;

        const rect = canvas.getBoundingClientRect();
        applyPanDelta(dx, dy, rect);
    }, { signal });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            if (!state.pointer3dEnabled) {
                canvas.style.cursor = 'default';
            }
        }
    }, { signal });

    return { isDragging: () => isDragging, setDragging: (v) => { isDragging = v; }, getLastPos: () => ({ lastX, lastY }), setLastPos: (x, y) => { lastX = x; lastY = y; } };
}

/**
 * Set up touch/pinch interactions
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Object} mouseState - Mouse state object
 * @param {AbortSignal} signal - AbortController signal for cleanup
 */
export function setupTouchHandlers(canvas, mouseState, signal) {
    const pointers = new Map();
    let lastPinchDistance = 0;
    let isPinching = false;

    const cleanup = () => {
        pointers.clear();
        lastPinchDistance = 0;
        isPinching = false;
    };

    if (signal) {
        signal.addEventListener('abort', cleanup);
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse') return;

        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        canvas.setPointerCapture(e.pointerId);

        if (pointers.size === 1) {
            if (state.cropSelectionMode) return;

            // In viewer mode, only SBS/3DTV (incl. TaB) images pan, and only beyond fit.
            if (!viewerDragEnabled()) {
                return;
            }
            mouseState.setDragging(true);
            mouseState.setLastPos(e.clientX, e.clientY);
            if (!state.pointer3dEnabled) {
                canvas.style.cursor = 'move';
            }
        } else if (pointers.size === 2) {
            // In crop-selection mode, ui-crop handles two-finger pan itself;
            // do not also start pinch-zoom here (would corrupt the selection mapping).
            if (state.cropSelectionMode) return;
            mouseState.setDragging(false);
            isPinching = true;
            const pts = Array.from(pointers.values());
            lastPinchDistance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        }
        e.preventDefault();
    }, { signal });

    canvas.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse') return;

        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (pointers.size === 1 && mouseState.isDragging()) {
            const { lastX, lastY } = mouseState.getLastPos();
            const dx = e.clientX - lastX;
            const dy = e.clientY - lastY;
            mouseState.setLastPos(e.clientX, e.clientY);

            const rect = canvas.getBoundingClientRect();
            applyPanDelta(dx, dy, rect);
        } else if (pointers.size === 2 && isPinching) {
            handlePinchZoom(canvas, pointers, lastPinchDistance, (newDist) => { lastPinchDistance = newDist; });
        }
        e.preventDefault();
    }, { signal });

    const handlePointerEnd = (e) => {
        if (e.pointerType === 'mouse') return;

        try {
            if (pointers.has(e.pointerId)) {
                pointers.delete(e.pointerId);
            }
            canvas.releasePointerCapture(e.pointerId);
        } catch (err) {
            // releasePointerCapture might fail if already released
            logger.warn('UIInput','[Input] Error releasing pointer capture:', err);
        }

        if (pointers.size < 2) {
            isPinching = false;
            lastPinchDistance = 0;
        } else if (pointers.size === 2 && isPinching) {
            // Lifting one finger of a 3+ finger gesture back down to two leaves
            // lastPinchDistance measured against the *old* pointer pair. Rebase it
            // on the two remaining pointers so the next move computes the zoom
            // ratio against a fresh baseline instead of jumping.
            const pts = Array.from(pointers.values());
            lastPinchDistance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        }

        if (pointers.size === 0) {
            if (mouseState.isDragging()) {
                mouseState.setDragging(false);
                if (!state.pointer3dEnabled) {
                    canvas.style.cursor = 'default';
                }
            }
        } else if (pointers.size === 1) {
            const remaining = Array.from(pointers.values())[0];
            if (remaining) {  // Guard against empty array
                mouseState.setLastPos(remaining.x, remaining.y);
            }
            // Mirror the pointerdown guards: never re-enable dragging while in
            // crop-selection mode. Lifting one finger of ui-crop's two-finger pan
            // lands here, and starting a pan would shift the image under the crop
            // overlay and corrupt the selection mapping.
            if (state.cropSelectionMode) {
                mouseState.setDragging(false);
            } else if (!viewerDragEnabled()) {
                mouseState.setDragging(false);
            } else {
                mouseState.setDragging(true);
                if (!state.pointer3dEnabled) {
                    canvas.style.cursor = 'move';
                }
            }
        }
    };

    canvas.addEventListener('pointerup', handlePointerEnd, { signal });
    canvas.addEventListener('pointercancel', handlePointerEnd, { signal });
}

/**
 * Handle pinch zoom
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {Map} pointers - Pointer info
 * @param {number} lastPinchDistance - Previous pinch distance
 * @param {Function} setLastPinchDistance - Update pinch distance function
 */
function handlePinchZoom(canvas, pointers, lastPinchDistance, setLastPinchDistance) {
    const pts = Array.from(pointers.values());
    const currentDistance = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

    if (lastPinchDistance > 0) {
        const pinchRatio = currentDistance / lastPinchDistance;
        const zoomDelta = (pinchRatio - 1) * 0.5;

        // For SBS/3DTV mode, use the shared handler
        if (applyViewerZoom(zoomDelta)) {
            setLastPinchDistance(currentDistance);
            return;
        }

        // Other modes
        const pinchCenterX = (pts[0].x + pts[1].x) / 2;
        const pinchCenterY = (pts[0].y + pts[1].y) / 2;
        const rect = canvas.getBoundingClientRect();

        if (rect.width <= 0 || rect.height <= 0) {
            setLastPinchDistance(currentDistance);
            return;
        }

        if (state.viewerMode) {
            // Viewer mode (non-SBS): zoom around center
            const oldScale = state.params.scale;
            let newScale = Math.max(0.1, Math.min(10.0, oldScale + zoomDelta));
            state.params.panX = 0;
            state.params.panY = 0;
            callbacks.updateParamValue?.('scale', newScale);
            callbacks.updateViewerZoomDisplay?.(newScale);
        } else {
            // Normal mode: zoom around pinch center
            const oldScale = state.params.scale;
            let newScale = Math.max(0.1, Math.min(getNormalScaleMax(), oldScale + zoomDelta));

            const mouseX = pinchCenterX - rect.left;
            const mouseY = pinchCenterY - rect.top;
            const ndcX = (mouseX / rect.width) * 2 - 1;
            const ndcY = -(mouseY / rect.height) * 2 + 1;
            const frustumHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
            const aspect = rect.width / rect.height;
            const frustumWidth = frustumHeight * aspect;
            const mouseWorldX = ndcX * (frustumWidth / 2);
            const mouseWorldY = ndcY * (frustumHeight / 2);
            const scaleRatio = newScale / oldScale;
            state.params.panX = mouseWorldX - (mouseWorldX - state.params.panX) * scaleRatio;
            state.params.panY = mouseWorldY - (mouseWorldY - state.params.panY) * scaleRatio;
            callbacks.updateParamValue?.('scale', newScale);
        }
    }
    setLastPinchDistance(currentDistance);
}

/**
 * Set up double click (viewer mode)
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {AbortSignal} signal - AbortController signal for cleanup
 */
export function setupDoubleClick(canvas, signal) {
    canvas.addEventListener('dblclick', (e) => {
        if (state.viewerMode) {
            e.preventDefault();
            fitImageToWindow();
            updateUniforms();
            // Shared rule: a 3DTV fit is zoomed by viewerScale alone, so the plain
            // SBS formula reported the mesh fit scale for the double-click fit.
            callbacks.updateViewerZoomDisplay?.(getViewerDisplayScale());
        }
    }, { signal });
}

/**
 * Set up click navigation (viewer mode)
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {AbortSignal} signal - AbortController signal for cleanup
 */
export function setupClickNavigation(canvas, signal) {
    let navClickStartX = null;
    let navClickStartY = null;
    let navHasDragged = false;

    canvas.addEventListener('pointerdown', (e) => {
        navClickStartX = e.clientX;
        navClickStartY = e.clientY;
        navHasDragged = false;
    }, { signal });

    canvas.addEventListener('pointermove', (e) => {
        if (navClickStartX !== null) {
            const dx = Math.abs(e.clientX - navClickStartX);
            const dy = Math.abs(e.clientY - navClickStartY);
            if (dx > 5 || dy > 5) {
                navHasDragged = true;
            }
        }
    }, { signal });

    canvas.addEventListener('click', (e) => {
        if (!state.viewerMode) return;

        // Ignore the click events that make up a double-click (e.detail > 1).
        // dblclick fits to window; without this guard a double-click inside the
        // left/right nav zones also fired prev/next twice, skipping two images.
        if (e.detail > 1) return;

        if (navHasDragged) {
            navHasDragged = false;
            return;
        }

        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const width = rect.width;

        if (x < width / 6) {
            e.preventDefault();
            window.viewerPrevImage?.();
        } else if (x > width * 5 / 6) {
            e.preventDefault();
            window.viewerNextImage?.();
        }
    }, { signal });
}

/**
 * Set up wheel interactions
 * @param {HTMLCanvasElement} canvas - Canvas element
 * @param {AbortSignal} signal - AbortController signal for cleanup
 */
export function setupWheelHandler(canvas, signal) {
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();

        // 3D Pointer depth adjustment (Ctrl+Wheel)
        if (state.pointer3dEnabled && e.ctrlKey) {
            const depthSpeed = 0.00005;
            state.pointer3dParallax += e.deltaY * depthSpeed;
            // Clamp to reasonable range
            state.pointer3dParallax = Math.max(-0.1, Math.min(0.1, state.pointer3dParallax));
            updateUniforms();
            updatePointer3dDepthDisplay();
            return;
        }

        const zoomSpeed = 0.001;
        const zoomDelta = -e.deltaY * zoomSpeed;

        // For SBS/3DTV mode, use the shared handler
        if (applyViewerZoom(zoomDelta)) {
            return;
        }

        // Other modes
        if (state.viewerMode) {
            // Viewer mode (non-SBS): zoom around center
            const oldScale = state.params.scale;
            let newScale = Math.max(0.1, Math.min(10.0, oldScale + zoomDelta));

            state.params.panX = 0;
            state.params.panY = 0;
            callbacks.updateParamValue?.('scale', newScale);
            callbacks.updateViewerZoomDisplay?.(newScale);
        } else {
            // Normal mode: zoom around mouse position
            const oldScale = state.params.scale;
            let newScale = Math.max(0.1, Math.min(getNormalScaleMax(), oldScale + zoomDelta));

            const rect = canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;

            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;

            const ndcX = (mouseX / rect.width) * 2 - 1;
            const ndcY = -(mouseY / rect.height) * 2 + 1;

            const frustumHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
            const aspect = rect.width / rect.height;
            const frustumWidth = frustumHeight * aspect;

            const mouseWorldX = ndcX * (frustumWidth / 2);
            const mouseWorldY = ndcY * (frustumHeight / 2);

            const scaleRatio = newScale / oldScale;

            state.params.panX = mouseWorldX - (mouseWorldX - state.params.panX) * scaleRatio;
            state.params.panY = mouseWorldY - (mouseWorldY - state.params.panY) * scaleRatio;

            callbacks.updateParamValue?.('scale', newScale);
        }
    }, { passive: false, signal });
}

/**
 * Stop slideshow on fullscreen exit
 * @param {AbortSignal} signal - AbortController signal for cleanup
 */
export function setupFullscreenSlideshowHandler(signal) {
    // Use isFullscreenActive() (checks the vendor-prefixed properties) and register
    // the prefixed change events too: listening only for the unprefixed event would
    // never fire on a WebKit-prefixed-only browser (e.g. older iPadOS Safari) that
    // the compat helpers deliberately support, leaving the slideshow running in
    // windowed view with the speed dropdown desynced after exiting fullscreen there.
    const onFullscreenChange = () => {
        if (!isFullscreenActive() && state.viewerMode && state.viewerSlideshowSpeed > 0) {
            const speedSelect = document.getElementById('viewerSlideshowSpeed');
            if (speedSelect) {
                speedSelect.value = '0';
                window.setViewerSlideshowSpeed?.(0);
            }
        }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange, { signal });
    document.addEventListener('webkitfullscreenchange', onFullscreenChange, { signal });
    document.addEventListener('mozfullscreenchange', onFullscreenChange, { signal });
}

/**
 * Set up keyboard interactions
 * @param {AbortSignal} signal - AbortController signal
 */
export function setupKeyboardHandler(signal) {
    window.addEventListener('keydown', (e) => {
        // ESC key
        if (e.key === 'Escape') {
            if (state.viewerMode) {
                // Close the topmost open viewer modal first (help / file list), so
                // Escape dismisses the overlay before it touches fullscreen or the
                // slideshow.
                const viewerHelpModalEl = document.getElementById('viewerHelpModal');
                if (viewerHelpModalEl && viewerHelpModalEl.style.display === 'flex') {
                    viewerHelpModalEl.style.display = 'none';
                    e.preventDefault();
                    return;
                }
                const viewerListModalEl = document.getElementById('viewerListModal');
                if (viewerListModalEl && viewerListModalEl.style.display === 'flex') {
                    viewerListModalEl.style.display = 'none';
                    e.preventDefault();
                    return;
                }

                if (isFullscreenActive()) {
                    exitFullscreenCompat();
                    e.preventDefault();
                    return;
                }

                if (state.viewerSlideshowSpeed > 0) {
                    const speedSelect = document.getElementById('viewerSlideshowSpeed');
                    if (speedSelect) {
                        speedSelect.value = '0';
                        window.setViewerSlideshowSpeed?.(0);
                    }
                    e.preventDefault();
                    return;
                }

                return;
            }

            // Non-viewer mode: let Escape dismiss the EXIF modal too, in addition to
            // the close button and backdrop click.
            const exifModalEl = document.getElementById('exifModal');
            if (exifModalEl && exifModalEl.style.display === 'flex') {
                exifModalEl.style.display = 'none';
                e.preventDefault();
                return;
            }

            if (isFullscreenActive()) {
                return;
            }
        }

        // Viewer mode keyboard navigation
        if (state.viewerMode) {
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                    return;
                }
            }

            // Suppress the image-affecting viewer shortcuts (N/P/S) while a viewer
            // modal/dialog is open, so they do not navigate or mutate the image behind
            // it. The help/list modals open via style.display = 'flex' (closed = 'none',
            // matching the existing 'flex' checks elsewhere), and the exit-confirm dialog
            // exists in the DOM only while open. The list toggle (L) is intentionally left
            // active so the list modal stays dismissable from the keyboard.
            const viewerHelpModalEl = document.getElementById('viewerHelpModal');
            const viewerListModalEl = document.getElementById('viewerListModal');
            const isViewerModalOpen =
                (viewerHelpModalEl && viewerHelpModalEl.style.display === 'flex') ||
                (viewerListModalEl && viewerListModalEl.style.display === 'flex') ||
                !!document.getElementById('viewerExitConfirmDialog');

            // N: Next
            if (e.key === 'n' || e.key === 'N') {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (isViewerModalOpen) return;
                const viewerNextBtn = document.getElementById('viewerNextBtn');
                if (viewerNextBtn && !viewerNextBtn.disabled) {
                    window.viewerNextImage?.();
                }
                e.preventDefault();
                return;
            }

            // P: Previous
            if (e.key === 'p' || e.key === 'P') {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (isViewerModalOpen) return;
                const viewerPrevBtn = document.getElementById('viewerPrevBtn');
                if (viewerPrevBtn && !viewerPrevBtn.disabled) {
                    window.viewerPrevImage?.();
                }
                e.preventDefault();
                return;
            }

            // L: Show list
            if (e.key === 'l' || e.key === 'L') {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                const viewerListModal = document.getElementById('viewerListModal');
                if (viewerListModal && viewerListModal.style.display === 'flex') {
                    viewerListModal.style.display = 'none';
                } else {
                    window.showViewerFileList?.();
                }
                e.preventDefault();
                return;
            }

            // S: Toggle LR
            if (e.key === 's' || e.key === 'S') {
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (isViewerModalOpen) return;
                // Route through the shared swap helper so the keyboard shortcut,
                // the checkbox, and the viewer button perform identical state +
                // UI updates (shift sign, px readout, histogram, checkbox sync,
                // EXIF). Without this the px readout kept its pre-swap sign.
                applySwapLR(!state.params.swapLR);
                // In viewer mode, remember the swap state so navigation preserves it
                // (clearPreviousImageState resets swapLR to the default on each load).
                if (state.viewerMode) {
                    state.viewerSwapLR = state.params.swapLR;
                }
                // Reflect the new state on the viewer swap button's active appearance
                const viewerSwapLRBtn = document.getElementById('viewerSwapLRBtn');
                if (viewerSwapLRBtn) {
                    if (state.params.swapLR) {
                        viewerSwapLRBtn.style.backgroundColor = 'var(--accent-color, #4a9eff)';
                        viewerSwapLRBtn.style.color = 'white';
                    } else {
                        viewerSwapLRBtn.style.backgroundColor = '';
                        viewerSwapLRBtn.style.color = '';
                    }
                    viewerSwapLRBtn.setAttribute('aria-pressed', String(state.params.swapLR));
                }
                e.preventDefault();
                return;
            }
        }

        // D: Toggle 3D Pointer mode (works in both modes)
        if (e.key === 'd' || e.key === 'D') {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
            togglePointer3dMode();
            e.preventDefault();
            return;
        }

        // While a modal overlay sits above the image — the viewer help/list modal,
        // the exit-confirm dialog, or the EXIF modal — the alignment arrows and the
        // +/- zoom keys must not mutate the image underneath it. (N/P/S are already
        // gated on the viewer modals above; the arrow/zoom keys below were not, and
        // the exit-confirm dialog also blocks its own Escape via stopPropagation.)
        const overlayBlockingImageKeys =
            document.getElementById('viewerHelpModal')?.style.display === 'flex' ||
            document.getElementById('viewerListModal')?.style.display === 'flex' ||
            document.getElementById('exifModal')?.style.display === 'flex' ||
            !!document.getElementById('viewerExitConfirmDialog');
        if (overlayBlockingImageKeys) return;

        // Arrow keys are reserved for alignment adjustment, but must not hijack
        // caret movement when the user is editing a text-like field.
        const isArrowKey = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key);

        if (!isArrowKey) {
            // Exclude ALL <input> types (not just text/number): the +/- zoom keys
            // otherwise fired while a range slider, checkbox, or radio was focused,
            // zooming the image when the user meant to adjust the focused control.
            // Matches the arrow-key branch below.
            if (e.target && e.target.tagName === 'INPUT') return;
            if (e.target && e.target.tagName === 'SELECT') return;
            if (e.target && e.target.tagName === 'TEXTAREA') return;
            if (e.target && e.target.isContentEditable) return;
        } else {
            // For arrow keys, only let alignment adjustment run when focus is NOT
            // in a control that uses arrows natively: text-like inputs and
            // contenteditable (caret), <select> (option change), and range sliders
            // (value change). Without the SELECT/range exclusions an arrow key on a
            // focused dropdown or slider was hijacked into a parallax shift and the
            // native control could not be operated by keyboard.
            // Exclude ALL <input> types, not just text/number/range: radio groups
            // (crop-mode, stereo-format dialog) use arrows for native option movement,
            // and hijacking them into a parallax shift both changed alignment
            // unexpectedly and blocked keyboard navigation of the group.
            if (e.target && e.target.tagName === 'INPUT') return;
            if (e.target && e.target.tagName === 'SELECT') return;
            if (e.target && e.target.tagName === 'TEXTAREA') return;
            if (e.target && e.target.isContentEditable) return;
        }

        let changed = false;

        let stepX = 0.0005;
        let stepY = 0.0005;

        if (state.material && state.material.uniforms.map.value && state.material.uniforms.map.value.image) {
            const img = state.material.uniforms.map.value.image;
            const eyeWidth = img.width / 2;
            const eyeHeight = img.height;

            stepX = 1.0 / (2.0 * eyeWidth);
            stepY = 1.0 / eyeHeight;
        }

        const multiplier = e.shiftKey ? 10 : 1;
        const deltaX = stepX * multiplier;
        const deltaY = stepY * multiplier;

        switch(e.key) {
            case 'ArrowLeft':
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                callbacks.updateParamValue?.('shiftX', state.params.shiftX - deltaX);
                changed = true;
                break;
            case 'ArrowRight':
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                callbacks.updateParamValue?.('shiftX', state.params.shiftX + deltaX);
                changed = true;
                break;
            case 'ArrowUp':
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                callbacks.updateParamValue?.('shiftY', state.params.shiftY + deltaY);
                changed = true;
                break;
            case 'ArrowDown':
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                callbacks.updateParamValue?.('shiftY', state.params.shiftY - deltaY);
                changed = true;
                break;
            case '+':
            case ';':
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (state.viewerMode) {
                    // In viewer mode, use the same zoom path as wheel/pinch so the
                    // composite viewerScale/fitScale/pan-reset semantics apply and the
                    // #viewerZoom readout updates, instead of setting scale directly.
                    applyVRZoomDelta(0.1);
                } else {
                    callbacks.updateParamValue?.('scale', state.params.scale + 0.1);
                }
                changed = true;
                break;
            case '-':
            case '_':
                if (e.ctrlKey || e.metaKey || e.altKey) return;
                if (state.viewerMode) {
                    applyVRZoomDelta(-0.1);
                } else {
                    callbacks.updateParamValue?.('scale', state.params.scale - 0.1);
                }
                changed = true;
                break;
        }

        if (changed) e.preventDefault();
    }, { signal });
}
