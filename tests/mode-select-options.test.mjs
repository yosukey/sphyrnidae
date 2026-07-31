/**
 * tests/mode-select-options.test.mjs
 *
 * Committed, framework-free verification of the contract between the display-mode
 * numbers the app can be put into and the <option> values of the two mode
 * dropdowns in index.html (#displayMode in the menu panel, #viewerDisplayMode in
 * the viewer bottom bar).
 *
 * Why this is a test and not just a comment: several code paths keep a dropdown in
 * step with state.params.mode by assigning `select.value = String(mode)` —
 * applyViewerDisplayMode() (ui-viewer.js) and the ?src=...&mode= external-image
 * path (loader-external.js). Assigning a value that no <option> carries silently
 * clears the selection (the select renders blank) instead of throwing, so a mode
 * that is reachable from ?mode= but missing from the dropdown would be a silent UI
 * bug. This locks in that every MODE_NAME_MAP mode has an option, that the two
 * dropdowns stay identical, and that their initial selection matches
 * defaultParams.mode (the state a freshly loaded page is actually in).
 *
 * Reads index.html as text (no DOM/jsdom needed) and imports only pure modules, so
 * it runs under Node's built-in test runner.
 *
 * Run:  node tests/mode-select-options.test.mjs
 * Exits non-zero if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MODE_NAME_MAP, modeSuffixes } from '../js/mode-utils.js';
import { state } from '../js/globals.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

/**
 * Extract a <select> by id: its markup and its option values in document order.
 * @param {string} id - Element id
 * @returns {{markup: string, values: string[]}|null} Parsed select, or null if absent
 */
function parseSelect(id) {
    // Non-greedy up to the first </select> after the opening tag with this id.
    // `id="displayMode"` cannot match `id="viewerDisplayMode"` (the quote is part
    // of the pattern), so the two ids stay distinct.
    const selectMatch = html.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`));
    if (!selectMatch) return null;
    return {
        markup: selectMatch[0],
        values: [...selectMatch[0].matchAll(/<option[^>]*\svalue="([^"]*)"/g)].map(([, v]) => v)
    };
}

const menuSelect = parseSelect('displayMode');
const viewerSelect = parseSelect('viewerDisplayMode');
const menuOptions = menuSelect?.values ?? null;
const viewerOptions = viewerSelect?.values ?? null;

// ---- Both selects exist and were parsed ----
ok(Array.isArray(menuOptions) && menuOptions.length > 0, '#displayMode found with options');
ok(Array.isArray(viewerOptions) && viewerOptions.length > 0, '#viewerDisplayMode found with options');

if (menuOptions && viewerOptions) {
    // ---- Every mode reachable from ?mode= / a per-URL `mode=` token has an option ----
    // parseModeParam() only accepts MODE_NAME_MAP names, so this set is exactly the
    // set of modes a URL can request.
    const urlReachableModes = [...new Set(Object.values(MODE_NAME_MAP))].sort((a, b) => a - b);
    const menuSet = new Set(menuOptions);
    const viewerSet = new Set(viewerOptions);
    const missingFromViewer = urlReachableModes.filter(m => !viewerSet.has(String(m)));
    const missingFromMenu = urlReachableModes.filter(m => !menuSet.has(String(m)));
    ok(missingFromViewer.length === 0,
        `every URL-reachable mode has a #viewerDisplayMode option (missing: ${missingFromViewer.join(', ')})`);
    ok(missingFromMenu.length === 0,
        `every URL-reachable mode has a #displayMode option (missing: ${missingFromMenu.join(', ')})`);

    // ---- The two dropdowns offer the same modes in the same order ----
    // They are two views of one setting; a divergence would make the mode change
    // when the user moves between the menu panel and the viewer bar.
    ok(menuOptions.join(',') === viewerOptions.join(','),
        `#displayMode and #viewerDisplayMode option lists match (menu: ${menuOptions.join(',')} / viewer: ${viewerOptions.join(',')})`);

    // ---- Every offered option is a real mode number ----
    // A typo'd or stale value would build a shader for an unknown mode.
    const unknownOptions = [...new Set([...menuOptions, ...viewerOptions])]
        .filter(v => !Object.prototype.hasOwnProperty.call(modeSuffixes, v));
    ok(unknownOptions.length === 0, `all option values are known modes (unknown: ${unknownOptions.join(', ')})`);

    // ---- The initial selection matches the default mode ----
    // Neither select carries a `selected` attribute, so the browser selects the
    // first option. A load without ?mode= leaves state.params.mode at
    // defaultParams.mode and no code syncs the dropdown, so the two must agree or
    // the UI is wrong from the first paint.
    ok(!/<option[^>]*\sselected/.test(menuSelect.markup),
        'no explicit selected attribute on #displayMode options (first option wins)');
    ok(!/<option[^>]*\sselected/.test(viewerSelect.markup),
        'no explicit selected attribute on #viewerDisplayMode options (first option wins)');
    ok(menuOptions[0] === String(state.defaultParams.mode),
        `#displayMode first option (${menuOptions[0]}) equals defaultParams.mode (${state.defaultParams.mode})`);
    ok(viewerOptions[0] === String(state.defaultParams.mode),
        `#viewerDisplayMode first option (${viewerOptions[0]}) equals defaultParams.mode (${state.defaultParams.mode})`);
}

console.log(`mode-select-options: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
