/**
 * histogram.js
 * Histogram calculation and auto-level correction
 *
 * In histogram calculations, isLeftEye refers to the logical left eye.
 * swapLR (left/right swap) effect:
 *   - swapLR=false: physical left = logical left, physical right = logical right
 *   - swapLR=true: physical left = logical right, physical right = logical left
 * This mapping is required in the fallback path (2D canvas).
 */

import * as THREE from 'three';
import { state, CONSTANTS } from '../globals.js';
import { updateUniforms } from '../rendering/renderer.js';
import { vertexShader, getFragmentShaderCached, getShaderGroup } from '../rendering/shaders.js';
import * as logger from '../utils/logger.js';
import {
    buildHistogramFromData,
    calculateHistogramStats,
    downsampleForHistogram,
    croppedEyeDimensions
} from './histogram-math.js';

// The pure histogram math (bin counting, stats, downsample sizing, cropped-eye
// dimensions) lives in histogram-math.js so it can be unit-tested under Node
// (this file imports three/globals and cannot). Re-export calculateHistogramStats
// so existing callers that import it from histogram.js keep working.
export { calculateHistogramStats };

// Histogram cache for cropOnly=false
// histogram: histogram data, stats: statistics
const histogramCache = {
    left: null,
    right: null,
    paramsHash: null
};

// Histogram cache for cropOnly=true (includes shift/crop values)
const cropHistogramCache = {
    left: null,
    right: null,
    paramsHash: null
};

// Persistent ShaderMaterials for the offscreen histogram passes, keyed by shader
// group. These are created once and reused (never disposed) for the lifetime of
// the app. Creating and disposing a ShaderMaterial on every histogram pass would
// release the underlying GPU program each time, forcing the single-eye shader to
// recompile on every histogram update. That synchronous recompile blocks the main
// thread (the "press histogram, nothing happens, wait, then it appears" delay)
// and re-emits the shader-compile warnings repeatedly.
const histogramMaterialCache = new Map(); // shader group -> THREE.ShaderMaterial

/**
 * Get (or lazily create) the persistent histogram material for a temp mode.
 * The uniforms object is shared with the main material; because a fresh uniforms
 * object is created on every new image load, it is re-synced here so the cached
 * material always reads the current image's uniform values.
 * @param {number} tempMode - Temporary display mode (4=left-only, 5=right-only)
 * @param {Object} uniforms - The main material's uniforms object to share
 * @returns {THREE.ShaderMaterial}
 */
function getHistogramMaterial(tempMode, uniforms) {
    const group = getShaderGroup(tempMode);
    let material = histogramMaterialCache.get(group);
    if (!material) {
        material = new THREE.ShaderMaterial({
            uniforms,
            vertexShader,
            fragmentShader: getFragmentShaderCached(tempMode),
            transparent: true
        });
        histogramMaterialCache.set(group, material);
    } else if (material.uniforms !== uniforms) {
        // Keep the shared uniforms reference in sync with the current main
        // material. Reassigning .uniforms does not trigger a recompile (the
        // program is keyed by shader source, which is unchanged).
        material.uniforms = uniforms;
    }
    return material;
}

/**
 * Precompile the single-eye histogram shader program so the first histogram
 * request does not pay a synchronous shader-compilation stall on the main
 * thread. Call this once per image load (after the main material exists).
 *
 * Uses renderer.compileAsync() when available (parallel shader compile, off the
 * main thread); otherwise falls back to a synchronous compile. Safe to call
 * repeatedly: the program is cached after the first compile.
 */
export function warmUpHistogramShader() {
    if (!state.renderer || !state.camera || !state.material || !state.mesh) {
        return;
    }
    try {
        // mode 4 (left-only) resolves to the same single-view shader group used
        // by both the left (mode 4) and right (mode 5) histogram passes, so
        // warming it covers both.
        const material = getHistogramMaterial(4, state.material.uniforms);

        // compileAsync/compile operate on a scene graph, so wrap the material in
        // a throwaway scene + mesh. The geometry is shared with the main mesh and
        // must NOT be disposed; the material is cached and must NOT be disposed.
        const warmScene = new THREE.Scene();
        const warmMesh = new THREE.Mesh(state.mesh.geometry, material);
        warmScene.add(warmMesh);

        const cleanup = () => warmScene.remove(warmMesh);

        if (typeof state.renderer.compileAsync === 'function') {
            state.renderer.compileAsync(warmScene, state.camera)
                .then(cleanup)
                .catch((err) => {
                    logger.warn('Histogram', 'Async shader warm-up failed:', err);
                    cleanup();
                });
        } else {
            state.renderer.compile(warmScene, state.camera);
            cleanup();
        }
    } catch (err) {
        logger.warn('Histogram', 'Shader warm-up failed:', err);
    }
}

/**
 * Compute a hash of image adjustment parameters (for cache validation)
 */
function getQualityParamsHash() {
    const p = state.params;
    // Include the image-quality parameters. shift/crop/offset are excluded because
    // the cropOnly=false render forces them to 0; alignTransform is included because
    // that render does NOT reset it (the full-image pass still applies the alignment
    // warp), so a rotation/zoom/alignment change must invalidate this cache.
    return JSON.stringify({
        brightnessL: p.brightnessL,
        brightnessR: p.brightnessR,
        contrastL: p.contrastL,
        contrastR: p.contrastR,
        saturationL: p.saturationL,
        saturationR: p.saturationR,
        hueL: p.hueL,
        hueR: p.hueR,
        sharpnessL: p.sharpnessL,
        sharpnessR: p.sharpnessR,
        noiseReductionL: p.noiseReductionL,
        noiseReductionR: p.noiseReductionR,
        swapLR: p.swapLR,
        alignTransform: p.alignTransform
    });
}

/**
 * Compute parameter hash for cropOnly=true (includes shift/crop values)
 */
function getCropParamsHash() {
    const p = state.params;
    return JSON.stringify({
        brightnessL: p.brightnessL,
        brightnessR: p.brightnessR,
        contrastL: p.contrastL,
        contrastR: p.contrastR,
        saturationL: p.saturationL,
        saturationR: p.saturationR,
        hueL: p.hueL,
        hueR: p.hueR,
        sharpnessL: p.sharpnessL,
        sharpnessR: p.sharpnessR,
        noiseReductionL: p.noiseReductionL,
        noiseReductionR: p.noiseReductionR,
        swapLR: p.swapLR,
        shiftX: p.shiftX,
        shiftY: p.shiftY,
        cropX: p.cropX,
        cropY: p.cropY,
        offsetX: p.offsetX,
        offsetY: p.offsetY,
        // The crop render keeps the alignment matrix active (the shader applies it
        // in the single-eye modes 4/5), so a rotation/vertical-zoom/vertical-affine
        // change must invalidate this cache. Without it the panel could redraw a
        // stale histogram after Auto-Align adopts a roll/zoom matrix while shiftX/
        // shiftY stay unchanged. JSON.stringify serializes the 9-element array.
        alignTransform: p.alignTransform
    });
}

/**
 * Clear histogram cache (called on image load, etc.)
 */
export function clearHistogramCache() {
    histogramCache.left = null;
    histogramCache.right = null;
    histogramCache.paramsHash = null;
    cropHistogramCache.left = null;
    cropHistogramCache.right = null;
    cropHistogramCache.paramsHash = null;
}

/**
 * Render to offscreen WebGLRenderTarget and read pixel data
 * This avoids modifying the main renderer state
 * @param {number} width - Render width
 * @param {number} height - Render height
 * @param {number} tempMode - Temporary display mode (4=left-only, 5=right-only)
 * @param {Object} tempUniforms - Temporary uniform values (optional)
 * @param {boolean} fitMeshToTarget - If true, render with a camera whose frustum
 *   exactly matches the mesh geometry (mesh transform temporarily reset), so the
 *   image fills the render target with no letterbox padding and independent of
 *   the current zoom/pan/fit/display-mode scale. The main camera's frustum is
 *   sized for the canvas container, so rendering with it leaves black bars
 *   whenever the container aspect differs from the image aspect — those bars
 *   would otherwise be counted as real pixels.
 * @returns {Uint8Array|null} Pixel data or null on failure
 */
function renderToOffscreenTarget(width, height, tempMode, tempUniforms = {}, fitMeshToTarget = false) {
    if (!state.renderer || !state.scene || !state.camera || !state.material || !state.material.uniforms || !state.mesh) {
        // state.material.uniforms is absent for the plain MeshBasicMaterial fallback
        // installed after a failed WebGL context restore; without this guard the
        // originalMaterial.uniforms.mode.value read below (outside the try) throws a
        // raw TypeError instead of honoring the documented "return null on failure".
        logger.error('Histogram', 'Renderer, scene, camera, shader material (uniforms), or mesh not available');
        return null;
    }

    // Neutralize on-screen-only overlays for histogram passes so the readback
    // reflects true image tones, not the dimmed/decorated display result:
    // - intensity=1.0 removes the global 0.85 display dimming
    // - gridEnabled/textEnabled/pointer3dEnabled=0 keep the alignment grid, text
    //   overlay and 3D pointer out of the measured pixels (they would otherwise
    //   skew min/max/median and corrupt Auto Levels).
    // These are saved and restored via originalUniforms below. Callers may still
    // override any of them explicitly (their values win via the spread).
    tempUniforms = {
        intensity: 1.0,
        gridEnabled: 0.0,
        textEnabled: 0.0,
        pointer3dEnabled: 0.0,
        ...tempUniforms
    };

    let renderTarget = null;
    let pixelBuffer = null;
    const originalMaterial = state.material;
    const originalMode = originalMaterial.uniforms.mode.value;
    const originalUniforms = {};
    for (const key in tempUniforms) {
        if (originalMaterial.uniforms[key]) {
            originalUniforms[key] = originalMaterial.uniforms[key].value;
        }
    }
    const savedMeshScale = state.mesh.scale.clone();
    const savedMeshPosition = state.mesh.position.clone();

    const restoreMeshTransform = () => {
        if (fitMeshToTarget && state.mesh) {
            state.mesh.scale.copy(savedMeshScale);
            state.mesh.position.copy(savedMeshPosition);
        }
    };

    try {
        // Create offscreen render target
        renderTarget = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType
        });

        // Use the persistent, per-shader-group histogram material instead of
        // rebuilding the main shader or creating a throwaway material. This keeps
        // the GPU program alive across histogram passes, so it is compiled once
        // (ideally at warm-up time) rather than recompiled on every call. The
        // uniforms object is shared, so changes to uniform values are visible to
        // both materials; we restore the values afterward.
        const tempMaterial = getHistogramMaterial(tempMode, originalMaterial.uniforms);

        // Set temporary uniform values
        originalMaterial.uniforms.mode.value = tempMode;
        for (const key in tempUniforms) {
            if (originalMaterial.uniforms[key]) {
                originalMaterial.uniforms[key].value = tempUniforms[key];
            }
        }

        // Swap the mesh material temporarily (do NOT touch state.material or currentShaderGroup)
        state.mesh.material = tempMaterial;

        // When requested, neutralize the mesh transform (display fit/zoom/pan and
        // the display mode's baseScale) and use a camera whose frustum matches
        // the plane geometry exactly, so the rendered image fills the target.
        let camera = state.camera;
        if (fitMeshToTarget) {
            const geomW = state.mesh.geometry.parameters.width;
            const geomH = state.mesh.geometry.parameters.height;
            camera = new THREE.OrthographicCamera(
                -geomW / 2, geomW / 2, geomH / 2, -geomH / 2, 0.1, 1000
            );
            camera.position.z = 5;
            state.mesh.scale.set(1, 1, 1);
            state.mesh.position.set(0, 0, 0);
        }

        // Render to offscreen target
        state.renderer.setRenderTarget(renderTarget);
        state.renderer.render(state.scene, camera);

        // Read pixels from render target
        pixelBuffer = new Uint8Array(width * height * 4);
        state.renderer.readRenderTargetPixels(renderTarget, 0, 0, width, height, pixelBuffer);

        // Restore render target to null (back to screen)
        state.renderer.setRenderTarget(null);

        // Restore original material, mesh transform, and uniform values
        restoreMeshTransform();
        state.mesh.material = originalMaterial;
        originalMaterial.uniforms.mode.value = originalMode;
        for (const key in originalUniforms) {
            if (originalMaterial.uniforms[key]) {
                originalMaterial.uniforms[key].value = originalUniforms[key];
            }
        }

        // Dispose the render target only. The histogram material is persistent
        // (cached and reused) and must not be disposed, or its GPU program would
        // be released and recompiled on the next pass.
        renderTarget.dispose();

        return pixelBuffer;
    } catch (err) {
        logger.error('Histogram', 'Error rendering to offscreen target:', err);

        // Cleanup on error
        if (renderTarget) {
            state.renderer.setRenderTarget(null);
            renderTarget.dispose();
        }

        // Restore original material and transform on the mesh
        restoreMeshTransform();
        if (state.mesh && originalMaterial) {
            state.mesh.material = originalMaterial;
        }

        // Restore original uniform values
        if (originalMaterial && originalMaterial.uniforms) {
            originalMaterial.uniforms.mode.value = originalMode;
            for (const key in originalUniforms) {
                if (originalMaterial.uniforms[key]) {
                    originalMaterial.uniforms[key].value = originalUniforms[key];
                }
            }
        }

        // Note: the histogram material is persistent (cached) and intentionally
        // not disposed here.

        return null;
    }
}

/**
 * Build quality-uniform overrides that reset image adjustments for one eye.
 * Used by useRawImage=true callers (e.g. auto-levels) so the histogram
 * reflects the source pixels rather than the currently-displayed result.
 */
function buildRawImageUniformOverrides(isLeftEye) {
    const side = isLeftEye ? 'L' : 'R';
    return {
        [`brightness${side}`]: 0,
        [`contrast${side}`]: 1,
        [`saturation${side}`]: 1,
        [`hue${side}`]: 0,
        [`sharpness${side}`]: 0,
        [`noiseReduction${side}`]: 0
    };
}

/**
 * Calculate histogram from an image
 * @param {HTMLImageElement} image - Original image element
 * @param {boolean} isLeftEye - True for left eye, false for right eye
 * @param {boolean} cropOnly - If true, calculate only the displayed area after shift/crop
 * @param {boolean} useRawImage - If true, bypass current image-quality adjustments and the
 *   histogram cache so the result reflects the source pixels (used by auto-levels for
 *   idempotent behavior).
 * @returns {Object} Histogram data
 */
export function calculateHistogram(image, isLeftEye, cropOnly = false, useRawImage = false) {
    try {
        // Validate input
        if (!image) {
            logger.error('Histogram','[Histogram] Invalid image provided');
            return null;
        }

        // cropOnly=true: compute histogram from display area after shift/crop
        if (cropOnly && state.renderer && state.renderer.domElement && state.material) {
            // Check cache validity (cache is bypassed when useRawImage=true since
            // those results do not reflect the user's current adjustments)
            const currentHash = getCropParamsHash();
            const cacheKey = isLeftEye ? 'left' : 'right';

            if (!useRawImage) {
                // If parameter hash changed, clear both caches
                if (cropHistogramCache.paramsHash !== currentHash) {
                    cropHistogramCache.left = null;
                    cropHistogramCache.right = null;
                    cropHistogramCache.paramsHash = null;
                }

                if (cropHistogramCache.paramsHash === currentHash && cropHistogramCache[cacheKey]) {
                    // If cache is valid, return cached histogram
                    return cropHistogramCache[cacheKey];
                }
            }

            // When cropOnly=true, determine appropriate base dimensions:
            // - If actual cropping is active (cropX≠0 or cropY≠0): calculate cropped image size
            //   This represents the actual image area after cropping.
            // - If no cropping (cropX=0 and cropY=0): use original image size
            //   This matches cropOnly=false behavior, ensuring histogram consistency.
            //   Shift/offset parameters only move the image and add black padding; they don't
            //   change the actual image content, so histogram should remain identical.
            // Use epsilon comparison to handle floating-point precision issues
            const EPSILON = 1e-10;
            const isCroppingActive = Math.abs(state.params.cropX) > EPSILON || Math.abs(state.params.cropY) > EPSILON;

            // Get original image size (needed for both cropping and non-cropping cases)
            const texture = state.material.uniforms.map.value;
            if (!texture || !texture.image) {
                logger.warn('Histogram', 'Texture not available for histogram calculation');
                return null;
            }
            const originalImageWidth = texture.image.width;
            const originalImageHeight = texture.image.height;
            const eyeWidth = Math.floor(originalImageWidth / 2);  // Per-eye width
            const eyeHeight = originalImageHeight;

            let baseWidth, baseHeight;

            if (isCroppingActive) {
                // Active cropping: compute the cropped single-eye size with the
                // SAME even-snapped rounding used for the displayed cropped
                // resolution (renderer.js updateCroppedResolution) and the exported
                // image (ui-export.js). Using the shared croppedEyeDimensions helper
                // keeps the "Pixels:" count and the render size consistent with what
                // the user sees and exports, instead of plain Math.floor, which can
                // disagree by up to ~2px.
                ({ width: baseWidth, height: baseHeight } =
                    croppedEyeDimensions(eyeWidth, eyeHeight, state.params.cropX, state.params.cropY));
            } else {
                // No cropping: Use original image size (match cropOnly=false)
                baseWidth = eyeWidth;
                baseHeight = eyeHeight;
            }

            // Calculate original pixel count (before downsampling)
            const originalPixelCount = baseWidth * baseHeight;

            // Render at the image's OWN pixel grid (cropped or full), capped to
            // MAX_HISTOGRAM_SIZE — in both cases the mesh is fitted to the target
            // (below), so the readback is a deterministic sampling of the actual
            // image content. Rendering the cropping case at the on-screen canvas size
            // through the display camera instead would make the histogram depend on
            // the current zoom/pan and window shape, resampling the content through
            // the whole canvas.
            let { width: renderWidth, height: renderHeight } =
                downsampleForHistogram(baseWidth, baseHeight, CONSTANTS.MAX_HISTOGRAM_SIZE);

            // Temporarily render in left-only (mode=4) or right-only (mode=5)
            const tempMode = isLeftEye ? 4 : 5;

            // Prepare temporary uniforms
            // When no cropping: Reset shift/crop/offset to 0, ensuring we render the full image
            // When cropping is active: Use current state values (empty object means no override)
            const tempUniforms = isCroppingActive ? {} : {
                shiftX: 0,
                shiftY: 0,
                cropX: 0,
                cropY: 0,
                offsetX: 0,
                offsetY: 0
            };

            // For raw-image histogram, neutralize the eye-side image-adjustment uniforms
            if (useRawImage) {
                Object.assign(tempUniforms, buildRawImageUniformOverrides(isLeftEye));
            }

            // Render to offscreen target (no main renderer state modification).
            // Always fit the mesh to the target: the full mesh is rendered through
            // the single-eye shader with an orthographic camera matching the mesh
            // geometry and the mesh transform reset, so neither the window aspect
            // (letterbox padding) nor the current zoom/pan/fit can leak into the
            // readback. When cropping is active the crop/offset (and shift/align)
            // uniforms are kept, so the shader maps the full mesh onto the cropped
            // sub-window and the cropped content fills the target with no padding.
            // This measures the same per-eye, crop/offset/shift/alignment-adjusted
            // content the exporter samples (the exporter's fit-to-target framing is
            // mathematically equivalent) — here at reduced resolution and without
            // the exporter's per-mode compositing (SBS/TaB/anaglyph/…) or overlays.
            const pixelData = renderToOffscreenTarget(renderWidth, renderHeight, tempMode, tempUniforms, true);

            if (!pixelData) {
                logger.warn('Histogram', 'Failed to render to offscreen target (cropOnly=true)');
                return null;
            }

            // Count every pixel (do NOT skip black). Because the mesh is fitted to
            // the target in all cases there is no letterbox padding to exclude, and
            // a proper crop already trims the shift-induced border. Skipping black
            // would drop genuine dark content of the image and bias min/mean/median
            // — and any residual border black would also appear in the exporter's
            // per-eye output, so counting it keeps the histogram consistent with it.
            const histogram = buildHistogramFromData(pixelData, false, originalPixelCount);

            // Save cache (skip when useRawImage to avoid polluting the regular cache)
            if (!useRawImage) {
                cropHistogramCache[cacheKey] = histogram;
                cropHistogramCache.paramsHash = currentHash;
            }

            return histogram;
        }

        // cropOnly=false: compute histogram from full image with adjustments (no shift/crop)
        // Use WebGL renderer to get image with adjustments applied
        if (state.renderer && state.renderer.domElement && state.material) {
            // Check cache validity (cache is bypassed when useRawImage=true since
            // those results do not reflect the user's current adjustments)
            const currentHash = getQualityParamsHash();
            const cacheKey = isLeftEye ? 'left' : 'right';

            if (!useRawImage) {
                // If parameter hash changed, clear both caches
                if (histogramCache.paramsHash !== currentHash) {
                    histogramCache.left = null;
                    histogramCache.right = null;
                    histogramCache.paramsHash = null;
                }

                if (histogramCache.paramsHash === currentHash && histogramCache[cacheKey]) {
                    // If cache is valid, return cached histogram
                    return histogramCache[cacheKey];
                }
            }

            // Get original image size
            const texture = state.material.uniforms.map.value;
            if (!texture || !texture.image) {
                return null;
            }
            const originalImageWidth = texture.image.width;
            const originalImageHeight = texture.image.height;
            const eyeWidth = Math.floor(originalImageWidth / 2);
            const eyeHeight = originalImageHeight;

            // Downsample for histogram calculation to save memory
            let { width: renderWidth, height: renderHeight } = downsampleForHistogram(eyeWidth, eyeHeight, CONSTANTS.MAX_HISTOGRAM_SIZE);

            // Calculate original pixel count (before downsampling)
            const originalPixelCount = eyeWidth * eyeHeight;

            // Temporarily render in left-only (mode=4) or right-only (mode=5)
            const tempMode = isLeftEye ? 4 : 5;

            // Temporarily set shift/crop to 0 and apply only image adjustments
            const tempUniforms = {
                shiftX: 0,
                shiftY: 0,
                cropX: 0,
                cropY: 0,
                offsetX: 0,
                offsetY: 0
            };

            // For raw-image histogram, neutralize the eye-side image-adjustment uniforms
            if (useRawImage) {
                Object.assign(tempUniforms, buildRawImageUniformOverrides(isLeftEye));
            }

            // Render to offscreen target (no main renderer state modification).
            // Fit the mesh to the target so the full image fills the readback:
            // without this, the display camera letterboxes the image (window
            // aspect vs image aspect) and the current zoom/pan would leak into
            // a histogram that is supposed to cover the whole image.
            const pixelData = renderToOffscreenTarget(renderWidth, renderHeight, tempMode, tempUniforms, true);

            if (!pixelData) {
                logger.warn('Histogram', 'Failed to render to offscreen target (cropOnly=false)');
                return null;
            }

            // No padding is generated in this path (shift/crop/offset are forced
            // to 0 and the mesh is fitted to the target), so count every pixel -
            // including genuine dark areas of the source image.
            const histogram = buildHistogramFromData(pixelData, false, originalPixelCount);

            // Update cache (skip when useRawImage to avoid polluting the regular cache)
            if (!useRawImage) {
                histogramCache[cacheKey] = histogram;
                histogramCache.paramsHash = currentHash;
            }

            return histogram;
        }

        // Fallback: if WebGL unavailable, compute directly from original image (no adjustments)
        //
        // Limitation: this degraded path cannot reproduce the shader crop. The crop
        // window is applied in the shader AFTER the per-eye shift and the (optional)
        // alignment matrix, and this path applies neither (nor any image-quality
        // adjustment). Honoring cropX/cropY here without the shift/alignment would
        // crop the wrong region for the shift-target eye, so we intentionally return
        // the FULL per-eye histogram and surface a warning, rather than silently
        // presenting mis-cropped data as "crop area only".
        if (cropOnly &&
            (Math.abs(state.params.cropX) > 1e-10 || Math.abs(state.params.cropY) > 1e-10)) {
            logger.warn('Histogram', 'Crop-area-only histogram is unavailable without WebGL; showing the full per-eye histogram instead.');
        }

        // Slice physical regions for logical left/right based on swapLR
        let canvas = document.createElement('canvas');
        let ctx = canvas.getContext('2d');

        // Error handling if getContext returns null
        if (!ctx) {
            logger.warn('Histogram','Failed to get 2D context for histogram calculation (fallback)');
            return null;
        }

        // Floor the per-eye width to match the Math.floor(width/2) convention used
        // everywhere else. A fractional half-width on an odd-width source made the
        // right-eye slice start at a half pixel and the canvas width truncate,
        // so the two eyes disagreed by a pixel.
        const width = Math.floor(image.width / 2);
        const height = image.height;
        canvas.width = width;
        canvas.height = height;

        // Determine physical slice positions considering swapLR
        const swapped = state.params.swapLR;
        const usePhysicalLeft = isLeftEye !== swapped;
        const sourceX = usePhysicalLeft ? 0 : width;
        ctx.drawImage(image, sourceX, 0, width, height, 0, 0, width, height);

        // Get pixel data
        let imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        // Calculate original pixel count (no downsampling in fallback path)
        const originalPixelCount = width * height;

        // Cleanup: release temporary canvas and context
        // Data from getImageData is stored in data; canvas is no longer needed
        canvas.width = 0;
        canvas.height = 0;
        ctx = null;
        canvas = null;
        imageData = null;

        // Calculate histogram (do not skip black pixels in fallback path)
        const histogram = buildHistogramFromData(data, false, originalPixelCount);

        return histogram;
    } catch (err) {
        logger.error('Histogram','[Histogram] Error calculating histogram:', err);
        return null;
    }
}

/**
 * Apply auto-level correction
 * @param {boolean} isLeft - True to apply to left image
 */
export function applyAutoLevels(isLeft) {
    if (!state.material || !state.material.uniforms.map.value) {
        logger.warn('Histogram','No image loaded');
        return;
    }

    // Note: applyAutoLevels runs fully synchronously (the histogram is computed
    // via a synchronous offscreen readback), so re-entrancy cannot occur and no
    // running-lock is needed. Repeated invocations are also idempotent because
    // the histogram is read from the raw, unadjusted image (see below).

    const texture = state.material.uniforms.map.value;
    const image = texture.image;

    if (!image) {
        logger.warn('Histogram','Texture image not available');
        return;
    }

    // Calculate histogram from the raw image (no current quality adjustments)
    // so that repeated invocations are idempotent. If we read the histogram of
    // the already-adjusted display, the previous brightness/contrast values
    // would be overwritten based on their own effect, drifting the result.
    const histogram = calculateHistogram(image, isLeft, false, true);

    // If histogram calculation fails (e.g., readback failure)
    if (!histogram) {
        logger.warn('Histogram','Failed to calculate histogram. Auto levels adjustment aborted.');
        const statusEl = document.getElementById('renderStatus');
        if (statusEl) {
            const errorMsg = window.t?.('messages.autoLevelsFailed') ?? 'Auto levels failed. Please try again.';
            statusEl.textContent = errorMsg;
            statusEl.style.color = '#ff9900';
            statusEl.style.display = 'block';
            setTimeout(() => {
                statusEl.style.display = 'none';
            }, 3000);
        }
        return;
    }

    const lumStats = calculateHistogramStats(histogram).luminance;

    // ========================================
    // Auto-level correction algorithm
    // ========================================
    // 1. Stretch toward a modest target range (220, not full 255)
    // 2. Blend with identity at applicationStrength to avoid overcorrection
    // 3. Clamp contrast to [0.8, 1.5] and brightness to [-0.3, 0.3]
    // 4. Center the median at 128/255 = 0.5
    // ========================================

    const range = lumStats.max - lumStats.min;
    if (range <= 0) return;

    const targetRange = 220;
    const applicationStrength = 0.6;

    // Interpolate between identity (1.0) and the ideal contrast.
    const idealContrast = targetRange / range;
    let autoContrast = 1.0 + (idealContrast - 1.0) * applicationStrength;
    autoContrast = Math.max(0.8, Math.min(1.5, autoContrast));

    // Brightness solves ((m + b - 0.5) * c + 0.5) = 0.5 for b, which collapses
    // to b = 0.5 - m regardless of contrast. We then scale by applicationStrength
    // and clamp to avoid over-shifting.
    const currentMedian = lumStats.median / 255;
    let autoBrightness = (0.5 - currentMedian) * applicationStrength;
    autoBrightness = Math.max(-0.3, Math.min(0.3, autoBrightness));

    if (isLeft) {
        state.params.contrastL = autoContrast;
        state.params.brightnessL = autoBrightness;
    } else {
        state.params.contrastR = autoContrast;
        state.params.brightnessR = autoBrightness;
    }

    updateUniforms();
    // Force re-computation of histogram cache after parameter changes.
    clearHistogramCache();

    if (typeof window.StereoView?.ui?.updateColorAdjustUI === 'function') {
        window.StereoView.ui.updateColorAdjustUI();
    } else if (typeof window.updateColorAdjustUI === 'function') {
        window.updateColorAdjustUI();
    }
}

/**
 * Draw histogram to canvas
 * @param {Object} histogram - Histogram data
 * @param {HTMLCanvasElement} canvas - Target canvas
 * @param {string} channel - Channel name ('r', 'g', 'b', 'luminance', 'rgb')
 */
export function drawHistogram(histogram, canvas, channel = 'luminance') {
    // calculateHistogram() returns null on several reachable failure paths
    // (offscreen readback failure, missing texture, 2D-context failure). Guard
    // here so a failed calculation does not throw "Cannot read properties of null"
    // out of the panel-refresh path (the caller passes the result straight in).
    if (!histogram) {
        logger.warn('Histogram', 'No histogram data to draw (calculation failed)');
        return;
    }

    const ctx = canvas.getContext('2d');

    // Error handling if getContext returns null
    if (!ctx) {
        logger.warn('Histogram','Failed to get 2D context for histogram drawing');
        return;
    }

    const width = canvas.width;
    const height = canvas.height;

    // Clear canvas
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, height);

    // Draw grid lines
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;

    // Horizontal grid (5 lines)
    for (let i = 0; i <= 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
    }

    // Vertical grid (4 lines)
    for (let i = 1; i < 4; i++) {
        const x = (width / 4) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
    }

    // Handle RGB mode - draw all three channels together
    if (channel === 'rgb') {
        // Compute max value across all RGB channels (exclude top 1% outliers)
        const allCounts = [...histogram.r, ...histogram.g, ...histogram.b];
        const sortedCounts = allCounts.sort((a, b) => b - a);
        const excludeIndex = Math.floor(sortedCounts.length * 0.01);
        const maxCount = sortedCounts[excludeIndex] || sortedCounts[0] || 1;

        if (maxCount === 0) return;

        // Divide by 255 (not 256) so the last bin (i=255) lands exactly at the
        // right edge instead of leaving a ~1/256-wide blank stripe.
        const binWidth = width / 255;

        // Draw R channel
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
            const x = i * binWidth;
            const normalizedHeight = (histogram.r[i] / maxCount) * height;
            const y = height - normalizedHeight;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Draw G channel
        ctx.strokeStyle = '#44ff44';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
            const x = i * binWidth;
            const normalizedHeight = (histogram.g[i] / maxCount) * height;
            const y = height - normalizedHeight;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Draw B channel
        ctx.strokeStyle = '#4444ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < 256; i++) {
            const x = i * binWidth;
            const normalizedHeight = (histogram.b[i] / maxCount) * height;
            const y = height - normalizedHeight;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        // Display statistics as text (use luminance for RGB mode)
        const stats = calculateHistogramStats(histogram);
        const lumStats = stats.luminance;

        const totalPixels = histogram.originalPixelCount || histogram.r.reduce((sum, count) => sum + count, 0);
        const formattedPixels = Math.round(totalPixels).toLocaleString();

        ctx.fillStyle = '#ffffff';
        ctx.font = '12px monospace';
        ctx.fillText(`Pixels: ${formattedPixels}`, 5, 15);
        ctx.fillText(`Min: ${lumStats.min}`, 5, 30);
        ctx.fillText(`Max: ${lumStats.max}`, 5, 45);
        ctx.fillText(`Mean: ${Math.round(lumStats.mean)}`, 5, 60);
        ctx.fillText(`Median: ${lumStats.median}`, 5, 75);
    } else {
        // Single channel mode
        const hist = histogram[channel];

        // Compute max value excluding outliers (exclude top 1%)
        const sortedCounts = [...hist].sort((a, b) => b - a);
        const excludeIndex = Math.floor(sortedCounts.length * 0.01);
        const maxCount = sortedCounts[excludeIndex] || sortedCounts[0] || 1;

        if (maxCount === 0) return;

        // Draw histogram
        ctx.strokeStyle = channel === 'r' ? '#ff4444' :
                          channel === 'g' ? '#44ff44' :
                          channel === 'b' ? '#4444ff' : '#cccccc';
        ctx.lineWidth = 2;
        ctx.beginPath();

        const binWidth = width / 255;

        for (let i = 0; i < 256; i++) {
            const x = i * binWidth;
            const normalizedHeight = (hist[i] / maxCount) * height;
            const y = height - normalizedHeight;

            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }

        ctx.stroke();

        // Display statistics as text
        const stats = calculateHistogramStats(histogram);
        const channelStats = stats[channel];

        // Use original pixel count (before downsampling) if available
        const totalPixels = histogram.originalPixelCount || hist.reduce((sum, count) => sum + count, 0);
        const formattedPixels = Math.round(totalPixels).toLocaleString();

        ctx.fillStyle = '#ffffff';
        ctx.font = '12px monospace';
        ctx.fillText(`Pixels: ${formattedPixels}`, 5, 15);
        ctx.fillText(`Min: ${channelStats.min}`, 5, 30);
        ctx.fillText(`Max: ${channelStats.max}`, 5, 45);
        ctx.fillText(`Mean: ${Math.round(channelStats.mean)}`, 5, 60);
        ctx.fillText(`Median: ${channelStats.median}`, 5, 75);
    }
}
