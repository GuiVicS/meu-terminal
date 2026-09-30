/**
 * browser-manager.js
 * Browser tabs: one headless Chromium on the server, one page per browser tab. The page
 * is shown to viewers as JPEG screencast frames over the tab's WebSocket, and clicks,
 * touches, scrolling and typing are sent back. Because Chromium runs on the server,
 * "localhost:5173" opens the dev servers started in the terminal.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const CHROMIUM_CANDIDATES = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

const DEFAULT_URL = 'about:blank';
const OPEN = 1; // WebSocket.OPEN

function findChromium() {
    return CHROMIUM_CANDIDATES.find(p => {
        try { return fs.statSync(p).isFile(); } catch { return false; }
    }) || null;
}

// Keys the page can't type as text: CDP needs key/code/keyCode to dispatch them
const SPECIAL_KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Tab: { code: 'Tab', keyCode: 9 },
    Escape: { code: 'Escape', keyCode: 27 },
    Delete: { code: 'Delete', keyCode: 46 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
};

/** Turns what the user typed in the address bar into a URL. */
function normalizeUrl(input) {
    const text = String(input || '').trim();
    if (!text) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data):/i.test(text)) return text;
    // localhost, localhost:5173, 127.0.0.1:3000, 192.168.0.10:8080 -> http
    if (/^(localhost|127\.\d+\.\d+\.\d+|\d+\.\d+\.\d+\.\d+|\[[0-9a-f:]+\])(:\d+)?(\/.*)?$/i.test(text)) {
        return `http://${text}`;
    }
    // ":5173" or "5173" -> a port on this server
    if (/^:?\d{2,5}(\/.*)?$/.test(text)) return `http://localhost:${text.replace(/^:/, '')}`;
    if (/^[^\s]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(text)) return `https://${text}`;
    return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
}

/**
 * Chrome DevTools Protocol over a pipe (--remote-debugging-pipe): no debugging port is
 * opened on the server. Messages are JSON separated by NUL bytes (fd 3 in, fd 4 out).
 */
class PipeCdp {
    constructor(proc, log) {
        this.out = proc.stdio[3];
        this.log = log;
        this.nextId = 0;
        this.pending = new Map();
        this.listeners = new Set();
        let buffer = '';
        proc.stdio[4].on('data', chunk => {
            buffer += chunk;
            let end;
            while ((end = buffer.indexOf('\0')) !== -1) {
                const raw = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                try {
                    this.dispatch(JSON.parse(raw));
                } catch (e) {
                    this.log('CDP parse error:', e.message);
                }
            }
        });
        proc.once('exit', () => {
            this.pending.forEach(p => p.reject(new Error('Chromium encerrou')));
            this.pending.clear();
        });
    }

    dispatch(msg) {
        if (msg.id !== undefined) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
        } else {
            this.listeners.forEach(fn => fn(msg));
        }
    }

    send(method, params = {}, sessionId) {
        const id = ++this.nextId;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.out.write(JSON.stringify(payload) + '\0');
        });
    }

    on(fn) {
        this.listeners.add(fn);
    }
}

class BrowserManager {
    /**
     * @param {object} opts
     * @param {string} opts.profileDir - Chromium user data dir (cookies/logins of the pages)
     * @param {(id: string, url: string) => void} opts.onUrlChange - persist the tab's URL
     * @param {number[]} opts.hiddenPorts - ports not suggested (the app's own)
     * @param {Function} opts.log
     */
    constructor({ profileDir, onUrlChange, hiddenPorts = [], log = () => {} }) {
        this.profileDir = profileDir;
        this.onUrlChange = onUrlChange;
        this.hiddenPorts = hiddenPorts;
        this.log = log;
        this.exe = findChromium();
        this.proc = null;
        this.cdp = null;
        this.ready = null;
        this.pages = new Map();      // tab id -> page state
        this.bySession = new Map();  // CDP sessionId -> page state
        this.idleTimer = null;
    }

    get available() {
        return !!this.exe;
    }

    // ---------- Chromium process ----------

    start() {
        if (!this.ready) {
            this.ready = this.launch().catch(e => {
                this.ready = null;
                if (this.proc) {
                    this.proc.removeAllListeners('exit');
                    try { this.proc.kill(); } catch { /* gone */ }
                    this.proc = null;
                }
                throw e;
            });
        }
        return this.ready;
    }

    async launch() {
        if (!this.exe) throw new Error('Chromium não está instalado no servidor.');
        const args = [
            '--headless=new',
            '--remote-debugging-pipe',
            `--user-data-dir=${this.profileDir}`,
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-dev-shm-usage',
            '--hide-scrollbars',
            // Screencast frames follow the window's scale, not the emulated one: render at 2x
            // so text is sharp on phones (frames are scaled down for 1x screens / "Leve")
            '--force-device-scale-factor=2',
            '--mute-audio',
            '--disable-background-networking',
            '--disable-sync',
            '--password-store=basic',
            'about:blank',
        ];
        // Chromium refuses to run as root without this (the usual case inside Docker)
        if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');

        this.proc = spawn(this.exe, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
        this.proc.once('exit', () => this.onExit());
        this.cdp = new PipeCdp(this.proc, this.log);
        this.cdp.on(msg => this.onEvent(msg));
        const { userAgent } = await this.cdp.send('Browser.getVersion');
        // Headless announces itself in the user agent; some sites block that
        this.userAgent = userAgent.replace('HeadlessChrome', 'Chrome');
        await this.cdp.send('Target.setDiscoverTargets', { discover: true });
        await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
        this.log(`Chromium iniciado (PID ${this.proc.pid})`);
    }

    onExit() {
        this.log('Chromium encerrou');
        this.ready = null;
        this.cdp = null;
        this.proc = null;
        this.bySession.clear();
        // Pages will be recreated (at their last URL) when a viewer attaches again
        this.pages.forEach(page => {
            page.sessionId = null;
            page.targetId = null;
            page.opening = null;
            page.screencasting = false;
            this.broadcast(page, { type: 'state', ...page.state, crashed: true });
        });
        const open = [...this.pages.values()].filter(p => p.clients.size);
        if (open.length) open.forEach(page => this.openPage(page).catch(() => {}));
    }

    /** Chromium only runs while there are browser tabs. */
    scheduleIdleShutdown() {
        clearTimeout(this.idleTimer);
        if (this.pages.size) return;
        this.idleTimer = setTimeout(() => {
            if (!this.pages.size && this.proc) {
                this.log('Sem abas de navegador: encerrando o Chromium');
                try { this.proc.kill(); } catch { /* gone */ }
            }
        }, 60000);
    }

    // ---------- pages ----------

    getPage(row) {
        let page = this.pages.get(row.id);
        if (!page) {
            page = {
                id: row.id,
                targetId: null,
                sessionId: null,
                opening: null,
                clients: new Set(),
                screencasting: false,
                lastFrame: null,
                quality: 85,
                viewport: { width: 1280, height: 800, dpr: 1, mobile: false },
                state: { url: row.url || DEFAULT_URL, title: '', loading: false, canGoBack: false, canGoForward: false },
            };
            this.pages.set(row.id, page);
        }
        clearTimeout(this.idleTimer);
        return page;
    }

    /** Creates the Chromium page for a tab (once), at its saved URL. */
    openPage(page) {
        if (page.sessionId) return Promise.resolve();
        if (page.opening) return page.opening;
        page.opening = (async () => {
            await this.start();
            const { targetId } = await this.cdp.send('Target.createTarget', { url: 'about:blank' });
            const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
            page.targetId = targetId;
            page.sessionId = sessionId;
            this.bySession.set(sessionId, page);
            await this.call(page, 'Page.enable');
            await this.call(page, 'Runtime.enable');
            await this.applyViewport(page);
            // Saved URLs from older rows may lack the scheme ("localhost:5173")
            const url = page.state.url && page.state.url !== DEFAULT_URL ? normalizeUrl(page.state.url) : null;
            if (url) this.navigate(page, url).catch(() => {});
        })();
        return page.opening.finally(() => { page.opening = null; });
    }

    call(page, method, params) {
        return this.cdp.send(method, params, page.sessionId);
    }

    /** Closing the tab (✕) closes its page. */
    async closePage(id) {
        const page = this.pages.get(id);
        if (!page) return;
        this.pages.delete(id);
        if (page.sessionId) this.bySession.delete(page.sessionId);
        page.clients.forEach(ws => ws.close(4404, 'Session closed'));
        if (page.targetId && this.cdp) await this.cdp.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
        this.scheduleIdleShutdown();
    }

    // ---------- events from Chromium ----------

    onEvent(msg) {
        const { method, params, sessionId } = msg;
        const page = sessionId ? this.bySession.get(sessionId) : null;
        if (page) {
            if (method === 'Page.screencastFrame') {
                // Ack first so Chromium keeps producing frames even if a viewer is slow
                this.call(page, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
                const frame = Buffer.from(params.data, 'base64');
                page.lastFrame = frame;
                page.clients.forEach(ws => {
                    // Hidden tabs get no frames; slow connections skip frames instead of queueing
                    if (ws.visible && ws.readyState === OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(frame);
                });
            } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
                this.setUrl(page, params.frame.url);
            } else if (method === 'Page.navigatedWithinDocument') {
                this.setUrl(page, params.url);
            } else if (method === 'Page.frameStartedLoading' && params.frameId === page.targetId) {
                this.setState(page, { loading: true });
            } else if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') {
                this.setState(page, { loading: false });
                this.refreshTitleSoon(page, 0);
            } else if (method === 'Page.javascriptDialogOpening') {
                // A blocking alert/confirm would freeze the page: accept it and tell the viewer
                this.call(page, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
                this.broadcast(page, { type: 'status', message: `Diálogo da página: ${params.message}` });
            }
            return;
        }
        // Links that open a new window (target=_blank / window.open): open them in the same tab
        if (method === 'Target.targetInfoChanged') {
            const info = params.targetInfo;
            if (info.type !== 'page' || !info.openerId || !info.url || info.url === 'about:blank') return;
            const opener = [...this.pages.values()].find(p => p.targetId === info.openerId);
            if (!opener) return;
            this.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
            this.navigate(opener, info.url).catch(() => {});
        }
    }

    setUrl(page, url) {
        page.state.url = url;
        this.refreshHistory(page);
        if (url && url !== DEFAULT_URL) this.onUrlChange(page.id, url);
    }

    async refreshHistory(page) {
        try {
            const { currentIndex, entries } = await this.call(page, 'Page.getNavigationHistory');
            this.setState(page, {
                url: entries[currentIndex]?.url || page.state.url,
                canGoBack: currentIndex > 0,
                canGoForward: currentIndex < entries.length - 1,
            });
        } catch {
            this.setState(page, {});
        }
    }

    /** Title-change events aren't reliable: read document.title after loads and input. */
    refreshTitleSoon(page, delay = 300) {
        clearTimeout(page.titleTimer);
        page.titleTimer = setTimeout(async () => {
            if (!page.sessionId) return;
            try {
                const { result } = await this.call(page, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
                if (typeof result.value === 'string' && result.value !== page.state.title) {
                    this.setState(page, { title: result.value });
                }
            } catch { /* navigating */ }
        }, delay);
    }

    setState(page, patch) {
        Object.assign(page.state, patch);
        this.broadcast(page, { type: 'state', ...page.state });
    }

    broadcast(page, message) {
        const payload = JSON.stringify(message);
        page.clients.forEach(ws => {
            if (ws.readyState === OPEN) ws.send(payload);
        });
    }

    // ---------- viewport & screencast ----------

    async applyViewport(page) {
        const { width, height, dpr, mobile } = page.viewport;
        await this.call(page, 'Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: dpr, mobile, screenWidth: width, screenHeight: height,
        });
        // maxTouchPoints must be 1-16 even when disabling, so only send it when enabling
        await this.call(page, 'Emulation.setTouchEmulationEnabled',
            mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
        const ua = mobile
            ? this.userAgent.replace(/\(([^)]+)\)/, '(Linux; Android 14; Pixel 8)').replace(/Chrome\/([\d.]+)/, 'Chrome/$1 Mobile')
            : this.userAgent;
        await this.call(page, 'Emulation.setUserAgentOverride', { userAgent: ua });
    }

    async setViewport(page, { width, height, dpr, mobile, quality }) {
        const next = {
            width: Math.max(200, Math.min(3000, Math.round(Number(width) || 0))),
            height: Math.max(200, Math.min(3000, Math.round(Number(height) || 0))),
            dpr: Math.max(1, Math.min(3, Number(dpr) || 1)),
            mobile: !!mobile,
        };
        const q = Math.max(30, Math.min(100, Math.round(Number(quality) || page.quality)));
        const sizeChanged = JSON.stringify(next) !== JSON.stringify(page.viewport);
        if (!sizeChanged && q === page.quality) return;
        page.viewport = next;
        page.quality = q;
        if (!page.sessionId) return;
        if (sizeChanged) await this.applyViewport(page);
        if (page.screencasting) {
            await this.stopScreencast(page);
            await this.updateScreencast(page);
        }
    }

    /** Frames are produced only while some viewer is looking at this tab. */
    async updateScreencast(page) {
        const visible = [...page.clients].some(ws => ws.visible);
        if (visible) await this.startScreencast(page);
        else await this.stopScreencast(page);
    }

    async startScreencast(page) {
        if (page.screencasting || !page.sessionId) return;
        page.screencasting = true;
        const { width, height, dpr } = page.viewport;
        await this.call(page, 'Page.startScreencast', {
            format: 'jpeg',
            quality: page.quality,
            maxWidth: Math.round(width * dpr),
            maxHeight: Math.round(height * dpr),
            everyNthFrame: 1,
        }).catch(() => { page.screencasting = false; });
    }

    async stopScreencast(page) {
        if (!page.screencasting || !page.sessionId) return;
        page.screencasting = false;
        await this.call(page, 'Page.stopScreencast').catch(() => {});
    }

    // ---------- viewers ----------

    /**
     * Connects a tab's WebSocket to its page.
     * @param {import('ws')} ws
     * @param {object} row - session row (id, url)
     * @param {object} initial - {width, height, dpr, mobile, quality, visible}
     */
    async attach(ws, row, initial) {
        const page = this.getPage(row);
        ws.visible = initial.visible !== false;
        page.clients.add(ws);
        ws.on('message', raw => this.onMessage(page, ws, raw).catch(e => {
            if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'status', message: `Erro: ${e.message}` }));
        }));
        ws.on('close', () => {
            page.clients.delete(ws);
            this.updateScreencast(page).catch(() => {});
        });
        try {
            // Before the page exists this only stores the size; openPage applies it
            if (initial.width) await this.setViewport(page, initial);
            await this.openPage(page);
        } catch (e) {
            if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'status', message: e.message }));
            ws.close(1011, 'Browser unavailable');
            return;
        }
        if (ws.readyState !== OPEN) return;
        ws.send(JSON.stringify({ type: 'state', ...page.state }));
        if (page.lastFrame && ws.visible) ws.send(page.lastFrame);
        await this.updateScreencast(page);
    }

    async onMessage(page, ws, raw) {
        let m;
        try {
            m = JSON.parse(raw);
        } catch {
            return;
        }
        if (m.type === 'visibility') {
            ws.visible = !!m.visible;
            if (ws.visible && page.lastFrame && ws.readyState === OPEN) ws.send(page.lastFrame);
            return this.updateScreencast(page);
        }
        if (m.type === 'ports') {
            return ws.send(JSON.stringify({ type: 'ports', ports: await listPorts(this.hiddenPorts) }));
        }
        if (!page.sessionId) return;
        // Clicks and typing often change the title (SPAs, forms)
        if (['tap', 'text', 'key', 'mouse'].includes(m.type) && m.event !== 'move') this.refreshTitleSoon(page);
        switch (m.type) {
            case 'viewport': return this.setViewport(page, m);
            case 'navigate': {
                const url = normalizeUrl(m.url);
                if (url) await this.navigate(page, url);
                return;
            }
            case 'back': return this.goHistory(page, -1);
            case 'forward': return this.goHistory(page, 1);
            case 'reload': return this.call(page, 'Page.reload', {});
            case 'stop': return this.call(page, 'Page.stopLoading');
            case 'mouse': return this.mouse(page, m);
            case 'tap': return this.tap(page, ws, m);
            case 'wheel':
                return this.call(page, 'Input.dispatchMouseEvent', {
                    type: 'mouseWheel', x: m.x, y: m.y, deltaX: m.deltaX || 0, deltaY: m.deltaY || 0,
                });
            case 'text':
                if (typeof m.text === 'string' && m.text) await this.call(page, 'Input.insertText', { text: m.text });
                return;
            case 'key': return this.key(page, m.key, m.modifiers || 0);
        }
    }

    async navigate(page, url) {
        this.setState(page, { loading: true, url });
        await this.call(page, 'Page.navigate', { url });
    }

    async goHistory(page, delta) {
        const { currentIndex, entries } = await this.call(page, 'Page.getNavigationHistory');
        const entry = entries[currentIndex + delta];
        if (entry) await this.call(page, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    }

    mouse(page, { event, x, y, button = 'left', clickCount = 1, modifiers = 0 }) {
        const type = { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved' }[event];
        if (!type) return undefined;
        const buttons = event === 'up' ? 0 : ({ left: 1, right: 2, middle: 4 }[button] || 0);
        return this.call(page, 'Input.dispatchMouseEvent', {
            type, x, y, modifiers, clickCount,
            button: event === 'move' && !buttons ? 'none' : button,
            buttons,
        });
    }

    /** Click at a point, then tell the viewer whether a text field got focus (to open the keyboard). */
    async tap(page, ws, { x, y, button = 'left' }) {
        await this.mouse(page, { event: 'down', x, y, button });
        await this.mouse(page, { event: 'up', x, y, button });
        if (button !== 'left') return;
        try {
            const { result } = await this.call(page, 'Runtime.evaluate', {
                expression: `(() => { let e = document.activeElement;
                    while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
                    return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)); })()`,
                returnByValue: true,
            });
            if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'editable', value: !!result.value }));
        } catch { /* page navigating */ }
    }

    async key(page, name, modifiers) {
        const special = SPECIAL_KEYS[name];
        if (special) {
            await this.call(page, 'Input.dispatchKeyEvent', {
                type: special.text ? 'keyDown' : 'rawKeyDown', key: name, code: special.code,
                windowsVirtualKeyCode: special.keyCode, text: special.text, modifiers,
            });
            await this.call(page, 'Input.dispatchKeyEvent', {
                type: 'keyUp', key: name, code: special.code, windowsVirtualKeyCode: special.keyCode, modifiers,
            });
            return;
        }
        // Single character with modifiers (e.g. Ctrl+A, Ctrl+C)
        if (typeof name === 'string' && name.length === 1) {
            const upper = name.toUpperCase();
            const code = /[A-Z]/.test(upper) ? `Key${upper}` : '';
            await this.call(page, 'Input.dispatchKeyEvent', {
                type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers,
            });
            await this.call(page, 'Input.dispatchKeyEvent', {
                type: 'keyUp', key: name, code, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers,
            });
        }
    }

    // ---------- used by the MCP server (agents), no viewer needed ----------

    /** Opens (if needed) and returns the page of a browser tab row. */
    async ensurePage(row) {
        const page = this.getPage(row);
        await this.openPage(page);
        return page;
    }

    /** Navigates a tab and waits (up to 15s) for the page to load. */
    async navigateTab(row, rawUrl) {
        const url = normalizeUrl(rawUrl);
        if (!url) throw new Error('URL inválida');
        const page = await this.ensurePage(row);
        await this.navigate(page, url);
        await this.waitForLoad(page, 15000);
        return { url: page.state.url, title: page.state.title };
    }

    waitForLoad(page, timeout) {
        return new Promise(resolve => {
            const started = Date.now();
            const check = () => {
                if (!page.state.loading || Date.now() - started > timeout) resolve();
                else setTimeout(check, 200);
            };
            setTimeout(check, 300);
        });
    }

    /** PNG screenshot of what the tab shows (or the whole page). */
    async screenshot(row, { fullPage = false } = {}) {
        const page = await this.ensurePage(row);
        await this.waitForLoad(page, 10000);
        const params = { format: 'png' };
        if (fullPage) {
            // Whole page: clip to the document size (capped so huge pages stay reasonable)
            const { cssContentSize } = await this.call(page, 'Page.getLayoutMetrics');
            params.captureBeyondViewport = true;
            params.clip = {
                x: 0, y: 0, scale: 1,
                width: Math.ceil(cssContentSize.width),
                height: Math.min(Math.ceil(cssContentSize.height), 10000),
            };
        }
        const { data } = await this.call(page, 'Page.captureScreenshot', params);
        return { data, url: page.state.url, title: page.state.title };
    }

    /** Title, URL and visible text of the page (truncated for the agent's context). */
    async readText(row, maxChars = 50000) {
        const page = await this.ensurePage(row);
        await this.waitForLoad(page, 10000);
        const { result } = await this.call(page, 'Runtime.evaluate', {
            expression: `(() => ({ title: document.title, url: location.href,
                text: (document.body ? document.body.innerText : '') }))()`,
            returnByValue: true,
        });
        const value = result.value || {};
        const text = String(value.text || '');
        return {
            title: value.title || '',
            url: value.url || page.state.url,
            text: text.length > maxChars ? `${text.slice(0, maxChars)}\n…(cortado: ${text.length} caracteres)` : text,
        };
    }

    shutdown() {
        try { this.proc && this.proc.kill(); } catch { /* gone */ }
    }
}

// ---------- listening ports (to suggest "localhost:5173") ----------

// System services and browsers aren't projects worth opening
const WINDOWS_NOISE = /^(System|svchost|lsass|wininit|services|spoolsv|chrome|msedge|Idle|MsMpEng|OneDrive|Code)$/i;

/** @returns {Promise<Array<{port: number, name: string}>>} */
function listPorts(exclude = []) {
    const skip = new Set(exclude.filter(Boolean).map(Number));
    const keep = port => port >= 1024 && port < 49152 && !skip.has(port);
    if (os.platform() === 'linux') {
        const ports = new Set();
        for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
            try {
                fs.readFileSync(file, 'utf8').split('\n').slice(1).forEach(line => {
                    const cols = line.trim().split(/\s+/);
                    if (cols[3] !== '0A') return; // 0A = LISTEN
                    const port = parseInt(cols[1].split(':').pop(), 16);
                    if (keep(port)) ports.add(port);
                });
            } catch { /* no ipv6 */ }
        }
        return Promise.resolve([...ports].sort((a, b) => a - b).map(port => ({ port, name: '' })));
    }
    if (os.platform() === 'win32') {
        const run = (cmd, args) => new Promise(resolve => {
            execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
        });
        // No "-p tcp": that hides IPv6, and dev servers often listen on [::1]
        return Promise.all([run('netstat', ['-ano']), run('tasklist', ['/fo', 'csv', '/nh'])]).then(([net, tasks]) => {
            const names = new Map();
            tasks.split('\n').forEach(line => {
                const m = line.match(/^"([^"]+)","(\d+)"/);
                if (m) names.set(Number(m[2]), m[1].replace(/\.exe$/i, ''));
            });
            const found = new Map();
            net.split('\n').forEach(line => {
                const cols = line.trim().split(/\s+/);
                // A listening socket has an empty remote address (the state word is localized)
                if (cols[0] !== 'TCP' || (cols[2] !== '0.0.0.0:0' && cols[2] !== '[::]:0')) return;
                const port = Number(cols[1].split(':').pop());
                const name = names.get(Number(cols[4])) || '';
                if (keep(port) && !WINDOWS_NOISE.test(name)) found.set(port, name);
            });
            return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([port, name]) => ({ port, name }));
        });
    }
    return Promise.resolve([]);
}

module.exports = { BrowserManager, listPorts, normalizeUrl };
