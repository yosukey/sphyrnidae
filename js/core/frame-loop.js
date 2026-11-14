/**
 * frame-loop.js
 * Which window the render loop (main.js animate) asks its animation frames of, and
 * what the loop does when that may have changed. The windows are passed in, so this
 * runs under Node (tests/frame-loop.test.mjs).
 *
 * While the external output window is open and in sight, frames are asked of it:
 * they come at the stereo display's refresh, and keep coming while the page is out
 * of sight (minimised or covered), which the browser gives none. Otherwise they are
 * asked of the page's window, and with neither in sight the loop stops.
 */

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
 * The loop's pending animation frame, and the window it was asked of. A frame is
 * cancelled on the window that issued its id, whichever window is in sight by then.
 */
export class FrameRequester {
    /**
     * @param {{requestAnimationFrame: Function, cancelAnimationFrame: Function}} pageWindow
     * @param {() => ({requestFrame: Function, cancelFrame: Function}|null)} frameSource -
     *   the external window to ask frames of while it is in sight, else null
     */
    constructor(pageWindow, frameSource) {
        this.pageWindow = pageWindow;
        this.frameSource = frameSource;
        /** The pending frame's id, or null. */
        this.id = null;
        /** The external window it was asked of; null for the page's own. */
        this.from = null;
    }

    /** Whether a frame is pending. */
    get pending() {
        return this.id !== null;
    }

    /**
     * Ask for the next frame, of the external window while it is in sight, otherwise
     * of the page's window. Any frame still pending is cancelled first, so there is
     * never more than one.
     * @param {FrameRequestCallback} callback
     */
    request(callback) {
        this.cancel();
        const source = this.frameSource();
        if (source) {
            this.from = source;
            this.id = source.requestFrame(callback);
        } else {
            this.from = null;
            this.id = this.pageWindow.requestAnimationFrame(callback);
        }
    }

    /** Cancel the pending frame, on the window it was asked of. */
    cancel() {
        if (this.id !== null) {
            if (this.from) this.from.cancelFrame(this.id);
            else this.pageWindow.cancelAnimationFrame(this.id);
        }
        this.id = null;
        this.from = null;
    }
}
