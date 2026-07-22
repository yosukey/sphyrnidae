/**
 * ui-pointer3d.js
 * 3D Pointer mode UI module
 * - Toggle button click handler
 * - Mouse tracking for pointer position
 * - Depth display update
 * - Coordinate conversion (screen → image UV)
 */

import { state, CONSTANTS, is3DTVActive } from '../globals.js';
import { updateUniforms } from '../rendering/renderer.js';
import { getShaderGroup } from '../rendering/shaders.js';
import * as logger from '../utils/logger.js';

// Callback for depth display update
let callbacks = {
    updatePointer3dDepthDisplay: null
};

// Mouse tracking handler references (for cleanup)
let mouseMoveHandler = null;
let mouseEnterHandler = null;
let mouseLeaveHandler = null;

/**
 * Set callback functions
 * @param {Object} cbs - Callback function object
 */
export function setPointer3dCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

/**
 * Convert whole-mesh UV (vUv) into the per-eye "baseUv" space that the fragment
 * shader uses to draw the pointer. This mirrors `inputProcessingLayout` in
 * shaders.js (layout split + 3DTV fit/zoom + viewer zoom/pan) so the pointer tip
 * lands under the cursor in SBS/TaB/LRL/Matrix layouts, during viewer zoom, and
 * in 3DTV mode.
 *
 * For simple modes (anaglyph/interlace/single-view) the shader uses baseUv = vUv
 * with no transform, so the whole-mesh UV is returned unchanged.
 *
 * @param {number} u - Whole-mesh UV X (0-1)
 * @param {number} v - Whole-mesh UV Y (0-1)
 * @returns {{ u: number, v: number }} baseUv coordinates
 */
function vUvToBaseUv(u, v) {
    const mode = state.params.mode;

    // Simple modes draw the pointer directly in vUv space.
    if (getShaderGroup(mode) !== 'layout') {
        return { u, v };
    }

    // --- Layout split (mirrors the SBS/TaB/LRL/Matrix layout-mode handling in shaders.js) ---
    let bu = u;
    let bv = v;

    if (mode === 3 || mode === 7 || mode === 8 || mode === 9) {
        // SBS: left/right halves
        bu = (u < 0.5) ? u * 2.0 : (u - 0.5) * 2.0;
    } else if (mode === 10 || mode === 16) {
        // Top-and-Bottom: top half is left eye
        bv = (v >= 0.5) ? (v - 0.5) * 2.0 : v * 2.0;
    } else if (mode === 12) {
        // LRL triple
        if (u < (1.0 / 3.0)) {
            bu = u * 3.0;
        } else if (u < (2.0 / 3.0)) {
            bu = (u - (1.0 / 3.0)) * 3.0;
        } else {
            bu = (u - (2.0 / 3.0)) * 3.0;
        }
    } else if (mode === 13) {
        // Matrix 2x2
        bu = (u < 0.5) ? u * 2.0 : (u - 0.5) * 2.0;
        bv = (v >= 0.5) ? (v - 0.5) * 2.0 : v * 2.0;
    }

    // --- 3DTV fit + zoom/pan, or viewer zoom/pan (mirrors the 3DTV fit/zoom-pan logic in shaders.js) ---
    const viewerScale = state.viewerScale || 1.0;
    const viewerPanX = state.viewerPanX || 0.0;
    const viewerPanY = state.viewerPanY || 0.0;

    if (is3DTVActive()) {
        const res = state.material.uniforms.resolution.value;
        const imageAspect = state.material.uniforms.imageAspect.value;

        let regionAspect;
        if (mode === 10 || mode === 16) {
            regionAspect = res.x / (res.y * 0.5);
        } else {
            regionAspect = (res.x * 0.5) / res.y;
        }

        let adjustedImageAspect = imageAspect;
        if (mode === 7) {
            adjustedImageAspect = imageAspect * 0.5;
        } else if (mode === 10) {
            adjustedImageAspect = imageAspect * 2.0;
        }

        let fitScaleX = 1.0;
        let fitScaleY = 1.0;
        if (adjustedImageAspect > regionAspect) {
            fitScaleY = regionAspect / adjustedImageAspect;
        } else {
            fitScaleX = adjustedImageAspect / regionAspect;
        }

        bu = (bu - 0.5) / fitScaleX + 0.5;
        bv = (bv - 0.5) / fitScaleY + 0.5;

        bu = (bu - 0.5) / viewerScale + 0.5;
        bv = (bv - 0.5) / viewerScale + 0.5;
        const panScale3dtv = Math.max(0.0, viewerScale - 1.0);
        bu += viewerPanX * panScale3dtv;
        bv += viewerPanY * panScale3dtv;
    } else if (state.viewerMode) {
        bu = (bu - 0.5) / viewerScale + 0.5;
        bv = (bv - 0.5) / viewerScale + 0.5;
        const panScale = Math.max(0.0, viewerScale - 1.0);
        bu += viewerPanX * panScale;
        bv += viewerPanY * panScale;
        // Shader clamps baseUv to [0,1] in this branch.
        bu = Math.min(Math.max(bu, 0.0), 1.0);
        bv = Math.min(Math.max(bv, 0.0), 1.0);
    }

    return { u: bu, v: bv };
}

/**
 * Convert screen coordinates to image UV for the 3D pointer
 * @param {number} clientX - Mouse client X
 * @param {number} clientY - Mouse client Y
 * @returns {{ u: number, v: number } | null} UV coordinates (0-1) or null if outside image
 */
function screenToPointerUV(clientX, clientY) {
    if (!state.renderer || !state.mesh || !state.material) return null;

    const canvas = state.renderer.domElement;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    // Screen → NDC
    const canvasX = clientX - rect.left;
    const canvasY = clientY - rect.top;
    const ndcX = (canvasX / rect.width) * 2 - 1;
    const ndcY = -(canvasY / rect.height) * 2 + 1;

    // NDC → World
    const frustumHeight = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
    const aspect = rect.width / rect.height;
    const frustumWidth = frustumHeight * aspect;
    const worldX = ndcX * (frustumWidth / 2);
    const worldY = ndcY * (frustumHeight / 2);

    // World → whole-mesh UV (vUv). Use the mesh's actual scale/position so this
    // stays correct in 3DTV mode, where the mesh is stretched to fill the frustum
    // instead of being scaled by baseScale*crop.
    const geomParams = state.mesh.geometry.parameters;
    if (!geomParams) return null;

    const meshW = geomParams.width * state.mesh.scale.x;
    const meshH = geomParams.height * state.mesh.scale.y;

    if (meshW <= 0 || meshH <= 0) return null;

    const meshCenterX = state.mesh.position.x;
    const meshCenterY = state.mesh.position.y;

    const u = (worldX - meshCenterX + meshW / 2) / meshW;
    const v = (worldY - meshCenterY + meshH / 2) / meshH;

    // Cursor outside the displayed mesh entirely.
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    // Map whole-mesh UV into the shader's per-eye baseUv space so the pointer tip
    // aligns with the cursor in layout / viewer-zoom / 3DTV cases.
    const base = vUvToBaseUv(u, v);
    if (base.u < 0 || base.u > 1 || base.v < 0 || base.v > 1) return null;
    return { u: base.u, v: base.v };
}

/**
 * Update canvas cursor visibility based on 3D pointer state
 */
function updateCanvasCursor() {
    const canvas = state.renderer?.domElement;
    if (!canvas) return;

    if (state.pointer3dEnabled) {
        canvas.style.cursor = 'none';
    } else {
        canvas.style.cursor = 'default';
    }
}

/**
 * Toggle 3D pointer mode on/off
 */
export function togglePointer3dMode() {
    state.pointer3dEnabled = !state.pointer3dEnabled;

    if (!state.pointer3dEnabled) {
        state.pointer3dVisible = false;
        state.pointer3dParallax = 0.0;
    }

    updateCanvasCursor();
    updatePointer3dButtonState();
    updatePointer3dDepthDisplay();
    updateUniforms();

    logger.debug('UI_LOG', 'Pointer3D', `3D Pointer mode ${state.pointer3dEnabled ? 'enabled' : 'disabled'}`);
}

/**
 * Update the visual state of the 3D pointer toggle button(s)
 */
function updatePointer3dButtonState() {
    const viewerBtn = document.getElementById('viewerPointer3dBtn');
    if (viewerBtn) {
        if (state.pointer3dEnabled) {
            viewerBtn.style.backgroundColor = 'var(--accent-color, #4a9eff)';
            viewerBtn.style.color = 'white';
        } else {
            viewerBtn.style.backgroundColor = '';
            viewerBtn.style.color = '';
        }
        // Expose toggle state to assistive tech (the color alone is invisible to AT).
        viewerBtn.setAttribute('aria-pressed', String(!!state.pointer3dEnabled));
    }
}

/**
 * Update the depth display in the viewer bar
 */
export function updatePointer3dDepthDisplay() {
    const depthContainer = document.getElementById('viewerDepth');
    const depthValueEl = document.getElementById('viewerDepthValue');

    if (depthContainer) {
        depthContainer.style.display = state.pointer3dEnabled ? '' : 'none';
    }

    if (depthValueEl && state.material && state.material.uniforms.map.value) {
        const img = state.material.uniforms.map.value.image;
        if (img) {
            // The shader shifts only the right-eye pointer by `parallax` in baseUv
            // space (drawPointer3d: pos.x += parallax), and one baseUv x-unit spans
            // the full per-eye width, so the L/R pointer disparity is
            // parallax * eyeWidth px. No extra x2 here: that factor belongs to
            // shiftX (whose shader applies srcR.x -= shiftX * 2.0), not the pointer.
            const eyeWidth = img.width / 2;
            const pxValue = state.pointer3dParallax * eyeWidth;
            depthValueEl.textContent = pxValue.toFixed(1);
        }
    }
}

/**
 * Handle mouse move for pointer tracking
 * @param {MouseEvent} e - Mouse event
 */
function handlePointerMouseMove(e) {
    if (!state.pointer3dEnabled) return;

    const uv = screenToPointerUV(e.clientX, e.clientY);
    if (uv) {
        state.pointer3dX = uv.u;
        state.pointer3dY = uv.v;
        state.pointer3dVisible = true;
    } else {
        state.pointer3dVisible = false;
    }
    updateUniforms();
}

/**
 * Handle mouse enter on canvas
 */
function handlePointerMouseEnter() {
    if (state.pointer3dEnabled) {
        state.pointer3dVisible = true;
        // Hide system cursor when entering canvas with pointer mode active
        const canvas = state.renderer?.domElement;
        if (canvas) canvas.style.cursor = 'none';
        updateUniforms();
    }
}

/**
 * Handle mouse leave on canvas
 */
function handlePointerMouseLeave() {
    state.pointer3dVisible = false;
    // Restore cursor when leaving canvas
    const canvas = state.renderer?.domElement;
    if (canvas && state.pointer3dEnabled) {
        canvas.style.cursor = 'default';
    }
    updateUniforms();
}

/**
 * Set up 3D pointer controls
 * @param {AbortSignal} signal - AbortController signal for cleanup
 */
export function setupPointer3dControls(signal) {
    const canvas = state.renderer?.domElement;
    if (!canvas) return;

    // Mouse tracking for pointer position
    mouseMoveHandler = handlePointerMouseMove;
    mouseEnterHandler = handlePointerMouseEnter;
    mouseLeaveHandler = handlePointerMouseLeave;

    canvas.addEventListener('mousemove', mouseMoveHandler, { signal });
    canvas.addEventListener('mouseenter', mouseEnterHandler, { signal });
    canvas.addEventListener('mouseleave', mouseLeaveHandler, { signal });

    // Viewer mode toggle button
    const viewerBtn = document.getElementById('viewerPointer3dBtn');
    if (viewerBtn) {
        viewerBtn.addEventListener('click', () => {
            togglePointer3dMode();
        }, { signal });
    }
}

/**
 * Clean up 3D pointer controls
 */
export function cleanupPointer3dControls() {
    state.pointer3dEnabled = false;
    state.pointer3dVisible = false;
    state.pointer3dParallax = 0.0;
    // Restore cursor
    const canvas = state.renderer?.domElement;
    if (canvas) canvas.style.cursor = 'default';
    mouseMoveHandler = null;
    mouseEnterHandler = null;
    mouseLeaveHandler = null;

    // Push the disabled state to the shader and button so the pointer actually
    // clears and the toggle button de-highlights (state flags alone are not enough).
    updatePointer3dButtonState();
    updateUniforms();
}
