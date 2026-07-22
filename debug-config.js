/**
 * debug-config.js
 * Logging configuration - single source of truth for debug mode
 *
 * Environment modes:
 * - DEVELOPMENT: All debug flags enabled (default for local development)
 * - PRODUCTION: Only ERROR/WARN/INFO enabled (set by GitHub Actions)
 *
 * Runtime override:
 * - Use localStorage.setItem('DEBUG_MODE', 'DEVELOPMENT') to enable debug logs
 * - Use localStorage.setItem('DEBUG_MODE', 'PRODUCTION') to test production behavior
 * - Reload page after changing mode
 *
 * This file is automatically overwritten by GitHub Actions during deployment.
 */

// Environment mode: 'DEVELOPMENT' or 'PRODUCTION'
// DEVELOPMENT: All debug/audit logs enabled (default for local development)
// PRODUCTION: Only error/warn/info logs enabled (set by GitHub Actions)
var DEBUG_MODE = 'DEVELOPMENT';

// Master switch for all debug/audit logs
// Set to false in production builds to eliminate debug code paths
var DEBUG_ENABLED = true;
