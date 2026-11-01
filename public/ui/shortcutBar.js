/**
 * shortcutBar.js
 * Mobile shortcut toolbar shown between the terminal and the native keyboard.
 * It is NOT a keyboard: it only sends the keys phones lack (Esc, Tab, Ctrl, arrows...)
 * as the real byte sequences a terminal would send. Also hosts the voice dictation button.
 */
import { icon } from './icons.js';
import { toast } from './toast.js';
import Dictation from './dictation.js';
import { haptic } from './haptics.js';

// Arrow/navigation keys: [normal mode, application cursor mode, xterm modifier final]
const NAV = {
    up: ['\x1b[A', '\x1bOA', 'A'],
    down: ['\x1b[B', '\x1bOB', 'B'],
    right: ['\x1b[C', '\x1bOC', 'C'],
    left: ['\x1b[D', '\x1bOD', 'D'],
    home: ['\x1b[H', '\x1bOH', 'H'],
    end: ['\x1b[F', '\x1bOF', 'F'],
};

const KEYS = [
    { id: 'esc', label: 'ESC', aria: 'Escape', send: '\x1b' },
    { id: 'tab', label: 'TAB', aria: 'Tab', send: '\t' },
    { id: 'ctrl', label: 'CTRL', aria: 'Control', modifier: 'ctrl' },
    { id: 'alt', label: 'ALT', aria: 'Alt', modifier: 'alt' },
    { id: 'up', label: '↑', aria: 'Seta para cima', nav: 'up', repeat: true },
    { id: 'down', label: '↓', aria: 'Seta para baixo', nav: 'down', repeat: true },
    { id: 'left', label: '←', aria: 'Seta para esquerda', nav: 'left', repeat: true },
    { id: 'right', label: '→', aria: 'Seta para direita', nav: 'right', repeat: true },
    // Pinned: always visible at the right edge, outside the scrolling keys
    { id: 'cmds', icon: 'bolt', aria: 'Comandos rápidos', action: 'commands', pinned: true },
    // Tap pastes the device clipboard; long press opens the "recently copied" list
    { id: 'clip', icon: 'clipboard', aria: 'Colar (segure para ver copiados recentemente)',
        action: 'paste', longAction: 'clipboard-history', pinned: true },
    { id: 'mic', icon: 'mic', aria: 'Transcrever voz', dictation: true },
    { id: 'more', label: '…', aria: 'Mais teclas', toggle: true },
    // Extra keys: revealed by "…"
    { id: 'home', label: 'HOME', aria: 'Home', nav: 'home', extra: true },
    { id: 'end', label: 'END', aria: 'End', nav: 'end', extra: true },
    { id: 'pgup', label: 'PGUP', aria: 'Page Up', send: '\x1b[5~', repeat: true, extra: true },
    { id: 'pgdn', label: 'PGDN', aria: 'Page Down', send: '\x1b[6~', repeat: true, extra: true },
    { id: 'pipe', label: '|', aria: 'Barra vertical', char: '|', extra: true },
    { id: 'slash', label: '/', aria: 'Barra', char: '/', extra: true },
    { id: 'tilde', label: '~', aria: 'Til', char: '~', extra: true },
    { id: 'dash', label: '-', aria: 'Hífen', char: '-', extra: true },
    { id: 'dollar', label: '$', aria: 'Cifrão', char: '$', extra: true },
    { id: 'amp', label: '&', aria: 'E comercial', char: '&', extra: true },
    { id: 'gt', label: '>', aria: 'Maior que', char: '>', extra: true },
];

/** Converts one character to its Ctrl-code (Ctrl+C -> \x03). Returns null if none. */
export function ctrlChar(ch) {
    if (ch.length !== 1) return null;
    const upper = ch.toUpperCase();
    const code = upper.charCodeAt(0);
    if (code >= 64 && code <= 95) return String.fromCharCode(code & 0x1f); // @ A-Z [ \ ] ^ _
    if (ch === ' ') return '\x00';
    if (ch === '?') return '\x7f';
    if (ch === '/') return '\x1f';
    return null;
}

export default class ShortcutBar {
    /**
     * @param {HTMLElement} el - container element
     * @param {{ getSession: () => any, onAction: (name: string, button: Element) => void }} deps
     */
    constructor(el, { getSession, onAction }) {
        this.el = el;
        this.getSession = getSession;
        this.onAction = onAction;
        this.modifiers = { ctrl: false, alt: false };
        this.repeatTimer = null;
        this.render();
    }

    render() {
        this.el.setAttribute('role', 'toolbar');
        this.el.setAttribute('aria-label', 'Teclas de atalho do terminal');

        // Live transcript while dictating
        this.preview = document.createElement('div');
        this.preview.className = 'dictation-preview';
        this.preview.hidden = true;
        this.preview.setAttribute('role', 'status');
        this.preview.setAttribute('aria-live', 'polite');
        this.el.appendChild(this.preview);

        if (Dictation.supported) {
            this.dictation = new Dictation({
                // Keep the newest words visible without growing the bar
                onInterim: text => {
                    this.preview.textContent = !text ? 'Ouvindo…'
                        : (text.length > 90 ? '…' + text.slice(-90) : text);
                },
                onFinal: text => this.getSession()?.sendInput(text),
                onStateChange: listening => {
                    const btn = this.el.querySelector('[data-key="mic"]');
                    btn?.classList.toggle('recording', listening);
                    btn?.setAttribute('aria-pressed', String(listening));
                    this.preview.hidden = !listening;
                    if (listening) this.preview.textContent = 'Ouvindo…';
                },
                onError: message => toast(message, { tone: 'error' }),
            });
        }

        const row = document.createElement('div');
        row.className = 'shortcut-row';
        const scroller = document.createElement('div');
        scroller.className = 'shortcut-scroll';
        const pinned = document.createElement('div');
        pinned.className = 'shortcut-pinned';
        KEYS.forEach(key => {
            if (key.dictation && !this.dictation) return; // browser has no speech recognition
            const btn = document.createElement('button');
            btn.type = 'button';
            const wide = key.label && key.label.length > 2;
            btn.className = 'shortcut-key' + (wide ? ' wide' : '') + (key.extra ? ' extra' : '')
                + (key.icon ? ' icon-key' : '');
            btn.dataset.key = key.id;
            if (key.icon) btn.innerHTML = icon(key.icon, 19);
            else btn.textContent = key.label;
            if (key.dictation) btn.setAttribute('aria-pressed', 'false');
            btn.setAttribute('aria-label', key.aria);
            if (key.modifier) btn.setAttribute('aria-pressed', 'false');
            if (key.toggle) btn.setAttribute('aria-expanded', 'false');
            this.bindKey(btn, key);
            (key.pinned ? pinned : scroller).appendChild(btn);
        });
        row.append(scroller, pinned);
        this.el.appendChild(row);
    }

    bindKey(btn, key) {
        if (key.longAction) {
            this.bindLongPressKey(btn, key);
            return;
        }
        // Acting on pointerdown + preventDefault keeps focus in the terminal, so the
        // native keyboard stays open while the user taps shortcut keys.
        btn.addEventListener('pointerdown', e => {
            e.preventDefault();
            btn.classList.add('pressed');
            this.press(key);
            if (key.repeat) {
                this.repeatTimer = setTimeout(() => {
                    this.repeatTimer = setInterval(() => this.press(key, true), 60);
                }, 400);
            }
        });
        const stop = () => {
            btn.classList.remove('pressed');
            clearTimeout(this.repeatTimer);
            clearInterval(this.repeatTimer);
            this.repeatTimer = null;
        };
        btn.addEventListener('pointerup', stop);
        btn.addEventListener('pointerleave', stop);
        btn.addEventListener('pointercancel', stop);
        btn.addEventListener('mousedown', e => e.preventDefault());
        // Keyboard / assistive tech activation (no pointer involved)
        btn.addEventListener('click', e => {
            if (e.detail === 0) this.press(key);
        });
    }

    /** Tap = key.action (on release), hold 500ms = key.longAction. Focus stays in the terminal. */
    bindLongPressKey(btn, key) {
        let timer = null;
        let longFired = false;
        btn.addEventListener('pointerdown', e => {
            e.preventDefault();
            btn.classList.add('pressed');
            longFired = false;
            timer = setTimeout(() => {
                longFired = true;
                haptic('medium');
                this.onAction?.(key.longAction, btn);
            }, 500);
        });
        const end = run => {
            btn.classList.remove('pressed');
            clearTimeout(timer);
            timer = null;
            if (run && !longFired) {
                haptic('select');
                this.onAction?.(key.action, btn);
            }
        };
        btn.addEventListener('pointerup', () => end(true));
        btn.addEventListener('pointercancel', () => end(false));
        btn.addEventListener('pointerleave', () => { if (timer) end(false); });
        btn.addEventListener('mousedown', e => e.preventDefault());
        btn.addEventListener('contextmenu', e => e.preventDefault());
        btn.addEventListener('click', e => {
            if (e.detail === 0) this.onAction?.(key.action, btn); // keyboard activation
        });
    }

    press(key, repeating = false) {
        if (!repeating) haptic('select');
        if (key.action) {
            this.onAction?.(key.action, this.el.querySelector(`[data-key="${key.id}"]`));
            return;
        }
        if (key.dictation) {
            this.dictation?.toggle();
            return;
        }
        if (key.toggle) {
            const expanded = this.el.classList.toggle('expanded');
            this.el.querySelector('[data-key="more"]').setAttribute('aria-expanded', String(expanded));
            return;
        }
        if (key.modifier) {
            this.setModifier(key.modifier, !this.modifiers[key.modifier]);
            return;
        }
        const session = this.getSession();
        if (!session) return;

        let data;
        if (key.nav) {
            const [normal, app, final] = NAV[key.nav];
            const mod = (this.modifiers.alt ? 2 : 0) + (this.modifiers.ctrl ? 4 : 0);
            if (mod) data = `\x1b[1;${mod + 1}${final}`; // xterm modifier encoding
            // Browser tabs have no terminal modes; they translate these sequences into keys
            else data = session.terminal?.modes.applicationCursorKeysMode ? app : normal;
        } else if (key.char) {
            data = key.char;
            if (this.modifiers.ctrl) data = ctrlChar(data) ?? data;
            if (this.modifiers.alt) data = '\x1b' + data;
        } else {
            data = key.send;
            if (this.modifiers.alt) data = '\x1b' + data;
        }
        if (!repeating) this.clearModifiers();
        session.sendInput(data);
    }

    /**
     * Applies sticky modifiers to text typed on the native keyboard.
     * Called by the workspace for every onData from xterm.
     */
    transform(data) {
        if (!this.modifiers.ctrl && !this.modifiers.alt) return data;
        let out = data;
        if (this.modifiers.ctrl && data.length === 1) out = ctrlChar(data) ?? data;
        if (this.modifiers.alt) out = '\x1b' + out;
        this.clearModifiers();
        return out;
    }

    setModifier(name, on) {
        this.modifiers[name] = on;
        const btn = this.el.querySelector(`[data-key="${name}"]`);
        btn?.classList.toggle('active', on);
        btn?.setAttribute('aria-pressed', String(on));
    }

    clearModifiers() {
        this.setModifier('ctrl', false);
        this.setModifier('alt', false);
    }

    setVisible(visible) {
        this.el.hidden = !visible;
        if (!visible) {
            this.clearModifiers();
            this.dictation?.stop();
        }
    }
}
