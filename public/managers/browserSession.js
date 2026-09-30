/**
 * browserSession.js
 * A browser tab: shows a page running in the server's Chromium (JPEG frames over the
 * tab's WebSocket) and sends back clicks, touches, scrolling and typing. Same interface
 * as TerminalSession, so tabs, status bar, menus and the shortcut bar work with both.
 */
import { STATE, SESSION_COLORS } from './session.js';
import { icon } from '../ui/icons.js';
import { showMenu } from '../ui/contextMenu.js';
import StorageManager from './storage.js';

const MAX_RECONNECT_ATTEMPTS = 6;
const CLOSE_SESSION_GONE = 4404;
const coarse = () => window.matchMedia('(pointer: coarse)').matches;

// JPEG quality of the stream and max pixel density (more = sharper, more data)
const QUALITY = {
    high: { label: 'Alta', jpeg: 92, maxDpr: 3 },
    medium: { label: 'Média', jpeg: 80, maxDpr: 2 },
    low: { label: 'Leve (4G)', jpeg: 60, maxDpr: 1 },
};
const MODES = {
    auto: { label: 'Tamanho da aba' },
    mobile: { label: 'Celular (390×844)', width: 390, height: 844, mobile: true },
    desktop: { label: 'Desktop (1280×800)', width: 1280, height: 800, mobile: false },
};

// Terminal byte sequences (shortcut bar, quick commands) -> browser keys
const SEQUENCES = [
    ['\x1b[A', 'ArrowUp'], ['\x1bOA', 'ArrowUp'], ['\x1b[B', 'ArrowDown'], ['\x1bOB', 'ArrowDown'],
    ['\x1b[C', 'ArrowRight'], ['\x1bOC', 'ArrowRight'], ['\x1b[D', 'ArrowLeft'], ['\x1bOD', 'ArrowLeft'],
    ['\x1b[H', 'Home'], ['\x1bOH', 'Home'], ['\x1b[F', 'End'], ['\x1bOF', 'End'],
    ['\x1b[5~', 'PageUp'], ['\x1b[6~', 'PageDown'], ['\x1b[3~', 'Delete'],
];
const MOD_FINAL = { A: 'ArrowUp', B: 'ArrowDown', C: 'ArrowRight', D: 'ArrowLeft', H: 'Home', F: 'End' };

const prefs = new StorageManager('meuterminal-');

export default class BrowserSession {
    /**
     * @param {object} opts
     * @param {object} opts.row - session from /api/sessions (kind 'browser')
     * @param {object} opts.settings - SettingsManager
     * @param {object} opts.hooks - callbacks into the workspace
     */
    constructor({ row, settings, hooks }) {
        this.kind = 'browser';
        this.id = row.id;
        this.name = row.name;
        this.pinned = !!row.pinned;
        this.color = SESSION_COLORS.includes(row.color) ? row.color : 'blue';
        this.url = row.url || '';
        this.title = '';
        this.settings = settings;
        this.hooks = hooks;

        // Fields the rest of the app reads from terminal sessions
        this.state = STATE.CONNECTING;
        this.shell = 'navegador';
        this.startCwd = '';
        this.cwd = null;
        this.process = null;
        this.branch = null;
        this.pid = null;
        this.terminal = null;
        this.addons = null;
        this.hasActivity = false;

        const saved = prefs.get('browser', {});
        this.mode = MODES[saved.mode] ? saved.mode : 'auto';
        this.quality = QUALITY[saved.quality] ? saved.quality : 'high';
        this.vp = { width: 0, height: 0, dpr: 1, mobile: false, quality: 92 };
        this.active = false;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.disposed = false;
        this.timers = new Set();
        this.frameSeq = 0;
        this.drawnSeq = 0;
        this.nav = { canGoBack: false, canGoForward: false, loading: false };

        this.panel = document.createElement('div');
        this.panel.className = 'terminal-panel browser-panel';
        this.panel.id = `panel-${this.id}`;
        this.panel.setAttribute('role', 'tabpanel');
        this.panel.setAttribute('aria-labelledby', `tab-${this.id}`);
    }

    get sizeLabel() {
        return this.vp.width ? `${this.vp.width}×${this.vp.height}` : '';
    }

    // ---------- view ----------

    mount(parent) {
        parent.appendChild(this.panel);
        this.panel.innerHTML = `
            <div class="browser-toolbar">
                <button type="button" class="icon-btn" data-act="back" aria-label="Voltar" disabled>${icon('chevronLeft', 18)}</button>
                <button type="button" class="icon-btn" data-act="forward" aria-label="Avançar" disabled>${icon('chevronRight', 18)}</button>
                <button type="button" class="icon-btn" data-act="reload" aria-label="Recarregar">${icon('refresh', 17)}</button>
                <form class="browser-address" autocomplete="off">
                    <input type="text" inputmode="url" enterkeyhint="go" spellcheck="false" autocapitalize="off"
                        autocorrect="off" placeholder="localhost:5173 ou endereço" aria-label="Endereço">
                </form>
                <button type="button" class="icon-btn" data-act="ports" aria-label="Portas abertas no servidor">${icon('activity', 17)}</button>
                <button type="button" class="icon-btn" data-act="view" aria-label="Tamanho e qualidade">${icon('settings', 17)}</button>
                <button type="button" class="icon-btn browser-kbd-btn" data-act="keyboard" aria-label="Abrir teclado">${icon('keyboard', 18)}</button>
            </div>
            <div class="browser-progress" hidden></div>
            <div class="browser-viewer">
                <div class="browser-surface" tabindex="0" aria-label="Página do navegador">
                    <canvas></canvas>
                </div>
                <div class="browser-status" role="status" aria-live="polite"></div>
            </div>
            <textarea class="browser-kbd" autocapitalize="off" autocorrect="off" autocomplete="off"
                spellcheck="false" aria-label="Digitar na página"></textarea>`;
        const q = sel => this.panel.querySelector(sel);
        this.el = {
            address: q('.browser-address input'),
            form: q('.browser-address'),
            back: q('[data-act="back"]'),
            forward: q('[data-act="forward"]'),
            reload: q('[data-act="reload"]'),
            progress: q('.browser-progress'),
            viewer: q('.browser-viewer'),
            surface: q('.browser-surface'),
            canvas: q('canvas'),
            status: q('.browser-status'),
            kbd: q('.browser-kbd'),
        };
        this.ctx = this.el.canvas.getContext('2d');
        this.el.address.value = this.url;
        this.bindToolbar();
        this.bindPointer();
        this.bindTouch();
        this.bindKeyboard();

        let frame = 0;
        this.resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => this.layout());
        });
        this.resizeObserver.observe(this.el.viewer);
        this.layout();
        this.connect();
    }

    setActive(active) {
        this.active = active;
        this.panel.classList.toggle('active', active);
        this.panel.setAttribute('aria-hidden', String(!active));
        // Hidden tabs receive no frames (saves bandwidth and server CPU)
        this.send({ type: 'visibility', visible: active });
        if (active) this.layout();
    }

    focus() {
        if (!coarse()) this.el?.surface.focus({ preventScroll: true });
    }

    applySettings() { /* the page keeps its own colors/fonts */ }

    applyRow(row) {
        this.name = row.name;
        this.pinned = !!row.pinned;
        if (SESSION_COLORS.includes(row.color)) this.color = row.color;
        if (row.url && row.url !== this.url) {
            this.url = row.url;
            if (document.activeElement !== this.el?.address) this.el.address.value = row.url;
        }
    }

    /** Tab subtitle / status bar "directory": host and path of the page. */
    displayCwd() {
        if (!this.url || this.url === 'about:blank') return 'nova página';
        try {
            const u = new URL(this.url);
            return (u.host + (u.pathname === '/' ? '' : u.pathname)) || this.url;
        } catch {
            return this.url;
        }
    }

    showStatus(text, ms = 3000) {
        if (!this.el) return;
        this.el.status.textContent = text;
        clearTimeout(this.statusTimer);
        if (ms) this.statusTimer = setTimeout(() => { this.el.status.textContent = ''; }, ms);
    }

    // ---------- connection ----------

    connect() {
        if (this.disposed) return;
        this.setState(this.reconnectAttempts > 0 ? STATE.RECONNECTING : STATE.CONNECTING);
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const basePath = window.appConfig?.basePath || '';
        const v = this.computeViewport();
        const query = new URLSearchParams({
            session: this.id,
            width: String(v.width), height: String(v.height), dpr: String(v.dpr),
            mobile: v.mobile ? '1' : '0', quality: String(v.quality), visible: this.active ? '1' : '0',
        });
        if (v.width) this.vp = v;
        const ws = new WebSocket(`${protocol}//${window.location.host}${basePath}/?${query}`);
        ws.binaryType = 'blob';
        this.ws = ws;

        const timeout = this.later(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 8000);
        ws.onopen = () => {
            clearTimeout(timeout);
            this.reconnectAttempts = 0;
            this.setState(STATE.CONNECTED);
            this.startHeartbeat(ws);
            // Visibility/size may have changed while connecting (messages sent before
            // the socket opened are dropped): send the current ones now
            this.send({ type: 'visibility', visible: this.active });
            const v = this.computeViewport();
            if (v.width) {
                this.vp = v;
                this.send({ type: 'viewport', ...v });
            }
        };
        ws.onmessage = event => {
            if (typeof event.data !== 'string') {
                this.drawFrame(event.data);
                return;
            }
            let m;
            try {
                m = JSON.parse(event.data);
            } catch {
                return;
            }
            if (m.type === 'state') this.applyState(m);
            else if (m.type === 'status') this.showStatus(m.message, 5000);
            else if (m.type === 'ports') this.showPorts(m.ports);
            else if (m.type === 'editable' && m.value && coarse()) this.openKeyboard();
            else if (m.type === 'workspace') this.hooks.onWorkspaceChanged();
            else if (m.type === 'open-tab' || m.type === 'notify') this.hooks.onServerMessage(m);
        };
        ws.onerror = () => ws.close();
        ws.onclose = event => {
            clearTimeout(timeout);
            if (this.ws !== ws || this.disposed) return;
            if (event.code === 1008) {
                this.setState(STATE.ERROR);
                this.hooks.onAuthRequired();
                return;
            }
            if (event.code === CLOSE_SESSION_GONE) {
                this.hooks.onRemoved(this);
                return;
            }
            if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                const delay = 1000 * Math.pow(2, this.reconnectAttempts++);
                this.setState(STATE.RECONNECTING);
                this.later(() => this.connect(), delay);
            } else {
                this.setState(STATE.DISCONNECTED);
                this.showStatus('Conexão perdida. Toque em recarregar para tentar de novo.', 0);
            }
        };
    }

    reconnectIfDropped() {
        if (this.state === STATE.DISCONNECTED) {
            this.reconnectAttempts = 0;
            this.connect();
        }
    }

    startHeartbeat(ws) {
        const interval = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) clearInterval(interval);
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

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.hooks.onStateChange(this);
    }

    applyState(s) {
        this.nav = s;
        if (s.url && s.url !== 'about:blank') this.url = s.url;
        this.title = s.title || '';
        // The status bar shows the page title where terminals show the running process
        this.process = this.title || null;
        if (document.activeElement !== this.el.address) {
            this.el.address.value = s.url && s.url !== 'about:blank' ? s.url : '';
        }
        this.el.back.disabled = !s.canGoBack;
        this.el.forward.disabled = !s.canGoForward;
        this.el.reload.innerHTML = s.loading ? icon('x', 17) : icon('refresh', 17);
        this.el.reload.setAttribute('aria-label', s.loading ? 'Parar' : 'Recarregar');
        this.el.progress.hidden = !s.loading;
        this.hooks.onInfo(this);
    }

    /** Frames can decode out of order: only draw one newer than the last drawn. */
    drawFrame(blob) {
        const seq = ++this.frameSeq;
        createImageBitmap(blob).then(bitmap => {
            if (seq < this.drawnSeq || this.disposed) {
                bitmap.close();
                return;
            }
            this.drawnSeq = seq;
            const { canvas } = this.el;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
            }
            this.ctx.drawImage(bitmap, 0, 0);
            bitmap.close();
        }).catch(() => {});
    }

    // ---------- viewport ----------

    computeViewport() {
        const box = this.el.viewer.getBoundingClientRect();
        const cw = Math.floor(box.width);
        const ch = Math.floor(box.height);
        const m = MODES[this.mode];
        let next = m.width ? { width: m.width, height: m.height, mobile: m.mobile } : { width: cw, height: ch, mobile: coarse() };
        if (cw < 50 || ch < 50) next = { ...this.vp };
        const scale = next.width ? Math.min(cw / next.width, ch / next.height, this.mode === 'auto' ? 1 : Infinity) : 1;
        const q = QUALITY[this.quality];
        next.dpr = Math.max(1, Math.min(q.maxDpr, Math.round(devicePixelRatio * scale * 100) / 100));
        next.quality = q.jpeg;
        next.scale = scale;
        return next;
    }

    layout() {
        if (!this.el) return;
        const next = this.computeViewport();
        if (!next.width) return;
        this.el.surface.style.width = `${Math.floor(next.width * next.scale)}px`;
        this.el.surface.style.height = `${Math.floor(next.height * next.scale)}px`;
        const changed = ['width', 'height', 'dpr', 'mobile', 'quality'].some(k => next[k] !== this.vp[k]);
        this.vp = next;
        if (changed) {
            clearTimeout(this.layoutTimer);
            this.layoutTimer = this.later(() => {
                this.send({ type: 'viewport', ...this.vp });
                this.hooks.onInfo(this);
            }, 120);
        }
    }

    /** Window point -> page coordinates (CSS px of the remote page). */
    toPage(clientX, clientY) {
        const r = this.el.surface.getBoundingClientRect();
        return {
            x: Math.round((clientX - r.left) * (this.vp.width / r.width)),
            y: Math.round((clientY - r.top) * (this.vp.height / r.height)),
        };
    }

    // ---------- toolbar ----------

    bindToolbar() {
        const { form, address } = this.el;
        form.addEventListener('submit', e => {
            e.preventDefault();
            this.navigate(address.value);
            address.blur();
            this.focus();
        });
        address.addEventListener('focus', () => address.select());
        this.panel.querySelector('.browser-toolbar').addEventListener('click', e => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            const act = btn.dataset.act;
            if (act === 'back' || act === 'forward') this.send({ type: act });
            else if (act === 'reload') {
                if (this.state === STATE.DISCONNECTED) this.reconnectIfDropped();
                else this.send({ type: this.nav.loading ? 'stop' : 'reload' });
            } else if (act === 'ports') this.send({ type: 'ports' }) || this.showStatus('Sem conexão');
            else if (act === 'view') this.openViewMenu(btn);
            else if (act === 'keyboard') {
                if (document.activeElement === this.el.kbd) this.el.kbd.blur();
                else this.openKeyboard();
            }
        });
    }

    navigate(url) {
        if (url && url.trim()) this.send({ type: 'navigate', url });
    }

    openViewMenu(anchor) {
        const item = (label, checked, run) => ({ label, checked, run });
        showMenu([
            ...Object.entries(MODES).map(([key, m]) => item(m.label, this.mode === key, () => this.setPref('mode', key))),
            'separator',
            ...Object.entries(QUALITY).map(([key, q]) => item(`Qualidade: ${q.label}`, this.quality === key,
                () => this.setPref('quality', key))),
        ], { anchor, label: 'Tamanho e qualidade' });
    }

    setPref(key, value) {
        this[key] = value;
        prefs.set('browser', { mode: this.mode, quality: this.quality });
        this.layout();
    }

    showPorts(ports) {
        const anchor = this.panel.querySelector('[data-act="ports"]');
        const items = ports.map(({ port, name }) => ({
            label: `localhost:${port}`,
            hint: name,
            icon: 'terminal',
            run: () => this.navigate(`localhost:${port}`),
        }));
        if (!items.length) {
            items.push({ label: 'Nenhuma porta aberta. Rode o projeto (npm run dev) e tente de novo.', disabled: true });
        }
        showMenu(items, { anchor, label: 'Portas abertas no servidor' });
    }

    // ---------- mouse ----------

    bindPointer() {
        const s = this.el.surface;
        const BUTTONS = ['left', 'middle', 'right'];
        let last = { time: 0, x: 0, y: 0, count: 0 };
        let move = null;
        const mods = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

        s.addEventListener('pointerdown', e => {
            if (e.pointerType === 'touch') return;
            s.focus({ preventScroll: true });
            s.setPointerCapture(e.pointerId);
            const p = this.toPage(e.clientX, e.clientY);
            const now = performance.now();
            const again = now - last.time < 400 && Math.hypot(p.x - last.x, p.y - last.y) < 5;
            last = { time: now, x: p.x, y: p.y, count: again ? last.count + 1 : 1 };
            this.send({ type: 'mouse', event: 'down', ...p, button: BUTTONS[e.button] || 'left', clickCount: last.count, modifiers: mods(e) });
            e.preventDefault();
        });
        s.addEventListener('pointerup', e => {
            if (e.pointerType === 'touch') return;
            this.send({ type: 'mouse', event: 'up', ...this.toPage(e.clientX, e.clientY), button: BUTTONS[e.button] || 'left',
                clickCount: last.count, modifiers: mods(e) });
        });
        s.addEventListener('pointermove', e => {
            if (e.pointerType === 'touch') return;
            const first = !move;
            move = { ...this.toPage(e.clientX, e.clientY), button: e.buttons & 1 ? 'left' : 'none', modifiers: mods(e) };
            if (first) {
                requestAnimationFrame(() => {
                    this.send({ type: 'mouse', event: 'move', ...move });
                    move = null;
                });
            }
        });
        s.addEventListener('contextmenu', e => e.preventDefault());
        s.addEventListener('wheel', e => {
            e.preventDefault();
            const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? this.vp.height : 1;
            this.send({ type: 'wheel', ...this.toPage(e.clientX, e.clientY), deltaX: e.deltaX * unit, deltaY: e.deltaY * unit });
        }, { passive: false });
    }

    // ---------- touch: tap = click, drag = scroll (momentum), 2-finger tap = right click ----------

    bindTouch() {
        const s = this.el.surface;
        let touch = null;
        let fling = 0;
        const scrollBy = (dx, dy, x, y) => {
            const r = s.getBoundingClientRect();
            const k = this.vp.width / r.width;
            this.send({ type: 'wheel', ...this.toPage(x, y), deltaX: dx * k, deltaY: dy * k });
        };
        s.addEventListener('touchstart', e => {
            e.preventDefault();
            cancelAnimationFrame(fling);
            if (e.touches.length === 2) {
                const [a, b] = e.touches;
                touch = { two: true, start: performance.now(), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, moved: false };
                return;
            }
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            touch = { two: false, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, time: performance.now(), vx: 0, vy: 0, dragging: false };
        }, { passive: false });
        s.addEventListener('touchmove', e => {
            e.preventDefault();
            if (!touch) return;
            if (touch.two) {
                touch.moved = true;
                return;
            }
            const t = e.touches[0];
            if (!touch.dragging && Math.hypot(t.clientX - touch.x0, t.clientY - touch.y0) < 8) return;
            touch.dragging = true;
            const now = performance.now();
            const dt = Math.max(1, now - touch.time);
            const dx = touch.x - t.clientX;
            const dy = touch.y - t.clientY;
            touch.vx = 0.8 * (dx / dt) + 0.2 * touch.vx;
            touch.vy = 0.8 * (dy / dt) + 0.2 * touch.vy;
            touch.x = t.clientX;
            touch.y = t.clientY;
            touch.time = now;
            scrollBy(dx, dy, t.clientX, t.clientY);
        }, { passive: false });
        s.addEventListener('touchend', e => {
            e.preventDefault();
            if (!touch || e.touches.length) return;
            const t = touch;
            touch = null;
            if (t.two) {
                if (!t.moved && performance.now() - t.start < 350) this.send({ type: 'tap', ...this.toPage(t.x, t.y), button: 'right' });
                return;
            }
            if (!t.dragging) {
                this.send({ type: 'tap', ...this.toPage(t.x0, t.y0) });
                return;
            }
            if (performance.now() - t.time > 80) return;
            let vx = t.vx;
            let vy = t.vy;
            let prev = performance.now();
            const step = now => {
                const dt = now - prev;
                prev = now;
                scrollBy(vx * dt, vy * dt, t.x, t.y);
                vx *= Math.pow(0.95, dt / 16);
                vy *= Math.pow(0.95, dt / 16);
                if (Math.hypot(vx, vy) > 0.05) fling = requestAnimationFrame(step);
            };
            fling = requestAnimationFrame(step);
        }, { passive: false });
    }

    // ---------- keyboard ----------

    bindKeyboard() {
        const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown',
            'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
        const onKeyDown = e => {
            if (e.isComposing || e.keyCode === 229) return; // phone keyboards: handled by 'input'
            const mods = (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
            if (SPECIAL.has(e.key)) {
                this.send({ type: 'key', key: e.key, modifiers: mods });
                e.preventDefault();
            } else if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
                if (e.key.toLowerCase() === 'v') return; // the paste event carries the text
                this.send({ type: 'key', key: e.key, modifiers: mods });
                e.preventDefault();
            } else if (e.key.length === 1 && !e.altKey) {
                this.send({ type: 'text', text: e.key });
                e.preventDefault();
            }
        };
        const { surface, kbd } = this.el;
        surface.addEventListener('keydown', onKeyDown);
        kbd.addEventListener('keydown', onKeyDown);
        const onPaste = e => {
            const text = e.clipboardData.getData('text');
            if (text) this.sendText(text);
            e.preventDefault();
        };
        surface.addEventListener('paste', onPaste);
        kbd.addEventListener('paste', onPaste);

        // Phone keyboard: the hidden field keeps a sentinel so Backspace on "empty" still
        // produces an input event; we diff the value, forward it and reset.
        const SENTINEL = '​​';
        let composing = false;
        kbd.value = SENTINEL;
        const flush = () => {
            const value = kbd.value;
            if (value.startsWith(SENTINEL)) {
                const added = value.slice(SENTINEL.length);
                added.split('\n').forEach((part, i) => {
                    if (i > 0) this.send({ type: 'key', key: 'Enter' });
                    if (part) this.send({ type: 'text', text: part });
                });
            } else {
                const deleted = Math.max(1, SENTINEL.length - value.length);
                for (let i = 0; i < deleted; i++) this.send({ type: 'key', key: 'Backspace' });
            }
            kbd.value = SENTINEL;
            kbd.setSelectionRange(SENTINEL.length, SENTINEL.length);
        };
        kbd.addEventListener('compositionstart', () => { composing = true; });
        kbd.addEventListener('compositionend', () => { composing = false; flush(); });
        kbd.addEventListener('input', () => { if (!composing) flush(); });
        // The shortcut bar shows up while typing in the page, like in the terminal
        kbd.addEventListener('focus', () => this.hooks.onFocusChange(this, true));
        kbd.addEventListener('blur', () => this.hooks.onFocusChange(this, false));
        this.sentinel = SENTINEL;
    }

    openKeyboard() {
        const { kbd } = this.el;
        kbd.value = this.sentinel;
        kbd.focus({ preventScroll: true });
        kbd.setSelectionRange(this.sentinel.length, this.sentinel.length);
    }

    /** Plain text (paste, dictation, clipboard history). */
    sendText(text) {
        const parts = String(text).split(/\r?\n/);
        parts.forEach((part, i) => {
            if (i > 0) this.send({ type: 'key', key: 'Enter' });
            if (part) this.send({ type: 'text', text: part });
        });
    }

    /**
     * Terminal-style input (shortcut bar keys, quick commands) translated into browser
     * keys: "\r" = Enter, "\x1b[A" = ArrowUp, "\x03" = Ctrl+C, ...
     */
    sendInput(data) {
        let text = '';
        const flushText = () => {
            if (text) this.send({ type: 'text', text });
            text = '';
        };
        for (let i = 0; i < data.length;) {
            const rest = data.slice(i);
            const seq = SEQUENCES.find(([s]) => rest.startsWith(s));
            if (seq) {
                flushText();
                this.send({ type: 'key', key: seq[1] });
                i += seq[0].length;
                continue;
            }
            // xterm modifier encoding: ESC [ 1 ; <mod> <final>
            const mod = /^\x1b\[1;(\d)([ABCDHF])/.exec(rest);
            if (mod) {
                flushText();
                const bits = Number(mod[1]) - 1; // xterm: 1 shift, 2 alt, 4 ctrl
                const modifiers = (bits & 2 ? 1 : 0) | (bits & 4 ? 2 : 0) | (bits & 1 ? 8 : 0);
                this.send({ type: 'key', key: MOD_FINAL[mod[2]], modifiers });
                i += mod[0].length;
                continue;
            }
            const ch = data[i];
            const code = ch.charCodeAt(0);
            const named = { '\r': 'Enter', '\n': 'Enter', '\t': 'Tab', '\x1b': 'Escape', '\x7f': 'Backspace', '\b': 'Backspace' }[ch];
            if (named) {
                flushText();
                this.send({ type: 'key', key: named });
            } else if (code >= 1 && code <= 26) {
                // Ctrl+letter
                flushText();
                this.send({ type: 'key', key: String.fromCharCode(code + 96), modifiers: 2 });
            } else {
                text += ch;
            }
            i++;
        }
        flushText();
    }

    // ---------- lifecycle ----------

    later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
        return t;
    }

    /** Removes the view only; the page keeps running on the server until the tab is closed. */
    dispose() {
        this.disposed = true;
        this.timers.forEach(clearTimeout);
        this.timers.clear();
        this.resizeObserver?.disconnect();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.panel.remove();
    }
}
