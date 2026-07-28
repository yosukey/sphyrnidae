/**
 * loader-pixel-validation.js
 * Pixel validation and dialog display during image loading
 */

import { validatePixelsForFormat, trimToEvenPixels } from '../utils/pixel-utils.js';
import * as logger from '../utils/logger.js';

/**
 * Validation dialog options
 * @typedef {'trim'|'cancel'} ValidationAction
 */

/**
 * Resolution-mismatch dialog options
 * @typedef {'scale'|'trim'|'cancel'} MismatchAction
 */

let isDialogDisplaying = false;
const dialogQueue = [];
const DIALOG_TIMEOUT_MS = 30000;  // 30 second timeout for dialog display
const DIALOG_QUEUE_MAX = 5;       // Maximum queued dialogs; excess are rejected immediately

// Track the currently-displayed dialog's cleanup function
// so clearDialogQueue can dismiss it and remove its event listeners
let activeDialogCleanup = null;

/**
 * Build an error marking a dialog that was never answered, as opposed to a
 * genuine processing failure. Callers check err.dialogTimeout so they can
 * report the real reason instead of a generic "processing failed" message.
 * @param {string} message - Error message
 * @returns {Error}
 * @private
 */
function dialogTimeoutError(message) {
    const err = new Error(message);
    err.dialogTimeout = true;
    return err;
}

/**
 * Clear all pending dialogs in the queue
 * Also dismiss the currently-displayed dialog to prevent listener accumulation
 * Useful when a new file load operation starts
 * @export
 */
export function clearDialogQueue() {
    // Dismiss the currently-displayed dialog and remove its event listeners
    if (activeDialogCleanup) {
        try {
            activeDialogCleanup();
        } catch (err) {
            logger.warn('PixelValidation','[PixelValidation] Error cleaning up active dialog:', err);
        }
        activeDialogCleanup = null;
    }

    // Reject all queued dialogs with cancellation error
    while (dialogQueue.length > 0) {
        const { reject } = dialogQueue.shift();
        reject(new Error('Dialog cancelled due to new file load'));
    }
}

/**
 * Process queued dialog requests sequentially (FIFO)
 * Ensures only one dialog is shown at a time with timeout protection
 * @private
 */
async function processDialogQueue() {
    if (isDialogDisplaying || dialogQueue.length === 0) {
        return;
    }

    isDialogDisplaying = true;
    const { resolve, reject, showFn, abortSignal } = dialogQueue.shift();

    let dialogTimeoutId = null;
    try {
        // Check if operation was aborted before showing dialog.
        // Must be inside try block so that finally always resets isDialogDisplaying.
        if (abortSignal && abortSignal.aborted) {
            throw new Error('Dialog cancelled before display');
        }
        // Set timeout for dialog display (prevent infinite wait)
        const timeoutPromise = new Promise((_, rejectTimeout) => {
            dialogTimeoutId = setTimeout(() => {
                rejectTimeout(dialogTimeoutError('Dialog display timeout - user did not respond'));
            }, DIALOG_TIMEOUT_MS);
        });

        // Race between showFn and timeout
        const result = await Promise.race([
            showFn(),
            timeoutPromise
        ]);
        // Clear timeout when showFn resolves first (prevent unhandled rejection)
        clearTimeout(dialogTimeoutId);
        resolve(result);
    } catch (err) {
        // Clear timeout in case showFn rejected (not the timeout itself)
        clearTimeout(dialogTimeoutId);
        // On timeout or error, clean up the active dialog's DOM and listeners
        if (activeDialogCleanup) {
            try {
                activeDialogCleanup();
            } catch (cleanupErr) {
                logger.warn('PixelValidation','[PixelValidation] Error cleaning up dialog on timeout:', cleanupErr);
            }
            activeDialogCleanup = null;
        }
        // Handle both timeout errors and showFn errors
        logger.warn('PixelValidation','[PixelValidation] Dialog error:', err.message);
        reject(err);
    } finally {
        activeDialogCleanup = null;
        isDialogDisplaying = false;
        // Process next queued dialog if any (immediately, without delay)
        if (dialogQueue.length > 0) {
            // Use microtask queue to ensure synchronous order while allowing DOM updates
            Promise.resolve().then(() => {
                processDialogQueue();
            });
        }
    }
}

/**
 * Show the pixel validation dialog
 * @param {Object[]} issues - List of detected issues
 * @param {Object} correction - Recommended corrections { trimRight, trimBottom }
 * @param {string} format - Image format
 * @param {AbortSignal} [abortSignal] - Optional abort signal for cancellation
 * @returns {Promise<ValidationAction>} User selection
 */
export function showPixelValidationDialog(issues, correction, format, abortSignal = null) {
    return enqueueDialog(() => createAndShowDialog(issues, correction, format), abortSignal);
}

/**
 * Show the resolution-mismatch dialog for dual-image loads
 * @param {Object} dims - {leftWidth, leftHeight, rightWidth, rightHeight, targetWidth, targetHeight}
 * @param {AbortSignal} [abortSignal] - Optional abort signal for cancellation
 * @returns {Promise<MismatchAction>} User selection
 */
export function showResolutionMismatchDialog(dims, abortSignal = null) {
    return enqueueDialog(() => createAndShowMismatchDialog(dims), abortSignal);
}

/**
 * Enqueue a dialog request into the serialized FIFO queue
 * @param {() => Promise<any>} showFn - Function that creates and shows the dialog
 * @param {AbortSignal} [abortSignal] - Optional abort signal for cancellation
 * @returns {Promise<any>} Dialog result
 * @private
 */
function enqueueDialog(showFn, abortSignal = null) {
    return new Promise((resolve, reject) => {
        let didTimeout = false;
        let queueTimeoutId = null;

        const wrappedResolve = (result) => {
            if (didTimeout) return;  // Ignore if timeout already occurred
            if (queueTimeoutId !== null) clearTimeout(queueTimeoutId);
            resolve(result);
        };

        const wrappedReject = (error) => {
            if (didTimeout) return;  // Ignore if timeout already occurred
            if (queueTimeoutId !== null) clearTimeout(queueTimeoutId);
            reject(error);
        };

        // Reject immediately if the queue has grown too large to prevent unbounded memory growth
        if (dialogQueue.length >= DIALOG_QUEUE_MAX) {
            logger.warn('PixelValidation', '[PixelValidation] Dialog queue limit reached; dropping request');
            reject(new Error('Dialog queue limit reached'));
            return;
        }

        // Queue this dialog request
        const queueEntry = {
            resolve: wrappedResolve,
            reject: wrappedReject,
            showFn,
            abortSignal
        };
        dialogQueue.push(queueEntry);

        // Outer timeout to catch queue processing failures
        // Call reject() directly (not wrappedReject) because didTimeout is set to true
        // before this call, and wrappedReject would see didTimeout=true and become a no-op.
        // The didTimeout flag prevents wrappedResolve/wrappedReject from settling the
        // promise again after this timeout has already rejected it.
        queueTimeoutId = setTimeout(() => {
            if (!didTimeout) {
                didTimeout = true;
                logger.error('PixelValidation', '[PixelValidation] Queue processing timeout');
                // Remove this entry from the queue if it is still waiting. Otherwise
                // processDialogQueue would later show an orphan dialog whose answer is
                // discarded (the promise was already rejected here). Remove by identity.
                const idx = dialogQueue.indexOf(queueEntry);
                if (idx !== -1) {
                    dialogQueue.splice(idx, 1);
                }
                reject(dialogTimeoutError('Dialog queue processing timeout'));
            }
        }, DIALOG_TIMEOUT_MS + 5000);  // Allow some buffer beyond inner timeout

        // Process the queue
        processDialogQueue();
    });
}

/**
 * Internal function to create and display the dialog
 * (All concurrent calls are serialized through the queue)
 * @private
 */
function createAndShowDialog(issues, correction, format) {
    return new Promise((resolve, reject) => {
        try {
            // Remove any existing dialog (safe now that we're serialized)
            const existingDialog = document.getElementById('pixelValidationDialog');
            if (existingDialog) {
                existingDialog.remove();
            }

            // Create the dialog
            const dialog = document.createElement('div');
            dialog.id = 'pixelValidationDialog';
            dialog.className = 'dialog-overlay';
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
            `;

            // Build the issue description (XSS protection: use DOM API)
            const issueDescriptions = issues.map(issue => {
                switch (issue.type) {
                    case 'sbs_odd_width':
                        return window.t?.('messages.pixelValidation.sbsOddWidth', { width: issue.width }) ?? `Odd SBS width: ${issue.width}`;
                    case 'tab_odd_height':
                        return window.t?.('messages.pixelValidation.tabOddHeight', { height: issue.height }) ?? `Odd TaB height: ${issue.height}`;
                    case 'eye_odd_width':
                        return window.t?.('messages.pixelValidation.oddWidth', { width: issue.eyeWidth || issue.width }) ?? `Odd width: ${issue.eyeWidth || issue.width}`;
                    case 'eye_odd_height':
                        return window.t?.('messages.pixelValidation.oddHeight', { height: issue.eyeHeight || issue.height }) ?? `Odd height: ${issue.eyeHeight || issue.height}`;
                    case 'interlace_odd_width':
                    case 'odd_width':
                        return window.t?.('messages.pixelValidation.oddWidth', { width: issue.width }) ?? `Odd width: ${issue.width}`;
                    case 'interlace_odd_height':
                    case 'odd_height':
                        return window.t?.('messages.pixelValidation.oddHeight', { height: issue.height }) ?? `Odd height: ${issue.height}`;
                    default:
                        return '';
                }
            }).filter(desc => desc);

            // Build the dialog box (XSS protection: use DOM API)
            const dialogBox = document.createElement('div');
            dialogBox.className = 'dialog-box';
            dialogBox.style.cssText = `
                background: var(--panel-bg, #2a2a2a);
                border-radius: 8px;
                padding: 20px;
                max-width: 400px;
                color: var(--text-color, #e0e0e0);
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            `;

            const title = document.createElement('h3');
            title.style.cssText = 'margin: 0 0 15px 0; font-size: 16px; color: #ffcc00;';
            title.textContent = window.t?.('messages.pixelValidation.title') ?? 'Pixel Validation';

            const issuesContainer = document.createElement('div');
            issuesContainer.style.cssText = 'margin-bottom: 15px; font-size: 14px; line-height: 1.5;';
            issueDescriptions.forEach((desc, index) => {
                if (index > 0) {
                    issuesContainer.appendChild(document.createElement('br'));
                }
                const textNode = document.createTextNode(desc);
                issuesContainer.appendChild(textNode);
            });

            const recommendation = document.createElement('p');
            recommendation.style.cssText = 'font-size: 12px; color: #aaa; margin-bottom: 15px;';
            recommendation.textContent = window.t?.('messages.pixelValidation.recommendation') ?? 'Trimming to even pixels is recommended for optimal display.';

            dialogBox.appendChild(title);
            dialogBox.appendChild(issuesContainer);
            dialogBox.appendChild(recommendation);

            if (correction.trimRight > 0 || correction.trimBottom > 0) {
                const trimInfo = document.createElement('p');
                trimInfo.style.cssText = 'font-size: 12px; color: #aaa; margin-top: 10px;';
                trimInfo.textContent = window.t?.('messages.pixelValidation.trimInfo', { right: correction.trimRight, bottom: correction.trimBottom }) ?? `Trim: right=${correction.trimRight}px, bottom=${correction.trimBottom}px`;
                dialogBox.appendChild(trimInfo);
            }

            const actions = document.createElement('div');
            actions.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px;';

            const trimBtn = document.createElement('button');
            trimBtn.id = 'pixelValidationTrim';
            trimBtn.className = 'modern-btn primary';
            trimBtn.style.cssText = 'padding: 8px 16px;';
            trimBtn.textContent = window.t?.('messages.pixelValidation.trimOption') ?? 'Trim';

            const cancelBtn = document.createElement('button');
            cancelBtn.id = 'pixelValidationCancel';
            cancelBtn.className = 'modern-btn secondary';
            cancelBtn.style.cssText = 'padding: 8px 16px;';
            cancelBtn.textContent = window.t?.('messages.pixelValidation.cancelOption') ?? 'Cancel';

            actions.appendChild(trimBtn);
            actions.appendChild(cancelBtn);
            dialogBox.appendChild(actions);
            dialog.appendChild(dialogBox);

            document.body.appendChild(dialog);

            let didResolve = false;

            // Set up event listeners
            const cleanup = () => {
                // Unregister from active dialog tracking
                activeDialogCleanup = null;
                // Check if dialog still exists before removing
                if (dialog && dialog.parentNode) {
                    dialog.remove();
                }
                // Explicitly remove keydown listener (prevent memory leaks)
                document.removeEventListener('keydown', handleKeydown);
                // Remove button listeners
                trimBtn.removeEventListener('click', onTrim);
                cancelBtn.removeEventListener('click', onCancel);
            };

            // Register cleanup so clearDialogQueue / timeout can dismiss this dialog
            activeDialogCleanup = () => {
                if (!didResolve) {
                    didResolve = true;
                    cleanup();
                    resolve('cancel');
                }
            };

            // Cancel with the ESC key
            const handleKeydown = (e) => {
                if (e.key === 'Escape' && !didResolve) {
                    didResolve = true;
                    cleanup();
                    resolve('cancel');
                }
            };

            // Button event handlers
            const onTrim = () => {
                if (!didResolve) {
                    didResolve = true;
                    cleanup();
                    resolve('trim');
                }
            };

            const onCancel = () => {
                if (!didResolve) {
                    didResolve = true;
                    cleanup();
                    resolve('cancel');
                }
            };

            // Attach event listeners
            trimBtn.addEventListener('click', onTrim);
            cancelBtn.addEventListener('click', onCancel);
            document.addEventListener('keydown', handleKeydown);

        } catch (err) {
            // Catch DOM creation errors or translation errors
            logger.error('PixelValidation','[PixelValidation] Dialog creation error:', err);
            reject(new Error(`Failed to create dialog: ${err.message}`));
        }
    });
}

/**
 * Internal function to create and display the resolution-mismatch dialog
 * (All concurrent calls are serialized through the queue)
 * @param {Object} dims - {leftWidth, leftHeight, rightWidth, rightHeight, targetWidth, targetHeight}
 * @returns {Promise<MismatchAction>}
 * @private
 */
function createAndShowMismatchDialog(dims) {
    return new Promise((resolve, reject) => {
        try {
            // Remove any existing dialog (safe now that we're serialized)
            const existingDialog = document.getElementById('resolutionMismatchDialog');
            if (existingDialog) {
                existingDialog.remove();
            }

            // Create the dialog
            const dialog = document.createElement('div');
            dialog.id = 'resolutionMismatchDialog';
            dialog.className = 'dialog-overlay';
            dialog.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
            `;

            // Build the dialog box (XSS protection: use DOM API)
            const dialogBox = document.createElement('div');
            dialogBox.className = 'dialog-box';
            dialogBox.style.cssText = `
                background: var(--panel-bg, #2a2a2a);
                border-radius: 8px;
                padding: 20px;
                max-width: 400px;
                color: var(--text-color, #e0e0e0);
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            `;

            const title = document.createElement('h3');
            title.style.cssText = 'margin: 0 0 15px 0; font-size: 16px; color: #ffcc00;';
            title.textContent = window.t?.('messages.resolutionMismatchDialog.title') ?? 'Resolution Mismatch';

            const infoContainer = document.createElement('div');
            infoContainer.style.cssText = 'margin-bottom: 15px; font-size: 14px; line-height: 1.5;';
            const infoLines = [
                window.t?.('messages.resolutionMismatchDialog.description') ?? 'The left and right images have different resolutions.',
                window.t?.('messages.resolutionMismatchDialog.leftSize', { width: dims.leftWidth, height: dims.leftHeight }) ?? `Left: ${dims.leftWidth} x ${dims.leftHeight} px`,
                window.t?.('messages.resolutionMismatchDialog.rightSize', { width: dims.rightWidth, height: dims.rightHeight }) ?? `Right: ${dims.rightWidth} x ${dims.rightHeight} px`,
                window.t?.('messages.resolutionMismatchDialog.targetInfo', { width: dims.targetWidth, height: dims.targetHeight }) ?? `Adjusted size: ${dims.targetWidth} x ${dims.targetHeight} px (both eyes)`
            ];
            infoLines.forEach((line, index) => {
                if (index > 0) {
                    infoContainer.appendChild(document.createElement('br'));
                }
                infoContainer.appendChild(document.createTextNode(line));
            });

            const recommendation = document.createElement('p');
            recommendation.style.cssText = 'font-size: 12px; color: #aaa; margin-bottom: 15px;';
            recommendation.textContent = window.t?.('messages.resolutionMismatchDialog.recommendation') ?? '"Scale" keeps the full image and resizes to the smaller dimensions. "Trim" center-crops without resampling (best when scans just have slightly different borders).';

            dialogBox.appendChild(title);
            dialogBox.appendChild(infoContainer);
            dialogBox.appendChild(recommendation);

            const actions = document.createElement('div');
            actions.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; flex-wrap: wrap;';

            // .modern-btn is width:100%, which with three buttons would put each on
            // its own row. Size them to their labels instead and let the row wrap
            // only when the labels genuinely do not fit.
            const actionButtonStyle = 'padding: 8px 16px; width: auto; flex: 0 1 auto; margin-bottom: 0;';

            const scaleBtn = document.createElement('button');
            scaleBtn.id = 'resolutionMismatchScale';
            scaleBtn.className = 'modern-btn primary';
            scaleBtn.style.cssText = actionButtonStyle;
            scaleBtn.textContent = window.t?.('messages.resolutionMismatchDialog.scaleOption') ?? 'Scale to match';

            const trimBtn = document.createElement('button');
            trimBtn.id = 'resolutionMismatchTrim';
            trimBtn.className = 'modern-btn secondary';
            trimBtn.style.cssText = actionButtonStyle;
            trimBtn.textContent = window.t?.('messages.resolutionMismatchDialog.trimOption') ?? 'Trim to match';

            const cancelBtn = document.createElement('button');
            cancelBtn.id = 'resolutionMismatchCancel';
            cancelBtn.className = 'modern-btn secondary';
            cancelBtn.style.cssText = actionButtonStyle;
            cancelBtn.textContent = window.t?.('messages.resolutionMismatchDialog.cancelOption') ?? 'Cancel';

            actions.appendChild(scaleBtn);
            actions.appendChild(trimBtn);
            actions.appendChild(cancelBtn);
            dialogBox.appendChild(actions);
            dialog.appendChild(dialogBox);

            document.body.appendChild(dialog);

            let didResolve = false;

            // Set up event listeners
            const cleanup = () => {
                // Unregister from active dialog tracking
                activeDialogCleanup = null;
                // Check if dialog still exists before removing
                if (dialog && dialog.parentNode) {
                    dialog.remove();
                }
                // Explicitly remove keydown listener (prevent memory leaks)
                document.removeEventListener('keydown', handleKeydown);
                // Remove button listeners
                scaleBtn.removeEventListener('click', onScale);
                trimBtn.removeEventListener('click', onTrim);
                cancelBtn.removeEventListener('click', onCancel);
            };

            const settle = (action) => {
                if (!didResolve) {
                    didResolve = true;
                    cleanup();
                    resolve(action);
                }
            };

            // Register cleanup so clearDialogQueue / timeout can dismiss this dialog
            activeDialogCleanup = () => settle('cancel');

            // Cancel with the ESC key
            const handleKeydown = (e) => {
                if (e.key === 'Escape') {
                    settle('cancel');
                }
            };

            // Button event handlers
            const onScale = () => settle('scale');
            const onTrim = () => settle('trim');
            const onCancel = () => settle('cancel');

            // Attach event listeners
            scaleBtn.addEventListener('click', onScale);
            trimBtn.addEventListener('click', onTrim);
            cancelBtn.addEventListener('click', onCancel);
            document.addEventListener('keydown', handleKeydown);

        } catch (err) {
            // Catch DOM creation errors or translation errors
            logger.error('PixelValidation','[PixelValidation] Mismatch dialog creation error:', err);
            reject(new Error(`Failed to create dialog: ${err.message}`));
        }
    });
}

/**
 * Validate the image and show a dialog if needed
 * @param {ImageBitmap|HTMLCanvasElement|HTMLImageElement} image - Image to validate
 * @param {string} format - Image format
 * @param {Object} [options] - Validation behavior options
 * @param {boolean} [options.forceTrimWithoutDialog=false] - Skip dialog and force trim-to-even when issues are detected
 * @returns {Promise<{image: any, action: ValidationAction}>} Processed image and action
 */
export async function validateAndProcessImage(image, format, options = {}) {
    const { forceTrimWithoutDialog = false } = options;
    const validation = validatePixelsForFormat(image.width, image.height, format);

    if (validation.isValid && validation.issues.length === 0) {
        // No issues (even pixels)
        return { image, action: 'trim' };
    }

    // If there is an issue, show a dialog unless forced-trim mode is enabled
    const action = forceTrimWithoutDialog
        ? 'trim'
        : await showPixelValidationDialog(validation.issues, validation.correction, format);

    if (action === 'cancel') {
        return { image: null, action: 'cancel' };
    }

    // Perform trimming (action === 'trim')
    if (validation.correction.trimRight > 0 || validation.correction.trimBottom > 0) {
        const trimmedCanvas = trimToEvenPixels(
            image,
            validation.correction.trimRight,
            validation.correction.trimBottom
        );
        logger.info('PixelValidation',`Image trimmed: ${image.width}x${image.height} → ${trimmedCanvas.width}x${trimmedCanvas.height}`);
        return { image: trimmedCanvas, action: 'trim' };
    }

    // No trimming needed (already even)
    return { image, action: 'trim' };
}

/**
 * Validate dual images (left/right)
 * @param {HTMLImageElement} imgL - Left eye image
 * @param {HTMLImageElement} imgR - Right eye image
 * @param {Object} [options]
 * @param {boolean} [options.forceTrimWithoutDialog=false] - Skip the dialog and force
 *   trim-to-even when issues are detected (used for ?src=/?list= URL launches, so an
 *   odd-dimension MPO does not pop a blocking dialog on an unattended slideshow)
 * @returns {Promise<{imgL: any, imgR: any, action: ValidationAction}>}
 */
export async function validateDualImages(imgL, imgR, options = {}) {
    const { forceTrimWithoutDialog = false } = options;
    // Validate as a single-eye image
    const validationL = validatePixelsForFormat(imgL.width * 2, imgL.height, 'full_sbs');

    if (validationL.issues.length > 0) {
        const action = forceTrimWithoutDialog
            ? 'trim'
            : await showPixelValidationDialog(validationL.issues, validationL.correction, 'full_sbs');

        if (action === 'cancel') {
            return { imgL: null, imgR: null, action: 'cancel' };
        }

        // Perform trimming (action === 'trim')
        const trimRight = Math.floor(validationL.correction.trimRight / 2);
        const trimBottom = validationL.correction.trimBottom;

        if (trimRight > 0 || trimBottom > 0) {
            const trimmedL = trimToEvenPixels(imgL, trimRight, trimBottom);
            const trimmedR = trimToEvenPixels(imgR, trimRight, trimBottom);
            logger.info('PixelValidation',`Dual images trimmed: ${imgL.width}x${imgL.height} → ${trimmedL.width}x${trimmedL.height}`);
            return { imgL: trimmedL, imgR: trimmedR, action: 'trim' };
        }
    }

    // No trimming needed or no issues
    return { imgL, imgR, action: 'trim' };
}
