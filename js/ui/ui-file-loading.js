/**
 * ui-file-loading.js
 * Manage UI controls for file loading (single file, left/right images, format selection)
 */
import { state } from '../globals.js';
import { handleFile, loadDualImageFiles, loadFileWithFormat, clearPreviousImageState, restoreUrlDialogFlags } from '../loaders/loader.js';
import { fetchImageAsFile, sanitizeDisplayUrl, isCorsOrNetworkError } from '../loaders/loader-utils.js';
import { showLoadingProgress, hideLoadingProgress } from '../loaders/loader-ui-progress.js';
import { showToast } from './ui-toast.js';
import * as logger from '../utils/logger.js';

/**
 * Pending format file (shared between format dialog and loader)
 * @type {File|null}
 */
export let pendingFormatFile = null;

/**
 * Set pending format file
 * @param {File|null} file - File to set
 */
export function setPendingFormatFile(file) {
    pendingFormatFile = file;
}

/**
 * Output filename field update function (injected from ui.js)
 */
let updateOutputFileNameField = null;

/**
 * Set callback functions
 * @param {Object} callbacks - Callback function object
 */
export function setFileLoadingCallbacks(callbacks) {
    updateOutputFileNameField = callbacks.updateOutputFileNameField;
}

/**
 * Update the status panel filename and the output filename base from a File.
 * Shared by local file loading and URL-based loading so both paths display
 * the filename consistently in the top-right status panel.
 * @param {File} file - Loaded file (file.name is used)
 */
function applyLoadedFileName(file) {
    if (!file) return;

    // File name display
    const nameEl = document.getElementById('infoFileName');
    if (nameEl) {
        nameEl.textContent = file.name;
        nameEl.removeAttribute('data-i18n');  // Remove translation attribute for dynamic text
    }

    // Hide second filename row
    const secondaryRow = document.getElementById('infoFileNameSecondaryRow');
    if (secondaryRow) secondaryRow.style.display = 'none';

    // Base name without extension
    const nameParts = file.name.split('.');
    if (nameParts.length > 1) nameParts.pop();
    state.originalFileNameBase = nameParts.join('.');

    // Update UI
    if (updateOutputFileNameField) updateOutputFileNameField();
}

/**
 * Single file loading handler (shared)
 * @param {File} file - File to load
 */
function loadFile(file) {
    if (!file) return;

    cancelPendingUrlDialogLoad();

    // Note: clearPreviousImageState() is intentionally not called here;
    // handleFile() performs it, so calling it here would double-invoke.

    // File name display / output filename base
    applyLoadedFileName(file);

    // Actual processing (image load)
    // Reset URL dialog flag when loading from local file
    handleFile(file, { loadedFromUrlDialog: false });
}

let fileLoadingControlsInitialized = false;

/**
 * Set up event listeners for file loading
 */
export function setupFileLoadingControls() {
    if (fileLoadingControlsInitialized) return;
    fileLoadingControlsInitialized = true;

    // ===== Single file load (auto-detect) =====
    const fileInputLabel = document.querySelector('label[for="fileInput"]');
    if (fileInputLabel) {
        fileInputLabel.addEventListener('click', () => {
            if (window.navigateToMainMenu) window.navigateToMainMenu();
        });
    }

    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', (e) => {
            const file = e.target?.files?.[0];
            if (file) {
                loadFile(file);
            }
            // Clear value so re-selecting the same file still fires a change event
            e.target.value = '';
        }, false);
    }

    // ===== Single file load (manual selection) =====
    const fileInputManualLabel = document.querySelector('label[for="fileInputManual"]');
    if (fileInputManualLabel) {
        fileInputManualLabel.addEventListener('click', () => {
            if (window.navigateToMainMenu) window.navigateToMainMenu();
        });
    }

    const fileInputManual = document.getElementById('fileInputManual');
    if (fileInputManual) {
        fileInputManual.addEventListener('change', (e) => {
            const file = e.target?.files?.[0];
            if (file) {
                cancelPendingUrlDialogLoad();
                // Do NOT update #infoFileName / originalFileNameBase here. The
                // currently displayed image stays on screen until the user confirms
                // the format, so applying the new name now would strand it pointing
                // at a file that never loads if the dialog is cancelled (wrong export
                // filename). The name is applied on confirm (loadWithFormatBtn).
                if (window.showFormatSelectDialog) {
                    window.showFormatSelectDialog(file);
                }
            }
            // Clear value so re-selecting the same file still fires a change event
            e.target.value = '';
        }, false);
    }
}

let dualImageDialogInitialized = false;

/**
 * Set up left/right image loading dialog
 */
export function setupDualImageDialog() {
    if (dualImageDialogInitialized) return;
    dualImageDialogInitialized = true;

    const openDualImagesBtn = document.getElementById('openDualImagesBtn');
    const dualImageDialog = document.getElementById('dualImageDialog');
    const closeDualDialogBtn = document.getElementById('closeDualDialogBtn');
    const cancelDualBtn = document.getElementById('cancelDualBtn');
    const fileInputLeft = document.getElementById('fileInputLeft');
    const fileInputRight = document.getElementById('fileInputRight');
    const leftFileName = document.getElementById('leftFileName');
    const rightFileName = document.getElementById('rightFileName');
    const loadDualImagesBtn = document.getElementById('loadDualImagesBtn');

    let leftImageFile = null;
    let rightImageFile = null;

    // Update load button enabled state
    function updateDualLoadButtonState() {
        if (loadDualImagesBtn) {
            loadDualImagesBtn.disabled = !(leftImageFile && rightImageFile);
        }
    }

    // Open modal
    if (openDualImagesBtn) {
        openDualImagesBtn.addEventListener('click', () => {
            if (dualImageDialog) {
                dualImageDialog.style.display = 'flex';
            }
            leftImageFile = null;
            rightImageFile = null;
            if (leftFileName) {
                leftFileName.textContent = window.t?.('dialog.dualImages.notSelected') ?? 'Not selected';
            }
            if (rightFileName) {
                rightFileName.textContent = window.t?.('dialog.dualImages.notSelected') ?? 'Not selected';
            }
            if (loadDualImagesBtn) {
                loadDualImagesBtn.disabled = true;
            }
            // Return to main menu
            if (window.navigateToMainMenu) window.navigateToMainMenu();
        });
    }

    // Close modal
    if (closeDualDialogBtn) {
        closeDualDialogBtn.addEventListener('click', () => {
            if (dualImageDialog) {
                dualImageDialog.style.display = 'none';
            }
        });
    }

    if (cancelDualBtn) {
        cancelDualBtn.addEventListener('click', () => {
            if (dualImageDialog) {
                dualImageDialog.style.display = 'none';
            }
        });
    }

    // Select left image
    if (fileInputLeft) {
        fileInputLeft.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                leftImageFile = e.target.files[0];
                if (leftFileName) {
                    leftFileName.textContent = leftImageFile.name;
                }
                updateDualLoadButtonState();
            }
            // Clear value so re-selecting the same file still fires a change event
            e.target.value = '';
        });
    }

    // Select right image
    if (fileInputRight) {
        fileInputRight.addEventListener('change', (e) => {
            if (e.target.files && e.target.files[0]) {
                rightImageFile = e.target.files[0];
                if (rightFileName) {
                    rightFileName.textContent = rightImageFile.name;
                }
                updateDualLoadButtonState();
            }
            // Clear value so re-selecting the same file still fires a change event
            e.target.value = '';
        });
    }

    // Load left/right images
    if (loadDualImagesBtn) {
        loadDualImagesBtn.addEventListener('click', () => {
            if (leftImageFile && rightImageFile) {
                cancelPendingUrlDialogLoad();
                if (dualImageDialog) {
                    dualImageDialog.style.display = 'none';
                }

                // Note: clearPreviousImageState() is intentionally not called here;
                // loadDualImageFiles() performs it, so calling it here would double-invoke.

                loadDualImageFiles(leftImageFile, rightImageFile);
                // Return to main menu (already there, but just in case)
                if (window.navigateToMainMenu) window.navigateToMainMenu();
            }
        });
    }

    // Close by clicking modal backdrop
    if (dualImageDialog) {
        dualImageDialog.addEventListener('click', (e) => {
            if (e.target === dualImageDialog) {
                dualImageDialog.style.display = 'none';
            }
        });
    }
}

let formatSelectDialogInitialized = false;

/**
 * Set up format selection dialog
 */
export function setupFormatSelectDialog() {
    if (formatSelectDialogInitialized) return;
    formatSelectDialogInitialized = true;

    const formatSelectDialog = document.getElementById('formatSelectDialog');
    const closeFormatDialogBtn = document.getElementById('closeFormatDialogBtn');
    const cancelFormatBtn = document.getElementById('cancelFormatBtn');
    const loadWithFormatBtn = document.getElementById('loadWithFormatBtn');

    let pendingFile = null;

    // Close dialog
    if (closeFormatDialogBtn) {
        closeFormatDialogBtn.addEventListener('click', () => {
            if (formatSelectDialog) formatSelectDialog.style.display = 'none';
            pendingFile = null;
            setPendingFormatFile(null);
            hideLoadingProgress();
        });
    }

    if (cancelFormatBtn) {
        cancelFormatBtn.addEventListener('click', () => {
            if (formatSelectDialog) formatSelectDialog.style.display = 'none';
            pendingFile = null;
            setPendingFormatFile(null);
            hideLoadingProgress();
        });
    }

    // Load button
    if (loadWithFormatBtn) {
        loadWithFormatBtn.addEventListener('click', () => {
            const selectedFormat = document.querySelector('input[name="stereoFormat"]:checked');
            // Check pendingFile or fallback global variable
            const fileToLoad = pendingFile || pendingFormatFile;
            if (selectedFormat && fileToLoad) {
                cancelPendingUrlDialogLoad();
                const format = selectedFormat.value;
                if (formatSelectDialog) formatSelectDialog.style.display = 'none';

                // Apply the status-panel filename + output filename base now that the
                // load is confirmed. Deferred from file selection so a cancelled
                // format dialog leaves the previously displayed image's name intact.
                applyLoadedFileName(fileToLoad);

                // Preserve URL dialog flags before clearing state
                const preserveUrlDialogFlags = state.loadedFromUrlDialog;
                const preserveExternalImageUrl = state.externalImageUrl;

                // Clear current image state before loading the selected file
                // Note: loadFileWithFormat() does NOT call clearPreviousImageState()
                // so this call is required here (unlike other load paths).
                clearPreviousImageState();

                // Restore URL dialog flags after clearing
                restoreUrlDialogFlags(preserveUrlDialogFlags, preserveExternalImageUrl, format);

                // Load image with specified format
                // The loader surfaces the user-facing error itself, but rejects so
                // callers that own additional state (external mode) can react. This
                // event handler has no extra state to restore, so consume that
                // already-handled rejection rather than creating an unhandled one.
                void loadFileWithFormat(fileToLoad, format).catch((err) => {
                    logger.debug('UIFileLoading', 'Manual format load failed after loader cleanup:', err);
                });
                pendingFile = null;
                setPendingFormatFile(null);

                // Return to main menu
                if (window.navigateToMainMenu) window.navigateToMainMenu();
            }
        });
    }

    // Close by clicking modal backdrop
    if (formatSelectDialog) {
        formatSelectDialog.addEventListener('click', (e) => {
            if (e.target === formatSelectDialog) {
                formatSelectDialog.style.display = 'none';
                pendingFile = null;
                setPendingFormatFile(null);
                hideLoadingProgress();
            }
        });
    }

    // Expose globally (called from loader.js)
    const showFormatSelectDialog = (file) => {
        pendingFile = file;
        // Hide loading progress so it doesn't overlap the dialog
        hideLoadingProgress();
        if (formatSelectDialog) {
            formatSelectDialog.style.display = 'flex';
        }
    };

    // Initialize namespace
    if (!window.StereoView) {
        window.StereoView = {};
    }
    if (!window.StereoView.ui) {
        window.StereoView.ui = {};
    }

    // Expose in namespace
    window.StereoView.ui.showFormatSelectDialog = showFormatSelectDialog;

    // Expose as a direct global in addition to the namespace
    Object.defineProperty(window, 'showFormatSelectDialog', {
        get: () => window.StereoView.ui.showFormatSelectDialog,
        configurable: true
    });
}

let openUrlDialogInitialized = false;
// Generation token for "Open from URL" loads; bumped per click so a stale or
// failed earlier load cannot overwrite a newer one's state/UI (see loadUrlBtn).
let urlDialogLoadToken = 0;
let urlDialogAbortController = null;

/**
 * A URL fetch must lose ownership as soon as any local load starts. The loader's
 * own token begins only after a File exists, so it cannot protect this network
 * phase by itself. Exported so other local-load entry points that bypass this
 * module (e.g. the drag-and-drop handler in ui-input.js) can invalidate an
 * in-flight "Open from URL" fetch before starting their own load.
 */
export function cancelPendingUrlDialogLoad() {
    urlDialogLoadToken++;
    if (urlDialogAbortController) {
        urlDialogAbortController.abort();
        urlDialogAbortController = null;
    }
}

/**
 * Set up the "Open from URL" dialog
 */
export function setupOpenUrlDialog() {
    if (openUrlDialogInitialized) return;
    openUrlDialogInitialized = true;

    const openUrlBtn = document.getElementById('openUrlBtn');
    const openUrlDialog = document.getElementById('openUrlDialog');
    const closeUrlDialogBtn = document.getElementById('closeUrlDialogBtn');
    const cancelUrlDialogBtn = document.getElementById('cancelUrlDialogBtn');
    const urlInput = document.getElementById('urlInput');
    const urlFormatSelect = document.getElementById('urlFormatSelect');
    const loadUrlBtn = document.getElementById('loadUrlBtn');

    // Update load button state based on URL input
    function updateLoadButtonState() {
        if (loadUrlBtn && urlInput) {
            const value = urlInput.value.trim();
            loadUrlBtn.disabled = !value;
        }
    }

    // Open dialog
    if (openUrlBtn) {
        openUrlBtn.addEventListener('click', () => {
            if (openUrlDialog) {
                openUrlDialog.style.display = 'flex';
            }
            if (urlInput) {
                urlInput.value = '';
            }
            if (urlFormatSelect) {
                urlFormatSelect.value = '';
            }
            if (loadUrlBtn) {
                loadUrlBtn.disabled = true;
            }
            if (window.navigateToMainMenu) window.navigateToMainMenu();
        });
    }

    // URL input change
    if (urlInput) {
        urlInput.addEventListener('input', updateLoadButtonState);
    }

    // Close dialog
    const closeDialog = () => {
        if (openUrlDialog) openUrlDialog.style.display = 'none';
    };

    if (closeUrlDialogBtn) closeUrlDialogBtn.addEventListener('click', closeDialog);
    if (cancelUrlDialogBtn) cancelUrlDialogBtn.addEventListener('click', closeDialog);
    if (openUrlDialog) {
        openUrlDialog.addEventListener('click', (e) => {
            if (e.target === openUrlDialog) closeDialog();
        });
    }

    // Load URL
    if (loadUrlBtn) {
        loadUrlBtn.addEventListener('click', async () => {
            const url = urlInput?.value?.trim();
            if (!url) return;

            // Validate URL
            try {
                const parsedUrl = new URL(url);
                if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                    showToast(window.t?.('messages.invalidUrl') || 'Invalid URL: only HTTP/HTTPS protocols are supported', 'error');
                    return;
                }
            } catch {
                showToast(window.t?.('messages.invalidUrl') || 'Invalid URL format', 'error');
                return;
            }

            closeDialog();

            const format = urlFormatSelect?.value || null;

            // Guard against overlapping URL loads: the dialog closes immediately so
            // a second load can be started while the first fetch is still pending.
            // Only the most recently requested load may proceed past its fetch or
            // touch shared flags/progress UI in the catch, so a slow/failed earlier
            // load cannot clobber a newer one (or win by resolving last).
            cancelPendingUrlDialogLoad();
            const myToken = urlDialogLoadToken;
            const myAbortController = new AbortController();
            urlDialogAbortController = myAbortController;

            // Tracks whether we have already torn down the previously displayed
            // image. A fetch failure happens BEFORE this point, leaving the prior
            // image (and its URL/format flags) live on screen, so the catch must not
            // wipe those flags in that case — doing so would silently break the prior
            // image's share/clipboard export.
            let clearedPreviousImage = false;

            try {
                showLoadingProgress(10);
                const file = await fetchImageAsFile(url, undefined, undefined, myAbortController.signal);
                // A newer URL load superseded this one while fetching — abandon it
                // without resetting state or replacing the newer image.
                if (myToken !== urlDialogLoadToken || myAbortController.signal.aborted) return;
                showLoadingProgress(30);

                // Clear current image state before loading the selected file (will reset state variables)
                clearPreviousImageState();
                clearedPreviousImage = true;

                // File name display / output filename base
                // fetchImageAsFile() derives file.name from the URL path, so the
                // status panel shows the filename just like local file loading.
                applyLoadedFileName(file);

                // Restore URL dialog flags (preserve them through clearPreviousImageState)
                restoreUrlDialogFlags(true, url);

                if (format) {
                    state.currentImageFormat = format;
                    await loadFileWithFormat(file, format);
                } else {
                    // Auto-detect format - pass URL dialog metadata through options
                    await handleFile(file, {
                        loadedFromUrlDialog: true,
                        externalImageUrl: url
                    });
                }
            } catch (err) {
                logger.error('UIFileLoading','[OpenUrl] Failed to load image from URL:', err);

                // A newer URL load has superseded this one — do not touch the
                // in-flight load's progress UI or URL-dialog flags.
                if (myToken !== urlDialogLoadToken || myAbortController.signal.aborted) return;

                hideLoadingProgress();

                // Shared classifier also catches Safari's "Load failed" (err.name
                // === 'TypeError'), which a plain substring check would miss.
                const isCORSError = isCorsOrNetworkError(err);

                const errorMessage = isCORSError
                    ? (window.t?.('messages.corsError') || 'Unable to load the image due to CORS policy.')
                    : (window.t?.('messages.loadFailed') || 'Failed to load image');

                // Image decoding/worker errors were already surfaced by
                // loadFileWithFormat(). Keep this URL-specific toast for fetch
                // failures, but do not stack a duplicate error after decoding.
                if (!err?.__loadFileWithFormatHandled) {
                    showToast(`${errorMessage}\n\nURL: ${sanitizeDisplayUrl(url)}\n\nError: ${err.message}`, 'error', 8000);
                }

                // Reset URL dialog flags on error, but ONLY if we already cleared the
                // previous image. If the fetch failed before clearPreviousImageState()
                // ran, the previous image is still displayed and owns these flags —
                // wiping them would break its share/clipboard export and desync the
                // format-dependent UI. currentImageFormat is reset too so it matches
                // the now-blank canvas when a decode failed after clearing.
                if (clearedPreviousImage) {
                    state.loadedFromUrlDialog = false;
                    state.externalImageUrl = null;
                    state.currentImageFormat = null;
                }
            } finally {
                if (urlDialogAbortController === myAbortController) {
                    urlDialogAbortController = null;
                }
            }
        });
    }
}
