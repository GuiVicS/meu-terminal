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

// A linha de cima, fixa à direita
const PINNED_KEYS = [
    { id: 'cmds', icon: 'bolt', aria: 'Comandos rápidos', action: 'commands' },
    // Tap pastes the device clipboard; long press opens the "recently copied" list
    { id: 'clip', icon: 'clipboard', aria: 'Colar (segure para ver copiados recentemente)',
        action: 'paste', longAction: 'clipboard-history' },
];

// A linha de baixo: cada uma liga ou desliga em Configurações → Terminal
const KEYS = [
    { id: 'esc', label: 'ESC', aria: 'Escape', send: '\x1b' },
    { id: 'tab', label: 'TAB', aria: 'Tab', send: '\t' },
    { id: 'ctrl', label: 'CTRL', aria: 'Control', modifier: 'ctrl' },
    { id: 'alt', label: 'ALT', aria: 'Alt', modifier: 'alt' },
    { id: 'up', label: '↑', aria: 'Seta para cima', nav: 'up', repeat: true },
    { id: 'down', label: '↓', aria: 'Seta para baixo', nav: 'down', repeat: true },
    { id: 'left', label: '←', aria: 'Seta para esquerda', nav: 'left', repeat: true },
    { id: 'right', label: '→', aria: 'Seta para direita', nav: 'right', repeat: true },
    { id: 'mic', icon: 'mic', aria: 'Transcrever voz', dictation: true },
    { id: 'home', label: 'HOME', aria: 'Home', nav: 'home' },
    { id: 'end', label: 'END', aria: 'End', nav: 'end' },
    { id: 'pgup', label: 'PGUP', aria: 'Page Up', send: '\x1b[5~', repeat: true },
    { id: 'pgdn', label: 'PGDN', aria: 'Page Down', send: '\x1b[6~', repeat: true },
    { id: 'pipe', label: '|', aria: 'Barra vertical', char: '|' },
    { id: 'slash', label: '/', aria: 'Barra', char: '/' },
    { id: 'tilde', label: '~', aria: 'Til', char: '~' },
    { id: 'dash', label: '-', aria: 'Hífen', char: '-' },
    { id: 'dollar', label: '$', aria: 'Cifrão', char: '$' },
    { id: 'amp', label: '&', aria: 'E comercial', char: '&' },
    { id: 'gt', label: '>', aria: 'Maior que', char: '>' },
];

/** O que vem ligado: cabe tudo numa linha, em qualquer celular. */
export const DEFAULT_SHORTCUT_KEYS = ['esc', 'tab', 'ctrl', 'alt', 'up', 'down', 'left', 'right', 'mic'];

/** Para o configurador de teclas. */
export const SHORTCUT_KEY_OPTIONS = KEYS.map(k => ({ id: k.id, label: k.label || null, icon: k.icon || null, aria: k.aria }));

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
     * @param {{ getSession: () => any, onAction: (name: string, button: Element) => void, keys?: string[] }} deps
     */
    constructor(el, { getSession, onAction, keys }) {
        this.enabled = keys;
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

        const top = document.createElement('div');
        top.className = 'shortcut-row shortcut-row-top';
        const pinned = document.createElement('div');
        pinned.className = 'shortcut-pinned';
        PINNED_KEYS.forEach(key => pinned.appendChild(this.keyButton(key)));
        top.appendChild(pinned);
        // O vazio ao lado também não pode tirar o foco do terminal (fecharia o teclado)
        top.addEventListener('pointerdown', e => e.preventDefault());
        top.addEventListener('mousedown', e => e.preventDefault());

        const row = document.createElement('div');
        row.className = 'shortcut-row';
        this.scroller = document.createElement('div');
        this.scroller.className = 'shortcut-scroll';
        row.appendChild(this.scroller);
        this.el.append(top, row);
        this.setKeys(this.enabled);
    }

    keyButton(key) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const wide = key.label && key.label.length > 2;
        btn.className = 'shortcut-key' + (wide ? ' wide' : '') + (key.icon ? ' icon-key' : '');
        btn.dataset.key = key.id;
        if (key.icon) btn.innerHTML = icon(key.icon, 19);
        else btn.textContent = key.label;
        if (key.dictation) btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', key.aria);
        if (key.modifier) btn.setAttribute('aria-pressed', 'false');
        this.bindKey(btn, key);
        return btn;
    }

    /** Monta a linha de baixo com as teclas ligadas no configurador. */
    setKeys(ids) {
        this.enabled = Array.isArray(ids) ? ids : DEFAULT_SHORTCUT_KEYS;
        this.clearModifiers();
        this.scroller.replaceChildren(...KEYS
            .filter(k => this.enabled.includes(k.id) && !(k.dictation && !this.dictation)) // navegador sem reconhecimento de voz
            .map(k => this.keyButton(k)));
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
