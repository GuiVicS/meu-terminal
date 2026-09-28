/**
 * touchScroll.js
 * Finger-drag scrolling for xterm.js on touch screens, with momentum.
 * xterm's own touch handling is minimal (and fights the browser's page panning),
 * so one-finger vertical drags are handled here; taps still focus the terminal.
 */

const TAP_SLOP = 8;          // px of movement before a touch counts as a drag
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
 * @returns {() => void} cleanup
 */
export function attachTouchScroll(panel, term, sendInput) {
    let startX = 0;
    let startY = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0;   // px per ms, positive = finger moving up = scroll down
    let remainder = 0;  // sub-line pixels not yet turned into scrolled lines
    let dragging = false;
    let tracking = false;
    let momentumFrame = 0;

    const rowHeight = () => {
        const screen = panel.querySelector('.xterm-screen');
        return screen && term.rows ? screen.clientHeight / term.rows : 18;
    };

    // Turns pixel movement into whole-line scrolls
    const scrollBy = pixels => {
        remainder += pixels;
        const h = rowHeight();
        const lines = Math.trunc(remainder / h);
        if (!lines) return;
        remainder -= lines * h;
        if (term.buffer.active.type === 'alternate') {
            // Full-screen programs have no scrollback: send arrows like a mouse wheel does
            const key = term.modes.applicationCursorKeysMode
                ? (lines > 0 ? '\x1bOB' : '\x1bOA')
                : (lines > 0 ? '\x1b[B' : '\x1b[A');
            sendInput(key.repeat(Math.abs(lines)));
        } else {
            term.scrollLines(lines);
        }
    };

    const stopMomentum = () => {
        cancelAnimationFrame(momentumFrame);
        momentumFrame = 0;
    };

    const onStart = e => {
        stopMomentum();
        if (e.touches.length !== 1) { tracking = false; return; }
        const t = e.touches[0];
        startX = t.clientX;
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
        lastY = t.clientY;
        lastT = now;
        scrollBy(dy);
    };

    const onEnd = e => {
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
