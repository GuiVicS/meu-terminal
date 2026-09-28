/**
 * terminal.js
 * Workspace manager: the ordered set of terminal sessions ("tabs"), their persistence,
 * recently closed sessions and the tab-level keyboard shortcuts.
 * The data model is one workspace for now, shaped so more workspaces can be added later.
 */
import StorageManager from './storage.js';
import TerminalSession, { STATE, SESSION_COLORS } from './session.js';
import TabBar from '../ui/tabbar.js';
import SearchBar from '../ui/search.js';
import NewSessionPage from '../ui/newSession.js';
import { showMenu } from '../ui/contextMenu.js';
import { toast } from '../ui/toast.js';

const MAX_RECENTS = 8;
const SAVE_DELAY = 800;

function joinPath(path) {
    const basePath = window.appConfig?.basePath || '';
    const cleanPath = path.replace(/^\/+/, '');
    const cleanBase = basePath.replace(/\/+$/, '');
    return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
}

const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

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
        this.storage = new StorageManager('dumbterm-');

        this.sessions = new Map(); // id -> TerminalSession, insertion order = tab order
        this.activeId = null;
        this.counter = 1;
        this.colorIndex = 0;
        this.recents = this.storage.get('recent', []);

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
            isAppShortcut: e => !!this.matchShortcut(e),
            transformInput: data => this.events.transformInput(data),
        };

        settings.onChange(key => this.sessions.forEach(s => s.applySettings(key)));

        // Capture phase: runs before xterm sees the key, so shortcuts never reach the shell
        document.addEventListener('keydown', e => this.onKeyDown(e), true);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.sessions.forEach(s => s.reconnectIfDropped());
            } else {
                this.saveNow(); // mobile browsers may kill a hidden page without unload
            }
        });
        window.addEventListener('pagehide', () => this.saveNow());

        this.restore();
    }

    get active() {
        return this.sessions.get(this.activeId) || null;
    }

    get order() {
        return Array.from(this.sessions.keys());
    }

    // ---------- lifecycle ----------

    /**
     * Creates a session and its tab.
     * @returns {TerminalSession}
     */
    create({ name, cwd = '', pinned = false, color, content = '', id, index, activate = true } = {}) {
        const sessionId = id ?? this.counter;
        this.counter = Math.max(this.counter, sessionId + 1);
        const session = new TerminalSession({
            id: sessionId,
            name: name || `Term ${sessionId}`,
            pinned,
            color: color || SESSION_COLORS[this.colorIndex++ % SESSION_COLORS.length],
            cwd: cwd || this.settings.get('defaultCwd'),
            content,
            settings: this.settings,
            hooks: this.hooks,
        });

        // Insert into the ordered map at the requested position
        const ids = this.order;
        const at = index ?? ids.length;
        const entries = Array.from(this.sessions.entries());
        entries.splice(at, 0, [sessionId, session]);
        this.sessions = new Map(entries);

        this.tabBar.add(session, at);
        session.mount(this.workspaceEl.querySelector('.terminal-panels'));
        session.setActive(false);
        this.normalizeOrder();
        if (activate) this.activate(sessionId, { focus: !isCoarse() });
        this.scheduleSave();
        return session;
    }

    activate(id, { focus = false } = {}) {
        const next = this.sessions.get(id);
        if (!next) return;
        this.closeNewSessionPage(false);
        if (this.activeId !== id) {
            this.active?.setActive(false);
            this.activeId = id;
            next.setActive(true);
            this.tabBar.setActive(id);
            this.tabBar.update(next);
            this.search.bind(next);
            this.events.onActiveChange(next);
            this.scheduleSave();
        }
        if (focus) next.focus();
    }

    close(id, { record = true, silent = false } = {}) {
        const session = this.sessions.get(id);
        if (!session) return;
        if (record) this.remember(session);

        // Browser behaviour: focus the tab to the right, else the one to the left
        const ids = this.order;
        const i = ids.indexOf(id);
        const neighbor = ids[i + 1] ?? ids[i - 1];

        session.dispose();
        this.tabBar.remove(id);
        this.sessions.delete(id);

        if (this.sessions.size === 0) {
            this.activeId = null;
            this.create();
        } else if (this.activeId === id) {
            this.activeId = null;
            this.activate(neighbor, { focus: !isCoarse() });
        }
        this.scheduleSave();

        if (record && !silent) {
            toast(`"${session.name}" fechada`, {
                action: { label: 'Reabrir', run: () => this.restoreLastClosed() },
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
        // A duplicate is a new shell in the same directory - processes can't be cloned
        this.create({
            name: s.name,
            cwd: s.cwd || s.startCwd,
            index: this.order.indexOf(id) + 1,
        });
    }

    rename(id, name) {
        const s = this.sessions.get(id);
        if (!s) return;
        s.name = name;
        s.terminal?.textarea?.setAttribute('aria-label', `Terminal: ${name}`);
        this.onSessionChanged(s);
        this.scheduleSave();
    }

    togglePin(id) {
        const s = this.sessions.get(id);
        if (!s) return;
        s.pinned = !s.pinned;
        this.tabBar.update(s);
        this.normalizeOrder();
        this.scheduleSave();
    }

    move(id, delta) {
        const ids = this.order;
        const i = ids.indexOf(id);
        const j = i + delta;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        this.setOrder(ids);
    }

    /** Applies a new tab order (from drag and drop or menu). */
    setOrder(ids) {
        this.sessions = new Map(ids.filter(id => this.sessions.has(id)).map(id => [id, this.sessions.get(id)]));
        this.normalizeOrder();
        this.scheduleSave();
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

    openNewSessionPage() {
        this.newSessionPage.open({
            defaultName: `Term ${this.counter}`,
            defaultCwd: this.settings.get('defaultCwd'),
            recents: this.recents,
        });
        this.workspaceEl.classList.add('showing-new-session');
    }

    closeNewSessionPage(refocus = true) {
        if (!this.newSessionPage.isOpen) return;
        this.newSessionPage.close();
        this.workspaceEl.classList.remove('showing-new-session');
        if (refocus) this.focusActive();
    }

    createFromPage({ name, cwd, fromRecent }) {
        const recent = fromRecent !== undefined ? this.recents[fromRecent] : null;
        if (recent) this.forgetRecent(fromRecent, false);
        this.closeNewSessionPage(false);
        this.create({ name, cwd, color: recent?.color });
    }

    remember(session) {
        this.recents.unshift({
            name: session.name,
            cwd: session.displayCwd() || '',
            rawCwd: session.cwd || session.startCwd || '',
            color: session.color,
            closedAt: Date.now(),
        });
        this.recents = this.recents.slice(0, MAX_RECENTS);
        this.storage.set('recent', this.recents);
    }

    forgetRecent(index, rerender = true) {
        this.recents.splice(index, 1);
        this.storage.set('recent', this.recents);
        if (rerender && this.newSessionPage.isOpen) this.newSessionPage.renderRecents(this.recents);
    }

    restoreLastClosed() {
        const last = this.recents.shift();
        if (!last) {
            toast('Nenhuma sessão fechada recentemente');
            return;
        }
        this.storage.set('recent', this.recents);
        this.create({ name: last.name, cwd: last.rawCwd || last.cwd, color: last.color });
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
            { label: 'Duplicar sessão', icon: 'copy', run: () => this.duplicate(id) },
            { label: 'Renomear', icon: 'edit', hint: k.rename, run: () => this.tabBar.startRename(id) },
            { label: s.pinned ? 'Desafixar' : 'Fixar', icon: 'pin', run: () => this.togglePin(id) },
            'separator',
            { label: 'Mover para a esquerda', icon: 'chevronLeft', disabled: i === 0, run: () => this.move(id, -1) },
            { label: 'Mover para a direita', icon: 'chevronRight', disabled: i === ids.length - 1,
                run: () => this.move(id, 1) },
            'separator',
            { label: 'Fechar', icon: 'x', hint: k.close, run: () => this.close(id) },
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
                icon: s.pinned ? 'pin' : 'terminal',
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
        session.dirty = true;
        if (session.id !== this.activeId && !session.hasActivity) {
            session.hasActivity = true;
            this.tabBar.update(session);
        }
        this.scheduleSave(1500);
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
            case 'newPage': return this.openNewSessionPage();
            case 'reopen': return this.restoreLastClosed();
            case 'close': return this.activeId !== null && this.close(this.activeId);
            case 'rename': return this.activeId !== null && this.tabBar.startRename(this.activeId);
            case 'next': return this.cycle(1);
            case 'prev': return this.cycle(-1);
            case 'search': return this.search.open();
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
            { keys: `${m}+N`, label: 'Nova sessão com opções' },
            { keys: `${m}+Shift+T`, label: 'Reabrir sessão fechada' },
            { keys: `${m}+W`, label: 'Fechar sessão' },
            { keys: `${m}+R / F2`, label: 'Renomear sessão' },
            { keys: `Ctrl+Tab / ${m}+.`, label: 'Próxima sessão' },
            { keys: `Ctrl+Shift+Tab / ${m}+,`, label: 'Sessão anterior' },
            { keys: `${m}+1…9 / ${c}+1…9`, label: 'Ir para a sessão (9 = última)' },
            { keys: `${c}+F`, label: 'Buscar no terminal' },
            { keys: `${m}+F`, label: 'Tela cheia' },
            { keys: `${c}+,`, label: 'Configurações' },
        ];
    }

    // ---------- persistence ----------

    scheduleSave(delay = SAVE_DELAY) {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveNow(), delay);
    }

    /**
     * Persists UI state (tabs, order, names, pins, colors, active tab) plus the last
     * output of each tab. Only tabs with new output are re-serialized.
     */
    saveNow() {
        clearTimeout(this.saveTimer);
        const sessions = this.order.map(id => {
            const s = this.sessions.get(id);
            let content = s.lastContent;
            if (s.dirty) {
                content = s.serialize();
                s.dirty = false;
            }
            return {
                id,
                name: s.name,
                pinned: s.pinned,
                color: s.color,
                cwd: s.cwd || s.startCwd || '',
                content: this.settings.get('restoreContent') ? content : '',
            };
        });
        const ok = this.storage.set('workspace', {
            version: 2,
            workspaces: [{ id: 'default', name: 'Padrão', activeId: this.activeId, sessions }],
            currentWorkspace: 'default',
            counter: this.counter,
            colorIndex: this.colorIndex,
        });
        if (!ok && !this.warnedQuota) {
            this.warnedQuota = true;
            toast('Não foi possível salvar o estado das abas (armazenamento cheio).', { tone: 'error' });
        }
    }

    /** Loads the saved workspace, migrating the pre-2.0 format if needed. */
    restore() {
        let data = this.storage.get('workspace');
        if (!data) {
            const legacy = this.storage.get('sessionState');
            if (legacy?.terminals?.length) {
                data = {
                    workspaces: [{
                        id: 'default',
                        activeId: legacy.activeTabId,
                        sessions: legacy.terminals
                            .sort((a, b) => (a.order || 0) - (b.order || 0))
                            .map(t => ({ id: t.id, name: t.name, content: t.content || '' })),
                    }],
                };
                this.storage.remove('sessionState');
            }
        }

        const ws = data?.workspaces?.find(w => w.id === (data.currentWorkspace || 'default'))
            || data?.workspaces?.[0];
        if (!ws || !ws.sessions?.length) {
            this.create();
            return;
        }

        this.colorIndex = data.colorIndex || 0;
        ws.sessions.forEach(s => this.create({
            id: s.id,
            name: s.name,
            pinned: !!s.pinned,
            color: s.color,
            cwd: s.cwd,
            content: this.settings.get('restoreContent') ? (s.content || '') : '',
            activate: false,
        }));
        this.counter = Math.max(this.counter, data.counter || 0);
        const activeId = this.sessions.has(ws.activeId) ? ws.activeId : this.order[0];
        this.activate(activeId, { focus: !isCoarse() });
    }
}

export { STATE };
