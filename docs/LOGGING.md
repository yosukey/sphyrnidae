# Logging Policy

## Overview

To solve the problem of excessive console output, this app uses a fine-grained logging control system.

**All debug logs are enabled during development and automatically disabled during production deployment.**

## Log Levels

### ERROR (Always output)
- Critical errors that prevent functionality
- Example: rendering failures, initialization errors

### WARN (Always output)
- Non-critical issues, fallbacks, and resource warnings
- Example: EXIF read failure, WebGL context loss

### INFO (Output in normal mode)
- Important lifecycle events
- Example: app initialization complete, WebGL context restored

### DEBUG (Only when the debug flag is enabled)
- Detailed debug information
- Example: texture cache operations, material validation, format detection

### AUDIT (Only when the audit log is enabled)
- Complete action tracking
- Example: image processing start/end, format detection results

## Environment-Based Auto Switching

### Development (DEVELOPMENT mode)
Default settings in `debug-config.js`:
```javascript
var DEBUG_MODE = 'DEVELOPMENT';  // All debug logs enabled
var DEBUG_ENABLED = true;
```

### Production (PRODUCTION mode)
Automatically rewritten by GitHub Actions:
```javascript
var DEBUG_MODE = 'PRODUCTION';   // error/warn/info only
var DEBUG_ENABLED = false;
```

## DEBUG Configuration

`js/globals.js` provides fine-grained control across 20 categories. Every flag
except `RENDER_ERROR_LOG` follows `debugDefault`, so all categories are enabled
in DEVELOPMENT mode and disabled in PRODUCTION mode:

```javascript
// debugDefault = true (development) or false (production)
export const DEBUG = {
    // Core module logging
    MAIN_LOG: debugDefault,                    // App bootstrap / init lifecycle logs
    EXIF_LOG: debugDefault,                    // EXIF extraction and parsing logs
    AUDIT_LOG: debugDefault,                   // Audit trail (complete action lifecycle tracking)

    // Rendering module
    RENDER_ERROR_LOG: true,                    // Rendering critical error logs (always enabled)
    RENDER_VALIDATION_LOG: debugDefault,       // Material/texture validation detail logs
    RENDER_INFO_LOG: debugDefault,             // Renderer initialization and state logs

    // VR module
    VR_LOG: debugDefault,                      // VR initialization and session logs
    VR_DETAIL_LOG: debugDefault,               // Detailed VR button and WebXR state logs

    // Loader module
    LOADER_LOG: debugDefault,                  // Image loading lifecycle logs
    FORMAT_DETECTION_LOG: debugDefault,        // Format detection analysis logs (SBS/TaB/Interlace)
    WORKER_LOG: debugDefault,                  // Web Worker communication and processing logs

    // UI modules
    FULLSCREEN_LOG: debugDefault,              // Fullscreen mode transition logs
    UI_LOG: debugDefault,                      // General UI interaction logs
    EXPORT_LOG: debugDefault,                  // Image export operation logs
    CROP_LOG: debugDefault,                    // Crop selection and apply logs
    ALIGNMENT_LOG: debugDefault,               // Alignment pipeline selection and fallback logs

    // Network and caching
    OFFLINE_LOG: debugDefault,                 // Network status change logs
    UPDATE_NOTIFICATION_LOG: debugDefault,     // Version check and update notification logs
    VERSION_CHECK_LOG: debugDefault,           // Version fetch attempt logs
    CACHE_LOG: debugDefault                    // Service Worker cache operation logs
};
```

## Usage

### 1. Import logger

```javascript
import * as logger from './utils/logger.js';
```

### 2. Output logs

```javascript
// Error (always output)
logger.error('ModuleName', 'Error message', optionalData);

// Warning (always output)
logger.warn('ModuleName', 'Warning message', optionalData);

// Info (normal mode)
logger.info('ModuleName', 'Info message', optionalData);

// Debug (only when specific flag is enabled)
logger.debug('RENDER_VALIDATION_LOG', 'ModuleName', 'Debug message', optionalData);

// Audit (only when AUDIT_LOG is enabled)
logger.audit('ModuleName', 'Audit message', optionalData);

// EXIF (convenience helper, only when EXIF_LOG is enabled; category is fixed to 'EXIF')
logger.exif('EXIF message', optionalData);
```

### 3. Create a module-specific logger

```javascript
import { createLogger } from './utils/logger.js';

const log = createLogger('MyModule');

log.error('Error message');
log.warn('Warning message');
log.info('Info message');
log.debug('DEBUG_FLAG', 'Debug message');
log.audit('Audit message');
```

## Runtime Switching

The debug helpers (`setDebugMode()`, the global `DEBUG` object, and the
`window.StereoView.debug` namespace) are exposed **only in DEVELOPMENT mode**.
`setDebugMode()` simply writes a `DEBUG_MODE` value to `localStorage`, which
`js/globals.js` reads on the next load as an override of the `DEBUG_MODE` value
declared in `debug-config.js`. Because these helpers are unavailable once the
page reloads into PRODUCTION mode, use `localStorage` directly to switch back.

### Test production behavior locally
```javascript
// Run in console (DEVELOPMENT mode)
setDebugMode('PRODUCTION');   // equivalent to localStorage.setItem('DEBUG_MODE', 'PRODUCTION')
// Reload the page
location.reload();

// Return to development mode (helpers are no longer exposed, so use localStorage)
localStorage.setItem('DEBUG_MODE', 'DEVELOPMENT');
// or: localStorage.removeItem('DEBUG_MODE'); to fall back to the built-in default
location.reload();
```

### Enable only specific modules (DEVELOPMENT mode)
```javascript
// Disable specific logs while leaving the rest enabled
DEBUG.LOADER_LOG = false;
DEBUG.FORMAT_DETECTION_LOG = false;

// Re-enable a specific log
DEBUG.LOADER_LOG = true;
```

## Recommended Debug Settings

### Normal development
```javascript
// Do nothing -> all debug logs are enabled
```

### Testing production behavior
```javascript
setDebugMode('PRODUCTION');
location.reload();
// Only error / warn / info logs are output (debug and audit are suppressed)
```

### Debugging rendering issues
```javascript
// Automatically enabled in development mode:
// RENDER_VALIDATION_LOG: true
// RENDER_INFO_LOG: true

// To focus on rendering only, mute the other categories (DEVELOPMENT mode):
DEBUG.LOADER_LOG = false;
DEBUG.WORKER_LOG = false;
DEBUG.UI_LOG = false;
```

### Debugging file loading issues
```javascript
// Automatically enabled in development mode:
// LOADER_LOG: true
// FORMAT_DETECTION_LOG: true
// WORKER_LOG: true
```

## Implementation Details

### File Structure
1. **`/debug-config.js`** - Environment configuration file
   - Development: `DEBUG_MODE = 'DEVELOPMENT'`
   - Production: GitHub Actions rewrites `DEBUG_MODE = 'PRODUCTION'`

2. **`js/globals.js`** - DEBUG flag definitions
   - Reads settings from `debug-config.js`
   - Development mode: `debugDefault = true` (all logs ON)
   - Production mode: `debugDefault = false` (errors/warnings only)

3. **`index.html`** - Loading configuration files
   ```html
   <script src="./debug-config.js"></script>
   <script src="./version-config.js"></script>
   ```

4. **GitHub Actions** (`.github/workflows/release-deploy.yml`) - Automatic
   switching during production deployment
   - Triggered on tag push (`v*.*.*`)
   - Rewrites `debug-config.js` to PRODUCTION mode
     (`DEBUG_MODE = 'PRODUCTION'`, `DEBUG_ENABLED = false`)
   - Minifies the JavaScript with Terser (`--compress` only, no `--mangle`)

### How production logs are suppressed
Suppression is **runtime-based**, not build-time. Every `logger.debug(...)` /
`logger.audit(...)` / `logger.exif(...)` call performs its flag check inside
`logger.js` at runtime:
```javascript
// logger.js
export function debug(debugFlag, category, message, ...data) {
    if (DEBUG[debugFlag]) {              // false in PRODUCTION → nothing is logged
        console.log(`[${category}]`, message, ...data);
    }
}
```
In PRODUCTION mode `debug-config.js` sets `DEBUG_MODE = 'PRODUCTION'`, so
`debugDefault` resolves to `false` and every category flag (except
`RENDER_ERROR_LOG`) is `false`. The calls remain in the bundle but are gated off
at runtime.

> **Note:** Terser is run per file with `--compress` only and without any
> `--define` flag, so it cannot statically resolve the `DEBUG_MODE` value (it is
> read from `globalThis` at runtime in a separate classic script). Terser
> therefore reduces file size but does **not** strip the `logger.debug(...)`
> calls themselves.
