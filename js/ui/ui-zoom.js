/**
 * ui-zoom.js
 * Zoom display features
 * - Zoom display in normal mode
 * - Zoom display in viewer mode
 * - Zoom display in 3DTV mode
 */

import { state, getModeLayout, is3DTVActive, CONSTANTS } from '../globals.js';
import { isTaBMode } from '../mode-utils.js';
import * as logger from '../utils/logger.js';

/**
 * Update zoom display (top-right panel)
 * Always display zoom relative to the original image (one eye)
 */
export function updateZoomDisplay() {
    const label = document.getElementById('valZoomDisplay');
    if (!label) return;

    if (!state.material || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image || !state.mesh) {
        label.textContent = "100%";
        return;
    }

    const texture = state.material.uniforms.map.value;
    const imgW = texture.image.width;
    const imgH = texture.image.height;

    const eyeWidth = imgW / 2;

    const mode = state.params.mode;
    const layout = getModeLayout(mode);

    // Original image frame width (before crop)
    const originalFrameWidthPx = eyeWidth * layout.wMul;

    const canvas = state.renderer.domElement;
    const canvasWidth = canvas.clientWidth;
    const canvasHeight = canvas.clientHeight;

    if (canvasHeight <= 0) {
        label.textContent = "100%";
        return;
    }

    const frustumH = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
    const frustumW = frustumH * (canvasWidth / canvasHeight);

    const geomParams = state.mesh.geometry.parameters;
    if (!geomParams) {
        logger.warn('UIZoom','[UI-Zoom] geometry.parameters is null (non-parametric geometry)');
        return;
    }
    const geomW = geomParams.width;
    const baseScaleX = state.mesh.userData.baseScaleX || 1.0;

    // Actual display width including cropRatioX
    const cropRatioX = 1.0 - state.params.cropX;

    if (originalFrameWidthPx <= 0 || cropRatioX <= 0) {
        label.textContent = "- %";
        return;
    }

    const worldWidth = geomW * baseScaleX * state.params.scale * cropRatioX;

    const displayedPixelWidth = worldWidth * (canvasWidth / frustumW);

    // Divide the post-crop display pixel width by the original pixel width
    // Divide by cropRatioX to get zoom based on the original image
    const zoomRatio = (displayedPixelWidth / cropRatioX) / originalFrameWidthPx;
    const zoomPercent = Math.round(zoomRatio * 100) + "%";

    // Zoom display in the right menu (status panel)
    label.textContent = zoomPercent;

    // Match the left menu (under slider) zoom display to the same %
    const valScale = document.getElementById('valScale');
    if (valScale) {
        valScale.textContent = zoomPercent;
    }
}

/**
 * Update zoom display in viewer mode
 * @param {number} scale - Current scale value
 */
export function updateViewerZoomDisplay(scale) {
    // In 3DTV mode, update regardless of viewerMode
    const is3dtvMode = is3DTVActive();
    if (!state.viewerMode && !is3dtvMode) return;

    const viewerZoom = document.getElementById('viewerZoom');
    if (!viewerZoom) return;

    if (!state.material || !state.material.uniforms.map.value || !state.material.uniforms.map.value.image || !state.mesh) {
        viewerZoom.textContent = "100%";
        return;
    }

    const texture = state.material.uniforms.map.value;
    const imgW = texture.image.width;
    const imgH = texture.image.height;

    const eyeWidth = imgW / 2;
    const eyeHeight = imgH;
    const mode = state.params.mode;
    const layout = getModeLayout(mode);

    const originalFrameWidthPx = eyeWidth * layout.wMul;

    const canvas = state.renderer.domElement;
    const canvasWidth = canvas.clientWidth;
    const canvasHeight = canvas.clientHeight;

    if (canvasHeight <= 0) {
        viewerZoom.textContent = "100%";
        return;
    }

    if (is3dtvMode) {
        // Zoom calculation for 3DTV mode
        // scale parameter receives viewerScale

        // One-eye region size (pixels)
        let regionWidthPx, regionHeightPx;
        if (isTaBMode(mode)) {
            // TaB types: split vertically
            regionWidthPx = canvasWidth;
            regionHeightPx = canvasHeight / 2;
        } else {
            // SBS types: split horizontally
            regionWidthPx = canvasWidth / 2;
            regionHeightPx = canvasHeight;
        }

        // Image aspect ratio (adjust based on mode)
        let adjustedImageAspect = eyeWidth / eyeHeight;
        if (mode === 7) {
            adjustedImageAspect *= 0.5;  // Half SBS: horizontal compression
        } else if (mode === 10) {
            adjustedImageAspect *= 2.0;  // Half TaB: vertical compression
        }

        // One-eye region aspect ratio
        const regionAspect = regionWidthPx / regionHeightPx;

        // Calculate fitted display size (equivalent to shader fitScaleX/fitScaleY)
        let displayWidthPx;
        if (adjustedImageAspect > regionAspect) {
            // Image is wide: fit width
            displayWidthPx = regionWidthPx;
        } else {
            // Image is tall: fit height, shrink width
            displayWidthPx = regionHeightPx * adjustedImageAspect;
        }

        // Apply viewerScale (equivalent to UV scaling in shader)
        displayWidthPx *= scale;

        // Zoom calculation
        if (originalFrameWidthPx <= 0) {
            if (viewerZoom) viewerZoom.textContent = "100%";
            return;
        }

        const zoomRatio = displayWidthPx / originalFrameWidthPx;
        const zoomPercent = Math.round(zoomRatio * 100);
        const zoomText = `${zoomPercent}%`;

        // In 3DTV mode, update all zoom display elements
        if (viewerZoom) viewerZoom.textContent = zoomText;
        const valScale = document.getElementById('valScale');
        if (valScale) valScale.textContent = zoomText;
        const valZoomDisplay = document.getElementById('valZoomDisplay');
        if (valZoomDisplay) valZoomDisplay.textContent = zoomText;
        return;
    } else {
        // Zoom calculation in normal mode
        const frustumH = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        const frustumW = frustumH * (canvasWidth / canvasHeight);

        const geomW = state.mesh.geometry.parameters?.width;
        if (!geomW) {
            viewerZoom.textContent = "100%";
            return;
        }
        const baseScaleX = state.mesh.userData.baseScaleX || 1.0;

        const cropRatioX = 1.0 - state.params.cropX;

        if (originalFrameWidthPx <= 0 || cropRatioX <= 0) {
            viewerZoom.textContent = "- %";
            return;
        }

        const worldWidth = geomW * baseScaleX * scale * cropRatioX;

        const displayedPixelWidth = worldWidth * (canvasWidth / frustumW);

        const zoomRatio = (displayedPixelWidth / cropRatioX) / originalFrameWidthPx;
        const zoomPercent = Math.round(zoomRatio * 100);
        viewerZoom.textContent = `${zoomPercent}%`;
    }
}
