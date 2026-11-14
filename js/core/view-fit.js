/**
 * view-fit.js
 * Pure math for placing the stereo plane in a view — no three.js, no DOM — shared
 * by the page's renderer and the external output window (external-output.js).
 *
 * The orthographic camera's frustum is `frustumH` tall (CONSTANTS.CAMERA_FRUSTUM_HEIGHT)
 * and `frustumH * aspect` wide, so a view's size enters only through its aspect.
 *
 * The page keeps its zoom and pan (state.params.scale / panX / panY) in world units of
 * its own view. Another view of a different aspect shows the same framing by scaling
 * the whole plane by `fitScale(other) / fitScale(page)` about the origin
 * (externalZoom): the same image point stays at the centre, at the same zoom relative
 * to "fit", and only the visible extent grows or shrinks with the aspect.
 */

import { isInterlaceMode } from '../mode-utils.js';

/**
 * Size of the plane (in world units) that "fit" fits into the view.
 * In 3DTV the mesh deliberately ignores the layout scale and the regular crop
 * (the shader handles both), so fit is based on the bare geometry there.
 * @param {{geomW:number, geomH:number, baseScaleX:number, baseScaleY:number, cropX:number, cropY:number, is3dtv:boolean}} p
 * @returns {{width:number, height:number}}
 */
export function meshBaseSize({ geomW, geomH, baseScaleX, baseScaleY, cropX, cropY, is3dtv }) {
    if (is3dtv) {
        return { width: geomW, height: geomH };
    }
    const cropRatioX = 1.0 - cropX;
    const cropRatioY = 1.0 - cropY;
    return { width: geomW * baseScaleX * cropRatioX, height: geomH * baseScaleY * cropRatioY };
}

/**
 * The mesh scale at which a plane of `meshBaseW` x `meshBaseH` fits a view of
 * `viewW` x `viewH` (CSS px) without gaps.
 * @returns {number}
 */
export function fitScale(viewW, viewH, meshBaseW, meshBaseH, frustumH) {
    const aspect = viewW / viewH;
    const frustumW = frustumH * aspect;
    const margin = 1.0;  // Fit without gaps
    const scaleW = (frustumW * margin) / meshBaseW;
    const scaleH = (frustumH * margin) / meshBaseH;
    return Math.min(scaleW, scaleH);
}

/**
 * The mesh's scale and position in a view.
 *
 * - Normal: the layout scale times the zoom (`scale`) times the crop ratio, at the pan.
 * - 3DTV: stretched to cover the whole frustum, ignoring aspect (the shader fits the
 *   image within it), at the pan.
 *
 * `zoom` scales the page's framing to another view (externalZoom); 1 for the page.
 *
 * @param {{viewW:number, viewH:number, frustumH:number, geomW:number, geomH:number,
 *          baseScaleX:number, baseScaleY:number, scale:number, panX:number, panY:number,
 *          cropX:number, cropY:number, is3dtv:boolean, zoom?:number}} p
 * @returns {{scaleX:number, scaleY:number, x:number, y:number}}
 */
export function meshTransform({ viewW, viewH, frustumH, geomW, geomH, baseScaleX, baseScaleY, scale, panX, panY, cropX, cropY, is3dtv, zoom = 1 }) {
    const x = panX * zoom;
    const y = panY * zoom;
    if (is3dtv) {
        const aspect = viewW / viewH;
        const frustumW = frustumH * aspect;
        return { scaleX: frustumW / geomW, scaleY: frustumH / geomH, x, y };
    }
    const s = scale * zoom;
    const cropRatioX = 1.0 - cropX;
    const cropRatioY = 1.0 - cropY;
    return { scaleX: baseScaleX * s * cropRatioX, scaleY: baseScaleY * s * cropRatioY, x, y };
}

/**
 * The factor that carries the page's framing to another view: the ratio of the two
 * views' fit scales. 1 when either is not a usable number (a collapsed view).
 * @param {number} pageFit - fitScale of the page's view
 * @param {number} otherFit - fitScale of the other view
 * @returns {number}
 */
export function externalZoom(pageFit, otherFit) {
    if (!(Number.isFinite(pageFit) && pageFit > 0 && Number.isFinite(otherFit) && otherFit > 0)) {
        return 1;
    }
    return otherFit / pageFit;
}

/**
 * The pixel ratio to draw the external window at. Interlace needs one buffer pixel per
 * physical pixel, so the window's own ratio is used as is; otherwise it is capped at 2
 * like the page's (framebuffer memory with antialiasing).
 * @param {number} mode - display mode
 * @param {number} devicePixelRatio - the external window's devicePixelRatio
 * @returns {number}
 */
export function externalPixelRatio(mode, devicePixelRatio) {
    const dpr = (Number.isFinite(devicePixelRatio) && devicePixelRatio > 0) ? devicePixelRatio : 1;
    return isInterlaceMode(mode) ? dpr : Math.min(dpr, 2);
}
