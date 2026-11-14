/**
 * tests/frame-loop.test.mjs
 *
 * Which window the render loop asks its frames of (js/core/frame-loop.js), and that
 * the loop built on it in main.js never runs two frame chains, never dies while
 * something is in sight, runs on the page's own frames while the page is in sight,
 * keeps the external window going when the window asked goes quiet without saying
 * so, and stops when nothing is in sight. Without the external window no timer is
 * used, so the page alone behaves as before.
 *
 * main.js itself pulls in three.js/WebGL, so the loop is modelled here exactly as
 * main.js drives it (animate / startAnimation / stopAnimation / refreshAnimationLoop),
 * over fake windows that deliver frames only while they are in sight (and, when
 * stalled, not even then) and drop the pending ones when they close, and fake timers.
 * A check of main.js's source ties the model to the real code.
 *
 * Run:  node tests/frame-loop.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FrameRequester, loopAction, STALL_MS } from '../js/core/frame-loop.js';

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

// The wait stays well above a slow machine's frame interval (about 0.7 s was seen
// with software rendering); 250 ms ran the timer between real frames there.
ok(STALL_MS >= 1000, `STALL_MS is at least a second (${STALL_MS})`);

// --- Fakes --------------------------------------------------------------------------
class FakeWindow {
    constructor(name) { this.name = name; this.pending = new Map(); this.nextId = 1; this.cancelled = []; }
    request(cb) { const id = this.nextId++; this.pending.set(id, cb); return id; }
    cancel(id) { this.cancelled.push(id); this.pending.delete(id); }
    /** Deliver the frames due, as a browser does for a window in sight. */
    fire() { const due = [...this.pending.values()]; this.pending.clear(); for (const cb of due) cb(16); }
}
class FakeTimers {
    constructor() { this.now = 0; this.list = new Map(); this.nextId = 1; }
    setTimeout(fn, ms) { const id = this.nextId++; this.list.set(id, { fn, due: this.now + ms }); return id; }
    clearTimeout(id) { this.list.delete(id); }
    advance(ms) {
        const end = this.now + ms;
        for (;;) {
            let next = null;
            for (const [id, t] of this.list) if (t.due <= end && (!next || t.due < next[1].due)) next = [id, t];
            if (!next) break;
            this.list.delete(next[0]);
            this.now = next[1].due;
            next[1].fn();
        }
        this.now = end;
    }
}

// --- FrameRequester -----------------------------------------------------------------
{
    const page = new FakeWindow('page'), ext = new FakeWindow('ext'), timers = new FakeTimers();
    let source = null, standBy = false, runs = 0;
    const frames = new FrameRequester(page, () => source, { timers, standBy: () => standBy, stallMs: STALL_MS });
    frames.request(() => runs++);
    ok(page.pending.size === 1 && timers.list.size === 0 && frames.pending, 'no other window: the page is asked, with no timer');
    timers.advance(STALL_MS * 4);
    ok(runs === 0 && page.pending.size === 1, 'without a timer, a quiet page just waits (as before)');
    source = ext; standBy = true;
    frames.request(() => runs++);
    ok(page.pending.size === 0 && ext.pending.size === 1 && timers.list.size === 1, 'another window named: it is asked, the page\'s frame cancelled, a timer stands by');
    ext.fire();
    ok(runs === 1 && timers.list.size === 0 && !frames.pending, 'the frame comes: run once, the timer cleared');
    frames.request(() => runs++);
    timers.advance(STALL_MS * 2);
    ok(runs === 2 && ext.pending.size === 0 && !frames.pending, 'no frame for STALL_MS: run once from the timer, the frame request cancelled');
    ext.fire();
    ok(runs === 2, 'a late frame does not run it again');
    // Frames merely slow (each a little under STALL_MS apart): the timer never runs.
    // (A shorter STALL_MS ran the timer between such frames and more than doubled the work.)
    {
        const w = new FakeWindow('slow'), t3 = new FakeTimers();
        let n = 0, fromTimer = 0;
        const fr = new FrameRequester(w, () => null, { timers: t3, standBy: () => true, stallMs: STALL_MS });
        const loop = (time) => { n++; if (time === undefined) fromTimer++; fr.request(loop); };
        fr.request(loop);
        for (let i = 0; i < 50; i++) { t3.advance(STALL_MS * 0.8); w.fire(); }
        ok(n === 50 && fromTimer === 0, `slow frames: the loop runs on them alone, the timer never (${n} runs, ${fromTimer} from the timer)`);
        // Then the window goes quiet: the timer runs the loop, once per STALL_MS.
        const before = n;
        t3.advance(STALL_MS * 10);
        ok(fromTimer === 10 && n - before === 10, `stalled: the loop runs from the timer once per STALL_MS (${fromTimer} in 10 × STALL_MS)`);
        w.fire();
        const afterResume = fromTimer;
        for (let i = 0; i < 10; i++) { t3.advance(STALL_MS * 0.5); w.fire(); }
        ok(fromTimer === afterResume, 'frames again: the timer stands back');
    }
    // A window whose frame was already on its way when it was cancelled delivers it
    // anyway: still run once.
    {
        class LateWindow extends FakeWindow { cancel(id) { this.cancelled.push(id); } }
        const late = new LateWindow('late'), t2 = new FakeTimers();
        let n = 0;
        const fr = new FrameRequester(late, () => null, { timers: t2, standBy: () => true, stallMs: STALL_MS });
        fr.request(() => n++);
        t2.advance(STALL_MS * 2);
        late.fire();
        ok(n === 1, 'a frame delivered after its cancel does not run the loop a second time');
    }
    frames.request(() => runs++);
    source = null; // the window went out of sight (or closed) meanwhile
    frames.cancel();
    ok(ext.pending.size === 0 && timers.list.size === 0 && !frames.pending,
        'cancel: the request on the window that issued it, whichever is in sight by then, and the timer');
}

// --- The loop, modelled on main.js, under random events ------------------------------
function simulate(seed, steps) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const page = new FakeWindow('page'), ext = new FakeWindow('ext'), timers = new FakeTimers();
    const world = { pageHidden: false, extOpen: false, extHidden: false, pageStalled: false, extStalled: false };
    const extInSight = () => world.extOpen && !world.extHidden;
    // As main.js: externalFramesWhilePageHidden, standBy: the external window in sight.
    const frames = new FrameRequester(page, () => (world.pageHidden && extInSight() ? ext : null), { timers, standBy: extInSight, stallMs: STALL_MS });
    let animating = false;
    let drawn = 0;

    // As main.js: animate() asks for the next frame first, then draws.
    function animate() { if (!animating) return; frames.request(animate); drawn++; }
    function startAnimation() { if (!animating) { animating = true; animate(); } }
    function stopAnimation() { animating = false; frames.cancel(); }
    function refreshAnimationLoop() {
        switch (loopAction({ xr: false, pageHidden: world.pageHidden, externalInSight: extInSight(), animating })) {
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
        let what = 'nothing';
        const drawnBefore = drawn;
        if (r < 0.10) { what = 'page hide/show'; world.pageHidden = !world.pageHidden; refreshAnimationLoop(); }
        else if (r < 0.18) {
            if (!world.extOpen) { what = 'open external'; world.extOpen = true; world.extHidden = false; refreshAnimationLoop(); }
            else { what = 'close external'; world.extOpen = false; ext.pending.clear(); refreshAnimationLoop(); }
        }
        else if (r < 0.28) { if (world.extOpen) { what = 'external hide/show'; world.extHidden = !world.extHidden; refreshAnimationLoop(); } }
        else if (r < 0.34) { what = 'page goes quiet/resumes'; world.pageStalled = !world.pageStalled; }
        else if (r < 0.40) { what = 'external goes quiet/resumes'; world.extStalled = !world.extStalled; }
        else if (r < 0.62) { what = 'page frame'; if (!world.pageHidden && !world.pageStalled) page.fire(); }
        else if (r < 0.84) { what = 'external frame'; if (extInSight() && !world.extStalled) ext.fire(); }
        else {
            what = 'time passes';
            const wasAnimating = animating, audience = extInSight();
            // No frame meanwhile: within two STALL_MS the timer must have run the loop.
            timers.advance(2 * STALL_MS + 50);
            if (wasAnimating && audience && drawn === drawnBefore) problems.push(`step ${i}: the external window in sight, no frame came, and the loop did not run from the timer`);
            if (!audience && drawn !== drawnBefore) problems.push(`step ${i}: the loop ran from a timer without the external window in sight`);
        }

        const pendingFrames = page.pending.size + ext.pending.size;
        const inSight = !world.pageHidden || extInSight();
        if (pendingFrames > 1 || timers.list.size > 1) problems.push(`step ${i} (${what}): ${pendingFrames} frames and ${timers.list.size} timers pending — two chains`);
        if (inSight) {
            const want = world.pageHidden ? ext : page;
            if (!animating || pendingFrames !== 1 || want.pending.size !== 1) problems.push(`step ${i} (${what}): something in sight but the frame is not pending on the ${want.name} (animating ${animating}, ${pendingFrames} pending)`);
            if ((timers.list.size === 1) !== extInSight()) problems.push(`step ${i} (${what}): ${timers.list.size} timers with the external window ${extInSight() ? 'in sight' : 'not in sight'}`);
        } else if (animating || pendingFrames !== 0 || timers.list.size !== 0) {
            problems.push(`step ${i} (${what}): nothing in sight but the loop runs (${pendingFrames} frames, ${timers.list.size} timers)`);
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
    ok(problems.length === 0, `one frame chain, on the window in sight, kept going by its timer while the external window is in sight, stopped with nothing in sight${problems.length ? '\n    ' + problems.slice(0, 5).join('\n    ') : ''}`);
    ok(drawn > 10000, `the simulated loop drew frames (${drawn})`);
}

// --- main.js drives the loop as modelled ---------------------------------------------
{
    const main = readFileSync(fileURLToPath(new URL('../js/main.js', import.meta.url)), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
        .replace(/\s+/g, ' ');
    ok(/const frames = new FrameRequester\(pageFrames, externalFramesWhilePageHidden, \{ standBy: \(?\(\) => !!externalFrameSource\(\)\)? \}\);/.test(main),
        'main.js asks its frames through FrameRequester, with a timer only while the external window is in sight');
    ok(/function externalFramesWhilePageHidden\(\) \{ if \(!document\.hidden\) return null; const external = externalFrameSource\(\); if \(!external\) return null;/.test(main),
        'main.js: the external window\'s frames only while the page is out of sight');
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
