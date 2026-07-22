/**
 * ui-update-notification.js
 * Manage the application update notification UI
 */

import { dismissVersionNotification, fetchOnlineVersion, compareVersions } from '../core/versionCheck.js';
import { APP_VERSION, BUILD_DATE, COMMIT_SHA, CONFIG_LOADED } from '../version.js';
import * as logger from '../utils/logger.js';

// Resolve i18n text with an English default. This module is intentionally started
// before i18n finishes loading (main.js), so a plain window.t?.(key) ?? 'English'
// would render the raw key: the pre-init t() returns the key (a truthy string), so
// ?? never engages. Passing the English string as i18next's defaultValue makes it
// win both before init (see js/i18n.js pre-init fallback) and after (native
// i18next), while ?? still covers the case where window.t is entirely undefined.
function tr(key, defaultValue, options) {
    return window.t?.(key, { ...options, defaultValue }) ?? defaultValue;
}

// AbortController for managing event listeners (prevent memory leaks)
let updateNotificationEventAbortController = null;

// Prevents exceptions in Safari Private Browsing and other restricted environments
function safeSessionStorageSet(key, value) {
    try {
        sessionStorage.setItem(key, value);
        return true;
    } catch (err) {
        logger.warn('UpdateNotification', 'sessionStorage write failed:', err.message);
        return false;
    }
}

function safeSessionStorageGet(key) {
    try {
        return sessionStorage.getItem(key);
    } catch (err) {
        logger.warn('UpdateNotification', 'sessionStorage read failed:', err.message);
        return null;
    }
}

function safeSessionStorageRemove(key) {
    try {
        sessionStorage.removeItem(key);
        return true;
    } catch (err) {
        logger.warn('UpdateNotification', 'sessionStorage remove failed:', err.message);
        return false;
    }
}

function safeLocalStorageRemove(key) {
    try {
        localStorage.removeItem(key);
        return true;
    } catch (err) {
        logger.warn('UpdateNotification', 'localStorage remove failed:', err.message);
        return false;
    }
}

function safeLocalStorageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (err) {
        logger.warn('UpdateNotification', 'localStorage read failed:', err.message);
        return null;
    }
}

// Dismissal keys. dismissedVersion is shared with the version-check flow
// (versionCheck.js): dismissing EITHER banner records the version here so neither
// re-notifies for it until a strictly newer version ships or "Update now" is
// clicked. The session key is the fallback for a Service-Worker banner whose target
// version is unknown (version.json was unreachable), so "Later" still stops the
// per-reload nagging without stranding the dismissal across browser sessions.
const DISMISSED_VERSION_KEY = 'dismissedVersion';
const SW_UPDATE_DISMISSED_SESSION_KEY = 'swUpdateDismissedSession';

// True when the user already dismissed this Service-Worker update via "Later".
// Without this, the banner reappears on every reload: a downloaded worker stays
// waiting across soft reloads (it activates only on SKIP_WAITING or once all tabs
// close), and sw-register.js re-dispatches 'sw-update-available' on each page load.
function isSwUpdateDismissed(latestVersion) {
    if (latestVersion) {
        return safeLocalStorageGet(DISMISSED_VERSION_KEY) === latestVersion;
    }
    return safeSessionStorageGet(SW_UPDATE_DISMISSED_SESSION_KEY) === '1';
}

// A build fingerprint that changes even when the SemVer string does not — e.g. a
// same-tag rebuild on the same commit (only BUILD_DATE differs; see sw.js's
// CACHE_REVISION note). The post-reload check uses it so such a rebuild is
// recognized as a successful update instead of a false "update may have failed".
function currentBuildFingerprint() {
    return `${COMMIT_SHA || ''}|${BUILD_DATE || ''}`;
}

let updateBanner = null;
let currentUpdateInfo = null;
let updateNotificationInitialized = false;

/**
 * Initialize the update notification UI
 * Set up event listeners and monitor update events
 */
export function initUpdateNotification() {
    if (updateNotificationInitialized) return;
    updateNotificationInitialized = true;

    // Initialize AbortController (abort existing one if present)
    if (updateNotificationEventAbortController) {
        updateNotificationEventAbortController.abort();
    }
    updateNotificationEventAbortController = new AbortController();
    const signal = updateNotificationEventAbortController.signal;

    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Initializing update notification UI');

    // Clean up cache-busting query parameter from URL if present
    cleanupCacheBustingParam();

    // Check if we just reloaded after an update attempt
    checkPostReloadUpdate();

    // Detect Service Worker updates
    window.addEventListener('sw-update-available', async (event) => {
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'SW update detected');
        const { registration } = event.detail;

        // Try to fetch the online version to display version info
        let latestVersion = null;
        try {
            const versionData = await fetchOnlineVersion();
            // Ignore the offline fallback marker — a waiting SW is already downloaded,
            // so we must still show the banner even if version.json is unreachable.
            if (versionData?.offline !== true && versionData?.version !== 'offline') {
                latestVersion = versionData?.version || null;
            }
            logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Fetched latest version for SW update:', latestVersion);
        } catch (err) {
            logger.warn('UpdateNotification', 'Could not fetch version info for SW update:', err.message);
        }

        // Skip notification if fetched version is not newer than the current version.
        // But a genuinely-installed waiting worker (a same-SemVer rebuild via
        // CACHE_REVISION, or a stale/unreachable version.json) must still surface the
        // banner, otherwise the already-downloaded worker is stranded until every tab
        // is closed. Only apply the version-gate when no worker is actually waiting.
        if (latestVersion && APP_VERSION && APP_VERSION !== '0.0.0-dev' && !registration?.waiting) {
            if (compareVersions(latestVersion, APP_VERSION) <= 0) {
                logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'SW updated but version is not newer (current:', APP_VERSION, ', online:', latestVersion, '). Skipping notification.');
                return;
            }
        }

        // Respect an explicit "Later" so the banner does not reappear on every
        // reload while the downloaded worker stays waiting (see isSwUpdateDismissed).
        // "Update now" clears these keys, so a future genuine update is not suppressed.
        if (isSwUpdateDismissed(latestVersion)) {
            logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'SW update was dismissed earlier; not re-showing banner.');
            return;
        }

        showUpdateNotification({
            type: 'service-worker',
            message: latestVersion
                ? tr('update.newVersionAvailableWithNumber', `A new version ${latestVersion} is available`, { version: latestVersion })
                : tr('update.newVersionAvailable', 'A new version is available'),
            registration: registration,
            currentVersion: APP_VERSION,
            latestVersion: latestVersion
        });
    }, { signal });

    // Detect via version check
    window.addEventListener('version-outdated', (event) => {
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Version outdated detected');

        // Safely extract version info from event detail
        const detail = event.detail || {};
        const currentVersion = detail.currentVersion || APP_VERSION;
        const latestVersion = detail.latestVersion || 'unknown';
        const buildDate = detail.buildDate || '';

        // Log version info to help debugging
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Current version:', currentVersion);
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Latest version:', latestVersion);

        showUpdateNotification({
            type: 'version-check',
            message: tr('update.newVersionAvailableWithNumber', `A new version ${latestVersion} is available`, { version: latestVersion }),
            currentVersion: currentVersion,
            latestVersion: latestVersion,
            buildDate: buildDate
        });
    }, { signal });
}

/**
 * Clean up the cache-busting query parameter from URL to prevent bookmark pollution
 * This removes the ?_t= parameter added during update reload
 */
function cleanupCacheBustingParam() {
    const url = new URL(window.location.href);

    // Check if the _t parameter exists
    if (url.searchParams.has('_t')) {
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Removing cache-busting parameter from URL');

        // Remove the _t parameter
        url.searchParams.delete('_t');

        // Replace the URL with the History API without reloading
        // This prevents the query string from being bookmarked
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    }
}

/**
 * Check if an update was attempted and verify if it succeeded
 * If the update failed, show instructions for hard reload
 */
function checkPostReloadUpdate() {
    const pendingVersion = safeSessionStorageGet('pendingUpdateVersion');       // target (for display), may be null
    const fromVersion = safeSessionStorageGet('pendingUpdateFromVersion');       // pre-reload version
    const fromBuild = safeSessionStorageGet('pendingUpdateFromBuild');           // pre-reload build fingerprint

    if (!pendingVersion && !fromVersion) {
        return; // No pending update
    }

    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Checking post-reload update. From:', fromVersion, 'Expected:', pendingVersion, 'Current:', APP_VERSION);

    // Remove the pending update flags
    safeSessionStorageRemove('pendingUpdateVersion');
    safeSessionStorageRemove('pendingUpdateFromVersion');
    safeSessionStorageRemove('pendingUpdateFromBuild');

    // Never verify on a dev build (its version is a sentinel).
    if (APP_VERSION === '0.0.0-dev') {
        return;
    }

    // Prefer the robust "did the running build actually change?" check: the
    // activated version (esp. via Service Worker SKIP_WAITING) is the waiting
    // worker's, which need not equal version.json's latest, so an equality check
    // against the target gave false "update failed" results.
    //
    // Treat a changed build fingerprint (COMMIT_SHA/BUILD_DATE) as success too, not
    // just a changed SemVer string: a same-SemVer rebuild (same tag/commit re-pushed,
    // only BUILD_DATE differs — a case sw.js's CACHE_REVISION supports and the SW
    // banner deliberately surfaces) keeps APP_VERSION identical, so a version-only
    // check would misreport a successful rebuild as a failure.
    //
    // Fall back to exact-target matching only when the pre-reload version was not
    // recorded (e.g. a retry path that skips recording it).
    const currentBuild = currentBuildFingerprint();
    const buildChanged = fromBuild ? (fromBuild !== currentBuild) : false;
    const updateApplied = fromVersion
        ? (APP_VERSION !== fromVersion || buildChanged)
        : (APP_VERSION === pendingVersion);

    if (!updateApplied) {
        logger.warn('UpdateNotification', 'Update may have failed. Current version:', APP_VERSION, 'From:', fromVersion, 'Expected:', pendingVersion);

        // Show hard reload instruction after a short delay to ensure the page is fully loaded
        setTimeout(() => {
            showHardReloadInstruction(APP_VERSION, pendingVersion || APP_VERSION);
        }, 1000);
    } else {
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Update successful!');
    }
}

/**
 * Show instructions for performing a hard reload
 * @param {string} currentVersion - Current version
 * @param {string} expectedVersion - Expected version after update
 */
function showHardReloadInstruction(currentVersion, expectedVersion) {
    // Don't show if a banner is already visible
    if (updateBanner && document.body.contains(updateBanner)) {
        return;
    }

    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Showing hard reload instruction');

    // Create the banner HTML element
    updateBanner = document.createElement('div');
    updateBanner.className = 'update-notification-banner update-failed-banner';

    const content = document.createElement('div');
    content.className = 'update-notification-content';

    const icon = document.createElement('div');
    icon.className = 'update-notification-icon';
    icon.textContent = '⚠️';

    const textContainer = document.createElement('div');
    textContainer.className = 'update-notification-text';

    const message = document.createElement('div');
    message.className = 'update-notification-message';
    message.textContent = tr('update.updateMayHaveFailed', 'The update may not have been applied successfully');

    const versionInfo = document.createElement('div');
    versionInfo.className = 'update-notification-version-info';

    const currentLabel = document.createElement('span');
    currentLabel.className = 'version-label';
    currentLabel.textContent = tr('update.currentVersion', 'Current:');

    const currentValue = document.createElement('span');
    currentValue.className = 'version-value';
    currentValue.textContent = currentVersion;

    const expectedLabel = document.createElement('span');
    expectedLabel.className = 'version-label';
    expectedLabel.textContent = tr('update.expectedVersion', 'Expected:');

    const expectedValue = document.createElement('span');
    expectedValue.className = 'version-value version-value-highlight';
    expectedValue.textContent = expectedVersion;

    versionInfo.appendChild(currentLabel);
    versionInfo.appendChild(currentValue);
    versionInfo.appendChild(document.createTextNode(' '));
    versionInfo.appendChild(expectedLabel);
    versionInfo.appendChild(expectedValue);

    const instruction = document.createElement('div');
    instruction.className = 'update-notification-instruction';

    // Detect OS for appropriate keyboard shortcut
    // Use navigator.userAgentData (modern) with navigator.platform fallback (deprecated but widely supported)
    const isMac = navigator.userAgentData
        ? /macOS/i.test(navigator.userAgentData.platform)
        : /Mac|iPhone|iPod|iPad/i.test(navigator.platform);
    const shortcut = isMac ? 'Cmd+Shift+R' : 'Ctrl+Shift+R';

    instruction.textContent = tr('update.hardReloadInstruction', `Please try a hard reload (${shortcut}) or click the button below to try again`, { shortcut });

    textContainer.appendChild(message);
    textContainer.appendChild(versionInfo);
    textContainer.appendChild(instruction);

    const actions = document.createElement('div');
    actions.className = 'update-notification-actions';

    const retryBtn = document.createElement('button');
    retryBtn.className = 'update-notification-btn update-notification-btn-primary';
    retryBtn.textContent = tr('update.tryAgain', 'Try Again');
    retryBtn.addEventListener('click', () => {
        // Store the pre-reload version too, so the post-reload check uses the robust
        // "did the version change?" test instead of exact-target matching. Without
        // it, a retry that activates a waiting worker whose version differs from
        // version.json's latest is misreported as a failed update. Mirrors
        // handleUpdateNow().
        if (APP_VERSION && APP_VERSION !== '0.0.0-dev') {
            safeSessionStorageSet('pendingUpdateFromVersion', APP_VERSION);
            safeSessionStorageSet('pendingUpdateFromBuild', currentBuildFingerprint());
        }
        // Store the expected version again
        safeSessionStorageSet('pendingUpdateVersion', expectedVersion);
        // Try reload again
        window.location.reload();
    });

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'update-notification-btn update-notification-btn-secondary';
    dismissBtn.textContent = tr('update.dismiss', 'Dismiss');
    dismissBtn.addEventListener('click', () => {
        hideUpdateNotification();
    });

    actions.appendChild(retryBtn);
    actions.appendChild(dismissBtn);

    content.appendChild(icon);
    content.appendChild(textContainer);
    content.appendChild(actions);
    updateBanner.appendChild(content);

    document.body.appendChild(updateBanner);

    // Fade-in animation
    requestAnimationFrame(() => {
        updateBanner.classList.add('show');
    });
}

/**
 * Display the update notification banner
 * XSS protection: insert text safely using textContent
 * @param {Object} updateInfo - Update information
 */
function showUpdateNotification(updateInfo) {
    // If a banner is already shown, only allow an *upgrade* from a version-check
    // banner to a service-worker banner. A service-worker banner coordinates with a
    // downloaded, waiting worker (safe SKIP_WAITING activation that preserves the new
    // precache), whereas a version-check banner has no SW coordination. Letting a
    // version-check banner supersede a service-worker one would route the user into
    // the aggressive cache-clear path and wipe the waiting worker's fresh shell.
    if (updateBanner && document.body.contains(updateBanner)) {
        const existingIsServiceWorker = currentUpdateInfo?.type === 'service-worker';
        const incomingIsServiceWorker = updateInfo?.type === 'service-worker';

        if (!existingIsServiceWorker && incomingIsServiceWorker) {
            hideUpdateNotificationImmediate();
        } else {
            logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Banner already visible');
            return;
        }
    }

    currentUpdateInfo = updateInfo;

    // Create the banner HTML element (XSS protection: use DOM API)
    updateBanner = document.createElement('div');
    updateBanner.className = 'update-notification-banner';

    const content = document.createElement('div');
    content.className = 'update-notification-content';

    const icon = document.createElement('div');
    icon.className = 'update-notification-icon';
    icon.textContent = '🔄';

    const textContainer = document.createElement('div');
    textContainer.className = 'update-notification-text';

    const message = document.createElement('div');
    message.className = 'update-notification-message';
    message.textContent = updateInfo.message;

    textContainer.appendChild(message);

    // Display version information when version data is available
    if (updateInfo.currentVersion || updateInfo.latestVersion) {
        // Use fallback values if version info is missing
        const currentVersion = updateInfo.currentVersion || APP_VERSION || 'unknown';
        const latestVersion = updateInfo.latestVersion || 'unknown';

        // Always show version info for version-check type updates
        const versionInfo = document.createElement('div');
        versionInfo.className = 'update-notification-version-info';

        const currentVersionLabel = document.createElement('span');
        currentVersionLabel.className = 'version-label';
        currentVersionLabel.textContent = tr('update.currentVersion', 'Current:');

        const currentVersionValue = document.createElement('span');
        currentVersionValue.className = 'version-value';
        currentVersionValue.textContent = currentVersion;

        const latestVersionLabel = document.createElement('span');
        latestVersionLabel.className = 'version-label';
        latestVersionLabel.textContent = tr('update.latestVersion', 'Latest:');

        const latestVersionValue = document.createElement('span');
        latestVersionValue.className = 'version-value version-value-highlight';
        latestVersionValue.textContent = latestVersion;

        versionInfo.appendChild(currentVersionLabel);
        versionInfo.appendChild(currentVersionValue);
        versionInfo.appendChild(document.createTextNode(' '));
        versionInfo.appendChild(latestVersionLabel);
        versionInfo.appendChild(latestVersionValue);

        textContainer.appendChild(versionInfo);

        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Version info displayed - Current:', currentVersion, 'Latest:', latestVersion);
    }

    if (updateInfo.buildDate) {
        const buildInfo = document.createElement('div');
        buildInfo.className = 'update-notification-build-info';
        buildInfo.textContent = tr('update.buildDate', `Build date: ${updateInfo.buildDate}`, { date: updateInfo.buildDate });
        textContainer.appendChild(buildInfo);
    }

    const actions = document.createElement('div');
    actions.className = 'update-notification-actions';

    const updateNowBtn = document.createElement('button');
    updateNowBtn.id = 'updateNowBtn';
    updateNowBtn.className = 'update-notification-btn update-notification-btn-primary';
    updateNowBtn.textContent = tr('update.updateNow', 'Update now');

    const updateLaterBtn = document.createElement('button');
    updateLaterBtn.id = 'updateLaterBtn';
    updateLaterBtn.className = 'update-notification-btn update-notification-btn-secondary';
    updateLaterBtn.textContent = tr('update.updateLater', 'Later');

    actions.appendChild(updateNowBtn);
    actions.appendChild(updateLaterBtn);

    content.appendChild(icon);
    content.appendChild(textContainer);
    content.appendChild(actions);
    updateBanner.appendChild(content);

    // Append the banner to the body
    document.body.appendChild(updateBanner);

    // Set event listeners (attach directly to DOM elements)
    updateNowBtn.addEventListener('click', handleUpdateNow);
    updateLaterBtn.addEventListener('click', handleUpdateLater);

    // Fade-in animation
    requestAnimationFrame(() => {
        updateBanner.classList.add('show');
    });

    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Banner displayed');
}

function hideUpdateNotificationImmediate() {
    if (!updateBanner) return;

    if (updateBanner.parentNode) {
        updateBanner.parentNode.removeChild(updateBanner);
    }
    updateBanner = null;
    currentUpdateInfo = null;
}

/**
 * Handler for the "Update now" button
 */
function handleUpdateNow() {
    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'User clicked "Update Now"');

    // Record the pre-reload version so the post-reload check can verify the app
    // actually moved to a NEW version. We verify "the version changed" rather than
    // "it equals latestVersion": Service-Worker-coordinated updates (and the
    // version-check path that delegates to a waiting worker) activate the *waiting
    // worker's* version, which need not equal version.json's latest, so an equality
    // check produced spurious "update may have failed" banners. latestVersion is
    // still stored (when known) purely for display in that failure banner.
    if (APP_VERSION && APP_VERSION !== '0.0.0-dev') {
        safeSessionStorageSet('pendingUpdateFromVersion', APP_VERSION);
        safeSessionStorageSet('pendingUpdateFromBuild', currentBuildFingerprint());
    }
    if (currentUpdateInfo && currentUpdateInfo.latestVersion) {
        safeSessionStorageSet('pendingUpdateVersion', currentUpdateInfo.latestVersion);
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Stored pending update version:', currentUpdateInfo.latestVersion);
    }

    // Clear the dismissal keys so the version we're updating to isn't suppressed.
    safeLocalStorageRemove(DISMISSED_VERSION_KEY);
    safeSessionStorageRemove(SW_UPDATE_DISMISSED_SESSION_KEY);

    if (currentUpdateInfo && currentUpdateInfo.type === 'service-worker') {
        // Service Worker update path:
        // Tell the waiting worker to activate. Its activate handler already cleans up
        // stale caches and (re)populates the app-shell cache, then clients.claim()
        // triggers 'controllerchange' in sw-register.js, which reloads the page.
        //
        // IMPORTANT: do NOT delete all caches here. The waiting worker has just
        // precached the new app shell during install; wiping every cache would leave
        // the app with nothing to fall back on if the network is unavailable right
        // after reload (breaking offline updates).
        const registration = currentUpdateInfo.registration;

        if (registration && registration.waiting) {
            logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Sending SKIP_WAITING; reload will follow controllerchange');
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });

            // Fallback: if controllerchange does not fire within a few seconds
            // (e.g. the worker was already activating), reload manually.
            setTimeout(() => {
                logger.warn('UpdateNotification', 'controllerchange not observed; forcing reload');
                window.location.reload();
            }, 3000);
            return;
        }

        // No waiting worker available (it activated or was discarded between banner
        // display and click). Drive a fresh SW update (fetch + activate) rather than a
        // plain reload, which cannot apply an update under the cache-first shell —
        // same root cause as the version-check path, so reuse the same helper.
        logger.warn('UpdateNotification', 'SW update requested but no waiting worker; driving a fresh update');
        driveServiceWorkerUpdate(registration);
        return;
    }

    // Version-check path. The periodic version.json check found a newer release, but
    // the Service Worker may not have picked it up yet — the version.json check can
    // out-race the SW's own update() at load, so a waiting/installing worker often
    // does NOT exist at this point. The app shell is served cache-first (and the HTML
    // route ignores the query string), so a plain or cache-busted reload would just
    // re-serve the SAME version and then trip the "update may have failed" banner.
    // Drive a real SW update (fetch + activate) instead, so the new shell is actually
    // installed and swapped in.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((registration) => {
            driveServiceWorkerUpdate(registration);
        }).catch(() => {
            clearNonShellCachesAndReload();
        });
        return;
    }

    clearNonShellCachesAndReload();
}

/**
 * Drive a Service Worker registration to activate a new version, then let
 * sw-register.js's controllerchange handler reload the page. Used by the
 * version-check "Update now" path, where a waiting worker frequently does not exist
 * yet (the version.json check out-races the SW's own update() at load).
 *
 * Because the app shell is served cache-first, a plain reload cannot apply an
 * update — a new SW must be fetched and activated. This:
 *   - waiting worker present  -> SKIP_WAITING immediately
 *   - installing worker       -> SKIP_WAITING once it reaches 'installed'
 *   - neither                 -> registration.update() to fetch a new SW, then
 *                                SKIP_WAITING when it installs
 * and falls back to a cache-busting reload only if no new worker materializes within
 * the timeout, so the click is never a silent no-op.
 */
function driveServiceWorkerUpdate(registration) {
    if (!registration) {
        clearNonShellCachesAndReload();
        return;
    }

    let activationRequested = false;

    const requestActivation = (worker) => {
        if (activationRequested || !worker) return;
        activationRequested = true;
        logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'version-check: activating updated worker via SKIP_WAITING');
        worker.postMessage({ type: 'SKIP_WAITING' });
        // controllerchange (sw-register.js) reloads on activation; force a reload if
        // it is not observed shortly after we ask the worker to take over.
        setTimeout(() => {
            logger.warn('UpdateNotification', 'controllerchange not observed; forcing reload');
            window.location.reload();
        }, 3000);
    };

    const activateWhenInstalled = (worker) => {
        if (!worker) return;
        if (worker.state === 'installed' || worker.state === 'activating' || worker.state === 'activated') {
            requestActivation(worker);
            return;
        }
        const onStateChange = () => {
            if (worker.state === 'installed') {
                requestActivation(worker);
                worker.removeEventListener('statechange', onStateChange);
            } else if (worker.state === 'redundant') {
                // Install failed or was aborted (e.g. a network drop mid-download): this
                // worker will never reach 'installed'. Stop listening; the armed fallback
                // reload below handles the no-activation case so the click is not a
                // silent no-op, and the listener is not left dangling on a dead worker.
                worker.removeEventListener('statechange', onStateChange);
            }
        };
        worker.addEventListener('statechange', onStateChange);
    };

    // Best-effort fallback so the "Update now" click is never a silent no-op: if no
    // activation was requested within 5s (the installing worker went redundant, or no
    // new worker materialized), do a cache-busting reload.
    const armActivationFallback = () => setTimeout(() => {
        if (!activationRequested) {
            logger.warn('UpdateNotification', 'version-check: no updated worker activated; falling back to cache-busting reload');
            clearNonShellCachesAndReload();
        }
    }, 5000);

    if (registration.waiting) {
        requestActivation(registration.waiting);
        return;
    }

    if (registration.installing) {
        activateWhenInstalled(registration.installing);
        armActivationFallback();
        return;
    }

    // No pending worker: actively check for a new one and activate it once installed.
    const onUpdateFound = () => activateWhenInstalled(registration.installing);
    registration.addEventListener('updatefound', onUpdateFound);
    registration.update()
        .then(() => {
            // update() can resolve after the new worker is already waiting.
            if (registration.waiting) {
                requestActivation(registration.waiting);
            }
        })
        .catch((err) => {
            logger.warn('UpdateNotification', 'version-check: registration.update() failed:', err?.message || err);
        });

    // If no new worker materializes (bytes unreachable/unchanged, or the update
    // raced), fall back to a best-effort cache-busting reload so the click is not a
    // silent no-op.
    setTimeout(() => {
        registration.removeEventListener('updatefound', onUpdateFound);
        if (!activationRequested) {
            logger.warn('UpdateNotification', 'version-check: no updated worker found; falling back to cache-busting reload');
            clearNonShellCachesAndReload();
        }
    }, 5000);
}

/**
 * Delete stale caches and reload with a cache-busting timestamp, preserving the
 * versioned app-shell caches for the current and (if known) target versions so an
 * immediate offline navigation after reload still resolves.
 */
function clearNonShellCachesAndReload() {
    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Reloading page with cache busting...');

    const reloadWithBusting = () => {
        const url = new URL(window.location.href);
        url.searchParams.set('_t', Date.now().toString());
        window.location.href = url.toString();
    };

    if (!('caches' in window)) {
        reloadWithBusting();
        return;
    }

    // If we cannot reliably identify the running version (e.g. version-config.js
    // failed to load and APP_VERSION degraded to the '0.0.0-dev' sentinel), we cannot
    // tell the active shell cache apart from a stale one by name. Deleting the wrong
    // one would strand the app with an empty shell (503 on the next offline
    // navigation) — the very outcome the SW-coordinated path avoids. Skip deletion
    // entirely and just reload; still self-healing, without risking the active shell.
    const versionKnown = CONFIG_LOADED && APP_VERSION && APP_VERSION !== '0.0.0-dev';
    if (!versionKnown) {
        logger.warn('UpdateNotification', 'Running version unknown; skipping cache deletion to protect the active shell');
        reloadWithBusting();
        return;
    }

    // Never delete the shell caches tagged with the running version or the target
    // version. The SW cache names are `sphyrnidae-<static|runtime>-<version>-<sha>-<date>`
    // (CACHE_REVISION always appends `-<sha>-<date>` after the version), so the version
    // is delimited by '-' on both sides. Match on that delimited form rather than a bare
    // includes(): includes('1.2.3') would also preserve a '1.2.30' cache — a different,
    // stale version — leaving it for the SW to reap later instead of cleaning it here.
    // The active shell's own cache still matches (it contains `-<APP_VERSION>-`).
    const targetVersion = currentUpdateInfo?.latestVersion;
    const preserves = (name, v) => !!v && v !== '0.0.0-dev' && name.includes(`-${v}-`);
    const shouldPreserve = (name) =>
        preserves(name, APP_VERSION) || preserves(name, targetVersion);

    caches.keys().then(cacheNames => {
        return Promise.all(
            cacheNames.map(cacheName => {
                if (shouldPreserve(cacheName)) {
                    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Preserving shell cache:', cacheName);
                    return Promise.resolve(false);
                }
                logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Deleting cache:', cacheName);
                return caches.delete(cacheName);
            })
        );
    }).then(() => {
        reloadWithBusting();
    }).catch(err => {
        logger.warn('UpdateNotification', 'Cache clearing failed:', err);
        window.location.reload();
    });
}

/**
 * Handler for the "Later" button
 */
function handleUpdateLater() {
    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'User clicked "Update Later"');

    // Persist the dismissal so the banner does not reappear on every reload. Both
    // banner types mean "a newer version is available"; dismissing either suppresses
    // re-notification for that version (shared dismissedVersion key) until "Update
    // now" is clicked or a strictly newer version ships. This matters most for the
    // Service-Worker banner: its worker keeps waiting across soft reloads and
    // sw-register.js re-dispatches 'sw-update-available' on every load, so without a
    // persisted dismissal "Later" was ignored and the banner kept re-appearing.
    if (currentUpdateInfo && currentUpdateInfo.latestVersion) {
        dismissVersionNotification(currentUpdateInfo.latestVersion);
    }
    // For a Service-Worker banner, also set the session-scoped flag regardless of
    // whether the version was known when dismissed. A later *offline* reload re-fires
    // 'sw-update-available' (the worker stays waiting across soft reloads) but resolves
    // latestVersion to null because version.json is unreachable, and isSwUpdateDismissed(null)
    // can then only consult the session key — so without this the banner the user just
    // dismissed would reappear on that offline reload despite the persisted version key.
    if (currentUpdateInfo && currentUpdateInfo.type === 'service-worker') {
        safeSessionStorageSet(SW_UPDATE_DISMISSED_SESSION_KEY, '1');
    }

    // Hide the banner
    hideUpdateNotification();
}

/**
 * Hide the update notification banner
 */
function hideUpdateNotification() {
    if (!updateBanner) return;

    // Capture the specific banner being hidden. Between now and the 300ms removal
    // a newer banner may replace updateBanner (e.g. a version-check banner is
    // dismissed just as an sw-update-available event arrives and shows its own
    // banner). Without capturing, this timer would remove that NEWER banner and
    // null the shared state, silently discarding a valid update prompt.
    const banner = updateBanner;

    // Fade-out animation
    banner.classList.remove('show');

    // Remove from the DOM after the animation completes
    setTimeout(() => {
        if (banner && document.body.contains(banner)) {
            document.body.removeChild(banner);
        }
        // Only clear shared state if it still refers to the banner we hid; a newer
        // banner shown in the meantime must keep its state intact.
        if (updateBanner === banner) {
            updateBanner = null;
            currentUpdateInfo = null;
        }
    }, 300);

    logger.debug('UPDATE_NOTIFICATION_LOG', 'UpdateNotification', 'Banner hidden');
}

/**
 * Clean up update notification system resources (prevent memory leaks)
 * @idempotent Safe to call multiple times (has null guards)
 */
export function cleanupUpdateNotification() {
    // Remove event listeners
    if (updateNotificationEventAbortController) {
        updateNotificationEventAbortController.abort();
        updateNotificationEventAbortController = null;
    }
    // Reset initialization flag (allow re-init after cleanup)
    updateNotificationInitialized = false;
}
