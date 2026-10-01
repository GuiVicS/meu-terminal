/**
 * filesSession.js
 * "Arquivos" tab: a file manager for the server's folders and, when rclone is installed,
 * its remotes (Google Drive...). Browse, preview, edit text, upload, download, copy/move,
 * rename, delete, search, favorites. Touch: tap opens, long press selects, ⋮ on each row.
 * Mouse: click selects, double click opens, right click menu, drag to move, drop to upload.
 * Same interface as TerminalSession, so tabs, status bar and menus work with it.
 */
import { STATE, SESSION_COLORS } from './session.js';
import StorageManager from './storage.js';
import { icon } from '../ui/icons.js';
import { showMenu } from '../ui/contextMenu.js';
import { toast } from '../ui/toast.js';
import { askText, askConfirm, showInfo } from '../ui/prompt.js';

const prefs = new StorageManager('meuterminal-');
const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const LONG_PRESS = 450;
const UPLOAD_CONCURRENCY = 2;
const THUMB_MAX = 15 * 1024 * 1024;

// ---------- helpers ----------

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function query(params) {
    const q = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach(item => q.append(k, item));
        else if (v !== undefined && v !== null) q.append(k, String(v));
    });
    return q.toString();
}

function apiUrl(route, params) {
    return `${basePath()}/api/files/${route}${params ? `?${query(params)}` : ''}`;
}

async function request(method, route, { params, body } = {}) {
    const response = await fetch(apiUrl(route, params), {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.redirected && /\/login$/.test(new URL(response.url).pathname)) {
        window.location.href = `${basePath()}/login`;
        throw new Error('Sua sessão expirou. Entre de novo.');
    }
    let data = null;
    try {
        data = await response.json();
    } catch { /* empty body */ }
    if (!response.ok) {
        const error = new Error(data?.error || `Erro ${response.status}`);
        error.status = response.status;
        throw error;
    }
    return data;
}

const sizeFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
function formatSize(bytes) {
    if (bytes === null || bytes === undefined) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${i === 0 ? n : sizeFormat.format(n)} ${units[i]}`;
}

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
const fullDateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const longFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' });
function formatDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return `hoje ${timeFormat.format(d)}`;
    if (d.getFullYear() === now.getFullYear()) return dayFormat.format(d).replace('.', '');
    return fullDateFormat.format(d);
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

// File kinds by extension (icons, preview)
const EXT = {
    image: 'png jpg jpeg gif webp svg ico bmp avif',
    video: 'mp4 webm mov mkv m4v ogv',
    audio: 'mp3 wav ogg oga m4a flac opus aac',
    pdf: 'pdf',
    archive: 'zip gz tgz tar rar 7z bz2 xz zst',
    sheet: 'xls xlsx ods',
    json: 'json jsonc json5',
    key: 'pem key crt cer pub gpg asc p12',
    code: 'js mjs cjs ts tsx jsx vue svelte py rb php go rs java kt kts c h cc cpp hpp cs swift sh bash zsh fish ps1 bat '
        + 'sql graphql gql html htm css scss sass less xml yaml yml toml ini conf cfg lua pl dart ex exs erl hs clj '
        + 'scala tf hcl prisma astro r gradle',
    text: 'txt md markdown log env csv tsv gitignore gitattributes dockerignore editorconfig properties lock rst adoc srt vtt',
};
const EXT_KIND = {};
Object.entries(EXT).forEach(([kind, list]) => list.split(' ').forEach(ext => { EXT_KIND[ext] = kind; }));
const TEXT_NAMES = /^(dockerfile|makefile|license|licence|readme|changelog|procfile|gemfile|rakefile|vagrantfile|config|authorized_keys|known_hosts|\.env(\..*)?|\.[\w.-]*rc|\.profile|\.bash_\w+|\.gitconfig|\.npmrc)$/i;
const KIND_ICON = {
    dir: 'folder', image: 'fileImage', video: 'fileVideo', audio: 'fileAudio', pdf: 'fileText', archive: 'fileArchive',
    sheet: 'fileSheet', json: 'fileJson', key: 'fileKey', code: 'fileCode', text: 'fileText', other: 'file',
};
const MEDIA = new Set(['image', 'video', 'audio']);

function extOf(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function kindOf(entry) {
    if (entry.type === 'dir') return 'dir';
    const kind = EXT_KIND[extOf(entry.name)];
    if (kind) return kind;
    return TEXT_NAMES.test(entry.name) ? 'text' : 'other';
}

/** Shared by every files tab: copy/cut clipboard, favorites, sources. */
const shared = {
    clipboard: null, // { op: 'copy' | 'move', items: [{ source, path, name, type }] }
    listeners: new Set(),
    favorites: null,
    sources: null,
    setClipboard(value) {
        this.clipboard = value;
        this.listeners.forEach(fn => fn());
    },
    notify() {
        this.listeners.forEach(fn => fn());
    },
    async loadFavorites(force = false) {
        if (!this.favorites || force) {
            try {
                this.favorites = await request('GET', 'favorites');
            } catch {
                this.favorites = this.favorites || [];
            }
        }
        return this.favorites;
    },
    async saveFavorites(list) {
        this.favorites = list;
        this.notify();
        try {
            this.favorites = await request('PUT', 'favorites', { body: list });
        } catch (e) {
            toast(`Não foi possível salvar os favoritos: ${e.message}`, { tone: 'error' });
        }
        this.notify();
    },
    async loadSources(force = false) {
        if (!this.sources || force) {
            try {
                this.sources = await request('GET', 'sources');
            } catch {
                this.sources = this.sources || { home: '', rclone: false, sources: [{ id: 'local', name: 'Este servidor', type: 'local' }] };
            }
        }
        return this.sources;
    },
};

export default class FilesSession {
    /**
     * @param {object} opts
     * @param {object} opts.row - session from /api/sessions (kind 'files': url = source, cwd = folder)
     * @param {object} opts.settings - SettingsManager
     * @param {object} opts.hooks - callbacks into the workspace
     */
    constructor({ row, settings, hooks }) {
        this.kind = 'files';
        this.id = row.id;
        this.name = row.name;
        this.pinned = !!row.pinned;
        this.color = SESSION_COLORS.includes(row.color) ? row.color : 'blue';
        this.settings = settings;
        this.hooks = hooks;

        // Fields the rest of the app reads from terminal sessions
        this.state = STATE.CONNECTING;
        this.shell = 'arquivos';
        this.startCwd = row.startCwd || '';
        this.cwd = row.cwd || null;
        this.process = null;
        this.branch = null;
        this.pid = null;
        this.terminal = null;
        this.addons = null;
        this.hasActivity = false;

        this.source = row.url || 'local';
        this.path = row.cwd || '';
        this.sep = '/';
        this.parent = null;
        this.entries = [];
        this.visible = [];
        this.selection = new Set(); // paths
        this.cursor = -1;
        this.anchor = -1;
        this.filter = '';
        this.results = null; // recursive search: { query, entries, truncated }
        this.back = [];
        this.forward = [];
        this.navSeq = 0;
        this.lastNav = 0;
        this.loading = false;
        this.error = null;
        this.uploads = [];
        this.viewer = null;

        const saved = prefs.get('files', {});
        this.prefs = {
            view: saved.view === 'grid' ? 'grid' : 'list',
            sort: ['name', 'size', 'mtime', 'type'].includes(saved.sort) ? saved.sort : 'name',
            desc: !!saved.desc,
            hidden: !!saved.hidden,
            side: saved.side !== false,
        };

        this.active = false;
        this.disposed = false;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.timers = new Set();
        this.onShared = () => this.renderBars();
        shared.listeners.add(this.onShared);

        this.panel = document.createElement('div');
        this.panel.className = 'terminal-panel files-panel';
        this.panel.id = `panel-${this.id}`;
        this.panel.setAttribute('role', 'tabpanel');
        this.panel.setAttribute('aria-labelledby', `tab-${this.id}`);
    }

    get sizeLabel() {
        if (this.results) return `${this.results.entries.length} resultados`;
        return this.entries.length ? `${this.visible.length} itens` : '';
    }

    get sourceName() {
        if (this.source === 'local') return 'Este servidor';
        return this.source;
    }

    // ---------- paths ----------

    join(dir, name) {
        if (this.source !== 'local' || this.sep === '/') return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
        return dir.endsWith(this.sep) ? dir + name : dir + this.sep + name;
    }

    /** Home shown as "~" (local), remote as "gdrive:/pasta". */
    prettyPath(path = this.path, source = this.source) {
        if (source !== 'local') return `${source}:${path}`;
        const home = shared.sources?.home;
        if (home && (path === home || path.startsWith(home + this.sep))) return '~' + path.slice(home.length);
        return path;
    }

    displayCwd() {
        return this.path ? this.prettyPath() : '';
    }

    crumbs() {
        if (!this.path) return [];
        if (this.source !== 'local' || this.sep === '/') {
            const parts = this.path.split('/').filter(Boolean);
            const rootLabel = this.source === 'local' ? '/' : this.source;
            const list = [{ label: rootLabel, path: '/' }];
            let acc = '';
            parts.forEach(part => {
                acc += `/${part}`;
                list.push({ label: part, path: acc });
            });
            // Local paths under home start at "~"
            const home = this.source === 'local' ? shared.sources?.home : null;
            if (home && home !== '/' && (this.path === home || this.path.startsWith(home + '/'))) {
                const depth = home.split('/').filter(Boolean).length;
                return [{ label: '~', path: home, home: true }, ...list.slice(depth + 1)];
            }
            return list;
        }
        // Windows-style local path (development)
        const parts = this.path.split(this.sep).filter(Boolean);
        let acc = '';
        return parts.map((part, i) => {
            acc = i === 0 ? part + this.sep : acc + (acc.endsWith(this.sep) ? '' : this.sep) + part;
            return { label: part, path: acc };
        });
    }

    // ---------- view ----------

    mount(parent) {
        parent.appendChild(this.panel);
        this.panel.innerHTML = `
            <div class="fm" data-view="${this.prefs.view}">
                <aside class="fm-side" aria-label="Locais"></aside>
                <div class="fm-scrim" hidden></div>
                <div class="fm-main">
                    <div class="fm-toolbar">
                        <button type="button" class="icon-btn" data-act="side" aria-label="Locais e favoritos">${icon('panelLeft', 18)}</button>
                        <button type="button" class="icon-btn fm-wide" data-act="back" aria-label="Voltar" disabled>${icon('chevronLeft', 18)}</button>
                        <button type="button" class="icon-btn fm-wide" data-act="forward" aria-label="Avançar" disabled>${icon('chevronRight', 18)}</button>
                        <button type="button" class="icon-btn" data-act="up" aria-label="Pasta acima">${icon('arrowUp', 18)}</button>
                        <nav class="fm-crumbs" aria-label="Caminho"></nav>
                        <button type="button" class="icon-btn" data-act="search" aria-label="Buscar">${icon('search', 18)}</button>
                        <button type="button" class="icon-btn fm-wide" data-act="new-folder" aria-label="Nova pasta">${icon('folderPlus', 18)}</button>
                        <button type="button" class="icon-btn fm-wide" data-act="upload" aria-label="Enviar arquivos">${icon('upload', 18)}</button>
                        <button type="button" class="icon-btn fm-wide" data-act="view" aria-label="Alternar lista/grade"></button>
                        <button type="button" class="icon-btn" data-act="more" aria-label="Mais ações da pasta">${icon('more', 18)}</button>
                    </div>
                    <div class="fm-progress" hidden></div>
                    <form class="fm-search" hidden role="search">
                        ${icon('search', 16)}
                        <input type="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false"
                            placeholder="Filtrar nesta pasta" aria-label="Filtrar nesta pasta">
                        <button type="submit" class="btn btn-ghost btn-sm">Buscar em subpastas</button>
                        <button type="button" class="icon-btn" data-act="search-close" aria-label="Fechar busca">${icon('x', 16)}</button>
                    </form>
                    <div class="fm-results-bar" hidden></div>
                    <div class="fm-head" role="presentation">
                        <button type="button" data-sort="name">Nome</button>
                        <button type="button" data-sort="size">Tamanho</button>
                        <button type="button" data-sort="mtime">Modificado</button>
                        <span></span>
                    </div>
                    <div class="fm-list" role="listbox" aria-multiselectable="true" tabindex="0" aria-label="Arquivos"></div>
                    <div class="fm-bars">
                        <div class="fm-pastebar" hidden></div>
                        <div class="fm-selbar" hidden></div>
                    </div>
                    <button type="button" class="fm-fab" aria-label="Novo">${icon('plus', 24)}</button>
                    <div class="fm-uploads" hidden></div>
                    <div class="fm-drop" hidden><div>${icon('upload', 28)}<span></span></div></div>
                </div>
                <div class="fm-viewer" hidden role="dialog" aria-modal="false"></div>
                <input type="file" class="fm-file-input" multiple hidden>
            </div>`;
        const q = sel => this.panel.querySelector(sel);
        this.el = {
            root: q('.fm'),
            side: q('.fm-side'),
            scrim: q('.fm-scrim'),
            main: q('.fm-main'),
            toolbar: q('.fm-toolbar'),
            crumbs: q('.fm-crumbs'),
            progress: q('.fm-progress'),
            search: q('.fm-search'),
            searchInput: q('.fm-search input'),
            resultsBar: q('.fm-results-bar'),
            head: q('.fm-head'),
            list: q('.fm-list'),
            pastebar: q('.fm-pastebar'),
            selbar: q('.fm-selbar'),
            fab: q('.fm-fab'),
            uploads: q('.fm-uploads'),
            drop: q('.fm-drop'),
            viewer: q('.fm-viewer'),
            fileInput: q('.fm-file-input'),
        };
        this.applySidePref();
        this.bindToolbar();
        this.bindList();
        this.bindKeyboard();
        this.bindDrop();
        this.connect();
        shared.loadSources().then(() => {
            this.renderSide();
            this.renderCrumbs();
            this.hooks.onInfo(this);
        });
        shared.loadFavorites().then(() => this.renderSide());
        this.navigate(this.source, this.path, { push: false, persist: false, fallback: true });
    }

    setActive(active) {
        this.active = active;
        this.panel.classList.toggle('active', active);
        this.panel.setAttribute('aria-hidden', String(!active));
        if (active && this.mountedOnce) this.refresh({ quiet: true });
        this.mountedOnce = true;
    }

    focus() {
        if (coarse() || !this.el) return;
        if (this.viewer?.editor) this.viewer.editor.focus({ preventScroll: true });
        else this.el.list.focus({ preventScroll: true });
    }

    applySettings() { /* uses the app theme via CSS */ }

    applyRow(row) {
        this.name = row.name;
        this.pinned = !!row.pinned;
        if (SESSION_COLORS.includes(row.color)) this.color = row.color;
        // Another device moved this tab to another folder: follow (not while we navigate)
        const source = row.url || 'local';
        if (this.el && row.cwd && (source !== this.source || row.cwd !== this.path)
            && Date.now() - this.lastNav > 3000 && !this.loading) {
            this.navigate(source, row.cwd, { persist: false });
        }
    }

    // ---------- connection (only for workspace notices) ----------

    connect() {
        if (this.disposed) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}${basePath()}/?${query({ session: this.id })}`);
        this.ws = ws;
        ws.onopen = () => {
            this.reconnectAttempts = 0;
            this.setState(STATE.CONNECTED);
        };
        ws.onmessage = event => {
            let m;
            try {
                m = JSON.parse(event.data);
            } catch {
                return;
            }
            if (m.type === 'workspace') this.hooks.onWorkspaceChanged();
            else if (m.nonce) this.hooks.onServerMessage(m); // app-wide notices (open-tab, notify, split...)
        };
        ws.onerror = () => ws.close();
        ws.onclose = event => {
            if (this.ws !== ws || this.disposed) return;
            if (event.code === 1008) {
                this.setState(STATE.ERROR);
                this.hooks.onAuthRequired();
                return;
            }
            if (event.code === 4404) {
                this.hooks.onRemoved(this);
                return;
            }
            if (this.reconnectAttempts < 6) {
                this.setState(STATE.RECONNECTING);
                this.later(() => this.connect(), 1000 * Math.pow(2, this.reconnectAttempts++));
            } else {
                this.setState(STATE.DISCONNECTED);
            }
        };
    }

    reconnectIfDropped() {
        if (this.state === STATE.DISCONNECTED) {
            this.reconnectAttempts = 0;
            this.connect();
        }
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.hooks.onStateChange(this);
    }

    // ---------- navigation ----------

    /**
     * Opens a folder. push = add to back history; persist = save the tab's location;
     * fallback = on error, go home instead of showing the error (saved folder was deleted).
     */
    async navigate(source, path, { push = true, persist = true, fallback = false, keepSearch = false } = {}) {
        const seq = ++this.navSeq;
        this.setLoading(true);
        let data;
        try {
            data = await request('GET', 'list', { params: { source, path } });
        } catch (e) {
            if (seq !== this.navSeq || this.disposed) return;
            this.setLoading(false);
            if (fallback && (source !== 'local' || path)) {
                toast(`Não deu para abrir ${path || source}: ${e.message}`, { tone: 'error' });
                return this.navigate('local', '', { push: false, persist: true });
            }
            if (!this.path) {
                this.error = e.message;
                this.renderList();
            } else {
                toast(e.message, { tone: 'error' });
            }
            return;
        }
        if (seq !== this.navSeq || this.disposed) return;
        const moved = data.source !== this.source || data.path !== this.path;
        if (push && moved && this.path) {
            this.back.push({ source: this.source, path: this.path });
            this.forward = [];
        }
        this.source = data.source;
        this.shell = data.source === 'local' ? 'arquivos' : `rclone · ${data.source}`;
        this.path = data.path;
        this.cwd = data.path;
        this.sep = data.sep || '/';
        this.parent = data.parent;
        this.entries = data.entries.map(e => ({ ...e, path: this.join(data.path, e.name), source: data.source }));
        this.truncated = data.truncated;
        this.error = null;
        if (moved) {
            this.selection.clear();
            this.cursor = -1;
            this.anchor = -1;
            this.filter = '';
            this.el.searchInput.value = '';
            if (!keepSearch) this.closeResults();
        }
        this.setLoading(false);
        this.render();
        if (moved) this.el.list.scrollTop = 0;
        if (persist && moved) this.persistLocation();
        if (moved && coarse()) this.closeSideDrawer();
    }

    refresh({ quiet = false } = {}) {
        if (!this.path && !quiet) return this.navigate(this.source, '', { push: false });
        if (!this.path) return undefined;
        return this.navigate(this.source, this.path, { push: false, persist: false, keepSearch: true });
    }

    goUp() {
        if (this.results) return this.closeResults(true);
        if (this.parent) this.navigate(this.source, this.parent);
    }

    goBack() {
        const prev = this.back.pop();
        if (!prev) return;
        this.forward.push({ source: this.source, path: this.path });
        this.navigate(prev.source, prev.path, { push: false });
    }

    goForward() {
        const next = this.forward.pop();
        if (!next) return;
        this.back.push({ source: this.source, path: this.path });
        this.navigate(next.source, next.path, { push: false });
    }

    goHome() {
        this.navigate('local', shared.sources?.home || '');
    }

    persistLocation() {
        this.lastNav = Date.now();
        fetch(`${basePath()}/api/sessions/${encodeURIComponent(this.id)}`, {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ location: { source: this.source, path: this.path } }),
        }).catch(() => { /* next navigation saves it */ });
    }

    setLoading(on) {
        this.loading = on;
        clearTimeout(this.progressTimer);
        if (on) this.progressTimer = this.later(() => { this.el.progress.hidden = false; }, 150);
        else this.el.progress.hidden = true;
    }

    // ---------- rendering ----------

    render() {
        this.computeVisible();
        this.renderCrumbs();
        this.renderList();
        this.renderBars();
        this.renderToolbar();
        this.renderSide();
        this.hooks.onInfo(this);
    }

    computeVisible() {
        const base = this.results ? this.results.entries : this.entries;
        const f = this.filter.trim().toLowerCase();
        const { sort, desc, hidden } = this.prefs;
        const list = base.filter(e => (hidden || this.results || !e.name.startsWith('.'))
            && (!f || e.name.toLowerCase().includes(f)));
        const dir = desc ? -1 : 1;
        list.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1; // folders first
            let r = 0;
            if (sort === 'size') r = (a.size || 0) - (b.size || 0);
            else if (sort === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
            else if (sort === 'type') r = collator.compare(extOf(a.name), extOf(b.name));
            return (r || collator.compare(a.name, b.name)) * dir;
        });
        this.visible = list;
        // Drop selected items that are no longer shown
        const shown = new Set(list.map(e => e.path));
        [...this.selection].forEach(p => { if (!shown.has(p)) this.selection.delete(p); });
        if (this.cursor >= list.length) this.cursor = list.length - 1;
    }

    renderCrumbs() {
        const crumbs = this.crumbs();
        this.el.crumbs.innerHTML = crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            const lead = i === 0 ? icon(this.source === 'local' ? (c.home ? 'house' : 'hardDrive') : 'cloud', 15) : '';
            return `${i ? `<span class="fm-crumb-sep" aria-hidden="true">${icon('chevronRight', 14)}</span>` : ''}`
                + `<button type="button" class="fm-crumb" data-i="${i}" ${last ? 'aria-current="page"' : ''}>${lead}<span>${esc(c.label)}</span></button>`;
        }).join('');
        this.crumbList = crumbs;
        // Keep the current folder in view on narrow screens
        this.el.crumbs.scrollLeft = this.el.crumbs.scrollWidth;
    }

    renderToolbar() {
        const q = act => this.el.toolbar.querySelector(`[data-act="${act}"]`);
        q('back').disabled = !this.back.length;
        q('forward').disabled = !this.forward.length;
        q('up').disabled = !this.parent && !this.results;
        q('view').innerHTML = icon(this.prefs.view === 'grid' ? 'listView' : 'grid', 18);
        q('view').setAttribute('aria-label', this.prefs.view === 'grid' ? 'Ver em lista' : 'Ver em grade');
        this.el.root.dataset.view = this.prefs.view;
        this.el.head.querySelectorAll('[data-sort]').forEach(b => {
            const on = b.dataset.sort === this.prefs.sort;
            b.classList.toggle('sorted', on);
            b.innerHTML = `${esc(b.textContent.replace(/[↑↓]/g, '').trim())}${on ? (this.prefs.desc ? ' ↓' : ' ↑') : ''}`;
        });
        this.el.fab.hidden = !!this.results;
    }

    rowHtml(e, i) {
        const kind = kindOf(e);
        const selected = this.selection.has(e.path);
        const cut = shared.clipboard?.op === 'move' && shared.clipboard.items.some(c => c.path === e.path && c.source === e.source);
        const thumb = this.prefs.view === 'grid' && kind === 'image' && e.source === 'local' && (e.size || 0) < THUMB_MAX
            ? `<img loading="lazy" decoding="async" alt="" src="${esc(this.rawUrl(e, { render: extOf(e.name) === 'svg' ? 1 : undefined }))}">`
            : icon(e.link && e.type === 'dir' ? 'folderSymlink' : KIND_ICON[kind], this.prefs.view === 'grid' ? 34 : 20);
        const sub = this.results
            ? this.prettyPath(e.path.slice(0, Math.max(1, e.path.length - e.name.length - 1)), e.source)
            : [e.type === 'dir' ? '' : formatSize(e.size), formatDate(e.mtime)].filter(Boolean).join(' · ');
        return `<div class="fm-row${selected ? ' selected' : ''}${i === this.cursor ? ' cursor' : ''}${cut ? ' cut' : ''}`
            + `${e.name.startsWith('.') ? ' dotfile' : ''}" role="option" id="${this.id}-r${i}" data-i="${i}"`
            + ` aria-selected="${selected}" data-kind="${kind}"${coarse() ? '' : ' draggable="true"'}>`
            + `<span class="fm-check" aria-hidden="true">${icon(selected ? 'squareCheck' : 'square', 18)}</span>`
            + `<span class="fm-icon kind-${kind}">${thumb}</span>`
            + `<span class="fm-name"><span class="fm-title">${esc(e.name)}${e.link ? ' <span class="fm-link" title="Atalho (link simbólico)">↗</span>' : ''}</span>`
            + `<span class="fm-sub">${esc(sub)}</span></span>`
            + `<span class="fm-size">${e.type === 'dir' ? '—' : esc(formatSize(e.size))}</span>`
            + `<span class="fm-date">${esc(formatDate(e.mtime))}</span>`
            + `<button type="button" class="icon-btn fm-more" tabindex="-1" aria-label="Ações de ${esc(e.name)}">${icon('more', 17)}</button>`
            + '</div>';
    }

    renderList() {
        const { list } = this.el;
        list.classList.toggle('selecting', this.selection.size > 0);
        if (this.error) {
            list.innerHTML = `<div class="fm-empty">${icon('info', 28)}<p>${esc(this.error)}</p>
                <div class="fm-empty-actions"><button type="button" class="btn btn-ghost" data-empty="retry">Tentar de novo</button>
                <button type="button" class="btn btn-primary" data-empty="home">Ir para o início</button></div></div>`;
            return;
        }
        if (!this.visible.length) {
            const msg = this.results ? `Nada encontrado para "${this.results.query}".`
                : this.filter ? `Nenhum item com "${this.filter}" nesta pasta.`
                    : this.loading || !this.path ? 'Carregando…'
                        : this.entries.length ? 'Só há arquivos ocultos aqui. Ative "Mostrar ocultos" no menu ⋮.' : 'Pasta vazia.';
            list.innerHTML = `<div class="fm-empty">${icon(this.path ? 'folderOpen' : 'loader', 28)}<p>${esc(msg)}</p></div>`;
            return;
        }
        list.innerHTML = this.visible.map((e, i) => this.rowHtml(e, i)).join('')
            + (this.truncated && !this.results ? '<div class="fm-note">Pasta muito grande: mostrando os primeiros 5000 itens.</div>' : '')
            + (this.results?.truncated ? '<div class="fm-note">Muitos resultados: mostrando os primeiros. Refine a busca.</div>' : '');
        if (this.cursor >= 0) list.setAttribute('aria-activedescendant', `${this.id}-r${this.cursor}`);
        else list.removeAttribute('aria-activedescendant');
    }

    /** Re-renders only selection classes (fast path for clicks). */
    renderSelection() {
        this.el.list.classList.toggle('selecting', this.selection.size > 0);
        this.el.list.querySelectorAll('.fm-row').forEach(row => {
            const e = this.visible[Number(row.dataset.i)];
            const on = !!e && this.selection.has(e.path);
            if (row.classList.contains('selected') !== on) {
                row.classList.toggle('selected', on);
                row.setAttribute('aria-selected', String(on));
                row.querySelector('.fm-check').innerHTML = icon(on ? 'squareCheck' : 'square', 18);
            }
            row.classList.toggle('cursor', Number(row.dataset.i) === this.cursor);
        });
        if (this.cursor >= 0) this.el.list.setAttribute('aria-activedescendant', `${this.id}-r${this.cursor}`);
        this.renderBars();
        this.hooks.onInfo(this);
    }

    renderBars() {
        if (!this.el) return;
        const n = this.selection.size;
        this.process = n ? `${n} selecionado${n > 1 ? 's' : ''}` : null;
        const { selbar, pastebar } = this.el;
        selbar.hidden = !n;
        if (n) {
            const items = this.selectedEntries();
            const one = items.length === 1 ? items[0] : null;
            selbar.innerHTML = `
                <button type="button" class="icon-btn" data-sel="clear" aria-label="Limpar seleção">${icon('x', 18)}</button>
                <span class="fm-sel-count">${n} selecionado${n > 1 ? 's' : ''}</span>
                <button type="button" class="icon-btn" data-sel="all" aria-label="Selecionar tudo">${icon('checkCheck', 18)}</button>
                <button type="button" class="icon-btn" data-sel="copy" aria-label="Copiar">${icon('copy', 18)}</button>
                <button type="button" class="icon-btn" data-sel="cut" aria-label="Recortar">${icon('scissors', 18)}</button>
                <button type="button" class="icon-btn" data-sel="download" aria-label="Baixar">${icon('download', 18)}</button>
                ${one ? `<button type="button" class="icon-btn" data-sel="rename" aria-label="Renomear">${icon('edit', 18)}</button>` : ''}
                <button type="button" class="icon-btn danger" data-sel="delete" aria-label="Excluir">${icon('trash', 18)}</button>
                <button type="button" class="icon-btn" data-sel="more" aria-label="Mais ações">${icon('more', 18)}</button>`;
        }
        const clip = shared.clipboard;
        pastebar.hidden = !clip || !!this.results;
        if (clip) {
            const count = clip.items.length;
            const what = count === 1 ? `"${clip.items[0].name}"` : `${count} itens`;
            pastebar.innerHTML = `
                ${icon(clip.op === 'move' ? 'scissors' : 'copy', 16)}
                <span class="fm-paste-text">${esc(what)} ${clip.op === 'move' ? 'para mover' : 'copiado' + (count > 1 ? 's' : '')}</span>
                <button type="button" class="btn btn-primary btn-sm" data-paste="here">${clip.op === 'move' ? 'Mover para cá' : 'Colar aqui'}</button>
                <button type="button" class="icon-btn" data-paste="cancel" aria-label="Cancelar">${icon('x', 16)}</button>`;
        }
        this.el.root.classList.toggle('has-bars', !selbar.hidden || !pastebar.hidden);
    }

    renderSide() {
        if (!this.el) return;
        const src = shared.sources;
        const favs = shared.favorites || [];
        const here = (source, path) => source === this.source && path === this.path;
        const item = (attrs, iconName, label, sub, current, extra = '') => `
            <li><button type="button" class="fm-side-item${current ? ' current' : ''}" ${attrs}>
                ${icon(iconName, 17)}<span class="fm-side-text"><span>${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
            </button>${extra}</li>`;
        const home = src?.home || '';
        let html = `<div class="fm-side-head"><span>Locais</span>
            <button type="button" class="icon-btn fm-side-close" data-side="close" aria-label="Fechar">${icon('x', 16)}</button></div>
            <ul>
                ${item(`data-go="local" data-path="${esc(home)}"`, 'house', 'Início', home ? '~' : '', here('local', home))}
                ${item('data-go="local" data-path="/"', 'hardDrive', 'Raiz do servidor', '/', here('local', '/'))}
            </ul>
            <div class="fm-side-head"><span>Nuvem (rclone)</span></div>`;
        const remotes = (src?.sources || []).filter(s => s.remote);
        if (remotes.length) {
            html += `<ul>${remotes.map(r => item(`data-go="${esc(r.id)}" data-path="/"`, 'cloud', r.name,
                r.type === 'drive' ? 'Google Drive' : r.type, this.source === r.id)).join('')}</ul>`;
        } else {
            html += `<p class="fm-side-hint">${src?.rclone
                ? 'Nenhum remote configurado. No terminal: <code>rclone config</code>'
                : 'Para ver o Google Drive, instale o rclone e rode <code>rclone config</code>.'}</p>`;
        }
        html += `<div class="fm-side-head"><span>Favoritos</span></div>`;
        if (favs.length) {
            html += `<ul>${favs.map((f, i) => item(`data-go="${esc(f.source)}" data-path="${esc(f.path)}"`, 'star',
                f.name || f.path.split(/[\\/]/).filter(Boolean).pop() || f.path, this.prettyPath(f.path, f.source),
                here(f.source, f.path),
                `<button type="button" class="icon-btn fm-side-remove" data-unfav="${i}" aria-label="Remover dos favoritos">${icon('x', 14)}</button>`)).join('')}</ul>`;
        } else {
            html += '<p class="fm-side-hint">Use ⋮ → "Adicionar aos favoritos" numa pasta.</p>';
        }
        this.el.side.innerHTML = html;
    }

    applySidePref() {
        this.el.root.classList.toggle('side-closed', !this.prefs.side);
    }

    toggleSide() {
        if (window.matchMedia('(max-width: 899px)').matches) {
            const open = !this.el.root.classList.contains('side-open');
            this.el.root.classList.toggle('side-open', open);
            this.el.scrim.hidden = !open;
            return;
        }
        this.prefs.side = !this.prefs.side;
        this.savePrefs();
        this.applySidePref();
    }

    closeSideDrawer() {
        this.el.root.classList.remove('side-open');
        this.el.scrim.hidden = true;
    }

    savePrefs() {
        prefs.set('files', this.prefs);
    }

    setPref(key, value) {
        this.prefs[key] = value;
        this.savePrefs();
        this.render();
    }

    // ---------- selection ----------

    selectedEntries() {
        const all = this.results ? this.results.entries : this.entries;
        return all.filter(e => this.selection.has(e.path));
    }

    /** What an action applies to: the selection, or the item under the cursor. */
    targets(i) {
        const e = this.visible[i];
        if (e && !this.selection.has(e.path)) return [e];
        const sel = this.selectedEntries();
        return sel.length ? sel : (e ? [e] : []);
    }

    selectOnly(i) {
        this.selection.clear();
        const e = this.visible[i];
        if (e) this.selection.add(e.path);
        this.cursor = i;
        this.anchor = i;
        this.renderSelection();
    }

    toggle(i) {
        const e = this.visible[i];
        if (!e) return;
        if (this.selection.has(e.path)) this.selection.delete(e.path);
        else this.selection.add(e.path);
        this.cursor = i;
        this.anchor = i;
        this.renderSelection();
    }

    selectRange(i) {
        const from = this.anchor >= 0 ? this.anchor : i;
        const [a, b] = from < i ? [from, i] : [i, from];
        this.selection.clear();
        for (let k = a; k <= b; k++) this.selection.add(this.visible[k].path);
        this.cursor = i;
        this.renderSelection();
    }

    selectAll() {
        this.visible.forEach(e => this.selection.add(e.path));
        this.renderSelection();
    }

    clearSelection() {
        if (!this.selection.size) return;
        this.selection.clear();
        this.renderSelection();
    }

    moveCursor(delta, { extend = false } = {}) {
        if (!this.visible.length) return;
        let step = delta;
        if (this.prefs.view === 'grid' && Math.abs(delta) === 'row') step = delta;
        const next = Math.max(0, Math.min(this.visible.length - 1, (this.cursor < 0 ? -1 : this.cursor) + step));
        if (extend) this.selectRange(next);
        else {
            this.cursor = next;
            this.renderSelection();
        }
        this.el.list.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    gridColumns() {
        const rows = [...this.el.list.querySelectorAll('.fm-row')];
        if (rows.length < 2) return 1;
        const top = rows[0].offsetTop;
        const n = rows.findIndex(r => r.offsetTop !== top);
        return n === -1 ? rows.length : n;
    }

    // ---------- toolbar & bars ----------

    bindToolbar() {
        this.el.toolbar.addEventListener('click', e => {
            const crumb = e.target.closest('.fm-crumb');
            if (crumb) {
                const c = this.crumbList[Number(crumb.dataset.i)];
                if (c) {
                    this.closeResults();
                    this.navigate(this.source, c.path);
                }
                return;
            }
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            switch (btn.dataset.act) {
                case 'side': return this.toggleSide();
                case 'back': return this.goBack();
                case 'forward': return this.goForward();
                case 'up': return this.goUp();
                case 'search': return this.openSearch();
                case 'new-folder': return this.newFolder();
                case 'upload': return this.pickUpload();
                case 'view': return this.setPref('view', this.prefs.view === 'grid' ? 'list' : 'grid');
                case 'more': return this.openFolderMenu(btn);
                default: return undefined;
            }
        });
        this.el.head.addEventListener('click', e => {
            const btn = e.target.closest('[data-sort]');
            if (!btn) return;
            const key = btn.dataset.sort;
            if (this.prefs.sort === key) this.prefs.desc = !this.prefs.desc;
            else {
                this.prefs.sort = key;
                this.prefs.desc = key !== 'name';
            }
            this.savePrefs();
            this.render();
        });

        // Search: typing filters this folder; Enter/button searches subfolders
        const { search, searchInput } = this.el;
        searchInput.addEventListener('input', () => {
            this.filter = searchInput.value;
            this.computeVisible();
            this.renderList();
            this.hooks.onInfo(this);
        });
        search.addEventListener('submit', e => {
            e.preventDefault();
            this.searchDeep(searchInput.value);
        });
        search.querySelector('[data-act="search-close"]').addEventListener('click', () => this.closeSearch());
        searchInput.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeSearch();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.el.list.focus();
                this.moveCursor(this.cursor < 0 ? 1 : 0);
            }
        });

        this.el.selbar.addEventListener('click', e => {
            const btn = e.target.closest('[data-sel]');
            if (!btn) return;
            const items = this.selectedEntries();
            switch (btn.dataset.sel) {
                case 'clear': return this.clearSelection();
                case 'all': return this.selectAll();
                case 'copy': return this.copyItems(items, 'copy');
                case 'cut': return this.copyItems(items, 'move');
                case 'download': return this.download(items);
                case 'rename': return this.rename(items[0]);
                case 'delete': return this.remove(items);
                case 'more': return this.openItemMenu(items, { anchor: btn });
                default: return undefined;
            }
        });
        this.el.pastebar.addEventListener('click', e => {
            const btn = e.target.closest('[data-paste]');
            if (!btn) return;
            if (btn.dataset.paste === 'here') this.paste();
            else shared.setClipboard(null);
        });
        this.el.fab.addEventListener('click', () => this.openNewMenu(this.el.fab));
        this.el.fileInput.addEventListener('change', () => {
            const files = [...this.el.fileInput.files];
            this.el.fileInput.value = '';
            if (files.length) this.upload(files, { source: this.source, path: this.path });
        });
        // "Enviar pasta": the browser gives every file with its path inside the folder
        this.folderInput = document.createElement('input');
        this.folderInput.type = 'file';
        this.folderInput.hidden = true;
        this.folderInput.webkitdirectory = true;
        this.folderInput.multiple = true;
        this.panel.appendChild(this.folderInput);
        this.folderInput.addEventListener('change', () => {
            const items = [...this.folderInput.files].map(file => ({
                file,
                dir: (file.webkitRelativePath || file.name).split('/').slice(0, -1),
            }));
            this.folderInput.value = '';
            if (items.length) this.uploadTree(items, { source: this.source, path: this.path });
        });

        this.el.side.addEventListener('click', e => {
            const unfav = e.target.closest('[data-unfav]');
            if (unfav) {
                const list = [...(shared.favorites || [])];
                list.splice(Number(unfav.dataset.unfav), 1);
                shared.saveFavorites(list).then(() => this.renderSide());
                return;
            }
            if (e.target.closest('[data-side="close"]')) return this.closeSideDrawer();
            const go = e.target.closest('[data-go]');
            if (go) {
                this.closeResults();
                this.navigate(go.dataset.go, go.dataset.path);
                this.closeSideDrawer();
            }
            return undefined;
        });
        this.el.scrim.addEventListener('click', () => this.closeSideDrawer());
    }

    openSearch() {
        this.el.search.hidden = false;
        this.el.searchInput.focus();
        this.el.searchInput.select();
    }

    closeSearch() {
        this.el.search.hidden = true;
        this.filter = '';
        this.el.searchInput.value = '';
        this.closeResults();
        this.render();
        this.focus();
    }

    async searchDeep(text) {
        const q = String(text || '').trim();
        if (!q) return;
        this.setLoading(true);
        try {
            const data = await request('GET', 'search', { params: { source: this.source, path: this.path, q } });
            this.results = {
                query: q,
                truncated: data.truncated,
                entries: data.results.map(r => ({ ...r, source: this.source })),
            };
            this.filter = '';
            this.el.searchInput.value = '';
            this.selection.clear();
            this.cursor = -1;
            this.el.resultsBar.hidden = false;
            this.el.resultsBar.innerHTML = `${icon('search', 15)}<span>${esc(`Resultados para "${q}" em ${this.prettyPath()}`)}</span>
                <button type="button" class="btn btn-ghost btn-sm" data-results="close">Voltar à pasta</button>`;
            this.el.resultsBar.querySelector('[data-results="close"]').addEventListener('click', () => this.closeResults(true));
        } catch (e) {
            toast(e.message, { tone: 'error' });
        } finally {
            this.setLoading(false);
            this.render();
        }
    }

    closeResults(rerender = false) {
        if (!this.results) return;
        this.results = null;
        this.el.resultsBar.hidden = true;
        this.selection.clear();
        this.cursor = -1;
        if (rerender) this.render();
    }

    // ---------- list interaction ----------

    bindList() {
        const { list } = this.el;
        let press = null;
        let lastPointer = 'mouse';
        let suppressClick = false;
        const rowIndex = target => {
            const row = target.closest?.('.fm-row');
            return row ? Number(row.dataset.i) : -1;
        };

        list.addEventListener('pointerdown', e => {
            lastPointer = e.pointerType;
            suppressClick = false;
            if (e.pointerType === 'mouse') return;
            const i = rowIndex(e.target);
            if (i < 0 || e.target.closest('.fm-more')) return;
            press = { i, x: e.clientX, y: e.clientY };
            press.timer = setTimeout(() => {
                suppressClick = true;
                try {
                    navigator.vibrate?.(15);
                } catch { /* needs a user gesture on some browsers */ }
                const entry = this.visible[i];
                if (entry && !this.selection.has(entry.path)) this.toggle(i);
                press = null;
            }, LONG_PRESS);
        });
        const cancelPress = () => {
            if (press) clearTimeout(press.timer);
            press = null;
        };
        list.addEventListener('pointermove', e => {
            if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
        });
        list.addEventListener('pointerup', cancelPress);
        list.addEventListener('pointercancel', cancelPress);

        list.addEventListener('click', e => {
            const empty = e.target.closest('[data-empty]');
            if (empty) {
                if (empty.dataset.empty === 'retry') this.refresh();
                else this.goHome();
                return;
            }
            if (suppressClick) {
                suppressClick = false;
                return;
            }
            const i = rowIndex(e.target);
            if (i < 0) {
                if (lastPointer === 'mouse' && !e.ctrlKey && !e.metaKey && !e.shiftKey) this.clearSelection();
                return;
            }
            if (e.target.closest('.fm-more')) {
                this.cursor = i;
                this.openItemMenu(this.targets(i), { anchor: e.target.closest('.fm-more') });
                return;
            }
            const touch = lastPointer !== 'mouse';
            if (touch) {
                // Selection mode: taps select; otherwise tap opens
                if (this.selection.size || e.target.closest('.fm-check')) this.toggle(i);
                else this.open(this.visible[i]);
                return;
            }
            if (e.target.closest('.fm-check')) this.toggle(i);
            else if (e.shiftKey) this.selectRange(i);
            else if (e.ctrlKey || e.metaKey) this.toggle(i);
            else this.selectOnly(i);
        });
        list.addEventListener('dblclick', e => {
            if (lastPointer !== 'mouse' || e.target.closest('.fm-more, .fm-check')) return;
            const i = rowIndex(e.target);
            if (i >= 0) this.open(this.visible[i]);
        });
        list.addEventListener('contextmenu', e => {
            e.preventDefault();
            if (lastPointer !== 'mouse') return; // long press handles touch
            const i = rowIndex(e.target);
            if (i < 0) {
                this.openFolderMenu(null, { x: e.clientX, y: e.clientY });
                return;
            }
            if (!this.selection.has(this.visible[i].path)) this.selectOnly(i);
            this.openItemMenu(this.targets(i), { x: e.clientX, y: e.clientY });
        });

        // Drag rows onto folders / breadcrumbs to move (Ctrl or Alt = copy). Mouse only.
        list.addEventListener('dragstart', e => {
            const i = rowIndex(e.target);
            if (i < 0) return;
            if (!this.selection.has(this.visible[i].path)) this.selectOnly(i);
            const items = this.selectedEntries().map(({ source, path, name, type }) => ({ source, path, name, type }));
            this.dragItems = items;
            e.dataTransfer.effectAllowed = 'copyMove';
            e.dataTransfer.setData('application/x-meuterminal-files', JSON.stringify(items));
            e.dataTransfer.setData('text/plain', items.map(it => it.path).join('\n'));
        });
        list.addEventListener('dragend', () => {
            this.dragItems = null;
            this.panel.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        });
    }

    // ---------- keyboard ----------

    bindKeyboard() {
        this.panel.addEventListener('keydown', e => {
            if (this.viewer) return this.onViewerKey(e);
            if (e.target.closest('input, textarea, dialog')) return undefined;
            const mod = e.ctrlKey || e.metaKey;
            const i = this.cursor;
            const grid = this.prefs.view === 'grid';
            const handled = () => {
                e.preventDefault();
                e.stopPropagation();
            };
            if (e.key === 'ArrowDown') {
                handled();
                return this.moveCursor(grid ? this.gridColumns() : 1, { extend: e.shiftKey });
            }
            if (e.key === 'ArrowUp' && !e.altKey) {
                handled();
                return this.moveCursor(grid ? -this.gridColumns() : -1, { extend: e.shiftKey });
            }
            if (grid && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.altKey) {
                handled();
                return this.moveCursor(e.key === 'ArrowRight' ? 1 : -1, { extend: e.shiftKey });
            }
            if (e.key === 'Home' || e.key === 'End') {
                handled();
                return this.moveCursor(e.key === 'Home' ? -Infinity : Infinity, { extend: e.shiftKey });
            }
            if (e.key === 'Enter' && i >= 0) {
                handled();
                return this.open(this.visible[i]);
            }
            if (e.key === ' ' && i >= 0) {
                handled();
                return this.toggle(i);
            }
            if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) {
                handled();
                return this.goUp();
            }
            if (e.altKey && e.key === 'ArrowLeft') {
                handled();
                return this.goBack();
            }
            if (e.altKey && e.key === 'ArrowRight') {
                handled();
                return this.goForward();
            }
            if (e.key === 'Escape') {
                if (this.selection.size) {
                    handled();
                    return this.clearSelection();
                }
                if (!this.el.search.hidden) {
                    handled();
                    return this.closeSearch();
                }
                return undefined;
            }
            if (e.key === 'Delete' && this.targets(i).length) {
                handled();
                return this.remove(this.targets(i));
            }
            if (e.key === 'F2' && i >= 0) {
                handled();
                return this.rename(this.visible[i]);
            }
            if (e.key === 'F5') {
                handled();
                return this.refresh();
            }
            if (mod && !e.altKey) {
                const k = e.key.toLowerCase();
                if (k === 'a') {
                    handled();
                    return this.selectAll();
                }
                if ((k === 'c' || k === 'x') && this.targets(i).length) {
                    handled();
                    return this.copyItems(this.targets(i), k === 'x' ? 'move' : 'copy');
                }
                if (k === 'v' && shared.clipboard) {
                    handled();
                    return this.paste();
                }
                if (k === 'n' && e.shiftKey) {
                    handled();
                    return this.newFolder();
                }
            }
            return undefined;
        });
    }

    // ---------- drop to upload / move ----------

    bindDrop() {
        const { main, drop } = this.el;
        let depth = 0;
        const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
        const internal = e => [...(e.dataTransfer?.types || [])].includes('application/x-meuterminal-files');
        const folderAt = target => {
            const row = target.closest?.('.fm-row[data-kind="dir"]');
            if (row) return this.visible[Number(row.dataset.i)];
            const crumb = target.closest?.('.fm-crumb');
            if (crumb) {
                const c = this.crumbList[Number(crumb.dataset.i)];
                return c ? { source: this.source, path: c.path, name: c.label } : null;
            }
            return null;
        };
        const mark = target => {
            this.panel.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
            target?.classList.add('drop-target');
        };

        this.panel.addEventListener('dragover', e => {
            if (!hasFiles(e) && !internal(e)) return;
            const folder = folderAt(e.target);
            const dragged = this.dragItems || [];
            const bad = internal(e) && (!folder || dragged.some(d => d.path === folder.path));
            if (bad && !hasFiles(e)) {
                mark(null);
                return;
            }
            e.preventDefault();
            e.dataTransfer.dropEffect = internal(e) ? (e.ctrlKey || e.altKey ? 'copy' : 'move') : 'copy';
            mark(folder ? e.target.closest('.fm-row, .fm-crumb') : null);
        });
        main.addEventListener('dragenter', e => {
            if (!hasFiles(e)) return;
            depth++;
            drop.hidden = false;
            drop.querySelector('span').textContent = `Solte para enviar para ${this.prettyPath()}`;
        });
        main.addEventListener('dragleave', e => {
            if (!hasFiles(e)) return;
            depth = Math.max(0, depth - 1);
            if (!depth) drop.hidden = true;
        });
        this.panel.addEventListener('drop', e => {
            depth = 0;
            drop.hidden = true;
            mark(null);
            const folder = folderAt(e.target);
            if (internal(e)) {
                e.preventDefault();
                if (!folder) return;
                let items = [];
                try {
                    items = JSON.parse(e.dataTransfer.getData('application/x-meuterminal-files'));
                } catch { /* ignore */ }
                items = items.filter(it => it.path !== folder.path);
                if (items.length) this.transfer(items, folder, e.ctrlKey || e.altKey ? 'copy' : 'move');
                return;
            }
            if (!hasFiles(e)) return;
            e.preventDefault();
            const dest = folder || { source: this.source, path: this.path };
            // Dropped folders: walk them (the entries must be taken now, during the drop event)
            const entries = [...(e.dataTransfer.items || [])]
                .filter(it => it.kind === 'file')
                .map(it => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
                .filter(Boolean);
            if (entries.some(en => en.isDirectory)) {
                this.uploadEntries(entries, dest);
                return;
            }
            const files = [...e.dataTransfer.files];
            if (files.length) this.upload(files, dest);
        });
    }

    // ---------- menus ----------

    openNewMenu(anchor) {
        showMenu([
            { label: 'Nova pasta', icon: 'folderPlus', hint: coarse() ? '' : 'Ctrl+Shift+N', run: () => this.newFolder() },
            { label: 'Novo arquivo', icon: 'filePlus', run: () => this.newFile() },
            { label: 'Enviar arquivos do aparelho', icon: 'upload', run: () => this.pickUpload() },
            { label: 'Enviar pasta do aparelho', icon: 'folderInput', run: () => this.folderInput.click() },
            ...(shared.clipboard ? ['separator', { label: shared.clipboard.op === 'move' ? 'Mover para cá' : 'Colar aqui',
                icon: 'clipboard', run: () => this.paste() }] : []),
        ], { anchor, label: 'Novo' });
    }

    openFolderMenu(anchor, pos = {}) {
        const fav = (shared.favorites || []).some(f => f.source === this.source && f.path === this.path);
        const local = this.source === 'local';
        const sortItem = (key, label) => ({ label, checked: this.prefs.sort === key, run: () => {
            this.prefs.desc = this.prefs.sort === key ? !this.prefs.desc : key !== 'name';
            this.setPref('sort', key);
        } });
        const current = { source: this.source, path: this.path, name: this.crumbList?.at(-1)?.label || this.path, type: 'dir' };
        showMenu([
            { label: 'Nova pasta', icon: 'folderPlus', run: () => this.newFolder() },
            { label: 'Novo arquivo', icon: 'filePlus', run: () => this.newFile() },
            { label: 'Enviar arquivos', icon: 'upload', run: () => this.pickUpload() },
            { label: 'Enviar pasta', icon: 'folderInput', run: () => this.folderInput.click() },
            ...(shared.clipboard ? [{ label: shared.clipboard.op === 'move' ? 'Mover para cá' : 'Colar aqui', icon: 'clipboard',
                hint: coarse() ? '' : 'Ctrl+V', run: () => this.paste() }] : []),
            'separator',
            { label: 'Selecionar tudo', icon: 'checkCheck', hint: coarse() ? '' : 'Ctrl+A', disabled: !this.visible.length, run: () => this.selectAll() },
            { label: 'Buscar', icon: 'search', hint: coarse() ? '' : 'Ctrl+F', run: () => this.openSearch() },
            { label: 'Atualizar', icon: 'refresh', hint: coarse() ? '' : 'F5', run: () => this.refresh() },
            'separator',
            { label: 'Lista', icon: 'listView', checked: this.prefs.view === 'list', run: () => this.setPref('view', 'list') },
            { label: 'Grade', icon: 'grid', checked: this.prefs.view === 'grid', run: () => this.setPref('view', 'grid') },
            sortItem('name', `Ordenar por nome${this.prefs.sort === 'name' ? (this.prefs.desc ? ' (Z–A)' : ' (A–Z)') : ''}`),
            sortItem('mtime', `Ordenar por data${this.prefs.sort === 'mtime' ? (this.prefs.desc ? ' (recentes)' : ' (antigos)') : ''}`),
            sortItem('size', `Ordenar por tamanho${this.prefs.sort === 'size' ? (this.prefs.desc ? ' (maiores)' : ' (menores)') : ''}`),
            sortItem('type', 'Ordenar por tipo'),
            { label: 'Mostrar ocultos', icon: this.prefs.hidden ? 'eye' : 'eyeOff', checked: this.prefs.hidden,
                run: () => this.setPref('hidden', !this.prefs.hidden) },
            'separator',
            { label: fav ? 'Remover dos favoritos' : 'Adicionar aos favoritos', icon: fav ? 'starOff' : 'star', run: () => this.toggleFavorite(current) },
            ...(local ? [{ label: 'Abrir terminal aqui', icon: 'terminal', run: () => this.openTerminal(this.path) }] : []),
            { label: 'Copiar caminho', icon: 'link', run: () => this.copyPath(current) },
            ...(local ? [{ label: 'Baixar pasta (.tar.gz)', icon: 'download', run: () => this.download([current]) }] : []),
            { label: 'Propriedades', icon: 'info', run: () => this.properties(current) },
        ], { anchor, x: pos.x, y: pos.y, label: 'Ações da pasta' });
    }

    openItemMenu(items, { anchor = null, x, y } = {}) {
        if (!items.length) return;
        const one = items.length === 1 ? items[0] : null;
        const kind = one ? kindOf(one) : null;
        const fav = one?.type === 'dir' && (shared.favorites || []).some(f => f.source === one.source && f.path === one.path);
        const hint = k => (coarse() ? '' : k);
        const list = one ? [
            { label: one.type === 'dir' ? 'Abrir' : 'Abrir / visualizar', icon: one.type === 'dir' ? 'folderOpen' : 'eye', hint: hint('Enter'), run: () => this.open(one) },
            ...(one.type === 'file' && !['text', 'code', 'json'].includes(kind)
                ? [{ label: 'Abrir como texto', icon: 'fileText', run: () => this.openViewer(one, { asText: true }) }] : []),
            ...(this.results ? [{ label: 'Abrir pasta do item', icon: 'folderInput', run: () => {
                const dir = one.path.slice(0, Math.max(1, one.path.length - one.name.length - 1));
                this.closeResults();
                this.navigate(one.source, dir);
            } }] : []),
            { label: one.type === 'dir' && one.source === 'local' ? 'Baixar (.tar.gz)' : 'Baixar', icon: 'download',
                disabled: one.type === 'dir' && one.source !== 'local', run: () => this.download([one]) },
            'separator',
            { label: 'Copiar', icon: 'copy', hint: hint('Ctrl+C'), run: () => this.copyItems(items, 'copy') },
            { label: 'Recortar (mover)', icon: 'scissors', hint: hint('Ctrl+X'), run: () => this.copyItems(items, 'move') },
            { label: 'Duplicar', icon: 'files', run: () => this.duplicate(one) },
            { label: 'Renomear', icon: 'edit', hint: hint('F2'), run: () => this.rename(one) },
            'separator',
            ...(one.type === 'dir' ? [{ label: fav ? 'Remover dos favoritos' : 'Adicionar aos favoritos', icon: fav ? 'starOff' : 'star',
                run: () => this.toggleFavorite(one) }] : []),
            ...(one.type === 'dir' && one.source === 'local' ? [{ label: 'Abrir terminal aqui', icon: 'terminal', run: () => this.openTerminal(one.path) }] : []),
            { label: 'Copiar caminho', icon: 'link', run: () => this.copyPath(one) },
            { label: 'Propriedades', icon: 'info', run: () => this.properties(one) },
            'separator',
            { label: 'Excluir', icon: 'trash', hint: hint('Delete'), danger: true, run: () => this.remove(items) },
        ] : [
            { label: `Baixar ${items.length} itens`, icon: 'download', run: () => this.download(items) },
            { label: 'Copiar', icon: 'copy', hint: hint('Ctrl+C'), run: () => this.copyItems(items, 'copy') },
            { label: 'Recortar (mover)', icon: 'scissors', hint: hint('Ctrl+X'), run: () => this.copyItems(items, 'move') },
            { label: 'Copiar caminhos', icon: 'link', run: () => this.copyPath(items) },
            'separator',
            { label: `Excluir ${items.length} itens`, icon: 'trash', hint: hint('Delete'), danger: true, run: () => this.remove(items) },
        ];
        showMenu(list, { anchor, x, y, label: one ? `Ações de ${one.name}` : `${items.length} itens` });
    }

    // ---------- actions ----------

    open(entry) {
        if (!entry) return;
        if (entry.type === 'dir') {
            this.closeResults();
            this.navigate(entry.source, entry.path);
        } else {
            this.openViewer(entry);
        }
    }

    rawUrl(entry, extra = {}) {
        return apiUrl('raw', { source: entry.source, path: entry.path, ...extra });
    }

    triggerDownload(url) {
        const a = document.createElement('a');
        a.href = url;
        a.download = '';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    download(items) {
        if (!items.length) return;
        const local = items[0].source === 'local';
        if (items.length === 1 && items[0].type === 'file') {
            this.triggerDownload(this.rawUrl(items[0], { download: 1 }));
            return;
        }
        if (local) {
            // Folders / several items: one .tar.gz, grouped by parent folder
            const parentOf = e => e.path.slice(0, Math.max(1, e.path.length - e.name.length - 1)) || this.sep;
            const groups = new Map();
            items.forEach(e => {
                const dir = parentOf(e);
                if (!groups.has(dir)) groups.set(dir, []);
                groups.get(dir).push(e.name);
            });
            groups.forEach((names, dir) => this.triggerDownload(apiUrl('archive', { source: 'local', path: dir, names })));
            toast(items.some(e => e.type === 'dir') || items.length > 1 ? 'Preparando o .tar.gz…' : 'Baixando…');
            return;
        }
        const files = items.filter(e => e.type === 'file');
        if (files.length < items.length) toast('Pastas do rclone não podem ser baixadas de uma vez: baixando só os arquivos.');
        files.forEach((e, i) => setTimeout(() => this.triggerDownload(this.rawUrl(e, { download: 1 })), i * 500));
    }

    copyItems(items, op) {
        if (!items.length) return;
        shared.setClipboard({ op, items: items.map(({ source, path, name, type }) => ({ source, path, name, type })) });
        this.clearSelection();
        this.renderList();
        toast(op === 'move'
            ? `${items.length === 1 ? `"${items[0].name}"` : `${items.length} itens`} para mover: abra a pasta de destino e toque em "Mover para cá".`
            : `${items.length === 1 ? `"${items[0].name}" copiado` : `${items.length} itens copiados`}: abra a pasta de destino e toque em "Colar aqui".`,
        { duration: 5000 });
    }

    async paste() {
        const clip = shared.clipboard;
        if (!clip) return;
        const ok = await this.transfer(clip.items, { source: this.source, path: this.path }, clip.op);
        if (ok && clip.op === 'move') shared.setClipboard(null);
    }

    /** Copy/move items into a folder. Returns true on success. */
    async transfer(items, dest, op) {
        const label = items.length === 1 ? `"${items[0].name}"` : `${items.length} itens`;
        const slow = items.some(i => i.source !== 'local') || dest.source !== 'local';
        const status = toastWhile(`${op === 'move' ? 'Movendo' : 'Copiando'} ${label}…`, slow ? 800 : 400);
        try {
            await request('POST', 'op', { body: { op, items, dest: { source: dest.source, path: dest.path } } });
            status.done();
            toast(`${label} ${op === 'move' ? 'movido' : 'copiado'}${items.length > 1 ? 's' : ''} para ${this.prettyPath(dest.path, dest.source)}.`);
            this.refresh();
            shared.notify();
            return true;
        } catch (e) {
            status.done();
            toast(e.message, { tone: 'error', duration: 6000 });
            this.refresh();
            return false;
        }
    }

    duplicate(entry) {
        const dir = entry.path.slice(0, Math.max(1, entry.path.length - entry.name.length - 1)) || this.sep;
        this.transfer([entry], { source: entry.source, path: dir }, 'copy');
    }

    async newFolder() {
        const name = await askText({ title: 'Nova pasta', label: 'Nome da pasta', value: 'Nova pasta', confirm: 'Criar', validate: badName });
        if (!name) return;
        try {
            await request('POST', 'op', { body: { op: 'mkdir', source: this.source, path: this.path, name } });
            await this.refresh();
            this.focusEntry(name);
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    }

    async newFile() {
        const name = await askText({ title: 'Novo arquivo', label: 'Nome do arquivo', value: 'novo.txt', confirm: 'Criar',
            selectStem: true, validate: badName });
        if (!name) return;
        try {
            await request('POST', 'op', { body: { op: 'touch', source: this.source, path: this.path, name } });
            await this.refresh();
            const entry = this.entries.find(e => e.name === name);
            if (entry) this.openViewer(entry, { asText: true });
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    }

    async rename(entry) {
        if (!entry) return;
        const name = await askText({ title: 'Renomear', label: 'Novo nome', value: entry.name, confirm: 'Renomear',
            selectStem: entry.type === 'file', validate: badName });
        if (!name || name === entry.name) return;
        try {
            await request('POST', 'op', { body: { op: 'rename', source: entry.source, path: entry.path, name } });
            if (this.results) this.closeResults();
            await this.refresh();
            this.focusEntry(name);
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    }

    async remove(items) {
        if (!items.length) return;
        const remote = items[0].source !== 'local';
        const dirs = items.filter(i => i.type === 'dir').length;
        const ok = await askConfirm({
            title: items.length === 1 ? `Excluir "${items[0].name}"?` : `Excluir ${items.length} itens?`,
            message: (dirs ? 'Pastas são apagadas com tudo o que têm dentro. ' : '')
                + (remote ? 'No Google Drive, os arquivos vão para a lixeira do Drive (outros remotes podem apagar de vez).'
                    : 'Isso não pode ser desfeito: não há lixeira no servidor.'),
            details: items.length > 1 ? items.map(i => i.name + (i.type === 'dir' ? '/' : '')) : [],
            confirm: 'Excluir',
            danger: true,
        });
        if (!ok) return;
        const status = toastWhile(`Excluindo ${items.length === 1 ? `"${items[0].name}"` : `${items.length} itens`}…`, 400);
        try {
            await request('POST', 'op', { body: { op: 'delete', source: items[0].source, paths: items.map(i => i.path) } });
            status.done();
            toast(items.length === 1 ? `"${items[0].name}" excluído.` : `${items.length} itens excluídos.`);
        } catch (e) {
            status.done();
            toast(e.message, { tone: 'error', duration: 6000 });
        }
        this.selection.clear();
        if (this.results) {
            const gone = new Set(items.map(i => i.path));
            this.results.entries = this.results.entries.filter(e => !gone.has(e.path));
        }
        this.refresh();
    }

    async toggleFavorite(entry) {
        const list = [...(await shared.loadFavorites())];
        const i = list.findIndex(f => f.source === entry.source && f.path === entry.path);
        if (i >= 0) {
            list.splice(i, 1);
            toast('Removido dos favoritos.');
        } else {
            list.push({ source: entry.source, path: entry.path, name: entry.name });
            toast(`"${entry.name}" nos favoritos.`);
        }
        await shared.saveFavorites(list);
        this.renderSide();
    }

    openTerminal(dir) {
        this.hooks.openTab?.({ cwd: dir, name: dir.split(/[\\/]/).filter(Boolean).pop() || dir });
    }

    async copyPath(target) {
        const items = Array.isArray(target) ? target : [target];
        const text = items.map(e => (e.source === 'local' ? e.path : `${e.source}:${e.path.replace(/^\//, '')}`)).join('\n');
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try {
                ok = document.execCommand('copy');
            } catch { /* not allowed */ }
            ta.remove();
        }
        toast(ok ? (items.length > 1 ? 'Caminhos copiados.' : 'Caminho copiado.') : text, { duration: ok ? 3000 : 8000 });
    }

    async properties(entry) {
        let info = entry;
        try {
            info = await request('GET', 'stat', { params: { source: entry.source, path: entry.path } });
        } catch (e) {
            toast(e.message, { tone: 'error' });
            return;
        }
        const kind = kindOf(info);
        const rows = [
            ['Nome', info.name || entry.name],
            ['Tipo', info.type === 'dir' ? 'Pasta' : (extOf(info.name || '') ? `Arquivo .${extOf(info.name)}` : 'Arquivo') + (info.mime ? ` (${info.mime})` : '')],
            ['Onde', this.prettyPath(info.path, entry.source), { mono: true }],
        ];
        if (info.type === 'dir') {
            rows.push(['Tamanho', '—', {
                action: {
                    label: 'Calcular',
                    run: async () => {
                        const r = await request('GET', 'size', { params: { source: entry.source, path: info.path } });
                        return `${formatSize(r.size)} em ${r.files} arquivo${r.files === 1 ? '' : 's'}${r.complete ? '' : ' (parcial)'}`;
                    },
                },
            }]);
        } else {
            rows.push(['Tamanho', `${formatSize(info.size)} (${(info.size || 0).toLocaleString('pt-BR')} bytes)`]);
        }
        if (info.mtime) rows.push(['Modificado', longFormat.format(new Date(info.mtime))]);
        if (info.mode) rows.push(['Permissões', info.mode, { mono: true }]);
        if (info.linkTarget) rows.push(['Aponta para', info.linkTarget, { mono: true }]);
        if (kind !== 'dir' && kind !== 'other') rows.push(['Categoria', { image: 'Imagem', video: 'Vídeo', audio: 'Áudio', pdf: 'PDF',
            archive: 'Arquivo compactado', sheet: 'Planilha', json: 'JSON', key: 'Chave/certificado', code: 'Código', text: 'Texto' }[kind]]);
        showInfo({ title: 'Propriedades', rows });
    }

    focusEntry(name) {
        const i = this.visible.findIndex(e => e.name === name);
        if (i < 0) return;
        this.selectOnly(i);
        this.el.list.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    }

    // ---------- upload ----------

    pickUpload() {
        this.el.fileInput.click();
    }

    /** Dropped files and folders (FileSystemEntry): reads the folders' contents, then uploadTree. */
    async uploadEntries(entries, dest) {
        const items = [];
        const readAll = reader => new Promise((resolve, reject) => {
            const out = [];
            // readEntries returns at most ~100 entries per call: call until it returns none
            const step = () => reader.readEntries(batch => {
                if (!batch.length) return resolve(out);
                out.push(...batch);
                step();
            }, reject);
            step();
        });
        const walk = async (entry, dir) => {
            if (entry.isFile) {
                const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                items.push({ file, dir });
            } else if (entry.isDirectory) {
                const children = await readAll(entry.createReader());
                const sub = [...dir, entry.name];
                if (!children.length) items.push({ file: null, dir: sub }); // empty folder: still created
                for (const child of children) await walk(child, sub);
            }
        };
        try {
            for (const entry of entries) await walk(entry, []);
        } catch (e) {
            toast(`Não foi possível ler a pasta: ${e.message || e}`, { tone: 'error' });
            return;
        }
        this.uploadTree(items, dest);
    }

    /**
     * Uploads files keeping their folders: [{ file, dir: ['pasta', 'sub'] }] -> creates the
     * folders under dest (existing ones are reused), then queues each file into its folder.
     */
    async uploadTree(items, dest) {
        const dirs = new Map(); // 'pasta/sub' -> ['pasta', 'sub']
        for (const { dir } of items) {
            for (let i = 1; i <= dir.length; i++) dirs.set(dir.slice(0, i).join('/'), dir.slice(0, i));
        }
        const pathOf = parts => parts.reduce((acc, name) => this.join(acc, name), dest.path);
        if (dirs.size) toast(`Criando ${dirs.size} pasta${dirs.size > 1 ? 's' : ''}…`);
        // Parents first (shorter paths first); "already exists" is fine
        for (const parts of [...dirs.values()].sort((a, b) => a.length - b.length)) {
            try {
                await request('POST', 'op', { body: { op: 'mkdir', source: dest.source, path: pathOf(parts.slice(0, -1)), name: parts[parts.length - 1] } });
            } catch { /* exists already (or the upload below will say why) */ }
        }
        const groups = new Map();
        for (const { file, dir } of items) {
            if (!file) continue;
            const key = dir.join('/');
            if (!groups.has(key)) groups.set(key, { dest: { source: dest.source, path: pathOf(dir) }, files: [] });
            groups.get(key).files.push(file);
        }
        for (const { dest: d, files } of groups.values()) this.upload(files, d);
        this.refresh(); // the new folders show up right away
    }

    upload(files, dest) {
        files.forEach(file => this.uploads.push({ file, dest, loaded: 0, status: 'queued', xhr: null }));
        this.renderUploads();
        this.pumpUploads();
    }

    pumpUploads() {
        const running = this.uploads.filter(u => u.status === 'running').length;
        const next = this.uploads.filter(u => u.status === 'queued').slice(0, Math.max(0, UPLOAD_CONCURRENCY - running));
        next.forEach(u => this.startUpload(u));
        if (!this.uploads.some(u => u.status === 'queued' || u.status === 'running') && this.uploads.length) {
            const failed = this.uploads.filter(u => u.status === 'error').length;
            const okCount = this.uploads.filter(u => u.status === 'done').length;
            if (okCount) toast(`${okCount} arquivo${okCount > 1 ? 's' : ''} enviado${okCount > 1 ? 's' : ''}.`);
            clearTimeout(this.uploadsTimer);
            this.uploadsTimer = this.later(() => {
                if (this.uploads.some(u => u.status === 'queued' || u.status === 'running')) return;
                this.uploads = this.uploads.filter(u => u.status === 'error');
                this.renderUploads();
            }, failed ? 15000 : 2500);
        }
    }

    startUpload(u) {
        u.status = 'running';
        const xhr = new XMLHttpRequest();
        u.xhr = xhr;
        xhr.open('POST', apiUrl('upload', { source: u.dest.source, path: u.dest.path, name: u.file.name }));
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = e => {
            u.loaded = e.loaded;
            this.renderUploadsSoon();
        };
        xhr.onload = () => {
            let data = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch { /* not JSON */ }
            if (xhr.status >= 200 && xhr.status < 300) {
                u.status = 'done';
                u.loaded = u.file.size;
                if (data?.name && data.name !== u.file.name) u.note = `salvo como "${data.name}"`;
            } else {
                u.status = 'error';
                u.note = data?.error || `Erro ${xhr.status}`;
            }
            this.afterUpload(u);
        };
        xhr.onerror = () => {
            u.status = 'error';
            u.note = 'Falha na conexão';
            this.afterUpload(u);
        };
        xhr.onabort = () => {
            u.status = 'error';
            u.note = 'Cancelado';
            this.afterUpload(u);
        };
        xhr.send(u.file);
        this.renderUploads();
    }

    afterUpload(u) {
        if (u.dest.source === this.source && u.dest.path === this.path) {
            clearTimeout(this.uploadRefresh);
            this.uploadRefresh = this.later(() => this.refresh(), 300);
        }
        this.renderUploads();
        this.pumpUploads();
    }

    renderUploadsSoon() {
        if (this.uploadFrame) return;
        this.uploadFrame = requestAnimationFrame(() => {
            this.uploadFrame = 0;
            this.renderUploads();
        });
    }

    renderUploads() {
        const box = this.el.uploads;
        if (!this.uploads.length) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        const active = this.uploads.filter(u => u.status === 'running' || u.status === 'queued').length;
        const total = this.uploads.reduce((s, u) => s + u.file.size, 0);
        const loaded = this.uploads.reduce((s, u) => s + Math.min(u.loaded, u.file.size), 0);
        const pct = total ? Math.round((loaded / total) * 100) : 100;
        box.innerHTML = `
            <div class="fm-up-head">
                ${icon(active ? 'loader' : 'check', 16)}
                <span>${active ? `Enviando ${this.uploads.length - active + 1} de ${this.uploads.length} · ${pct}%` : 'Envio concluído'}</span>
                <button type="button" class="icon-btn" data-up="close" aria-label="${active ? 'Cancelar envios' : 'Fechar'}">${icon('x', 15)}</button>
            </div>
            <ul class="fm-up-list">${this.uploads.map((u, i) => {
                const p = u.file.size ? Math.round((Math.min(u.loaded, u.file.size) / u.file.size) * 100) : (u.status === 'done' ? 100 : 0);
                return `<li class="fm-up ${u.status}">
                    <span class="fm-up-name">${esc(u.file.name)}</span>
                    <span class="fm-up-meta">${u.status === 'error' ? esc(u.note) : u.status === 'done' ? esc(u.note || formatSize(u.file.size))
                        : u.status === 'queued' ? 'na fila' : `${p}% de ${formatSize(u.file.size)}`}</span>
                    ${u.status === 'running' || u.status === 'queued'
                        ? `<button type="button" class="icon-btn" data-up-cancel="${i}" aria-label="Cancelar ${esc(u.file.name)}">${icon('x', 14)}</button>` : ''}
                    <span class="fm-up-bar"><span style="width:${p}%"></span></span>
                </li>`;
            }).join('')}</ul>`;
        box.querySelector('[data-up="close"]').onclick = () => {
            this.uploads.forEach(u => {
                if (u.status === 'queued') {
                    u.status = 'error';
                    u.note = 'Cancelado';
                }
                if (u.status === 'running') u.xhr?.abort();
            });
            this.uploads = [];
            this.renderUploads();
        };
        box.querySelectorAll('[data-up-cancel]').forEach(btn => {
            btn.onclick = () => {
                const u = this.uploads[Number(btn.dataset.upCancel)];
                if (!u) return;
                if (u.status === 'running') u.xhr?.abort();
                else {
                    u.status = 'error';
                    u.note = 'Cancelado';
                    this.renderUploads();
                    this.pumpUploads();
                }
            };
        });
    }

    // ---------- viewer / editor ----------

    /** Media of this folder, for previous/next in the viewer. */
    mediaSiblings(entry) {
        const kind = kindOf(entry);
        if (!MEDIA.has(kind)) return [];
        return this.visible.filter(e => e.type === 'file' && MEDIA.has(kindOf(e)));
    }

    async openViewer(entry, { asText = false } = {}) {
        if (this.viewer && !(await this.closeViewer())) return;
        const kind = asText ? 'text' : kindOf(entry);
        const v = { entry, kind, dirty: false, editor: null, wrap: prefs.get('files-wrap', true) };
        this.viewer = v;
        const el = this.el.viewer;
        el.hidden = false;
        el.setAttribute('aria-label', entry.name);
        this.el.root.classList.add('viewing');
        el.innerHTML = `
            <div class="fm-viewer-bar">
                <button type="button" class="icon-btn" data-v="close" aria-label="Fechar">${icon('chevronLeft', 20)}</button>
                <div class="fm-viewer-title"><span class="fm-viewer-name"></span><small class="fm-viewer-meta"></small></div>
                <button type="button" class="btn btn-primary btn-sm fm-save" data-v="save" hidden>${icon('save', 15)} Salvar</button>
                <button type="button" class="icon-btn" data-v="wrap" hidden aria-label="Quebrar linhas">${icon('fileText', 18)}</button>
                <button type="button" class="icon-btn" data-v="download" aria-label="Baixar">${icon('download', 18)}</button>
                <button type="button" class="icon-btn" data-v="more" aria-label="Mais ações">${icon('more', 18)}</button>
            </div>
            <div class="fm-viewer-body"></div>
            <button type="button" class="fm-nav prev" data-v="prev" aria-label="Anterior" hidden>${icon('chevronLeft', 26)}</button>
            <button type="button" class="fm-nav next" data-v="next" aria-label="Próximo" hidden>${icon('chevronRight', 26)}</button>`;
        el.querySelector('.fm-viewer-name').textContent = entry.name;
        el.querySelector('.fm-viewer-meta').textContent = [formatSize(entry.size), formatDate(entry.mtime)].filter(Boolean).join(' · ');
        el.onclick = e => {
            const btn = e.target.closest('[data-v]');
            if (!btn) return;
            const act = btn.dataset.v;
            if (act === 'close') this.closeViewer().then(ok => ok && this.focus());
            else if (act === 'save') this.saveText();
            else if (act === 'wrap') {
                v.wrap = !v.wrap;
                prefs.set('files-wrap', v.wrap);
                if (v.editor) v.editor.wrap = v.wrap ? 'soft' : 'off';
                btn.classList.toggle('on', v.wrap);
            } else if (act === 'download') this.download([entry]);
            else if (act === 'more') this.openViewerMenu(btn);
            else if (act === 'prev' || act === 'next') this.stepViewer(act === 'next' ? 1 : -1);
        };

        const body = el.querySelector('.fm-viewer-body');
        const siblings = this.mediaSiblings(entry);
        if (siblings.length > 1) el.querySelectorAll('.fm-nav').forEach(b => { b.hidden = false; });

        if (kind === 'image') {
            const img = document.createElement('img');
            img.alt = entry.name;
            img.src = this.rawUrl(entry, { render: extOf(entry.name) === 'svg' ? 1 : undefined });
            img.className = 'fm-media fit';
            img.addEventListener('click', () => img.classList.toggle('fit'));
            img.addEventListener('error', () => this.viewerMessage('Não foi possível mostrar esta imagem.'));
            body.appendChild(img);
            this.bindSwipe(body);
        } else if (kind === 'video' || kind === 'audio') {
            const media = document.createElement(kind);
            media.controls = true;
            media.preload = 'metadata';
            media.src = this.rawUrl(entry);
            media.className = 'fm-media';
            if (kind === 'video') media.playsInline = true;
            media.addEventListener('error', () => this.viewerMessage('O navegador não consegue tocar este formato. Baixe o arquivo.'));
            body.appendChild(media);
            this.bindSwipe(body);
        } else if (kind === 'pdf') {
            if (coarse()) {
                this.viewerMessage('Celulares não mostram PDF dentro da página.', [
                    { label: 'Abrir o PDF', primary: true, run: () => window.open(this.rawUrl(entry), '_blank', 'noopener') },
                ]);
            } else {
                const frame = document.createElement('iframe');
                frame.src = this.rawUrl(entry);
                frame.className = 'fm-pdf';
                frame.title = entry.name;
                body.appendChild(frame);
            }
        } else if (['text', 'code', 'json', 'other'].includes(kind)) {
            await this.loadText(entry, { forced: asText });
        } else {
            this.viewerMessage('Sem prévia para este tipo de arquivo.', [
                { label: 'Baixar', primary: true, run: () => this.download([entry]) },
                { label: 'Abrir como texto', run: () => this.openViewer(entry, { asText: true }) },
            ]);
        }
        if (!v.editor) el.querySelector('[data-v="close"]').focus({ preventScroll: true });
    }

    viewerMessage(text, buttons = []) {
        const body = this.el.viewer.querySelector('.fm-viewer-body');
        if (!body) return;
        body.innerHTML = `<div class="fm-empty">${icon(KIND_ICON[kindOf(this.viewer.entry)] || 'file', 32)}<p></p><div class="fm-empty-actions"></div></div>`;
        body.querySelector('p').textContent = text;
        const actionsEl = body.querySelector('.fm-empty-actions');
        buttons.forEach(b => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn ${b.primary ? 'btn-primary' : 'btn-ghost'}`;
            btn.textContent = b.label;
            btn.addEventListener('click', b.run);
            actionsEl.appendChild(btn);
        });
    }

    async loadText(entry, { forced = false } = {}) {
        const v = this.viewer;
        const body = this.el.viewer.querySelector('.fm-viewer-body');
        body.innerHTML = `<div class="fm-empty">${icon('loader', 26)}<p>Abrindo…</p></div>`;
        let data;
        try {
            data = await request('GET', 'text', { params: { source: entry.source, path: entry.path } });
        } catch (e) {
            if (this.viewer === v) this.viewerMessage(e.message, [{ label: 'Baixar', run: () => this.download([entry]) }]);
            return;
        }
        if (this.viewer !== v) return;
        if (data.text === null) {
            this.viewerMessage(data.reason === 'big'
                ? `Arquivo grande demais para o editor (${formatSize(data.size)}; limite 2 MB).`
                : forced ? 'Este arquivo é binário (não é texto).' : 'Sem prévia para este tipo de arquivo.', [
                { label: 'Baixar', primary: true, run: () => this.download([entry]) },
            ]);
            return;
        }
        v.mtime = data.mtime;
        const editor = document.createElement('textarea');
        editor.className = 'fm-editor mono';
        editor.spellcheck = false;
        editor.setAttribute('autocapitalize', 'off');
        editor.setAttribute('autocorrect', 'off');
        editor.setAttribute('aria-label', `Conteúdo de ${entry.name}`);
        editor.wrap = v.wrap ? 'soft' : 'off';
        editor.value = data.text;
        editor.addEventListener('input', () => this.setDirty(true));
        editor.addEventListener('keydown', e => {
            // Tab indents instead of leaving the editor
            if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                document.execCommand('insertText', false, '    ');
            }
        });
        body.innerHTML = '';
        body.appendChild(editor);
        v.editor = editor;
        const wrapBtn = this.el.viewer.querySelector('[data-v="wrap"]');
        wrapBtn.hidden = false;
        wrapBtn.classList.toggle('on', v.wrap);
        this.updateViewerMeta();
        if (!coarse()) editor.focus({ preventScroll: true });
        editor.setSelectionRange(0, 0);
        editor.scrollTop = 0;
    }

    updateViewerMeta() {
        const v = this.viewer;
        if (!v?.editor) return;
        const lines = v.editor.value.split('\n').length;
        this.el.viewer.querySelector('.fm-viewer-meta').textContent =
            `${lines} linha${lines === 1 ? '' : 's'}${v.dirty ? ' · não salvo' : ''}`;
    }

    setDirty(dirty) {
        const v = this.viewer;
        if (!v) return;
        v.dirty = dirty;
        this.el.viewer.querySelector('[data-v="save"]').hidden = !dirty;
        this.el.viewer.classList.toggle('dirty', dirty);
        this.updateViewerMeta();
    }

    async saveText({ force = false } = {}) {
        const v = this.viewer;
        if (!v?.editor) return false;
        const btn = this.el.viewer.querySelector('[data-v="save"]');
        btn.disabled = true;
        try {
            const info = await request('PUT', 'text', {
                body: { source: v.entry.source, path: v.entry.path, text: v.editor.value, expectMtime: v.mtime, force },
            });
            v.mtime = info.mtime;
            this.setDirty(false);
            toast(`"${v.entry.name}" salvo.`);
            this.refresh({ quiet: true });
            return true;
        } catch (e) {
            if (e.status === 409) {
                const overwrite = await askConfirm({
                    title: 'O arquivo mudou',
                    message: `${e.message} Salvar por cima mesmo assim?`,
                    confirm: 'Salvar por cima',
                    danger: true,
                });
                if (overwrite) return this.saveText({ force: true });
            } else {
                toast(e.message, { tone: 'error' });
            }
            return false;
        } finally {
            btn.disabled = false;
        }
    }

    openViewerMenu(anchor) {
        const v = this.viewer;
        if (!v) return;
        const e = v.entry;
        showMenu([
            ...(v.editor ? [{ label: 'Salvar', icon: 'save', hint: coarse() ? '' : 'Ctrl+S', disabled: !v.dirty, run: () => this.saveText() }] : []),
            { label: 'Abrir em nova aba do navegador', icon: 'externalLink', run: () => window.open(this.rawUrl(e), '_blank', 'noopener') },
            ...(!v.editor ? [{ label: 'Abrir como texto', icon: 'fileText', run: () => this.openViewer(e, { asText: true }) }] : []),
            { label: 'Renomear', icon: 'edit', run: async () => {
                if (await this.closeViewer()) this.rename(e);
            } },
            { label: 'Copiar caminho', icon: 'link', run: () => this.copyPath(e) },
            { label: 'Propriedades', icon: 'info', run: () => this.properties(e) },
            'separator',
            { label: 'Excluir', icon: 'trash', danger: true, run: async () => {
                if (await this.closeViewer()) this.remove([e]);
            } },
        ], { anchor, label: 'Ações do arquivo' });
    }

    stepViewer(delta) {
        const v = this.viewer;
        if (!v) return;
        const list = this.mediaSiblings(v.entry);
        const i = list.findIndex(e => e.path === v.entry.path);
        if (i < 0 || list.length < 2) return;
        this.openViewer(list[(i + delta + list.length) % list.length]);
    }

    bindSwipe(body) {
        let start = null;
        body.addEventListener('touchstart', e => {
            if (e.touches.length === 1) start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
        }, { passive: true });
        body.addEventListener('touchend', e => {
            if (!start) return;
            const t = e.changedTouches[0];
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - start.t < 600) this.stepViewer(dx < 0 ? 1 : -1);
            start = null;
        }, { passive: true });
    }

    /** Closes the viewer; asks first when there are unsaved changes. Returns false if kept open. */
    async closeViewer() {
        const v = this.viewer;
        if (!v) return true;
        if (v.dirty) {
            const discard = await askConfirm({
                title: 'Alterações não salvas',
                message: `Descartar as alterações em "${v.entry.name}"?`,
                confirm: 'Descartar',
                danger: true,
            });
            if (!discard) return false;
        }
        if (this.viewer !== v) return true;
        this.viewer = null;
        this.el.viewer.querySelectorAll('video, audio').forEach(m => m.pause());
        this.el.viewer.hidden = true;
        this.el.viewer.innerHTML = '';
        this.el.root.classList.remove('viewing');
        const i = this.visible.findIndex(e => e.path === v.entry.path);
        if (i >= 0) {
            this.cursor = i;
            this.renderSelection();
            this.el.list.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
        }
        return true;
    }

    onViewerKey(e) {
        const mod = e.ctrlKey || e.metaKey;
        if (mod && e.key.toLowerCase() === 's') {
            e.preventDefault();
            e.stopPropagation();
            this.saveText();
            return;
        }
        if (e.target.closest('textarea, input')) {
            if (e.key === 'Escape' && !this.viewer?.dirty) {
                e.preventDefault();
                this.closeViewer().then(ok => ok && this.focus());
            }
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            this.closeViewer().then(ok => ok && this.focus());
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            if (e.target.closest('video, audio')) return;
            e.preventDefault();
            this.stepViewer(e.key === 'ArrowRight' ? 1 : -1);
        }
    }

    // ---------- interface shared with terminals ----------

    /** Workspace "search" (Ctrl+F) on this tab. */
    openFind() {
        if (this.viewer?.editor) return;
        this.openSearch();
    }

    /** Dictation / clipboard paste: typed into the focused field of this tab, if any. */
    sendText(text) {
        const field = this.panel.querySelector('input:focus, textarea:focus');
        if (field) {
            field.focus();
            document.execCommand('insertText', false, text);
        } else {
            toast('Abra um arquivo de texto ou a busca para colar texto aqui.');
        }
    }

    sendInput(data) {
        if (data === '\r') {
            const field = this.panel.querySelector('input:focus, textarea:focus');
            if (field?.tagName === 'TEXTAREA') document.execCommand('insertText', false, '\n');
            else if (field) field.form?.requestSubmit();
            return;
        }
        if (/^[\x20-\x7e -￿]+$/.test(data)) this.sendText(data);
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
        shared.listeners.delete(this.onShared);
        this.uploads.forEach(u => u.xhr?.abort());
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.panel.remove();
    }
}

function badName(name) {
    if (name === '.' || name === '..') return 'Nome inválido.';
    if (/[/\\]/.test(name)) return 'O nome não pode ter / ou \\.';
    if (name.length > 255) return 'Nome muito longo.';
    return null;
}

/** Toast shown only if the operation takes longer than `delay` ms. */
function toastWhile(message, delay) {
    const timer = setTimeout(() => toast(message, { duration: 60000 }), delay);
    return { done: () => clearTimeout(timer) };
}
