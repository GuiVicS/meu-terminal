/**
 * session-manager.js
 * Server-side terminal sessions that outlive the browser: a shell keeps running when
 * its tab/connection closes and is only killed when the user closes the tab (✕).
 * Each session mirrors its screen in a headless xterm so any device can re-attach.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const COLORS = ['green', 'blue', 'purple', 'orange', 'pink', 'cyan', 'yellow'];
const SCROLLBACK = 5000;       // lines kept in memory per session
const SNAPSHOT_LINES = 1000;   // lines written to the database
const PERSIST_DELAY = 2000;    // debounce for snapshot writes
const notice = text => `\r\n\x1b[2m── ${text} ──\x1b[0m\r\n`;

function cleanName(name) {
    return typeof name === 'string' ? name.trim().slice(0, 60) : '';
}

function defaultName(type, n, cwd) {
    if (type === 'browser') return `Navegador ${n}`;
    if (type === 'agent') return 'Agente';
    if (type === 'notes') return 'Anotações';
    if (type === 'files') {
        const folder = cwd && cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        return folder ? folder.slice(0, 60) : 'Arquivos';
    }
    return `Term ${n}`;
}

class SessionManager {
    /**
     * @param {object} deps
     * @param {import('./session-store')} deps.store
     * @param {(opts: {cwd: string, cols: number, rows: number}) => any} deps.spawnShell
     * @param {(pty: any, cwd: string) => object} deps.shellInfo - static info sent to clients
     * @param {(pty: any) => object} deps.getProcessInfo - live cwd / process / branch
     * @param {string} deps.defaultCwd
     * @param {(...args: any[]) => void} deps.log
     */
    constructor({ store, spawnShell, shellInfo, getProcessInfo, defaultCwd, log }) {
        this.store = store;
        this.spawnShell = spawnShell;
        this.shellInfo = shellInfo;
        this.getProcessInfo = getProcessInfo;
        this.defaultCwd = defaultCwd;
        this.log = log;
        this.runtimes = new Map(); // id -> running state (pty, headless screen, clients)
        this.sockets = new Set();  // every attached socket (for workspace notifications)
        this.pendingInput = new Map(); // id -> command to type once the shell starts
    }

    // ---------- workspace (REST) ----------

    list() {
        return {
            sessions: this.store.listOpen().map(row => this.toPublic(row)),
            recent: this.store.listClosed().map(row => ({
                id: row.id,
                name: row.name,
                color: row.color,
                kind: row.kind || 'terminal',
                cwd: row.kind === 'browser' ? (row.url || '') : (row.cwd || row.start_cwd || ''),
                url: row.url || null,
                closedAt: row.closed_at,
            })),
        };
    }

    toPublic(row) {
        const rt = this.runtimes.get(row.id);
        return {
            id: row.id,
            kind: row.kind || 'terminal',
            url: row.url || null,
            name: row.name,
            color: row.color,
            pinned: !!row.pinned,
            position: row.position,
            cwd: row.cwd || null,
            startCwd: row.start_cwd || null,
            running: !!(rt && rt.pty),
            pid: rt && rt.pty ? rt.pty.pid : null,
        };
    }

    /**
     * Creates a tab. kind 'terminal' (default) gets a shell; kind 'browser' gets a page
     * in the server's Chromium (see browser-manager.js); kind 'files' is a file manager
     * (url = source: 'local' or an rclone remote, cwd = folder); kind 'agent' is the agent UI
     * (url = agent gateway session id, cwd = project folder); kind 'notes' is the notes app
     * (data lives in the notes table, see notes-store.js).
     */
    create({ name, cwd, color, afterId, reopenId, kind, url } = {}) {
        // Reopening a closed session = new shell/page with the same name/dir/URL/color
        let base = {};
        if (reopenId) {
            const old = this.store.get(reopenId);
            if (old && old.status === 'closed') {
                base = { name: old.name, cwd: old.cwd || old.start_cwd, color: old.color, kind: old.kind, url: old.url };
                this.store.forget(reopenId);
            }
        }
        const wanted = kind || base.kind;
        // 'agent' = agent UI tab (url = agent gateway session id, see scripts/agents/)
        const type = ['browser', 'files', 'agent', 'notes'].includes(wanted) ? wanted : 'terminal';
        const n = this.store.nextCounter();
        const startCwd = type !== 'browser'
            ? (typeof cwd === 'string' && cwd.trim().slice(0, 4096)) || base.cwd || null
            : null;
        const startUrl = type !== 'terminal'
            ? (typeof url === 'string' && url.trim().slice(0, 4096)) || base.url || null
            : null;
        const pick = color || base.color;
        const row = this.store.insert({
            id: crypto.randomUUID(),
            kind: type,
            url: startUrl,
            name: cleanName(name) || base.name || defaultName(type, n, startCwd),
            color: COLORS.includes(pick) ? pick : COLORS[(n - 1) % COLORS.length],
            pinned: false,
            position: this.store.positionAfter(afterId),
            cwd: startCwd,
            start_cwd: startCwd,
        });
        this.changed();
        return this.toPublic(row);
    }

    update(id, { name, pinned, color, location } = {}) {
        const row = this.store.get(id);
        if (!row || row.status !== 'open') return null;
        const fields = {};
        if (cleanName(name)) fields.name = cleanName(name);
        if (typeof pinned === 'boolean') fields.pinned = pinned;
        if (COLORS.includes(color)) fields.color = color;
        // File tabs remember where they are (same folder on every device)
        if (row.kind === 'files' && location && typeof location.path === 'string' && location.path.length <= 4096) {
            fields.cwd = location.path;
            if (typeof location.source === 'string' && location.source.length <= 200) fields.url = location.source;
        }
        const updated = this.store.update(id, fields);
        this.changed();
        return this.toPublic(updated);
    }

    setOrder(ids) {
        if (!Array.isArray(ids)) return;
        const open = new Set(this.store.listOpen().map(s => s.id));
        this.store.setOrder(ids.filter(id => open.has(id)));
        this.changed();
    }

    /** The only place a shell is killed on purpose: the user closed the tab. */
    close(id) {
        const row = this.store.get(id);
        if (!row || row.status !== 'open') return false;
        const rt = this.runtimes.get(id);
        if (rt) {
            // Keep the last screen's directory for "reopen"
            if (rt.pty) {
                const info = this.safeProcessInfo(rt.pty);
                if (info.cwd) this.store.update(id, { cwd: info.cwd });
            }
            clearTimeout(rt.persistTimer);
            this.runtimes.delete(id);
            try { rt.pty && rt.pty.kill(); } catch { /* already gone */ }
            rt.headless.dispose();
            rt.clients.forEach(ws => ws.close(4404, 'Session closed'));
        }
        this.store.close(id);
        this.log('Session closed:', id);
        this.changed();
        return true;
    }

    forget(id) {
        this.store.forget(id);
        this.changed();
    }

    /** Tells every connected tab that the session list changed (other device, other tab). */
    changed() {
        this.broadcast({ type: 'workspace' });
    }

    /** Sends a message to every open app window (e.g. MCP "open this tab", "notify"). */
    broadcast(message) {
        // Each app window has one socket per tab: the nonce lets it handle a message once
        const msg = JSON.stringify({ ...message, nonce: crypto.randomUUID() });
        this.sockets.forEach(ws => {
            if (ws.readyState === ws.OPEN) ws.send(msg);
        });
    }

    // ---------- runtime ----------

    /** Returns the running state for a session, starting its shell if needed. */
    ensureRuntime(id) {
        let rt = this.runtimes.get(id);
        if (rt) return rt;
        const row = this.store.get(id);
        // Browser and file tabs have no shell (server.js routes their sockets elsewhere)
        if (!row || row.status !== 'open' || (row.kind && row.kind !== 'terminal')) return null;

        // convertEol matches the browser terminal so both render output identically
        const headless = new Terminal({
            cols: 80, rows: 24, scrollback: SCROLLBACK, allowProposedApi: true, convertEol: true,
        });
        const serializer = new SerializeAddon();
        headless.loadAddon(serializer);
        rt = {
            id, headless, serializer,
            clients: new Set(),
            pty: null,
            info: null,
            cols: 80,
            rows: 24,
            owner: null,
            persistTimer: null,
        };
        this.runtimes.set(id, rt);

        // The server restarted since this session last ran: show its last screen,
        // clearly marked, instead of pretending the old process still exists
        if (row.snapshot) {
            headless.write(row.snapshot);
            headless.write(notice('servidor reiniciado · novo shell'));
        }
        this.startShell(rt, row);
        return rt;
    }

    startShell(rt, row = this.store.get(rt.id)) {
        const cwd = this.pickCwd(row);
        const pty = this.spawnShell({ id: rt.id, cwd, cols: rt.cols, rows: rt.rows });
        rt.pty = pty;
        rt.info = this.shellInfo(pty, cwd);
        this.store.update(rt.id, { pid: pty.pid });
        this.log(`Session ${rt.id} started shell PID ${pty.pid} in ${cwd}`);

        pty.on('data', data => {
            rt.headless.write(data);
            this.send(rt, { type: 'output', data });
            this.schedulePersist(rt);
        });
        pty.on('exit', code => {
            if (rt.pty !== pty) return; // an old shell of a restarted session
            rt.pty = null;
            const text = notice('processo encerrado — pressione Enter para iniciar um novo shell');
            rt.headless.write(text);
            this.send(rt, { type: 'output', data: text });
            this.send(rt, { type: 'exit', code });
            this.store.update(rt.id, { pid: null });
            this.persist(rt);
            this.changed();
        });
        this.send(rt, { type: 'info', ...rt.info });
        // A command queued before the shell existed (vibecoding: start the agent)
        const queued = this.pendingInput.get(rt.id);
        if (queued) {
            this.pendingInput.delete(rt.id);
            setTimeout(() => { if (rt.pty === pty) pty.write(queued); }, 600);
        }
    }

    /**
     * Types a command in a terminal tab (starting its shell if nobody opened it yet).
     * The text is typed as-is: end it with `\r` to run it.
     */
    runCommand(id, text) {
        const row = this.store.get(id);
        if (!row || row.status !== 'open' || (row.kind && row.kind !== 'terminal')) return false;
        const rt = this.runtimes.get(id);
        if (rt && rt.pty) {
            rt.pty.write(text);
            return true;
        }
        this.pendingInput.set(id, text);
        if (!rt) this.ensureRuntime(id);
        return true;
    }

    /** First existing directory among: last cwd, starting cwd, server default. */
    pickCwd(row) {
        const candidates = [row && row.cwd, row && row.start_cwd, this.defaultCwd];
        for (const dir of candidates) {
            if (!dir) continue;
            try {
                const resolved = path.resolve(dir.replace(/^~(?=$|\/)/, os.homedir()));
                if (fs.statSync(resolved).isDirectory()) return resolved;
            } catch { /* try the next one */ }
        }
        return this.defaultCwd;
    }

    /**
     * Connects a WebSocket to a session: sends the current screen, then live output.
     * Several sockets (devices) can watch the same session at once.
     */
    attach(ws, id, { cols, rows } = {}) {
        const rt = this.ensureRuntime(id);
        if (!rt) {
            ws.close(4404, 'Session not found');
            return;
        }
        ws.termSize = this.validSize(cols, rows);
        // Output produced while the snapshot is being prepared is queued, not lost
        ws.pending = [];
        rt.clients.add(ws);
        this.sockets.add(ws);
        this.claimSize(rt, ws);

        // write('', cb) resolves once everything written so far is parsed, so the
        // snapshot contains exactly the output that came before the queue started
        rt.headless.write('', () => {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ type: 'info', ...(rt.info || {}) }));
            ws.send(JSON.stringify({ type: 'snapshot', data: rt.serializer.serialize() }));
            if (!rt.pty) ws.send(JSON.stringify({ type: 'exit' }));
            const queued = ws.pending;
            ws.pending = null;
            queued.forEach(msg => ws.send(msg));
        });

        ws.on('message', raw => {
            let message;
            try {
                message = JSON.parse(raw);
            } catch {
                return;
            }
            switch (message.type) {
                case 'input':
                    if (!rt.pty || typeof message.data !== 'string') return;
                    this.claimSize(rt, ws); // whoever types decides the size (like tmux)
                    rt.pty.write(message.data);
                    break;
                case 'resize': {
                    ws.termSize = this.validSize(message.cols, message.rows);
                    if (rt.owner === ws || rt.clients.size === 1) this.claimSize(rt, ws);
                    break;
                }
                case 'process-info':
                    if (ws.readyState === ws.OPEN) {
                        const info = rt.pty ? this.safeProcessInfo(rt.pty) : {};
                        ws.send(JSON.stringify({ type: 'process-info', ...info }));
                    }
                    break;
                case 'restart':
                    if (!rt.pty) this.startShell(rt);
                    this.changed();
                    break;
            }
        });

        ws.on('close', () => {
            // Closing the browser tab only detaches: the shell keeps running
            rt.clients.delete(ws);
            this.sockets.delete(ws);
            if (rt.owner === ws) rt.owner = null;
        });
    }

    validSize(cols, rows) {
        const c = Math.floor(Number(cols));
        const r = Math.floor(Number(rows));
        if (!(c >= 2 && c <= 500 && r >= 2 && r <= 500)) return null;
        return { cols: c, rows: r };
    }

    claimSize(rt, ws) {
        rt.owner = ws;
        const size = ws.termSize;
        if (!size || (size.cols === rt.cols && size.rows === rt.rows)) return;
        rt.cols = size.cols;
        rt.rows = size.rows;
        rt.headless.resize(size.cols, size.rows);
        try { rt.pty && rt.pty.resize(size.cols, size.rows); } catch { /* exited */ }
    }

    send(rt, message) {
        const payload = JSON.stringify(message);
        rt.clients.forEach(ws => {
            if (ws.pending) ws.pending.push(payload);
            else if (ws.readyState === ws.OPEN) ws.send(payload);
        });
    }

    safeProcessInfo(pty) {
        try {
            return this.getProcessInfo(pty) || {};
        } catch {
            return {};
        }
    }

    // ---------- persistence ----------

    schedulePersist(rt) {
        if (rt.persistTimer) return;
        rt.persistTimer = setTimeout(() => {
            rt.persistTimer = null;
            this.persist(rt);
        }, PERSIST_DELAY);
    }

    /** Saves the screen (and live cwd) so a server restart can show it again. */
    persist(rt) {
        clearTimeout(rt.persistTimer);
        rt.persistTimer = null;
        if (!this.runtimes.has(rt.id)) return;
        const fields = { snapshot: rt.serializer.serialize({ scrollback: SNAPSHOT_LINES }) };
        if (rt.pty) {
            const info = this.safeProcessInfo(rt.pty);
            if (info.cwd) fields.cwd = info.cwd;
        }
        try {
            this.store.update(rt.id, fields);
        } catch (e) {
            console.error('Failed to persist session', rt.id, e);
        }
    }

    persistAll() {
        this.runtimes.forEach(rt => this.persist(rt));
    }
}

module.exports = SessionManager;
