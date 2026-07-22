/**
 * ui-menu.js
 * Modern slide menu and panel controls
 */
import { state } from '../globals.js';
import { resetCropSelection } from './ui-crop.js';
import { clearElementCache } from './ui.js';

// AbortController for managing event listeners (prevent memory leaks)
let menuEventAbortController = null;

// Function to navigate to main menu (exposed externally)
let navigateToMainMenuFn = null;

/**
 * Initialize the modern slide menu
 */
function initModernMenu() {
    // Initialize AbortController (abort existing one if present)
    if (menuEventAbortController) {
        menuEventAbortController.abort();
    }
    menuEventAbortController = new AbortController();
    const signal = menuEventAbortController.signal;

    const menuPanels = document.querySelectorAll('.menu-panel');
    const menuCards = document.querySelectorAll('.menu-card');
    const backButtons = document.querySelectorAll('.back-btn');

    let currentPanel = 'main-menu';

    menuPanels.forEach(panel => {
        if (!panel.classList.contains('active')) {
            panel.classList.add('is-hidden');
        }
    });

    // Menu card click event
    menuCards.forEach(card => {
        card.addEventListener('click', () => {
            const targetMenu = card.getAttribute('data-submenu');
            if (targetMenu) {
                navigateToPanel(targetMenu);
            }
        }, { signal });
    });

    // Back button click event
    backButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetMenu = btn.getAttribute('data-back');
            if (targetMenu) {
                // Disable rectangle selection mode when navigating up the menu
                if (state.cropSelectionMode) {
                    resetCropSelection();
                }

                navigateToPanel(targetMenu, true);
            }
        }, { signal });
    });

    // Panel transition function
    function navigateToPanel(targetId, isBack = false) {
        const currentPanelEl = document.getElementById(currentPanel);
        const targetPanelEl = document.getElementById(targetId);

        if (!targetPanelEl || currentPanel === targetId) return;

        // Ensures that getElement() in ui.js retrieves fresh DOM references
        clearElementCache();

        // Show/hide clipboard export section based on loadedFromUrlDialog flag
        if (targetId === 'export-menu') {
            const clipboardExportSection = document.getElementById('clipboardExportSection');
            if (clipboardExportSection) {
                if (state.loadedFromUrlDialog) {
                    clipboardExportSection.style.display = 'block';
                } else {
                    clipboardExportSection.style.display = 'none';
                }
            }
        }

        // Clean up all panel states
        const allPanels = document.querySelectorAll('.menu-panel');
        allPanels.forEach(panel => {
            if (panel.id !== currentPanel && panel.id !== targetId) {
                panel.classList.remove('active', 'slide-out');
                panel.classList.add('is-hidden');
                panel.style.transform = '';
            }
        });

        if (currentPanelEl) {
            currentPanelEl.classList.remove('active', 'slide-out');
            currentPanelEl.classList.add('is-hidden');
            currentPanelEl.style.transform = '';
        }

        targetPanelEl.classList.remove('is-hidden', 'slide-out');
        targetPanelEl.style.transform = isBack ? 'translateX(-100%)' : 'translateX(100%)';

        // Use double rAF to ensure the browser flushes the initial transform
        // before clearing it, so the CSS transition animation triggers reliably
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                targetPanelEl.classList.add('active');
                targetPanelEl.style.transform = '';
            });
        });

        currentPanel = targetId;
    }

    // Set main menu navigation function for global access
    navigateToMainMenuFn = () => {
        if (currentPanel !== 'main-menu') {
            navigateToPanel('main-menu', true);
        }
    };

    // Expose in global scope (via namespace)
    if (!window.StereoView) {
        window.StereoView = {};
    }
    window.StereoView.navigateToMainMenu = navigateToMainMenuFn;

    // Expose as a direct global in addition to the namespace
    Object.defineProperty(window, 'navigateToMainMenu', {
        get: () => window.StereoView.navigateToMainMenu,
        configurable: true
    });

    // Initial state
    document.body.classList.add('menu-open');
}

/**
 * Set up menu drawer show/hide controls
 */
function setupMenuDrawer() {
    const signal = menuEventAbortController?.signal;
    if (!signal) return;

    const uiContainer = document.getElementById('ui-container');
    const drawerHandle = document.getElementById('menu-drawer-handle');
    const panelCloseTab = document.getElementById('panel-close-tab');

    // Panel close tab click event
    if (panelCloseTab) {
        panelCloseTab.addEventListener('click', () => {
            if (uiContainer) {
                uiContainer.classList.add('ui-hidden');
                document.body.classList.remove('menu-open');
                clearElementCache();
            }
        }, { signal });
    }

    if (drawerHandle) {
        drawerHandle.addEventListener('click', () => {
            if (uiContainer) {
                uiContainer.classList.remove('ui-hidden');
                document.body.classList.add('menu-open');
                clearElementCache();
            }
        }, { signal });
    }
}

/**
 * Set up status panel show/hide controls
 */
function setupStatusPanel() {
    const signal = menuEventAbortController?.signal;
    if (!signal) return;

    const statusPanel = document.getElementById('status-panel');
    const showStatusBtn = document.getElementById('showStatusBtn');
    const hideStatusBtn = document.getElementById('hideStatusBtn');

    // Initial state: status panel is visible
    document.body.classList.add('status-open');

    if (hideStatusBtn) {
        hideStatusBtn.addEventListener('click', () => {
            if (statusPanel) statusPanel.classList.add('status-hidden');
            document.body.classList.remove('status-open');
            clearElementCache();
        }, { signal });
    }

    if (showStatusBtn) {
        showStatusBtn.addEventListener('click', () => {
            if (statusPanel) statusPanel.classList.remove('status-hidden');
            document.body.classList.add('status-open');
            clearElementCache();
        }, { signal });
    }
}

/**
 * Initialize the entire menu system
 */
export function setupMenuSystem() {
    initModernMenu();
    setupMenuDrawer();
    setupStatusPanel();
}

/**
 * Navigate to main menu
 */
export function navigateToMainMenu() {
    if (navigateToMainMenuFn) {
        navigateToMainMenuFn();
    }
}

/**
 * Clean up menu system resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guards)
 */
export function cleanupMenuSystem() {
    // Remove event listeners
    if (menuEventAbortController) {
        menuEventAbortController.abort();
        menuEventAbortController = null;
    }
}
