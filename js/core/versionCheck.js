/**
 * versionCheck.js
 * Check the online version and notify when updates are available
 */

import { APP_VERSION, CONFIG_LOADED } from '../version.js';
import * as logger from '../utils/logger.js';
import { safeLocalStorageGet, safeLocalStorageSet, safeLocalStorageRemove } from '../utils/safe-storage.js';

// Version check settings
const VERSION_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
// On transient errors (network, server unavailable) retry after 1 hour instead of
// waiting the full 24-hour interval. Prevents stale "version unknown" states after
// brief connectivity issues.
const VERSION_CHECK_RETRY_INTERVAL = 60 * 60 * 1000; // 1 hour (on error)
const VERSION_FETCH_TIMEOUT_MS = 5 * 1000; // 5 seconds (abort if version.json takes too long)
const VERSION_JSON_URL = './version.json';
const LAST_CHECK_KEY = 'lastVersionCheck';
const LAST_CHECK_FAILED_KEY = 'lastVersionCheckFailed'; // flag written on transient error
const DISMISSED_VERSION_KEY = 'dismissedVersion';

/**
 * Parse version string into components
 * @param {string} version - Version string (e.g. "1.2.3-beta.1+build.123")
 * @returns {Object} - Parsed version components
 */
function parseVersion(version) {
    // Remove the "v" prefix if present
    const cleaned = version.replace(/^v/, '');

    // Split by '+' to separate build metadata (we ignore it per SemVer spec)
    const withoutBuild = cleaned.split('+')[0];

    // Split by '-' to separate pre-release identifiers
    const parts = withoutBuild.split('-');
    // Parse core components strictly. A plain Number() on a malformed component such
    // as "3rc1" (a missing '-' before the prerelease tag) yields NaN, which the
    // "|| 0" fallbacks below then silently turn into 0 — so "1.2.3rc1" would read as
    // 1.2.0 and a client on 1.2.2 would see itself as newer and suppress the update
    // banner. Salvage any leading integer instead and warn so the build issue is
    // visible.
    const coreParts = parts[0].split('.').map((s) => {
        const n = Number(s);
        if (Number.isInteger(n) && n >= 0) {
            return n;
        }
        const salvaged = parseInt(s, 10);
        logger.warn('VersionCheck', `Malformed version core component "${s}" in "${version}"`);
        return Number.isFinite(salvaged) ? salvaged : 0;
    });

    // Split pre-release identifiers by '.' for proper SemVer comparison
    // e.g. "1.0.0-beta.9" → prerelease: ["beta", "9"] (not ["beta.9"])
    const prereleaseStr = parts.slice(1).join('-'); // rejoin in case of multiple '-'
    return {
        major: coreParts[0] || 0,
        minor: coreParts[1] || 0,
        patch: coreParts[2] || 0,
        prerelease: prereleaseStr ? prereleaseStr.split('.') : []
    };
}

/**
 * Compare pre-release identifiers according to SemVer spec
 * @param {Array<string>} pre1 - Pre-release identifiers for v1
 * @param {Array<string>} pre2 - Pre-release identifiers for v2
 * @returns {number} - 1 if pre1 > pre2, -1 if pre1 < pre2, 0 if equal
 */
function comparePrereleases(pre1, pre2) {
    // Per SemVer: version without pre-release is GREATER than version with pre-release
    if (pre1.length === 0 && pre2.length > 0) return 1;  // 1.0.0 > 1.0.0-alpha
    if (pre1.length > 0 && pre2.length === 0) return -1; // 1.0.0-alpha < 1.0.0

    // Both have no pre-release
    if (pre1.length === 0 && pre2.length === 0) return 0;

    // Compare each pre-release identifier from left to right
    const maxLength = Math.max(pre1.length, pre2.length);
    for (let i = 0; i < maxLength; i++) {
        // Per SemVer: larger set of pre-release fields has higher precedence
        if (i >= pre1.length) return -1; // 1.0.0-alpha < 1.0.0-alpha.1
        if (i >= pre2.length) return 1;  // 1.0.0-alpha.1 > 1.0.0-alpha

        const id1 = pre1[i];
        const id2 = pre2[i];

        // Check if both are numeric
        const num1 = parseInt(id1, 10);
        const num2 = parseInt(id2, 10);
        const isNum1 = !isNaN(num1) && num1.toString() === id1;
        const isNum2 = !isNaN(num2) && num2.toString() === id2;

        if (isNum1 && isNum2) {
            // Both numeric: compare as integers
            if (num1 > num2) return 1;
            if (num1 < num2) return -1;
        } else if (isNum1 && !isNum2) {
            // Numeric identifiers always have lower precedence than alphanumeric
            return -1; // 1.0.0-1 < 1.0.0-alpha
        } else if (!isNum1 && isNum2) {
            return 1; // 1.0.0-alpha > 1.0.0-1
        } else {
            // Both alphanumeric: compare lexically (ASCII sort order)
            if (id1 > id2) return 1;
            if (id1 < id2) return -1;
        }
    }

    return 0;
}

/**
 * Compare semantic version strings (SemVer 2.0.0 compliant)
 * @param {string} v1 - Version string (e.g. "1.2.3", "1.2.3-beta.1+build.123")
 * @param {string} v2 - Version string (e.g. "1.2.4")
 * @returns {number} - 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 *
 * Examples:
 *   compareVersions("1.0.0", "1.0.0-alpha") => 1   (release > prerelease)
 *   compareVersions("1.0.0-alpha", "1.0.0-beta") => -1  (alpha < beta)
 *   compareVersions("1.0.0-rc.1", "1.0.0-rc.2") => -1   (1 < 2)
 *   compareVersions("1.0.0+build.1", "1.0.0+build.2") => 0  (build metadata ignored)
 */
export function compareVersions(v1, v2) {
    const parsed1 = parseVersion(v1);
    const parsed2 = parseVersion(v2);

    // Compare major.minor.patch
    if (parsed1.major > parsed2.major) return 1;
    if (parsed1.major < parsed2.major) return -1;

    if (parsed1.minor > parsed2.minor) return 1;
    if (parsed1.minor < parsed2.minor) return -1;

    if (parsed1.patch > parsed2.patch) return 1;
    if (parsed1.patch < parsed2.patch) return -1;

    // If major.minor.patch are equal, compare pre-release identifiers
    return comparePrereleases(parsed1.prerelease, parsed2.prerelease);
}

/**
 * Check last check time and decide whether a check is needed
 * Uses a shorter retry interval when the previous attempt failed transiently.
 * @returns {boolean} - True if a check is needed
 */
function shouldCheckUpdate() {
    const lastCheck = safeLocalStorageGet(LAST_CHECK_KEY);

    if (!lastCheck) {
        return true; // First check or localStorage unavailable
    }

    const now = Date.now();
    const lastCheckTime = parseInt(lastCheck, 10);

    // Corrupt values and clocks moved far into the future must not suppress
    // update checks indefinitely.
    if (!Number.isFinite(lastCheckTime) || lastCheckTime < 0 || lastCheckTime > now) {
        return true;
    }

    // If the last attempt failed, use the shorter retry interval
    const previousFailed = safeLocalStorageGet(LAST_CHECK_FAILED_KEY) === '1';
    const interval = previousFailed ? VERSION_CHECK_RETRY_INTERVAL : VERSION_CHECK_INTERVAL;

    return (now - lastCheckTime) >= interval;
}

/**
 * Fetch the online version
 * @returns {Promise<Object>} - Version info object { version, buildDate, commitSha }
 */
export async function fetchOnlineVersion() {
    const controller = new AbortController();
    // Use AbortSignal directly instead of a separate fetchCompleted flag
    // to avoid TOCTOU race between timeout check and flag set
    const timeoutId = setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);

    try {
        // Fetch latest version info without caching
        const response = await fetch(VERSION_JSON_URL, {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch version.json: ${response.status}`);
        }

        return await response.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Version check timeout after ${VERSION_FETCH_TIMEOUT_MS}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
    }
}

/**
 * Run version check and dispatch an event if a new version is available
 * @param {boolean} force - Force check even in dev mode and ignore time interval
 * @returns {Promise<void>}
 */
export async function checkForUpdates(force = false) {
    // Check if debug mode is enabled via URL parameter
    const urlParams = new URLSearchParams(window.location.search);
    const debugMode = urlParams.has('debugVersionCheck');

    // Skip version check in development (0.0.0-dev) unless forced or in debug mode.
    // Require CONFIG_LOADED so this only skips a GENUINE dev build. If
    // version-config.js failed to load in a deployed build, APP_VERSION is also
    // '0.0.0-dev' but CONFIG_LOADED is false — we then proceed, and the fallback
    // version compares older than the real online version, surfacing the update
    // banner so a reload re-fetches the config (self-healing) instead of silently
    // disabling update checks forever.
    if (APP_VERSION === '0.0.0-dev' && CONFIG_LOADED && !force && !debugMode) {
        logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'Development mode, skipping version check');
        logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'To test version check in dev mode, use:');
        logger.debug('VERSION_CHECK_LOG', 'VersionCheck', '  - forceCheckForUpdates() in console');
        logger.debug('VERSION_CHECK_LOG', 'VersionCheck', '  - Add ?debugVersionCheck=true to URL');
        return;
    }

    // Check whether a version check is needed (skip if forced)
    if (!force && !shouldCheckUpdate()) {
        logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'Version check skipped (last check was recent)');
        return;
    }

    try {
        logger.info('VersionCheck', 'Checking for updates...');
        logger.info('VersionCheck', 'Current version:', APP_VERSION);

        const onlineVersionData = await fetchOnlineVersion();

        // Error handling when version info cannot be fetched
        if (!onlineVersionData || !onlineVersionData.version) {
            logger.warn('VersionCheck', 'Invalid version data received:', onlineVersionData);
            // Treat malformed version.json (200 with valid JSON but no usable version)
            // as a failed check: record the timestamp and set the failure flag, so
            // shouldCheckUpdate() applies the short retry interval instead of re-fetching
            // on every page load. A first-time visitor has no LAST_CHECK, so without
            // this the fetch would repeat unthrottled on every load until valid data
            // appears. Mirrors the offline branch and the catch below.
            safeLocalStorageSet(LAST_CHECK_KEY, Date.now().toString());
            safeLocalStorageSet(LAST_CHECK_FAILED_KEY, '1');
            return;
        }

        // Offline marker from the Service Worker fallback: treat as a failed check
        // (use the short retry interval) rather than a successful check, so we don't
        // record a bogus "offline" version or suppress retries for 24 hours.
        if (onlineVersionData.offline === true || onlineVersionData.version === 'offline') {
            logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'Offline version.json received; treating as failed check');
            safeLocalStorageSet(LAST_CHECK_KEY, Date.now().toString());
            safeLocalStorageSet(LAST_CHECK_FAILED_KEY, '1');
            return;
        }

        const onlineVersion = onlineVersionData.version;

        logger.info('VersionCheck', 'Online version:', onlineVersion);

        // Compare versions
        const comparison = compareVersions(onlineVersion, APP_VERSION);

        if (comparison > 0) {
            // Online version is newer
            logger.info('VersionCheck', `New version available: ${onlineVersion} (current: ${APP_VERSION})`);

            // Check if this version notification was already dismissed
            const dismissedVersion = safeLocalStorageGet(DISMISSED_VERSION_KEY);
            if (dismissedVersion === onlineVersion) {
                logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'Update notification was dismissed for this version');
                // This was still a successful check: record the timestamp and clear
                // any failure flag so shouldCheckUpdate() respects the normal 24h
                // interval. Otherwise, once LAST_CHECK ages out, version.json would be
                // re-fetched on every single page load until a newer version ships.
                safeLocalStorageSet(LAST_CHECK_KEY, Date.now().toString());
                safeLocalStorageRemove(LAST_CHECK_FAILED_KEY);
                return;
            }

            // Dispatch custom event so the UI shows the update notification
            // Ensure all version information is included
            const eventDetail = {
                currentVersion: APP_VERSION || '0.0.0-dev',
                latestVersion: onlineVersion || 'unknown',
                buildDate: onlineVersionData.buildDate || '',
                commitSha: onlineVersionData.commitSha || ''
            };

            logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'Dispatching version-outdated event with detail:', eventDetail);

            window.dispatchEvent(new CustomEvent('version-outdated', {
                detail: eventDetail
            }));
        } else if (comparison === 0) {
            logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'Already using the latest version');
        } else {
            logger.debug('VERSION_CHECK_LOG', 'VersionCheck', 'Current version is newer than online version (development/beta?)');
        }

        // Successful check: record timestamp and clear any previous failure flag
        safeLocalStorageSet(LAST_CHECK_KEY, Date.now().toString());
        safeLocalStorageRemove(LAST_CHECK_FAILED_KEY);

    } catch (error) {
        logger.warn('VersionCheck', 'Version check failed:', error);
        // Record timestamp so we don't spin immediately, but also set the failure
        // flag so shouldCheckUpdate() uses the shorter retry interval (1 hour)
        // rather than suppressing retries for a full 24 hours.
        safeLocalStorageSet(LAST_CHECK_KEY, Date.now().toString());
        safeLocalStorageSet(LAST_CHECK_FAILED_KEY, '1');
    }
}

/**
 * Dismiss the update notification for a specific version. This suppresses the
 * banner for THAT version until a strictly newer version ships (see the
 * `dismissedVersion === onlineVersion` check in checkVersion) — it is not a 24-hour
 * snooze. This is intentional: once the user has said "not now" to v1.2.3, they are
 * only re-notified when v1.2.4+ becomes available.
 * @param {string} version - Version to dismiss
 */
export function dismissVersionNotification(version) {
    safeLocalStorageSet(DISMISSED_VERSION_KEY, version);
    logger.debug('VERSION_CHECK_LOG', 'VersionCheck', `Version ${version} notification dismissed`);
}

/**
 * Force a version check (reset last check time and bypass dev mode check)
 * @returns {Promise<void>}
 */
export async function forceCheckForUpdates() {
    safeLocalStorageRemove(LAST_CHECK_KEY);
    safeLocalStorageRemove(LAST_CHECK_FAILED_KEY);
    return checkForUpdates(true); // Force check even in dev mode
}

// Expose the dev/test helper on window so the console hint printed in dev mode
// ("forceCheckForUpdates() in console") actually works — ES module exports are not
// global, so without this the documented call throws a ReferenceError.
if (typeof window !== 'undefined') {
    window.forceCheckForUpdates = forceCheckForUpdates;
}
