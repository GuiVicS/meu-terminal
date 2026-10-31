/**
 * edgeSwipe.js
 * iPhone gesture for the apps home page: drag from the left edge of the screen to the right to
 * open it; with it open, drag to the left to close it. A round glass hint with the grid icon
 * follows the finger, so it's clear what the gesture will do before letting go.
 * Only on iPhones in portrait (data-iphone); ignored while a sheet, menu or dialog is open.
 */
import { icon } from './icons.js';

const EDGE = 24;        // px from the left edge where an "open" drag may start
const TRIGGER = 70;     // px of horizontal travel needed to act
const SLOP = 12;        // px of movement before deciding horizontal vs vertical

const iphonePortrait = () => document.documentElement.hasAttribute('data-iphone')
    && window.matchMedia('(orientation: portrait)').matches;
const overlayOpen = () => {
    try {
        return !!document.querySelector('.ag-sheet-backdrop:not([hidden]), .menu, dialog[open], .ui-select-menu:popover-open');
    } catch { // :popover-open unsupported: check the rest
        return !!document.querySelector('.ag-sheet-backdrop:not([hidden]), .menu, dialog[open]');
    }
};

/**
 * @param {object} opts
 * @param {() => boolean} opts.isOpen - is the apps page showing?
 * @param {() => boolean} opts.canClose - may it be closed (false when no tab is open)?
 * @param {() => void} opts.onOpen
 * @param {() => void} opts.onClose
 */
export function bindEdgeSwipe({ isOpen, canClose, onOpen, onClose }) {
    let start = null; // { x, y, mode: 'open'|'close', decided: bool }
    let hint = null;

    const showHint = (dx, mode) => {
        if (!hint) {
            hint = document.createElement('div');
            hint.className = 'edge-swipe-hint';
            hint.setAttribute('aria-hidden', 'true');
            hint.innerHTML = icon('grid', 22);
            document.body.appendChild(hint);
        }
        const progress = Math.min(1, Math.abs(dx) / TRIGGER);
        // Opening: slides in from the left edge. Closing: slides in from the right edge.
        const offset = mode === 'open' ? Math.min(dx, TRIGGER + 20) - 56 : Math.max(dx, -(TRIGGER + 20)) + 56;
        hint.style.transform = `translateX(${offset}px) scale(${0.7 + 0.3 * progress})`;
        hint.style.opacity = String(progress);
        hint.classList.toggle('from-right', mode === 'close');
        hint.classList.toggle('ready', progress >= 1);
    };
    const hideHint = () => {
        hint?.remove();
        hint = null;
    };

    document.addEventListener('touchstart', e => {
        start = null;
        if (e.touches.length !== 1 || !iphonePortrait() || overlayOpen()) return;
        const t = e.touches[0];
        if (isOpen()) {
            if (canClose()) start = { x: t.clientX, y: t.clientY, mode: 'close', decided: false };
        } else if (t.clientX <= EDGE) {
            start = { x: t.clientX, y: t.clientY, mode: 'open', decided: false };
        }
    }, { capture: true, passive: true });

    document.addEventListener('touchmove', e => {
        if (!start) return;
        const t = e.touches[0];
        const dx = t.clientX - start.x;
        const dy = t.clientY - start.y;
        if (!start.decided) {
            if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
            // Vertical drags stay with the terminal/page; only a clearly horizontal drag is ours
            if (Math.abs(dy) > Math.abs(dx) || (start.mode === 'open' ? dx < 0 : dx > 0)) {
                start = null;
                return;
            }
            start.decided = true;
        }
        showHint(dx, start.mode);
    }, { capture: true, passive: true });

    const end = e => {
        if (!start) return;
        const { mode, decided, x } = start;
        start = null;
        hideHint();
        if (!decided || e.type === 'touchcancel') return;
        const dx = e.changedTouches[0].clientX - x;
        if (mode === 'open' && dx >= TRIGGER) onOpen();
        else if (mode === 'close' && dx <= -TRIGGER) onClose();
    };
    document.addEventListener('touchend', end, { capture: true, passive: true });
    document.addEventListener('touchcancel', end, { capture: true, passive: true });
}
