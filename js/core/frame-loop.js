/**
 * frame-loop.js
 * Which window the render loop (main.js animate) asks its animation frames of, and
 * what the loop does when that may have changed. The windows and the timers are
 * passed in, so this runs under Node (tests/frame-loop.test.mjs).
 *
 * Frames are asked of the page's window while the page is in sight. While it is out
 * of sight (minimised or covered), which the browser gives no frames, they are asked
 * of the external output window if that is open and in sight, so it goes on being
 * drawn. With neither in sight the loop stops. (Which window FrameRequester asks is
 * the frameSource main.js gives it.)
 *
 * A window can also stop giving frames without saying so: a compositor that does not
 * tell the browser a window was minimised, a display turned off. While the external
 * window is in sight (main.js decides, standBy), a timer stands by with each request,
 * and if no frame has come after STALL_MS the loop runs from the timer instead, so
 * the external window the audience looks at goes on, slowly, rather than freezing.
 * Only one of the two runs per frame asked. Without the external window there is no
 * timer: the page alone behaves as before.
 */

/** How long to wait for a frame before running the loop from a timer instead. */
export const STALL_MS = 250;

/**
 * What the loop does after the page or the external window came into or went out of
 * sight, or the external window opened or closed.
 *
 * - 'none': VR is on; WebXR drives the loop.
 * - 'stop': nothing in sight to draw for.
 * - 'start': the loop is stopped and something is in sight.
 * - 'reaim': the loop runs; ask the pending frame again, of the window in sight now
 *   (one pending on a window that went out of sight, or closed, would never come).
 *
 * @param {{xr: boolean, pageHidden: boolean, externalInSight: boolean, animating: boolean}} s
 * @returns {'none'|'stop'|'start'|'reaim'}
 */
export function loopAction({ xr, pageHidden, externalInSight, animating }) {
    if (xr) return 'none';
    if (pageHidden && !externalInSight) return 'stop';
    if (!animating) return 'start';
    return 'reaim';
}

/**
 * @typedef {Object} FrameSource
 * @property {(callback: FrameRequestCallback) => number} request - one window's requestAnimationFrame
 * @property {(id: number) => void} cancel - the same window's cancelAnimationFrame
 */

/**
 * The loop's pending frame: a request on one window and, when standBy says so, a timer
 * in case that window gives no frame (STALL_MS). Whichever comes first runs the
 * callback, once; the other is cancelled. A request is cancelled on the window that
 * issued it.
 */
export class FrameRequester {
    /**
     * @param {FrameSource} pageFrames - the page's own window
     * @param {() => (FrameSource|null)} frameSource - another window to ask instead, or null
     * @param {Object} [options]
     * @param {() => boolean} [options.standBy] - whether a timer stands by with this request
     * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
     * @param {number} [options.stallMs]
     */
    constructor(pageFrames, frameSource, { standBy = () => true, timers = globalThis, stallMs = STALL_MS } = {}) {
        this.pageFrames = pageFrames;
        this.frameSource = frameSource;
        this.standBy = standBy;
        this.timers = timers;
        this.stallMs = stallMs;
        /** The pending frame's own token; null when none is pending. */
        this.ticket = null;
        this.source = null;
        this.id = null;
        this.timer = null;
    }

    /** Whether a frame is pending. */
    get pending() {
        return this.ticket !== null;
    }

    /**
     * Ask for the next frame, of the window frameSource names, else of the page's,
     * with a timer standing by if standBy says so. Any frame still pending is
     * cancelled first, so there is never more than one.
     * @param {FrameRequestCallback} callback
     */
    request(callback) {
        this.cancel();
        const ticket = {};
        const run = (time) => {
            if (this.ticket !== ticket) return;
            // The other of the two (the frame, or the timer) is no longer wanted.
            this.cancel();
            callback(time);
        };
        this.ticket = ticket;
        this.source = this.frameSource() || this.pageFrames;
        this.id = this.source.request(run);
        if (this.standBy()) this.timer = this.timers.setTimeout(() => run(undefined), this.stallMs);
    }

    /** Cancel the pending frame: its request, on the window that issued it, and its timer. */
    cancel() {
        if (this.ticket !== null) {
            if (this.id !== null) this.source.cancel(this.id);
            if (this.timer !== null) this.timers.clearTimeout(this.timer);
        }
        this.ticket = null;
        this.source = null;
        this.id = null;
        this.timer = null;
    }
}
