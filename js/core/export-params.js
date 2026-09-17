/**
 * export-params.js
 * Serialization of the current view state into the `?src=` URL and the URL-list
 * line that ui-export.js copies to the clipboard.
 *
 * Split out of ui-export.js so the serialization can be exercised on its own:
 * ui-export.js imports THREE.js, the renderer and the shared `state` object, so
 * nothing in it can run outside a browser, while everything here is a function
 * of its arguments. js/url-params.js already holds the matching parse
 * direction, and the two are exact inverses up to the rounding documented
 * below; this module is its counterpart, the same way alignment-geometry.js is
 * the pure counterpart of alignment.js.
 *
 * What the round trip does and does not preserve:
 *   - `x` and `y` are written in whole image pixels, so a value re-read from a
 *     link differs from the original by at most half a pixel, and the
 *     normalized shift it reconstructs therefore depends on the image size.
 *   - `r` and `z` carry four decimals; below ALIGN_EXPORT_EPS they are omitted
 *     entirely, which is also the magnitude at which the fourth decimal stops
 *     being meaningful.
 *   - `crop` carries five decimals of the shader's normalized crop uniforms, so
 *     it needs no image dimensions and reconstructs the same window at any
 *     resolution.
 *   - The vertical value folds both shiftY and the constant carried by
 *     alignTransform into a single `y`. On import, splitVerticalShift() puts the
 *     in-range part back into shiftY and the remainder back into
 *     alignTransform[7]. The split may land differently from the original, but
 *     the shader adds the two (its srcR.y constant is alignTransform[7] minus
 *     shiftY), so the rendered result is unchanged.
 */

import { alignTransformToRotZoom } from '../rendering/alignment-geometry.js';
import { getModeName } from '../mode-utils.js';

// Below this magnitude a decomposed rotation/zoom is treated as zero and omitted
// from the export (also the round-off floor for the 4-decimal serialization).
export const ALIGN_EXPORT_EPS = 1e-4;

/**
 * Format a rotation (deg) / zoom (pct) value for URL/list output: fixed 4-decimal
 * precision with trailing zeros trimmed. Ample for the small roll/vertical-zoom
 * magnitudes involved (< ~10 deg / < ~6 %).
 * @param {number} n
 * @returns {string}
 */
export function formatAlignParam(n) {
    return parseFloat(n.toFixed(4)).toString();
}

/**
 * Format a normalized crop value (ratio / offset) for URL/list output: fixed
 * 5-decimal precision with trailing zeros trimmed. One extra digit over the
 * rotation/zoom formatter because these ratios scale directly by image pixels.
 * @param {number} n
 * @returns {string}
 */
export function formatCropValue(n) {
    return parseFloat(n.toFixed(5)).toString();
}

/**
 * Build the compact `crop=cropX,cropY,offsetX,offsetY` value for a crop state,
 * or null when no crop is applied (cropX and cropY both zero). The four values
 * are the shader's normalized, resolution-independent crop uniforms, so they
 * round-trip without needing image dimensions.
 * @param {{cropX?:number, cropY?:number, offsetX?:number, offsetY?:number}} params
 * @returns {string|null}
 */
export function buildCropParam(params) {
    const { cropX = 0, cropY = 0, offsetX = 0, offsetY = 0 } = params;
    if (!(cropX > 0 || cropY > 0)) return null;
    return [cropX, cropY, offsetX, offsetY].map(formatCropValue).join(',');
}

/**
 * Compute the shared URL/list export geometry for a parallax + alignment state.
 *
 * shiftX -> x (px). The vertical value folds BOTH shiftY and any folded vertical
 * constant f (= -alignTransform[7]) into a single `y` (px), so `y` stays a pure
 * vertical-shift value whether or not geometric refinement is active. The
 * alignTransform roll/vertical-zoom are decomposed into rotation (deg) / zoom (pct).
 * `y` is written unclamped (full image height), so it carries the entire vertical
 * value even when it exceeds the shiftY ±0.1 slider range. On import,
 * rotZoomToAlignTransform rebuilds the roll/zoom matrix and splitVerticalShift keeps
 * the in-range part in shiftY while folding any overflow back into alignTransform[7]
 * (the shader adds the two: srcR.y constant = a[7] - shiftY) — a lossless,
 * rendering-equivalent round-trip of the exported state.
 *
 * @param {{alignTransform?:number[], shiftX?:number, shiftY?:number}} params
 * @param {{width:number, height:number}|null|undefined} image - current stereo
 *        image, for the pixel scale; without it the pixel values stay 0
 * @returns {{parallaxPx:number, verticalPx:number, rotationDeg:number, zoomPct:number}}
 */
export function computeExportGeometry(params, image) {
    const align = params.alignTransform;
    // f = -a[7]: vertical constant carried by the matrix (0 for the shift-only path).
    const fUV = (Array.isArray(align) && align.length >= 9) ? -align[7] : 0;
    const verticalUV = (params.shiftY || 0) + fUV;

    let parallaxPx = 0;
    let verticalPx = 0;
    if (image) {
        parallaxPx = Math.round((params.shiftX || 0) * image.width);
        verticalPx = Math.round(verticalUV * image.height);
    }

    const rz = alignTransformToRotZoom(align) || { rotationDeg: 0, zoomPct: 0 };
    return { parallaxPx, verticalPx, rotationDeg: rz.rotationDeg, zoomPct: rz.zoomPct };
}

/**
 * Build the URL-list line for a view state.
 * Format: URL format=value mode=mode_name x=value y=value r=value z=value crop=cx,cy,ox,oy
 * Only non-default/non-zero values are included, for compactness.
 *
 * @param {Object} options
 * @param {string} options.url - image URL, written verbatim as the first field
 * @param {Object} options.params - view state (mode, shiftX, shiftY,
 *        alignTransform, cropX, cropY, offsetX, offsetY)
 * @param {string} options.format - stereo format token
 * @param {{width:number, height:number}|null} [options.image]
 * @returns {string}
 */
export function buildListLine({ url, params, format, image = null }) {
    const mode = params.mode;
    const { parallaxPx, verticalPx, rotationDeg, zoomPct } = computeExportGeometry(params, image);

    const parts = [url];

    // Always include format
    parts.push(`format=${format}`);

    // Include mode if not default (anaglyph)
    // Use mode name instead of number for readability
    if (mode !== 0) {
        const modeName = getModeName(mode);
        if (modeName) {
            parts.push(`mode=${modeName}`);
        } else {
            // Fallback to number if name not found
            parts.push(`mode=${mode}`);
        }
    }

    // Include x if non-zero
    if (parallaxPx !== 0) {
        parts.push(`x=${parallaxPx}`);
    }

    // Include y if non-zero
    if (verticalPx !== 0) {
        parts.push(`y=${verticalPx}`);
    }

    // Include rotation/zoom only when geometric refinement is in effect
    if (Math.abs(rotationDeg) >= ALIGN_EXPORT_EPS) {
        parts.push(`r=${formatAlignParam(rotationDeg)}`);
    }
    if (Math.abs(zoomPct) >= ALIGN_EXPORT_EPS) {
        parts.push(`z=${formatAlignParam(zoomPct)}`);
    }

    // Include the crop window only when a crop is applied
    const cropStr = buildCropParam(params);
    if (cropStr) {
        parts.push(`crop=${cropStr}`);
    }

    return parts.join(' ');
}

/**
 * Build the direct viewer link for a view state.
 * Format: <baseUrl>?src=URL&mode=mode_name&x=...&y=...&r=...&z=...&crop=...&format=...
 *
 * Unlike the list line, `x` and `y` are always written: the link is a complete
 * description of the view, not a compact list entry.
 *
 * @param {Object} options
 * @param {string} options.baseUrl - application origin the link points at
 * @param {string} options.url - image URL
 * @param {Object} options.params - view state
 * @param {string} options.format - stereo format token
 * @param {{width:number, height:number}|null} [options.image]
 * @returns {string}
 */
export function buildViewerUrl({ baseUrl, url, params, format, image = null }) {
    const mode = params.mode;
    const { parallaxPx, verticalPx, rotationDeg, zoomPct } = computeExportGeometry(params, image);

    const search = new URLSearchParams();
    search.set('src', url);

    // Use mode name instead of number
    const modeName = getModeName(mode);
    if (modeName) {
        search.set('mode', modeName);
    } else {
        // Fallback to number if name not found
        search.set('mode', mode.toString());
    }

    search.set('x', parallaxPx.toString());
    search.set('y', verticalPx.toString());
    // Include rotation/zoom only when geometric refinement is in effect, so plain
    // shift-only links stay unchanged.
    if (Math.abs(rotationDeg) >= ALIGN_EXPORT_EPS) {
        search.set('r', formatAlignParam(rotationDeg));
    }
    if (Math.abs(zoomPct) >= ALIGN_EXPORT_EPS) {
        search.set('z', formatAlignParam(zoomPct));
    }
    // Include the crop window only when a crop is applied
    const cropStr = buildCropParam(params);
    if (cropStr) {
        search.set('crop', cropStr);
    }
    search.set('format', format);

    return `${baseUrl}?${search.toString()}`;
}
