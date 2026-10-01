/**
 * terminal.js
 * Workspace manager: the ordered set of tabs, backed by the server (/api/sessions).
 * Tabs, names, order and pins live in the server database, so they are the same on
 * every device; shells keep running when the page closes and only end when a tab is closed.
 */
import StorageManager from './storage.js';
import TerminalSession, { STATE } from './session.js';
import BrowserSession from './browserSession.js';
import FilesSession from './filesSession.js';
import AgentSession from './agentSession.js';
import TabBar from '../ui/tabbar.js';
import SearchBar from '../ui/search.js';
import NewSessionPage from '../ui/newSession.js';
import { showMenu } from '../ui/contextMenu.js';
import { toast } from '../ui/toast.js';
import { playChime } from '../ui/sound.js';

const RECONCILE_DELAY = 250;

function joinPath(path) {
    const basePath = window.appConfig?.basePath || '';
    const cleanPath = path.replace(/^\/+/, '');
    const cleanBase = basePath.replace(/\/+$/, '');
    return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
}

const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

/** JSON request to the sessions API. Redirects to login when the session expired. */
async function api(method, path, body) {
    const response = await fetch(joinPath(`api/${path}`), {
        method,
        credentials: 'same-origin',
        cache: 'no-store', // the tab list must always come from the server

        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (response.redirected && /\/login$/.test(new URL(response.url).pathname)) {
        window.location.href = joinPath('login');
        throw new Error('Authentication required');
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

export default class TerminalManager {
    /**
     * @param {object} deps
     * @param {boolean} deps.isMacOS
     * @param {import('./settings.js').default} deps.settings
     * @param {HTMLElement} deps.tabList - role="tablist" element
     * @param {HTMLElement} deps.workspace - element that holds the terminal panels
     * @param {object} deps.events - onActiveChange(session), onSessionChange(session),
     *   onFocusChange(focused), transformInput(data), onAction(name)
     */
    constructor({ isMacOS, settings, tabList, workspace, events }) {
        this.isMacOS = isMacOS;
        this.settings = settings;
        this.workspaceEl = workspace;
        this.events = events;
        // Only per-device UI state stays in the browser (which tab is active here)
        this.storage = new StorageManager('meuterminal-');

        this.sessions = new Map(); // id -> TerminalSession, insertion order = tab order
        this.activeId = null;
        this.recents = [];         // recently closed sessions, from the server

        this.tabBar = new TabBar(tabList, {
            onActivate: id => this.activate(id, { focus: true }),
            onClose: id => this.close(id),
            onMenu: (id, pos) => this.openTabMenu(id, pos),
            onReorder: order => this.setOrder(order),
            onRename: (id, name) => this.rename(id, name),
            onRenameDone: () => this.focusActive(),
        });
        this.search = new SearchBar(workspace, { getSession: () => this.active });
        this.newSessionPage = new NewSessionPage(workspace, {
            onCreate: opts => this.createFromPage(opts),
            onCancel: () => this.closeNewSessionPage(),
            onForget: index => this.forgetRecent(index),
        });

        this.hooks = {
            onStateChange: s => this.onSessionChanged(s),
            onInfo: s => this.onSessionChanged(s),
            onOutput: s => this.onOutput(s),
            onFocusChange: (s, focused) => this.events.onFocusChange(focused),
            onAuthRequired: () => { window.location.href = joinPath('login'); },
            onRemoved: s => this.removeLocal(s.id),
            onWorkspaceChanged: () => this.scheduleReconcile(),
            onServerMessage: m => this.onServerMessage(m),
            onTerminalMenu: (s, x, y) => this.events.onTerminalMenu?.(s, x, y),
            isAppShortcut: e => !!this.matchShortcut(e),
            openTab: opts => this.create(opts),
            // Folder for "reload on save": the terminal beside it, else the last terminal used
            suggestFolder: s => {
                const partner = this.split && (this.split.a === s.id || this.split.b === s.id)
                    ? this.sessions.get(this.split.a === s.id ? this.split.b : this.split.a) : null;
                const terminals = [...this.sessions.values()].filter(x => x.kind === 'terminal');
                const t = partner?.kind === 'terminal' ? partner
                    : terminals.find(x => x.id === this.lastTerminalId) || terminals[0];
                return t?.cwd || t?.startCwd || '~';
            },
            transformInput: data => this.events.transformInput(data),
        };

        settings.onChange(key => this.sessions.forEach(s => s.applySettings(key)));

        // Capture phase: runs before xterm sees the key, so shortcuts never reach the shell
        document.addEventListener('keydown', e => this.onKeyDown(e), true);
        this.setupSplit();
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.sessions.forEach(s => s.reconnectIfDropped());
                this.scheduleReconcile();
            }
        });

        this.restore();
    }

    get active() {
        return this.sessions.get(this.activeId) || null;
    }

    get order() {
        return Array.from(this.sessions.keys());
    }

    // ---------- lifecycle ----------

    /** Creates a tab view for a server session (no request). Idempotent. */
    addSession(row, { index, activate = false } = {}) {
        if (this.sessions.has(row.id)) return this.sessions.get(row.id);
        const Kind = row.kind === 'browser' ? BrowserSession : row.kind === 'files' ? FilesSession
            : row.kind === 'agent' ? AgentSession : TerminalSession;
        const session = new Kind({ row, settings: this.settings, hooks: this.hooks });

        const at = index ?? this.sessions.size;
        const entries = Array.from(this.sessions.entries());
        entries.splice(at, 0, [row.id, session]);
        this.sessions = new Map(entries);

        this.tabBar.add(session, at);
        session.mount(this.workspaceEl.querySelector('.terminal-panels'));
        session.shown = false;
        session.setActive(false);
        if (activate) this.activate(row.id, { focus: !isCoarse() });
        return session;
    }

    /**
     * Creates a new session on the server and opens its tab.
     * @param {{name?: string, cwd?: string, color?: string, afterId?: string, reopenId?: string}} opts
     */
    async create({ name, cwd, color, afterId, reopenId, kind, url } = {}) {
        try {
            const row = await api('POST', 'sessions', {
                name,
                cwd: kind === 'browser' ? undefined : (cwd || (kind === 'files' ? undefined : this.settings.get('defaultCwd')) || undefined),
                color,
                afterId,
                reopenId,
                kind,
                url,
            });
            const index = afterId && this.sessions.has(afterId) ? this.order.indexOf(afterId) + 1 : undefined;
            this.addSession(row, { index });
            this.normalizeOrder();
            this.activate(row.id, { focus: !isCoarse() });
            return this.sessions.get(row.id);
        } catch (e) {
            console.error('Failed to create session:', e);
            toast('Não foi possível criar a sessão.', { tone: 'error' });
            return null;
        }
    }

    activate(id, { focus = false } = {}) {
        const next = this.sessions.get(id);
        if (!next) return;
        this.closeNewSessionPage(false);
        if (this.activeId !== id) {
            this.activeId = id;
            this.tabBar.setActive(id);
            this.tabBar.update(next);
            this.search.bind(next);
            this.events.onActiveChange(next);
            this.storage.set('activeSession', id);
            if (next.kind === 'terminal') {
                this.lastTerminalId = id;
                this.reportFocus(id);
            }
        }
        this.applyVisibility();
        if (focus) next.focus();
    }

    // ---------- split view (two tabs side by side, like VS Code's Live Server setup) ----------

    /** The pair shown right now: the saved split when the active tab is part of it. */
    visiblePair() {
        const s = this.split;
        if (!s || !this.sessions.has(s.a) || !this.sessions.has(s.b)) return null;
        return s.a === this.activeId || s.b === this.activeId ? [s.a, s.b] : null;
    }

    /** Shows the active tab (or the split pair) and hides the rest. */
    applyVisibility() {
        const pair = this.visiblePair();
        const shown = new Set(pair || (this.activeId ? [this.activeId] : []));
        this.sessions.forEach((session, id) => {
            const on = shown.has(id);
            if (session.shown !== on) {
                session.shown = on;
                session.setActive(on);
            }
            const tab = this.tabBar.tabs.get(id);
            if (tab) {
                tab.classList.toggle('paired', !!pair && shown.has(id));
                tab.classList.toggle('in-view', !!pair && on && id !== this.activeId);
            }
        });
        this.layoutPanels(pair);
    }

    /** Positions the two panels and the divider (row on wide screens, stacked on phones). */
    layoutPanels(pair = this.visiblePair()) {
        const box = this.panelsEl;
        this.sessions.forEach(s => s.panel.classList.remove('pane-a', 'pane-b', 'pane-focused'));
        if (!pair) {
            box.classList.remove('split', 'row', 'col');
            this.divider.hidden = true;
            return;
        }
        const row = box.clientWidth >= 640 && box.clientWidth >= box.clientHeight * 0.9;
        let [first, second] = pair;
        // Stacked: the page/files on top, the terminal at the bottom (next to the keyboard)
        if (!row && this.sessions.get(first).kind === 'terminal' && this.sessions.get(second).kind !== 'terminal') {
            [first, second] = [second, first];
        }
        box.classList.add('split');
        box.classList.toggle('row', row);
        box.classList.toggle('col', !row);
        box.style.setProperty('--split', String(this.split.ratio || 0.5));
        this.sessions.get(first).panel.classList.add('pane-a');
        this.sessions.get(second).panel.classList.add('pane-b');
        this.sessions.get(this.activeId)?.panel.classList.add('pane-focused');
        this.divider.hidden = false;
        this.divider.setAttribute('aria-orientation', row ? 'vertical' : 'horizontal');
    }

    /** Pairs two tabs (a = usually the terminal) and shows them. */
    setSplit(a, b, { focus = a, ratio } = {}) {
        if (!this.sessions.has(a) || !this.sessions.has(b) || a === b) return;
        this.split = { a, b, ratio: ratio || this.split?.ratio || 0.5 };
        this.storage.set('split', this.split);
        // Keep the pair next to each other in the tab bar
        const ids = this.order.filter(id => id !== b);
        ids.splice(ids.indexOf(a) + 1, 0, b);
        if (ids.join() !== this.order.join()) this.setOrder(ids);
        this.activate(focus, { focus: !isCoarse() });
        this.applyVisibility();
    }

    clearSplit({ keep } = {}) {
        if (!this.split) return;
        this.split = null;
        this.storage.remove('split');
        if (keep && this.sessions.has(keep)) this.activate(keep);
        this.applyVisibility();
    }

    setupSplit() {
        this.panelsEl = this.workspaceEl.querySelector('.terminal-panels');
        const saved = this.storage.get('split');
        this.split = saved && saved.a && saved.b ? saved : null;

        const divider = document.createElement('div');
        divider.className = 'split-divider';
        divider.hidden = true;
        divider.setAttribute('role', 'separator');
        divider.setAttribute('aria-label', 'Arraste para mudar o tamanho dos painéis');
        divider.tabIndex = 0;
        divider.innerHTML = '<span class="split-grip" aria-hidden="true"></span>';
        this.panelsEl.appendChild(divider);
        this.divider = divider;

        const setRatio = ratio => {
            if (!this.split) return;
            this.split.ratio = Math.min(0.85, Math.max(0.15, ratio));
            this.panelsEl.style.setProperty('--split', String(this.split.ratio));
        };
        divider.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault();
            try {
                divider.setPointerCapture(e.pointerId);
            } catch { /* window listeners below still track the drag */ }
            this.panelsEl.classList.add('resizing');
            const box = this.panelsEl.getBoundingClientRect();
            const row = this.panelsEl.classList.contains('row');
            const move = ev => {
                if (ev.pointerId !== e.pointerId) return;
                setRatio(row ? (ev.clientX - box.left) / box.width : (ev.clientY - box.top) / box.height);
            };
            // Always ends the drag (up, cancel, lost capture, window blur): a stuck "resizing"
            // state would block every tap on the panels
            const end = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', end);
                window.removeEventListener('pointercancel', end);
                window.removeEventListener('blur', end);
                divider.removeEventListener('lostpointercapture', end);
                this.panelsEl.classList.remove('resizing');
                if (this.split) this.storage.set('split', this.split);
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', end);
            window.addEventListener('pointercancel', end);
            window.addEventListener('blur', end);
            divider.addEventListener('lostpointercapture', end);
        });
        divider.addEventListener('keydown', e => {
            const delta = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[e.key];
            if (!delta || !this.split) return;
            e.preventDefault();
            setRatio(this.split.ratio + delta);
            this.storage.set('split', this.split);
        });
        divider.addEventListener('dblclick', () => {
            setRatio(0.5);
            if (this.split) this.storage.set('split', this.split);
        });

        // Touching/clicking a pane makes it the focused one (status bar, shortcuts, search)
        this.panelsEl.addEventListener('pointerdown', e => {
            const pair = this.visiblePair();
            if (!pair) return;
            const panel = e.target.closest('.terminal-panel');
            const id = panel?.id.replace(/^panel-/, '');
            if (id && id !== this.activeId && pair.includes(id)) this.activate(id);
        }, true);

        // Rotating the phone / resizing the window switches between side by side and stacked
        new ResizeObserver(() => this.layoutPanels()).observe(this.panelsEl);
    }

    /** Menu to choose what goes beside a tab. */
    openSplitMenu(id, pos = {}) {
        const s = this.sessions.get(id);
        if (!s) return;
        const kindIcon = k => (k === 'browser' ? 'globe' : k === 'files' ? 'folder' : 'terminal');
        const others = this.order.filter(o => o !== id).map(o => this.sessions.get(o));
        const newBeside = async opts => {
            const created = await this.create({ ...opts, afterId: id });
            if (created) this.setSplit(id, created.id, { focus: s.kind === 'terminal' ? id : created.id });
        };
        showMenu([
            ...(window.appConfig?.browserAvailable ? [{ label: 'Nova aba de navegador', icon: 'globe', run: () => newBeside({ kind: 'browser' }) }] : []),
            ...(window.appConfig?.filesAvailable ? [{ label: 'Arquivos desta pasta', icon: 'folder',
                run: () => newBeside({ kind: 'files', cwd: s.kind === 'terminal' ? (s.cwd || s.startCwd || undefined) : undefined }) }] : []),
            { label: 'Novo terminal', icon: 'terminal', run: () => newBeside({}) },
            ...(others.length ? ['separator'] : []),
            ...others.map(o => ({ label: o.name, icon: kindIcon(o.kind), hint: o.displayCwd?.() || '',
                run: () => this.setSplit(id, o.id, { focus: id }) })),
        ], { ...pos, label: `Dividir tela com ${s.name}` });
    }

    /** Folder of the active tab (terminal cwd, files folder, agent folder), for new agent conversations. */
    currentFolder() {
        const s = this.active;
        if (!s) return '~';
        if (s.kind === 'files') return s.source === 'local' && s.path ? s.path : '~';
        if (s.kind === 'browser') return this.hooks.suggestFolder(s);
        return s.cwd || s.startCwd || '~';
    }

    /** "Nova conversa com agente": pick an agent; the conversation opens in the active tab's folder. */
    async openAgentMenu(anchor) {
        let info;
        try {
            const r = await fetch(joinPath('api/agents'), { credentials: 'same-origin', cache: 'no-store' });
            info = await r.json();
        } catch {
            toast('Não foi possível listar os agentes.', { tone: 'error' });
            return;
        }
        const folder = this.currentFolder();
        const agents = (info.agents || []).filter(a => !a.terminalOnly);
        showMenu(agents.length ? agents.map(a => ({
            label: a.label,
            icon: 'bot',
            hint: a.installed ? '' : 'não instalado',
            disabled: !a.installed,
            run: () => this.createAgent(a.id, folder),
        })) : [{ label: 'Nenhum agente com modo UI', icon: 'info', disabled: true }],
        { anchor, label: `Nova conversa em ${folder}` });
    }

    async createAgent(agent, cwd) {
        try {
            const r = await fetch(joinPath('api/agent-sessions'), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agent, cwd, afterId: this.activeId || undefined }),
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
            await this.reconcile();
            if (this.sessions.has(data.tab.id)) this.activate(data.tab.id, { focus: true });
        } catch (e) {
            toast(`Não foi possível abrir o agente: ${e.message}`, { tone: 'error', duration: 6000 });
        }
    }

    /** Tells the server which terminal the user works in (agents open things beside it). */
    reportFocus(id) {
        clearTimeout(this.focusTimer);
        this.focusTimer = setTimeout(() => {
            fetch(joinPath('api/focus'), {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            }).catch(() => {});
        }, 300);
    }

    /** Removes a tab view locally (the server already dropped or will drop it). */
    removeLocal(id) {
        const session = this.sessions.get(id);
        if (!session) return;
        // Browser behaviour: focus the tab to the right, else the one to the left
        const ids = this.order;
        const i = ids.indexOf(id);
        const neighbor = ids[i + 1] ?? ids[i - 1];

        session.dispose();
        this.tabBar.remove(id);
        this.sessions.delete(id);
        if (this.split && (this.split.a === id || this.split.b === id)) {
            this.split = null;
            this.storage.remove('split');
        }

        if (this.activeId === id) {
            this.activeId = null;
            if (neighbor !== undefined) this.activate(neighbor, { focus: !isCoarse() });
        }
        if (this.sessions.size === 0) this.create();
    }

    /** Closing a tab is what ends its shell on the server. */
    async close(id, { silent = false } = {}) {
        const session = this.sessions.get(id);
        if (!session) return;
        const name = session.name;
        this.removeLocal(id);
        try {
            await api('DELETE', `sessions/${encodeURIComponent(id)}`);
        } catch (e) {
            console.error('Failed to close session:', e);
            toast('Não foi possível encerrar a sessão no servidor.', { tone: 'error' });
            this.scheduleReconcile();
            return;
        }
        if (!silent) {
            toast(`"${name}" fechada`, {
                action: { label: 'Reabrir', run: () => this.create({ reopenId: id }) },
            });
        }
    }

    closeOthers(id) {
        // Like browsers, pinned sessions survive "close others"
        this.order.filter(other => other !== id && !this.sessions.get(other).pinned)
            .forEach(other => this.close(other, { silent: true }));
    }

    closeToTheRight(id) {
        const ids = this.order;
        ids.slice(ids.indexOf(id) + 1).filter(other => !this.sessions.get(other).pinned)
            .forEach(other => this.close(other, { silent: true }));
    }

    duplicate(id) {
        const s = this.sessions.get(id);
        if (!s) return;
        if (s.kind === 'browser') {
            this.create({ kind: 'browser', name: s.name, url: s.url, afterId: id });
            return;
        }
        if (s.kind === 'files') {
            this.create({ kind: 'files', name: s.name, url: s.source, cwd: s.path, afterId: id });
            return;
        }
        // An agent conversation cannot be cloned: open a terminal in its folder instead
        if (s.kind === 'agent') {
            this.create({ cwd: s.cwd || undefined, afterId: id });
            return;
        }
        // A duplicate is a new shell in the same directory - processes can't be cloned
        this.create({ name: s.name, cwd: s.cwd || s.startCwd, afterId: id });
    }

    rename(id, name) {
        const s = this.sessions.get(id);
        if (!s) return;
        s.applyRow({ name, pinned: s.pinned, color: s.color });
        this.onSessionChanged(s);
        this.patch(id, { name });
    }

    togglePin(id) {
        const s = this.sessions.get(id);
        if (!s) return;
        s.pinned = !s.pinned;
        this.tabBar.update(s);
        this.patch(id, { pinned: s.pinned });
        this.normalizeOrder();
        this.saveOrder();
    }

    patch(id, fields) {
        api('PATCH', `sessions/${encodeURIComponent(id)}`, fields).catch(e => {
            console.error('Failed to update session:', e);
            toast('Não foi possível salvar a alteração.', { tone: 'error' });
            this.scheduleReconcile();
        });
    }

    move(id, delta) {
        const ids = this.order;
        const i = ids.indexOf(id);
        const j = i + delta;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        this.setOrder(ids);
    }

    /** Applies a new tab order (from drag and drop or menu) and saves it. */
    setOrder(ids) {
        this.sessions = new Map(ids.filter(id => this.sessions.has(id)).map(id => [id, this.sessions.get(id)]));
        this.normalizeOrder();
        this.saveOrder();
    }

    saveOrder() {
        api('PUT', 'sessions/order', { ids: this.order }).catch(e => {
            console.error('Failed to save tab order:', e);
            this.scheduleReconcile();
        });
    }

    /** Pinned sessions always stay on the left, like pinned browser tabs. */
    normalizeOrder() {
        const ids = this.order;
        const sorted = [...ids.filter(id => this.sessions.get(id).pinned),
            ...ids.filter(id => !this.sessions.get(id).pinned)];
        this.sessions = new Map(sorted.map(id => [id, this.sessions.get(id)]));
        this.tabBar.reorder(sorted);
    }

    cycle(delta) {
        const ids = this.order;
        if (ids.length < 2) return;
        const i = ids.indexOf(this.activeId);
        this.activate(ids[(i + delta + ids.length) % ids.length], { focus: true });
    }

    selectIndex(n) {
        const ids = this.order;
        // Like browsers: 9 always means "last tab"
        const id = n === 9 ? ids[ids.length - 1] : ids[n - 1];
        if (id !== undefined) this.activate(id, { focus: true });
    }

    focusActive() {
        if (!isCoarse()) this.active?.focus();
    }

    // ---------- new session page & recents ----------

    async openNewSessionPage() {
        const open = () => this.newSessionPage.open({
            defaultName: 'Automático (Term N)',
            defaultCwd: this.settings.get('defaultCwd'),
            recents: this.recents,
        });
        open();
        this.workspaceEl.classList.add('showing-new-session');
        // Refresh "recent" from the server (may include tabs closed on other devices)
        try {
            this.recents = (await api('GET', 'sessions')).recent || [];
            if (this.newSessionPage.isOpen) this.newSessionPage.renderRecents(this.recents);
        } catch { /* keep what we have */ }
    }

    closeNewSessionPage(refocus = true) {
        if (!this.newSessionPage.isOpen) return;
        this.newSessionPage.close();
        this.workspaceEl.classList.remove('showing-new-session');
        if (refocus) this.focusActive();
    }

    createFromPage({ name, cwd, fromRecent, kind, url }) {
        const recent = fromRecent !== undefined ? this.recents[fromRecent] : null;
        this.closeNewSessionPage(false);
        if (recent) this.create({ reopenId: recent.id });
        else if (kind === 'browser') this.create({ kind, name, url });
        else if (kind === 'files') this.create({ kind, name, cwd: cwd || undefined });
        else this.create({ name, cwd });
    }

    /** New browser tab (optionally already at a URL, e.g. "localhost:5173"). */
    createBrowser(url) {
        if (!window.appConfig?.browserAvailable) {
            toast('Abas de navegador precisam do Chromium instalado no servidor.', { tone: 'error' });
            return;
        }
        this.create({ kind: 'browser', url });
    }

    /** New file manager tab (optionally at a folder of the server). */
    createFiles(cwd) {
        if (!window.appConfig?.filesAvailable) {
            toast('O gerenciador de arquivos está desligado neste servidor.', { tone: 'error' });
            return;
        }
        this.create({ kind: 'files', cwd });
    }

    async forgetRecent(index) {
        const recent = this.recents[index];
        if (!recent) return;
        this.recents.splice(index, 1);
        if (this.newSessionPage.isOpen) this.newSessionPage.renderRecents(this.recents);
        try {
            await api('DELETE', `recent/${encodeURIComponent(recent.id)}`);
        } catch (e) {
            console.error('Failed to forget recent session:', e);
        }
    }

    async restoreLastClosed() {
        try {
            this.recents = (await api('GET', 'sessions')).recent || [];
        } catch { /* use cached list */ }
        const last = this.recents[0];
        if (!last) {
            toast('Nenhuma sessão fechada recentemente');
            return;
        }
        this.create({ reopenId: last.id });
    }

    // ---------- menus ----------

    openTabMenu(id, { x, y, anchor }) {
        const s = this.sessions.get(id);
        if (!s) return;
        const ids = this.order;
        const i = ids.indexOf(id);
        const hasRight = ids.slice(i + 1).some(o => !this.sessions.get(o).pinned);
        const hasOthers = ids.some(o => o !== id && !this.sessions.get(o).pinned);
        const k = this.shortcutLabels();
        showMenu([
            { label: 'Nova sessão', icon: 'plus', hint: k.newTab, run: () => this.create() },
            { label: 'Nova aba de navegador', icon: 'globe', hint: `${k.mod}+B`, run: () => this.createBrowser() },
            { label: 'Novo gerenciador de arquivos', icon: 'folder', hint: `${k.mod}+E`, run: () => this.createFiles() },
            ...(s.kind === 'terminal' ? [{ label: 'Abrir pasta atual nos Arquivos', icon: 'folderOpen',
                run: () => this.createFiles(s.cwd || s.startCwd || undefined) }] : []),
            ...(this.split && (this.split.a === id || this.split.b === id)
                ? [{ label: 'Desfazer divisão', icon: 'panelLeft', run: () => this.clearSplit({ keep: id }) }]
                : [{ label: 'Dividir tela com…', icon: 'panelLeft', run: () => this.openSplitMenu(id, { x, y, anchor }) }]),
            { label: 'Duplicar', icon: 'copy', run: () => this.duplicate(id) },
            { label: 'Renomear', icon: 'edit', hint: k.rename, run: () => this.tabBar.startRename(id) },
            { label: s.pinned ? 'Desafixar' : 'Fixar', icon: 'pin', run: () => this.togglePin(id) },
            'separator',
            { label: 'Mover para a esquerda', icon: 'chevronLeft', disabled: i === 0, run: () => this.move(id, -1) },
            { label: 'Mover para a direita', icon: 'chevronRight', disabled: i === ids.length - 1,
                run: () => this.move(id, 1) },
            'separator',
            { label: 'Fechar (encerra o processo)', icon: 'x', hint: k.close, run: () => this.close(id) },
            { label: 'Fechar outras', icon: 'closeOthers', disabled: !hasOthers, run: () => this.closeOthers(id) },
            { label: 'Fechar à direita', icon: 'arrowRightBar', disabled: !hasRight,
                run: () => this.closeToTheRight(id) },
        ], { x, y, label: `Ações de ${s.name}`, restoreFocus: anchor });
    }

    /** Session switcher (mobile status bar button). */
    openSessionList(anchor) {
        showMenu(this.order.map(id => {
            const s = this.sessions.get(id);
            return {
                label: s.name,
                icon: s.pinned ? 'pin' : s.kind === 'browser' ? 'globe' : s.kind === 'files' ? 'folder' : s.kind === 'agent' ? 'bot' : 'terminal',
                hint: s.displayCwd(),
                checked: id === this.activeId,
                run: () => this.activate(id),
            };
        }).concat(['separator', { label: 'Nova sessão', icon: 'plus', run: () => this.openNewSessionPage() }]),
        { anchor, label: 'Sessões' });
    }

    // ---------- events from sessions ----------

    onSessionChanged(session) {
        this.tabBar.update(session);
        if (session.id === this.activeId) this.events.onSessionChange(session);
    }

    onOutput(session) {
        if (session.id !== this.activeId && !session.hasActivity) {
            session.hasActivity = true;
            this.tabBar.update(session);
        }
    }

    // ---------- keyboard shortcuts ----------

    /**
     * Maps a key event to an action name. App shortcuts use Ctrl+Alt (Ctrl+Cmd on Mac)
     * so they don't collide with the shell (Ctrl+W, Ctrl+R, Ctrl+T are readline keys)
     * nor with the browser's own tab shortcuts.
     */
    matchShortcut(e) {
        if (e.type !== 'keydown') return null;
        // AltGr is reported as Ctrl+Alt on Windows - never treat it as a shortcut
        if (e.getModifierState?.('AltGraph')) return null;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const mod = this.isMacOS ? e.metaKey && e.ctrlKey : e.ctrlKey && e.altKey && !e.metaKey;
        // Physical digit key (e.key changes with modifiers/layouts)
        const digit = /^Digit([1-9])$/.exec(e.code || '')?.[1];

        if (mod) {
            if (key === 't' && e.shiftKey) return 'reopen';
            if (key === 't') return 'new';
            if (key === 'b') return 'newBrowser';
            if (key === 'e') return 'newFiles';
            if (key === 'n') return 'newPage';
            if (key === 'w') return 'close';
            if (key === 'r') return 'rename';
            if (key === 'f') return 'fullscreen';
            if (key === '.' || key === '>') return 'next';
            if (key === ',' || key === '<') return 'prev';
            if (digit) return `select${digit}`;
        }
        const ctrlOnly = (this.isMacOS ? e.metaKey : e.ctrlKey) && !e.altKey;
        // Ctrl/⌘+1..9: only reaches the page in installed-app windows (browsers keep it)
        if (ctrlOnly && !e.shiftKey && digit) return `select${digit}`;
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'Tab') return e.shiftKey ? 'prev' : 'next';
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'PageDown') return 'next';
        if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === 'PageUp') return 'prev';
        if (ctrlOnly && !e.shiftKey && key === 'f') return 'search';
        if (ctrlOnly && !e.shiftKey && key === ',') return 'settings';
        return null;
    }

    onKeyDown(e) {
        // Don't steal keys from text fields in dialogs / the new session page / rename
        const inField = e.target.closest?.('input, select, textarea:not(.xterm-helper-textarea), dialog');
        if (inField && e.key !== 'Tab') return;
        const action = this.matchShortcut(e);
        if (!action) return;
        e.preventDefault();
        e.stopPropagation();
        this.run(action);
    }

    run(action) {
        if (action.startsWith('select')) return this.selectIndex(Number(action.slice(6)));
        switch (action) {
            case 'new': return this.create();
            case 'newBrowser': return this.createBrowser();
            case 'newFiles': return this.createFiles();
            case 'newPage': return this.openNewSessionPage();
            case 'reopen': return this.restoreLastClosed();
            case 'close': return this.activeId !== null && this.close(this.activeId);
            case 'rename': return this.activeId !== null && this.tabBar.startRename(this.activeId);
            case 'next': return this.cycle(1);
            case 'prev': return this.cycle(-1);
            case 'search':
                // Browser tabs are images of a page: there's no text here to search
                if (this.active?.kind === 'browser') return this.active.focus();
                if (this.active?.kind === 'files') return this.active.openFind();
                return this.search.open();
            default: return this.events.onAction(action); // fullscreen, settings: handled by the shell
        }
    }

    shortcutLabels() {
        const m = this.isMacOS ? 'Ctrl+⌘' : 'Ctrl+Alt';
        return {
            mod: m,
            newTab: `${m}+T`,
            close: `${m}+W`,
            rename: `${m}+R`,
        };
    }

    shortcutList() {
        const m = this.isMacOS ? 'Ctrl+⌘' : 'Ctrl+Alt';
        const c = this.isMacOS ? '⌘' : 'Ctrl';
        return [
            { keys: `${m}+T`, label: 'Nova sessão' },
            { keys: `${m}+B`, label: 'Nova aba de navegador' },
            { keys: `${m}+E`, label: 'Novo gerenciador de arquivos' },
            { keys: `${m}+N`, label: 'Nova sessão com opções' },
            { keys: `${m}+Shift+T`, label: 'Reabrir sessão fechada' },
            { keys: `${m}+W`, label: 'Fechar sessão (encerra o processo)' },
            { keys: `${m}+R / F2`, label: 'Renomear sessão' },
            { keys: `Ctrl+Tab / ${m}+.`, label: 'Próxima sessão' },
            { keys: `Ctrl+Shift+Tab / ${m}+,`, label: 'Sessão anterior' },
            { keys: `${m}+1…9 / ${c}+1…9`, label: 'Ir para a sessão (9 = última)' },
            { keys: `${c}+F`, label: 'Buscar no terminal' },
            { keys: `${m}+F`, label: 'Tela cheia' },
            { keys: `${c}+,`, label: 'Configurações' },
        ];
    }

    // ---------- messages from agents (MCP) ----------

    /**
     * "open-tab" (open_url) and "notify" arrive once per open tab socket: the nonce
     * makes each one run a single time per window.
     */
    async onServerMessage(m) {
        this.seenNonces = this.seenNonces || new Set();
        if (m.nonce) {
            if (this.seenNonces.has(m.nonce)) return;
            this.seenNonces.add(m.nonce);
            if (this.seenNonces.size > 200) this.seenNonces = new Set([...this.seenNonces].slice(-100));
        }
        if (m.type === 'notify') {
            const title = m.title && m.title !== 'MeuTerminal' ? `${m.title}: ` : '';
            toast(title + m.message, { duration: 8000 });
            if (m.sound !== false) playChime();
        } else if (m.type === 'open-tab') {
            await this.reconcile(); // make sure the new tab exists here
            if (this.sessions.has(m.id)) this.activate(m.id, { focus: !isCoarse() });
        } else if (m.type === 'split') {
            await this.reconcile();
            if (m.b) this.setSplit(m.a, m.b, { focus: m.focus || m.a });
            else this.clearSplit({ keep: m.a });
        } else if (m.type === 'vibe-form' || m.type === 'vibe-form-close') {
            this.events.onVibeForm?.(m);
        } else if (m.type === 'agent-launch' || m.type === 'agent-launch-close') {
            this.events.onAgentLaunch?.(m);
        }
    }

    // ---------- sync with the server ----------

    scheduleReconcile() {
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = setTimeout(() => this.reconcile(), RECONCILE_DELAY);
    }

    /**
     * Brings local tabs in line with the server: tabs opened/closed/renamed/reordered
     * on another device or browser tab show up here too.
     */
    async reconcile() {
        let data;
        try {
            data = await api('GET', 'sessions');
        } catch (e) {
            console.warn('Could not refresh sessions:', e);
            return;
        }
        this.recents = data.recent || [];
        const rows = data.sessions || [];
        const ids = new Set(rows.map(r => r.id));

        this.order.filter(id => !ids.has(id)).forEach(id => this.removeLocal(id));
        rows.forEach(row => {
            const existing = this.sessions.get(row.id);
            if (existing) {
                existing.applyRow(row);
                this.onSessionChanged(existing);
            } else {
                this.addSession(row);
            }
        });
        // Server order is the source of truth
        this.sessions = new Map(rows.filter(r => this.sessions.has(r.id)).map(r => [r.id, this.sessions.get(r.id)]));
        this.normalizeOrder();
        if (this.activeId === null && this.sessions.size) this.activate(this.order[0]);
    }

    /** Loads the tabs from the server (first run: migrates tabs saved by older versions). */
    async restore() {
        let data;
        try {
            data = await api('GET', 'sessions');
        } catch (e) {
            console.error('Failed to load sessions:', e);
            toast('Não foi possível carregar as sessões.', {
                tone: 'error',
                duration: 10000,
                action: { label: 'Tentar de novo', run: () => this.restore() },
            });
            return;
        }
        this.recents = data.recent || [];
        let rows = data.sessions || [];

        // Older versions kept tabs in localStorage: carry names/dirs over once
        const legacy = this.storage.get('workspace')?.workspaces?.[0]?.sessions
            || this.storage.get('sessionState')?.terminals || [];
        if (!rows.length && legacy.length) {
            for (const tab of legacy) {
                try {
                    rows.push(await api('POST', 'sessions', { name: tab.name, cwd: tab.cwd || undefined }));
                } catch { /* skip */ }
            }
        }
        ['workspace', 'sessionState', 'recent'].forEach(key => this.storage.remove(key));

        if (!rows.length) {
            await this.create();
            return;
        }
        rows.forEach(row => this.addSession(row));
        this.normalizeOrder();
        const saved = this.storage.get('activeSession');
        this.activate(this.sessions.has(saved) ? saved : this.order[0], { focus: !isCoarse() });
    }
}

export { STATE };
