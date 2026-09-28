/**
 * session.js
 * One terminal session = one xterm.js instance + one WebSocket + one server-side shell.
 * Owns the connection state machine and cleans up every listener it creates on dispose().
 */
import { attachTouchScroll } from '../ui/touchScroll.js';

// Connection states shown in tabs and in the status bar
export const STATE = {
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    RECONNECTING: 'reconnecting',
    DISCONNECTED: 'disconnected', // gave up reconnecting; Enter tries again
    EXITED: 'exited',             // shell ended (e.g. `exit`); Enter starts a new one
    ERROR: 'error',
};

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 1000;
const SERIALIZE_LINES = 1000; // keeps localStorage small even with many tabs

// Identity colors for tabs (like browser tab groups). Stored per session.
export const SESSION_COLORS = ['green', 'blue', 'purple', 'orange', 'pink', 'cyan', 'yellow'];

// ANSI palettes (dark follows the visual reference: GitHub-dark-like)
const PALETTES = {
    dark: {
        black: '#484F58', red: '#FF7B72', green: '#3FB950', yellow: '#D29922',
        blue: '#58A6FF', magenta: '#BC8CFF', cyan: '#39C5CF', white: '#B1BAC4',
        brightBlack: '#6E7681', brightRed: '#FFA198', brightGreen: '#56D364',
        brightYellow: '#E3B341', brightBlue: '#79C0FF', brightMagenta: '#D2A8FF',
        brightCyan: '#56D4DD', brightWhite: '#F0F6FC',
    },
    light: {
        black: '#1A1B1D', red: '#C8313A', green: '#1A7F55', yellow: '#8F5F00',
        blue: '#2F5FD0', magenta: '#A8327F', cyan: '#0B7482', white: '#6E7075',
        brightBlack: '#8C8E92', brightRed: '#DC3F48', brightGreen: '#1F9463',
        brightYellow: '#A36D00', brightBlue: '#3E6FE3', brightMagenta: '#BD4495',
        brightCyan: '#0E8797', brightWhite: '#3A3C40',
    },
};

// Lines that look like a bare shell prompt. Trailing prompts are stripped before
// saving so a restored tab doesn't show a stale prompt above the new one.
const PROMPT_PATTERNS = [
    /^.*@.*[:~][#$>]\s*$/,
    /^[^@]+@[^:]+:[^$#>]+[#$>]\s*$/,
    /^[$#>]\s*$/,
    /^\w+:\s*[\w/~]+[$#>]\s*$/,
    /^\s*\u001b\[\d+(?:;\d+)*m/,
    /\u001b\[\?\d+[hl]/,
];

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function terminalTheme(themeName) {
    return {
        background: cssVar('--term-bg'),
        foreground: cssVar('--term-fg'),
        cursor: cssVar('--term-cursor'),
        cursorAccent: cssVar('--term-bg'),
        selectionBackground: cssVar('--term-selection'),
        ...PALETTES[themeName === 'light' ? 'light' : 'dark'],
    };
}

export default class TerminalSession {
    /**
     * @param {object} opts
     * @param {number} opts.id
     * @param {string} opts.name
     * @param {boolean} [opts.pinned]
     * @param {string} [opts.cwd] - directory to start the shell in
     * @param {string} [opts.content] - serialized output to re-print (restored tab)
     * @param {object} opts.settings - SettingsManager
     * @param {object} opts.hooks - callbacks into the workspace
     */
    constructor({ id, name, pinned = false, color = 'green', cwd = '', content = '', settings, hooks }) {
        this.id = id;
        this.name = name;
        this.pinned = pinned;
        this.color = SESSION_COLORS.includes(color) ? color : 'green';
        this.branch = null;       // git branch of cwd (Linux only)
        this.startCwd = cwd || '';
        this.settings = settings;
        this.hooks = hooks;

        // Connection / process state
        this.state = STATE.CONNECTING;
        this.shell = null;
        this.home = null;
        this.platform = null;
        this.cwd = null;          // live cwd (Linux only)
        this.process = null;      // foreground process (Linux only)
        this.title = '';          // OSC title set by the shell, if any
        this.hasActivity = false; // new output while in background
        this.lastContent = content || '';

        this.ws = null;
        this.reconnectAttempts = 0;
        this.hadShell = false;
        this.disposed = false;
        this.timers = new Set();

        this.panel = document.createElement('div');
        this.panel.className = 'terminal-panel';
        this.panel.id = `panel-${id}`;
        this.panel.setAttribute('role', 'tabpanel');
        this.panel.setAttribute('aria-labelledby', `tab-${id}`);
    }

    /** Creates the xterm instance inside `parent` and opens the connection. */
    mount(parent) {
        parent.appendChild(this.panel);
        const s = this.settings;
        const theme = s.resolvedTheme();

        this.terminal = new Terminal({
            cursorBlink: s.get('cursorBlink'),
            cursorStyle: s.get('cursorStyle'),
            cursorInactiveStyle: 'outline',
            fontSize: s.get('fontSize'),
            lineHeight: s.get('lineHeight'),
            fontFamily: cssVar('--font-mono'),
            theme: terminalTheme(theme),
            // 1 = real ANSI colors in dark mode; light mode nudges low-contrast colors
            minimumContrastRatio: theme === 'light' ? 4.5 : 1,
            allowTransparency: false,
            macOptionIsMeta: false,
            scrollback: s.get('scrollback'),
            cursorWidth: 1.5,
            letterSpacing: 0.5,
            windowOptions: { setWinSize: true, getWinSize: true },
            allowProposedApi: true,
            rightClickSelectsWord: true,
            convertEol: true,
            termProgram: 'xterm-256color',
            smoothScrollDuration: 0,
            fastScrollModifier: 'alt',
            fastScrollSensitivity: 5,
            altClickMovesCursor: true,
            screenReaderMode: false,
        });

        const addons = {
            fit: new FitAddon.FitAddon(),
            webLinks: new WebLinksAddon.WebLinksAddon(),
            webgl: new WebglAddon.WebglAddon(),
            canvas: new CanvasAddon.CanvasAddon(),
            image: new ImageAddon.ImageAddon(),
            ligatures: new LigaturesAddon.LigaturesAddon(),
            search: new SearchAddon.SearchAddon(),
            serialize: new SerializeAddon.SerializeAddon(),
            unicode11: new Unicode11Addon.Unicode11Addon(),
        };
        this.addons = addons;
        const term = this.terminal;

        term.open(this.panel);
        term.loadAddon(addons.unicode11);
        term.unicode.activeVersion = '11';

        // Existing handlers kept as-is (engine configuration not touched by the redesign)
        term.parser.registerOscHandler(133, () => true);
        term.parser.registerCsiHandler({ final: 'h' }, () => true);
        term.parser.registerCsiHandler({ final: 'l' }, () => true);

        term.loadAddon(addons.fit);
        term.loadAddon(addons.webLinks);
        term.loadAddon(addons.search);
        term.loadAddon(addons.serialize);
        try {
            term.loadAddon(addons.webgl);
            addons.webgl.onContextLoss(() => {
                console.warn('WebGL context lost, falling back to canvas renderer');
                addons.webgl.dispose();
                term.loadAddon(addons.canvas);
            });
        } catch (e) {
            console.warn('WebGL addon could not be loaded, using canvas renderer:', e);
            term.loadAddon(addons.canvas);
        }
        term.loadAddon(addons.image);
        try {
            term.loadAddon(addons.ligatures);
        } catch (e) {
            console.warn('Ligatures addon could not be loaded:', e);
        }

        // Mobile keyboards: no auto-capitalize / autocorrect inside a shell
        const ta = term.textarea;
        if (ta) {
            ta.setAttribute('autocapitalize', 'off');
            ta.setAttribute('autocorrect', 'off');
            ta.setAttribute('autocomplete', 'off');
            ta.setAttribute('spellcheck', 'false');
            ta.setAttribute('aria-label', `Terminal: ${this.name}`);
            ta.addEventListener('focus', () => this.hooks.onFocusChange(this, true));
            ta.addEventListener('blur', () => this.hooks.onFocusChange(this, false));
        }

        // App shortcuts must not reach the shell
        term.attachCustomKeyEventHandler(e => !this.hooks.isAppShortcut(e));

        this.safeFit();

        if (this.lastContent) {
            try {
                term.write(this.lastContent);
                term.write('\x1b[2m── sessão restaurada · novo shell ──\x1b[0m\r\n');
            } catch (e) {
                console.warn('Failed to restore terminal content:', e);
            }
        }

        // Finger-drag scrolling (xterm's native touch support is too limited on phones)
        this.detachTouch = attachTouchScroll(this.panel, term, data => this.sendInput(data));

        term.onData(data => this.handleInput(data));
        term.onResize(({ cols, rows }) => {
            this.send({
                type: 'resize',
                cols: Math.max(2, Math.min(500, Math.floor(cols))),
                rows: Math.max(2, Math.min(500, Math.floor(rows))),
            });
            this.hooks.onInfo(this);
        });
        term.onTitleChange(title => {
            this.title = title;
            this.hooks.onInfo(this);
        });

        // One observer per panel replaces the old per-tab window listeners:
        // it catches window resize, virtual keyboard, fullscreen and layout changes.
        let frame = 0;
        this.resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => this.safeFit());
        });
        this.resizeObserver.observe(this.panel);

        this.connect();
    }

    // ---------- connection ----------

    connect() {
        if (this.disposed) return;
        this.setState(this.hadShell || this.reconnectAttempts > 0 ? STATE.RECONNECTING : STATE.CONNECTING);

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const basePath = window.appConfig?.basePath || '';
        const cwd = this.cwd || this.startCwd;
        const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
        const ws = new WebSocket(`${protocol}//${window.location.host}${basePath}/${query}`);
        this.ws = ws;

        const connectionTimeout = this.later(() => {
            if (ws.readyState !== WebSocket.OPEN) ws.close();
        }, 5000);

        ws.onopen = () => {
            clearTimeout(connectionTimeout);
            this.reconnectAttempts = 0;
            if (this.hadShell) {
                this.terminal.write('\r\n\x1b[2m── conexão restabelecida · novo shell ──\x1b[0m\r\n');
            }
            this.hadShell = true;
            this.setState(STATE.CONNECTED);
            // Initial size sync once layout has settled
            this.later(() => {
                this.safeFit();
                this.send({ type: 'resize', cols: this.terminal.cols, rows: this.terminal.rows });
            }, 100);
            this.startHeartbeat(ws);
        };

        ws.onmessage = event => {
            let message;
            try {
                message = JSON.parse(event.data);
            } catch (e) {
                console.error('Error processing message:', e);
                return;
            }
            if (message.type === 'output') {
                this.terminal.write(message.data);
                this.hooks.onOutput(this);
            } else if (message.type === 'info') {
                this.shell = message.shell;
                this.home = message.home;
                this.platform = message.platform;
                this.cwd = message.cwd;
                this.hooks.onInfo(this);
            } else if (message.type === 'process-info') {
                this.cwd = message.cwd || this.cwd;
                this.process = message.process;
                this.branch = message.branch || null;
                this.hooks.onInfo(this);
            }
        };

        ws.onerror = () => ws.close();
        ws.onclose = event => {
            clearTimeout(connectionTimeout);
            if (this.ws !== ws) return; // superseded by a newer socket
            this.handleClose(event);
        };
    }

    handleClose(event) {
        if (this.disposed) return;
        this.process = null;

        // 1008 = policy violation: the auth cookie is missing/expired
        if (event && event.code === 1008) {
            this.setState(STATE.ERROR);
            this.hooks.onAuthRequired();
            return;
        }

        // Server closes cleanly when the shell process exits
        if (event && event.wasClean) {
            this.setState(STATE.EXITED);
            this.terminal.write('\r\n\x1b[2m[processo encerrado — pressione Enter para iniciar um novo shell]\x1b[0m\r\n');
            return;
        }

        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            const delay = BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts);
            this.reconnectAttempts++;
            this.setState(STATE.RECONNECTING);
            this.later(() => this.connect(), delay);
        } else {
            this.setState(STATE.DISCONNECTED);
            this.terminal.write('\r\n\x1b[2m[conexão perdida — pressione Enter para reconectar]\x1b[0m\r\n');
        }
    }

    /** Called by the workspace when the page becomes visible again. */
    reconnectIfDropped() {
        if (this.state === STATE.DISCONNECTED) {
            this.reconnectAttempts = 0;
            this.connect();
        }
    }

    startHeartbeat(ws) {
        const interval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat' }));
            else clearInterval(interval);
        }, 10000);
        ws.addEventListener('close', () => clearInterval(interval));
    }

    send(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
            return true;
        }
        return false;
    }

    /** Sends raw bytes to the shell (used by the mobile shortcut bar). */
    sendInput(data) {
        this.handleInput(data, { raw: true });
    }

    handleInput(data, { raw = false } = {}) {
        // Sticky CTRL/ALT from the mobile shortcut bar apply to the next typed key
        const out = raw ? data : this.hooks.transformInput(data);

        if (this.state === STATE.EXITED || this.state === STATE.DISCONNECTED) {
            if (out.includes('\r')) {
                this.reconnectAttempts = 0;
                this.connect();
            }
            return;
        }
        if (!this.send({ type: 'input', data: out })) return;

        // After Enter the shell may have changed directory or started a program
        if (out.includes('\r')) this.requestProcessInfoSoon();
    }

    requestProcessInfoSoon(delay = 400) {
        clearTimeout(this.infoTimer);
        this.infoTimer = this.later(() => this.send({ type: 'process-info' }), delay);
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.hooks.onStateChange(this);
    }

    // ---------- view ----------

    safeFit() {
        // Hidden or zero-sized panels would make fit() compute 0 columns
        if (!this.terminal || this.panel.clientWidth === 0 || this.panel.clientHeight === 0) return;
        try {
            this.addons.fit.fit();
        } catch { /* terminal not ready yet */ }
    }

    setActive(active) {
        this.panel.classList.toggle('active', active);
        this.panel.hidden = false;
        this.panel.setAttribute('aria-hidden', String(!active));
        if (active) {
            this.hasActivity = false;
            this.safeFit();
            this.requestProcessInfoSoon(0);
        } else {
            this.addons?.search.clearDecorations();
        }
    }

    focus() {
        this.terminal?.focus();
    }

    applySettings(key) {
        const s = this.settings;
        const t = this.terminal;
        if (!t) return;
        if (key === 'theme') {
            const theme = s.resolvedTheme();
            t.options.theme = terminalTheme(theme);
            t.options.minimumContrastRatio = theme === 'light' ? 4.5 : 1;
        } else if (['fontSize', 'lineHeight', 'cursorStyle', 'cursorBlink', 'scrollback'].includes(key)) {
            t.options[key] = s.get(key);
            this.safeFit();
        }
    }

    /**
     * Returns the output to persist for this tab, or the previous snapshot while a
     * full-screen program (vim, htop...) owns the alternate buffer.
     */
    serialize() {
        if (!this.terminal || !this.settings.get('restoreContent')) return '';
        if (this.terminal.buffer.active.type === 'alternate') return this.lastContent;
        try {
            const raw = this.addons.serialize.serialize({ scrollback: SERIALIZE_LINES });
            const lines = raw.split(/\r?\n/);
            let last = -1;
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i].trimEnd();
                if (line === '') continue;
                if (!PROMPT_PATTERNS.some(p => p.test(line))) {
                    last = i;
                    break;
                }
            }
            this.lastContent = last >= 0 ? lines.slice(0, last + 1).join('\n') + '\n' : '';
        } catch (e) {
            console.warn('Failed to serialize terminal content:', e);
        }
        return this.lastContent;
    }

    /** Directory to show / reuse: live cwd if known, otherwise where it started. */
    displayCwd() {
        const dir = this.cwd || this.startCwd || '';
        if (this.home && dir.startsWith(this.home)) return '~' + dir.slice(this.home.length);
        return dir;
    }

    later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
        return t;
    }

    dispose() {
        this.disposed = true;
        this.timers.forEach(clearTimeout);
        this.timers.clear();
        this.resizeObserver?.disconnect();
        this.detachTouch?.();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.terminal?.dispose();
        this.panel.remove();
    }
}
