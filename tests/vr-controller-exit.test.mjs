/**
 * tests/vr-controller-exit.test.mjs
 *
 * Committed, framework-free verification of the in-VR controller controls:
 *
 * 1. readVRControllerInput() (js/rendering/vr-input.js) — which buttons end the
 *    session and which must never do so. The exit button has to be reachable on
 *    both the XRInputSource path and the navigator.getGamepads() fallback, on
 *    runtimes that only report an analog button value, and from either hand;
 *    the trigger, squeeze, touchpad, thumbstick press and the primary face
 *    button must stay inert, since those are the ones pressed by accident while
 *    holding the controllers or pushing the stick to change images.
 *
 * 2. That vr.js actually wires that signal to a single, edge-triggered
 *    endVRSession() call and clears the latches when the navigation state is
 *    reset. This half is a source-text check because vr.js imports three.js and
 *    cannot be imported under Node.
 *
 * Run:  node tests/vr-controller-exit.test.mjs
 * Exits non-zero if any assertion fails.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    readVRControllerInput,
    isVRExitButtonPressed,
    resolveStickAxes,
    VR_EXIT_BUTTON_INDICES,
    VR_BUTTON_PRESS_THRESHOLD
} from '../js/rendering/vr-input.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

const readSource = (relPath) =>
    readFileSync(fileURLToPath(new URL(`../${relPath}`, import.meta.url)), 'utf8');

/**
 * Drop comments so a mention of a function in prose cannot stand in for a real
 * call. vr.js documents its own handlers at length — including naming the ones
 * this test looks for — so searching the raw text would pass even after the
 * call itself was deleted.
 * @param {string} src - JavaScript source
 * @returns {string} Source with block and line comments blanked out
 */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

/**
 * Build a gamepad whose listed button indices are pressed.
 * @param {number[]} pressedIndices - Indices reported as pressed
 * @param {number[]} axes - Stick axes
 * @returns {{buttons:object[], axes:number[]}}
 */
const gamepad = (pressedIndices = [], axes = [0, 0]) => ({
    axes,
    buttons: Array.from({ length: 6 }, (_, i) => ({
        pressed: pressedIndices.includes(i),
        value: pressedIndices.includes(i) ? 1 : 0
    }))
});

/** Wrap a gamepad the way session.inputSources exposes it. */
const inputSource = (pad) => ({ gamepad: pad, handedness: 'right' });

// ---- The exit button is the secondary face button (B/Y), and only that ----
// Index 5 in the xr-standard mapping. If this list ever grows, the "inert"
// assertions below are what keeps the addition deliberate.
ok(VR_EXIT_BUTTON_INDICES.includes(5), 'B/Y (xr-standard index 5) is an exit button');

for (const index of [0, 1, 2, 3, 4]) {
    ok(!isVRExitButtonPressed(gamepad([index])),
        `xr-standard button ${index} does not end the session (trigger/squeeze/touchpad/stick/A-X)`);
}
ok(isVRExitButtonPressed(gamepad([5])), 'pressing B/Y reports an exit press');

// ---- Runtimes that only fill in the analog value ----
// Some report .value without ever setting .pressed; the threshold is what makes
// those controllers able to exit at all.
const analogOnly = (value) => ({ axes: [0, 0], buttons: [{}, {}, {}, {}, {}, { value }] });
ok(isVRExitButtonPressed(analogOnly(VR_BUTTON_PRESS_THRESHOLD)),
    'analog-only button at the threshold counts as pressed');
ok(isVRExitButtonPressed(analogOnly(1.0)), 'analog-only button fully pressed counts as pressed');
ok(!isVRExitButtonPressed(analogOnly(VR_BUTTON_PRESS_THRESHOLD - 0.01)),
    'analog-only button below the threshold does not count as pressed');
ok(!isVRExitButtonPressed(analogOnly(0)), 'analog-only button at rest does not count as pressed');

// ---- Malformed / absent input never throws or reports a press ----
ok(!isVRExitButtonPressed(null), 'null gamepad reports no press');
ok(!isVRExitButtonPressed({}), 'gamepad without buttons reports no press');
ok(!isVRExitButtonPressed({ buttons: [] }), 'gamepad with an empty button list reports no press');

for (const sources of [null, undefined, {}, 42]) {
    const read = readVRControllerInput(sources);
    ok(read.horizontal === 0 && read.vertical === 0 && read.exitPressed === false,
        `non-iterable input source list (${String(sources)}) reads as idle`);
}

// ---- Both input paths reach the same signal ----
// session.inputSources yields XRInputSource objects carrying .gamepad; the
// navigator.getGamepads() fallback yields Gamepad objects directly, padded with
// nulls for empty slots.
ok(readVRControllerInput([inputSource(gamepad([5]))]).exitPressed,
    'exit press is read from an XRInputSource');
ok(readVRControllerInput([null, gamepad([5])]).exitPressed,
    'exit press is read from a raw gamepad list with empty slots');
ok(!readVRControllerInput([inputSource(null), null]).exitPressed,
    'sources without a gamepad (e.g. hand tracking) report no press');

// ---- Either hand can exit ----
ok(readVRControllerInput([inputSource(gamepad([])), inputSource(gamepad([5]))]).exitPressed,
    'exit press on the second controller is seen');
ok(readVRControllerInput([inputSource(gamepad([5])), inputSource(gamepad([]))]).exitPressed,
    'exit press on the first controller is seen');
ok(!readVRControllerInput([inputSource(gamepad([0])), inputSource(gamepad([4]))]).exitPressed,
    'trigger on one hand and A/X on the other still do not exit');

// ---- Stick reading is unchanged by the button handling ----
{
    const read = readVRControllerInput([
        inputSource(gamepad([], [0.3, 0.0])),
        inputSource(gamepad([5], [-0.9, 0.5]))
    ]);
    ok(read.horizontal === -0.9, 'strongest horizontal deflection across controllers wins');
    ok(read.vertical === 0.5, 'strongest vertical deflection across controllers wins');
    ok(read.exitPressed, 'stick input and an exit press are reported together');

    // Devices that expose the stick on axes [2,3] (the pair with the larger
    // magnitude is the active one).
    const alt = readVRControllerInput([inputSource(gamepad([], [0, 0, 0.8, -0.4]))]);
    ok(alt.horizontal === 0.8 && alt.vertical === -0.4, 'axes [2,3] are used when they carry the input');
    ok(resolveStickAxes([0.6, 0.1, 0, 0]).x === 0.6, 'axes [0,1] are used when they carry the input');

    const noAxes = readVRControllerInput([{ axes: [0.5], buttons: [] }]);
    ok(noAxes.horizontal === 0 && noAxes.vertical === 0, 'a gamepad with fewer than two axes is skipped');
}

// ---- vr.js wires the signal to a single session end ----
{
    const src = stripComments(readSource('js/rendering/vr.js'));

    ok(/\breadVRControllerInput\b/.test(src) && /from\s+['"]\.\/vr-input\.js['"]/.test(src),
        'vr.js imports the shared controller input reader');
    ok(/\breadVRControllerInput\s*\(\s*session\.inputSources\s*\)/.test(src),
        'updateVRNavigation() reads the XR input sources through it');
    ok(/\breadVRControllerInput\s*\(\s*navigator\.getGamepads\(\)\s*\)/.test(src),
        'the getGamepads() fallback goes through the same reader');

    const fnStart = src.indexOf('function requestVRExitFromController');
    ok(fnStart !== -1, 'vr.js defines requestVRExitFromController()');
    if (fnStart !== -1) {
        // Bound the body at the next top-level function so a stray match later in
        // the module cannot make these assertions pass vacuously.
        const nextFn = src.indexOf('\nfunction ', fnStart + 1);
        const body = src.slice(fnStart, nextFn === -1 ? src.length : nextFn);
        ok(body.length > 0 && body.length < src.length, 'requestVRExitFromController() body extracted');
        ok(/if\s*\(\s*!vrSession\s*\|\|\s*vrExitRequested/.test(body),
            'it refuses to fire without a session or while an end is already in flight');
        ok(/\bendVRSession\s*\(/.test(body), 'it ends the VR session');
    }

    ok(/if\s*\(\s*exitPressed\s*\)\s*\{\s*if\s*\(\s*!vrExitButtonHeld\s*\)/.test(src),
        'the exit press is edge-triggered, so holding the button ends the session once');
    ok(/vrExitButtonHeld\s*=\s*false/.test(src), 'the held latch is released when the button comes up');
    ok(/\brequestVRExitFromController\s*\(\s*\)/.test(src), 'the press edge requests the session end');

    const resetStart = src.indexOf('function resetVRStickState');
    ok(resetStart !== -1, 'vr.js defines resetVRStickState()');
    if (resetStart !== -1) {
        const nextFn = src.indexOf('\nfunction ', resetStart + 1);
        const body = src.slice(resetStart, nextFn === -1 ? src.length : nextFn);
        ok(/vrExitRequested\s*=\s*false/.test(body),
            'resetVRStickState() clears the exit request, so the next session can also be exited');
        ok(/vrExitButtonHeld\s*=\s*true/.test(body),
            'resetVRStickState() arms the held latch, so a button still down at session start needs a fresh press');
    }
}

console.log(`vr-controller-exit: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
