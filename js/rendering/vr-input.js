/**
 * vr-input.js
 * Pure helpers for reading VR controller (gamepad) input.
 *
 * Split out of vr.js so the input-mapping rules can be exercised under Node:
 * vr.js imports three.js and touches the WebGL renderer state, so it cannot be
 * imported outside a browser, while everything here is plain data in / data out.
 */

/**
 * A button counts as pressed when the runtime reports pressed === true, or —
 * for runtimes that leave that flag alone and only fill in the analog value —
 * once the value passes this threshold.
 */
export const VR_BUTTON_PRESS_THRESHOLD = 0.5;

/**
 * Buttons that end the VR session, as indices in the WebXR 'xr-standard'
 * gamepad mapping. Index 5 is the secondary face button: B on the right
 * controller, Y on the left.
 *
 * The other buttons are deliberately left out. Trigger (0), squeeze (1),
 * touchpad (2) and thumbstick press (3) are the ones pressed by accident while
 * holding the controllers or while pushing the stick to change images, and the
 * primary face button (4, A/X) is kept free for future in-VR actions.
 * Controllers whose mapping has no index 5 (e.g. Windows Mixed Reality) simply
 * have no in-VR exit button and still exit through the headset's system UI.
 */
export const VR_EXIT_BUTTON_INDICES = [5];

/**
 * Resolve analog stick axes from XR gamepad.
 * Some devices expose [0,1], others [2,3], and some expose both.
 * Use the pair with the larger magnitude so active input is not missed.
 * @param {number[]} axes - Gamepad axes
 * @returns {{x:number,y:number}}
 */
export function resolveStickAxes(axes) {
    if (!axes || axes.length < 2) {
        return { x: 0, y: 0 };
    }

    const x01 = Number(axes[0] ?? 0);
    const y01 = Number(axes[1] ?? 0);
    const mag01 = Math.max(Math.abs(x01), Math.abs(y01));

    const x23 = Number(axes[2] ?? 0);
    const y23 = Number(axes[3] ?? 0);
    const mag23 = Math.max(Math.abs(x23), Math.abs(y23));

    if (mag23 > mag01) {
        return { x: x23, y: y23 };
    }
    return { x: x01, y: y01 };
}

/**
 * Normalize one entry of an input list to a gamepad-like object.
 *
 * session.inputSources yields XRInputSource objects that carry the gamepad on
 * .gamepad (null for sources without one, e.g. hand tracking), while
 * navigator.getGamepads() yields Gamepad objects directly. Entries that are
 * neither are skipped by returning null.
 * @param {object|null} source
 * @returns {object|null}
 */
function toGamepad(source) {
    if (!source) return null;
    if (source.gamepad) return source.gamepad;
    return (source.axes || source.buttons) ? source : null;
}

/**
 * Whether one of the exit buttons is currently pressed on the given gamepad.
 * @param {object|null} gamepad
 * @returns {boolean}
 */
export function isVRExitButtonPressed(gamepad) {
    const buttons = gamepad?.buttons;
    if (!buttons) return false;

    for (const index of VR_EXIT_BUTTON_INDICES) {
        const button = buttons[index];
        if (!button) continue;
        if (button.pressed === true) return true;
        if (typeof button.value === 'number' && button.value >= VR_BUTTON_PRESS_THRESHOLD) {
            return true;
        }
    }
    return false;
}

/**
 * Read the stick axes and the exit-button state from a list of input sources.
 *
 * Accepts both an XRInputSourceArray (session.inputSources) and a Gamepad list
 * (navigator.getGamepads()). The strongest stick deflection across all
 * controllers wins, and the exit button counts as pressed if any controller
 * reports it, so either hand can drive both.
 * @param {Iterable<object|null>|null} sources
 * @returns {{horizontal:number, vertical:number, exitPressed:boolean}}
 */
export function readVRControllerInput(sources) {
    let horizontal = 0;
    let vertical = 0;
    let exitPressed = false;

    if (!sources || typeof sources[Symbol.iterator] !== 'function') {
        return { horizontal, vertical, exitPressed };
    }

    for (const source of sources) {
        const gamepad = toGamepad(source);
        if (!gamepad) continue;

        if (isVRExitButtonPressed(gamepad)) {
            exitPressed = true;
        }

        const axes = gamepad.axes;
        if (!axes || axes.length < 2) continue;

        const { x, y } = resolveStickAxes(axes);
        if (Math.abs(x) > Math.abs(horizontal)) horizontal = x;
        if (Math.abs(y) > Math.abs(vertical)) vertical = y;
    }

    return { horizontal, vertical, exitPressed };
}
