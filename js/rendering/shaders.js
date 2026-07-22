/**
 * shaders.js
 * Shader module by mode group
 * Resolve branching at compile time to avoid GPU pipeline stalls
 */

import { isAnaglyphMode, isInterlaceMode, isSingleEyeMode, isWiggleMode } from '../mode-utils.js';

// ============================================================
// Common vertex shader
// ============================================================
export const vertexShader = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// ============================================================
// Common uniform declarations
// ============================================================
const uniformDeclarations = `
    uniform sampler2D map;
    uniform float shiftX;
    uniform float shiftY;
    uniform float cropX;
    uniform float cropY;
    uniform float offsetX;
    uniform float offsetY;
    uniform float tvCropX;
    uniform float tvCropY;
    uniform float tvOffsetX;
    uniform float tvOffsetY;
    uniform float swapLR;
    uniform int mode;
    uniform mat3 alignTransform;

    uniform sampler2D textTexL;
    uniform sampler2D textTexR;
    uniform float textEnabled;
    uniform float textParallax;

    uniform float wigglePhase;

    // Image adjustments (left/right separately)
    uniform float brightnessL;
    uniform float brightnessR;
    uniform float contrastL;
    uniform float contrastR;
    uniform float saturationL;
    uniform float saturationR;
    uniform float hueL;
    uniform float hueR;
    uniform float sharpnessL;
    uniform float sharpnessR;
    uniform float noiseReductionL;
    uniform float noiseReductionR;
    uniform vec2 texelSize;

    // Global output dimming (0.85 for viewing comfort / anaglyph ghost reduction).
    // Exposed as a uniform so the offscreen histogram pass can disable it (=1.0)
    // and measure true image tones instead of the dimmed display result.
    uniform float intensity;

    // Grid display
    uniform float gridEnabled;
    uniform float gridDensity;
    uniform vec3 gridColor;
    uniform vec2 resolution;
    // Device-pixel ratio of the drawing buffer (renderer.getPixelRatio(), capped at 2).
    // The resolution uniform is in CSS pixels while the buffer is resolution*pixelRatio
    // device pixels, so the grid line-width math below multiplies by this to size lines
    // in real device pixels instead of ~pixelRatio-times too wide on high-DPR screens.
    // (No backticks in this comment: it lives inside a template-literal shader string.)
    uniform float pixelRatio;
    // Parity correction (0.0 or 1.0) that re-anchors horizontal-interlace line
    // assignment to the TOP edge of the drawing buffer. gl_FragCoord.y is bottom-left
    // origin, so raw floor(gl_FragCoord.y) parity depends on buffer-height parity and
    // flips the left/right eyes on a 1px resize. The host precomputes (bufferHeightPx
    // - 1) mod 2 (exact integer math, no large in-shader subtraction that mediump
    // could round) so we only add a 0/1 offset before the mod. See renderer.js.
    uniform float interlaceParityOffset;

    // For viewer mode
    uniform float viewerModeEnabled;
    uniform float viewerPanX;
    uniform float viewerPanY;
    uniform float viewerScale;

    // 3DTV mode
    uniform float sbs3dtv;
    uniform float imageAspect;

    // 3D Pointer
    uniform float pointer3dEnabled;
    uniform vec2 pointer3dPos;
    uniform float pointer3dParallax;

    varying vec2 vUv;
`;

// ============================================================
// Common constants and utility functions
// ============================================================
const commonUtilities = `
    // Background color (shown during movement) - set to black
    const vec4 bgColor = vec4(0.0, 0.0, 0.0, 1.0);

    // Floating-point tolerance (for bounds checks)
    const float BOUNDS_EPSILON = 0.0001;

    // Check if UV coordinates are within valid range
    bool isInBounds(vec2 uv) {
        return (uv.x >= -BOUNDS_EPSILON && uv.x <= 1.0 + BOUNDS_EPSILON &&
                uv.y >= -BOUNDS_EPSILON && uv.y <= 1.0 + BOUNDS_EPSILON);
    }

    // Texture sampling with bounds check
    vec4 sampleTexture(sampler2D tex, vec2 uv) {
        if (!isInBounds(uv)) {
            return bgColor;
        }
        return texture2D(tex, uv);
    }

    // Eye-aware bounds. The source \`map\` is a side-by-side stereo texture split
    // at x=0.5, and each eye samples only its own half. Convolution kernels
    // (noise reduction / sharpening) must therefore stay inside [xMin,xMax] x
    // [0,1] so a neighbor tap never crosses the center seam into the OTHER eye,
    // and never reads the black exterior past the image border.
    bool isInEyeBounds(vec2 uv, float xMin, float xMax) {
        return (uv.x >= xMin - BOUNDS_EPSILON && uv.x <= xMax + BOUNDS_EPSILON &&
                uv.y >= -BOUNDS_EPSILON && uv.y <= 1.0 + BOUNDS_EPSILON);
    }

    // Sampling for convolution kernels (noise reduction / sharpening), confined
    // to a single eye's half [xMin,xMax]. Taps outside that region fall back to
    // the provided center sample instead of black (bgColor) or the other eye, so
    // filters neither darken/ring at the image border nor bleed across the center
    // seam between the two eyes.
    vec4 sampleEyeKernel(sampler2D tex, vec2 uv, vec4 center, float xMin, float xMax) {
        if (!isInEyeBounds(uv, xMin, xMax)) {
            return center;
        }
        return texture2D(tex, uv);
    }

    // RGB to HSV conversion
    vec3 rgb2hsv(vec3 c) {
        vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
        vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
        vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
        float d = q.x - min(q.w, q.y);
        // Use 1e-6: smallest mediump normal is ~6.1e-5, so 1e-10 underflows on
        // GPUs that fall back from highp to mediump in fragment shaders.
        float e = 1.0e-6;
        return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
    }

    // HSV to RGB conversion
    vec3 hsv2rgb(vec3 c) {
        vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
        vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
        return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
    }

    // Apply color correction
    vec4 applyColorCorrection(vec4 color, float brightness, float contrast, float saturation, float hue) {
        vec3 rgb = color.rgb + brightness;
        rgb = (rgb - 0.5) * contrast + 0.5;
        // rgb2hsv assumes [0,1] input; out-of-range values from brightness/
        // contrast produce incorrect hue/saturation, so clamp before convert.
        rgb = clamp(rgb, 0.0, 1.0);
        vec3 hsv = rgb2hsv(rgb);
        hsv.y *= saturation;
        hsv.x += hue / 360.0;
        hsv.x = fract(hsv.x);
        rgb = hsv2rgb(hsv);
        rgb = clamp(rgb, 0.0, 1.0);
        return vec4(rgb, color.a);
    }

    // Noise reduction filter (Gaussian blur)
    // strength: 0.0 = no noise reduction, 1.0 = max noise reduction
    // Keep offset distance fixed; use strength as blend ratio
    vec4 applyNoiseReduction(sampler2D tex, vec2 uv, float strength, float xMin, float xMax) {
        // Sample the original image. Use a single return with an explicitly
        // initialized result (rather than an early return for strength < 0.001):
        // ANGLE translates early-return functions into an HLSL return-flag pattern
        // whose result temp the D3D compiler cannot prove is always assigned,
        // producing harmless but noisy X4000 "potentially uninitialized variable"
        // warnings. A single return avoids that pattern. Behavior is identical:
        // when strength < 0.001 the result is simply the original sample.
        vec4 original = sampleTexture(tex, uv);
        vec4 result = original;

        if (strength >= 0.001) {
            // Apply Gaussian blur (3x3 Gaussian kernel, unrolled for GLSL ES 1.0 compatibility).
            // Out-of-bounds neighbors reuse the center (original) so the blur does not
            // bleed black into the image edges.
            vec4 blurred = vec4(0.0);
            float totalWeight = 0.0;
            // Row 0: weights 1, 2, 1
            blurred += sampleEyeKernel(tex, uv + vec2(-1.0, -1.0) * texelSize, original, xMin, xMax) * 1.0;
            blurred += sampleEyeKernel(tex, uv + vec2( 0.0, -1.0) * texelSize, original, xMin, xMax) * 2.0;
            blurred += sampleEyeKernel(tex, uv + vec2( 1.0, -1.0) * texelSize, original, xMin, xMax) * 1.0;
            // Row 1: weights 2, 4, 2
            blurred += sampleEyeKernel(tex, uv + vec2(-1.0,  0.0) * texelSize, original, xMin, xMax) * 2.0;
            blurred += sampleEyeKernel(tex, uv + vec2( 0.0,  0.0) * texelSize, original, xMin, xMax) * 4.0;
            blurred += sampleEyeKernel(tex, uv + vec2( 1.0,  0.0) * texelSize, original, xMin, xMax) * 2.0;
            // Row 2: weights 1, 2, 1
            blurred += sampleEyeKernel(tex, uv + vec2(-1.0,  1.0) * texelSize, original, xMin, xMax) * 1.0;
            blurred += sampleEyeKernel(tex, uv + vec2( 0.0,  1.0) * texelSize, original, xMin, xMax) * 2.0;
            blurred += sampleEyeKernel(tex, uv + vec2( 1.0,  1.0) * texelSize, original, xMin, xMax) * 1.0;
            totalWeight = 16.0;  // sum: 1+2+1+2+4+2+1+2+1
            blurred /= totalWeight;

            // Blend original and blur by strength (more intuitive scaling)
            result = mix(original, blurred, strength);
        }

        return result;
    }

    // Resolve a single sample with the noise-reduction filter applied when active,
    // otherwise the plain bounds-checked sample. Used so the sharpening kernel
    // operates on the same (denoised) pixels it is being added to.
    vec4 sampleMaybeNR(sampler2D tex, vec2 uv, float noiseReduction, float xMin, float xMax) {
        // Single return (ternary) instead of an early return, so ANGLE does not
        // emit a false-positive X4000 uninitialized-variable warning. Only one
        // branch is evaluated, matching the original semantics.
        return (noiseReduction > 0.001)
            ? applyNoiseReduction(tex, uv, noiseReduction, xMin, xMax)
            : sampleTexture(tex, uv);
    }

    // Neighbor sample for the sharpening kernel: noise-reduction aware (so we
    // sharpen the denoised image rather than re-injecting noise) and eye-region
    // aware (a tap outside this eye's half reuses the center).
    vec4 sampleSharpenNeighbor(sampler2D tex, vec2 uv, float noiseReduction, vec4 center, float xMin, float xMax) {
        // Bounds/seam check FIRST: a neighbor outside this eye's half reuses
        // \`center\` regardless of noise reduction. Routing the NR branch straight to
        // applyNoiseReduction instead would use its center sample (sampleTexture),
        // which returns black out of bounds — defeating the center fallback and
        // darkening the image border whenever noise reduction is active — and would
        // leave the center seam unguarded, letting taps bleed into the other eye.
        // Single return with an always-assigned result temp keeps ANGLE from
        // emitting a false-positive X4000 uninitialized-variable warning.
        vec4 result;
        if (!isInEyeBounds(uv, xMin, xMax)) {
            result = center;
        } else if (noiseReduction > 0.001) {
            result = applyNoiseReduction(tex, uv, noiseReduction, xMin, xMax);
        } else {
            result = texture2D(tex, uv);
        }
        return result;
    }

    // Apply image adjustments holistically (filters + color correction)
    vec4 processEye(sampler2D tex, vec2 uv, float brightness, float contrast, float saturation, float hue, float sharpness, float noiseReduction) {
        // The source is a side-by-side stereo texture split at x=0.5. Derive this
        // eye's half from the center sample so the convolution kernels below stay
        // on one side of the seam (left eye samples in [0,0.5], right in [0.5,1]).
        float eyeXMin = (uv.x < 0.5) ? 0.0 : 0.5;
        float eyeXMax = (uv.x < 0.5) ? 0.5 : 1.0;

        // Explicitly initialize color variable to avoid ANGLE compiler warning
        vec4 color = sampleMaybeNR(tex, uv, noiseReduction, eyeXMin, eyeXMax);
        if (sharpness > 0.001) {
            // Sharpen the (optionally denoised) result: the center is the value we
            // add the laplacian back onto, and neighbors are sampled the same way
            // so noise reduction is not undone by re-sampling the raw texture.
            vec4 center = color;
            vec4 top = sampleSharpenNeighbor(tex, uv + vec2(0.0, texelSize.y), noiseReduction, center, eyeXMin, eyeXMax);
            vec4 bottom = sampleSharpenNeighbor(tex, uv - vec2(0.0, texelSize.y), noiseReduction, center, eyeXMin, eyeXMax);
            vec4 left = sampleSharpenNeighbor(tex, uv - vec2(texelSize.x, 0.0), noiseReduction, center, eyeXMin, eyeXMax);
            vec4 right = sampleSharpenNeighbor(tex, uv + vec2(texelSize.x, 0.0), noiseReduction, center, eyeXMin, eyeXMax);
            // Unsharp mask via a ZERO-SUM Laplacian (4*center - 4 neighbors). Its
            // coefficients sum to 0, so a flat region yields 0 and sharpening
            // enhances edges WITHOUT shifting overall brightness. A 5*center
            // kernel (sum 1) left a residual +center*sharpness term that brightened
            // the whole image as the slider was raised. Using the true Laplacian
            // directly (rather than mix(color, color+laplacian*sharpness, sharpness),
            // which would collapse to a quadratic sharpness^2 response) keeps the
            // slider response linear.
            vec4 laplacian = center * 4.0 - top - bottom - left - right;
            color = color + laplacian * sharpness;
        }
        color = applyColorCorrection(color, brightness, contrast, saturation, hue);
        return color;
    }

    // Signed distance from point p to the segment a-b (used to build the pointer).
    float sdPointerSegment(vec2 p, vec2 a, vec2 b) {
        vec2 pa = p - a;
        vec2 ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h);
    }

    // Draw the 3D pointer as a bold arrow whose tip marks the exact point, at the
    // given baseUv with parallax. An arrow (not a circle) is used so the per-panel
    // aspect distortion inherent to the various layouts (SBS/TaB/LRL/3DTV) stays
    // visually unobtrusive: a stretched arrow still reads as an arrow, whereas a
    // stretched circle is an obvious ellipse. It is drawn directly in baseUv space
    // with no aspect correction, so no per-mode panel-aspect uniform is needed.
    vec4 drawPointer3d(vec2 uv, vec2 pointerPos, float parallax, bool isLeft) {
        vec2 pos = pointerPos;
        // Apply parallax: left eye stays fixed, only right eye shifts
        if (!isLeft) {
            pos.x += parallax;
        }

        // Local coords with the tip (apex) at the origin = the exact pointer point.
        // baseUv.y increases upward on screen, so placing the body at -y makes an
        // up-pointing arrow whose shaft hangs below the marked point (not over it).
        vec2 d = uv - pos;

        const float headHalfWidth = 0.018;  // arrowhead half-width
        const float headLength    = 0.024;  // arrowhead depth (down from the tip)
        const float shaftLength   = 0.052;  // shaft length (down from the tip)

        vec2 apex  = vec2(0.0, 0.0);
        vec2 tail  = vec2(0.0, -shaftLength);
        vec2 barbL = vec2(-headHalfWidth, -headLength);
        vec2 barbR = vec2( headHalfWidth, -headLength);

        float dist = sdPointerSegment(d, apex, tail);
        dist = min(dist, sdPointerSegment(d, apex, barbL));
        dist = min(dist, sdPointerSegment(d, apex, barbR));

        // Bold white stroke with a dark outline so it stays visible on any
        // background. (Gray/Dubois anaglyph overlays blend by luma/alpha, so the
        // dark outline simply fades there, leaving a plain bold white arrow.)
        const float coreHalf    = 0.0065;  // white stroke half-thickness
        const float outlineHalf = 0.0105;  // white + dark outline half-thickness
        const float aa = 0.0018;

        float outlineAlpha = smoothstep(outlineHalf + aa, outlineHalf - aa, dist);
        if (outlineAlpha <= 0.0) {
            return vec4(0.0);
        }
        float coreAlpha = smoothstep(coreHalf + aa, coreHalf - aa, dist);

        // White core over a dark outline; edge alpha gives anti-aliasing.
        vec3 col = mix(vec3(0.0), vec3(1.0), coreAlpha);
        return vec4(col, outlineAlpha * 0.9);
    }

    // Apply crop/offset and 3DTV virtual trim (shared by Simple and Layout)
    void applyCropAndOffset(inout vec2 originalUv, vec2 baseUv, bool is3dtvApplicable) {
        // Apply crop and offset
        originalUv.x = baseUv.x * (1.0 - cropX) + cropX * 0.5 + offsetX * 0.5;
        originalUv.y = baseUv.y * (1.0 - cropY) + cropY * 0.5 + offsetY * 0.5;

        // Apply virtual trim window for 3DTV (independent from regular crop)
        if (is3dtvApplicable) {
            originalUv.x = originalUv.x * (1.0 - tvCropX) + tvCropX * 0.5 + tvOffsetX * 0.5;
            originalUv.y = originalUv.y * (1.0 - tvCropY) + tvCropY * 0.5 + tvOffsetY * 0.5;
        }

        // In 3DTV zoom-out, keep black outside the visible window. Assigned LAST,
        // after the trim remap — otherwise the trim could map this out-of-bounds
        // sentinel back into a valid UV and resurrect pixels meant to stay black.
        if (is3dtvApplicable && (baseUv.x < 0.0 || baseUv.x > 1.0 || baseUv.y < 0.0 || baseUv.y > 1.0)) {
            originalUv = vec2(-1.0, -1.0);
        }
    }

    // Compute sampling coordinates with alignment transform, manual shift, and swap
    void computeSampleCoordinates(out vec2 sampleL, out vec2 sampleR, vec2 originalUv) {
        bool swapped = (swapLR > 0.5);
        vec2 srcL = originalUv;
        vec2 srcR = originalUv;

        if (swapped) {
            // swapLR=true: the physical LEFT half is the logical right eye
            // (the shift target), so alignment applies to srcL here.
            vec3 t = alignTransform * vec3(srcL, 1.0);
            srcL = t.xy / t.z;
            // Apply manual fine-tuning shift
            srcL.x -= shiftX * 2.0;
            srcL.y -= shiftY;
        } else {
            // swapLR=false: the physical RIGHT half is the logical right eye
            // (the shift target), so alignment applies to srcR here.
            vec3 t = alignTransform * vec3(srcR, 1.0);
            srcR = t.xy / t.z;
            // Apply manual fine-tuning shift
            srcR.x -= shiftX * 2.0;
            srcR.y -= shiftY;
        }

        // Compute SBS sampling coordinates
        sampleL = vec2(srcL.x * 0.5, srcL.y);
        sampleR = vec2(srcR.x * 0.5 + 0.5, srcR.y);

        // Bounds check (including vertical)
        if (srcL.x < 0.0 || srcL.x > 1.0 || srcL.y < 0.0 || srcL.y > 1.0) {
            sampleL = vec2(-1.0, -1.0);
        }
        if (srcR.x < 0.0 || srcR.x > 1.0 || srcR.y < 0.0 || srcR.y > 1.0) {
            sampleR = vec2(-1.0, -1.0);
        }

        if (swapped) {
            vec2 temp = sampleL;
            sampleL = sampleR;
            sampleR = temp;
        }
    }
`;

// ============================================================
// Shared input handling (compute sampling coordinates)
// Include baseUv calculation based on mode group
// ============================================================

// For anaglyph/interlace/single-view (no layout split)
const inputProcessingSimple = `
    // Simple mode: baseUv is directly from vUv (no layout split)
    vec2 baseUv = vUv;
    bool isLeftEyePos = true;
    bool is3dtvApplicable = (sbs3dtv > 0.5) && (mode == 7 || mode == 8 || mode == 9 || mode == 10 || mode == 16);

    // Apply common processing: crop/offset, 3DTV trim, shift, and swap
    vec2 originalUv;
    applyCropAndOffset(originalUv, baseUv, is3dtvApplicable);

    vec2 sampleL, sampleR;
    computeSampleCoordinates(sampleL, sampleR, originalUv);
`;

// Input handling for layout modes (SBS/TaB/LRL/Matrix)
const inputProcessingLayout = `
    vec2 baseUv = vUv;
    bool isLeftEyePos = true;

    // SBS modes: split left/right
    if (mode == 3 || mode == 7 || mode == 8 || mode == 9) {
        isLeftEyePos = (vUv.x < 0.5);
        if (isLeftEyePos) {
            baseUv.x = vUv.x * 2.0;
        } else {
            baseUv.x = (vUv.x - 0.5) * 2.0;
        }
    }
    // Top-and-Bottom: split top/bottom (top is left eye)
    else if (mode == 10 || mode == 16) {
        isLeftEyePos = (vUv.y >= 0.5);
        if (isLeftEyePos) {
            baseUv.y = (vUv.y - 0.5) * 2.0;
        } else {
            baseUv.y = vUv.y * 2.0;
        }
    }
    // LRL (left-right-left triple)
    else if (mode == 12) {
        // Use exact thirds: truncated literals (0.33333 / 0.66666) leave the
        // right panel computing baseUv.x up to 1.00002, which trips the strict
        // >1.0 bounds check and produces a 1px black column at the right edge.
        if (vUv.x < (1.0 / 3.0)) {
            isLeftEyePos = true;
            baseUv.x = vUv.x * 3.0;
        } else if (vUv.x < (2.0 / 3.0)) {
            isLeftEyePos = false;
            baseUv.x = (vUv.x - (1.0 / 3.0)) * 3.0;
        } else {
            isLeftEyePos = true;
            baseUv.x = (vUv.x - (2.0 / 3.0)) * 3.0;
        }
    }
    // Matrix 2x2 (top: parallel, bottom: cross)
    else if (mode == 13) {
        bool top = (vUv.y >= 0.5);
        bool left = (vUv.x < 0.5);

        if (top && left) {
            isLeftEyePos = true;
            baseUv = vec2(vUv.x * 2.0, (vUv.y - 0.5) * 2.0);
        } else if (top && !left) {
            isLeftEyePos = false;
            baseUv = vec2((vUv.x - 0.5) * 2.0, (vUv.y - 0.5) * 2.0);
        } else if (!top && left) {
            isLeftEyePos = false;
            baseUv = vec2(vUv.x * 2.0, vUv.y * 2.0);
        } else {
            isLeftEyePos = true;
            baseUv = vec2((vUv.x - 0.5) * 2.0, vUv.y * 2.0);
        }
    }

    // 3DTV mode flag
    bool is3dtvApplicable = (sbs3dtv > 0.5) && (mode == 7 || mode == 8 || mode == 9 || mode == 10 || mode == 16);

    // Keep 3DTV zoom/pan behavior independent from viewer mode
    if (is3dtvApplicable) {
        float regionAspect;
        if (mode == 10 || mode == 16) {
            regionAspect = resolution.x / (resolution.y * 0.5);
        } else {
            regionAspect = (resolution.x * 0.5) / resolution.y;
        }

        float adjustedImageAspect = imageAspect;
        if (mode == 7) {
            adjustedImageAspect = imageAspect * 0.5;
        } else if (mode == 10) {
            adjustedImageAspect = imageAspect * 2.0;
        }

        float fitScaleX = 1.0;
        float fitScaleY = 1.0;
        if (adjustedImageAspect > regionAspect) {
            fitScaleY = regionAspect / adjustedImageAspect;
        } else {
            fitScaleX = adjustedImageAspect / regionAspect;
        }

        // Center-fit/crop inside each 3DTV half-screen region
        baseUv.x = (baseUv.x - 0.5) / fitScaleX + 0.5;
        baseUv.y = (baseUv.y - 0.5) / fitScaleY + 0.5;

        baseUv = (baseUv - 0.5) / viewerScale + 0.5;
        float panScale3dtv = max(0.0, viewerScale - 1.0);
        baseUv.x += viewerPanX * panScale3dtv;
        baseUv.y += viewerPanY * panScale3dtv;
    }
    else if (viewerModeEnabled > 0.5 && (mode == 3 || mode == 7 || mode == 8 || mode == 9 || mode == 10 || mode == 12 || mode == 13 || mode == 16)) {
        baseUv = (baseUv - 0.5) / viewerScale + 0.5;
        float panScale = max(0.0, viewerScale - 1.0);
        baseUv.x += viewerPanX * panScale;
        baseUv.y += viewerPanY * panScale;
        baseUv = clamp(baseUv, 0.0, 1.0);
    }

    // Apply common processing: crop/offset, 3DTV trim, shift, and swap
    vec2 originalUv;
    applyCropAndOffset(originalUv, baseUv, is3dtvApplicable);

    vec2 sampleL, sampleR;
    computeSampleCoordinates(sampleL, sampleR, originalUv);

    // Cross-view (mode==9): swap which eye each panel shows. Flip the eye
    // assignment rather than swapping the samples, so the displayed image,
    // per-eye color adjustments, text overlay, and 3D pointer all mirror
    // together. This matches mode 13's cross row, which is likewise driven
    // entirely by isLeftEyePos (a sample-only swap left isLeftEyePos pointing at
    // the wrong eye, inverting pointer/text depth and crossing the L/R color
    // adjustments).
    if (mode == 9) {
        isLeftEyePos = !isLeftEyePos;
    }
`;

// ============================================================
// Shared text overlay handling
// ============================================================

// Text overlay for anaglyph modes
const textOverlayAnaglyph = `
    if (textEnabled > 0.5) {
        vec2 tuvL = baseUv;
        vec2 tuvR = baseUv;
        tuvL.x -= textParallax;
        tuvR.x += textParallax;

        vec4 tcL = vec4(0.0);
        if (tuvL.x >= 0.0 && tuvL.x <= 1.0 && tuvL.y >= 0.0 && tuvL.y <= 1.0) {
            tcL = texture2D(textTexL, tuvL);
        }

        vec4 tcR = vec4(0.0);
        if (tuvR.x >= 0.0 && tuvR.x <= 1.0 && tuvR.y >= 0.0 && tuvR.y <= 1.0) {
            tcR = texture2D(textTexR, tuvR);
        }

        // mode 0: Anaglyph (red/cyan)
        if (mode == 0) {
            float textBrightL = tcL.r * tcL.a;
            float strokeL = tcL.a * (1.0 - textBrightL);
            float textBrightR = (tcR.g + tcR.b) * 0.5 * tcR.a;
            float strokeR = tcR.a * (1.0 - (tcR.g + tcR.b) * 0.5);

            finalColor.r = clamp(finalColor.r + textBrightL * 0.9, 0.0, 1.0);
            finalColor.g = clamp(finalColor.g + textBrightR * 0.9, 0.0, 1.0);
            finalColor.b = clamp(finalColor.b + textBrightR * 0.9, 0.0, 1.0);

            float strokeDarken = max(strokeL, strokeR) * 0.5;
            finalColor.rgb = clamp(finalColor.rgb - strokeDarken, 0.0, 1.0);
        }
        // mode 11: Anaglyph (gray)
        else if (mode == 11) {
            float gL = dot(tcL.rgb, vec3(0.299, 0.587, 0.114)) * tcL.a;
            float gR = dot(tcR.rgb, vec3(0.299, 0.587, 0.114)) * tcR.a;

            float strokeL = tcL.a * (1.0 - gL);
            float strokeR = tcR.a * (1.0 - gR);

            finalColor.r = clamp(finalColor.r + gL * 0.9, 0.0, 1.0);
            finalColor.g = clamp(finalColor.g + gR * 0.9, 0.0, 1.0);
            finalColor.b = clamp(finalColor.b + gR * 0.9, 0.0, 1.0);

            float strokeDarken = max(strokeL, strokeR) * 0.5;
            finalColor.rgb = clamp(finalColor.rgb - strokeDarken, 0.0, 1.0);
        }
        // mode 14: Anaglyph (blue/yellow)
        else if (mode == 14) {
            float textBrightR = (tcR.r + tcR.g) * 0.5 * tcR.a;
            float strokeR = tcR.a * (1.0 - (tcR.r + tcR.g) * 0.5);
            float textBrightL = tcL.b * tcL.a;
            float strokeL = tcL.a * (1.0 - textBrightL);

            finalColor.r = clamp(finalColor.r + textBrightR * 0.9, 0.0, 1.0);
            finalColor.g = clamp(finalColor.g + textBrightR * 0.9, 0.0, 1.0);
            finalColor.b = clamp(finalColor.b + textBrightL * 0.9, 0.0, 1.0);

            float strokeDarken = max(strokeL, strokeR) * 0.5;
            finalColor.rgb = clamp(finalColor.rgb - strokeDarken, 0.0, 1.0);
        }
        // mode 15: Anaglyph (Dubois)
        else if (mode == 15) {
            float gL = dot(tcL.rgb, vec3(0.299, 0.587, 0.114)) * tcL.a;
            float gR = dot(tcR.rgb, vec3(0.299, 0.587, 0.114)) * tcR.a;

            // Grayscale text routed through the Dubois diagonal terms: left eye ->
            // red (M_L[0][0]), right eye -> green/blue (M_R[1][1] / M_R[2][2]).
            // Using M_R's off-diagonal column entry (0.378) for textG, or an
            // understated 0.990 for blue, would dim and unbalance the right-eye
            // (cyan) text; the diagonal values below match the corrected image matrix.
            float textR = gL * 0.4561 * 0.9;
            float textG = gR * 0.73364 * 0.9;
            float textB = gR * 1.2264 * 0.9;

            finalColor.r = clamp(finalColor.r + textR, 0.0, 1.0);
            finalColor.g = clamp(finalColor.g + textG, 0.0, 1.0);
            finalColor.b = clamp(finalColor.b + textB, 0.0, 1.0);
        }
    }
`;

// Text overlay for interlace modes
const textOverlayInterlace = `
    if (textEnabled > 0.5) {
        vec2 tuvL = baseUv;
        vec2 tuvR = baseUv;
        tuvL.x -= textParallax;
        tuvR.x += textParallax;

        vec4 tcL = vec4(0.0);
        if (tuvL.x >= 0.0 && tuvL.x <= 1.0 && tuvL.y >= 0.0 && tuvL.y <= 1.0) {
            tcL = texture2D(textTexL, tuvL);
        }

        vec4 tcR = vec4(0.0);
        if (tuvR.x >= 0.0 && tuvR.x <= 1.0 && tuvR.y >= 0.0 && tuvR.y <= 1.0) {
            tcR = texture2D(textTexR, tuvR);
        }

        // mode 1: Interlace (horizontal lines)
        if (mode == 1) {
            float line = floor(gl_FragCoord.y) + interlaceParityOffset;
            bool useLeft = mod(line, 2.0) < 1.0;
            vec4 tc = useLeft ? tcL : tcR;
            finalColor = mix(finalColor, tc, tc.a);
        }
        // mode 2: Interlace (vertical lines)
        else if (mode == 2) {
            float col = floor(gl_FragCoord.x);
            bool useLeft = mod(col, 2.0) < 1.0;
            vec4 tc = useLeft ? tcL : tcR;
            finalColor = mix(finalColor, tc, tc.a);
        }
    }
`;

// Text overlay for single-view/layout modes
const textOverlayGeneral = `
    if (textEnabled > 0.5) {
        vec2 tuvL = baseUv;
        vec2 tuvR = baseUv;
        tuvL.x -= textParallax;
        tuvR.x += textParallax;

        vec4 tcL = vec4(0.0);
        if (tuvL.x >= 0.0 && tuvL.x <= 1.0 && tuvL.y >= 0.0 && tuvL.y <= 1.0) {
            tcL = texture2D(textTexL, tuvL);
        }

        vec4 tcR = vec4(0.0);
        if (tuvR.x >= 0.0 && tuvR.x <= 1.0 && tuvR.y >= 0.0 && tuvR.y <= 1.0) {
            tcR = texture2D(textTexR, tuvR);
        }

        vec4 tc = isLeftEyePos ? tcL : tcR;
        finalColor = mix(finalColor, tc, tc.a);
    }
`;

// ============================================================
// Shared 3D pointer overlay handling
// ============================================================

// 3D Pointer overlay for anaglyph modes
const pointer3dOverlayAnaglyph = `
    if (pointer3dEnabled > 0.5) {
        vec4 pL = drawPointer3d(baseUv, pointer3dPos, pointer3dParallax, true);
        vec4 pR = drawPointer3d(baseUv, pointer3dPos, pointer3dParallax, false);

        // Anaglyph: blend pointer into appropriate color channels
        // mode 0: red/cyan
        if (mode == 0) {
            finalColor.r = mix(finalColor.r, pL.r, pL.a);
            finalColor.g = mix(finalColor.g, pR.g, pR.a);
            finalColor.b = mix(finalColor.b, pR.b, pR.a);
        }
        // mode 11: gray anaglyph
        else if (mode == 11) {
            float gL = pL.r * pL.a;
            float gR = pR.r * pR.a;
            finalColor.r = mix(finalColor.r, 1.0, gL);
            finalColor.g = mix(finalColor.g, 1.0, gR);
            finalColor.b = mix(finalColor.b, 1.0, gR);
        }
        // mode 14: blue/yellow
        else if (mode == 14) {
            finalColor.r = mix(finalColor.r, pR.r, pR.a);
            finalColor.g = mix(finalColor.g, pR.g, pR.a);
            finalColor.b = mix(finalColor.b, pL.b, pL.a);
        }
        // mode 15: Dubois
        else if (mode == 15) {
            finalColor.r = mix(finalColor.r, 1.0, pL.a * 0.5);
            finalColor.g = mix(finalColor.g, 1.0, pR.a * 0.5);
            finalColor.b = mix(finalColor.b, 1.0, pR.a * 0.5);
        }
    }
`;

// 3D Pointer overlay for interlace modes
const pointer3dOverlayInterlace = `
    if (pointer3dEnabled > 0.5) {
        vec4 pL = drawPointer3d(baseUv, pointer3dPos, pointer3dParallax, true);
        vec4 pR = drawPointer3d(baseUv, pointer3dPos, pointer3dParallax, false);

        // mode 1: horizontal interlace
        if (mode == 1) {
            float line = floor(gl_FragCoord.y) + interlaceParityOffset;
            bool useLeft = mod(line, 2.0) < 1.0;
            vec4 p = useLeft ? pL : pR;
            finalColor = mix(finalColor, vec4(p.rgb, 1.0), p.a);
        }
        // mode 2: vertical interlace
        else if (mode == 2) {
            float col = floor(gl_FragCoord.x);
            bool useLeft = mod(col, 2.0) < 1.0;
            vec4 p = useLeft ? pL : pR;
            finalColor = mix(finalColor, vec4(p.rgb, 1.0), p.a);
        }
    }
`;

// 3D Pointer overlay for single-view and layout modes
const pointer3dOverlayGeneral = `
    if (pointer3dEnabled > 0.5) {
        vec4 p = drawPointer3d(baseUv, pointer3dPos, pointer3dParallax, isLeftEyePos);
        finalColor = mix(finalColor, vec4(p.rgb, 1.0), p.a);
    }
`;

// ============================================================
// Shared grid processing and final output
// ============================================================
// Apply the global on-screen display dimming to the IMAGE only, before the text
// and 3D-pointer overlays are composited. The overlays (and the grid, which is
// drawn later in gridAndOutput) are UI elements meant to stay at full intensity,
// so dimming them would undercut the pointer's "bold white, visible on any
// background" design. On export/histogram, intensity is forced to 1.0, so this
// is a no-op there.
const applyImageIntensity = `
    finalColor.rgb *= intensity;
`;

const gridAndOutput = `
    if (gridEnabled > 0.5) {
        vec2 gridUv = vUv * gridDensity;
        vec2 gridFract = fract(gridUv);

        float pixelSize = 1.0 / (min(resolution.x, resolution.y) * pixelRatio);
        float minLineWidth = max(2.0 * pixelSize * gridDensity, 0.01);
        float maxLineWidth = 0.03;
        float lineWidth = clamp(minLineWidth, 0.01, maxLineWidth);

        float aa = pixelSize * gridDensity * 0.5;
        float gridX = smoothstep(lineWidth, lineWidth - aa, gridFract.x);
        float gridY = smoothstep(lineWidth, lineWidth - aa, gridFract.y);
        float gridMask = max(gridX, gridY);

        finalColor.rgb = mix(finalColor.rgb, gridColor, gridMask * 0.5);
    }

    gl_FragColor = finalColor;
`;

// ============================================================
// Mode-specific rendering
// ============================================================

// Anaglyph rendering
const renderAnaglyph = `
    vec4 cL = processEye(map, sampleL, brightnessL, contrastL, saturationL, hueL, sharpnessL, noiseReductionL);
    vec4 cR = processEye(map, sampleR, brightnessR, contrastR, saturationR, hueR, sharpnessR, noiseReductionR);

    // mode 0: Anaglyph (red/cyan)
    if (mode == 0) {
        finalColor = vec4(cL.r, cR.g, cR.b, 1.0);
    }
    // mode 11: Anaglyph (gray)
    else if (mode == 11) {
        float gL = dot(cL.rgb, vec3(0.299, 0.587, 0.114));
        float gR = dot(cR.rgb, vec3(0.299, 0.587, 0.114));
        finalColor = vec4(gL, gR, gR, 1.0);
    }
    // mode 14: Anaglyph (blue/yellow)
    else if (mode == 14) {
        finalColor = vec4(cR.r, cR.g, cL.b, 1.0);
    }
    // mode 15: Anaglyph (Dubois)
    else if (mode == 15) {
        // Dubois optimized red-cyan anaglyph. Each output channel is the sum of the
        // left-eye contribution (M_L row) and the right-eye contribution (M_R row).
        // Dropping the cross terms, or indexing the M_R *columns* instead of its rows
        // for G/B, would collapse the cyan channels to ~1/4 of the intended luminance;
        // the full 3x3 matrices below ensure correct rendering.
        float outR = cL.r *  0.4561    + cL.g *  0.500484  + cL.b *  0.176381
                   + cR.r * -0.0434706 + cR.g * -0.0879388 + cR.b * -0.00155529;
        float outG = cL.r * -0.0400822 + cL.g * -0.0378246 + cL.b * -0.0157589
                   + cR.r *  0.378476  + cR.g *  0.73364   + cR.b * -0.0184503;
        float outB = cL.r * -0.0152161 + cL.g * -0.0205971 + cL.b * -0.00546856
                   + cR.r * -0.0721527 + cR.g * -0.112961  + cR.b *  1.2264;
        finalColor = vec4(clamp(vec3(outR, outG, outB), 0.0, 1.0), 1.0);
    }
`;

// Interlace rendering
const renderInterlace = `
    // mode 1: Interlace (horizontal lines)
    if (mode == 1) {
        float line = floor(gl_FragCoord.y) + interlaceParityOffset;
        bool useLeft = mod(line, 2.0) < 1.0;
        finalColor = useLeft ? processEye(map, sampleL, brightnessL, contrastL, saturationL, hueL, sharpnessL, noiseReductionL) : processEye(map, sampleR, brightnessR, contrastR, saturationR, hueR, sharpnessR, noiseReductionR);
    }
    // mode 2: Interlace (vertical lines)
    else if (mode == 2) {
        float col = floor(gl_FragCoord.x);
        bool useLeft = mod(col, 2.0) < 1.0;
        finalColor = useLeft ? processEye(map, sampleL, brightnessL, contrastL, saturationL, hueL, sharpnessL, noiseReductionL) : processEye(map, sampleR, brightnessR, contrastR, saturationR, hueR, sharpnessR, noiseReductionR);
    }
`;

// Single-view rendering
const renderSingleView = `
    // mode 4: Left eye only (2D)
    if (mode == 4) {
        finalColor = processEye(map, sampleL, brightnessL, contrastL, saturationL, hueL, sharpnessL, noiseReductionL);
        isLeftEyePos = true;
    }
    // mode 5: Right eye only (2D)
    else if (mode == 5) {
        finalColor = processEye(map, sampleR, brightnessR, contrastR, saturationR, hueR, sharpnessR, noiseReductionR);
        isLeftEyePos = false;
    }
    // mode 6: Wiggle (alternate left/right)
    else if (mode == 6) {
        if (wigglePhase > 0.5) {
            finalColor = processEye(map, sampleL, brightnessL, contrastL, saturationL, hueL, sharpnessL, noiseReductionL);
            isLeftEyePos = true;
        } else {
            finalColor = processEye(map, sampleR, brightnessR, contrastR, saturationR, hueR, sharpnessR, noiseReductionR);
            isLeftEyePos = false;
        }
    }
`;

// Layout rendering
const renderLayout = `
    vec2 sampleUv = isLeftEyePos ? sampleL : sampleR;
    if (isLeftEyePos) {
        finalColor = processEye(map, sampleUv, brightnessL, contrastL, saturationL, hueL, sharpnessL, noiseReductionL);
    } else {
        finalColor = processEye(map, sampleUv, brightnessR, contrastR, saturationR, hueR, sharpnessR, noiseReductionR);
    }
`;

// ============================================================
// Shader factory functions
// ============================================================

/**
 * Anaglyph shaders (mode 0, 11, 14, 15)
 */
export function createAnaglyphShader() {
    return `
        ${uniformDeclarations}
        ${commonUtilities}
        void main() {
            vec4 finalColor = vec4(0.0);
            ${inputProcessingSimple}
            ${renderAnaglyph}
            ${applyImageIntensity}
            ${textOverlayAnaglyph}
            ${pointer3dOverlayAnaglyph}
            ${gridAndOutput}
        }
    `;
}

/**
 * Interlace shaders (mode 1, 2)
 */
export function createInterlaceShader() {
    return `
        ${uniformDeclarations}
        ${commonUtilities}
        void main() {
            vec4 finalColor = vec4(0.0);
            ${inputProcessingSimple}
            ${renderInterlace}
            ${applyImageIntensity}
            ${textOverlayInterlace}
            ${pointer3dOverlayInterlace}
            ${gridAndOutput}
        }
    `;
}

/**
 * Single-view shaders (mode 4, 5, 6)
 */
export function createSingleViewShader() {
    return `
        ${uniformDeclarations}
        ${commonUtilities}
        void main() {
            vec4 finalColor = vec4(0.0);
            ${inputProcessingSimple}
            ${renderSingleView}
            ${applyImageIntensity}
            ${textOverlayGeneral}
            ${pointer3dOverlayGeneral}
            ${gridAndOutput}
        }
    `;
}

/**
 * Layout shaders (mode 3, 7, 8, 9, 10, 12, 13, 16)
 */
export function createLayoutShader() {
    return `
        ${uniformDeclarations}
        ${commonUtilities}
        void main() {
            vec4 finalColor = vec4(0.0);
            ${inputProcessingLayout}
            ${renderLayout}
            ${applyImageIntensity}
            ${textOverlayGeneral}
            ${pointer3dOverlayGeneral}
            ${gridAndOutput}
        }
    `;
}

// ============================================================
// Determine mode group and select shaders
// ============================================================

/**
 * Determine shader group from mode number
 */
export function getShaderGroup(mode) {
    // Anaglyph group
    if (isAnaglyphMode(mode)) {
        return 'anaglyph';
    }
    // Interlace group
    if (isInterlaceMode(mode)) {
        return 'interlace';
    }
    // Single-view group (mono + Wiggle)
    if (isSingleEyeMode(mode) || isWiggleMode(mode)) {
        return 'singleView';
    }
    // Layout group (SBS/TaB/LRL/Matrix/VR)
    return 'layout';
}

/**
 * Get fragment shader for a mode number
 */
export function getFragmentShader(mode) {
    const group = getShaderGroup(mode);
    switch (group) {
        case 'anaglyph':
            return createAnaglyphShader();
        case 'interlace':
            return createInterlaceShader();
        case 'singleView':
            return createSingleViewShader();
        case 'layout':
        default:
            return createLayoutShader();
    }
}

// Shader group cache
const shaderCache = new Map();

/**
 * Get fragment shader with caching
 */
export function getFragmentShaderCached(mode) {
    const group = getShaderGroup(mode);
    if (!shaderCache.has(group)) {
        shaderCache.set(group, getFragmentShader(mode));
    }
    return shaderCache.get(group);
}

/**
 * Clear shader cache
 */
export function clearShaderCache() {
    shaderCache.clear();
}
