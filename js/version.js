// Re-export version constants from shared config (version-config.js)
// version-config.js is loaded as a classic <script> tag in index.html,
// making APP_VERSION / BUILD_DATE / COMMIT_SHA available on globalThis.
//
// GitHub Actions updates version-config.js on release — this file needs no changes.
// True only when version-config.js actually executed and defined the globals.
// Local development still sets APP_VERSION to the string '0.0.0-dev', so this is
// true there too; it is false ONLY when the config script failed to load
// (script error, extension blocking, cache eviction of that one file). Consumers
// use it to tell a genuine dev build ('0.0.0-dev' + loaded) apart from a deployed
// build whose version was lost, so the latter does not get silently treated as dev.
export const CONFIG_LOADED = typeof globalThis.APP_VERSION === 'string';
export const APP_VERSION = globalThis.APP_VERSION || '0.0.0-dev';
export const BUILD_DATE = globalThis.BUILD_DATE || '';
export const COMMIT_SHA = globalThis.COMMIT_SHA || '';
