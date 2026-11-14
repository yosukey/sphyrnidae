/**
 * external-output.js
 * The picture in a window of its own (js/ui/external-window.js): a second
 * WebGLRenderer on that window's canvas, drawing the same image as the page.
 *
 * The page draws one plane (state.mesh) through a shader that composes the stereo
 * mode (state.material). This draws a plane of its own, sharing the page's geometry
 * and textures, through a ShaderMaterial of its own built from the page's shader.
 * Every frame it copies the page's uniforms — parallax, alignment, crop, colour,
 * the text overlay, wiggle, viewer zoom and pan, 3DTV — so everything the page
 * changes shows here too; nothing else is kept in step. What differs per window is
 * set here:
 *
 * - resolution, pixelRatio and the interlace row parity: this canvas's own;
 * - the grid: never drawn here (it is an on-screen aid for the page);
 * - the pointer: the 3D pointer as the page draws it, or — with the 3D pointer
 *   off — the mouse's place as a flat arrow (externalPointer);
 * - the plane's scale and position: the page's framing scaled to this window's
 *   aspect (view-fit.js), so the same image point is at the centre at the same
 *   zoom relative to fit.
 *
 * The cost of drawing twice is a second WebGL context: the image texture is
 * uploaded to the GPU once for each.
 *
 * Ported in outline from the MANTIS viewer's external output (same author).
 */

import * as THREE from 'three';
import { state, CONSTANTS, is3DTVActive } from '../globals.js';
import { isInterlaceMode } from '../mode-utils.js';
import { meshFitInputs, pageFitScale } from './renderer.js';
import { meshBaseSize, fitScale, meshTransform, externalZoom, externalPixelRatio } from '../core/view-fit.js';
import { externalPointer } from '../core/external-window-utils.js';
import { ExternalWindow } from '../ui/external-window.js';

const tempSize = new THREE.Vector2();
const tempColor = new THREE.Color();

/**
 * Parity offset (0 or 1) that anchors horizontal interlace to the buffer's top row
 * (same rule as the page's, renderer.js getInterlaceParityOffset).
 * @param {number} bufferHeight
 */
function interlaceParity(bufferHeight) {
    return (((bufferHeight - 1) % 2) + 2) % 2;
}

/**
 * Whether a uniform value is a math object to copy into the one already there
 * (Vector2/3/4, Matrix3/4, Color), rather than a reference to share (textures) or a
 * number.
 */
function copiable(value) {
    return !!value && typeof value.copy === 'function' && typeof value.clone === 'function' && !value.isTexture;
}

/**
 * @typedef {Object} ExternalOutputEvents
 * @property {() => void} closed - the window is gone; release what draws into it (dispose)
 * @property {() => void} [frames] - frames should be asked of another window now
 *   (the window came into or went out of sight, or its document was replaced)
 * @property {() => void} [contextLost] - this window's WebGL context was lost
 */

export class ExternalOutput {
    /**
     * Open the window and a renderer on its canvas. Call it straight from the
     * click (a popup blocker otherwise refuses). On failure `output` is null and
     * `failure` says why: 'blocked' — the browser refused the window (a popup
     * blocker); 'webgl' — the window opened but WebGL refused a second context, and
     * the window was closed again.
     * @param {Window} opener
     * @param {import('../ui/external-window.js').ExternalWindowTexts} texts
     * @param {ExternalOutputEvents} events
     * @returns {{output: ExternalOutput|null, failure: null|'blocked'|'webgl'}}
     */
    static open(opener, texts, events) {
        let out = null;
        const win = ExternalWindow.open(opener, texts, {
            // Not passed on for a window that never got a renderer: nothing was
            // opened as far as the page knows.
            closed: () => { if (out) events.closed(); },
            resized: () => { /* the size is looked at every frame (applySize) */ },
            visibility: () => { if (out) events.frames?.(); },
            replaced: () => {
                if (!out) return;
                try { out.renew(); } catch (e) { out.close(); return; }
                events.frames?.();
            },
        });
        if (!win) return { output: null, failure: 'blocked' };
        try {
            out = new ExternalOutput(win, events);
        } catch (e) {
            out = null;
        }
        if (!out) { win.close(); return { output: null, failure: 'webgl' }; }
        return { output: out, failure: null };
    }

    /**
     * @param {ExternalWindow} win
     * @param {ExternalOutputEvents} events
     */
    constructor(win, events) {
        this.window = win;
        this.events = events;
        this.scene = new THREE.Scene();
        const h = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        this.camera = new THREE.OrthographicCamera(-h / 2, h / 2, h / 2, -h / 2, 0.1, 1000);
        this.camera.position.z = 5;
        /** The plane drawn here; its geometry is the page's. */
        this.mesh = null;
        /** This window's material, and the page's it was built from. */
        this.material = null;
        this.source = null;
        /** Size, ratio and pixel-exactness the buffer was last made at (applySize). */
        this.sizeKey = '';
        /**
         * The `dispose` listeners this renderer put on the page's shared objects
         * (track). three adds one to every geometry and texture the first time a
         * renderer draws it, and renderer.dispose() does not take them off: each
         * would hold this renderer — and through its canvas the closed window — for
         * as long as the object lives.
         */
        this.disposeHooks = [];
        /** How many hooks there were after the last pruning: prune again at twice that. */
        this.prunedAt = 64;
        this.renderer = null;
        this.makeRenderer();
    }

    makeRenderer() {
        const canvas = this.window.canvas;
        // As the page's renderer, less preserveDrawingBuffer: nothing reads this
        // canvas back. No XR: VR is entered from the page, and closes this window.
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.xr.enabled = false;
        const onLost = (e) => {
            e.preventDefault();
            this.events.contextLost?.();
        };
        canvas.addEventListener('webglcontextlost', onLost, false);
        // Taken off before release() loses the context on purpose.
        this.stopListening = () => {
            try { canvas.removeEventListener('webglcontextlost', onLost, false); } catch (e) { /* gone */ }
        };
        this.sizeKey = '';
    }

    /**
     * A renderer on the window's new canvas, its document having been replaced: the
     * old one's context went with the old document.
     */
    renew() {
        this.release();
        this.makeRenderer();
    }

    /** Whether the window was closed. */
    get closed() {
        return this.window.closed;
    }

    /** Out of sight, so frames asked of its window would wait. */
    hidden() {
        return this.window.hidden();
    }

    /** Move it onto the other monitor, where the browser can. */
    place() {
        return this.window.place();
    }

    /** The window's words, in the page's language. */
    setTexts(texts) {
        this.window.setTexts(texts);
    }

    /** Close the window; `closed` follows. */
    close() {
        this.window.close();
    }

    /** Let go of the GPU: this window's material and the context itself. */
    dispose() {
        this.release();
    }

    /**
     * Size the drawing buffer and the camera to the window. Interlace draws one
     * buffer pixel per physical pixel: the window's own ratio, uncapped, and the
     * canvas's CSS size set to buffer / ratio so a fractional ratio stays exact.
     */
    applySize() {
        const { width, height } = this.window.size();
        const mode = state.params.mode;
        const exact = isInterlaceMode(mode);
        const ratio = externalPixelRatio(mode, this.window.devicePixelRatio());
        const key = `${width}x${height}@${ratio}${exact ? '!' : ''}`;
        if (key === this.sizeKey) return;
        this.sizeKey = key;
        this.renderer.setPixelRatio(ratio);
        this.renderer.setSize(width, height);
        if (exact) {
            const canvas = this.renderer.domElement;
            canvas.style.width = `${canvas.width / ratio}px`;
            canvas.style.height = `${canvas.height / ratio}px`;
        }
        const aspect = width / height;
        const h = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        this.camera.left = -h * aspect / 2;
        this.camera.right = h * aspect / 2;
        this.camera.top = h / 2;
        this.camera.bottom = -h / 2;
        this.camera.updateProjectionMatrix();
    }

    /** Clear to the page's background, as the page's renderer does. */
    matchClear() {
        const page = state.renderer;
        if (!page) return;
        page.getClearColor(tempColor);
        const alpha = page.getClearAlpha();
        const now = this.renderer.getClearColor(new THREE.Color());
        if (!now.equals(tempColor) || this.renderer.getClearAlpha() !== alpha) {
            this.renderer.setClearColor(tempColor, alpha);
        }
    }

    /**
     * This window's material, built again whenever the page's material is another
     * (a new image, another shader group for a new mode, a context restore). Its
     * uniforms are the page's, copied: math objects cloned, textures shared.
     * @param {THREE.Material} src - the page's material
     */
    syncMaterial(src) {
        if (src !== this.source || !this.material) {
            if (this.material) this.material.dispose();
            this.material = null;
            this.source = src;
            if (src.uniforms) {
                const uniforms = {};
                for (const key of Object.keys(src.uniforms)) {
                    const v = src.uniforms[key].value;
                    uniforms[key] = { value: copiable(v) ? v.clone() : v };
                }
                this.material = new THREE.ShaderMaterial({
                    uniforms,
                    vertexShader: src.vertexShader,
                    fragmentShader: src.fragmentShader,
                    transparent: src.transparent
                });
            } else {
                // The page's fallback after a failed context restore: the texture as is.
                this.material = new THREE.MeshBasicMaterial({ map: src.map ?? null });
            }
        }
        if (!src.uniforms) {
            if (this.material.map !== (src.map ?? null)) {
                this.material.map = src.map ?? null;
                this.material.needsUpdate = true;
            }
            return;
        }
        const dst = this.material.uniforms;
        for (const key of Object.keys(src.uniforms)) {
            const d = dst[key];
            if (!d) continue;
            const v = src.uniforms[key].value;
            if (copiable(v) && copiable(d.value)) d.value.copy(v);
            else d.value = v;
        }
        // What is this window's own.
        this.renderer.getSize(tempSize);
        if (dst.resolution) dst.resolution.value.set(tempSize.x, tempSize.y);
        if (dst.pixelRatio) dst.pixelRatio.value = this.renderer.getPixelRatio();
        if (dst.interlaceParityOffset) dst.interlaceParityOffset.value = interlaceParity(this.renderer.domElement.height);
        if (dst.gridEnabled) dst.gridEnabled.value = 0.0;
        const p = externalPointer(state);
        if (dst.pointer3dEnabled) dst.pointer3dEnabled.value = p.enabled;
        if (dst.pointer3dPos) dst.pointer3dPos.value.set(p.x, p.y);
        if (dst.pointer3dParallax) dst.pointer3dParallax.value = p.parallax;
    }

    /** The plane: the page's geometry, at the page's framing scaled to this window. */
    syncMesh() {
        const page = state.mesh;
        if (!this.mesh) {
            this.mesh = new THREE.Mesh(page.geometry, this.material);
            this.scene.add(this.mesh);
        }
        this.mesh.geometry = page.geometry;
        this.mesh.material = this.material;
        this.mesh.visible = true;

        const { width, height } = this.window.size();
        const is3dtv = is3DTVActive();
        const inputs = meshFitInputs(is3dtv);
        const base = meshBaseSize(inputs);
        const frustumH = CONSTANTS.CAMERA_FRUSTUM_HEIGHT;
        const zoom = externalZoom(pageFitScale(), fitScale(width, height, base.width, base.height, frustumH));
        const t = meshTransform({
            ...inputs,
            viewW: width,
            viewH: height,
            frustumH,
            scale: state.params.scale,
            panX: state.params.panX,
            panY: state.params.panY,
            zoom
        });
        if (Number.isFinite(t.scaleX) && Number.isFinite(t.scaleY) && Number.isFinite(t.x) && Number.isFinite(t.y)) {
            this.mesh.scale.set(t.scaleX, t.scaleY, 1);
            this.mesh.position.set(t.x, t.y, page.position.z);
        }
    }

    /** One frame: the page's image as it is now, at this window's size. */
    draw() {
        if (this.closed) return;
        this.applySize();
        this.matchClear();
        const page = state.mesh;
        const src = state.material;
        if (page && src && page.geometry?.parameters) {
            this.syncMaterial(src);
            this.syncMesh();
        } else if (this.mesh) {
            this.mesh.visible = false;
        }
        this.track(() => this.renderer.render(this.scene, this.camera));
    }

    /**
     * Run `drawing` — everything that renders with this renderer — noting the
     * `dispose` listeners it adds to the page's shared objects (disposeHooks), to
     * take them off in release(). Synchronous, so nothing else adds one meanwhile.
     * @param {() => void} drawing
     */
    track(drawing) {
        const proto = THREE.EventDispatcher.prototype;
        const add = proto.addEventListener;
        const hooks = this.disposeHooks;
        proto.addEventListener = function (type, listener) {
            if (type === 'dispose') hooks.push([this, listener]);
            return add.call(this, type, listener);
        };
        try {
            drawing();
        } finally {
            proto.addEventListener = add;
        }
        // Objects disposed by the page (an old image's texture) leave hooks behind
        // that three has already taken off: let them go now and then.
        if (hooks.length > this.prunedAt) {
            this.disposeHooks = hooks.filter(([target, listener]) => target.hasEventListener('dispose', listener));
            this.prunedAt = Math.max(64, this.disposeHooks.length * 2);
        }
    }

    release() {
        if (this.stopListening) {
            this.stopListening();
            this.stopListening = null;
        }
        if (this.material) {
            try { this.material.dispose(); } catch (e) { /* context already gone */ }
        }
        this.material = null;
        this.source = null;
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh = null;
        }
        if (this.renderer) {
            try {
                this.renderer.dispose();
                // Not on a context already gone with its window — three would warn
                // that it cannot lose what is lost.
                const gl = this.renderer.getContext();
                if (!gl.isContextLost() && gl.getExtension('WEBGL_lose_context')) this.renderer.forceContextLoss();
            } catch (e) { /* the window, and its context, already gone */ }
        }
        // What renderer.dispose() leaves on the shared objects (track).
        for (const [target, listener] of this.disposeHooks) {
            try { target.removeEventListener('dispose', listener); } catch (e) { /* gone */ }
        }
        this.disposeHooks = [];
        this.sizeKey = '';
    }
}
