/**
 * view-fit.js
 * Pure math for placing the stereo plane in a view — no three.js, no DOM — shared
 * by the page's renderer and the external output window (external-output.js).
 *
 * The orthographic camera's frustum is `frustumH` tall (CONSTANTS.CAMERA_FRUSTUM_HEIGHT)
 * and `frustumH * aspect` wide, so a view's size enters only through its aspect.
 *
 * The external window frames the plane by what the page shows of it
 * (externalFraming): the part of the image visible on the page, as large as it fits.
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
 * @param {{viewW:number, viewH:number, frustumH:number, geomW:number, geomH:number,
 *          baseScaleX:number, baseScaleY:number, scale:number, panX:number, panY:number,
 *          cropX:number, cropY:number, is3dtv:boolean}} p
 * @returns {{scaleX:number, scaleY:number, x:number, y:number}}
 */
export function meshTransform({ viewW, viewH, frustumH, geomW, geomH, baseScaleX, baseScaleY, scale, panX, panY, cropX, cropY, is3dtv }) {
    if (is3dtv) {
        const aspect = viewW / viewH;
        const frustumW = frustumH * aspect;
        return { scaleX: frustumW / geomW, scaleY: frustumH / geomH, x: panX, y: panY };
    }
    const cropRatioX = 1.0 - cropX;
    const cropRatioY = 1.0 - cropY;
    return { scaleX: baseScaleX * scale * cropRatioX, scaleY: baseScaleY * scale * cropRatioY, x: panX, y: panY };
}

/**
 * Where the external window puts the plane (outside 3DTV): the part of the image
 * visible on the page, centred, as large as it fits in the other view.
 *
 * So everything of the image the page shows is in the other view too — what the
 * operator points at is always in the audience's sight — and as large as can be:
 *
 * - The whole image on the page (at fit, zoomed out, or with the page's view grown
 *   around it): the whole image at the other view's fit. The page's own size does not
 *   enter, so opening or closing a panel on the page moves nothing there.
 * - Zoomed in: the page's window into the image, centred; where the two views'
 *   aspects differ, more of the image around it shows.
 * - None of the image on the page (panned out of view), or no usable page view: the
 *   whole image at fit.
 *
 * The plane is the page's plane scaled by one factor about the visible part's centre,
 * so its aspect, and every image point's place relative to the others, are kept.
 *
 * @param {Object} p
 * @param {{scaleX:number, scaleY:number, x:number, y:number}} p.mesh - the page's plane: scale and position
 * @param {number} p.geomW - the plane geometry's width (world units at scale 1)
 * @param {number} p.geomH - the plane geometry's height
 * @param {{left:number, right:number, top:number, bottom:number}} p.view - the page camera's frustum (world units; the camera sits at the origin)
 * @param {number} p.viewW - the other view's width (CSS px)
 * @param {number} p.viewH - the other view's height
 * @param {number} p.frustumH - the frustum height of both views (world units)
 * @returns {{scaleX:number, scaleY:number, x:number, y:number}}
 */
export function externalFraming({ mesh, geomW, geomH, view, viewW, viewH, frustumH }) {
    const halfW = Math.abs(geomW * mesh.scaleX) / 2;
    const halfH = Math.abs(geomH * mesh.scaleY) / 2;
    // The visible part: the page's view clipped to the plane.
    let x0 = Math.max(view.left, mesh.x - halfW);
    let x1 = Math.min(view.right, mesh.x + halfW);
    let y0 = Math.max(view.bottom, mesh.y - halfH);
    let y1 = Math.min(view.top, mesh.y + halfH);
    if (!(x1 - x0 > 0 && y1 - y0 > 0)) {
        x0 = mesh.x - halfW;
        x1 = mesh.x + halfW;
        y0 = mesh.y - halfH;
        y1 = mesh.y + halfH;
    }
    const k = Math.min((frustumH * (viewW / viewH)) / (x1 - x0), frustumH / (y1 - y0));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    return { scaleX: mesh.scaleX * k, scaleY: mesh.scaleY * k, x: (mesh.x - cx) * k, y: (mesh.y - cy) * k };
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
