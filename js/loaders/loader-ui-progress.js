/**
 * loader-ui-progress.js
 * UI progress display module
 * Manage showing/hiding the load progress bar
 */

/**
 * Show the load progress UI
 * @param {number} progress - Progress percentage (0-100)
 */
export function showLoadingProgress(progress) {
    let progressContainer = document.getElementById('loadingProgressContainer');

    if (!progressContainer) {
        progressContainer = document.createElement('div');
        progressContainer.id = 'loadingProgressContainer';
        progressContainer.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            z-index: 10000;
            background: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 20px 40px;
            border-radius: 8px;
            text-align: center;
            font-family: sans-serif;
        `;

        // XSS protection: use createElement instead of innerHTML
        const messageDiv = document.createElement('div');
        messageDiv.style.cssText = 'margin-bottom: 10px; font-size: 14px;';
        messageDiv.setAttribute('data-i18n', 'messages.imageProcessing');
        // Set default text (will be replaced by translation if available)
        messageDiv.textContent = 'Processing image...';
        progressContainer.appendChild(messageDiv);

        const progressBarContainer = document.createElement('div');
        progressBarContainer.style.cssText = 'width: 200px; height: 8px; background: #333; border-radius: 4px; overflow: hidden;';

        const progressBarFill = document.createElement('div');
        progressBarFill.id = 'loadingProgressBarFill';
        progressBarFill.style.cssText = 'height: 100%; background: #4CAF50; transition: width 0.3s ease;';
        progressBarContainer.appendChild(progressBarFill);
        progressContainer.appendChild(progressBarContainer);

        const percentageDiv = document.createElement('div');
        percentageDiv.id = 'loadingProgressPercentage';
        percentageDiv.style.cssText = 'margin-top: 10px; font-size: 12px;';
        progressContainer.appendChild(percentageDiv);

        document.body.appendChild(progressContainer);

        // Apply translations to dynamically added elements
        window.updateI18nContent?.();
    }

    // Update the progress bar and percentage
    const clampedProgress = Math.max(0, Math.min(100, progress));
    const progressBarFill = document.getElementById('loadingProgressBarFill');
    const percentageDiv = document.getElementById('loadingProgressPercentage');
    if (progressBarFill) {
        progressBarFill.style.width = `${clampedProgress}%`;
    }
    if (percentageDiv) {
        percentageDiv.textContent = `${Math.round(clampedProgress)}%`;
    }
}

/**
 * Hide the load progress UI
 */
export function hideLoadingProgress() {
    const progressContainer = document.getElementById('loadingProgressContainer');
    if (progressContainer) {
        // Remove immediately instead of delayed to prevent stale hidden elements
        // that block subsequent showLoadingProgress calls
        if (progressContainer.parentNode) {
            progressContainer.parentNode.removeChild(progressContainer);
        }
    }
}

/**
 * Restore UI state on file load errors
 * Re-enable disabled menus and buttons
 */
export function resetUIStateAfterLoadError() {
    // Enable buttons
    const buttons = document.querySelectorAll('button[data-load-control]');
    buttons.forEach(btn => {
        btn.disabled = false;
    });

    // Enable the menu
    const menu = document.getElementById('ui-container');
    if (menu) {
        menu.classList.remove('loading');
    }

    // Enable file input
    const fileInputs = document.querySelectorAll('input[type="file"]');
    fileInputs.forEach(input => {
        input.disabled = false;
    });
}
