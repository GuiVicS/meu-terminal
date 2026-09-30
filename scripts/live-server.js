/**
 * live-server.js
 * "Live Server" for project folders, like the VS Code extension: serves a folder over
 * HTTP on 127.0.0.1 (only the server's own Chromium can open it) and watches it, so
 * browser tabs reload when a file is saved. Ports are remembered per folder so saved
 * tabs keep working after the app restarts.
 */
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const path = require('path');

const FIRST_PORT = 41000;
const LAST_PORT = 41999;
const IGNORED = /(^|[\\/])(node_modules|\.git|\.next|\.nuxt|\.cache|dist[\\/]\.vite|__pycache__)([\\/]|$)/;

const TYPES = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    mp4: 'video/mp4', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain; charset=utf-8',
    map: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8', pdf: 'application/pdf',
    wasm: 'application/wasm', md: 'text/plain; charset=utf-8',
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Page shown while the project has no index.html yet (or waits for a dev server). */
function waitingPage(folder, waitPort) {
    const target = waitPort ? `http://localhost:${Number(waitPort)}/` : '';
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Aguardando o projeto</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #121212; color: #F2F0E3;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 440px; margin: 24px; padding: 28px; border: 2px solid #000; border-radius: 24px;
    background: #1F1F1F; box-shadow: 4px 4px 0 #000; text-align: center; }
  .logo { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 16px; background: #A855F7; display: grid;
    place-items: center; border: 2px solid #000; box-shadow: 3px 3px 0 #000; }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  p { color: #A0A0A0; margin: 6px 0; }
  code { font-family: ui-monospace, monospace; background: #2A2A2A; padding: 2px 6px; border-radius: 6px; color: #F2F0E3; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #A855F7; margin: 0 3px;
    animation: b 1.2s infinite ease-in-out; }
  .dot:nth-child(2) { animation-delay: .15s } .dot:nth-child(3) { animation-delay: .3s }
  @keyframes b { 0%, 80%, 100% { opacity: .25 } 40% { opacity: 1 } }
</style></head><body><div class="card">
  <div class="logo"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4"
    stroke-linecap="round" stroke-linejoin="round"><path d="M6 8l4 4-4 4"/><path d="M13 16h5"/></svg></div>
  <h1>${target ? 'Aguardando o servidor do projeto' : 'Aguardando os arquivos do projeto'}</h1>
  <p>${target ? `Assim que <code>${esc(target)}</code> responder, a página abre aqui.`
        : 'Quando um <code>index.html</code> for salvo nesta pasta, ele aparece aqui sozinho.'}</p>
  <p><code>${esc(folder)}</code></p>
  <p aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></p>
</div>
${target ? `<script>
  (function poll() {
    fetch(${JSON.stringify(target)}, { mode: 'no-cors', cache: 'no-store' })
      .then(function () { location.href = ${JSON.stringify(target)}; })
      .catch(function () { setTimeout(poll, 1500); });
  })();
</script>` : ''}
</body></html>`;
}

class LiveServers {
    /**
     * @param {object} opts
     * @param {import('./session-store')} opts.store - remembers folder -> port
     * @param {Function} [opts.log]
     */
    constructor({ store, log = () => {} }) {
        this.store = store;
        this.log = log;
        this.servers = new Map();  // folder -> { server, port, url }
        this.watchers = new Map(); // folder -> { watcher, listeners: Set, timer }
    }

    savedPorts() {
        try {
            const row = this.store.db.prepare(`SELECT value FROM meta WHERE key = 'live_servers'`).get();
            return row ? JSON.parse(row.value) : {};
        } catch {
            return {};
        }
    }

    savePort(folder, port) {
        const all = this.savedPorts();
        all[folder] = port;
        this.store.db.prepare(`INSERT INTO meta (key, value) VALUES ('live_servers', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(all));
    }

    /** Ports in use by live servers (hidden from "open ports" lists). */
    get ports() {
        return [...this.servers.values()].map(s => s.port);
    }

    /** Folder served on a given local port, if any (to restart saved tabs). */
    folderForPort(port) {
        const saved = this.savedPorts();
        return Object.keys(saved).find(folder => saved[folder] === Number(port)) || null;
    }

    /**
     * Serves a folder (idempotent). Returns its URL: http://127.0.0.1:<port>/
     * @param {string} folder - absolute path
     */
    async serve(folder) {
        const root = path.resolve(folder);
        const running = this.servers.get(root);
        if (running) return running.url;
        const st = await fsp.stat(root);
        if (!st.isDirectory()) throw new Error(`Não é uma pasta: ${root}`);

        const taken = new Set(Object.values(this.savedPorts()));
        const preferred = this.savedPorts()[root];
        const candidates = [];
        if (preferred) candidates.push(preferred);
        for (let p = FIRST_PORT; p <= LAST_PORT && candidates.length < 60; p++) if (!taken.has(p)) candidates.push(p);

        for (const port of candidates) {
            const server = http.createServer((req, res) => this.handle(root, req, res));
            try {
                await new Promise((resolve, reject) => {
                    server.once('error', reject);
                    server.listen(port, '127.0.0.1', resolve);
                });
            } catch (e) {
                server.close();
                if (e.code === 'EADDRINUSE') continue;
                throw e;
            }
            const url = `http://127.0.0.1:${port}/`;
            this.servers.set(root, { server, port, url });
            this.savePort(root, port);
            this.log(`Live server: ${root} -> ${url}`);
            return url;
        }
        throw new Error('Nenhuma porta livre para a pré-visualização.');
    }

    stop(folder) {
        const root = path.resolve(folder);
        const s = this.servers.get(root);
        if (!s) return;
        this.servers.delete(root);
        s.server.close();
    }

    async handle(root, req, res) {
        res.setHeader('Cache-Control', 'no-store');
        let rel;
        try {
            rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        } catch {
            res.writeHead(400).end('Bad request');
            return;
        }
        const wait = new URL(req.url, 'http://x').searchParams.get('wait');
        // Dev-server projects (Vite, Next...): the folder's index.html isn't the real page
        if (wait && rel === '/') return this.send(res, 200, 'text/html; charset=utf-8', waitingPage(root, wait));
        // resolve() drops the trailing separator, so "/" compares equal to the root folder
        let target = path.resolve(path.join(root, path.normalize(rel)));
        if (target !== root && !target.startsWith(root + path.sep)) {
            res.writeHead(403).end('Forbidden');
            return;
        }
        try {
            let st = await fsp.stat(target);
            if (st.isDirectory()) {
                const index = path.join(target, 'index.html');
                try {
                    st = await fsp.stat(index);
                    target = index;
                } catch {
                    if (target === root) return this.send(res, 200, 'text/html; charset=utf-8', waitingPage(root, wait));
                    return this.listing(res, root, target);
                }
            }
            const type = TYPES[path.extname(target).slice(1).toLowerCase()] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
            if (req.method === 'HEAD') return res.end();
            fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
        } catch {
            if (rel === '/' || rel === '/index.html') return this.send(res, 200, 'text/html; charset=utf-8', waitingPage(root, wait));
            // Single page apps: unknown routes without an extension fall back to index.html
            if (!path.extname(rel)) {
                try {
                    const index = path.join(root, 'index.html');
                    await fsp.access(index);
                    res.writeHead(200, { 'Content-Type': TYPES.html });
                    return fs.createReadStream(index).pipe(res);
                } catch { /* 404 below */ }
            }
            this.send(res, 404, 'text/plain; charset=utf-8', `Não encontrado: ${rel}`);
        }
    }

    send(res, status, type, body) {
        res.writeHead(status, { 'Content-Type': type });
        res.end(body);
    }

    async listing(res, root, dir) {
        const names = (await fsp.readdir(dir, { withFileTypes: true }).catch(() => []))
            .filter(d => !d.name.startsWith('.'))
            .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
        const rel = '/' + path.relative(root, dir).split(path.sep).join('/');
        const base = rel.endsWith('/') ? rel : rel + '/';
        const items = names.map(d => `<li><a href="${esc(base + encodeURIComponent(d.name))}${d.isDirectory() ? '/' : ''}">${esc(d.name)}${d.isDirectory() ? '/' : ''}</a></li>`);
        this.send(res, 200, 'text/html; charset=utf-8', `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${esc(rel)}</title><style>body{font:15px/1.7 system-ui;margin:24px;background:#121212;color:#F2F0E3}a{color:#C084FC}</style>
<h1 style="font-size:18px">${esc(rel)}</h1><ul>${rel !== '/' ? '<li><a href="../">../</a></li>' : ''}${items.join('')}</ul>`);
    }

    /**
     * Calls `onChange` (debounced) when files under `folder` change. Returns an unwatch
     * function. One OS watcher per folder, shared by every tab watching it.
     */
    watch(folder, onChange) {
        const root = path.resolve(folder);
        let entry = this.watchers.get(root);
        if (!entry) {
            entry = { watcher: null, listeners: new Set(), timer: null };
            try {
                entry.watcher = fs.watch(root, { recursive: true }, (event, filename) => {
                    if (filename && IGNORED.test(String(filename))) return;
                    clearTimeout(entry.timer);
                    entry.timer = setTimeout(() => entry.listeners.forEach(fn => {
                        try { fn(String(filename || '')); } catch { /* one listener failing doesn't stop the others */ }
                    }), 250);
                });
                entry.watcher.on('error', e => this.log('Live watch error:', root, e.message));
            } catch (e) {
                this.log('Live watch unavailable:', root, e.message);
            }
            this.watchers.set(root, entry);
        }
        entry.listeners.add(onChange);
        return () => {
            entry.listeners.delete(onChange);
            if (!entry.listeners.size) {
                clearTimeout(entry.timer);
                try { entry.watcher && entry.watcher.close(); } catch { /* already closed */ }
                this.watchers.delete(root);
            }
        };
    }

    shutdown() {
        this.servers.forEach(s => s.server.close());
        this.watchers.forEach(w => { try { w.watcher && w.watcher.close(); } catch { /* ignore */ } });
    }
}

module.exports = { LiveServers };
