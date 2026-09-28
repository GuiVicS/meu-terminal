/**
 * viewport.js
 * Tracks the *visible* viewport (window.visualViewport) so the app can shrink when a
 * mobile virtual keyboard opens, instead of trusting 100vh / innerHeight.
 * Exposes --vvh / --vvtop CSS variables and a keyboard open/closed signal.
 */

const KEYBOARD_THRESHOLD = 120; // px of height lost before we call it a keyboard

export default class ViewportManager {
    constructor() {
        this.vv = window.visualViewport || null;
        this.listeners = new Set();
        this.keyboardOpen = false;
        this.baseline = 0; // tallest visible height seen in the current orientation
        this.coarse = window.matchMedia('(pointer: coarse)');
        this.frame = 0;

        const schedule = () => {
            cancelAnimationFrame(this.frame);
            this.frame = requestAnimationFrame(() => this.update());
        };

        if (this.vv) {
            this.vv.addEventListener('resize', schedule);
            this.vv.addEventListener('scroll', schedule);
        }
        window.addEventListener('resize', schedule);
        // New orientation = new "keyboard closed" height
        const resetBaseline = () => {
            this.baseline = 0;
            schedule();
        };
        window.matchMedia('(orientation: portrait)').addEventListener?.('change', resetBaseline);
        this.update();
    }

    update() {
        const root = document.documentElement.style;
        const height = this.vv ? this.vv.height : window.innerHeight;
        const top = this.vv ? this.vv.offsetTop : 0;
        root.setProperty('--vvh', `${Math.round(height)}px`);
        root.setProperty('--vvtop', `${Math.round(top)}px`);

        this.baseline = Math.max(this.baseline, height);
        const open = this.coarse.matches && this.baseline - height > KEYBOARD_THRESHOLD;
        if (open !== this.keyboardOpen) {
            this.keyboardOpen = open;
            document.documentElement.toggleAttribute('data-keyboard', open);
            this.listeners.forEach(fn => fn(open));
        }
    }

    /** @param {(open: boolean) => void} fn */
    onKeyboardChange(fn) {
        this.listeners.add(fn);
    }
}
