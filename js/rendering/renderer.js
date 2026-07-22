/**
* renderer.js
* Handles WebGL rendering and shader management with Three.js
*/
import * as THREE from 'three';
import { state, getModeLayout, DEBUG, isSBSMode, CONSTANTS, is3DTVActive } from '../globals.js';
import { isFullSBSMode } from '../mode-utils.js';
import { vertexShader, getFragmentShaderCached, getShaderGroup, clearShaderCache } from './shaders.js';
import { ensureEven } from '../utils/pixel-utils.js';
import * as logger from '../utils/logger.js';

// Track current shader group
let currentShaderGroup = null;

// Error state management (prevent infinite loops)
let renderErrorCount = 0;
let renderStopped = false;
let lastErrorTime = 0;

// Flag to prevent duplicate event listener registration
let resizeListenerAttached = false;

let isThreeInitialized = false;

// Store WebGL context event handlers for cleanup on re-init
let contextLostHandler = null;
let contextRestoredHandler = null;

let resizeTimeoutId = null;
const RESIZE_DEBOUNCE_MS = 100;  // 100ms debounce for resize operations

// Reusable Vector2/Vector3 (reduce GC)
const tempVector2 = new THREE.Vector2();
const tempGridColorVector3 = new THREE.Vector3();

// WebGL GPU memory management
let maxTextureSize = null;  // Cached GPU max texture size

// Maps blob URL → texture object for reuse
// Limited to MAX_TEXTURE_CACHE_SIZE entries; oldest entries are evicted when limit exceeded
// Map preserves insertion order, so Map.keys().next() returns the oldest entry
const textureCache = new Map();
const MAX_TEXTURE_CACHE_SIZE = 50;  // Maximum number of cached textures

/**
 * Validate whether a ShaderMaterial is safe to use
 * Checks: not null, has dispose method, valid uniforms, texture integrity, and is not already disposed
 * @param {THREE.ShaderMaterial|null} material - Material to validate
 * @returns {boolean} True if material is valid and usable
 */
function isValidShaderMaterial(material) {
    // Basic null and type check
    if (!material || typeof material !== 'object') {
        return false;
    }

    // Check essential methods and properties
    if (typeof material.dispose !== 'function') {
        return false;
    }

    // Check shader code integrity
    if (!material.vertexShader || !material.fragmentShader) {
        return false;
    }

    // Check uniforms object
    if (!material.uniforms || typeof material.uniforms !== 'object') {
        return false;
    }

    // Check map texture (main image texture)
    if (material.uniforms.map && material.uniforms.map.value) {
        const mapTexture = material.uniforms.map.value;
        // Verify texture has valid image/canvas data
        if (!mapTexture.image) {
            logger.debug('RENDER_VALIDATION_LOG', 'Renderer', 'Material validation failed: map texture missing image');
            return false;
        }
        // Check texture dimensions are defined, valid numbers, and positive
        const imageWidth = mapTexture.image.width;
        const imageHeight = mapTexture.image.height;

        if (imageWidth === undefined || imageHeight === undefined) {
            logger.debug('RENDER_VALIDATION_LOG', 'Renderer', 'Material validation failed: map texture has undefined dimensions');
            return false;
        }

        if (typeof imageWidth !== 'number' || typeof imageHeight !== 'number') {
            logger.debug('RENDER_VALIDATION_LOG', 'Renderer', 'Material validation failed: map texture dimensions are not numbers');
            return false;
        }

        if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
            logger.debug('RENDER_VALIDATION_LOG', 'Renderer', 'Material validation failed: map texture has invalid dimensions', { width: imageWidth, height: imageHeight });
            return false;
        }
        // Check texture has valid UUID (indicates proper Three.js object)
        if (!mapTexture.uuid) {
            logger.debug('RENDER_VALIDATION_LOG', 'Renderer', 'Material validation failed: map texture missing UUID');
            return false;
        }
    }

    // Check text textures if present
    if (material.uniforms.textTexL && material.uniforms.textTexL.value) {
        const textTexL = material.uniforms.textTexL.value;
        if (!textTexL.image || !textTexL.uuid) {
            logger.debug('RENDER_VALIDATION_LOG', 'Renderer', 'Material validation failed: text texture L corrupted');
            return false;
        }
    }

    if (material.uniforms.textTexR && material.uniforms.textTexR.value) {
        const textTexR = material.uniforms.textTexR.value;
        if (!textTexR.image || !textTexR.uuid) {
            logger.debug('RENDER_VALIDATION_LOG', 'Renderer', 'Material validation failed: text texture R corrupted');
            return false;
        }
    }

    // All validations passed
    return true;
}

export function initThree(containerId) {
    // If already initialized, warn and clean up existing resources first
    if (isThreeInitialized) {
        logger.warn('Renderer', 'initThree() called multiple times. This may indicate a logic error.');
        logger.warn('Renderer', 'Cleaning up existing resources before re-initialization...');

        // Clean up existing resources
        if (state.resizeObserver) {
            try {
                state.resizeObserver.disconnect();
            } catch (err) {
                logger.warn('Renderer', 'Error disconnecting existing ResizeObserver:', err);
            }
            state.resizeObserver = null;
        }

        if (state.renderer) {
            try {
                // Remove WebGL context event listeners before disposing
                if (state.renderer.domElement) {
                    if (contextLostHandler) {
                        state.renderer.domElement.removeEventListener('webglcontextlost', contextLostHandler);
                    }
                    if (contextRestoredHandler) {
                        state.renderer.domElement.removeEventListener('webglcontextrestored', contextRestoredHandler);
                    }
                }
                contextLostHandler = null;
                contextRestoredHandler = null;

                // Remove canvas from DOM
                if (state.renderer.domElement && state.renderer.domElement.parentNode) {
                    state.renderer.domElement.parentNode.removeChild(state.renderer.domElement);
                }
                state.renderer.dispose();
            } catch (err) {
                logger.warn('Renderer', 'Error disposing existing renderer:', err);
            }
            state.renderer = null;
        }

        if (state.material) {
            try {
                state.material.dispose();
            } catch (err) {
                logger.warn('Renderer', 'Error disposing existing material:', err);
            }
            state.material = null;
        }

        // Remove and dispose the old mesh too. A fresh state.scene is created
        // below, so without this state.mesh would keep pointing at a mesh that
        // belongs to the discarded scene and whose material was just disposed;
        // code gated on state.mesh (fitImageToWindow, updateMeshTransform, the
        // context-restore handler) would then operate on it until the next image
        // load runs createStereoMesh. Nulling it makes those paths no-op until a
        // valid mesh exists, and disposes the geometry's GPU buffers.
        if (state.mesh) {
            try {
                if (state.scene) {
                    state.scene.remove(state.mesh);
                }
                if (state.mesh.geometry && typeof state.mesh.geometry.dispose === 'function') {
                    state.mesh.geometry.dispose();
                }
            } catch (err) {
                logger.warn('Renderer', 'Error disposing existing mesh:', err);
            }
            state.mesh = null;
        }

        // Dispose the text-overlay textures too. They are CanvasTextures referenced
        // via state.textTextureL/R (not held inside state.material.uniforms, so the
        // material.dispose() above does not reclaim them), and the mesh block just set
        // state.mesh = null, so createStereoMesh's own text-texture cleanup is skipped
        // on the next load. Leaving them non-null also lets the context-restore handler
        // reattach a stale overlay from the discarded session. Dispose and null both.
        if (state.textTextureL) {
            try { state.textTextureL.dispose(); } catch (err) { logger.warn('Renderer', 'Error disposing existing text texture (L):', err); }
            state.textTextureL = null;
        }
        if (state.textTextureR) {
            try { state.textTextureR.dispose(); } catch (err) { logger.warn('Renderer', 'Error disposing existing text texture (R):', err); }
            state.textTextureR = null;
        }
    }

    // Fully reset rendering error state
    renderErrorCount = 0;
    renderStopped = false;
    lastErrorTime = 0;

    // CRITICAL: Check container exists BEFORE creating any Three.js objects
    // This prevents partial initialization if container is missing
    const container = document.getElementById(containerId);
    if (!container) {
        logger.error('Renderer', `initThree: container element '${containerId}' not found`);
        isThreeInitialized = false; // Ensure flag reflects failure state
        throw new Error(`Required DOM element '${containerId}' not found. Ensure the HTML is loaded before calling initThree.`);
    }

    state.scene = new THREE.Scene();

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;

    const aspect = width / height;
    const frustumSize = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;

    // OrthographicCamera for normal 2D view
    state.camera = new THREE.OrthographicCamera(
        frustumSize * aspect / -2,
        frustumSize * aspect / 2,
        frustumSize / 2,
        frustumSize / -2,
        0.1,
        1000
    );
    state.camera.position.z = 5;

    // PerspectiveCamera for VR mode
    state.vrCamera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);
    state.vrCamera.position.set(0, 1.6, 0); // Set eye height (1.6m)

    state.renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: true });
    state.renderer.setSize(width, height);
    // Cap the pixel ratio at 2: combined with antialias + preserveDrawingBuffer,
    // an uncapped ratio on high-DPR phones multiplies framebuffer memory and risks
    // WebGL context loss. getInterlaceParityOffset() still reads the real buffer height.
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Get GPU maximum texture size (for memory check)
    const glContext = state.renderer.getContext();
    maxTextureSize = glContext.getParameter(glContext.MAX_TEXTURE_SIZE);
    logger.debug('RENDER_INFO_LOG', 'Renderer', `GPU MAX_TEXTURE_SIZE: ${maxTextureSize}x${maxTextureSize}`);

    // WebXR setup
    state.renderer.xr.enabled = false;

    container.appendChild(state.renderer.domElement);

    // Handle WebGL context loss (memory constraints on mobile)
    contextLostHandler = (event) => {
        event.preventDefault();

        const contextInfo = {
            statusMessage: event.statusMessage || 'No status message',
            timestamp: new Date().toISOString(),
            memoryInfo: performance.memory ? {
                usedJSHeapSize: (performance.memory.usedJSHeapSize / 1048576).toFixed(2) + 'MB',
                totalJSHeapSize: (performance.memory.totalJSHeapSize / 1048576).toFixed(2) + 'MB',
                jsHeapSizeLimit: (performance.memory.jsHeapSizeLimit / 1048576).toFixed(2) + 'MB'
            } : 'Not available',
            renderErrorCount,
            lastErrorTime: lastErrorTime ? new Date(lastErrorTime).toISOString() : 'N/A'
        };

        logger.warn('Renderer', 'WebGL context lost - preventing default behavior to allow restoration', contextInfo);

        // Reset error state (to attempt recovery)
        renderErrorCount = 0;
        renderStopped = true;
        lastErrorTime = 0;

        window.dispatchEvent(new CustomEvent('webgl-context-lost', { detail: contextInfo }));

        // Notify user
        const statusEl = document.getElementById('renderStatus');
        if (statusEl) {
            const errorMsg = window.t?.('messages.contextLost') ?? 'WebGL context lost. Attempting to restore...';
            statusEl.textContent = errorMsg;
            statusEl.style.color = '#ff9900';
            statusEl.style.display = 'block';
        }
    };
    state.renderer.domElement.addEventListener('webglcontextlost', contextLostHandler, false);

    contextRestoredHandler = () => {
        logger.info('Renderer', 'WebGL context restored successfully');

        // Reset error state
        renderErrorCount = 0;
        renderStopped = false;
        lastErrorTime = 0;

        window.dispatchEvent(new CustomEvent('webgl-context-restored'));

        // Hide notification
        const statusEl = document.getElementById('renderStatus');
        if (statusEl) {
            statusEl.style.display = 'none';
        }

        // Rebuild WebGL resources (textures, shaders)
        const restoreTexture = state.material?.uniforms?.map?.value ?? state.material?.map;
        if (state.mesh && restoreTexture) {
            const texture = restoreTexture;
            if (texture && texture.image) {
                // Rebuild textures
                texture.needsUpdate = true;

                const oldMaterial = state.material;
                let materialRestoreFailed = false;

                try {
                    state.material = createStereoMaterial(texture);
                    state.mesh.material = state.material;

                    // Rebuild text textures too
                    if (state.textTextureL) {
                        state.textTextureL.needsUpdate = true;
                        state.material.uniforms.textTexL.value = state.textTextureL;
                    }
                    if (state.textTextureR) {
                        state.textTextureR.needsUpdate = true;
                        state.material.uniforms.textTexR.value = state.textTextureR;
                    }

                    // Clear shader cache
                    clearShaderCache();
                    currentShaderGroup = getShaderGroup(state.params.mode);

                    // The fresh material from createStereoMaterial() starts with an
                    // identity alignTransform and textEnabled=0. Re-apply the user's
                    // params (including auto-alignment homography) via updateUniforms,
                    // and re-enable the text overlay if text textures are present.
                    // Pass skipRender=true so we render only once at the end.
                    const hasText = !!(state.textTextureL && state.textTextureR);
                    updateUniforms(true);
                    if (hasText) {
                        state.material.uniforms.textEnabled.value = 1.0;
                        state.material.uniforms.textParallax.value = state.params.textParallax;
                    }

                    logger.info('Renderer', 'WebGL resources (textures, shaders) rebuilt successfully');
                } catch (err) {
                    logger.error('Renderer', 'Failed to rebuild material after context restore:', err);

                    // Use isValidShaderMaterial() to prevent using disposed/partial materials
                    if (isValidShaderMaterial(oldMaterial)) {
                        // Existing material is fully valid and can be restored
                        logger.debug('RENDER_ERROR_LOG', 'Renderer', 'Restored old material after context loss');
                        state.material = oldMaterial;
                        state.mesh.material = oldMaterial;
                        materialRestoreFailed = false; // Successfully restored, no failure
                    } else {
                        // Existing material is invalid/disposed, so create a fallback material
                        logger.warn('Renderer', 'Old material invalid after context loss (invalid or disposed), creating fallback material');
                        try {
                            // Try to create a simple fallback using the texture we have
                            state.material = new THREE.MeshBasicMaterial({ map: texture });
                            state.mesh.material = state.material;
                            materialRestoreFailed = true; // New material created, mark as restoration failure
                            logger.debug('RENDER_ERROR_LOG', 'Renderer', 'Created basic fallback material');
                        } catch (fallbackErr) {
                            logger.error('Renderer', 'Fallback material creation also failed:', fallbackErr);
                            materialRestoreFailed = true;
                            renderStopped = true;
                            // Don't return early - let finally block execute for cleanup
                            // The render loop will stop due to renderStopped flag
                        }
                    }
                } finally {
                    // Dispose the prior material only if:
                    // 1. A new material was created successfully, AND
                    // 2. The prior material is no longer active (no restoration failure), AND
                    // 3. The prior material is valid and usable (per isValidShaderMaterial)
                    if (!materialRestoreFailed && state.material !== oldMaterial && isValidShaderMaterial(oldMaterial)) {
                        try {
                            oldMaterial.dispose();
                            logger.debug('RENDER_ERROR_LOG', 'Renderer', 'Disposed old material after context restore');
                        } catch (disposeErr) {
                            logger.warn('Renderer', 'Error disposing old material:', disposeErr);
                            // Continue anyway - disposal errors shouldn't break recovery
                        }
                    }
                }
            }
        }

        // Resume rendering
        render();
    };
    state.renderer.domElement.addEventListener('webglcontextrestored', contextRestoredHandler, false);

    state.textureLoader = new THREE.TextureLoader();

    // Prevent duplicate resize event listeners:
    // Always remove before adding to guarantee at most one listener,
    // even if resizeListenerAttached flag gets out of sync.
    window.removeEventListener('resize', onWindowResizeDebounced, false);
    window.addEventListener('resize', onWindowResizeDebounced, false);
    resizeListenerAttached = true;

    // Handle resize on menu open/close (ResizeObserver)
    // Dispose existing ResizeObserver (prevent leaks on re-init)
    if (state.resizeObserver) {
        try {
            state.resizeObserver.disconnect();
            logger.debug('RENDER_INFO_LOG', 'Renderer', 'Existing ResizeObserver disconnected');
        } catch (err) {
            logger.warn('Renderer', 'Error disconnecting ResizeObserver:', err);
        }
        state.resizeObserver = null;
    }

    if (typeof ResizeObserver !== 'undefined') {
        try {
            state.resizeObserver = new ResizeObserver(() => {
                onWindowResizeDebounced();
            });
            state.resizeObserver.observe(container);
            logger.debug('RENDER_INFO_LOG', 'Renderer', 'New ResizeObserver created and observing container');
        } catch (err) {
            logger.warn('Renderer', 'Error creating ResizeObserver:', err);
            state.resizeObserver = null;
            // ResizeObserver failure is not critical - resizing will still work via window 'resize' event
        }
    }

    isThreeInitialized = true;

    return true;
}

/**
 * Prevents excessive calls to onWindowResize() from ResizeObserver and window 'resize' events
 * @private
 */
function onWindowResizeDebounced() {
    clearTimeout(resizeTimeoutId);
    resizeTimeoutId = setTimeout(() => {
        onWindowResize();
        resizeTimeoutId = null;
    }, RESIZE_DEBOUNCE_MS);
}

export function onWindowResize() {
    // Return early if uninitialized (resize may fire before initThree())
    if (!state.renderer || !state.camera) {
        return;
    }

    // Use canvas-container size (exclude left menu area)
    const container = document.getElementById('canvas-container');
    if (!container) {
        logger.warn('Renderer', 'Canvas container not found in onWindowResize');
        return;
    }

    // Do NOT fall back to window.innerWidth/Height when clientWidth/Height is 0.
    // The container is display:none during menu/layout transitions; substituting
    // full-window dimensions would defeat the zero-size guard below and resize the
    // drawing buffer, resolution uniform, and interlace parity to values that do
    // not match the hidden container. Bail instead so a later resize with a real
    // size corrects it. Mirrors the guard in fitImageToWindow(). (container is
    // guaranteed non-null here by the early return above.)
    let width = container.clientWidth;
    let height = container.clientHeight;

    if (width <= 0 || height <= 0) {
        return;
    }

    const aspect = width / height;
    if (!Number.isFinite(aspect)) {
        return;
    }
    const frustumSize = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;

    // ===== Update normal camera (OrthographicCamera) =====
    state.camera.left = -frustumSize * aspect / 2;
    state.camera.right = frustumSize * aspect / 2;
    state.camera.top = frustumSize / 2;
    state.camera.bottom = -frustumSize / 2;
    state.camera.updateProjectionMatrix();

    // ===== Update VR camera (PerspectiveCamera) =====
    if (state.vrCamera) {
        state.vrCamera.aspect = aspect;
        state.vrCamera.updateProjectionMatrix();
    }

    // ===== Update renderer =====
    state.renderer.setSize(width, height);
    // Cap the pixel ratio at 2 (see initThree): avoids excess framebuffer memory /
    // context loss on high-DPR phones. Interlace parity reads the real buffer height.
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // ===== Update shader uniform resolution =====
    if (state.material?.uniforms?.resolution?.value) {
        state.material.uniforms.resolution.value.set(width, height);
    }
    // Keep pixelRatio in sync (it can change when the window moves between monitors of
    // different DPR); the grid line-width math pairs it with `resolution`.
    if (state.material?.uniforms?.pixelRatio) {
        state.material.uniforms.pixelRatio.value = state.renderer.getPixelRatio();
    }

    syncInterlaceParityOffset();

    // ===== Always auto-fit in viewer mode =====
    if (state.viewerMode && state.mesh) {
        fitImageToWindow();
    } else if (state.mesh && is3DTVActive()) {
        // 3DTV can be enabled outside viewer mode (its checkbox is independent of
        // viewerMode). The full-screen mesh stretch is derived from the container
        // size inside updateMeshTransform(), so on resize/rotation it must be
        // recomputed here or the image stops covering the screen (gap/overflow)
        // until some other action happens to call updateMeshTransform() again.
        updateMeshTransform();
    }

    // Notify the UI that the canvas geometry changed (after any viewer refit above).
    // The viewer-bar / 3DTV zoom readout is derived from the canvas size, so it goes
    // stale on resize/rotation until the next zoom interaction; ui.js recomputes it
    // on this event. Emitting an event (rather than calling the UI directly) keeps
    // the renderer independent of the UI layer. Dispatched only once a real resize
    // completed (the zero-size guards above return before reaching here).
    try {
        window.dispatchEvent(new Event('canvas-resized'));
    } catch (_) { /* CustomEvent/Event unavailable: non-fatal */ }
}

/**
 * Get GPU maximum texture size
 * @returns {number} Maximum texture size in pixels (width/height)
 */
export function getMaxTextureSize() {
    return maxTextureSize || 2048;  // Fallback to common minimum
}

/**
 * Get cached texture or create new one
 * Avoids duplicate GPU memory allocation for the same URL
 * Handles both synchronous textures and Promise-based async loading
 * @param {string} url - Texture URL (blob or data URL)
 * @param {Function} loaderFunc - Function to create texture if not cached (may return Texture or Promise<Texture>)
 * @returns {THREE.Texture|Promise<THREE.Texture>} Cached texture directly or Promise if still loading
 */
export function getCachedOrCreateTexture(url, loaderFunc) {
    // Check if texture is already cached
    if (textureCache.has(url)) {
        const cached = textureCache.get(url);
        // Handle cached Promise or rejected state by re-attempting
        if (cached && typeof cached === 'object' && cached.status === 'rejected') {
            logger.debug('RENDER_INFO_LOG', 'Renderer', `Retrying failed texture for ${(url || 'unknown').substring(0, 50)}...`);
            // Remove rejected entry from cache before retry
            textureCache.delete(url);
            // Continue to re-load
        } else if (cached && typeof cached === 'object' && cached.status === 'pending' && cached.promise instanceof Promise) {
            // Pending async load - return the promise (not the wrapper object)
            logger.debug('RENDER_INFO_LOG', 'Renderer', `Texture loading already in progress for ${(url || 'unknown').substring(0, 50)}...`);
            return cached.promise;
        } else {
            if (cached instanceof Promise) {
                // Unexpected: raw Promise in cache (should always be wrapped in {status, promise}).
                // Returning it directly would mean rejection cannot remove the cache entry,
                // causing permanent cache pollution. Evict and fall through to re-create.
                logger.warn('Renderer', `Unexpected raw Promise in texture cache for ${(url || 'unknown').substring(0, 50)}... Evicting.`);
                textureCache.delete(url);
                // Fall through to re-create the texture
            } else {
                // Successfully cached texture (THREE.Texture instance)
                logger.debug('RENDER_INFO_LOG', 'Renderer', `Using cached texture for ${(url || 'unknown').substring(0, 50)}...`);
                return cached;
            }
        }
    }

    // Evict oldest texture when cache exceeds MAX_TEXTURE_CACHE_SIZE
    if (textureCache.size >= MAX_TEXTURE_CACHE_SIZE) {
        // Try to find an evictable entry (skip textures still in use by materials)
        // Map preserves insertion order, so iterate from oldest to newest
        let evicted = false;
        const maxAttempts = Math.min(textureCache.size, 5);
        let attempt = 0;

        for (const candidateUrl of textureCache.keys()) {
            if (attempt >= maxAttempts || evicted) break;
            attempt++;

            const candidateEntry = textureCache.get(candidateUrl);

            // Skip entries that are still loading: evicting them would orphan the
            // pending promise's .then() handler, which checks textureCache.has(url)
            // before storing the resolved texture — preventing it from ever being cached.
            if (candidateEntry && typeof candidateEntry === 'object' &&
                candidateEntry.status === 'pending') {
                continue;
            }

            // Skip if texture is actively referenced by a material
            if (candidateEntry instanceof THREE.Texture) {
                // Also check state.material.map: after a failed context restore the
                // active material is a MeshBasicMaterial fallback that holds the live
                // texture in .map (not .uniforms.map), so without this the displayed
                // texture could be evicted/disposed out from under it. (VR materials
                // share the main material's texture object, so they need no separate
                // check here.)
                const isActive =
                    (state.material?.uniforms?.map?.value === candidateEntry) ||
                    (state.material?.map === candidateEntry);
                if (isActive) {
                    continue;  // Skip this entry, try next oldest
                }

                try {
                    candidateEntry.dispose();
                    logger.debug('RENDER_INFO_LOG', 'Renderer', `Evicted texture from cache: ${(candidateUrl || 'unknown').substring(0, 50)}...`);
                } catch (err) {
                    logger.warn('Renderer', 'Error disposing evicted texture:', err);
                }
            }

            textureCache.delete(candidateUrl);
            evicted = true;
        }

        if (!evicted) {
            logger.warn('Renderer', `Texture cache eviction failed: all ${textureCache.size} entries are pending or active. Cache will temporarily exceed limit.`);
        }
    }

    // Create new texture using provided loader function
    const result = loaderFunc();

    // Handle Promise-based loading
    if (result instanceof Promise) {
        // Cache entry for pending promise with a generation token to detect eviction
        const generationToken = {};
        const cacheEntry = { status: 'pending', promise: result, generation: generationToken };
        textureCache.set(url, cacheEntry);

        logger.debug('RENDER_INFO_LOG', 'Renderer', `Loading texture for ${(url || 'unknown').substring(0, 50)}... (Cache size: ${textureCache.size}/${MAX_TEXTURE_CACHE_SIZE})`);

        // Replace Promise cache entry with resolved Texture once loading completes
        return result.then((texture) => {
            // Guard against cache resurrection: only update if entry still exists
            // AND has the same generation token (prevents stale promise from overwriting
            // a newer entry after eviction + re-creation for the same URL)
            const current = textureCache.get(url);
            if (current && current.generation === generationToken) {
                textureCache.set(url, texture);
                logger.debug('RENDER_INFO_LOG', 'Renderer', `Cached resolved texture for ${(url || 'unknown').substring(0, 50)}... (Cache size: ${textureCache.size}/${MAX_TEXTURE_CACHE_SIZE})`);
            } else if (!current) {
                // The cache entry was cleared (clearTextureCache, e.g. on unload) while
                // this load was still pending, so nothing will ever store or dispose the
                // resolved texture. Dispose it here to avoid leaking GPU memory. A
                // superseded-but-still-present entry is intentionally left alone: its
                // original caller may still read the returned texture before discarding it.
                if (texture && typeof texture.dispose === 'function') {
                    try { texture.dispose(); } catch (_) { /* ignore */ }
                }
            }
            return texture;
        }).catch((err) => {
            // Remove failed entry from cache to allow retry (only if still ours)
            const current = textureCache.get(url);
            if (current && current.generation === generationToken) {
                textureCache.delete(url);
            }
            logger.warn('Renderer', `Failed to load texture for ${(url || 'unknown').substring(0, 50)}:`, err);
            throw err;
        });
    } else {
        // Synchronous texture creation (unlikely but supported)
        textureCache.set(url, result);

        logger.debug('RENDER_INFO_LOG', 'Renderer', `Cached texture for ${(url || 'unknown').substring(0, 50)}... (Cache size: ${textureCache.size}/${MAX_TEXTURE_CACHE_SIZE})`);

        return result;
    }
}

/**
 * Clear texture cache (call on page unload)
 * Safely handles Promises and state objects in cache
 * Uses explicit THREE.Texture type checking to prevent disposing non-texture objects
 */
export function clearTextureCache() {
    textureCache.forEach((entry, url) => {
        // Only dispose THREE.Texture instances (explicit type checking)
        // Skip: Promise objects, state objects ({status: 'pending'|'rejected'}), and null values
        if (entry instanceof THREE.Texture && typeof entry.dispose === 'function') {
            try {
                entry.dispose();
                logger.debug('RENDER_INFO_LOG', 'Renderer', 'Disposed texture from cache');
            } catch (err) {
                logger.warn('Renderer', 'Error disposing texture:', err);
            }
        } else if (entry && typeof entry === 'object' && !entry.dispose) {
            // Handle Promise or state objects ({status: 'pending'|'rejected'})
            if (entry.promise instanceof Promise) {
                // Cancel pending promise if possible (prevent unhandled rejection)
                entry.promise.catch(() => {});
            }
            // Clear references to allow garbage collection
            if (entry.status) delete entry.status;
            if (entry.promise) delete entry.promise;
            if (entry.error) delete entry.error;
        }
    });
    textureCache.clear();
    logger.debug('RENDER_INFO_LOG', 'Renderer', 'Texture cache cleared');
}

/**
 * Check whether rendering is stopped
 * @returns {boolean} Rendering stopped state
 */
export function isRenderingStopped() {
    return renderStopped;
}

export function render() {
    // Skip if already stopped due to error
    if (renderStopped) {
        return;
    }

    try {
        // Diagnostic log for init state (debug only)
        if (!state.renderer) {
            logger.debug('RENDER_ERROR_LOG', 'Renderer', 'Render failed: renderer not initialized');
            return;
        }

        if (!state.scene) {
            logger.debug('RENDER_ERROR_LOG', 'Renderer', 'Render failed: scene not initialized');
            return;
        }

        // Switch cameras between VR and normal mode
        const camera = (state.renderer.xr.enabled && state.vrCamera) ? state.vrCamera : state.camera;

        if (!camera) {
            logger.debug('RENDER_ERROR_LOG', 'Renderer', `Render failed: camera not initialized (VR: ${state.renderer.xr.enabled}, vrCamera: ${!!state.vrCamera}, camera: ${!!state.camera})`);
            return;
        }

        state.renderer.render(state.scene, camera);

        // Reset count if no errors
        renderErrorCount = 0;
        lastErrorTime = 0;
    } catch (error) {
        const now = performance.now();

        // Reset count if enough time has passed since last error
        // Reason: allow recovery from transient errors (e.g., WebGL context loss)
        if (lastErrorTime > 0 && (now - lastErrorTime) > CONSTANTS.ERROR_RESET_INTERVAL) {
            renderErrorCount = 0;
            logger.debug('RENDER_ERROR_LOG', 'Renderer', 'Render error count reset after recovery period');
        }

        renderErrorCount++;
        lastErrorTime = now;

        // Debug logging (flag-controlled)
        logger.debug('RENDER_ERROR_LOG', 'Renderer', `Rendering error (${renderErrorCount}/${CONSTANTS.MAX_RENDER_ERRORS}):`, error);

        // On error limit, stop animation and notify UI
        if (renderErrorCount >= CONSTANTS.MAX_RENDER_ERRORS) {
            renderStopped = true;

            // Dispatch custom event to notify UI (separation of concerns)
            window.dispatchEvent(new CustomEvent('render-error-threshold-reached', {
                detail: {
                    errorCount: renderErrorCount,
                    error: error
                }
            }));

            logger.error('Renderer', 'Rendering stopped due to repeated errors');
        }
    }
}

/**
 * Reset the rendering error state and resume rendering
 * Used for retry requests from the UI layer
 */
export function resetRenderErrorState() {
    renderErrorCount = 0;
    renderStopped = false;
    lastErrorTime = 0;
    logger.debug('RENDER_ERROR_LOG', 'Renderer', 'Rendering manually restarted');
}

/**
 * Compute the horizontal-interlace parity offset (0.0 or 1.0) for the current
 * drawing buffer. gl_FragCoord.y is measured from the buffer's bottom edge, so the
 * physical top display line has index (bufferHeightPx - 1); adding that value's
 * parity to floor(gl_FragCoord.y) in the shader re-anchors the eye-to-line mapping
 * to the top, keeping it stable regardless of buffer-height parity. The canvas
 * height is exactly the device-pixel drawing-buffer height gl_FragCoord ranges over.
 * Computed on the CPU (exact) to avoid a large in-shader subtraction that a mediump
 * fragment path could round.
 */
function getInterlaceParityOffset() {
    const bufH = state.renderer?.domElement?.height || 0;
    return (((bufH - 1) % 2) + 2) % 2; // 0.0 or 1.0
}

/**
 * Synchronize horizontal-interlace row parity after any direct renderer resize.
 * Export uses a temporary renderer size and cannot rely on the window-resize path.
 */
export function syncInterlaceParityOffset() {
    if (state.material?.uniforms?.interlaceParityOffset) {
        state.material.uniforms.interlaceParityOffset.value = getInterlaceParityOffset();
    }
}

/**
* Create a shader material for stereo rendering
*
* HTML mode definitions:
* 0: Anaglyph (red/cyan)
* 1: Interlace (horizontal lines)
* 2: Interlace (vertical lines)
* 3: Raw SBS (not exposed in the UI; supported for internal use)
* 4: Left eye only (2D)
* 5: Right eye only (2D)
* 6: Wiggle
* 7: Half SBS
* 8: Parallel view
* 9: Cross view
* 10: Top-and-Bottom
* 11: Anaglyph (gray)
* 12: LRL
* 13: Matrix 2x2
* 14: Anaglyph (blue/yellow)
* 15: Anaglyph (Dubois)
* 16: Full Top-and-Bottom (full-height stacked, no vertical compression; 3DTV-applicable)
*
* - The logical left eye image is fixed (reference)
* - Shifts (shiftX, shiftY) are applied only to the logical right eye image
*
* swapLR (swap left/right eyes) definition:
*   - swapLR=false: physical left = logical left, physical right = logical right
*   - swapLR=true: physical left = logical right, physical right = logical left
*   ※ Shifts always apply to the logical right eye, so swapLR shifts the physical left image.
*
* Cross view (mode==9) definition:
*   - Only the display placement is mirrored (independent of logical eye assignment)
*   - Treated independently from swapLR (no XOR cancellation)
*
* Shift and crop processing:
*   - shiftX: UV unit relative to eye width. The shader samples at srcR.x - shiftX*2,
*     so positive shiftX moves the right-eye image content RIGHT (uncrossed disparity
*     increases; the scene recedes behind the screen)
*   - shiftY: UV unit relative to image height. Positive moves the right-eye image
*     content up (vertical correction)
*   - cropX/cropY: mask amount (0-1). Masks outside the selection
*   - offsetX/offsetY: mask position adjustments (-1 to 1)
*
* - Rectangular selection is only valid for anaglyph (0, 11, 14, 15) and interlace (1, 2)
*
* Processing order (important):
*   1. Apply crop/offset (map output UV to the selected image region)
*   2. Apply shift (logical right eye only, parallax adjustment)
*   3. Swap sampleL/sampleR based on swapLR
*   4. If mode==9, flip output placement
*/
export function createStereoMaterial(texture) {
    const uniforms = {
        map: { value: texture },
        shiftX: { value: state.params.shiftX },
        shiftY: { value: state.params.shiftY },
        alignTransform: { value: new THREE.Matrix3() },
        cropX: { value: state.params.cropX },
        cropY: { value: state.params.cropY },
        offsetX: { value: state.params.offsetX },
        offsetY: { value: state.params.offsetY },
        tvCropX: { value: state.params.tvCropX },
        tvCropY: { value: state.params.tvCropY },
        tvOffsetX: { value: state.params.tvOffsetX },
        tvOffsetY: { value: state.params.tvOffsetY },
        swapLR: { value: state.params.swapLR ? 1.0 : 0.0 },
        mode: { value: state.params.mode },
        textTexL: { value: null },
        textTexR: { value: null },
        textEnabled: { value: 0.0 },
        textParallax: { value: 0.0 },
        wigglePhase: { value: state.params.wigglePhase },
        // Image adjustments (left/right separately)
        brightnessL: { value: state.params.brightnessL },
        brightnessR: { value: state.params.brightnessR },
        contrastL: { value: state.params.contrastL },
        contrastR: { value: state.params.contrastR },
        saturationL: { value: state.params.saturationL },
        saturationR: { value: state.params.saturationR },
        hueL: { value: state.params.hueL },
        hueR: { value: state.params.hueR },
        sharpnessL: { value: state.params.sharpnessL },
        sharpnessR: { value: state.params.sharpnessR },
        noiseReductionL: { value: state.params.noiseReductionL },
        noiseReductionR: { value: state.params.noiseReductionR },
        // Global output dimming for viewing comfort. Histogram offscreen passes
        // override this to 1.0 to measure true image tones (see histogram.js).
        intensity: { value: 0.85 },
        // texelSize: computed from actual texture size (fallback if none)
        texelSize: { value: (function() {
            const w = texture.image ? texture.image.width : 1024;
            const h = texture.image ? texture.image.height : 1024;
            return new THREE.Vector2(1.0 / w, 1.0 / h);
        })() },
        // Grid display
        gridEnabled: { value: state.params.gridEnabled ? 1.0 : 0.0 },
        gridDensity: { value: state.params.gridDensity },
        gridColor: { value: hexToRgbVector(state.params.gridColor) },
        resolution: { value: (function() {
            const container = state.renderer?.domElement?.parentElement;
            const w = container ? container.clientWidth : window.innerWidth;
            const h = container ? container.clientHeight : window.innerHeight;
            return new THREE.Vector2(w, h);
        })() },
        // Device-pixel ratio of the drawing buffer, kept in sync alongside `resolution`
        // (onWindowResize + updateUniforms). Used by the grid line-width math so lines
        // are a consistent device-pixel width on high-DPR screens. Never 0 (getPixelRatio
        // returns a positive value; defaults to 1.0 before the renderer exists).
        pixelRatio: { value: state.renderer ? state.renderer.getPixelRatio() : 1.0 },
        // Horizontal-interlace parity correction (see shaders.js). Kept in sync on
        // every resize by onWindowResize so the eye-to-line mapping never flips.
        interlaceParityOffset: { value: getInterlaceParityOffset() },
        // For viewer mode
        viewerModeEnabled: { value: state.viewerMode ? 1.0 : 0.0 },
        viewerPanX: { value: state.viewerPanX },
        viewerPanY: { value: state.viewerPanY },
        viewerScale: { value: state.viewerScale },
        // 3DTV mode
        sbs3dtv: { value: state.params.sbs3dtv ? 1.0 : 0.0 },
        imageAspect: { value: 1.0 }, // Single-eye aspect ratio (width/height)
        // 3D Pointer
        pointer3dEnabled: { value: 0.0 },
        pointer3dPos: { value: new THREE.Vector2(0.5, 0.5) },
        pointer3dParallax: { value: 0.0 }
    };

    // Select optimized shader based on mode
    const fragmentShader = getFragmentShaderCached(state.params.mode);
    currentShaderGroup = getShaderGroup(state.params.mode);

    let material;
    try {
        material = new THREE.ShaderMaterial({
            uniforms,
            vertexShader,
            fragmentShader,
            transparent: true
        });
    } catch (err) {
        logger.error('Renderer', 'Failed to create stereo shader material:', err);
        throw err;
    }

    return material;
}

/**
* Rebuild shaders when the mode changes
* Keep uniforms and update only the shader program
* @returns {string|null} Previous shader group (for restoration), or null if unchanged
*/
export function rebuildShaderForMode(mode) {
    if (!state.material || !state.mesh) return null;

    const newShaderGroup = getShaderGroup(mode);
    if (currentShaderGroup === newShaderGroup) return null;

    const previousGroup = currentShaderGroup;

    // Save existing uniforms
    const oldUniforms = state.material.uniforms;

    // Get new shader
    const fragmentShader = getFragmentShaderCached(mode);

    // Create the replacement material first, then dispose the prior one (safe rollback on failure)
    let newMaterial;
    try {
        newMaterial = new THREE.ShaderMaterial({
            uniforms: oldUniforms,
            vertexShader,
            fragmentShader,
            transparent: true
        });
    } catch (err) {
        logger.error('Renderer', `Failed to create shader material for mode group ${newShaderGroup}:`, err);
        // Keep the active material intact — do not dispose the prior one
        return null;
    }

    // Dispose the prior material and apply the replacement material
    state.material.dispose();
    state.material = newMaterial;
    state.mesh.material = newMaterial;

    // Update shader group and evict stale cache entries from the previous group
    // to prevent unbounded growth during frequent mode switches
    currentShaderGroup = newShaderGroup;
    if (previousGroup && previousGroup !== newShaderGroup) {
        clearShaderCache();
    }

    logger.debug('RENDER_INFO_LOG', 'Renderer', `Shader rebuilt for mode group: ${newShaderGroup}`);

    return previousGroup;
}

/**
 * Remove a specific texture from the texture cache. Used when a texture is
 * disposed outside createStereoMesh() (e.g. clearPreviousImageState) so a
 * disposed texture can never be served from the cache afterwards.
 */
export function removeTextureFromCache(texture) {
    if (!texture) return;
    for (const [url, entry] of textureCache.entries()) {
        if (entry === texture) {
            textureCache.delete(url);
            break;
        }
    }
}

/**
* Create a stereo mesh from an image (texture) and add it to the scene
*/
export function createStereoMesh(texture) {
    if (state.mesh) {
        state.scene.remove(state.mesh);

        // Dispose textures held by material
        if (state.mesh.material && state.mesh.material.uniforms) {
            const uniforms = state.mesh.material.uniforms;
            // Main texture may be the same as the new one passed in,
            // so dispose only if different
            if (uniforms.map && uniforms.map.value && uniforms.map.value !== texture) {
                const disposedTexture = uniforms.map.value;
                disposedTexture.dispose();
                // Remove disposed texture from cache to prevent stale references
                removeTextureFromCache(disposedTexture);
            }
            // Always dispose text textures (will be recreated)
            if (uniforms.textTexL && uniforms.textTexL.value) {
                uniforms.textTexL.value.dispose();
                state.textTextureL = null; // Clear state reference too
            }
            if (uniforms.textTexR && uniforms.textTexR.value) {
                uniforms.textTexR.value.dispose();
                state.textTextureR = null; // Clear state reference too
            }
        }

        state.mesh.geometry?.dispose();
        state.mesh.material?.dispose();
        state.mesh = null;
    }

    const img = texture.image;
    // Single-eye width must be integer (floor if combined width is odd)
    const eyeWidth = Math.floor(img.width / 2);
    const eyeHeight = img.height;

    if (eyeWidth <= 0 || eyeHeight <= 0) {
        logger.error('Renderer', 'Invalid image dimensions for mesh creation:', { eyeWidth, eyeHeight });
        throw new Error(`Invalid image dimensions: ${eyeWidth}x${eyeHeight}`);
    }

    const singleEyeAspect = eyeWidth / eyeHeight;

    const planeHeight = CONSTANTS.DEFAULT_PLANE_HEIGHT;
    const planeWidth = planeHeight * singleEyeAspect;
    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);

    state.material = createStereoMaterial(texture);

    state.mesh = new THREE.Mesh(geometry, state.material);
    state.mesh.userData.baseScaleX = 1.0;
    state.mesh.userData.baseScaleY = 1.0;

    state.scene.add(state.mesh);

    // Update resolution info (show single-eye resolution)
    const infoRes = document.getElementById('infoResolution');
    if (infoRes) {
        infoRes.textContent = `${eyeWidth} x ${eyeHeight}`;
    }
    updateCroppedResolution(eyeWidth, eyeHeight);

    // Fit after applying mode scale
    updateMeshScaleForMode();
    fitImageToWindow();

    render();
}

/**
* Update uniforms (reflect UI parameters)
*/
export function updateUniforms(skipRender = false) {
    if (!state.material || !state.renderer) return;
    // After a WebGL context-restore failure the active material may be a non-shader
    // fallback (MeshBasicMaterial) with no .uniforms. Skip parameter updates instead
    // of throwing, so the degraded fallback keeps rendering the texture rather than
    // bricking every UI control that calls updateUniforms().
    if (!state.material.uniforms) return;

    // Rebuild shader if mode group changes
    const newShaderGroup = getShaderGroup(state.params.mode);
    if (currentShaderGroup !== newShaderGroup) {
        rebuildShaderForMode(state.params.mode);
    }

    // Sanitize numeric params: replace NaN/Infinity with 0 to prevent GLSL corruption
    const safeFloat = (v) => Number.isFinite(v) ? v : 0;

    state.material.uniforms.shiftX.value = safeFloat(state.params.shiftX);
    state.material.uniforms.shiftY.value = safeFloat(state.params.shiftY);
    // alignTransform is a mat3 (9 floats). Apply the same NaN/Infinity guard as
    // the scalar uniforms above: a single corrupt element would make every sample
    // coordinate (t.xy / t.z) NaN and black out the whole image. Fall back to the
    // identity matrix rather than pushing a broken transform to the GPU. every()
    // avoids the per-call allocation of mapping the array.
    const alignArr = state.params.alignTransform;
    if (Array.isArray(alignArr) && alignArr.length >= 9 && alignArr.every(Number.isFinite)) {
        state.material.uniforms.alignTransform.value.fromArray(alignArr);
    } else {
        state.material.uniforms.alignTransform.value.identity();
    }
    state.material.uniforms.cropX.value = safeFloat(state.params.cropX);
    state.material.uniforms.cropY.value = safeFloat(state.params.cropY);
    state.material.uniforms.offsetX.value = safeFloat(state.params.offsetX);
    state.material.uniforms.offsetY.value = safeFloat(state.params.offsetY);
    state.material.uniforms.tvCropX.value = safeFloat(state.params.tvCropX);
    state.material.uniforms.tvCropY.value = safeFloat(state.params.tvCropY);
    state.material.uniforms.tvOffsetX.value = safeFloat(state.params.tvOffsetX);
    state.material.uniforms.tvOffsetY.value = safeFloat(state.params.tvOffsetY);
    state.material.uniforms.swapLR.value = state.params.swapLR ? 1.0 : 0.0;
    state.material.uniforms.mode.value = state.params.mode;
    state.material.uniforms.wigglePhase.value = safeFloat(state.params.wigglePhase);

    // Image adjustment parameters
    state.material.uniforms.brightnessL.value = safeFloat(state.params.brightnessL);
    state.material.uniforms.brightnessR.value = safeFloat(state.params.brightnessR);
    state.material.uniforms.contrastL.value = safeFloat(state.params.contrastL);
    state.material.uniforms.contrastR.value = safeFloat(state.params.contrastR);
    state.material.uniforms.saturationL.value = safeFloat(state.params.saturationL);
    state.material.uniforms.saturationR.value = safeFloat(state.params.saturationR);
    state.material.uniforms.hueL.value = safeFloat(state.params.hueL);
    state.material.uniforms.hueR.value = safeFloat(state.params.hueR);
    state.material.uniforms.sharpnessL.value = safeFloat(state.params.sharpnessL);
    state.material.uniforms.sharpnessR.value = safeFloat(state.params.sharpnessR);
    state.material.uniforms.noiseReductionL.value = safeFloat(state.params.noiseReductionL);
    state.material.uniforms.noiseReductionR.value = safeFloat(state.params.noiseReductionR);

    // Compute texelSize from texture size
    if (state.material.uniforms.map.value) {
        const tex = state.material.uniforms.map.value;
        const w = tex.image ? tex.image.width : 1024;
        const h = tex.image ? tex.image.height : 1024;
        state.material.uniforms.texelSize.value.set(1.0 / w, 1.0 / h);
    }

    // Grid parameters (reuse Vector3 to reduce GC)
    state.material.uniforms.gridEnabled.value = state.params.gridEnabled ? 1.0 : 0.0;
    state.material.uniforms.gridDensity.value = safeFloat(state.params.gridDensity);
    hexToRgbVectorReuse(state.params.gridColor, tempGridColorVector3);
    state.material.uniforms.gridColor.value.copy(tempGridColorVector3);

    // Update resolution uniform using renderer size
    state.renderer.getSize(tempVector2);
    state.material.uniforms.resolution.value.set(tempVector2.x, tempVector2.y);
    // Pair pixelRatio with resolution so the grid line-width math stays device-correct.
    if (state.material.uniforms.pixelRatio) {
        state.material.uniforms.pixelRatio.value = state.renderer.getPixelRatio();
    }

    // Viewer mode parameters. Route through the finite guards used for every other
    // numeric uniform: a NaN leaking in (e.g. from a degenerate pinch-zoom division)
    // would otherwise reach the shader unguarded. viewerScale is a DIVISOR in the
    // shader (baseUv = (baseUv - 0.5) / viewerScale + 0.5), so it falls back to 1
    // (not 0) to avoid blanking the frame.
    state.material.uniforms.viewerModeEnabled.value = state.viewerMode ? 1.0 : 0.0;
    state.material.uniforms.viewerPanX.value = safeFloat(state.viewerPanX);
    state.material.uniforms.viewerPanY.value = safeFloat(state.viewerPanY);
    state.material.uniforms.viewerScale.value =
        (Number.isFinite(state.viewerScale) && state.viewerScale !== 0) ? state.viewerScale : 1;

    // 3DTV mode
    state.material.uniforms.sbs3dtv.value = state.params.sbs3dtv ? 1.0 : 0.0;

    // 3D Pointer
    state.material.uniforms.pointer3dEnabled.value =
        (state.pointer3dEnabled && state.pointer3dVisible) ? 1.0 : 0.0;
    state.material.uniforms.pointer3dPos.value.set(state.pointer3dX, state.pointer3dY);
    state.material.uniforms.pointer3dParallax.value = state.pointer3dParallax;

    // Compute single-eye aspect ratio (SBS input halves width)
    if (state.material.uniforms.map.value && state.material.uniforms.map.value.image) {
        const img = state.material.uniforms.map.value.image;
        const eyeWidth = img.width / 2;
        const eyeHeight = img.height;

        // CRITICAL: Validate eyeHeight to prevent NaN propagation to shader uniforms
        // Check for positive finite number to prevent division by zero and NaN/Infinity
        if (eyeHeight > 0 && Number.isFinite(eyeHeight) && Number.isFinite(eyeWidth)) {
            // Account for crop when calculating aspect ratio for 3DTV mode
            // This ensures the aspect ratio matches the visible (cropped) area
            const effectiveEyeWidth = eyeWidth * (1.0 - state.params.cropX);
            const effectiveEyeHeight = eyeHeight * (1.0 - state.params.cropY);

            // Guard against zero/negative dimensions to prevent division by zero
            if (effectiveEyeHeight <= 0 || effectiveEyeWidth <= 0) {
                state.material.uniforms.imageAspect.value = 1.0;
            } else {
                state.material.uniforms.imageAspect.value = effectiveEyeWidth / effectiveEyeHeight;
            }
        } else {
            logger.error('Renderer', 'Invalid eyeHeight or eyeWidth for aspect ratio calculation:', { eyeWidth, eyeHeight });
            state.material.uniforms.imageAspect.value = 1.0; // Safe fallback to square aspect
        }
    }

    if (!skipRender) {
        render();
    }
}

/**
* Parse a hex color string to RGB values (shared helper)
* @param {string} hex - Hex color string
* @returns {Array<number>|null} [r, g, b] (0.0-1.0) or null (on parse failure)
*/
const HEX_RGB_REGEX = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
function parseHexToRgb(hex) {
    const result = HEX_RGB_REGEX.exec(hex);
    return result ? [
        parseInt(result[1], 16) / 255,
        parseInt(result[2], 16) / 255,
        parseInt(result[3], 16) / 255
    ] : null;
}

/**
* Convert a hex color to an RGB vector (returns a new Vector3)
*/
function hexToRgbVector(hex) {
    const rgb = parseHexToRgb(hex);
    return rgb ? new THREE.Vector3(rgb[0], rgb[1], rgb[2]) : new THREE.Vector3(1.0, 1.0, 1.0);
}

/**
* Convert a hex color to an RGB vector (updates an existing Vector3 to reduce GC)
*/
function hexToRgbVectorReuse(hex, targetVector) {
    const rgb = parseHexToRgb(hex);
    if (rgb) {
        targetVector.set(rgb[0], rgb[1], rgb[2]);
    } else {
        targetVector.set(1.0, 1.0, 1.0);
    }
    return targetVector;
}

/**
* Text overlay
*/
export function updateTextOverlay(redrawCanvas) {
    try {
        // After a failed WebGL context restore, state.material can be a fallback
        // MeshBasicMaterial with no .uniforms. Guard against it like updateUniforms()
        // and performAutoAlignment() do, so overlay edits in the degraded mode become
        // a clean no-op instead of throwing (and wastefully rasterizing text canvases).
        if (!state.material || !state.material.uniforms) return;

        const text = state.params.textString;

        if (!text || text.trim() === '') {
            state.material.uniforms.textEnabled.value = 0.0;
            // Release text texture from GPU memory on delete (prevent leaks)
            if (state.textTextureL) {
                state.textTextureL.dispose();
                state.textTextureL = null;
            }
            if (state.textTextureR) {
                state.textTextureR.dispose();
                state.textTextureR = null;
            }
            render();
            return;
        }

        if (redrawCanvas || !state.textTextureL || !state.textTextureR) {
            // Create two canvases for left/right eyes
            const canvasL = document.createElement('canvas');
            const canvasR = document.createElement('canvas');
            const ctxL = canvasL.getContext('2d');
            const ctxR = canvasR.getContext('2d');

            // Validate canvas context creation
            if (!ctxL || !ctxR) {
                logger.error('Renderer', 'Failed to create canvas 2D context for text overlay');
                return;
            }

            const canvasWidth = 2048;
            const canvasHeight = 512;
            canvasL.width = canvasWidth;
            canvasL.height = canvasHeight;
            canvasR.width = canvasWidth;
            canvasR.height = canvasHeight;

            ctxL.clearRect(0, 0, canvasWidth, canvasHeight);
            ctxR.clearRect(0, 0, canvasWidth, canvasHeight);

            // Validate text parameters
            const textSize = state.params.textSize;
            const textX = state.params.textX;
            const textY = state.params.textY;
            const textRotation = state.params.textRotation;

            if (!Number.isFinite(textSize) || textSize <= 0) {
                logger.error('Renderer', 'Invalid text size:', textSize);
                return;
            }
            if (!Number.isFinite(textX) || !Number.isFinite(textY)) {
                logger.error('Renderer', 'Invalid text position:', { textX, textY });
                return;
            }
            if (!Number.isFinite(textRotation)) {
                logger.error('Renderer', 'Invalid text rotation:', textRotation);
                return;
            }

            const fontSize = textSize * 4;
            ctxL.font = `bold ${fontSize}px sans-serif`;
            ctxL.textAlign = 'center';
            ctxL.textBaseline = 'middle';
            ctxR.font = `bold ${fontSize}px sans-serif`;
            ctxR.textAlign = 'center';
            ctxR.textBaseline = 'middle';

            const baseX = canvasWidth * textX;
            const baseY = canvasHeight * (1.0 - textY);

            // Compute aspect ratio compensation for isotropic rotation.
            // The canvas (2048x512, 4:1) gets mapped to the display mesh via UV, which may
            // have a different aspect ratio. Without compensation, rotating text in the
            // non-square canvas pixel space causes visible stretching on screen.
            // We apply scale(1, 1/rotComp) before rotation and scale(1, rotComp) after,
            // so that at 0° the net transform is identity, and at other angles the rotation
            // is isotropic in screen space.
            let rotComp = 1.0;
            if (state.mesh) {
                const canvasAR = canvasWidth / canvasHeight;
                const geomW = state.mesh.geometry.parameters?.width;
                const geomH = state.mesh.geometry.parameters?.height;
                if (!geomW || !geomH) return;
                const bsX = state.mesh.userData.baseScaleX || 1.0;
                const bsY = state.mesh.userData.baseScaleY || 1.0;
                const crX = 1.0 - state.params.cropX;
                const crY = 1.0 - state.params.cropY;
    
                let displayAR;
                const is3dtvActive = is3DTVActive();
                if (is3dtvActive) {
                    const container = document.getElementById('canvas-container');
                    const cw = container ? container.clientWidth : window.innerWidth;
                    const ch = container ? container.clientHeight : window.innerHeight;
                    displayAR = cw / ch;
                } else {
                    displayAR = (geomW * bsX * crX) / (geomH * bsY * crY);
                }
    
                if (displayAR > 0) {
                    rotComp = canvasAR / displayAR;
                }
            }
    
            // If 3D effect is enabled, draw per character for each eye
            if (state.params.textEffect !== 'none' && text.length > 1) {
                const chars = text.split('');
                const charWidths = chars.map(ch => ctxL.measureText(ch).width);
    
                // Draw left-eye canvas
                ctxL.save();
                ctxL.translate(baseX, baseY);
                ctxL.scale(1, 1 / rotComp);
                ctxL.rotate(state.params.textRotation * Math.PI / 180);
                ctxL.scale(1, rotComp);
    
                // Draw right-eye canvas
                ctxR.save();
                ctxR.translate(baseX, baseY);
                ctxR.scale(1, 1 / rotComp);
                ctxR.rotate(state.params.textRotation * Math.PI / 180);
                ctxR.scale(1, rotComp);
    
                // Center using the summed per-character widths (not measureText of the
                // whole string) so the start position matches the per-character layout
                // below; kerning makes the two measurements differ otherwise.
                const totalCharWidth = charWidths.reduce((a, b) => a + b, 0);
                let currentX = -totalCharWidth / 2;

                // Depth parallax must act horizontally in screen space. Glyphs are drawn
                // inside the rotated / aspect-compensated context, so the horizontal
                // offset is pre-transformed by the inverse of that context transform.
                // This keeps the per-eye separation purely horizontal on screen; applying
                // it in the rotated local frame would add vertical disparity that breaks
                // stereo fusion.
                const tTheta = state.params.textRotation * Math.PI / 180;
                const tCos = Math.cos(tTheta);
                const tSin = Math.sin(tTheta);

                chars.forEach((char, idx) => {
                    const charCenterX = currentX + charWidths[idx] / 2;
    
                    // Compute stepped depth (based on character index)
                    let depth = 0;
                    const strength = state.params.textEffectStrength;
                    const numChars = chars.length;
    
                    // Normalize character position to 0-1
                    const normalizedPos = idx / (numChars - 1 || 1);
    
                    switch (state.params.textEffect) {
                        case 'concave': // Concave: edges forward, center back (stepped)
                            const distanceFromCenter = Math.abs(normalizedPos - 0.5) * 2;
                            depth = (0.5 - distanceFromCenter) * strength;
                            break;
                        case 'convex': // Convex: edges back, center forward (stepped)
                            const distFromCenter = Math.abs(normalizedPos - 0.5) * 2;
                            depth = (distFromCenter - 0.5) * strength;
                            break;
                        case 'swing_front': // Swing front: left forward, right back (stepped)
                            depth = (0.5 - normalizedPos) * strength;
                            break;
                        case 'swing_back': // Swing back: left back, right forward (stepped)
                            depth = (normalizedPos - 0.5) * strength;
                            break;
                    }
    
                    // Per-eye horizontal separation in screen space.
                    // depth > 0 pushes the glyph behind the screen (left eye left,
                    // right eye right); depth < 0 brings it forward.
                    const depthOffset = depth * state.params.textParallax * canvasWidth * 5.0;

                    // Local-frame offset whose image under scale(1,1/rotComp)·rotate(θ)·
                    // scale(1,rotComp) is exactly (±depthOffset, 0) on the canvas, so the
                    // net L/R separation stays horizontal regardless of rotation.
                    const offDX = depthOffset * tCos;
                    const offDY = depthOffset * tSin / rotComp;
                    const finalXL = charCenterX - offDX; // Left eye
                    const finalYL = offDY;
                    const finalXR = charCenterX + offDX; // Right eye
                    const finalYR = -offDY;
    
                    // Draw on left-eye canvas
                    if (state.params.textStroke > 0) {
                        ctxL.strokeStyle = '#000000';
                        ctxL.lineWidth = state.params.textStroke * 4;
                        ctxL.lineJoin = 'round';
                        ctxL.strokeText(char, finalXL, finalYL);
                    }
                    ctxL.fillStyle = state.params.textColor;
                    ctxL.fillText(char, finalXL, finalYL);
    
                    // Draw on right-eye canvas
                    if (state.params.textStroke > 0) {
                        ctxR.strokeStyle = '#000000';
                        ctxR.lineWidth = state.params.textStroke * 4;
                        ctxR.lineJoin = 'round';
                        ctxR.strokeText(char, finalXR, finalYR);
                    }
                    ctxR.fillStyle = state.params.textColor;
                    ctxR.fillText(char, finalXR, finalYR);
    
                    currentX += charWidths[idx];
                });
    
                ctxL.restore();
                ctxR.restore();
            } else {
                // Normal draw (no effect) - same for both
                ctxL.save();
                ctxL.translate(baseX, baseY);
                ctxL.scale(1, 1 / rotComp);
                ctxL.rotate(state.params.textRotation * Math.PI / 180);
                ctxL.scale(1, rotComp);
    
                ctxR.save();
                ctxR.translate(baseX, baseY);
                ctxR.scale(1, 1 / rotComp);
                ctxR.rotate(state.params.textRotation * Math.PI / 180);
                ctxR.scale(1, rotComp);
    
                // Left eye
                if (state.params.textStroke > 0) {
                    ctxL.strokeStyle = '#000000';
                    ctxL.lineWidth = state.params.textStroke * 4;
                    ctxL.lineJoin = 'round';
                    ctxL.strokeText(text, 0, 0);
                }
                ctxL.fillStyle = state.params.textColor;
                ctxL.fillText(text, 0, 0);
    
                // Right eye
                if (state.params.textStroke > 0) {
                    ctxR.strokeStyle = '#000000';
                    ctxR.lineWidth = state.params.textStroke * 4;
                    ctxR.lineJoin = 'round';
                    ctxR.strokeText(text, 0, 0);
                }
                ctxR.fillStyle = state.params.textColor;
                ctxR.fillText(text, 0, 0);
    
                ctxL.restore();
                ctxR.restore();
            }

            // Dispose prior textures
            if (state.textTextureL) {
                state.textTextureL.dispose();
            }
            if (state.textTextureR) {
                state.textTextureR.dispose();
            }

            // Create new textures with error handling
            try {
                state.textTextureL = new THREE.CanvasTexture(canvasL);
                state.textTextureL.minFilter = THREE.LinearFilter;
                state.textTextureL.magFilter = THREE.LinearFilter;

                state.textTextureR = new THREE.CanvasTexture(canvasR);
                state.textTextureR.minFilter = THREE.LinearFilter;
                state.textTextureR.magFilter = THREE.LinearFilter;
            } catch (textureErr) {
                logger.error('Renderer', 'Failed to create text overlay textures:', textureErr);
                // Clean up on failure
                if (state.textTextureL) {
                    try {
                        state.textTextureL.dispose();
                    } catch (disposeErr) {
                        logger.warn('Renderer', 'Error disposing textTextureL:', disposeErr);
                    }
                    state.textTextureL = null;
                }
                if (state.textTextureR) {
                    try {
                        state.textTextureR.dispose();
                    } catch (disposeErr) {
                        logger.warn('Renderer', 'Error disposing textTextureR:', disposeErr);
                    }
                    state.textTextureR = null;
                }
                return;
            }
        }

        // Validate textures before applying to material
        if (!state.textTextureL || !state.textTextureR) {
            logger.error('Renderer', 'Text textures are not available');
            return;
        }

        state.material.uniforms.textTexL.value = state.textTextureL;
        state.material.uniforms.textTexR.value = state.textTextureR;
        state.material.uniforms.textEnabled.value = 1.0;
        state.material.uniforms.textParallax.value = state.params.textParallax;

        render();
    } catch (err) {
        logger.error('Renderer', 'Error in updateTextOverlay:', err);
        // Disable text overlay on error to prevent repeated failures
        try {
            if (state.material && state.material.uniforms && state.material.uniforms.textEnabled) {
                state.material.uniforms.textEnabled.value = 0.0;
            }
        } catch (cleanupErr) {
            logger.error('Renderer', 'Error disabling text overlay after failure:', cleanupErr);
        }
    }
}

/**
* Update UI with cropped resolution info
* Note: show single-eye resolution only (adjusted to even pixels)
*/
export function updateCroppedResolution(eyeWidth, eyeHeight) {
    const cropRatioX = 1.0 - state.params.cropX;
    const cropRatioY = 1.0 - state.params.cropY;
    // Adjust to even pixels to match actual output size. Round (not floor) so the
    // displayed resolution matches the exporter: cropX/cropY encode an even pixel
    // count whose float round-trip lands just under the integer, which floor +
    // ensureEven would render 2px short (see ui-export.js).
    const croppedWidth = ensureEven(Math.round(eyeWidth * cropRatioX));
    const croppedHeight = ensureEven(Math.round(eyeHeight * cropRatioY));

    const croppedResEl = document.getElementById('infoCroppedResolution');
    if (croppedResEl) {
        // Simple display (top-right panel)
        croppedResEl.textContent = `${croppedWidth} x ${croppedHeight}`;
    }
}

export function updateSceneWithImage(texture) {
    createStereoMesh(texture);
    window.dispatchEvent(new Event('stereo-image-loaded'));

    // Update if histogram panel is visible
    setTimeout(() => {
        const histogramPanel = document.getElementById('histogram-panel');
        if (histogramPanel && histogramPanel.style.display !== 'none') {
            // Call updateHistogramPanel from ui.js
            window.dispatchEvent(new Event('refresh-histogram'));
        }
    }, 100);
}

/**
* Fit (fit within the display area)
*/
export function fitImageToWindow() {
    if (!state.mesh) return;

    // Guard against a collapsed/hidden container (clientWidth/Height === 0, e.g.
    // display:none or a mid-layout image load). Without this, aspect becomes 0 or
    // NaN below, fitScale collapses to 0, and scale=0 is persisted into
    // state.params — blanking the viewer until a manual rescale. Mirrors the guard
    // in onWindowResize(). Bail out before mutating any state so a later, valid
    // fit (triggered when the container regains size) starts from clean values.
    const fitContainer = document.getElementById('canvas-container');
    const fitCheckW = fitContainer ? fitContainer.clientWidth : window.innerWidth;
    const fitCheckH = fitContainer ? fitContainer.clientHeight : window.innerHeight;
    if (!(fitCheckW > 0) || !(fitCheckH > 0)) {
        return;
    }

    // Always center in viewer mode
    state.params.panX = 0;
    state.params.panY = 0;

    // Determine 3DTV mode first
    const is3dtvMode = is3DTVActive();

    // Reset viewerScale and viewerPan in viewer mode
    if (state.viewerMode) {
        state.viewerScale = 1.0;
        state.viewerPanX = 0;
        state.viewerPanY = 0;
        state.viewerFitScale = 1.0; // Placeholder value, overwritten later
    }

    // In 3DTV mode, reset viewerScale regardless of viewerMode
    // (viewerScale is used for zoom in the shader)
    if (is3dtvMode) {
        state.viewerScale = 1.0;
        state.viewerPanX = 0;
        state.viewerPanY = 0;
        // Update uniforms (skip render to avoid redundant rendering)
        updateUniforms(true);
    }

    updateMeshScaleForMode();

    const geomW = state.mesh.geometry.parameters.width;
    const geomH = state.mesh.geometry.parameters.height;

    const baseScaleX = state.mesh.userData.baseScaleX || 1.0;
    const baseScaleY = state.mesh.userData.baseScaleY || 1.0;

    const cropRatioX = 1.0 - state.params.cropX;
    const cropRatioY = 1.0 - state.params.cropY;

    // In normal modes, FIT should target the post-crop visible area.
    // In 3DTV mode, mesh transform intentionally ignores regular crop ratio,
    // so keep FIT based on full geometry there.
    const meshBaseW = is3dtvMode ? geomW : geomW * baseScaleX * cropRatioX;
    const meshBaseH = is3dtvMode ? geomH : geomH * baseScaleY * cropRatioY;

    // Use canvas-container size
    const container = document.getElementById('canvas-container');
    const containerWidth = container ? container.clientWidth : window.innerWidth;
    const containerHeight = container ? container.clientHeight : window.innerHeight;

    const frustumH = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
    const aspect = containerWidth / containerHeight;
    const frustumW = frustumH * aspect;

    const margin = 1.0;  // Fit without gaps
    const scaleW = (frustumW * margin) / meshBaseW;
    const scaleH = (frustumH * margin) / meshBaseH;

    const fitScale = Math.min(scaleW, scaleH);

    state.params.scale = fitScale;

    // Save fit scale in viewer mode
    if (state.viewerMode) {
        state.viewerFitScale = fitScale;
    }

    // Update mesh and uniforms in the same order as the 3DTV button
    // (updateMeshTransform → updateUniforms)
    // Skip individual renders to avoid redundancy; render once at the end
    updateMeshTransform(true);
    updateUniforms(true);

    // Render once after all updates are complete
    render();

    window.dispatchEvent(new CustomEvent('param-changed-externally', { detail: { name: 'scale', value: fitScale } }));

    // Update zoom display in viewer mode
    if (state.viewerMode) {
        // Use viewerScale in 3DTV mode
        // Non-3DTV SBS uses state.params.scale * state.viewerScale (same as wheel zoom)
        // Otherwise use state.params.scale
        let displayScale;
        if (is3dtvMode) {
            displayScale = state.viewerScale;
        } else if (isSBSMode(state.params.mode)) {
            displayScale = state.params.scale * state.viewerScale;
        } else {
            displayScale = state.params.scale;
        }
        window.dispatchEvent(new CustomEvent('viewer-zoom-changed', { detail: { scale: displayScale } }));
    }
}

/**
* Adjust mesh shape based on mode
*/
export function updateMeshScaleForMode() {
    if (!state.mesh) return;

    const mode = state.params.mode;

    let baseScaleX = 1.0;
    let baseScaleY = 1.0;

    if (isFullSBSMode(mode)) {
        // Full SBS: double width
        baseScaleX = 2.0;
    }
    else if (mode === 12) {
        // LRL: triple width
        baseScaleX = 3.0;
    }
    else if (mode === 13) {
        // Matrix 2x2: double width/height
        baseScaleX = 2.0;
        baseScaleY = 2.0;
    }
    else if (mode === 16) {
        // Full TaB: double height
        baseScaleY = 2.0;
    }
    // mode 7 (Half SBS) and mode 10 (Half TaB) are compressed, keep baseScale at 1.0

    state.mesh.userData.baseScaleX = baseScaleX;
    state.mesh.userData.baseScaleY = baseScaleY;

    if (state.material && state.material.uniforms && state.material.uniforms.map.value && state.material.uniforms.map.value.image) {
        const img = state.material.uniforms.map.value.image;
        // Floor to the actual even-snapped eye width (matches createStereoMesh and the
        // export path). Passing the raw img.width/2 for an odd-width source rounds the
        // cropped-resolution readout up by 2px, disagreeing with the exported size.
        updateCroppedResolution(Math.floor(img.width / 2), img.height);
    }

    updateMeshTransform();
}

/**
* Update mesh transform
*/
export function updateMeshTransform(skipRender = false) {
    if (!state.mesh) return;

    const baseScaleX = state.mesh.userData.baseScaleX || 1.0;
    const baseScaleY = state.mesh.userData.baseScaleY || 1.0;
    const s = state.params.scale;

    // Scale with crop considered (preserve aspect ratio)
    const cropRatioX = 1.0 - state.params.cropX;
    const cropRatioY = 1.0 - state.params.cropY;

    // In 3DTV mode, stretch mesh to cover the screen
    const is3dtvTargetMode = is3DTVActive();
    if (is3dtvTargetMode) {
        // Compute scale to cover the screen
        const container = document.getElementById('canvas-container');
        const containerWidth = container ? container.clientWidth : window.innerWidth;
        const containerHeight = container ? container.clientHeight : window.innerHeight;

        const frustumH = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        const aspect = containerWidth / containerHeight;
        const frustumW = frustumH * aspect;

        const geomW = state.mesh.geometry.parameters.width;
        const geomH = state.mesh.geometry.parameters.height;

        // In 3DTV mode, ignore baseScale and use geometry size only
        // This makes Half SBS/Full SBS/Half TaB cover the screen
        const meshBaseW = geomW;  // Do not apply baseScaleX
        const meshBaseH = geomH;  // Do not apply baseScaleY

        // Stretch to cover the screen (ignore aspect ratio)
        const stretchScaleX = frustumW / meshBaseW;
        const stretchScaleY = frustumH / meshBaseH;

        // In 3DTV mode, keep mesh always full-screen.
        // Aspect fit and crop behavior are handled in shader UV mapping.
        state.mesh.scale.set(stretchScaleX, stretchScaleY, 1);
    } else {
        // Normal mode
        state.mesh.scale.set(baseScaleX * s * cropRatioX, baseScaleY * s * cropRatioY, 1);
    }

    state.mesh.position.x = state.params.panX;
    state.mesh.position.y = state.params.panY;

    if (!skipRender) {
        render();
    }
}
