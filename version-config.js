/**
 * version-config.js
 * Single source of truth for app version constants.
 *
 * Consumed by:
 *   - sw.js          via importScripts('./version-config.js')
 *   - index.html     via <script src="./version-config.js">
 *   - js/version.js  re-exports globalThis values for ES module consumers
 *
 * GitHub Actions replaces these values when a release tag is pushed.
 * See .github/workflows/release-deploy.yml
 *
 * Default values are used during development.
 */
var APP_VERSION = '0.0.0-dev';
var BUILD_DATE = '';
var COMMIT_SHA = '';
