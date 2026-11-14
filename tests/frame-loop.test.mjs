/**
 * tests/frame-loop.test.mjs
 *
 * Which window the render loop asks its frames of (js/core/frame-loop.js), and that
 * the loop built on it in main.js never runs two frame chains, never dies while
 * something is in sight, and stops when nothing is.
 *
 * main.js itself pulls in three.js/WebGL, so the loop is modelled here exactly as
 * main.js drives it (animate / startAnimation / stopAnimation / refreshAnimationLoop),
 * over fake windows that deliver frames only while they are in sight and drop the
 * pending ones when they close, as browsers do. A check of main.js's source ties the
 * model to the real code.
 *
 * Run:  node tests/frame-loop.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FrameRequester, loopAction } from '../js/core/frame-loop.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

// --- loopAction: every combination --------------------------------------------------
for (const xr of [false, true]) {
    for (const pageHidden of [false, true]) {
        for (const externalInSight of [false, true]) {
            for (const animating of [false, true]) {
                const got = loopAction({ xr, pageHidden, externalInSight, animating });
                const want = xr ? 'none'
                    : (pageHidden && !externalInSight) ? 'stop'
                        : !animating ? 'start' : 'reaim';
                ok(got === want, `loopAction xr=${xr} pageHidden=${pageHidden} externalInSight=${externalInSight} animating=${animating}: ${got}`);
            }
        }
    }
}

// --- Fake windows -------------------------------------------------------------------
class FakeWindow {
    constructor(name) { this.name = name; this.pending = new Map(); this.nextId = 1; this.cancelled = []; }
    requestAnimationFrame(cb) { const id = this.nextId++; this.pending.set(id, cb); return id; }
    cancelAnimationFrame(id) { this.cancelled.push(id); this.pending.delete(id); }
    // The external window's names for the same (ExternalWindow.requestFrame / cancelFrame).
    requestFrame(cb) { return this.requestAnimationFrame(cb); }
    cancelFrame(id) { this.cancelAnimationFrame(id); }
    /** Deliver the frames due, as a browser does for a window in sight. */
    fire() { const due = [...this.pending.values()]; this.pending.clear(); for (const cb of due) cb(); }
}

// --- FrameRequester -----------------------------------------------------------------
{
    const page = new FakeWindow('page'), ext = new FakeWindow('ext');
    let source = null;
    const frames = new FrameRequester(page, () => source);
    frames.request(() => {});
    ok(page.pending.size === 1 && ext.pending.size === 0 && frames.pending, 'no external window: the page is asked');
    source = ext;
    frames.request(() => {});
    ok(page.pending.size === 0 && ext.pending.size === 1, 'external window in sight: it is asked, the page\'s frame cancelled');
    source = null; // the external window went out of sight (or closed) meanwhile
    frames.cancel();
    ok(ext.pending.size === 0 && ext.cancelled.length === 1 && !frames.pending,
        'a frame is cancelled on the window that issued it, whichever is in sight by then');
    frames.cancel();
    ok(ext.cancelled.length === 1 && page.cancelled.length === 1, 'cancelling with nothing pending does nothing');
}

// --- The loop, modelled on main.js, under random events ------------------------------
function simulate(seed, steps) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const page = new FakeWindow('page'), ext = new FakeWindow('ext');
    const world = { pageHidden: false, extOpen: false, extHidden: false };
    const frameSource = () => (world.extOpen && !world.extHidden ? ext : null);
    const frames = new FrameRequester(page, frameSource);
    let animating = false;
    let drawn = 0;

    // As main.js: animate() asks for the next frame first, then draws.
    function animate() { if (!animating) return; frames.request(animate); drawn++; }
    function startAnimation() { if (!animating) { animating = true; animate(); } }
    function stopAnimation() { animating = false; frames.cancel(); }
    function refreshAnimationLoop() {
        switch (loopAction({ xr: false, pageHidden: world.pageHidden, externalInSight: !!frameSource(), animating })) {
            case 'stop': stopAnimation(); break;
            case 'start': startAnimation(); break;
            case 'reaim': frames.request(animate); break;
            default: break;
        }
    }

    startAnimation();
    const problems = [];
    for (let i = 0; i < steps; i++) {
        const r = rnd();
        let what;
        if (r < 0.12) { what = 'page hide/show'; world.pageHidden = !world.pageHidden; refreshAnimationLoop(); }
        else if (r < 0.22) {
            if (!world.extOpen) { what = 'open external'; world.extOpen = true; world.extHidden = false; refreshAnimationLoop(); }
            else {
                // Closed: its pending frames never come.
                what = 'close external'; world.extOpen = false; ext.pending.clear(); refreshAnimationLoop();
            }
        }
        else if (r < 0.34) { if (world.extOpen) { what = 'external hide/show'; world.extHidden = !world.extHidden; refreshAnimationLoop(); } }
        else if (r < 0.67) { what = 'page frame'; if (!world.pageHidden) page.fire(); }
        else { what = 'external frame'; if (world.extOpen && !world.extHidden) ext.fire(); }

        const pending = page.pending.size + ext.pending.size;
        const inSight = !world.pageHidden || !!frameSource();
        if (pending > 1) problems.push(`step ${i} (${what}): ${pending} frames pending — two chains`);
        if (inSight) {
            if (!animating || pending !== 1) problems.push(`step ${i} (${what}): something in sight but ${pending} frames pending (animating ${animating}) — the loop died`);
            const want = frameSource() ? ext : page;
            if (pending === 1 && want.pending.size !== 1) problems.push(`step ${i} (${what}): frame pending on ${want === ext ? 'the page' : 'the external window'}, not on the one in sight`);
        } else if (animating || pending !== 0) {
            problems.push(`step ${i} (${what}): nothing in sight but the loop runs (${pending} pending)`);
        }
    }
    return { problems, drawn };
}

{
    let problems = [];
    let drawn = 0;
    for (let seed = 1; seed <= 200; seed++) {
        const r = simulate(seed * 7919, 400);
        problems = problems.concat(r.problems.map(p => `seed ${seed}: ${p}`));
        drawn += r.drawn;
    }
    ok(problems.length === 0, `the loop keeps one frame chain on the window in sight, and stops with none in sight${problems.length ? '\n    ' + problems.slice(0, 5).join('\n    ') : ''}`);
    ok(drawn > 10000, `the simulated loop drew frames (${drawn})`);
}

// --- main.js drives the loop as modelled ---------------------------------------------
{
    const main = readFileSync(fileURLToPath(new URL('../js/main.js', import.meta.url)), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
        .replace(/\s+/g, ' ');
    ok(/const frames = new FrameRequester\(window, externalFrameSource\);/.test(main), 'main.js asks its frames through FrameRequester');
    ok(/function requestNextFrame\(\) \{ frames\.request\(animate\); \}/.test(main), 'main.js: requestNextFrame asks for animate');
    ok(/function stopAnimation\(\) \{ isAnimating = false; cancelPendingFrame\(\); \}/.test(main), 'main.js: stopAnimation cancels the pending frame');
    ok(/function cancelPendingFrame\(\) \{ frames\.cancel\(\); \}/.test(main), 'main.js: cancelPendingFrame cancels through FrameRequester');
    ok(/case 'stop': stopAnimation\(\); break; case 'start': startAnimation\(\); break; case 'reaim': requestNextFrame\(\); break;/.test(main),
        'main.js: refreshAnimationLoop acts on loopAction');
    ok(/if \(!state\.renderer\.xr\.enabled\) \{ requestNextFrame\(\); \}/.test(main), 'main.js: animate asks for the next frame outside VR');
    ok(/function handleVisibilityChange\(\) \{ refreshAnimationLoop\(\); \}/.test(main), 'main.js: the page\'s visibility re-aims the loop');
}

console.log(`frame-loop: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
