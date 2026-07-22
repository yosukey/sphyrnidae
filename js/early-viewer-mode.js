/**
 * early-viewer-mode.js
 * Detects viewer mode from URL parameters and applies UI changes immediately
 * This prevents UI flash when loading images via ?src= or ?list= parameters
 */

(function() {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('src') || urlParams.has('list')) {
        // Immediately set viewer mode UI classes
        document.body.classList.add('viewer-mode');
        document.body.classList.remove('menu-open', 'status-open');

        // Hide menu panel immediately
        const style = document.createElement('style');
        style.id = 'early-viewer-mode-style';
        style.textContent = `
            #ui-container { display: none !important; }
            #viewer-mode-bar { display: flex !important; }
            #status-panel { display: none !important; }
        `;
        document.head.appendChild(style);
    }
})();
