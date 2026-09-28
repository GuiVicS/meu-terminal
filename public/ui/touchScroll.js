/**
 * touchScroll.js
 * Touch gestures for the terminal on phones/tablets:
 * - 1-finger vertical drag scrolls, with momentum. When the running program enabled
 *   mouse reporting (vim, htop, less, tmux, TUIs...), the scroll is sent as mouse-wheel
 *   events AT THE FINGER'S CELL, so the program scrolls the pane under the finger.
 *   Otherwise it scrolls the terminal history (or sends arrows in full-screen programs).
 * - 2-finger tap = right click: sent to the program when it uses the mouse,
 *   otherwise opens the app's terminal menu (paste, copy...).
 * Taps still focus the terminal / open the keyboard.
 */

const TAP_SLOP = 8;          // px of movement before a touch counts as a drag
const TWO_FINGER_TAP_MS = 350;
const FRICTION = 0.95;       // momentum decay per frame
const MIN_VELOCITY = 0.02;   // px/ms under which momentum stops

function reducedMotion() {
    return document.documentElement.hasAttribute('data-reduced-motion')
        || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * @param {HTMLElement} panel - element that contains the xterm instance
 * @param {import('@xterm/xterm').Terminal} term
 * @param {(data: string) => void} sendInput - used in the alternate buffer (vim, less...)
 * @param {{ onSecondaryTap?: (x: number, y: number) => void }} [options]
 * @returns {() => void} cleanup
 */
export function attachTouchScroll(panel, term, sendInput, { onSecondaryTap } = {}) {
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;   // px per ms, positive = finger moving up = scroll down
    let remainder = 0;  // sub-line pixels not yet turned into scrolled lines
    let dragging = false;
    let tracking = false;
    let momentumFrame = 0;
    let twoFinger = null; // { start, points, moved }

    const screen = () => panel.querySelector('.xterm-screen');
    const rowHeight = () => {
        const s = screen();
        return s && term.rows ? s.clientHeight / term.rows : 18;
    };
    const mouseMode = () => term.modes.mouseTrackingMode !== 'none';

    /**
     * Mouse-wheel event at a screen point. xterm turns it into the right mouse report
     * (cell coordinates + the encoding the program asked for), so we don't encode by hand.
     */
    const wheelAt = (x, y, lines) => {
        const target = screen();
        if (!target) return;
        const step = lines > 0 ? 1 : -1;
        for (let i = 0; i < Math.abs(lines); i++) {
            target.dispatchEvent(new WheelEvent('wheel', {
                deltaY: step,
                deltaMode: WheelEvent.DOM_DELTA_LINE,
                clientX: x,
                clientY: y,
                bubbles: true,
                cancelable: true,
            }));
        }
    };

    // Turns pixel movement into whole-line scrolls
    const scrollBy = pixels => {
        remainder += pixels;
        const h = rowHeight();
        const lines = Math.trunc(remainder / h);
        if (!lines) return;
        remainder -= lines * h;
        if (mouseMode()) {
            // Positional: the program decides which pane is under (lastX, lastY)
            wheelAt(lastX, lastY, lines);
        } else if (term.buffer.active.type === 'alternate') {
            // Full-screen program without mouse: arrows, like a mouse wheel would send
            const key = term.modes.applicationCursorKeysMode
                ? (lines > 0 ? '\x1bOB' : '\x1bOA')
                : (lines > 0 ? '\x1b[B' : '\x1b[A');
            sendInput(key.repeat(Math.abs(lines)));
        } else {
            term.scrollLines(lines);
        }
    };

    /** Right click (button 2) at a point, delivered through xterm's mouse handling. */
    const rightClickAt = (x, y) => {
        const target = screen();
        if (!target) return;
        const init = { clientX: x, clientY: y, button: 2, bubbles: true, cancelable: true, view: window };
        target.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 2 }));
        // xterm listens for the release on the document while a button is held
        document.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    };

    const stopMomentum = () => {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = 0;
    };

    const onStart = e => {
        stopMomentum();
        if (e.touches.length === 2) {
            // Possible two-finger tap: cancel any one-finger drag in progress
            tracking = false;
            const [a, b] = e.touches;
            twoFinger = {
                start: performance.now(),
                x: (a.clientX + b.clientX) / 2,
                y: (a.clientY + b.clientY) / 2,
                points: [[a.clientX, a.clientY], [b.clientX, b.clientY]],
                moved: false,
            };
            e.preventDefault(); // no browser zoom / focus from the second finger
            e.stopPropagation();
            return;
        }
        if (e.touches.length !== 1) {
            tracking = false;
            twoFinger = null;
            return;
        }
        const t = e.touches[0];
        startX = lastX = t.clientX;
        startY = lastY = t.clientY;
        lastT = performance.now();
        velocity = 0;
        remainder = 0;
        dragging = false;
        tracking = true;
        // Keep xterm's own touch handlers out of the way (they would double-scroll)
        e.stopPropagation();
    };

    const onMove = e => {
        if (twoFinger) {
            // Fingers moved: not a tap (pinch/pan is ignored rather than guessed at)
            [...e.touches].slice(0, 2).forEach((t, i) => {
                const [x0, y0] = twoFinger.points[i] || [t.clientX, t.clientY];
                if (Math.hypot(t.clientX - x0, t.clientY - y0) > TAP_SLOP) twoFinger.moved = true;
            });
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (!tracking || e.touches.length !== 1) return;
        const t = e.touches[0];
        if (!dragging) {
            const dx = Math.abs(t.clientX - startX);
            const dy = Math.abs(t.clientY - startY);
            if (dy < TAP_SLOP || dy < dx) {
                // Mostly horizontal or too small: not ours
                if (dx > TAP_SLOP) tracking = false;
                return;
            }
            dragging = true;
            lastY = t.clientY;
        }
        e.preventDefault(); // stop page panning / pull-to-refresh
        e.stopPropagation();
        const now = performance.now();
        const dy = lastY - t.clientY;
        const dt = Math.max(1, now - lastT);
        // Smoothed velocity for the fling at the end
        velocity = 0.8 * (dy / dt) + 0.2 * velocity;
        lastX = t.clientX;
        lastY = t.clientY;
        lastT = now;
        scrollBy(dy);
    };

    const onEnd = e => {
        if (twoFinger) {
            // Wait until both fingers are up, then decide if it was a quick, still tap
            if (e.touches.length > 0) {
                e.preventDefault();
                return;
            }
            const tap = !twoFinger.moved && performance.now() - twoFinger.start < TWO_FINGER_TAP_MS;
            const { x, y } = twoFinger;
            twoFinger = null;
            e.preventDefault();
            e.stopPropagation();
            if (!tap) return;
            navigator.vibrate?.(10);
            if (mouseMode()) rightClickAt(x, y);
            else onSecondaryTap?.(x, y);
            return;
        }
        if (!tracking) return;
        tracking = false;
        if (!dragging) return; // a tap: let it focus the terminal / open the keyboard
        e.preventDefault();    // no synthetic click after a drag
        e.stopPropagation();
        // Ignore stale velocity if the finger paused before lifting
        if (performance.now() - lastT > 80 || reducedMotion()) return;
        let v = velocity;
        let prev = performance.now();
        const step = now => {
            const dt = now - prev;
            prev = now;
            scrollBy(v * dt);
            v *= Math.pow(FRICTION, dt / 16);
            if (Math.abs(v) > MIN_VELOCITY) momentumFrame = requestAnimationFrame(step);
            else momentumFrame = 0;
        };
        momentumFrame = requestAnimationFrame(step);
    };

    // Capture phase on the panel runs before xterm's listeners on inner elements
    const opts = { capture: true, passive: false };
    panel.addEventListener('touchstart', onStart, opts);
    panel.addEventListener('touchmove', onMove, opts);
    panel.addEventListener('touchend', onEnd, opts);
    panel.addEventListener('touchcancel', onEnd, opts);

    return () => {
        stopMomentum();
        panel.removeEventListener('touchstart', onStart, opts);
        panel.removeEventListener('touchmove', onMove, opts);
        panel.removeEventListener('touchend', onEnd, opts);
        panel.removeEventListener('touchcancel', onEnd, opts);
    };
}
