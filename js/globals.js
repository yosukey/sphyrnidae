/**
 * globals.js
 * State management and constants shared across the application
 */

// structuredClone polyfill for browsers that do not support it natively
// (Chrome < 98, Firefox < 94, Safari < 15.4).  Falls back to JSON round-trip
// which handles plain-data objects like defaultParams / defaultExportOptions.
// Limitation: cannot clone circular references, Date, RegExp, Map, Set, or functions.
if (typeof structuredClone === 'undefined') {
    console.warn('structuredClone not available — using JSON polyfill (only plain-data objects supported)');
    globalThis.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

import {
    modeSuffixes,
    getModeLayout,
    isSBSMode,
    isCropSelectionAllowed,
    is3DTVModeApplicable
} from './mode-utils.js';

import {
    APP_VERSION,
    BUILD_DATE,
    COMMIT_SHA
} from './version.js';

// Debug mode settings - fine-grained logging control
// Configuration is read from debug-config.js (loaded before this module)
// - DEVELOPMENT mode: All debug flags enabled (default for local development)
// - PRODUCTION mode: Only ERROR/WARN/INFO enabled (set by GitHub Actions)

// Detect if running in a Worker context (Web Worker, Service Worker, etc.)
const isWorkerContext = typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;

// Read configuration from globalThis (set by debug-config.js classic script).
// debug-config.js is a classic <script> only loaded in the page, NOT in module
// workers — so DEBUG_MODE is undefined there. Default to PRODUCTION (debug OFF)
// when unset to avoid enabling all debug flags in production workers.
const MODE = globalThis.DEBUG_MODE || 'PRODUCTION';
const MASTER_DEBUG = globalThis.DEBUG_ENABLED !== false;

// Runtime override via localStorage (for developers testing production behavior)
// Skip localStorage access in Worker context (not available)
const storageMode = (() => {
    if (isWorkerContext) {
        return null;
    }
    try {
        return localStorage.getItem('DEBUG_MODE');
    } catch (e) {
        return null;
    }
})();

const runtimeMode = storageMode || MODE;
const isDevMode = runtimeMode === 'DEVELOPMENT';

// An explicit localStorage opt-in (DEBUG_MODE='DEVELOPMENT') is a deliberate
// developer action via devtools, so it must enable debug logs even in a production
// build where the compile-time master switch (MASTER_DEBUG) is false. Without this
// the documented override silently did nothing exactly where it's most useful.
const storageDevOptIn = storageMode === 'DEVELOPMENT';

// Apply mode-based defaults
// In DEVELOPMENT: debugDefault = true (all debug logs enabled)
// In PRODUCTION: debugDefault = false (only error/warn/info enabled)
const debugDefault = isDevMode && (MASTER_DEBUG || storageDevOptIn);

export const DEBUG = {
    // Core module logging
    MAIN_LOG: debugDefault,                    // Enable app bootstrap / init lifecycle logs
    EXIF_LOG: debugDefault,                    // Enable EXIF extraction and parsing logs
    AUDIT_LOG: debugDefault,                   // Enable audit trail (complete action lifecycle tracking)

    // Rendering module
    RENDER_ERROR_LOG: true,                    // Enable rendering critical error logs (always enabled)
    RENDER_VALIDATION_LOG: debugDefault,       // Enable material/texture validation detail logs
    RENDER_INFO_LOG: debugDefault,             // Enable renderer initialization and state logs

    // VR module
    VR_LOG: debugDefault,                      // Enable VR initialization and session logs
    VR_DETAIL_LOG: debugDefault,               // Enable detailed VR button and WebXR state logs

    // Loader module
    LOADER_LOG: debugDefault,                  // Enable image loading lifecycle logs
    FORMAT_DETECTION_LOG: debugDefault,        // Enable format detection analysis logs (SBS/TaB/Interlace)
    WORKER_LOG: debugDefault,                  // Enable Web Worker communication and processing logs

    // UI modules
    FULLSCREEN_LOG: debugDefault,              // Enable fullscreen mode transition logs
    UI_LOG: debugDefault,                      // Enable general UI interaction logs
    EXPORT_LOG: debugDefault,                  // Enable image export operation logs
    CROP_LOG: debugDefault,                    // Enable crop selection and apply logs
    ALIGNMENT_LOG: debugDefault,               // Enable alignment pipeline selection and fallback logs

    // Network and caching
    OFFLINE_LOG: debugDefault,                 // Enable network status change logs
    UPDATE_NOTIFICATION_LOG: debugDefault,     // Enable version check and update notification logs
    VERSION_CHECK_LOG: debugDefault,           // Enable version fetch attempt logs
    CACHE_LOG: debugDefault                    // Enable Service Worker cache operation logs
};

// Development helper: expose debug control functions
// Only available in main thread context (not in Workers)
if (isDevMode && !isWorkerContext && typeof window !== 'undefined') {
    // Initialize namespace
    if (!window.StereoView) {
        window.StereoView = {};
    }

    // Helper function to switch debug mode
    const setDebugMode = (mode) => {
        try {
            if (mode !== 'DEVELOPMENT' && mode !== 'PRODUCTION') {
                console.error('Invalid mode. Use "DEVELOPMENT" or "PRODUCTION"');
                return;
            }
            localStorage.setItem('DEBUG_MODE', mode);
            console.log(`✓ Debug mode set to ${mode}. Reload page to apply.`);
            console.log('  To reload: location.reload()');
        } catch (e) {
            console.error('Failed to set debug mode:', e);
        }
    };

    // Create debug namespace
    window.StereoView.debug = {
        DEBUG,
        setDebugMode,
        currentMode: runtimeMode,
        isDevMode: isDevMode
    };

    // Expose as direct globals (console access, inline HTML handlers) in addition to the namespace
    Object.defineProperty(window, 'DEBUG', {
        get: () => window.StereoView.debug.DEBUG,
        configurable: true
    });

    Object.defineProperty(window, 'setDebugMode', {
        get: () => window.StereoView.debug.setDebugMode,
        configurable: true
    });

    // Log current mode on startup
    console.log(`🔧 Debug mode: ${runtimeMode}${storageMode ? ' (localStorage override)' : ''}`);
    if (runtimeMode === 'DEVELOPMENT') {
        console.log('   All debug logs enabled. Use setDebugMode("PRODUCTION") to test production behavior.');
    }
}

// APP_NAME - use document.title if available (main thread), fallback to 'Sphyrnidae' (Worker context)
export const APP_NAME = (!isWorkerContext && typeof document !== 'undefined' && document.title) ? document.title : 'Sphyrnidae';

// BASE_URL - application base URL (dynamically detected from window.location.origin)
// Used for constructing absolute URLs (e.g., in exported HTML files)
export const BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';

export const REPOSITORY_URL = 'https://github.com/yosukey/sphyrnidae';

// APP_SITE_URL - the official hosted application. Unlike BASE_URL (wherever this
// copy happens to be served from) this is the canonical address shown to users,
// e.g. in the viewer help modal, where a URL-launched viewer offers no other way
// to tell what app is showing the image.
export const APP_SITE_URL = 'https://sphyrnidae.pages.dev/';

// Version info (re-exported from version.js)
export { APP_VERSION, BUILD_DATE, COMMIT_SHA };

// Default parameter values (master definition)
const defaultParams = {
    mode: 0,
    shiftX: 0.0,
    shiftY: 0.0,
    scale: 1.0,
    panX: 0.0,
    panY: 0.0,
    cropX: 0.0,
    cropY: 0.0,
    offsetX: 0.0,
    offsetY: 0.0,
    tvCropX: 0.0,
    tvCropY: 0.0,
    tvOffsetX: 0.0,
    tvOffsetY: 0.0,
    swapLR: false,
    sbs3dtv: false,
    textString: '',
    textSize: 48,
    textStroke: 0,
    textColor: '#cccccc',
    textX: 0.5,
    textY: 0.5,
    textParallax: 0.02,
    textRotation: 0,
    textEffect: 'none',
    textEffectStrength: 0.5,
    brightnessL: 0.0,
    brightnessR: 0.0,
    contrastL: 1.0,
    contrastR: 1.0,
    saturationL: 1.0,
    saturationR: 1.0,
    hueL: 0.0,
    hueR: 0.0,
    sharpnessL: 0.0,
    sharpnessR: 0.0,
    noiseReductionL: 0.0,
    noiseReductionR: 0.0,
    // Link L/R image-quality adjustments (global option)
    // When true, L controls drive both eyes; when false, L and R are independent.
    linkLR: true,
    gridEnabled: false,
    gridDensity: 10,
    gridColor: '#888888',
    wigglePhase: 0.0,
    // Auto-alignment transform matrix (mat3, column-major for GLSL)
    // Identity matrix by default (no transformation)
    alignTransform: [1, 0, 0, 0, 1, 0, 0, 0, 1]
};
Object.freeze(defaultParams);

// Default export options (master definition)
const defaultExportOptions = {
    quality: 0.95,
    enableResize: false,
    resizeMode: 'scale',   // 'scale' or 'pixel'
    resizeScale: 0.5,
    resizeTargetWidth: null, // pixel mode: target width in px (null = not set)
    resizeAlgorithm: 'lanczos',
    enableBorderDecoration: false,
    preserveExif: true     // For JPEG/MPO output, splice original EXIF APP1 segment
};
Object.freeze(defaultExportOptions);

export const state = {
    // Three.js related
    scene: null,
    camera: null,
    vrCamera: null,
    renderer: null,
    mesh: null,
    material: null,
    textureLoader: null,

    // ResizeObserver instance management
    resizeObserver: null,

    // For text overlay
    textTextureL: null,
    textTextureR: null,

    // File info
    originalFileNameBase: 'image',

    // EXIF info (for display - reference left/right based on swapLR)
    exifData: null,           // Raw data from ExifReader (for display)
    exifThumbnail: null,      // Thumbnail image (Base64) (for display)

    // EXIF info (kept separately for left/right)
    exifDataLeft: null,       // Left image EXIF
    exifDataRight: null,      // Right image EXIF
    exifThumbnailLeft: null,  // Left image thumbnail
    exifThumbnailRight: null, // Right image thumbnail

    // Raw EXIF APP1 segment bytes (for re-injection on JPEG/MPO export)
    exifRawSegment: null,       // Active raw APP1 segment (based on swapLR)
    exifRawSegmentLeft: null,   // Left image raw APP1 segment (Uint8Array) or null
    exifRawSegmentRight: null,  // Right image raw APP1 segment (Uint8Array) or null

    // Crop state management
    lastCroppedShiftX: null,
    lastCroppedShiftY: null,
    lastCroppedAlign: null, // alignTransform snapshot at last auto-crop (geometric refinement)

    // Rectangle selection state
    cropSelectionMode: false,
    cropSelection: null, // { x, y, width, height } (UV coordinate system 0-1)
    lastCropState: null, // Save state before crop apply (for cancel)
    cropRectMode: 'free', // 'free' | 'aspectRatio' | 'fixedSize'
    cropAspectWidth: 16,
    cropAspectHeight: 9,
    cropFixedWidth: 1920,
    cropFixedHeight: 1080,

    // VR related
    vrEnabled: false,
    vrSession: null,

    // Viewer mode related
    viewerMode: false,              // Viewer mode enabled flag
    viewerFiles: [],                // Image file list for viewer mode
    viewerCurrentIndex: 0,          // Current image index
    viewerSlideshowIntervalId: null, // Slideshow interval ID
    viewerSlideshowSpeed: 0,        // Slideshow speed (seconds) 0=OFF, 1/2/5/10=ON
    viewerLoopMode: false,          // Loop mode (wrap at list ends)
    viewerPanX: 0.0,                // Viewer mode pan (shared for left/right images)
    viewerPanY: 0.0,                // Viewer mode pan (shared for left/right images)
    viewerScale: 1.0,               // Viewer mode scale (1.0=fit)
    viewerFitScale: 1.0,            // Fit scale (baseline)
    pre3DTVScale: null,             // Normal-view scale saved while 3DTV zoom owns viewerScale
    viewerDisplayMode: 0,           // Viewer mode: remembered display mode (re-applied across navigation; per-image URL mode= takes priority)
    viewerSwapLR: false,            // Viewer mode: remembered swap-L/R state (re-applied across navigation)

    // External image mode (opened via URL parameters)
    externalImageMode: false,       // Whether opened from an external URL
    externalImageUrl: null,         // External image URL
    currentImageFormat: null,       // Current image format (full_sbs, half_sbs, etc.)

    // URL dialog mode (opened via "Open from URL" menu in normal mode)
    loadedFromUrlDialog: false,     // Whether loaded via the "Open from URL" dialog in normal mode

    // URL parameter mode (opened directly via ?src= or ?list=)
    loadedFromUrlParams: false,     // Whether viewer mode was started directly from URL parameters

    // 3D Pointer mode
    pointer3dEnabled: false,        // Whether 3D pointer mode is active
    pointer3dX: 0.5,               // Pointer UV X position (0-1, per-eye baseUv space; matches shader)
    pointer3dY: 0.5,               // Pointer UV Y position (0-1, per-eye baseUv space; matches shader)
    pointer3dParallax: 0.0,        // Pointer depth: right-eye-only baseUv x-shift (L/R disparity = parallax * eyeWidth px)
    pointer3dVisible: false,        // Whether mouse is currently over the canvas

    // Parameters (initialized from defaultParams)
    params: structuredClone(defaultParams),

    // Export settings (initialized from defaultExportOptions)
    exportOptions: structuredClone(defaultExportOptions),

    // Default values for reset (reference to master definitions)
    defaultParams: defaultParams
};

// Mode-related functions live in mode-utils.js; re-exported here so callers
// can import them from globals.js
export { getModeLayout, isCropSelectionAllowed, isSBSMode };

/**
 * Check if 3DTV mode is active
 * Combines sbs3dtv parameter check and mode applicability check.
 *
 * @returns {boolean} Whether 3DTV mode is currently active
 */
export function is3DTVActive() {
    return state.params.sbs3dtv && is3DTVModeApplicable(state.params.mode);
}

export const CONSTANTS = {
    // Mode-specific filename suffixes (from mode-utils.js)
    modeSuffixes: modeSuffixes,
    // Save format extension map
    extensionMap: {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
        "image/tiff": ".tiff",
        "image/mpo": ".mpo",
        "image/agif": ".gif",
        "image/apng": ".png"
    },
    // Rendering related
    CAMERA_FRUSTUM_HEIGHT: 10,           // Camera frustum height (world units)
    DEFAULT_PLANE_HEIGHT: 10,            // Default plane height
    MIN_SELECTION_SIZE: 5,               // Minimum selection size (pixels)
    MAX_RENDER_ERRORS: 5,                // Max allowed render errors
    ERROR_RESET_INTERVAL: 5000,          // Error count reset interval (ms)
    // Timeout settings (ms)
    FILE_LOAD_TIMEOUT_MS: 60000,         // File load timeout (60s)
    MPO_PROCESSING_TIMEOUT_MS: 30000,    // MPO processing timeout (30s)
    IMAGE_FETCH_TIMEOUT: 30000,          // Image fetch timeout (30s)
    URL_LIST_FETCH_TIMEOUT: 30000,       // URL list text-file fetch timeout (30s)
    // File size limits
    IMAGE_FETCH_MAX_SIZE: 50 * 1024 * 1024, // Image fetch max size (50MB)
    URL_LIST_MAX_BYTES: 5 * 1024 * 1024,    // URL list text-file max size (5MB)
    URL_LIST_MAX_ENTRIES: 1000,             // Max number of URLs parsed from a list
    LARGE_IMAGE_FILE_SIZE_MB: 20,            // Large image file size threshold (MB)
    FORMAT_DETECTION_SKIP_SIZE_MB: 50,       // Skip format detection for files larger than this (MB)
    LARGE_IMAGE_PIXELS_MP: 30,               // Large image pixel count threshold (megapixels)
    SKIP_FORMAT_DETECTION_MP: 50,            // Skip format detection for images larger than this (megapixels)
    // MPO processing related
    MPO_MAX_SCAN_LENGTH: 10 * 1024 * 1024,  // Max MPO scan length (10MB)
    MPO_MAX_JPEG_COUNT: 20,                 // Max JPEGs to extract from MPO
    MPO_MIN_JPEG_SIZE: 4096,                // Min JPEG size in MPO (bytes)
    // Format detection related
    FORMAT_DETECTION_MAX_SIZE: 800,         // Max size for format detection analysis (pixels)
    FORMAT_DETECTION_CONFIDENCE_THRESHOLD: 0.6, // Format detection confidence threshold
    FORMAT_DETECTION_SAMPLE_COUNT: 500,     // Format detection sample count
    // Shift/crop related
    DEFAULT_SHIFT_STEP: 1,               // Default shift step
    FINE_SHIFT_STEP: 0.1,                // Fine shift step
    COARSE_SHIFT_STEP: 10,               // Coarse shift step
    // Animation related
    WIGGLE_ANIMATION_INTERVAL_MS: 150,   // Wiggle mode toggle interval (ms)
    // Image processing related
    ANALYSIS_RESIZE_MAX_DIMENSION: 1024, // Max dimension for analysis resize (pixels)
    // UI related
    HISTOGRAM_DEBOUNCE_DELAY: 150,       // Histogram update debounce delay (ms)
    // Histogram calculation related
    MAX_HISTOGRAM_SIZE: 1536,            // Max size for histogram downsampling (pixels)
    // Fullscreen mode related
    FULLSCREEN_DETECTION_THRESHOLD: 0.95, // Fullscreen detection threshold
    VIEWER_BAR_AUTO_HIDE_DELAY: 2000,    // Viewer bar auto-hide delay (ms)
    VIEWER_BAR_HOVER_ZONE_HEIGHT: 100,   // Viewer bar hover zone height (px)
    SWIPE_THRESHOLD: 50,                 // Minimum distance to treat as swipe (px)
    SWIPE_START_ZONE: 150,               // Bottom zone to detect swipe start (px)
    TAP_THRESHOLD: 10,                   // Max movement to treat as tap (px)
    TAP_TIME_THRESHOLD: 300,             // Max time to treat as tap (ms)
    // Automatic format detection related
    INTERLACE_PERIODICITY_THRESHOLD: 1.5, // Periodicity ratio threshold: evenOddDiff/sameParityDiff must exceed this
    INTERLACE_SBS_VETO_SIMILARITY: 0.75, // If SBS/TaB half-similarity exceeds this, veto interlace detection
    INTERLACE_COMBINED_SCORE_THRESHOLD: 0.25, // Minimum combined interlace score (highDiffRate * periodicityFactor)
    INTERLACE_CROSS_AXIS_MAX: 120,       // Cross-axis size for interlace samples (split axis kept full-res to preserve even/odd periodicity)
    SIMILARITY_DIFFERENCE_THRESHOLD: 0.05, // Similarity difference threshold (<5% is hard to judge)
    PIXEL_DIFF_THRESHOLD: 15,            // Pixel difference threshold (>=15 means high difference)
    // URL parameter limits
    MAX_SHIFT_PX: 500,                   // Maximum plausible stereo shift from URL params (pixels)
    MAX_ROTATION_DEG: 15,                // Maximum roll angle from URL params (deg). Slightly beyond the
                                         // auto-align gate (~10 deg) so exported values are never clipped.
    MAX_ZOOM_PCT: 15,                    // Maximum vertical-zoom difference from URL params (%). Keeps the
                                         // alignTransform m11 = 1 - e comfortably clear of zero (>= 0.85).
    MAX_CROP_RATIO: 0.98                 // Maximum crop trim ratio from URL params (cropX/cropY). Safety bound
                                         // on imported crop windows; keeps (1 - crop) clear of zero. The app's
                                         // own manual-crop guard stays stricter (rejects >= 0.9).
};
