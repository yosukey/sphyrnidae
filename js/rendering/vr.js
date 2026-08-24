/**
 * vr.js
 * VR mode implementation using WebXR API
 */

import { showToast } from '../ui/ui-toast.js';
import * as THREE from 'three';
import { state, DEBUG } from '../globals.js';
import { applyVRZoomDelta } from '../ui/ui-input.js';
import { readVRControllerInput } from './vr-input.js';
import * as logger from '../utils/logger.js';

let vrButton = null;
let vrSession = null;
let vrRefSpace = null;

// Left/right eye meshes for VR
let vrMeshLeft = null;
let vrMeshRight = null;
let vrMaterialLeft = null;
let vrMaterialRight = null;

// Import animate function once and keep it
let animateFunction = null;
// Resume helper from main.js: cancels any live rAF chain before starting one, so a
// failed VR start cannot leave two concurrent normal-render loops running.
let resumeAnimationFunction = null;
let animateModulePromise = null;

// Save scale to restore on VR exit
let savedMeshScale = null;

// VR support state
let vrSupported = false;

// VR session change flag (prevent rapid clicks)
let isVRSessionChanging = false;

// VR initialized flag (prevent duplicate initialization)
let vrInitialized = false;

// Fallback animation frame ID for cleanup
let fallbackAnimationFrameId = null;

// VR navigation via analog stick
const VR_STICK_DEADZONE = 0.2;
const VR_STICK_ZOOM_SPEED = 0.04;
const VR_STICK_HORIZONTAL_COOLDOWN_MS = 280;
const VR_STICK_VIEW_SCALE_MIN = 0.5;
const VR_STICK_VIEW_SCALE_MAX = 3.0;

let vrViewScale = 1.0;

const vrStickState = {
    leftTriggered: false,
    rightTriggered: false,
    lastHorizontalActionTime: 0
};

// Edge-trigger state for the controller exit button (see vr-input.js), so
// holding the button down ends the session once instead of every frame.
// Initialized/reset to true by resetVRStickState(); see the note there.
let vrExitButtonHeld = true;
// Set once the controller has asked for the session to end; cleared when the
// VR navigation state is reset (session start / session end).
let vrExitRequested = false;

/**
 * Check VR support and initialize button
 */
export function initVR() {
    // Prevent duplicate initialization
    if (vrInitialized) {
        logger.debug('VR_LOG', 'VR','[VR] initVR() called multiple times. Skipping duplicate initialization.');
        return;
    }
    vrInitialized = true;

    logger.debug('VR_LOG', 'VR','Starting VR initialization');

    // Check WebXR API support
    if ('xr' in navigator) {
        logger.debug('VR_LOG', 'VR','WebXR API is available');
        navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
            if (supported) {
                logger.debug('VR_LOG', 'VR','VR session is supported');
                createVRButton();
            } else {
                logger.debug('VR_LOG', 'VR','VR session is not supported');
                // Explicitly set vrSupported to false when not supported
                vrSupported = false;
            }
        }).catch((error) => {
            logger.error('VR','Error while checking VR support:', error);
            // Explicitly set vrSupported to false on error
            vrSupported = false;
            // VR button will remain hidden since vrSupported is false
        });
    } else {
        logger.debug('VR_LOG', 'VR','WebXR API is not available');
        // Explicitly set vrSupported to false when WebXR not available
        vrSupported = false;
    }
}

/**
 * Initialize VR button
 * Called only when VR is confirmed to be supported
 */
function createVRButton() {
    // Get existing VR button from HTML
    vrButton = document.getElementById('vr-button');

    if (!vrButton) {
        logger.warn('VR', 'VR button not found in DOM');
        // Set vrSupported to false if button element is missing
        vrSupported = false;
        return;
    }

    // Add click event listener
    vrButton.addEventListener('click', onVRButtonClick);

    // Record VR support state (used to control display in viewer mode)
    vrSupported = true;

    // Keep hidden by default (show only in viewer mode)
    logger.debug('VR_LOG', 'VR','Initialized VR button (waiting for viewer mode)');
}

/**
 * Show VR button (called when viewer mode starts)
 */
export function showVRButton() {
    if (vrButton && vrSupported) {
        vrButton.style.display = 'flex';
        if (!vrSession) {
            vrButton.setAttribute('data-i18n', 'vr.modeDisplay');
            vrButton.setAttribute('data-i18n-title', 'vr.modeDisplay');
            vrButton.classList.remove('vr-active');
            window.updateI18nContent?.();
        }
        logger.debug('VR_LOG', 'VR','VR button shown');
    }
}

/**
 * Hide VR button (called when viewer mode ends)
 */
export function hideVRButton() {
    if (vrButton) {
        vrButton.style.display = 'none';
        logger.debug('VR_LOG', 'VR','VR button hidden');
    }
}

/**
 * Get the current VR session (for cleanup and management)
 * @returns {Object|null} The current VR session or null if not active
 */
export function getVRSession() {
    return vrSession;
}

/**
 * End the VR session (for page lifecycle cleanup)
 * @returns {Promise<void>}
 */
export async function endVRSession() {
    if (vrSession) {
        try {
            await vrSession.end();
        } catch (err) {
            logger.error('VR','Error ending VR session:', err);
            // If .end() rejected, the XR 'end' event may never fire, so run the
            // full teardown manually instead of only nulling vrSession — otherwise
            // renderer.xr stays enabled, the animation loop and stereo-image-loaded
            // listener keep running, and the VR meshes/materials leak. Mirrors the
            // timeout paths in onVRButtonClick, which also force onSessionEnded().
            //
            // Guard on vrSession: if the 'end' event already ran onSessionEnded during
            // the await (e.g. a concurrent headset-initiated end raced this call and
            // then end() rejected with "already ended"), vrSession is already null and
            // calling onSessionEnded() again would kick off a second animate() rAF
            // chain that runs forever alongside the first. Same guard style as the
            // 'session end timeout' branch in onVRButtonClick.
            if (vrSession) {
                onSessionEnded();
            }
        }
    }
}

/**
 * Handle VR button clicks
 * Uses a lock to prevent race conditions from rapid clicks
 * Includes timeout protection to prevent permanent stuck state
 */
async function onVRButtonClick() {
    // Ignore if processing (prevent rapid clicks)
    if (isVRSessionChanging) {
        logger.debug('VR_LOG', 'VR','Ignoring request while VR session is changing');
        return;
    }

    isVRSessionChanging = true;

    try {
        if (!vrSession) {
            // Start VR session with timeout protection (10 seconds)
            let sessionTimedOut = false;
            const sessionPromise = navigator.xr.requestSession('immersive-vr', {
                optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking']
            });

            // Guard against late resolve: if timeout won, discard late session.
            // Attached BEFORE the await so it is registered even when Promise.race
            // rejects on timeout (otherwise this code would be unreachable and a
            // late-arriving XR session would leak, never being ended).
            sessionPromise.then(lateSession => {
                if (sessionTimedOut && lateSession) {
                    logger.warn('VR', 'Discarding late VR session that arrived after timeout');
                    try { lateSession.end(); } catch (e) { /* ignore */ }
                }
            }).catch(() => {}); // ignore late rejection

            let timeoutTimerId = null;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutTimerId = setTimeout(() => {
                    sessionTimedOut = true;
                    reject(new Error('VR session start timeout'));
                }, 10000);
            });

            const session = await Promise.race([sessionPromise, timeoutPromise]);

            // Success path: clear the timeout timer so sessionTimedOut cannot later
            // flip to true and end the now-active session.
            if (timeoutTimerId !== null) {
                clearTimeout(timeoutTimerId);
                timeoutTimerId = null;
            }

            await onSessionStarted(session);
        } else {
            // End VR session with timeout protection (5 seconds)
            const endPromise = vrSession.end();
            let endTimeoutTimerId = null;
            const timeoutPromise = new Promise((_, reject) => {
                endTimeoutTimerId = setTimeout(() => reject(new Error('VR session end timeout')), 5000);
            });

            try {
                await Promise.race([endPromise, timeoutPromise]);
            } finally {
                // Clear the timer on the normal-exit path so it does not linger for
                // 5s after end() resolves (mirrors the start branch's cleanup).
                if (endTimeoutTimerId !== null) {
                    clearTimeout(endTimeoutTimerId);
                    endTimeoutTimerId = null;
                }
            }
        }
    } catch (error) {
        logger.error('VR','Failed to start/end VR session:', error);

        // If session start timed out, force cleanup to reset state
        if (error.message === 'VR session start timeout') {
            logger.warn('VR', 'Session start timed out, resetting state');
            onSessionEnded();
        }

        // If session end timed out, force cleanup
        if (error.message === 'VR session end timeout' && vrSession) {
            logger.warn('VR', 'Session end timed out, forcing cleanup');
            onSessionEnded();  // Force cleanup
        }

        const errorMessage = window.t?.('messages.vrStartFailed') || 'Failed to start VR mode. Please try again.';
        showToast(errorMessage, 'error');
    } finally {
        // Ensure flag is always reset, even if errors occur
        isVRSessionChanging = false;
    }
}

/**
 * Handle VR session start
 * Includes comprehensive error handling to ensure VR state consistency
 */
async function onSessionStarted(session) {
    vrSession = session;

    // Event listener for session end
    session.addEventListener('end', onSessionEnded);

    try {
        // Start VR render loop (set before xr.enabled=true)
        state.renderer.xr.enabled = true;

        // Enable XR on renderer. three.js's setSession() itself requests the
        // reference space (default type 'local-floor'), so on a headset/browser that
        // declines the optional local-floor feature it rejects here — a fallback that
        // tried to manually set the reference space afterward would never run, since
        // setSession has already failed, causing VR to fail outright. Retry with the
        // 'local' reference space type instead so VR still starts.
        try {
            await state.renderer.xr.setSession(session);
        } catch (setSessionError) {
            logger.debug('VR_LOG', 'VR', 'setSession failed (local-floor likely unavailable), retrying with local reference space:', setSessionError);
            state.renderer.xr.setReferenceSpaceType('local');
            await state.renderer.xr.setSession(session);
        }

        // Update VR button text and style
        vrButton.setAttribute('data-i18n', 'vr.exitMode');
        vrButton.classList.add('vr-active');

        // Update i18n content
        if (window.updateI18nContent) {
            window.updateI18nContent();
        }

        // Configure scene for VR mode
        resetVRStickState();
        setupVRScene();

        // Rebuild the VR eye meshes whenever a new image loads during the session
        // (analog-stick navigation). Removed in onSessionEnded.
        window.addEventListener('stereo-image-loaded', onStereoImageLoadedDuringVR);

        // Per-eye layer separation (layer 1 = left, layer 2 = right) is handled
        // automatically by three.js WebXRManager: it hardcodes layer 1 on the left XR
        // sub-camera and layer 2 on the right. render() passes state.vrCamera during VR,
        // so no manual layers.enable() is needed here. (Enabling them on state.vrCamera
        // would make BOTH eyes render BOTH meshes and defeat the separation; the previous
        // enable on state.camera — the 2D camera, never used in VR — was inert except for
        // leaving stray layer bits set on it after the session.)

        // A prior onSessionEnded recovery may have left a fallback rAF loop
        // running; cancel it so it cannot render concurrently with the VR loop.
        if (fallbackAnimationFrameId !== null) {
            cancelAnimationFrame(fallbackAnimationFrameId);
            fallbackAnimationFrameId = null;
        }

        // Set animation loop for VR mode
        // Import and use main.js animate once
        if (!animateFunction) {
            // Always re-import if animate is not resolved, so that a successful
            // import that yielded undefined animate does not cache a stale promise.
            animateModulePromise = null;
            animateModulePromise = import('../main.js').then(module => {
                if (typeof module.animate !== 'function') {
                    throw new Error('main.js loaded but animate is not a function');
                }
                animateFunction = module.animate;
                resumeAnimationFunction = (typeof module.resumeAnimationLoop === 'function')
                    ? module.resumeAnimationLoop : null;
                return module;
            }).catch(err => {
                logger.error('VR','Failed to import main.js for VR animation:', err);
                animateModulePromise = null;
                return null;
            });
        }

        // Await animation module loading to ensure errors are properly propagated
        try {
            await animateModulePromise;
            if (animateFunction) {
                state.renderer.setAnimationLoop(animateFunction);
            } else {
                logger.error('VR','Animation function not available for VR mode, ending VR session');
                // End VR session if animation function is not available
                await endVRSession().catch(endErr => {
                    logger.error('VR','Failed to end VR session after animation load failure:', endErr);
                });
                throw new Error('Animation function not available for VR mode');
            }
        } catch (err) {
            logger.error('VR','Failed to set VR animation loop:', err);
            // End VR session on animation setup failure
            await endVRSession().catch(endErr => {
                logger.error('VR','Failed to end VR session after animation setup failure:', endErr);
            });
            throw err;
        }

        logger.debug('VR_LOG', 'VR','VR session started');

    } catch (error) {
        // Clean up on initialization failure
        logger.error('VR','VR session initialization failed:', error);

        // Reset VR state
        vrSession = null;
        vrRefSpace = null;
        state.renderer.xr.enabled = false;

        // Try to end the session gracefully
        try {
            await session.end();
        } catch (endError) {
            logger.debug('VR_LOG', 'VR','Failed to end VR session after init error:', endError);
        }

        // Re-throw to let the caller handle the error (show alert, etc.)
        throw error;
    }
}

/**
 * Handle VR session end
 */
function onSessionEnded() {
    // Remove the 'end' event listener before clearing vrSession so that
    // a delayed 'end' event (e.g. when session.end() timed out and onSessionEnded
    // was already invoked manually) does not trigger this handler a second time.
    if (vrSession) {
        try {
            vrSession.removeEventListener('end', onSessionEnded);
        } catch (e) { /* ignore */ }
    }
    // Stop rebuilding VR meshes on image load now that the session is ending.
    window.removeEventListener('stereo-image-loaded', onStereoImageLoadedDuringVR);
    vrSession = null;
    vrRefSpace = null;

    // Restore VR button text and style (guard against null vrButton)
    if (vrButton) {
        vrButton.setAttribute('data-i18n', 'vr.modeDisplay');
        vrButton.classList.remove('vr-active');
    }

    // Update i18n content
    if (window.updateI18nContent) {
        window.updateI18nContent();
    }

    // Return to normal rendering (guard against null renderer)
    if (state.renderer) {
        state.renderer.xr.enabled = false;
        // Clear animation loop (return to requestAnimationFrame)
        state.renderer.setAnimationLoop(null);
    }

    // Clean up VR scene
    cleanupVRScene();
    cleanupVRNavigation();

    // Cancel any previous fallback animation loop before starting a new one
    if (fallbackAnimationFrameId !== null) {
        cancelAnimationFrame(fallbackAnimationFrameId);
        fallbackAnimationFrameId = null;
    }

    // Resume normal rendering. Prefer resumeAnimationLoop() over calling animate()
    // directly: it cancels any existing rAF chain before starting one, so a failed
    // VR start (which never stopped the normal loop) cannot leave two concurrent
    // chains running. Fall back to animate() only if the resume helper is unavailable.
    if (resumeAnimationFunction) {
        resumeAnimationFunction();
    } else if (animateFunction) {
        animateFunction();
    } else {
        // Fallback: import if not loaded yet
        animateModulePromise = import('../main.js').then(module => {
            animateFunction = module.animate;
            resumeAnimationFunction = (typeof module.resumeAnimationLoop === 'function')
                ? module.resumeAnimationLoop : null;
            (resumeAnimationFunction || animateFunction)();
            return module;
        }).catch(err => {
            logger.error('VR','Failed to import main.js after VR session ended:', err);
            // Attempt to recover by requesting animation frame manually
            if (typeof requestAnimationFrame !== 'undefined') {
                logger.warn('VR', 'Attempting recovery with requestAnimationFrame');
                import('../rendering/renderer.js')
                    .then(({ render }) => {
                        if (render) {
                            const fallbackAnimate = () => {
                                if (fallbackAnimationFrameId === null) return; // cancelled
                                render();
                                fallbackAnimationFrameId = requestAnimationFrame(fallbackAnimate);
                            };
                            fallbackAnimationFrameId = requestAnimationFrame(fallbackAnimate);
                        }
                    })
                    .catch(() => {});
            }
        });
    }

    logger.debug('VR_LOG', 'VR','VR session ended');
}

/**
 * Scene setup for VR mode
 */
function setupVRScene() {
    if (!state.mesh || !state.material) {
        logger.debug('VR_LOG', 'VR','No image loaded');
        return;
    }

    // Save scale before VR (restore on exit)
    savedMeshScale = {
        x: state.mesh.scale.x,
        y: state.mesh.scale.y,
        z: state.mesh.scale.z
    };

    // Restrict existing mesh to Layer 0 (hidden in VR mode)
    state.mesh.layers.set(0);
    state.mesh.visible = false;

    // Create left/right eye meshes for VR
    createVRStereoMeshes();
}

/**
 * Create left/right eye meshes for VR
 * Split SBS image and feed each eye
 */
function createVRStereoMeshes() {
    // Optional-chain uniforms: after a failed WebGL context restore the active
    // material is a MeshBasicMaterial fallback with no .uniforms, and a bare
    // .uniforms.map access would throw a TypeError that aborts VR startup.
    if (!state.material || !state.material.uniforms?.map?.value) {
        logger.debug('VR_LOG', 'VR','VR material creation: no texture');
        return;
    }

    const texture = state.material.uniforms.map.value;
    const params = state.params;

    // Calculate SBS image aspect ratio (per eye)
    const img = texture.image;
    const eyeWidth = img.width / 2;
    const eyeHeight = img.height;
    const aspect = eyeWidth / eyeHeight;

    // Size in VR space (based on 2m height)
    const planeHeight = 2.0;
    const planeWidth = planeHeight * aspect;

    // VR-specific shader (simple, viewing-focused)
    const vertexShader = `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;

    // Determine sampling sides considering swapLR
    const swapped = params.swapLR;
    const leftSampleLeft = swapped ? false : true;
    const rightSampleLeft = swapped ? true : false;

    // Left-eye fragment shader
    const fragmentShaderLeft = createVRFragmentShader(true, leftSampleLeft);
    // Right-eye fragment shader
    const fragmentShaderRight = createVRFragmentShader(false, rightSampleLeft);

    // Build initial uniform values
    const leftVals = getVRUniformValues(true, params);
    const rightVals = getVRUniformValues(false, params);

    // Validate alignTransform before seeding the uniform, matching the guard in
    // updateVRShaderParams and renderer.js. Matrix3.fromArray on a non-finite or
    // wrong-shape array yields a NaN matrix; fall back to identity (Matrix3's
    // default) so a corrupt param cannot produce a bad initial VR frame. Each eye
    // needs its own instance since updateVRShaderParams mutates them independently.
    const makeAlignMatrix = () => {
        const m = new THREE.Matrix3();
        if (Array.isArray(params.alignTransform) && params.alignTransform.length >= 9 &&
            params.alignTransform.every(Number.isFinite)) {
            m.fromArray(params.alignTransform);
        }
        return m;
    };

    // Left-eye material (uniforms allow live parameter updates)
    vrMaterialLeft = new THREE.ShaderMaterial({
        uniforms: {
            map: { value: texture },
            shiftX: { value: leftVals.shiftX },
            shiftY: { value: leftVals.shiftY },
            cropX: { value: params.cropX ?? 0 },
            cropY: { value: params.cropY ?? 0 },
            offsetX: { value: params.offsetX ?? 0 },
            offsetY: { value: params.offsetY ?? 0 },
            alignTransform: { value: makeAlignMatrix() },
            brightness: { value: leftVals.brightness },
            contrast: { value: leftVals.contrast },
            saturation: { value: leftVals.saturation },
            hue: { value: leftVals.hue }
        },
        vertexShader: vertexShader,
        fragmentShader: fragmentShaderLeft
    });

    // Right-eye material (uniforms allow live parameter updates)
    vrMaterialRight = new THREE.ShaderMaterial({
        uniforms: {
            map: { value: texture },
            shiftX: { value: rightVals.shiftX },
            shiftY: { value: rightVals.shiftY },
            cropX: { value: params.cropX ?? 0 },
            cropY: { value: params.cropY ?? 0 },
            offsetX: { value: params.offsetX ?? 0 },
            offsetY: { value: params.offsetY ?? 0 },
            alignTransform: { value: makeAlignMatrix() },
            brightness: { value: rightVals.brightness },
            contrast: { value: rightVals.contrast },
            saturation: { value: rightVals.saturation },
            hue: { value: rightVals.hue }
        },
        vertexShader: vertexShader,
        fragmentShader: fragmentShaderRight
    });

    // Shared geometry for both eyes
    const geometry = new THREE.PlaneGeometry(planeWidth, planeHeight);

    // Left-eye mesh (Layer 1)
    vrMeshLeft = new THREE.Mesh(geometry, vrMaterialLeft);
    vrMeshLeft.position.set(0, 1.6, -3);
    vrMeshLeft.layers.set(1);
    state.scene.add(vrMeshLeft);

    // Right-eye mesh (Layer 2)
    vrMeshRight = new THREE.Mesh(geometry, vrMaterialRight);
    vrMeshRight.position.set(0, 1.6, -3);
    vrMeshRight.layers.set(2);
    state.scene.add(vrMeshRight);

    // Size the meshes for the current crop so a cropped image keeps its true aspect
    // (see applyVRMeshScale). The plane geometry carries the full uncropped aspect,
    // while the shader samples only the (1 - cropX/Y) sub-region, so without this the
    // cropped content would be stretched back to the full-aspect plane.
    applyVRMeshScale();

    logger.debug('VR_LOG', 'VR','Created VR stereo mesh');
}

/**
 * Apply the VR view scale (analog-stick zoom) to both eye meshes, folding in the
 * current crop ratio per axis. The VR fragment shader remaps UVs into the crop
 * window but the plane geometry keeps the full uncropped aspect, so the mesh must
 * be scaled by (1 - crop) on each axis to avoid distorting a cropped image —
 * exactly what the 2D path does in renderer.js updateMeshTransform. With no crop
 * (cropX = cropY = 0) both ratios are 1, so this is identical to a uniform scale.
 */
function applyVRMeshScale() {
    const cropRatioX = 1.0 - (state.params.cropX ?? 0);
    const cropRatioY = 1.0 - (state.params.cropY ?? 0);
    const sx = vrViewScale * cropRatioX;
    const sy = vrViewScale * cropRatioY;
    if (vrMeshLeft) vrMeshLeft.scale.set(sx, sy, 1);
    if (vrMeshRight) vrMeshRight.scale.set(sx, sy, 1);
}

/**
 * Generate fragment shader for VR using uniforms for dynamic parameters.
 * Parameters (shiftX, brightness, contrast, etc.) are passed as uniforms
 * so they can be updated during the VR session without shader recompilation.
 * @param {boolean} isLeft - Whether for left eye
 * @param {boolean} sampleLeft - Whether to sample from left half of SBS image
 */
function createVRFragmentShader(isLeft, sampleLeft) {
    // UV offset (left half: 0.0, right half: 0.5)
    const uvOffset = sampleLeft ? 0.0 : 0.5;

    // The manual parallax shift must land on the same physical eye as the 2D
    // shader. There, the shift is applied to the logical right eye and, after the
    // swapLR exchange, always ends up on the physical right eye (see
    // computeSampleCoordinates in shaders.js). isLeft identifies the physical eye
    // here (true = physical left mesh / layer 1, false = physical right / layer 2),
    // so the shift belongs on the physical right eye regardless of swapLR.
    // Using !sampleLeft instead inverts the shift whenever swapLR is active.
    const applyShift = !isLeft;

    return `
        uniform sampler2D map;
        uniform float shiftX;
        uniform float shiftY;
        uniform float cropX;
        uniform float cropY;
        uniform float offsetX;
        uniform float offsetY;
        uniform mat3 alignTransform;
        uniform float brightness;
        uniform float contrast;
        uniform float saturation;
        uniform float hue;
        varying vec2 vUv;

        // RGB to HSV conversion
        vec3 rgb2hsv(vec3 c) {
            vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
            vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
            vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
            float d = q.x - min(q.w, q.y);
            // Use 1e-6 to match the main shader: 1e-10 underflows on mediump GPUs
            // (VR headsets are mobile-class and may fall back to mediump).
            float e = 1.0e-6;
            return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
        }

        // HSV to RGB conversion
        vec3 hsv2rgb(vec3 c) {
            vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
            vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
            return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }

        void main() {
            // Keep the VR sampling path aligned with the 2D renderer: regular
            // crop/offset applies to both eyes, while geometric alignment and
            // manual shift apply to the logical right eye (the physical right VR
            // layer after swap handling above).
            vec2 uv = vec2(
                vUv.x * (1.0 - cropX) + cropX * 0.5 + offsetX * 0.5,
                vUv.y * (1.0 - cropY) + cropY * 0.5 + offsetY * 0.5
            );

            // Parallax adjustment (logical right eye only)
            ${applyShift ? `
            vec3 transformed = alignTransform * vec3(uv, 1.0);
            uv = transformed.xy / transformed.z;
            uv.x -= shiftX * 2.0;
            uv.y -= shiftY;
            ` : ''}

            // Sample the correct side from SBS image
            vec2 sampleUv = vec2(uv.x * 0.5 + ${uvOffset.toFixed(1)}, uv.y);

            // Out-of-bounds check. Use a floating-point tolerance (matching the
            // 2D shader's BOUNDS_EPSILON) so legal parallax shifts do not produce a
            // black seam of mediump rounding error at the exact eye boundary.
            float boundsEps = 0.0001;
            if (sampleUv.x < ${uvOffset.toFixed(1)} - boundsEps || sampleUv.x > ${(uvOffset + 0.5).toFixed(1)} + boundsEps ||
                sampleUv.y < -boundsEps || sampleUv.y > 1.0 + boundsEps) {
                gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
                return;
            }

            vec4 color = texture2D(map, sampleUv);

            // Color correction
            vec3 rgb = color.rgb;

            // Brightness
            rgb += brightness;

            // Contrast
            rgb = (rgb - 0.5) * contrast + 0.5;

            // rgb2hsv assumes [0,1] input; out-of-range values from brightness/
            // contrast produce incorrect hue/saturation, so clamp before convert.
            rgb = clamp(rgb, 0.0, 1.0);

            // Saturation and hue
            vec3 hsv = rgb2hsv(rgb);
            hsv.y *= saturation;
            hsv.x += hue;
            hsv.x = fract(hsv.x);
            rgb = hsv2rgb(hsv);

            rgb = clamp(rgb, 0.0, 1.0);
            gl_FragColor = vec4(rgb, color.a);
        }
    `;
}

/**
 * Build VR uniform values for a given eye from current params
 * @param {boolean} isLeft - Whether for left eye
 * @param {object} params - Current state params
 * @returns {object} Uniform values
 */
function getVRUniformValues(isLeft, params) {
    return {
        shiftX: params.shiftX ?? 0,
        shiftY: params.shiftY ?? 0,
        brightness: isLeft ? (params.brightnessL ?? 0) : (params.brightnessR ?? 0),
        contrast: isLeft ? (params.contrastL ?? 1) : (params.contrastR ?? 1),
        saturation: isLeft ? (params.saturationL ?? 1) : (params.saturationR ?? 1),
        hue: isLeft ? ((params.hueL ?? 0) / 360.0) : ((params.hueR ?? 0) / 360.0)
    };
}

/**
 * Update VR shader uniforms from current state.params.
 *
 * Called every VR frame from updateVRNavigation() so parameter changes made
 * during a session are reflected live. Guards on material existence, so it is a
 * no-op before the VR meshes are built or after they are disposed.
 */
export function updateVRShaderParams() {
    const params = state.params;
    const updateMaterial = (material, isLeft) => {
        if (!material) return;
        const vals = getVRUniformValues(isLeft, params);
        for (const [key, val] of Object.entries(vals)) {
            material.uniforms[key].value = val;
        }
        material.uniforms.cropX.value = params.cropX ?? 0;
        material.uniforms.cropY.value = params.cropY ?? 0;
        material.uniforms.offsetX.value = params.offsetX ?? 0;
        material.uniforms.offsetY.value = params.offsetY ?? 0;
        if (Array.isArray(params.alignTransform) && params.alignTransform.length >= 9 && params.alignTransform.every(Number.isFinite)) {
            material.uniforms.alignTransform.value.fromArray(params.alignTransform);
        } else {
            material.uniforms.alignTransform.value.identity();
        }
    };
    updateMaterial(vrMaterialLeft, true);
    updateMaterial(vrMaterialRight, false);

    // Crop is pushed into the shader uniforms above; re-apply the matching per-axis
    // mesh scale so a crop change made during the session does not distort the aspect
    // (cheap no-op scale write when crop is unchanged).
    applyVRMeshScale();
}

/**
 * Dispose the VR eye meshes/materials and remove them from the scene.
 * Does NOT restore state.mesh — callers decide whether to restore (session end)
 * or rebuild (image change during a session).
 */
function disposeVRMeshes() {
    if (vrMeshLeft) {
        try {
            state.scene.remove(vrMeshLeft);
            if (vrMeshLeft.geometry) {
                vrMeshLeft.geometry.dispose();
            }
        } catch (err) {
            logger.error('VR','[VR] Error disposing left VR mesh:', err);
        }
        vrMeshLeft = null;
    }
    if (vrMaterialLeft) {
        try {
            vrMaterialLeft.dispose();
        } catch (err) {
            logger.error('VR','[VR] Error disposing left VR material:', err);
        }
        vrMaterialLeft = null;
    }

    if (vrMeshRight) {
        try {
            state.scene.remove(vrMeshRight);
            if (vrMeshRight.geometry) {
                vrMeshRight.geometry.dispose();
            }
        } catch (err) {
            logger.error('VR','[VR] Error disposing right VR mesh:', err);
        }
        vrMeshRight = null;
    }
    if (vrMaterialRight) {
        try {
            vrMaterialRight.dispose();
        } catch (err) {
            logger.error('VR','[VR] Error disposing right VR material:', err);
        }
        vrMaterialRight = null;
    }
}

/**
 * Rebuild the VR eye meshes when a new image is loaded during an active VR
 * session (e.g. analog-stick navigation -> viewerNextImage/PrevImage).
 *
 * createStereoMesh() replaces state.mesh and disposes the previous texture — the
 * one the VR materials captured at session start. Without rebuilding, the VR
 * quads keep referencing that disposed texture and the freshly created state.mesh
 * (visible, layer 0) leaks into both eyes. Tearing down and recreating the VR
 * meshes re-binds them to the new texture and re-hides the new state.mesh.
 * stereo-image-loaded is dispatched synchronously inside updateSceneWithImage(),
 * before the next render, so the new state.mesh never actually draws on layer 0.
 */
function onStereoImageLoadedDuringVR() {
    if (!vrSession) return;
    try {
        disposeVRMeshes();
        // setupVRScene() re-hides state.mesh, re-captures savedMeshScale from the
        // (already fitted) new mesh so VR exit restores the correct scale, and
        // builds fresh VR meshes from the new texture.
        setupVRScene();
    } catch (err) {
        logger.error('VR', '[VR] Failed to rebuild VR scene for new image:', err);
    }
}

/**
 * Clean up VR scene
 */
function cleanupVRScene() {
    try {
        // Remove VR meshes
        disposeVRMeshes();

        // Restore original mesh
        if (state.mesh) {
            try {
                state.mesh.visible = true;
                // Restore the 2D mesh to exactly layer 0 (its default / normal-mode
                // state). enableAll() left it on all 32 layers after a VR session, so
                // a later VR session's eye layers (1/2) would also pick it up. The 2D
                // orthographic camera renders layer 0, so this keeps it visible.
                state.mesh.layers.set(0);
                state.mesh.position.set(state.params.panX, state.params.panY, 0);

                // Restore pre-VR scale
                if (savedMeshScale) {
                    state.mesh.scale.set(savedMeshScale.x, savedMeshScale.y, savedMeshScale.z);
                    savedMeshScale = null;
                } else {
                    // Fallback: if no scale info, use updateMeshTransform()
                    logger.debug('VR_LOG', 'VR','Pre-VR scale information not found');
                }
            } catch (err) {
                logger.error('VR','[VR] Error restoring original mesh:', err);
            }
        }

        logger.debug('VR_LOG', 'VR','VR scene cleaned up');
    } catch (err) {
        logger.error('VR','[VR] Error during VR scene cleanup:', err);
    }
}

function resetVRStickState() {
    vrStickState.leftTriggered = false;
    vrStickState.rightTriggered = false;
    vrStickState.lastHorizontalActionTime = 0;
    vrViewScale = 1.0;
    // Reset the exit-button latches too. vrExitButtonHeld starts as held rather
    // than released: a button still down when the session starts must be
    // released and pressed again to count, so a press that leaked in from
    // outside the session (or one held through a previous session's teardown)
    // cannot end the new session on its very first frame. The first frame that
    // reports the button up clears it. Without the vrExitRequested reset the
    // next session could not be exited by controller at all.
    vrExitButtonHeld = true;
    vrExitRequested = false;
}

/**
 * End the VR session in response to the controller exit button.
 *
 * Runs from the VR render loop, so it must not block: endVRSession() is fired
 * and awaited only for logging. vrExitRequested keeps a second frame from
 * requesting the end again while the first request is still in flight (the XR
 * 'end' event, and with it onSessionEnded(), arrives asynchronously).
 */
function requestVRExitFromController() {
    if (!vrSession || vrExitRequested || isVRSessionChanging) {
        return;
    }
    vrExitRequested = true;

    logger.debug('VR_LOG', 'VR', 'Controller exit button pressed, ending VR session');

    endVRSession().catch((err) => {
        logger.error('VR', 'Failed to end VR session from controller button:', err);
        // endVRSession() already forces onSessionEnded() when end() rejects, so
        // this only runs if the session somehow survived. Release the latch so a
        // second press can retry rather than leaving the user stuck in VR.
        vrExitRequested = false;
    });
}


function applyVRViewScaleDelta(delta) {
    if (!vrMeshLeft || !vrMeshRight) {
        // Fallback when VR meshes are not available
        applyVRZoomDelta(delta);
        return;
    }

    vrViewScale = Math.max(VR_STICK_VIEW_SCALE_MIN, Math.min(VR_STICK_VIEW_SCALE_MAX, vrViewScale + delta));
    // Keep the per-axis crop compensation (see applyVRMeshScale) when the stick
    // zoom changes the scale — a plain setScalar here would reintroduce the crop
    // aspect distortion for cropped images.
    applyVRMeshScale();
}

/**
 * Update VR navigation via analog stick input, and end the session when the
 * controller exit button is pressed.
 */
export function updateVRNavigation() {
    if (!vrSession || !state.renderer) {
        return;
    }

    // Push current state.params into the VR materials every frame so live
    // changes (shift/brightness/contrast/saturation/hue, e.g. from the analog
    // sticks below or external param events) are reflected in VR. The VR
    // materials were otherwise frozen at the values present at session start.
    updateVRShaderParams();

    const session = state.renderer.xr.getSession?.() || vrSession;
    if (!session || !session.inputSources) {
        return;
    }

    const xrInput = readVRControllerInput(session.inputSources);
    let horizontal = xrInput.horizontal;
    let vertical = xrInput.vertical;
    let exitPressed = xrInput.exitPressed;

    // Fallback for browsers/devices where WebXR inputSources are not populated
    // reliably. Read once and use it for whichever signal is still missing: the
    // axes only while both sticks read idle (as before), and the exit button
    // whenever no XR input source reported it pressed.
    const sticksIdle = Math.abs(horizontal) <= VR_STICK_DEADZONE && Math.abs(vertical) <= VR_STICK_DEADZONE;
    if ((sticksIdle || !exitPressed) && navigator.getGamepads) {
        const fallback = readVRControllerInput(navigator.getGamepads());
        if (sticksIdle) {
            if (Math.abs(fallback.horizontal) > Math.abs(horizontal)) horizontal = fallback.horizontal;
            if (Math.abs(fallback.vertical) > Math.abs(vertical)) vertical = fallback.vertical;
        }
        exitPressed = exitPressed || fallback.exitPressed;
    }

    // Exit on the press edge only, so holding the button issues a single end
    // request and a press held across the session teardown cannot immediately
    // re-trigger anything on the next session.
    if (exitPressed) {
        if (!vrExitButtonHeld) {
            vrExitButtonHeld = true;
            requestVRExitFromController();
        }
    } else {
        vrExitButtonHeld = false;
    }

    // Skip stick handling once the session is on its way out: loading another
    // image while the VR meshes are being torn down is wasted work.
    if (vrExitRequested) {
        return;
    }

    if (Math.abs(vertical) > VR_STICK_DEADZONE) {
        applyVRViewScaleDelta(-vertical * VR_STICK_ZOOM_SPEED);
    }

    const now = performance.now();
    const cooldownPassed = (now - vrStickState.lastHorizontalActionTime) >= VR_STICK_HORIZONTAL_COOLDOWN_MS;

    if (horizontal <= -VR_STICK_DEADZONE) {
        if (!vrStickState.leftTriggered && cooldownPassed) {
            window.viewerPrevImage?.();
            vrStickState.leftTriggered = true;
            vrStickState.lastHorizontalActionTime = now;
        }
    } else {
        vrStickState.leftTriggered = false;
    }

    if (horizontal >= VR_STICK_DEADZONE) {
        if (!vrStickState.rightTriggered && cooldownPassed) {
            window.viewerNextImage?.();
            vrStickState.rightTriggered = true;
            vrStickState.lastHorizontalActionTime = now;
        }
    } else {
        vrStickState.rightTriggered = false;
    }
}

/**
 * Clean up VR navigation state.
 */
function cleanupVRNavigation() {
    resetVRStickState();
}

/**
 * Return whether the VR session is active
 */
export function isInVR() {
    return vrSession !== null;
}
