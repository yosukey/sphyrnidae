/**
 * ui-viewer.js
 * UI features for viewer mode
 */
import { state, CONSTANTS } from '../globals.js';
import { is3DTVModeApplicable } from '../mode-utils.js';
import { VALID_STEREO_FORMATS, parseFormatParam, parseModeParam, parseShiftParam, parseRotationParam, parseZoomParam, parseCropParam } from '../url-params.js';
import { isHttpUrl, safeDecodeURIComponent, sanitizeDisplayUrl } from '../loaders/loader-utils.js';
import { startViewerMode, clearPreviousImageState, syncActiveExifState } from '../loaders/loader.js';
import { updateUniforms, updateMeshScaleForMode, fitImageToWindow } from '../rendering/renderer.js';
import { updateExifModalIfVisible } from './ui-exif.js';
import { applySwapLR } from './ui-alignment.js';
import { reset3DTVVirtualWindow } from './ui-crop.js';
import { isFullscreenActive, requestFullscreenCompat, exitFullscreenCompat } from './ui-fullscreen.js';
import * as logger from '../utils/logger.js';

/**
 * Extract a display-friendly filename from a URL
 * @param {string} url - Full URL
 * @returns {string} - Filename or shortened URL
 */
function extractFilenameFromUrl(url) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname;
        const segments = pathname.split('/').filter(s => s.length > 0);
        if (segments.length > 0) {
            // safeDecodeURIComponent so a malformed %-escape yields the raw last
            // segment rather than throwing and falling back to the whole URL.
            return safeDecodeURIComponent(segments[segments.length - 1]);
        }
        return parsed.hostname;
    } catch {
        return url;
    }
}

/**
 * Valid stereo format values for per-URL options.
 * Sourced from the shared url-params module so the single-image ?src parser and
 * this URL-list parser stay in lockstep.
 */
const VALID_FORMATS = new Set(VALID_STEREO_FORMATS);

/**
 * Create a UrlItem object for use in viewerFiles
 * @param {string} url - Image URL
 * @param {Object} [options] - Per-URL options
 * @param {string} [options.format] - Stereo format override
 * @param {number|null} [options.x] - Horizontal shift in pixels
 * @param {number|null} [options.y] - Vertical shift in pixels
 * @param {number|null} [options.rotation] - Alignment roll in degrees
 * @param {number|null} [options.zoom] - Alignment vertical-zoom in percent
 * @param {Object|null} [options.crop] - Normalized crop window {cropX,cropY,offsetX,offsetY}
 * @param {number|null} [options.mode] - Display mode (0-6)
 * @returns {Object} - UrlItem with File-like interface
 */
export function createUrlItem(url, options = {}) {
    const item = {
        name: extractFilenameFromUrl(url),
        _urlSource: url,
        _isUrlItem: true,
        _status: 'pending' // 'pending' | 'loaded' | 'error'
    };

    if (options.format && VALID_FORMATS.has(options.format)) {
        item._format = options.format;
    }
    if (options.x !== undefined && options.x !== null) {
        item._shiftX = options.x;
    }
    if (options.y !== undefined && options.y !== null) {
        item._shiftY = options.y;
    }
    if (options.rotation !== undefined && options.rotation !== null) {
        item._rotation = options.rotation;
    }
    if (options.zoom !== undefined && options.zoom !== null) {
        item._zoom = options.zoom;
    }
    if (options.crop !== undefined && options.crop !== null) {
        item._crop = options.crop;
    }
    if (options.mode !== undefined && options.mode !== null) {
        item._mode = options.mode;
    }

    return item;
}

/**
 * Parse per-URL options from whitespace-separated key=value tokens
 * Format: URL format=value mode=value x=value y=value r=value z=value crop=cx,cy,ox,oy
 * All parameters are optional and can be specified in any order
 * @param {string[]} parts - Array of option strings (e.g., ["format=full_sbs", "mode=parallel", "x=10", "y=-5", "r=2.5", "z=1.8", "crop=0.1,0.05,0,0"])
 * @returns {Object} - Parsed options { format, x, y, rotation, zoom, crop, mode }
 */
function parseUrlOptions(parts) {
    const options = {};

    for (const part of parts) {
        const trimmed = part.trim();
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex < 0) continue;

        const key = trimmed.substring(0, eqIndex).trim().toLowerCase();
        const value = trimmed.substring(eqIndex + 1).trim();

        if (key === 'format') {
            // Shared validator case-normalizes to match the single-URL parser
            // (?format=Half_SBS); an invalid value yields null and is dropped.
            const format = parseFormatParam(value);
            if (format !== null) options.format = format;
        } else if (key === 'x') {
            // Shared validator clamps to ±MAX_SHIFT_PX, matching ?x= behavior.
            const parsed = parseShiftParam(value);
            if (parsed !== null) options.x = parsed.value;
        } else if (key === 'y') {
            const parsed = parseShiftParam(value);
            if (parsed !== null) options.y = parsed.value;
        } else if (key === 'r') {
            // Rotation (roll, degrees); clamped to ±MAX_ROTATION_DEG, matching ?r=.
            const parsed = parseRotationParam(value);
            if (parsed !== null) options.rotation = parsed.value;
        } else if (key === 'z') {
            // Vertical zoom (percent); clamped to ±MAX_ZOOM_PCT, matching ?z=.
            const parsed = parseZoomParam(value);
            if (parsed !== null) options.zoom = parsed.value;
        } else if (key === 'crop') {
            // Crop window cropX,cropY,offsetX,offsetY; clamped, matching ?crop=.
            const parsed = parseCropParam(value);
            if (parsed !== null) options.crop = parsed;
        } else if (key === 'mode') {
            // Only accept mode names (not numeric values)
            const mode = parseModeParam(value);
            if (mode !== null) options.mode = mode;
            // Numeric/invalid mode values are rejected (no fallback)
        }
    }

    return options;
}

/**
 * Parse a URL list text into an array of UrlItems
 * Skips empty lines, comment lines (#), and non-HTTP(S) lines
 * Format: URL format=value mode=value x=value y=value r=value z=value crop=cx,cy,ox,oy
 * All parameters are optional and can be in any order
 * @param {string} text - Text with one URL per line (optionally with whitespace-separated key=value options)
 * @param {number} [maxEntries=Infinity] - Maximum number of URLs to parse (excess lines are ignored)
 * @param {string} [baseUrl] - Base to resolve relative image paths against (the
 *   list file's own URL). When given, a line may use a path relative to where
 *   the list lives, like an HTML document. Omit to require absolute URLs (the
 *   pasted-textarea path, which has no meaningful base).
 * @returns {Object[]} - Array of UrlItems
 */
export function parseUrlList(text, maxEntries = Infinity, baseUrl) {
    if (!text) return [];

    const lines = text.split('\n');
    const items = [];
    const seen = new Set();

    for (const line of lines) {
        // Stop once the entry cap is reached to bound memory/processing for huge lists
        if (items.length >= maxEntries) {
            logger.warn('Viewer', `URL list truncated to ${maxEntries} entries`);
            break;
        }

        const trimmed = line.trim();
        // Skip empty lines and comment lines
        if (!trimmed || trimmed.startsWith('#')) continue;

        // Split by whitespace to extract URL and options
        const parts = trimmed.split(/\s+/);
        const urlPart = parts[0]?.trim();

        if (!urlPart) continue;

        // Resolve against the list file's own URL so a list can reference images
        // by a path relative to where it lives (like an HTML document). An
        // absolute URL ignores the base, so absolute entries are unaffected. With
        // no base (pasted textarea), the value is used as-is and isHttpUrl below
        // rejects any relative form — preserving the absolute-only behavior there.
        let resolvedUrl = urlPart;
        if (baseUrl) {
            try {
                resolvedUrl = new URL(urlPart, baseUrl).href;
            } catch (_) {
                // Leave as-is; isHttpUrl below rejects an unparseable value.
            }
        }

        // Skip duplicates on the whole resolved entry (URL + options), not the URL
        // alone. The same image can legitimately appear more than once with
        // different per-URL options — e.g. comparing two crops or display modes of
        // one source, which is exactly what the clipboard "List Format" export
        // builds. Keying on the URL alone silently dropped those later entries.
        // Keying on the resolved URL also collapses relative/absolute forms of the
        // same target. Options are already whitespace-normalized via `parts`.
        const entryKey = [resolvedUrl, ...parts.slice(1)].join(' ');
        if (seen.has(entryKey)) continue;

        // Parse options from remaining parts
        const options = parts.length > 1 ? parseUrlOptions(parts.slice(1)) : {};

        // Validate URL scheme (http/https only) on the resolved absolute URL.
        if (isHttpUrl(resolvedUrl)) {
            seen.add(entryKey);
            items.push(createUrlItem(resolvedUrl, options));
        } else {
            logger.warn('Viewer', 'Skipping invalid or non-HTTP URL:', urlPart);
        }
    }

    return items;
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {Object} options - Options
 * @param {number} options.duration - Duration in ms (default: 3000)
 * @param {boolean} options.isError - Whether this is an error toast
 */
export function showViewerToast(message, { duration = 3000, isError = false } = {}) {
    // Remove existing toast
    const existing = document.querySelector('.viewer-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `viewer-toast${isError ? ' error' : ''}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
        toast.classList.add('visible');
    });

    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Files selected for viewer mode
let viewerSelectedFiles = [];

// Callback function (set from ui.js)
let callbacks = {
    updateZoomDisplay: null
};

// AbortController for managing event listeners (prevent memory leaks)
let viewerAbortController = null;

// Initialization flag (prevent duplicate registration)
let viewerDialogInitialized = false;
let viewerControlBarInitialized = false;
let viewerFileListModalInitialized = false;

/**
 * Clean up viewer module resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (delete is idempotent, array reset is safe)
 */
export function cleanupViewerUI() {
    // Abort all event listeners
    if (viewerAbortController) {
        viewerAbortController.abort();
        viewerAbortController = null;
    }

    // Reset initialization flag (allow re-init)
    viewerDialogInitialized = false;
    viewerControlBarInitialized = false;
    viewerFileListModalInitialized = false;

    // Clear the direct-global references (kept alongside the namespace)
    delete window.showViewerFileList;
    delete window.updateViewerNavigationButtons;
    // Clear functions in the namespace too
    if (window.StereoView && window.StereoView.viewerUI) {
        delete window.StereoView.viewerUI;
    }

    // Clear selected files
    viewerSelectedFiles = [];
}

/**
 * Set callback function
 */
export function setViewerCallbacks(cbs) {
    callbacks = { ...callbacks, ...cbs };
}

/**
 * Recursively gather files for viewer mode folder selection
 */
async function getFilesFromFolder(folderFileList) {
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.mpo', '.jps', '.gif', '.webp', '.bmp', '.tiff', '.tif'];
    const files = [];

    for (const file of folderFileList) {
        const ext = file.name.toLowerCase().match(/\.[^.]*$/)?.[0] || '';
        if (allowedExtensions.includes(ext)) {
            files.push(file);
        }
    }

    return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Set up the viewer mode dialog
 * Called from setupEventListeners
 */
export function setupViewerModeDialog() {
    // Prevent duplicate initialization
    if (viewerDialogInitialized) {
        logger.warn('Viewer', 'setupViewerModeDialog() called multiple times. Skipping duplicate registration.');
        return;
    }
    viewerDialogInitialized = true;

    // Initialize AbortController if not already created
    if (!viewerAbortController) {
        viewerAbortController = new AbortController();
    }
    const signal = viewerAbortController.signal;

    const openViewerModeBtn = document.getElementById('openViewerModeBtn');
    const viewerModeDialog = document.getElementById('viewerModeDialog');
    const closeViewerDialogBtn = document.getElementById('closeViewerDialogBtn');
    const cancelViewerDialogBtn = document.getElementById('cancelViewerDialogBtn');
    const viewerFileInput = document.getElementById('viewerFileInput');
    const viewerFolderInput = document.getElementById('viewerFolderInput');
    const startViewerBtn = document.getElementById('startViewerBtn');
    const viewerUrlList = document.getElementById('viewerUrlList');
    const viewerLoadUrlListBtn = document.getElementById('viewerLoadUrlListBtn');
    const viewerUrlListFileInput = document.getElementById('viewerUrlListFileInput');
    const viewerSelectedInfo = document.getElementById('viewerSelectedInfo');

    // Update start button enable/disable and info display
    function updateViewerStartButtonState() {
        if (startViewerBtn) {
            startViewerBtn.disabled = viewerSelectedFiles.length === 0;
        }
        // Update selected info
        if (viewerSelectedInfo) {
            if (viewerSelectedFiles.length > 0) {
                const localCount = viewerSelectedFiles.filter(f => !f._isUrlItem).length;
                const urlCount = viewerSelectedFiles.filter(f => f._isUrlItem).length;
                const parts = [];
                if (localCount > 0) {
                    parts.push(
                        window.t?.('viewer.fileCount', { count: localCount })
                            ?? `${localCount} file${localCount > 1 ? 's' : ''}`
                    );
                }
                if (urlCount > 0) {
                    parts.push(
                        window.t?.('viewer.urlCount', { count: urlCount })
                            ?? `${urlCount} URL${urlCount > 1 ? 's' : ''}`
                    );
                }
                viewerSelectedInfo.textContent = parts.join(' + ');
                viewerSelectedInfo.style.display = 'block';
            } else {
                viewerSelectedInfo.style.display = 'none';
            }
        }
    }

    // Viewer mode button click
    if (openViewerModeBtn) {
        openViewerModeBtn.addEventListener('click', () => {
            if (viewerModeDialog) {
                viewerModeDialog.style.display = 'flex';
            }
            viewerSelectedFiles = [];
            if (startViewerBtn) {
                startViewerBtn.disabled = true;
            }
            if (viewerUrlList) viewerUrlList.value = '';
            if (viewerSelectedInfo) viewerSelectedInfo.style.display = 'none';
            // Return to main menu
            if (window.navigateToMainMenu) window.navigateToMainMenu();
        }, { signal });
    }

    // Close dialog
    if (closeViewerDialogBtn) {
        closeViewerDialogBtn.addEventListener('click', () => {
            if (viewerModeDialog) {
                viewerModeDialog.style.display = 'none';
            }
        }, { signal });
    }

    if (cancelViewerDialogBtn) {
        cancelViewerDialogBtn.addEventListener('click', () => {
            if (viewerModeDialog) {
                viewerModeDialog.style.display = 'none';
            }
        }, { signal });
    }

    // File selection (card)
    const viewerFileSelectCard = document.getElementById('viewerFileSelectCard');
    if (viewerFileSelectCard && viewerFileInput) {
        viewerFileSelectCard.addEventListener('click', () => {
            viewerFileInput.click();
        }, { signal });
    }

    // Folder selection (card)
    const viewerFolderSelectCard = document.getElementById('viewerFolderSelectCard');
    if (viewerFolderSelectCard && viewerFolderInput) {
        viewerFolderSelectCard.addEventListener('click', () => {
            viewerFolderInput.click();
        }, { signal });
    }

    // Drag and drop area
    const viewerDragDropArea = document.getElementById('viewerDragDropArea');
    const viewerDragDropInput = document.getElementById('viewerDragDropInput');
    if (viewerDragDropArea) {
        viewerDragDropArea.addEventListener('click', () => {
            if (viewerDragDropInput) viewerDragDropInput.click();
        }, { signal });

        // Drag and drop event handlers
        viewerDragDropArea.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            viewerDragDropArea.style.backgroundColor = 'rgba(33, 150, 243, 0.1)';
        }, { signal });

        viewerDragDropArea.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            viewerDragDropArea.style.backgroundColor = '';
        }, { signal });

        viewerDragDropArea.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            viewerDragDropArea.style.backgroundColor = '';
            // stopPropagation() above keeps this drop from reaching the window handler
            // that clears the page-wide drag highlight and resets its depth counter, so
            // resync that shared state explicitly (otherwise the highlight sticks).
            window.dispatchEvent(new CustomEvent('drag-state-reset'));
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                const localFiles = await getFilesFromFolder(e.dataTransfer.files);
                // Preserve URL items from textarea
                const urlItems = viewerSelectedFiles.filter(f => f._isUrlItem);
                viewerSelectedFiles = [...localFiles, ...urlItems];
                updateViewerStartButtonState();
            }
        }, { signal });
    }

    if (viewerDragDropInput) {
        viewerDragDropInput.addEventListener('change', async (e) => {
            const input = e.target;
            if (input.files && input.files.length > 0) {
                const localFiles = await getFilesFromFolder(input.files);
                // Preserve URL items from textarea
                const urlItems = viewerSelectedFiles.filter(f => f._isUrlItem);
                viewerSelectedFiles = [...localFiles, ...urlItems];
                updateViewerStartButtonState();
            }
            // Clear value so re-selecting the same files/folder fires change again
            input.value = '';
        }, { signal });
    }

    // Select files from the file selection dialog
    if (viewerFileInput) {
        viewerFileInput.addEventListener('change', async (e) => {
            const input = e.target;
            if (input.files && input.files.length > 0) {
                const localFiles = await getFilesFromFolder(input.files);
                // Preserve URL items from textarea
                const urlItems = viewerSelectedFiles.filter(f => f._isUrlItem);
                viewerSelectedFiles = [...localFiles, ...urlItems];
                updateViewerStartButtonState();
            }
            // Clear value so re-selecting the same files/folder fires change again
            input.value = '';
        }, { signal });
    }

    // Select folder from the folder selection dialog
    if (viewerFolderInput) {
        viewerFolderInput.addEventListener('change', async (e) => {
            const input = e.target;
            if (input.files && input.files.length > 0) {
                const localFiles = await getFilesFromFolder(input.files);
                // Preserve URL items from textarea
                const urlItems = viewerSelectedFiles.filter(f => f._isUrlItem);
                viewerSelectedFiles = [...localFiles, ...urlItems];
                updateViewerStartButtonState();
            }
            // Clear value so re-selecting the same files/folder fires change again
            input.value = '';
        }, { signal });
    }

    // URL textarea input - parse URLs and update selection
    if (viewerUrlList) {
        viewerUrlList.addEventListener('input', () => {
            // When URL textarea has content, combine with any file selection
            collectAllSources();
        }, { signal });
    }

    // URL list file loading
    if (viewerLoadUrlListBtn && viewerUrlListFileInput) {
        viewerLoadUrlListBtn.addEventListener('click', () => {
            viewerUrlListFileInput.click();
        }, { signal });

        viewerUrlListFileInput.addEventListener('change', (e) => {
            const file = e.target?.files?.[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                const text = event.target.result;
                if (viewerUrlList) {
                    // Append to existing content
                    const existing = viewerUrlList.value.trim();
                    viewerUrlList.value = existing ? existing + '\n' + text : text;
                }
                collectAllSources();
            };
            reader.onerror = () => {
                // Without this the read failure (deleted file, permission error)
                // would be a silent no-op with no feedback to the user.
                logger.warn('Viewer', 'Failed to read URL list file:', reader.error);
                showViewerToast(
                    window.t?.('messages.fileReadError') ?? 'Failed to read the file. Please try again.',
                    { isError: true }
                );
            };
            reader.readAsText(file);
            // Reset input so the same file can be loaded again
            viewerUrlListFileInput.value = '';
        }, { signal });
    }

    // Collect sources from all inputs (file selection + URL textarea)
    function collectAllSources() {
        // Start with existing file selections (local files only)
        const localFiles = viewerSelectedFiles.filter(f => !f._isUrlItem);

        // Parse URLs from textarea (capped to the same entry limit as remote lists)
        const urlText = viewerUrlList?.value || '';
        const urlItems = parseUrlList(urlText, CONSTANTS.URL_LIST_MAX_ENTRIES);

        // Combine: local files first, then URL items
        viewerSelectedFiles = [...localFiles, ...urlItems];
        updateViewerStartButtonState();
    }

    // Start viewer
    if (startViewerBtn) {
        startViewerBtn.addEventListener('click', () => {
            // Collect URLs from textarea before starting
            collectAllSources();

            if (viewerSelectedFiles.length > 0) {
                if (viewerModeDialog) {
                    viewerModeDialog.style.display = 'none';
                }

                // Clear current image state before loading the selected file
                clearPreviousImageState();

                // Start viewer mode
                startViewerMode(viewerSelectedFiles);
            }
        }, { signal });
    }

    // Close by clicking the dialog backdrop
    if (viewerModeDialog) {
        viewerModeDialog.addEventListener('click', (e) => {
            if (e.target === viewerModeDialog) {
                viewerModeDialog.style.display = 'none';
            }
        }, { signal });
    }
}

function setTemporaryViewerButtonActive(button, durationMs = 180) {
    if (!button) return;
    button.classList.add('active');
    window.setTimeout(() => {
        button.classList.remove('active');
    }, durationMs);
}

/**
 * Update viewer exit button visibility based on how viewer mode was started
 * - Hide exit button if started from external URL or URL dialog (no normal mode to return to)
 * - Show exit button if started from normal app menu (can return to normal mode)
 */
export function updateViewerExitButtonVisibility() {
    const viewerExitBtn = document.getElementById('viewerExitBtn');
    if (!viewerExitBtn) return;

    const urlParams = new URLSearchParams(window.location.search);
    const startedDirectlyFromUrlParams = urlParams.has('src') || urlParams.has('list');

    // Hide exit button if:
    // 1. Started from URL parameters (externalImageMode = true)
    // 2. Started from URL dialog in viewer mode (loadedFromUrlDialog = true + viewerMode = true)
    // In both cases, there's no normal mode to return to
    const loadedFromUrl = state.externalImageMode
        || state.loadedFromUrlParams
        || startedDirectlyFromUrlParams
        || (state.loadedFromUrlDialog && state.viewerMode);

    if (loadedFromUrl) {
        // Started from URL - hide exit button (no normal mode to return to)
        viewerExitBtn.style.display = 'none';
    } else {
        // Started from app menu - show exit button (can return to normal mode)
        viewerExitBtn.style.display = '';
    }
}

/**
 * Apply a display mode in viewer context, running the same side effects as the
 * viewer control bar's mode dropdown (3DTV handling, mesh rescale, fit, and
 * dropdown sync). Shared by that dropdown and the per-URL `mode` option so both
 * behave identically, instead of a bare updateParamValue('mode', ...) which only
 * sets the uniform and skips mesh rescaling / fit / 3DTV handling.
 * @param {number} mode - Display mode
 */
export function applyViewerDisplayMode(mode) {
    if (!Number.isInteger(mode)) return;
    state.params.mode = mode;

    // Remember the chosen mode so it survives navigation (clearPreviousImageState
    // resets state.params.mode to the default on every load). Only persist while
    // actually in viewer mode; this function is also used by the dropdown outside
    // viewer mode where the value should not become the viewer default.
    if (state.viewerMode) {
        state.viewerDisplayMode = mode;
    }

    // Sync the viewer's mode dropdown so the UI reflects the applied mode
    const viewerDisplayMode = document.getElementById('viewerDisplayMode');
    if (viewerDisplayMode && viewerDisplayMode.value !== String(mode)) {
        viewerDisplayMode.value = String(mode);
    }

    const sbs3dtvCheckbox = document.getElementById('sbs3dtv');

    // In viewer mode, Half SBS/parallel/cross/Half TaB/Full TaB always enable 3DTV mode.
    if (state.viewerMode && is3DTVModeApplicable(mode)) {
        if (!state.params.sbs3dtv) {
            state.pre3DTVScale = state.params.scale;
        }
        state.params.sbs3dtv = true;
        if (sbs3dtvCheckbox) {
            sbs3dtvCheckbox.checked = true;
        }
        // Handling when 3DTV mode is on
        state.viewerScale = 1.0;
        state.viewerPanX = 0;
        state.viewerPanY = 0;
        state.params.panX = 0;
        state.params.panY = 0;
        // Sync the #scale slider to 1.0 as well: in 3DTV mode this slider drives
        // viewerScale (ui-parameters.js), so leaving it at the pre-3DTV value made
        // the first slider nudge jump the zoom from 1.0 to the stale value. Mirrors
        // the checkbox path in ui-alignment.js, which already performs this sync.
        const scaleInput3dtv = document.getElementById('scale');
        if (scaleInput3dtv) scaleInput3dtv.value = 1.0;
    } else if (!is3DTVModeApplicable(mode) && state.params.sbs3dtv) {
        // Viewer mode changes bypass ui-mode.js, so perform the same complete
        // teardown here. Leaving the stale flag set would make a later return to
        // SBS restore an old scale over adjustments made in the interim mode.
        state.params.sbs3dtv = false;
        if (sbs3dtvCheckbox) sbs3dtvCheckbox.checked = false;
        if (Number.isFinite(state.pre3DTVScale)) {
            state.params.scale = state.pre3DTVScale;
            state.pre3DTVScale = null;
            const scaleInput = document.getElementById('scale');
            if (scaleInput) scaleInput.value = state.params.scale;
        }
        reset3DTVVirtualWindow();
    }

    updateUniforms();
    updateMeshScaleForMode();

    // In viewer mode, fit to window
    if (state.viewerMode) {
        fitImageToWindow();
    }
}

/**
 * Apply an absolute swap-L/R state in viewer context: set the param, sync the
 * viewer swap button visual and the EXIF eye selection, and refresh uniforms.
 * Unlike the swap button/key handlers this does NOT invert the shift signs,
 * because it sets the state absolutely (used to re-apply the remembered swap to a
 * freshly loaded image whose shifts start from their per-image/default values).
 * @param {boolean} swap - Desired swapLR state
 */
export function applyViewerSwapState(swap) {
    state.params.swapLR = !!swap;

    const viewerSwapLRBtn = document.getElementById('viewerSwapLRBtn');
    if (viewerSwapLRBtn) {
        if (state.params.swapLR) {
            viewerSwapLRBtn.style.backgroundColor = 'var(--accent-color, #4a9eff)';
            viewerSwapLRBtn.style.color = 'white';
        } else {
            viewerSwapLRBtn.style.backgroundColor = '';
            viewerSwapLRBtn.style.color = '';
        }
        // Expose toggle state to assistive tech (the color alone is invisible to AT).
        viewerSwapLRBtn.setAttribute('aria-pressed', String(state.params.swapLR));
    }

    updateUniforms();
    // Keep the EXIF panel showing the eye that matches the new swap state.
    syncActiveExifState();
    updateExifModalIfVisible();
}

/**
 * Set up the viewer mode control bar
 * Called from setupInputHandlers
 */
export function setupViewerControlBar() {
    // Prevent duplicate initialization
    if (viewerControlBarInitialized) {
        logger.warn('Viewer', 'setupViewerControlBar() called multiple times. Skipping duplicate registration.');
        return;
    }
    viewerControlBarInitialized = true;

    // Initialize AbortController if not already created
    if (!viewerAbortController) {
        viewerAbortController = new AbortController();
    }
    const signal = viewerAbortController.signal;

    const viewerPrevBtn = document.getElementById('viewerPrevBtn');
    const viewerNextBtn = document.getElementById('viewerNextBtn');
    const viewerListBtn = document.getElementById('viewerListBtn');
    const viewerFullscreenBtn = document.getElementById('viewerFullscreenBtn');
    const viewerExitBtn = document.getElementById('viewerExitBtn');
    const viewerDisplayMode = document.getElementById('viewerDisplayMode');
    const viewerSlideshowSpeed = document.getElementById('viewerSlideshowSpeed');

    // Previous button
    if (viewerPrevBtn) {
        viewerPrevBtn.addEventListener('click', () => {
            window.viewerPrevImage?.();
        }, { signal });
    }

    // Next button
    if (viewerNextBtn) {
        viewerNextBtn.addEventListener('click', () => {
            window.viewerNextImage?.();
        }, { signal });
    }

    // Loop button
    const viewerLoopBtn = document.getElementById('viewerLoopBtn');
    if (viewerLoopBtn) {
        viewerLoopBtn.addEventListener('click', () => {
            state.viewerLoopMode = !state.viewerLoopMode;
            // Update button appearance
            if (state.viewerLoopMode) {
                viewerLoopBtn.classList.add('active');
            } else {
                viewerLoopBtn.classList.remove('active');
            }
            // Update navigation button state
            window.updateViewerNavigationButtons?.();
        }, { signal });
    }

    // List button
    if (viewerListBtn) {
        viewerListBtn.addEventListener('click', () => {
            window.showViewerFileList?.();
        }, { signal });
    }

    // Fullscreen button
    if (viewerFullscreenBtn) {
        viewerFullscreenBtn.addEventListener('click', () => {
            setTemporaryViewerButtonActive(viewerFullscreenBtn, 250);
            if (!isFullscreenActive()) {
                // In viewer mode, fullscreen document.documentElement
                // This keeps the viewer-mode-bar visible in fullscreen.
                // Use the prefixed-fallback helper so WebKit-only browsers don't no-op.
                requestFullscreenCompat(document.documentElement);
            } else {
                exitFullscreenCompat();
            }
        }, { signal });

        // Register the prefixed change events too, so the button's active state is
        // cleared on exit even on WebKit-prefixed-only browsers (the unprefixed-only
        // listener never fired there, leaving the button stuck in the active state).
        const onViewerFullscreenChange = () => {
            viewerFullscreenBtn.classList.remove('active');
        };
        document.addEventListener('fullscreenchange', onViewerFullscreenChange, { signal });
        document.addEventListener('webkitfullscreenchange', onViewerFullscreenChange, { signal });
        document.addEventListener('mozfullscreenchange', onViewerFullscreenChange, { signal });
    }

    // Exit button
    if (viewerExitBtn) {
        // Update visibility based on how viewer mode was started
        updateViewerExitButtonVisibility();

        viewerExitBtn.addEventListener('click', () => {
            window.exitViewerMode?.();
        }, { signal });
    }

    // Help button
    const viewerHelpBtn = document.getElementById('viewerHelpBtn');
    const viewerHelpModal = document.getElementById('viewerHelpModal');
    const closeViewerHelpModalBtn = document.getElementById('closeViewerHelpModalBtn');

    if (viewerHelpBtn && viewerHelpModal) {
        viewerHelpBtn.addEventListener('click', () => {
            viewerHelpModal.style.display = 'flex';
        }, { signal });
    }

    if (closeViewerHelpModalBtn && viewerHelpModal) {
        closeViewerHelpModalBtn.addEventListener('click', () => {
            viewerHelpModal.style.display = 'none';
        }, { signal });
    }

    // Close help modal by clicking the modal backdrop
    if (viewerHelpModal) {
        viewerHelpModal.addEventListener('click', (e) => {
            if (e.target === viewerHelpModal) {
                viewerHelpModal.style.display = 'none';
            }
        }, { signal });
    }

    // Display mode switch
    if (viewerDisplayMode) {
        viewerDisplayMode.addEventListener('change', (e) => {
            const mode = parseInt(e.target.value, 10);
            if (Number.isNaN(mode)) return;

            applyViewerDisplayMode(mode);

            // Outside viewer mode, update the zoom readout (applyViewerDisplayMode
            // only fits to window while in viewer mode)
            if (!state.viewerMode && callbacks.updateZoomDisplay) {
                callbacks.updateZoomDisplay();
            }
        }, { signal });
    }

    // Swap left/right button
    const viewerSwapLRBtn = document.getElementById('viewerSwapLRBtn');
    if (viewerSwapLRBtn) {
        viewerSwapLRBtn.addEventListener('click', () => {
            // Route through the shared swap helper so the viewer button, the
            // checkbox, and the keyboard 'S' shortcut perform identical state +
            // UI updates (shift sign, px readout, histogram, checkbox sync,
            // EXIF). Without this the viewer-bar px readout kept its pre-swap sign.
            applySwapLR(!state.params.swapLR);
            // Remember the swap state so it survives navigation (clearPreviousImageState
            // resets it to the default on every load).
            state.viewerSwapLR = state.params.swapLR;
            // Update button appearance (active state)
            if (state.params.swapLR) {
                viewerSwapLRBtn.style.backgroundColor = 'var(--accent-color, #4a9eff)';
                viewerSwapLRBtn.style.color = 'white';
            } else {
                viewerSwapLRBtn.style.backgroundColor = '';
                viewerSwapLRBtn.style.color = '';
            }
            viewerSwapLRBtn.setAttribute('aria-pressed', String(state.params.swapLR));
        }, { signal });
    }

    // Fit button
    const viewerFitBtn = document.getElementById('viewerFitBtn');
    if (viewerFitBtn) {
        viewerFitBtn.addEventListener('click', () => {
            setTemporaryViewerButtonActive(viewerFitBtn);
            fitImageToWindow();
        }, { signal });
    }

    // Change slideshow speed
    if (viewerSlideshowSpeed) {
        viewerSlideshowSpeed.addEventListener('change', (e) => {
            const speed = parseInt(e.target.value, 10);
            if (Number.isNaN(speed)) return;
            window.setViewerSlideshowSpeed?.(speed);
        }, { signal });
    }

    // Function to update navigation button state
    const updateViewerNavigationButtons = function() {
        if (!state.viewerMode) return;

        const viewerPrevBtn = document.getElementById('viewerPrevBtn');
        const viewerNextBtn = document.getElementById('viewerNextBtn');
        const viewerLoopBtn = document.getElementById('viewerLoopBtn');
        const viewerListBtn = document.getElementById('viewerListBtn');
        const viewerSlideshowSpeed = document.getElementById('viewerSlideshowSpeed');

        if (!viewerPrevBtn || !viewerNextBtn) return;

        const fileCount = state.viewerFiles.length;
        const currentIndex = state.viewerCurrentIndex;
        const loopMode = state.viewerLoopMode;

        // If only one file, hide all navigation buttons, list, and slideshow
        if (fileCount <= 1) {
            viewerPrevBtn.style.display = 'none';
            viewerNextBtn.style.display = 'none';
            // Also disable them: they are hidden, but the N/P keyboard shortcuts only
            // check .disabled, and a prior multi-file session leaves them enabled — so
            // without this, N would reload the same single image (index (0+1) % 1 = 0).
            viewerPrevBtn.disabled = true;
            viewerNextBtn.disabled = true;
            if (viewerLoopBtn) {
                viewerLoopBtn.style.display = 'none';
            }
            if (viewerListBtn) {
                viewerListBtn.style.display = 'none';
            }
            if (viewerSlideshowSpeed) {
                viewerSlideshowSpeed.style.display = 'none';
            }
            return;
        }

        // If two or more files, show all navigation buttons
        viewerPrevBtn.style.display = '';
        viewerNextBtn.style.display = '';
        if (viewerListBtn) {
            viewerListBtn.style.display = '';
        }

        // If two or more files, enable the loop button and slideshow
        if (viewerLoopBtn) {
            viewerLoopBtn.style.display = '';
            viewerLoopBtn.disabled = false;
        }
        if (viewerSlideshowSpeed) {
            viewerSlideshowSpeed.style.display = '';
        }

        // When loop mode is off
        if (!loopMode) {
            // Disable the previous button on the first image
            viewerPrevBtn.disabled = (currentIndex <= 0);
            // If the last image, disable the next button
            viewerNextBtn.disabled = (currentIndex >= fileCount - 1);
        } else {
            // When loop mode is on, enable all buttons
            viewerPrevBtn.disabled = false;
            viewerNextBtn.disabled = false;
        }
    };

    // Initialize and export the namespace
    if (!window.StereoView) {
        window.StereoView = {};
    }
    if (!window.StereoView.viewerUI) {
        window.StereoView.viewerUI = {};
    }
    window.StereoView.viewerUI.updateNavigationButtons = updateViewerNavigationButtons;

    // Expose as a direct global in addition to the namespace
    Object.defineProperty(window, 'updateViewerNavigationButtons', {
        get: () => window.StereoView.viewerUI.updateNavigationButtons,
        configurable: true
    });
}

/**
 * Set up the file list modal
 * Called from setupInputHandlers
 */
export function setupViewerFileListModal() {
    // Prevent duplicate initialization
    if (viewerFileListModalInitialized) {
        logger.warn('Viewer', 'setupViewerFileListModal() called multiple times. Skipping duplicate registration.');
        return;
    }
    viewerFileListModalInitialized = true;

    // Initialize AbortController if not already created
    if (!viewerAbortController) {
        viewerAbortController = new AbortController();
    }
    const signal = viewerAbortController.signal;

    const viewerListModal = document.getElementById('viewerListModal');
    const closeViewerListModalBtn = document.getElementById('closeViewerListModalBtn');

    // File list render function
    const showViewerFileList = function() {
        if (!state.viewerMode || !state.viewerFiles || state.viewerFiles.length === 0) {
            return;
        }

        if (!viewerListModal) return;

        const container = document.getElementById('viewerFileListContainer');
        if (!container) return;

        // Clear the list
        container.innerHTML = '';

        // Build the file list
        const listDiv = document.createElement('div');
        listDiv.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

        state.viewerFiles.forEach((file, index) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'viewer-file-list-item';

            const isCurrent = index === state.viewerCurrentIndex;
            const isError = file._isUrlItem && file._status === 'error';

            if (isCurrent) {
                itemDiv.classList.add('viewer-file-list-item--current');
            } else if (isError) {
                itemDiv.classList.add('viewer-file-list-item--error');
            }

            itemDiv.textContent = `${index + 1}. ${file.name}`;

            // Tooltip: show sanitized URL + options for URL items, filename for local files.
            // Strip the query string (sanitizeDisplayUrl) so signed-URL signatures, API
            // tokens or personal query params in a URL-list entry are not exposed via the
            // title attribute (screen sharing, screenshots, accessibility readouts). This
            // matches how error toasts and logs already display these URLs.
            if (file._isUrlItem) {
                let tooltip = sanitizeDisplayUrl(file._urlSource);
                const opts = [];
                if (file._format) opts.push(`format=${file._format}`);
                if (file._shiftX !== undefined) opts.push(`x=${file._shiftX}`);
                if (file._shiftY !== undefined) opts.push(`y=${file._shiftY}`);
                if (file._rotation !== undefined) opts.push(`r=${file._rotation}`);
                if (file._zoom !== undefined) opts.push(`z=${file._zoom}`);
                if (file._crop !== undefined) opts.push(`crop=${file._crop.cropX},${file._crop.cropY},${file._crop.offsetX},${file._crop.offsetY}`);
                if (opts.length > 0) tooltip += ` (${opts.join(', ')})`;
                itemDiv.title = tooltip;
            } else {
                itemDiv.title = file.name;
            }

            // No AbortSignal here: these per-item nodes are discarded each time the
            // list is rebuilt (container.innerHTML = '' above), so their listeners are
            // GC'd with the nodes. Using the page-lifetime viewerAbortController would
            // retain every removed item until unload (leak of up to 1000 nodes).
            itemDiv.addEventListener('click', async () => {
                if (index !== state.viewerCurrentIndex) {
                    await window.loadViewerImage?.(index);
                }
                if (viewerListModal) {
                    viewerListModal.style.display = 'none';
                }
            });

            listDiv.appendChild(itemDiv);
        });

        container.appendChild(listDiv);

        // Show the modal
        if (viewerListModal) {
            viewerListModal.style.display = 'flex';
        }
    };

    // Initialize and export the namespace
    if (!window.StereoView) {
        window.StereoView = {};
    }
    if (!window.StereoView.viewerUI) {
        window.StereoView.viewerUI = {};
    }
    window.StereoView.viewerUI.showFileList = showViewerFileList;

    // Expose as a direct global in addition to the namespace
    Object.defineProperty(window, 'showViewerFileList', {
        get: () => window.StereoView.viewerUI.showFileList,
        configurable: true
    });

    // Close the file list modal
    if (closeViewerListModalBtn) {
        closeViewerListModalBtn.addEventListener('click', () => {
            if (viewerListModal) {
                viewerListModal.style.display = 'none';
            }
        }, { signal });
    }

    // Close by clicking the modal backdrop
    if (viewerListModal) {
        viewerListModal.addEventListener('click', (e) => {
            if (e.target === viewerListModal) {
                viewerListModal.style.display = 'none';
            }
        }, { signal });
    }
}
