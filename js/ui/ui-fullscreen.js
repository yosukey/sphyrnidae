/**
 * ui-fullscreen.js
 * Fullscreen detection/toggling and viewer mode bar auto-display control
 */
import { state, DEBUG, CONSTANTS } from '../globals.js';
import * as logger from '../utils/logger.js';

// State variables
let lastInnerHeight = window.innerHeight;
let lastInnerWidth = window.innerWidth;
let wasMenuOpenBeforeFullscreen = false;
let wasStatusOpenBeforeFullscreen = false;
let wasHistogramOpenBeforeFullscreen = false;
let resizeCheckTimer = null;
let initialCheckTimer = null;
let viewerBarAutoHideTimer = null;
let ignoreMouseEventsUntil = 0;
let wasInBottomZone = false;
let touchStartY = null;
let touchStartX = null;
// Cached bounding rect for viewer bar (invalidated on resize)
let cachedBarRect = null;
let touchStartTime = null;
let viewerBarAbortController = null;
let fullscreenListenersAttached = false;

// AbortController for managing window event listeners (prevent memory leaks)
let fullscreenEventAbortController = null;

// DOM element cache
let uiContainerEl = null;
let statusPanelEl = null;

/**
 * Check if Fullscreen API is active
 * @returns {boolean} True if any fullscreen API is active
 */
export function isFullscreenActive() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}

/**
 * Request fullscreen with vendor-prefixed fallbacks (WebKit/Firefox/legacy IE).
 * Shared so callers (viewer fullscreen button, etc.) do not no-op on browsers
 * that only expose the prefixed API, which would desync the prefixed state checks.
 * @param {Element} el - Element to display fullscreen
 * @returns {Promise|void}
 */
export function requestFullscreenCompat(el) {
    if (!el) return;
    const request = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (request) {
        return request.call(el);
    }
}

/**
 * Exit fullscreen with vendor-prefixed fallbacks (WebKit/Firefox/legacy IE).
 * @returns {Promise|void}
 */
export function exitFullscreenCompat() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen || document.msExitFullscreen;
    if (exit) {
        return exit.call(document);
    }
}

/**
 * Check if F11 fullscreen (browser native fullscreen without API) is active
 * @returns {boolean} True if window occupies most of the screen without Fullscreen API
 */
export function isF11Fullscreen() {
    if (isFullscreenActive()) {
        return false;
    }
    const heightRatio = window.innerHeight / screen.availHeight;
    const widthRatio = window.innerWidth / screen.availWidth;
    return (heightRatio > CONSTANTS.FULLSCREEN_DETECTION_THRESHOLD) && (widthRatio > CONSTANTS.FULLSCREEN_DETECTION_THRESHOLD);
}

/**
 * Show the viewer mode control bar
 */
function showViewerControlBar() {
    const viewerBar = document.getElementById('viewer-mode-bar');
    if (viewerBar) {
        viewerBar.classList.remove('viewer-bar-hidden');
        // Invalidate cached rect when bar visibility changes
        cachedBarRect = null;
    }
}

/**
 * Hide the viewer mode control bar
 */
function hideViewerControlBar() {
    const viewerBar = document.getElementById('viewer-mode-bar');
    if (viewerBar) {
        viewerBar.classList.add('viewer-bar-hidden');
        cachedBarRect = null;
    }
}

/**
 * Start the viewer mode control bar auto-hide timer
 */
function startViewerBarAutoHideTimer() {
    // Clear existing timer
    if (viewerBarAutoHideTimer) {
        clearTimeout(viewerBarAutoHideTimer);
        viewerBarAutoHideTimer = null;
    }

    // Start timer only in fullscreen viewer mode
    const isFullscreen = isFullscreenActive();
    const isF11FullscreenMode = isF11Fullscreen();
    const isAnyFullscreen = isFullscreen || isF11FullscreenMode;

    logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'startViewerBarAutoHideTimer:', {
        isFullscreen,
        isF11Fullscreen: isF11FullscreenMode,
        isAnyFullscreen,
        viewerMode: state.viewerMode,
        willStartTimer: isAnyFullscreen && state.viewerMode
    });

    if (isAnyFullscreen && state.viewerMode) {
        viewerBarAutoHideTimer = setTimeout(() => {
            logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Auto-hide timer fired, hiding viewer bar');
            hideViewerControlBar();
            viewerBarAutoHideTimer = null;
        }, CONSTANTS.VIEWER_BAR_AUTO_HIDE_DELAY);
    }
}

/**
 * Stop the viewer mode control bar auto-hide timer
 */
function stopViewerBarAutoHideTimer() {
    if (viewerBarAutoHideTimer) {
        clearTimeout(viewerBarAutoHideTimer);
        viewerBarAutoHideTimer = null;
    }
}

/**
 * Apply fullscreen mode
 */
function applyFullscreenMode() {
    logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'applyFullscreenMode called, viewerMode:', state.viewerMode);

    // Reentrancy: if already in fullscreen mode (e.g. entering API fullscreen while
    // already in F11 fullscreen), skip ONLY the state save — re-saving would capture
    // the already-modified menu/status/histogram state and break restoration on exit.
    // The viewer-mode UI below must still run, otherwise entering viewer mode while
    // already fullscreen would leave the side panels visible and never start the
    // control-bar auto-hide timer.
    const alreadyFullscreen = document.body.classList.contains('fullscreen-mode');

    const histogramPanel = document.getElementById('histogram-panel');
    if (!alreadyFullscreen) {
        // Save current menu state
        wasMenuOpenBeforeFullscreen = document.body.classList.contains('menu-open');
        wasStatusOpenBeforeFullscreen = document.body.classList.contains('status-open');

        // The histogram is only hidden (and later restored) by the viewer-mode block
        // below, which captures its live visibility at hide time. Reset the flag here
        // so a non-viewer (F11) fullscreen — which never hides the histogram — does
        // not force-reopen it on exit, and so a stale value from a previous viewer
        // fullscreen session cannot leak in.
        wasHistogramOpenBeforeFullscreen = false;

        document.body.classList.add('fullscreen-mode');
    }

    // Hide UI only in viewer mode
    if (state.viewerMode) {
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Applying viewer mode fullscreen UI');

        document.body.classList.add('viewer-fullscreen');

        // Close menu
        if (uiContainerEl) {
            uiContainerEl.classList.add('ui-hidden');
        }
        document.body.classList.remove('menu-open');
        if (statusPanelEl) {
            statusPanelEl.classList.add('status-hidden');
        }
        document.body.classList.remove('status-open');

        // Hide histogram in the immersive viewer. Capture its CURRENT visibility (not
        // the snapshot from first fullscreen entry) so a panel opened AFTER entering
        // fullscreen is hidden here and correctly restored on exit. This runs on every
        // entry, so the F11 -> viewer/API-fullscreen re-entry transition is handled too.
        if (histogramPanel && histogramPanel.style.display !== 'none') {
            wasHistogramOpenBeforeFullscreen = true;
            histogramPanel.style.display = 'none';
        }

        // Show the control bar then start auto-hide timer
        showViewerControlBar();

        // Ignore mouse events right after entering fullscreen to avoid stopping the timer
        // (avoid mouseenter/mousemove during fullscreen transition)
        ignoreMouseEventsUntil = Date.now() + 500; // Ignore for 500ms
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Starting viewer bar auto-hide timer');
        startViewerBarAutoHideTimer();
    }
    // In non-viewer mode, keep side panels visible
}

/**
 * Exit fullscreen mode
 */
function exitFullscreenMode() {
    logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'exitFullscreenMode called');

    document.body.classList.remove('fullscreen-mode');
    document.body.classList.remove('viewer-fullscreen');

    // Stop the viewer mode auto-hide timer
    logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Stopping viewer bar auto-hide timer');
    stopViewerBarAutoHideTimer();

    // Restore control bar visibility
    showViewerControlBar();

    // Restore saved state (default is open)
    if (wasMenuOpenBeforeFullscreen) {
        if (uiContainerEl) {
            uiContainerEl.classList.remove('ui-hidden');
        }
        document.body.classList.add('menu-open');
    }

    if (wasStatusOpenBeforeFullscreen) {
        if (statusPanelEl) {
            statusPanelEl.classList.remove('status-hidden');
        }
        document.body.classList.add('status-open');
    }

    // Restore histogram state
    const histogramPanel = document.getElementById('histogram-panel');
    if (wasHistogramOpenBeforeFullscreen && histogramPanel) {
        histogramPanel.style.display = 'block';
    }
}

/**
 * Fullscreen change event handler
 */
function handleFullscreenChange() {
    const isFullscreen = isFullscreenActive();
    logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'handleFullscreenChange:', { isFullscreen });
    if (isFullscreen) {
        applyFullscreenMode();
    } else {
        // API fullscreen ended, but F11/browser-native fullscreen may still be
        // active (e.g. Esc leaves API fullscreen while F11 remains). Re-check via
        // the same guard the resize path uses instead of unconditionally exiting,
        // so the UI stays in fullscreen mode while the window still is.
        checkBrowserFullscreen();
    }
}

/**
 * Detect fullscreen mode via F11 key (browser-native fullscreen)
 */
function checkBrowserFullscreen() {
    const isApiFullscreen = isFullscreenActive();
    const isF11FullscreenMode = isF11Fullscreen();

    const wasFullscreen = document.body.classList.contains('fullscreen-mode');
    const isNowFullscreen = isF11FullscreenMode || isApiFullscreen;

    // Debug log
    const heightRatio = window.innerHeight / screen.availHeight;
    const widthRatio = window.innerWidth / screen.availWidth;
    logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'checkBrowserFullscreen:', {
        heightRatio: heightRatio.toFixed(3),
        widthRatio: widthRatio.toFixed(3),
        isF11Fullscreen: isF11FullscreenMode,
        isApiFullscreen,
        wasFullscreen,
        isNowFullscreen,
        viewerMode: state.viewerMode
    });

    if (isNowFullscreen && !wasFullscreen) {
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Entering fullscreen mode (F11 or Browser)');
        applyFullscreenMode();
    } else if (!isNowFullscreen && wasFullscreen && !isApiFullscreen) {
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Exiting fullscreen mode (F11 or Browser)');
        exitFullscreenMode();
    }
}

/**
 * Helper: check whether fullscreen is active
 */
function isInFullscreenViewerMode() {
    return (isFullscreenActive() || isF11Fullscreen()) && state.viewerMode;
}

/**
 * Helper: check whether the control bar is visible
 */
function isViewerBarVisible() {
    const viewerBar = document.getElementById('viewer-mode-bar');
    return viewerBar && !viewerBar.classList.contains('viewer-bar-hidden');
}

/**
 * Detect bottom hover via mouse movement
 */
function handleMouseMove(e) {
    // Handle only in fullscreen viewer mode
    const isFullscreen = isFullscreenActive();
    const isF11FullscreenMode = isF11Fullscreen();
    const isAnyFullscreen = isFullscreen || isF11FullscreenMode;

    if (!isAnyFullscreen || !state.viewerMode) return;

    // Ignore mouse events immediately after entering fullscreen
    if (Date.now() < ignoreMouseEventsUntil) return;

    const viewerBar = document.getElementById('viewer-mode-bar');
    if (!viewerBar) return;

    // Bottom hover zone
    const windowHeight = window.innerHeight;
    const isInBottomZone = e.clientY >= windowHeight - CONSTANTS.VIEWER_BAR_HOVER_ZONE_HEIGHT;

    if (isInBottomZone) {
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Mouse in bottom zone, showing viewer bar');
        // Show the control bar
        showViewerControlBar();
        // Stop timer (do not hide while hovering)
        stopViewerBarAutoHideTimer();
    } else if (wasInBottomZone) {
        // Restart timer when leaving the hover zone and not over the control bar
        // Use cached rect to avoid forced layout reflow on every mousemove
        if (!cachedBarRect) cachedBarRect = viewerBar.getBoundingClientRect();
        const barRect = cachedBarRect;
        const isOverBar = e.clientX >= barRect.left && e.clientX <= barRect.right &&
                          e.clientY >= barRect.top && e.clientY <= barRect.bottom;
        if (!isOverBar) {
            logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Mouse left bottom zone and not over bar, restarting timer');
            startViewerBarAutoHideTimer();
        }
    }
    wasInBottomZone = isInBottomZone;
}

/**
 * Touch start handler
 */
function handleTouchStart(e) {
    if (!isInFullscreenViewerMode()) return;
    if (Date.now() < ignoreMouseEventsUntil) return;

    const touch = e.touches[0];
    touchStartY = touch.clientY;
    touchStartX = touch.clientX;
    touchStartTime = Date.now();
}

/**
 * Touch end handler
 */
function handleTouchEnd(e) {
    if (!isInFullscreenViewerMode()) return;
    if (Date.now() < ignoreMouseEventsUntil) return;
    if (touchStartY === null || touchStartX === null) return;

    const touch = e.changedTouches[0];
    const touchEndY = touch.clientY;
    const touchEndX = touch.clientX;
    const deltaY = touchStartY - touchEndY; // Positive value = upward swipe
    const deltaX = Math.abs(touchEndX - touchStartX);
    const touchDuration = Date.now() - touchStartTime;
    const windowHeight = window.innerHeight;

    // Ignore touches on the control bar (avoid interfering with buttons)
    const viewerBar = document.getElementById('viewer-mode-bar');
    if (viewerBar) {
        const barRect = viewerBar.getBoundingClientRect();
        const isOnBar = touchStartX >= barRect.left && touchStartX <= barRect.right &&
                        touchStartY >= barRect.top && touchStartY <= barRect.bottom;
        if (isOnBar) {
            touchStartY = null;
            touchStartX = null;
            touchStartTime = null;
            return;
        }
    }

    // 1. Detect swipe up from bottom of screen
    const isFromBottomZone = touchStartY >= windowHeight - CONSTANTS.SWIPE_START_ZONE;
    const isSwipeUp = deltaY > CONSTANTS.SWIPE_THRESHOLD && deltaY > deltaX; // Upward and vertical movement larger than horizontal

    if (isFromBottomZone && isSwipeUp) {
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Swipe up from bottom detected, showing viewer bar');
        showViewerControlBar();
        startViewerBarAutoHideTimer();
        touchStartY = null;
        touchStartX = null;
        touchStartTime = null;
        return;
    }

    // 2. Detect tap (small movement and short duration)
    const totalMovement = Math.sqrt(Math.pow(touchEndY - touchStartY, 2) + Math.pow(touchEndX - touchStartX, 2));
    const isTap = totalMovement < CONSTANTS.TAP_THRESHOLD && touchDuration < CONSTANTS.TAP_TIME_THRESHOLD;

    if (isTap) {
        if (isViewerBarVisible()) {
            // Panel visible → restart timer (reset)
            logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Tap detected while bar visible, restarting timer');
            startViewerBarAutoHideTimer();
        } else {
            // Panel hidden → show and start timer
            logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Tap detected while bar hidden, showing bar');
            showViewerControlBar();
            startViewerBarAutoHideTimer();
        }
    }

    touchStartY = null;
    touchStartX = null;
    touchStartTime = null;
}

/**
 * Touch move handler
 */
function handleTouchMove(e) {
    if (!isInFullscreenViewerMode()) return;
    if (Date.now() < ignoreMouseEventsUntil) return;

    const touch = e.touches[0];
    const windowHeight = window.innerHeight;
    const isInBottomZone = touch.clientY >= windowHeight - CONSTANTS.VIEWER_BAR_HOVER_ZONE_HEIGHT;

    if (isInBottomZone) {
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Touch in bottom zone, showing viewer bar');
        showViewerControlBar();
        stopViewerBarAutoHideTimer();
    }
}

/**
 * Set up viewer bar mouse events
 */
function setupViewerBarHoverEvents() {
    const viewerModeBar = document.getElementById('viewer-mode-bar');
    if (!viewerModeBar) return;

    // Remove existing listeners if any
    if (viewerBarAbortController) {
        viewerBarAbortController.abort();
    }
    viewerBarAbortController = new AbortController();
    const signal = viewerBarAbortController.signal;

    viewerModeBar.addEventListener('mouseenter', () => {
        // Ignore mouse events immediately after entering fullscreen
        if (Date.now() < ignoreMouseEventsUntil) return;
        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Mouse entered viewer bar, stopping timer');
        stopViewerBarAutoHideTimer();
        showViewerControlBar();
    }, { signal });

    // Restart timer when mouse leaves the control bar
    viewerModeBar.addEventListener('mouseleave', () => {
        // Ignore mouse events immediately after entering fullscreen
        if (Date.now() < ignoreMouseEventsUntil) return;
        const isFullscreen = isFullscreenActive();
        const isF11FullscreenMode = isF11Fullscreen();
        const isAnyFullscreen = isFullscreen || isF11FullscreenMode;

        logger.debug('FULLSCREEN_LOG', 'Fullscreen', 'Mouse left viewer bar:', { isFullscreen, isF11Fullscreen: isF11FullscreenMode, isAnyFullscreen, viewerMode: state.viewerMode });

        if (isAnyFullscreen && state.viewerMode) {
            startViewerBarAutoHideTimer();
        }
    }, { signal });
}

/**
 * Clean up fullscreen system resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guards)
 */
export function cleanupFullscreenSystem() {
    // Remove window event listeners
    if (fullscreenEventAbortController) {
        fullscreenEventAbortController.abort();
        fullscreenEventAbortController = null;
    }

    // Remove viewer bar event listeners
    if (viewerBarAbortController) {
        viewerBarAbortController.abort();
        viewerBarAbortController = null;
    }

    // Clear timers
    if (resizeCheckTimer) {
        clearTimeout(resizeCheckTimer);
        resizeCheckTimer = null;
    }
    if (initialCheckTimer) {
        clearTimeout(initialCheckTimer);
        initialCheckTimer = null;
    }
    stopViewerBarAutoHideTimer();

    // Clear DOM references
    uiContainerEl = null;
    statusPanelEl = null;

    // Reset flags
    fullscreenListenersAttached = false;
}

/**
 * Initialize fullscreen system
 */
export function setupFullscreenSystem() {
    // DOM element cache
    uiContainerEl = document.getElementById('ui-container');
    statusPanelEl = document.getElementById('status-panel');

    // Initialize AbortController (abort existing one if present)
    if (fullscreenEventAbortController) {
        fullscreenEventAbortController.abort();
    }
    fullscreenEventAbortController = new AbortController();
    const signal = fullscreenEventAbortController.signal;

    // Register fullscreenchange listeners with the current signal.
    // The old AbortController was already aborted above, which removes previous listeners,
    // so we always re-register here with the new signal.
    document.addEventListener('fullscreenchange', handleFullscreenChange, { signal });
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange, { signal });
    document.addEventListener('mozfullscreenchange', handleFullscreenChange, { signal });
    // MS-prefixed variant for legacy Edge/IE11. isFullscreenActive()/requestFullscreenCompat()
    // already honor msFullscreenElement/msRequestFullscreen, so the matching change event
    // must be subscribed too, otherwise handleFullscreenChange never fires on those engines.
    document.addEventListener('MSFullscreenChange', handleFullscreenChange, { signal });
    fullscreenListenersAttached = true;

    // Check fullscreen state on resize events (e.g., F11 toggles)
    // Prevent timer accumulation with debounce
    window.addEventListener('resize', () => {
        // Invalidate cached bounding rect (position changes on resize)
        cachedBarRect = null;

        const heightChanged = Math.abs(window.innerHeight - lastInnerHeight) > 100;
        const widthChanged = Math.abs(window.innerWidth - lastInnerWidth) > 100;

        if (heightChanged || widthChanged) {
            lastInnerHeight = window.innerHeight;
            lastInnerWidth = window.innerWidth;

            // Clear existing timer (prevent accumulation)
            if (resizeCheckTimer) {
                clearTimeout(resizeCheckTimer);
            }
            // Set a new timer
            resizeCheckTimer = setTimeout(() => {
                checkBrowserFullscreen();
                resizeCheckTimer = null;
            }, 50);
        }
    }, { signal });

    // Initial check (already fullscreen on page load)
    initialCheckTimer = setTimeout(() => {
        checkBrowserFullscreen();
        initialCheckTimer = null;
    }, 100);

    // Mouse move event (detect bottom hover)
    document.addEventListener('mousemove', handleMouseMove, { signal });

    // Mobile touch events
    document.addEventListener('touchstart', handleTouchStart, { passive: true, signal });
    document.addEventListener('touchend', handleTouchEnd, { passive: true, signal });
    document.addEventListener('touchmove', handleTouchMove, { passive: true, signal });

    // Viewer bar hover events
    setupViewerBarHoverEvents();
}
