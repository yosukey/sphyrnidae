/**
 * tests/ui-visibility-toggle.test.mjs
 *
 * Committed, framework-free verification of the distraction-free view (the H key /
 * on-canvas button that hides every operation panel in normal editing mode).
 *
 * Why this is a test and not just a comment: the feature is implemented as one
 * body class (`ui-chrome-hidden`) plus a single CSS rule that lists every panel
 * and handle it suppresses. Nothing in JS enumerates those panels, so if a panel's
 * id/class is renamed — or a new floating panel is added — the CSS rule silently
 * stops covering it and "hide everything" quietly leaves something on screen. The
 * label/tooltip side has the same problem: ui-visibility.js swaps the button's
 * data-i18n keys at runtime, so a missing locale entry would surface as a raw key
 * in the UI rather than an error.
 *
 * This locks in that:
 *  - every selector in the hide rule targets an element that exists in index.html
 *  - the panels the app can float over the canvas are all covered by that rule
 *  - a pointer route out of the hidden state always survives the rule
 *  - the on-canvas button lives inside #canvas-container (so it tracks the image area)
 *    and is never on screen while the panels are
 *  - a collapsed status panel leaves the tab order, so its × cannot be reached blind
 *  - both i18n keys ui-visibility.js swaps between exist in every locale, as do the
 *    help-panel keys index.html references for the shortcut
 *
 * Reads index.html / layout.css / the locales as text (no DOM or jsdom needed), so
 * it runs under Node's built-in test runner.
 *
 * NOTE: the release workflow runs the test suite from its "Verify release artifact"
 * step, which comes AFTER the JS/CSS/HTML minification steps. Those steps strip
 * comments and normalize whitespace: terser reformats (comments gone, statements kept
 * one per line), csso drops comments and collapses whitespace and rewrites values
 * (0.55 -> .55), and html-minifier-terser removes comments. Anchor every pattern on
 * structure, never on indentation, blank lines or quote style — and keep the margin,
 * since the build has been tightened before and could be again.
 *
 * Run:  node tests/ui-visibility-toggle.test.mjs
 * Exits non-zero if any assertion fails.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const html = read('index.html');
const layoutCss = read('css/layout.css');
const visibilityJs = read('js/ui/ui-visibility.js');

// ---- The hide rule exists and lists concrete selectors ----
// Match the selector list that precedes the `display: none !important` block whose
// first selector is the body class. Comments are stripped first so a `/* ... */`
// note between the rules cannot leak into the selector list.
const cssNoComments = layoutCss.replace(/\/\*[\s\S]*?\*\//g, '');
const hideRule = cssNoComments.match(
    /((?:body\.ui-chrome-hidden[^{};]*,\s*)*body\.ui-chrome-hidden[^{};]*)\{([^}]*display:\s*none\s*!important[^}]*)\}/
);
ok(!!hideRule, 'css/layout.css has a body.ui-chrome-hidden { display: none !important } rule');

if (hideRule) {
    const selectors = hideRule[1].split(',').map(s => s.trim()).filter(Boolean);
    ok(selectors.length > 1, `hide rule lists more than one target (found ${selectors.length})`);

    // Every selector must be scoped so viewer mode is unaffected: the viewer has its
    // own auto-hiding control bar and no control for this toggle.
    const unscoped = selectors.filter(s => !s.includes(':not(.viewer-mode)'));
    ok(unscoped.length === 0,
        `every hide selector excludes viewer mode (unscoped: ${unscoped.join(' | ')})`);

    // The trailing target of each selector must be a real element in index.html.
    const missing = [];
    for (const selector of selectors) {
        const target = selector.split(/\s+/).pop();
        if (target.startsWith('#')) {
            if (!html.includes(`id="${target.slice(1)}"`)) missing.push(target);
        } else if (target.startsWith('.')) {
            const cls = target.slice(1);
            if (!new RegExp(`class="[^"]*\\b${cls}\\b`).test(html)) missing.push(target);
        } else {
            missing.push(`${target} (unrecognized selector form)`);
        }
    }
    ok(missing.length === 0, `every hide-rule target exists in index.html (missing: ${missing.join(', ')})`);

    // ---- Nothing the app floats over the canvas escapes the rule ----
    // These are the panels and reopen-handles that make up the normal-mode chrome.
    // A new one added without extending the rule would stay visible in the
    // "hide everything" state, which is the bug this whole test guards against.
    // .status-toggle-btn is deliberately absent: it is the restore button, and the
    // assertion below requires the opposite of it.
    const CHROME = ['#ui-container', '#status-panel', '#histogram-panel',
                    '.panel-tab', '.drawer-handle'];
    const targets = new Set(selectors.map(s => s.split(/\s+/).pop()));
    const uncovered = CHROME.filter(t => !targets.has(t));
    ok(uncovered.length === 0, `all normal-mode chrome is covered by the rule (uncovered: ${uncovered.join(', ')})`);

    ok(!targets.has('.status-toggle-btn'),
        'the hide rule leaves .status-toggle-btn alone (it is the way back)');
}

// ---- A pointer route back always survives the hide ----
// The on-canvas button is styled to be nearly invisible at rest, so the top-right
// restore button carries the discoverable route out of the distraction-free view.
// Its normal gate is `body:not(.status-open)`, which does not hold when the panels
// were hidden while the status panel was open — hence an explicit reveal rule.
ok(/body\.ui-chrome-hidden[^{};]*\.status-toggle-btn\s*\{[^}]*display:\s*flex/.test(cssNoComments),
    'body.ui-chrome-hidden reveals .status-toggle-btn so the panels can be restored by pointer');

// ...and it must not be conditioned on fullscreen. Fullscreen suppresses the status
// panel and this button, so excluding it there would leave a 22%-opacity glyph on the
// image as the entire escape route.
const restoreRevealRule = cssNoComments.match(
    /(body\.ui-chrome-hidden[^{};]*\.status-toggle-btn)\s*\{[^}]*display:\s*flex/);
ok(restoreRevealRule && !restoreRevealRule[1].includes('fullscreen-mode'),
    'the .status-toggle-btn reveal is not withheld in fullscreen');

// ---- A collapsed status panel is gone for the keyboard too ----
// .status-hidden slides the panel off with transform/opacity, which leaves its buttons
// focusable. Since the × clears every panel, a Tab that lands on the invisible button
// would wipe the UI with nothing on screen explaining why.
ok(/#status-panel\.status-hidden\s*\{[^}]*visibility:\s*hidden/.test(cssNoComments),
    '.status-hidden takes the status panel out of the tab order');

/**
 * Inner markup of a <div> with the given id, found by walking div nesting depth
 * from its opening tag.
 *
 * Depth-walking rather than matching a literal closing tag: the release workflow runs
 * this test after the HTML minification step, so any regex anchored on indentation or
 * newlines risks passing locally and failing the release build.
 * @param {string} id - Element id
 * @returns {string|null} Inner markup, or null if the div is absent/unbalanced
 */
function divContent(id) {
    const open = html.match(new RegExp(`<div[^>]*\\sid="${id}"[^>]*>`));
    if (!open) return null;
    const start = open.index + open[0].length;
    const tag = /<(\/?)div[\s>]/g;
    tag.lastIndex = start;
    let depth = 1, m;
    while ((m = tag.exec(html)) !== null) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) return html.slice(start, m.index);
    }
    return null;
}

// ---- The on-canvas button sits inside the canvas container ----
// Position is not cosmetic: #canvas-container is the flex sibling of the menu
// drawer, so an absolutely positioned child tracks the visible image area at every
// breakpoint without per-breakpoint offsets for the menu width.
const canvasContent = divContent('canvas-container');
ok(canvasContent !== null, '#canvas-container block found in index.html');
ok(canvasContent !== null && canvasContent.includes('id="uiVisibilityToggleBtn"'),
    '#uiVisibilityToggleBtn is inside #canvas-container');

// ---- ...and is a way BACK, never a second way out ----
// Hiding by pointer is the status panel's × alone. A hide control drawn over the image
// would duplicate it, on top of the very thing the feature exists to show — so this
// button must not be on screen while the panels are. Checked structurally: every rule
// that puts it on screen has to be scoped to the hidden state.
const canvasBtnShowRules = [...cssNoComments.matchAll(/([^{}]*#uiVisibilityToggleBtn[^{}]*)\{([^}]*)\}/g)]
    .filter(([, , decls]) => /display:\s*flex/.test(decls))
    .map(([, selector]) => selector.trim());
ok(canvasBtnShowRules.length > 0, '#uiVisibilityToggleBtn has a rule that puts it on screen');
ok(canvasBtnShowRules.every(s => s.includes('ui-chrome-hidden')),
    `every rule revealing #uiVisibilityToggleBtn is scoped to the hidden state ` +
    `(unscoped: ${canvasBtnShowRules.filter(s => !s.includes('ui-chrome-hidden')).join(' | ')})`);

// ---- The status panel offers both actions ----
// Its × hides every panel, so collapsing the status panel alone needs its own control.
// Without the second button that action would have no route at all.
const statusContent = divContent('status-panel');
ok(statusContent !== null, '#status-panel block found in index.html');
for (const id of ['hideStatusBtn', 'minimizeStatusBtn']) {
    ok(statusContent !== null && statusContent.includes(`id="${id}"`),
        `#${id} is inside #status-panel`);
}
// Both status-panel buttons and the restore button are wired here, not in ui-menu.js,
// so one module owns every label the feature swaps.
for (const id of ['hideStatusBtn', 'minimizeStatusBtn', 'showStatusBtn']) {
    ok(new RegExp(`['"]${id}['"]`).test(visibilityJs),
        `ui-visibility.js wires #${id}`);
}

// ---- Locale coverage for every key the feature uses ----
// ui-visibility.js swaps the button's data-i18n keys at runtime, so both must
// resolve in every locale or the tooltip renders a raw key.
const jsKeys = [...visibilityJs.matchAll(/['"](accessibility\.[A-Za-z]+)['"]/g)].map(([, k]) => k);
ok(jsKeys.length >= 2, `ui-visibility.js references its label keys (found: ${jsKeys.join(', ')})`);

// Help-panel keys for the shortcut, taken from the markup rather than hard-coded
// so renaming a key in index.html cannot leave this test passing vacuously.
const htmlKeys = [...html.matchAll(/data-i18n(?:-title)?="(?:\[[^\]]+\])?(help\.hidePanels[A-Za-z]*)"/g)]
    .map(([, k]) => k);
ok(htmlKeys.length >= 2, `index.html documents the shortcut in the help panel (found: ${htmlKeys.join(', ')})`);

// The buttons carry their opening labels in the markup and only get repointed once a
// state changes, so the keys spelled in index.html need the same coverage as the ones
// spelled in the JS.
const htmlA11yKeys = [...html.matchAll(/data-i18n(?:-title)?="(?:\[[^\]]+\])?(accessibility\.[A-Za-z]+)"/g)]
    .map(([, k]) => k);
ok(htmlA11yKeys.length >= 3,
    `index.html labels the panel visibility buttons (found: ${htmlA11yKeys.join(', ')})`);

const localeFiles = readdirSync(fileURLToPath(new URL('../locales', import.meta.url)))
    .filter(f => f.endsWith('.json'));
ok(localeFiles.length > 0, 'locale files found');

const lookup = (obj, key) => key.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

for (const file of localeFiles) {
    const locale = JSON.parse(read(`locales/${file}`));
    const absent = [...new Set([...jsKeys, ...htmlKeys, ...htmlA11yKeys])]
        .filter(k => typeof lookup(locale, k) !== 'string');
    ok(absent.length === 0, `${file} defines every distraction-free view key (missing: ${absent.join(', ')})`);
}

console.log(`ui-visibility-toggle: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
