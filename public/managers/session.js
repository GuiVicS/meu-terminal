/**
 * session.js
 * One tab = one xterm.js view attached (over WebSocket) to a persistent server-side session.
 * The shell lives on the server: closing the page only detaches; on reconnect the server
 * sends the current screen. Cleans up every listener it creates on dispose().
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

const MAX_RECONNECT_ATTEMPTS = 6;
const BASE_RECONNECT_DELAY = 1000;
const CLOSE_SESSION_GONE = 4404; // server: session was closed (maybe on another device)

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
     * @param {object} opts.row - session as returned by /api/sessions (id, name, color, ...)
     * @param {object} opts.settings - SettingsManager
     * @param {object} opts.hooks - callbacks into the workspace
     */
    constructor({ row, settings, hooks }) {
        this.kind = 'terminal';
        this.id = row.id;         // server session id (UUID)
        this.name = row.name;
        this.pinned = !!row.pinned;
        this.color = SESSION_COLORS.includes(row.color) ? row.color : 'green';
        this.branch = null;       // git branch of cwd (Linux only)
        this.startCwd = row.startCwd || '';
        this.pid = row.pid || null;
        this.settings = settings;
        this.hooks = hooks;
        const id = this.id;

        // Connection / process state
        this.state = STATE.CONNECTING;
        this.shell = null;
        this.home = null;
        this.platform = null;
        this.cwd = row.cwd || null; // live cwd (Linux only)
        this.process = null;      // foreground process (Linux only)
        this.title = '';          // OSC title set by the shell, if any
        this.hasActivity = false; // new output while in background

        this.ws = null;
        this.reconnectAttempts = 0;
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

        // OSC 133 (shell integration marks) is ignored, as before.
        // The old handlers that swallowed every CSI "h"/"l" (DECSET/DECRST) were removed:
        // they kept programs from enabling mouse reporting (needed for touch scrolling
        // inside TUIs), the alternate screen (vim/htop) and bracketed paste.
        term.parser.registerOscHandler(133, () => true);

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

        // Touch gestures: 1-finger scroll (positional inside TUIs), 2-finger tap = right click
        this.detachTouch = attachTouchScroll(this.panel, term, data => this.sendInput(data), {
            onSecondaryTap: (x, y) => this.hooks.onTerminalMenu(this, x, y),
        });

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
        this.safeFit();
        // The size goes along so the server's screen copy matches before it's sent back
        const query = new URLSearchParams({
            session: this.id,
            cols: String(this.terminal.cols),
            rows: String(this.terminal.rows),
        });
        const ws = new WebSocket(`${protocol}//${window.location.host}${basePath}/?${query}`);
        this.ws = ws;

        const connectionTimeout = this.later(() => {
            if (ws.readyState !== WebSocket.OPEN) ws.close();
        }, 5000);

        ws.onopen = () => {
            clearTimeout(connectionTimeout);
            this.reconnectAttempts = 0;
            this.setState(STATE.CONNECTED);
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
            } else if (message.type === 'snapshot') {
                // Full current screen from the server (first connect or re-attach):
                // replaces whatever this view showed, so nothing is duplicated
                this.terminal.reset();
                this.terminal.write(message.data, () => this.terminal.scrollToBottom());
                if (this.state === STATE.EXITED) this.setState(STATE.CONNECTED);
            } else if (message.type === 'exit') {
                this.process = null;
                this.setState(STATE.EXITED);
            } else if (message.type === 'workspace') {
                this.hooks.onWorkspaceChanged();
            } else if (message.nonce) { // app-wide notices from the server (open-tab, notify, split, vibe-form...)
                this.hooks.onServerMessage(message); // from the MCP (agents)
            } else if (message.type === 'info') {
                this.shell = message.shell;
                this.home = message.home;
                this.platform = message.platform;
                this.pid = message.pid;
                this.cwd = message.cwd || this.cwd;
                if (this.state === STATE.EXITED) this.setState(STATE.CONNECTED); // shell restarted
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

        // The session no longer exists on the server (closed on another device)
        if (event && event.code === CLOSE_SESSION_GONE) {
            this.hooks.onRemoved(this);
            return;
        }

        // Anything else is a dropped connection: the shell is still running on the
        // server, so keep trying to re-attach
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

        // Shell ended: Enter asks the server for a new shell in this same tab
        if (this.state === STATE.EXITED) {
            if (out.includes('\r')) this.send({ type: 'restart' });
            return;
        }
        if (this.state === STATE.DISCONNECTED) {
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

    /** Applies metadata changed elsewhere (another device / tab). */
    applyRow(row) {
        this.name = row.name;
        this.pinned = !!row.pinned;
        if (SESSION_COLORS.includes(row.color)) this.color = row.color;
        this.terminal?.textarea?.setAttribute('aria-label', `Terminal: ${this.name}`);
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

    /** Removes the view only. The shell keeps running on the server. */
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
