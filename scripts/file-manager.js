/**
 * file-manager.js
 * Files behind the "Arquivos" tabs: the server's own folders (fs) and, when rclone is
 * installed, its configured remotes (Google Drive, S3, Dropbox...). Every operation takes
 * a source ('local' or a remote name) and a path, so the routes and the UI treat both alike.
 * Copy/move between a remote and the server go through rclone.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const LOCAL = 'local';
const MAX_ENTRIES = 5000;
const MAX_TEXT = 2 * 1024 * 1024;
const SEARCH_LIMIT = 300;
const SEARCH_SKIP = new Set(['node_modules', '.git', '.cache', '.npm', '__pycache__', '.venv']);

const MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska', m4v: 'video/mp4',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
    opus: 'audio/ogg', aac: 'audio/aac',
    pdf: 'application/pdf', json: 'application/json', zip: 'application/zip',
    gz: 'application/gzip', tar: 'application/x-tar',
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html',
    css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', xml: 'text/xml',
};

class FileError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** Friendly Portuguese message for fs errors. */
function fsError(e, target = '') {
    const name = target ? ` "${path.basename(target)}"` : '';
    switch (e && e.code) {
        case 'ENOENT': return new FileError(`Não encontrado${name}.`, 404);
        case 'EACCES':
        case 'EPERM': return new FileError(`Sem permissão${name}.`, 403);
        case 'EEXIST': return new FileError(`Já existe${name}.`, 409);
        case 'ENOTDIR': return new FileError(`Não é uma pasta${name}.`, 400);
        case 'EISDIR': return new FileError(`É uma pasta${name}.`, 400);
        case 'ENOTEMPTY': return new FileError(`A pasta${name} não está vazia.`, 409);
        case 'ENOSPC': return new FileError('Sem espaço no disco.', 507);
        case 'EXDEV': return new FileError('Não dá para mover entre discos.', 400);
        default: return e instanceof FileError ? e : new FileError(e && e.message ? e.message : String(e), 500);
    }
}

function mimeOf(name) {
    return MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream';
}

function modeString(mode) {
    const chars = 'rwxrwxrwx';
    let out = '';
    for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? chars[i] : '-';
    return out;
}

/** A single file/folder name: no separators, not "." / "..". */
function cleanName(name) {
    const n = String(name ?? '').trim();
    if (!n || n === '.' || n === '..' || /[/\\\0]/.test(n) || n.length > 255) {
        throw new FileError('Nome inválido.');
    }
    return n;
}

class FileManager {
    /**
     * @param {object} opts
     * @param {string} opts.home - default folder (the shell's home)
     * @param {string} [opts.rclone] - rclone binary
     * @param {Function} [opts.log]
     */
    constructor({ home, rclone = process.env.RCLONE_PATH || 'rclone', log = () => {} }) {
        this.home = home || os.homedir();
        this.rcloneBin = rclone;
        this.log = log;
        this.remotesCache = null;
    }

    // ---------- sources ----------

    /** rclone's remotes ([] when rclone isn't installed or has none). Cached for 20s. */
    async remotes() {
        if (this.remotesCache && Date.now() - this.remotesCache.at < 20000) return this.remotesCache.list;
        let list = [];
        try {
            const out = await this.rclone(['listremotes', '--long'], { timeout: 10000 });
            list = out.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
                const m = /^(.+?):\s*(\S*)/.exec(line);
                return m ? { name: m[1], type: m[2] || '' } : null;
            }).filter(Boolean);
            this.rcloneAvailable = true;
        } catch (e) {
            this.rcloneAvailable = e.code !== 'ENOENT';
        }
        this.remotesCache = { at: Date.now(), list };
        return list;
    }

    async sources() {
        const remotes = await this.remotes();
        return {
            home: this.home,
            rclone: !!this.rcloneAvailable,
            sources: [
                { id: LOCAL, name: 'Este servidor', type: 'local' },
                ...remotes.map(r => ({ id: r.name, name: r.name, type: r.type || 'rclone', remote: true })),
            ],
        };
    }

    async assertSource(source) {
        if (!source || source === LOCAL) return LOCAL;
        const remotes = await this.remotes();
        if (!remotes.some(r => r.name === source)) {
            throw new FileError(this.rcloneAvailable
                ? `O remote "${source}" não existe no rclone.`
                : 'O rclone não está instalado no servidor.', 404);
        }
        return source;
    }

    // ---------- paths ----------

    /** Absolute local path ("~" = home, relative = from home). */
    localPath(p) {
        const raw = String(p ?? '').trim() || this.home;
        if (raw.length > 4096 || raw.includes('\0')) throw new FileError('Caminho inválido.');
        return path.resolve(this.home, raw.replace(/^~(?=$|[\\/])/, this.home));
    }

    /** Remote path, always "/a/b" (root = "/"). */
    remotePath(p) {
        const raw = String(p ?? '').replace(/\\/g, '/');
        if (raw.length > 4096 || raw.includes('\0')) throw new FileError('Caminho inválido.');
        const parts = [];
        for (const part of raw.split('/')) {
            if (!part || part === '.') continue;
            if (part === '..') parts.pop();
            else parts.push(part);
        }
        return '/' + parts.join('/');
    }

    resolve(source, p) {
        return source === LOCAL ? this.localPath(p) : this.remotePath(p);
    }

    /** Argument for rclone: "remote:a/b" or the local absolute path. */
    rcloneTarget(source, p) {
        return source === LOCAL ? p : `${source}:${p.replace(/^\/+/, '')}`;
    }

    join(source, dir, name) {
        return source === LOCAL ? path.join(dir, name) : (dir === '/' ? `/${name}` : `${dir}/${name}`);
    }

    dirname(source, p) {
        if (source === LOCAL) return path.dirname(p);
        const i = p.lastIndexOf('/');
        return i <= 0 ? '/' : p.slice(0, i);
    }

    basename(source, p) {
        return source === LOCAL ? path.basename(p) : p.split('/').pop();
    }

    isRoot(source, p) {
        return source === LOCAL ? path.dirname(p) === p : p === '/';
    }

    // ---------- rclone ----------

    /** Runs rclone and returns stdout (rejects with its stderr). */
    rclone(args, { timeout = 0, input } = {}) {
        return new Promise((resolve, reject) => {
            const child = spawn(this.rcloneBin, args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            let timer = null;
            if (timeout) timer = setTimeout(() => child.kill('SIGKILL'), timeout);
            child.stdout.on('data', d => { out += d; });
            child.stderr.on('data', d => { err += d; });
            child.on('error', e => {
                clearTimeout(timer);
                reject(e);
            });
            child.on('close', code => {
                clearTimeout(timer);
                if (code === 0) resolve(out);
                else {
                    const msg = rcloneMessage(err) || `rclone saiu com código ${code}`;
                    reject(new FileError(msg, msg.startsWith('Não encontrado') ? 404 : 502));
                }
            });
            if (input) input.pipe(child.stdin);
        });
    }

    // ---------- listing ----------

    async list(source, dir) {
        source = await this.assertSource(source);
        const target = this.resolve(source, dir);
        const entries = source === LOCAL ? await this.listLocal(target) : await this.listRemote(source, target);
        return {
            source,
            path: target,
            sep: source === LOCAL ? path.sep : '/',
            parent: this.isRoot(source, target) ? null : this.dirname(source, target),
            truncated: entries.length > MAX_ENTRIES,
            entries: entries.slice(0, MAX_ENTRIES),
        };
    }

    async listLocal(dir) {
        let dirents;
        try {
            dirents = await fsp.readdir(dir, { withFileTypes: true });
        } catch (e) {
            throw fsError(e, dir);
        }
        return Promise.all(dirents.slice(0, MAX_ENTRIES + 1).map(d => this.entryLocal(path.join(dir, d.name), d.name)));
    }

    async entryLocal(full, name = path.basename(full)) {
        let st;
        let link = false;
        try {
            st = await fsp.lstat(full);
            if (st.isSymbolicLink()) {
                link = true;
                try {
                    st = await fsp.stat(full);
                } catch {
                    return { name, type: 'file', link, broken: true, size: 0, mtime: 0 };
                }
            }
        } catch {
            return { name, type: 'file', size: 0, mtime: 0, unreadable: true };
        }
        return {
            name,
            type: st.isDirectory() ? 'dir' : 'file',
            link,
            size: st.isDirectory() ? null : st.size,
            mtime: Math.round(st.mtimeMs),
            mode: modeString(st.mode),
        };
    }

    async listRemote(source, dir) {
        const out = await this.rclone(['lsjson', '--', this.rcloneTarget(source, dir)], { timeout: 120000 });
        return JSON.parse(out || '[]').map(e => ({
            name: e.Name,
            type: e.IsDir ? 'dir' : 'file',
            size: e.IsDir ? null : e.Size,
            mtime: e.ModTime ? Date.parse(e.ModTime) || 0 : 0,
            mime: e.MimeType || undefined,
        }));
    }

    async stat(source, p) {
        source = await this.assertSource(source);
        const target = this.resolve(source, p);
        if (source === LOCAL) {
            try {
                await fsp.lstat(target);
            } catch (e) {
                throw fsError(e, target);
            }
            const entry = await this.entryLocal(target);
            if (entry.link) {
                try {
                    entry.linkTarget = await fsp.readlink(target);
                } catch { /* ignore */ }
            }
            return { ...entry, source, path: target };
        }
        if (target === '/') return { name: source, type: 'dir', source, path: '/' };
        const out = await this.rclone(['lsjson', '--stat', '--', this.rcloneTarget(source, target)], { timeout: 60000 });
        const e = JSON.parse(out);
        return {
            name: e.Name || this.basename(source, target), type: e.IsDir ? 'dir' : 'file', size: e.IsDir ? null : e.Size,
            mtime: e.ModTime ? Date.parse(e.ModTime) || 0 : 0, mime: e.MimeType, source, path: target,
        };
    }

    /** Total size of a folder (local only; stops after 200k entries). */
    async folderSize(source, p) {
        source = await this.assertSource(source);
        const target = this.resolve(source, p);
        if (source !== LOCAL) {
            const out = await this.rclone(['size', '--json', '--', this.rcloneTarget(source, target)], { timeout: 300000 });
            const r = JSON.parse(out);
            return { size: r.bytes, files: r.count, complete: true };
        }
        let size = 0;
        let files = 0;
        let seen = 0;
        const stack = [target];
        while (stack.length && seen < 200000) {
            const dir = stack.pop();
            let list;
            try {
                list = await fsp.readdir(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const d of list) {
                seen++;
                const full = path.join(dir, d.name);
                if (d.isDirectory()) stack.push(full);
                else if (d.isFile()) {
                    try {
                        size += (await fsp.stat(full)).size;
                        files++;
                    } catch { /* vanished */ }
                }
            }
        }
        return { size, files, complete: stack.length === 0 };
    }

    // ---------- search ----------

    /** Finds names containing `query` below `dir` (skips node_modules, .git...). */
    async search(source, dir, query) {
        source = await this.assertSource(source);
        const target = this.resolve(source, dir);
        const q = String(query || '').trim().toLowerCase();
        if (!q) return { results: [], truncated: false };
        if (source !== LOCAL) {
            const glob = '*' + q.replace(/[*?[\]{}\\]/g, c => `\\${c}`) + '*';
            const out = await this.rclone(['lsjson', '-R', '--ignore-case', '--include', glob, '--include', `${glob}/**`,
                '--max-depth', '8', '--', this.rcloneTarget(source, target)], { timeout: 60000 });
            const seen = new Set();
            const results = [];
            for (const e of JSON.parse(out || '[]')) {
                // "--include x/**" lists what's inside matching folders: keep only the match itself
                const parts = e.Path.split('/');
                const idx = parts.findIndex(part => part.toLowerCase().includes(q));
                if (idx === -1) continue;
                const rel = parts.slice(0, idx + 1).join('/');
                if (seen.has(rel)) continue;
                seen.add(rel);
                const isDir = idx < parts.length - 1 || e.IsDir;
                results.push({
                    name: parts[idx], type: isDir ? 'dir' : 'file',
                    path: this.join(source, target, rel).replace(/\/+/g, '/'),
                    size: isDir ? null : e.Size, mtime: Date.parse(e.ModTime) || 0,
                });
                if (results.length >= SEARCH_LIMIT) break;
            }
            return { results, truncated: results.length >= SEARCH_LIMIT };
        }
        const results = [];
        const queue = [target];
        const deadline = Date.now() + 8000;
        let dirs = 0;
        while (queue.length && results.length < SEARCH_LIMIT && Date.now() < deadline && dirs < 50000) {
            const dirPath = queue.shift();
            dirs++;
            let list;
            try {
                list = await fsp.readdir(dirPath, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const d of list) {
                const full = path.join(dirPath, d.name);
                if (d.name.toLowerCase().includes(q)) {
                    results.push({ ...(await this.entryLocal(full, d.name)), path: full });
                    if (results.length >= SEARCH_LIMIT) break;
                }
                if (d.isDirectory() && !SEARCH_SKIP.has(d.name)) queue.push(full);
            }
        }
        return { results, truncated: queue.length > 0 };
    }

    // ---------- reading ----------

    /**
     * Streams a file to an HTTP response. Local files support Range (video seeking).
     * Pages/SVGs are sandboxed so a file can never run scripts as the app.
     */
    async send(req, res, source, p, { download = false } = {}) {
        source = await this.assertSource(source);
        const target = this.resolve(source, p);
        const name = this.basename(source, target);
        const type = mimeOf(name);
        res.set('X-Content-Type-Options', 'nosniff');
        if (type !== 'application/pdf') res.set('Content-Security-Policy', 'sandbox');
        res.set('Cache-Control', 'private, no-cache');
        res.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);
        // HTML/JS shown inline are text, not pages
        res.type(!download && /^text\/(html|javascript)|image\/svg/.test(type) && req.query.render !== '1'
            ? 'text/plain; charset=utf-8' : type);

        if (source !== LOCAL) {
            const child = spawn(this.rcloneBin, ['cat', '--', this.rcloneTarget(source, target)], { stdio: ['ignore', 'pipe', 'pipe'] });
            let err = '';
            child.stderr.on('data', d => { err += d; });
            child.on('error', e => { if (!res.headersSent) res.status(500).json({ error: e.message }); });
            let started = false;
            child.stdout.once('data', () => { started = true; });
            child.stdout.pipe(res);
            child.on('close', code => {
                if (code !== 0 && !started && !res.headersSent) res.status(502).json({ error: rcloneMessage(err) });
            });
            res.on('close', () => child.kill());
            return;
        }

        let st;
        try {
            st = await fsp.stat(target);
        } catch (e) {
            throw fsError(e, target);
        }
        if (st.isDirectory()) throw new FileError('É uma pasta.');
        res.set('Accept-Ranges', 'bytes');
        res.set('Last-Modified', st.mtime.toUTCString());
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        let start = 0;
        let end = st.size - 1;
        if (range && st.size > 0) {
            start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
            end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
            if (start > end || start >= st.size) {
                res.status(416).set('Content-Range', `bytes */${st.size}`).end();
                return;
            }
            res.status(206).set('Content-Range', `bytes ${start}-${end}/${st.size}`);
        }
        res.set('Content-Length', String(st.size ? end - start + 1 : 0));
        if (req.method === 'HEAD' || st.size === 0) return res.end();
        const stream = fs.createReadStream(target, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
    }

    /** A folder (or several items of one folder) as .tar.gz. Local only. */
    async sendArchive(res, source, dir, names) {
        source = await this.assertSource(source);
        if (source !== LOCAL) throw new FileError('Para baixar pastas do rclone, baixe os arquivos um a um.');
        const base = this.localPath(dir);
        const list = (Array.isArray(names) ? names : [names]).map(cleanName);
        if (!list.length) throw new FileError('Nada selecionado.');
        for (const n of list) {
            try {
                await fsp.lstat(path.join(base, n));
            } catch (e) {
                throw fsError(e, n);
            }
        }
        const label = list.length === 1 ? list[0] : (path.basename(base) || 'arquivos');
        res.set('Content-Type', 'application/gzip');
        res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(label)}.tar.gz`);
        const child = spawn('tar', ['-czf', '-', '-C', base, '--', ...list], { stdio: ['ignore', 'pipe', 'ignore'] });
        child.on('error', () => res.destroy());
        child.stdout.pipe(res);
        res.on('close', () => child.kill());
    }

    /** Text for the editor: null text when the file is binary or too big. */
    async readText(source, p) {
        source = await this.assertSource(source);
        const target = this.resolve(source, p);
        const info = await this.stat(source, target);
        if (info.type === 'dir') throw new FileError('É uma pasta.');
        if (info.size > MAX_TEXT) return { ...info, text: null, reason: 'big' };
        let buf;
        if (source === LOCAL) {
            try {
                buf = await fsp.readFile(target);
            } catch (e) {
                throw fsError(e, target);
            }
        } else {
            buf = await new Promise((resolve, reject) => {
                const child = spawn(this.rcloneBin, ['cat', '--', this.rcloneTarget(source, target)]);
                const chunks = [];
                let err = '';
                child.stdout.on('data', d => chunks.push(d));
                child.stderr.on('data', d => { err += d; });
                child.on('error', reject);
                child.on('close', code => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new FileError(rcloneMessage(err), 502))));
            });
        }
        if (buf.subarray(0, 8000).includes(0)) return { ...info, text: null, reason: 'binary' };
        return { ...info, text: buf.toString('utf8') };
    }

    /**
     * Saves text. `expectMtime` guards against overwriting a newer version saved elsewhere
     * (409 unless force).
     */
    async writeText(source, p, text, { expectMtime, force = false } = {}) {
        source = await this.assertSource(source);
        const target = this.resolve(source, p);
        if (typeof text !== 'string') throw new FileError('Conteúdo inválido.');
        if (source === LOCAL) {
            if (expectMtime && !force) {
                try {
                    const st = await fsp.stat(target);
                    if (Math.abs(st.mtimeMs - expectMtime) > 1) {
                        throw new FileError('O arquivo foi alterado em outro lugar depois que você abriu.', 409);
                    }
                } catch (e) {
                    if (e instanceof FileError) throw e;
                }
            }
            try {
                await fsp.writeFile(target, text, 'utf8');
            } catch (e) {
                throw fsError(e, target);
            }
        } else {
            await this.rclone(['rcat', '--', this.rcloneTarget(source, target)], { input: Readable.from([Buffer.from(text, 'utf8')]) });
        }
        return this.stat(source, target);
    }

    // ---------- writing ----------

    /** A free name in `dir`: "nome.txt" -> "nome (1).txt". */
    async freeName(source, dir, name) {
        const taken = new Set((source === LOCAL ? await this.listLocal(dir).catch(() => [])
            : await this.listRemote(source, dir).catch(() => [])).map(e => e.name));
        if (!taken.has(name)) return name;
        const ext = path.extname(name);
        const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
        for (let i = 1; i < 10000; i++) {
            const candidate = `${stem} (${i})${ext && ext !== name ? ext : ''}`;
            if (!taken.has(candidate)) return candidate;
        }
        return `${stem} ${crypto.randomUUID().slice(0, 8)}${ext}`;
    }

    /** Upload: streams the request body into dir/name (auto-renames on conflict unless overwrite). */
    async upload(req, source, dir, name, { overwrite = false } = {}) {
        source = await this.assertSource(source);
        const base = this.resolve(source, dir);
        const clean = cleanName(name);
        const finalName = overwrite ? clean : await this.freeName(source, base, clean);
        const target = this.join(source, base, finalName);
        if (source !== LOCAL) {
            await this.rclone(['rcat', '--', this.rcloneTarget(source, target)], { input: req });
            return { name: finalName, path: target };
        }
        // Write to a temp file first: an interrupted upload never leaves half a file
        const temp = path.join(base, `.${finalName}.${crypto.randomUUID().slice(0, 8)}.part`);
        await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(temp, { flags: 'wx' });
            let failed = false;
            const fail = e => {
                if (failed) return;
                failed = true;
                out.destroy();
                fsp.rm(temp, { force: true }).catch(() => {});
                reject(e);
            };
            out.on('error', e => fail(fsError(e, base)));
            req.on('aborted', () => fail(new FileError('Envio cancelado.', 499)));
            req.on('error', fail);
            out.on('finish', resolve);
            req.pipe(out);
        });
        try {
            await fsp.rename(temp, target);
        } catch (e) {
            await fsp.rm(temp, { force: true }).catch(() => {});
            throw fsError(e, target);
        }
        return { name: finalName, path: target };
    }

    async mkdir(source, dir, name) {
        source = await this.assertSource(source);
        const target = this.join(source, this.resolve(source, dir), cleanName(name));
        if (source === LOCAL) {
            try {
                await fsp.mkdir(target);
            } catch (e) {
                throw fsError(e, target);
            }
        } else {
            await this.rclone(['mkdir', '--', this.rcloneTarget(source, target)]);
        }
        return { path: target };
    }

    async touch(source, dir, name) {
        source = await this.assertSource(source);
        const target = this.join(source, this.resolve(source, dir), cleanName(name));
        if (source === LOCAL) {
            try {
                await fsp.writeFile(target, '', { flag: 'wx' });
            } catch (e) {
                throw fsError(e, target);
            }
        } else {
            await this.rclone(['rcat', '--', this.rcloneTarget(source, target)], { input: Readable.from([Buffer.alloc(0)]) });
        }
        return { path: target };
    }

    async rename(source, p, newName) {
        source = await this.assertSource(source);
        const from = this.resolve(source, p);
        if (this.isRoot(source, from)) throw new FileError('Não dá para renomear a raiz.');
        const to = this.join(source, this.dirname(source, from), cleanName(newName));
        if (to === from) return { path: to };
        if (source === LOCAL) {
            try {
                await fsp.access(to);
                throw new FileError(`Já existe "${newName}".`, 409);
            } catch (e) {
                if (e instanceof FileError) throw e;
            }
            try {
                await fsp.rename(from, to);
            } catch (e) {
                throw fsError(e, from);
            }
        } else {
            await this.rclone(['moveto', '--', this.rcloneTarget(source, from), this.rcloneTarget(source, to)]);
        }
        return { path: to };
    }

    /** Deletes items (folders recursively). */
    async remove(source, paths) {
        source = await this.assertSource(source);
        const done = [];
        for (const p of paths) {
            const target = this.resolve(source, p);
            if (this.isRoot(source, target) || (source === LOCAL && target === this.home)) {
                throw new FileError('Essa pasta não pode ser apagada por aqui.');
            }
            if (source === LOCAL) {
                try {
                    await fsp.rm(target, { recursive: true });
                } catch (e) {
                    throw fsError(e, target);
                }
            } else {
                const info = await this.stat(source, target);
                await this.rclone([info.type === 'dir' ? 'purge' : 'deletefile', '--', this.rcloneTarget(source, target)]);
            }
            done.push(target);
        }
        return { removed: done };
    }

    /**
     * Copies or moves items into a folder (any source to any source). Name conflicts get
     * " (1)"; a folder can't go inside itself.
     */
    async transfer(items, dest, { move = false } = {}) {
        const destSource = await this.assertSource(dest.source);
        const destDir = this.resolve(destSource, dest.path);
        const results = [];
        for (const item of items) {
            const source = await this.assertSource(item.source);
            const from = this.resolve(source, item.path);
            const name = this.basename(source, from);
            if (source === destSource) {
                let inside;
                if (source === LOCAL) {
                    const rel = path.relative(from, destDir);
                    inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
                } else {
                    inside = destDir === from || destDir.startsWith(from + '/');
                }
                if (inside) throw new FileError(`"${name}" não pode ir para dentro dela mesma.`);
                if (move && this.dirname(source, from) === destDir) {
                    results.push({ path: from, skipped: true });
                    continue;
                }
            }
            const finalName = await this.freeName(destSource, destDir, name);
            const to = this.join(destSource, destDir, finalName);
            if (source === LOCAL && destSource === LOCAL) {
                try {
                    if (move) {
                        try {
                            await fsp.rename(from, to);
                        } catch (e) {
                            if (e.code !== 'EXDEV') throw e;
                            await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
                            await fsp.rm(from, { recursive: true });
                        }
                    } else {
                        await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
                    }
                } catch (e) {
                    throw fsError(e, from);
                }
            } else {
                // Anything that touches a remote: rclone (works for files and folders)
                await this.rclone([move ? 'moveto' : 'copyto', '--', this.rcloneTarget(source, from), this.rcloneTarget(destSource, to)]);
            }
            results.push({ path: to });
        }
        return { results };
    }
}

/** Last meaningful line of rclone's stderr, without the timestamp. */
function rcloneMessage(stderr) {
    const lines = String(stderr || '').split('\n').map(l => l.trim()).filter(Boolean);
    const last = lines.reverse().find(l => /ERROR|Failed|error/i.test(l)) || lines[0] || '';
    const msg = last.replace(/^\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s+/, '').replace(/^(ERROR|NOTICE|Failed to \w+):?\s*/i, '');
    if (/directory not found|object not found|not found/i.test(msg)) return 'Não encontrado no remote.';
    if (/didn't find section in config file/i.test(msg)) return 'Remote não configurado no rclone.';
    return msg.slice(0, 300);
}

module.exports = { FileManager, FileError, LOCAL };
