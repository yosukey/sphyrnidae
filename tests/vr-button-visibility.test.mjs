/**
 * tests/vr-button-visibility.test.mjs
 *
 * Committed, framework-free verification that the VR button survives the race
 * between the asynchronous WebXR support check and a viewer session that starts
 * during page init.
 *
 * ?src= (external image mode) begins while navigator.xr.isSessionSupported()
 * is still pending: showVRButton() therefore runs before createVRButton() has
 * created the button or set vrSupported, so the old "show it if it exists"
 * check silently dropped the request and no VR button ever appeared on a
 * headset. The request is now recorded and replayed by createVRButton().
 *
 * vr.js imports three.js and cannot be imported under Node, so this is a
 * source-text check (same approach as vr-controller-exit.test.mjs).
 *
 * Run:  node tests/vr-button-visibility.test.mjs
 * Exits non-zero if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

const readSource = (relPath) =>
    readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8');

/**
 * Drop comments so prose about a mechanism cannot stand in for the code that
 * implements it — these modules document their own handlers at length.
 * @param {string} src - JavaScript source
 * @returns {string} Source with block and line comments blanked out
 */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/**
 * Extract one top-level function body, bounded at the next top-level function
 * so a match later in the module cannot satisfy an assertion vacuously.
 * @param {string} src - Comment-stripped source
 * @param {string} header - Function header text to search for
 * @returns {string} The function body, or '' when the function is absent
 */
const functionBody = (src, header) => {
    const start = src.indexOf(header);
    if (start === -1) return '';
    const next = src.slice(start + header.length).search(/\n(?:export\s+)?function\s/);
    return next === -1 ? src.slice(start) : src.slice(start, start + header.length + next);
};

const vrSrc = stripComments(readSource('js/rendering/vr.js'));

// ---- The request is recorded, not dropped ----
{
    ok(/\blet\s+vrButtonVisibilityRequested\s*=\s*false\s*;/.test(vrSrc),
        'vr.js keeps a module-level flag for the requested VR button visibility');

    const show = functionBody(vrSrc, 'export function showVRButton()');
    ok(show !== '', 'vr.js defines showVRButton()');
    ok(/vrButtonVisibilityRequested\s*=\s*true/.test(show),
        'showVRButton() records the request even when the button does not exist yet');
    // The recording must come before the early-out condition, or a call made
    // during page init is still lost.
    ok(show.indexOf('vrButtonVisibilityRequested = true') < show.indexOf('if ('),
        'showVRButton() records the request before its vrButton/vrSupported check');

    const hide = functionBody(vrSrc, 'export function hideVRButton()');
    ok(hide !== '', 'vr.js defines hideVRButton()');
    ok(/vrButtonVisibilityRequested\s*=\s*false/.test(hide),
        'hideVRButton() withdraws the request, so a finished session cannot pop the button up later');
}

// ---- createVRButton() replays a pending request ----
{
    const create = functionBody(vrSrc, 'function createVRButton()');
    ok(create !== '', 'vr.js defines createVRButton()');
    ok(/if\s*\(\s*vrButtonVisibilityRequested\s*\)/.test(create),
        'createVRButton() checks for a request made before the support check resolved');
    ok(/\bshowVRButton\s*\(\s*\)/.test(create),
        'createVRButton() shows the button for such a request');
    // vrSupported gates showVRButton(), so the replay must happen after it is set.
    ok(create.indexOf('vrSupported = true') !== -1
        && create.indexOf('vrSupported = true') < create.indexOf('vrButtonVisibilityRequested'),
        'the replay runs after vrSupported is set, so showVRButton() is not a no-op again');
}

// ---- The ?src= loader asks for the button, and takes the ask back on failure ----
{
    const externalSrc = stripComments(readSource('js/loaders/loader-external.js'));

    ok(/import\s*\{[^}]*\bshowVRButton\b[^}]*\}\s*from\s*['"]\.\.\/rendering\/vr\.js['"]/.test(externalSrc),
        'loader-external.js imports showVRButton');
    ok(/import\s*\{[^}]*\bhideVRButton\b[^}]*\}\s*from\s*['"]\.\.\/rendering\/vr\.js['"]/.test(externalSrc),
        'loader-external.js imports hideVRButton');
    ok(/\bshowVRButton\s*\(\s*\)/.test(externalSrc),
        'external image mode asks for the VR button');

    const restoreStart = externalSrc.indexOf('const restoreExternalModeUI');
    ok(restoreStart !== -1, 'loader-external.js defines restoreExternalModeUI()');
    if (restoreStart !== -1) {
        const restoreEnd = externalSrc.indexOf('\n    };', restoreStart);
        const body = externalSrc.slice(restoreStart, restoreEnd === -1 ? externalSrc.length : restoreEnd);
        ok(/\bhideVRButton\s*\(\s*\)/.test(body),
            'a failed external load hides the VR button again instead of leaving it over the normal-mode UI');
    }
}

console.log(`vr-button-visibility: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
