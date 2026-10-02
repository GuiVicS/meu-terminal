/**
 * notesSession.js
 * "Anotações" tab: Markdown notes saved on the server, so every device shows the same notes.
 * List with search, tags, pin and trash; editor with autosave and a Markdown preview. When
 * another device changes the open note the tab reloads it, or asks which version to keep.
 * Same interface as TerminalSession, so tabs, status bar and menus work with it.
 */
import { STATE, SESSION_COLORS } from './session.js';
import { icon } from '../ui/icons.js';
import { showMenu } from '../ui/contextMenu.js';
import { toast } from '../ui/toast.js';
import { askConfirm } from '../ui/prompt.js';
import { renderMarkdown, esc } from '../agent/markdown.js';
import { highlightIn, onCodeClick, copyText } from '../agent/codeblock.js';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const SAVE_DELAY = 800;
const REFRESH_DELAY = 300;
const SEARCH_DELAY = 250;

const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function formatDate(ms) {
    const date = new Date(ms);
    return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
}

async function request(method, route = '', { params, body } = {}) {
    const query = params ? `?${new URLSearchParams(params)}` : '';
    const response = await fetch(`${basePath()}/api/notes${route}${query}`, {
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
        error.note = data?.note;
        throw error;
    }
    return data;
}

const parseTags = text => text.split(',').map(t => t.trim()).filter(Boolean);

export default class NotesSession {
    /**
     * @param {object} opts
     * @param {object} opts.row - session from /api/sessions (kind 'notes')
     * @param {object} opts.settings - SettingsManager
     * @param {object} opts.hooks - callbacks into the workspace
     */
    constructor({ row, settings, hooks }) {
        this.kind = 'notes';
        this.id = row.id;
        this.name = row.name;
        this.pinned = !!row.pinned;
        this.color = SESSION_COLORS.includes(row.color) ? row.color : (SESSION_COLORS.includes('yellow') ? 'yellow' : SESSION_COLORS[0]);
        this.settings = settings;
        this.hooks = hooks;

        // Fields the rest of the app reads from terminal sessions
        this.state = STATE.CONNECTING;
        this.shell = 'anotações';
        this.startCwd = '';
        this.cwd = null;
        this.process = null;
        this.branch = null;
        this.pid = null;
        this.terminal = null;
        this.addons = null;
        this.hasActivity = false;

        this.list = [];
        this.tags = [];
        this.trashCount = 0;
        this.query = '';
        this.tag = '';
        this.trashView = false;
        this.current = null; // full note open in the editor
        this.dirty = false;
        this.saving = false;
        this.conflict = null; // the other device's version, while the user decides
        this.pendingRemote = false;
        this.preview = false;
        this.listSeq = 0;

        this.active = false;
        this.disposed = false;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.timers = new Set();
        this.saveTimer = null;
        this.refreshTimer = null;

        this.panel = document.createElement('div');
        this.panel.className = 'terminal-panel notes-panel';
        this.panel.id = `panel-${this.id}`;
        this.panel.setAttribute('role', 'tabpanel');
        this.panel.setAttribute('aria-labelledby', `tab-${this.id}`);
    }

    get sizeLabel() {
        return this.list.length ? `${this.list.length} ${this.trashView ? 'na lixeira' : 'anotações'}` : '';
    }

    displayCwd() {
        return '';
    }

    // ---------- view ----------

    mount(parent) {
        parent.appendChild(this.panel);
        this.panel.innerHTML = `
            <div class="nt" data-pane="list">
                <aside class="nt-side" aria-label="Lista de anotações">
                    <div class="nt-toolbar">
                        <form class="nt-search" role="search">
                            ${icon('search', 16)}
                            <input type="search" enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false"
                                placeholder="Buscar anotações" aria-label="Buscar anotações">
                        </form>
                        <button type="button" class="icon-btn" data-act="new" aria-label="Nova anotação" title="Nova anotação">${icon('plus', 18)}</button>
                        <button type="button" class="icon-btn" data-act="trash" aria-label="Lixeira" aria-pressed="false" title="Lixeira">${icon('trash', 18)}</button>
                    </div>
                    <div class="nt-tags" aria-label="Filtrar por tag"></div>
                    <div class="nt-trashbar" hidden>
                        <span>Itens na lixeira ficam até você excluir.</span>
                        <button type="button" class="btn btn-ghost btn-sm" data-act="empty-trash">Esvaziar</button>
                    </div>
                    <ul class="nt-list" role="listbox" aria-label="Anotações"></ul>
                </aside>
                <section class="nt-main" aria-label="Editor">
                    <div class="nt-empty">
                        ${icon('notes', 40)}
                        <p>Selecione uma anotação ou crie uma nova.</p>
                        <button type="button" class="btn btn-primary" data-act="new">${icon('plus', 16)} Nova anotação</button>
                    </div>
                    <div class="nt-editor" hidden>
                        <div class="nt-ehead">
                            <button type="button" class="icon-btn nt-back" data-act="back" aria-label="Voltar para a lista">${icon('arrowLeft', 18)}</button>
                            <span class="nt-status" role="status" aria-live="polite"></span>
                            <button type="button" class="btn btn-ghost btn-sm" data-act="restore" hidden>Restaurar</button>
                            <button type="button" class="icon-btn" data-act="pin" aria-label="Fixar no topo" aria-pressed="false" title="Fixar no topo">${icon('pin', 18)}</button>
                            <button type="button" class="icon-btn" data-act="preview" aria-label="Visualizar" aria-pressed="false" title="Editar / Visualizar">${icon('eye', 18)}</button>
                            <button type="button" class="icon-btn" data-act="more" aria-label="Mais ações">${icon('more', 18)}</button>
                        </div>
                        <div class="nt-conflict" role="alert" hidden>
                            <span>Esta anotação foi alterada em outro aparelho.</span>
                            <button type="button" class="btn btn-ghost btn-sm" data-act="take-theirs">Usar a outra versão</button>
                            <button type="button" class="btn btn-ghost btn-sm" data-act="keep-mine">Manter a minha</button>
                        </div>
                        <input class="nt-title" type="text" maxlength="200" placeholder="Título" aria-label="Título da anotação" autocomplete="off">
                        <div class="nt-tagsline">
                            ${icon('tag', 14)}
                            <input class="nt-tags-input" type="text" placeholder="Tags separadas por vírgula" aria-label="Tags" autocomplete="off" autocapitalize="off">
                        </div>
                        <textarea class="nt-body" placeholder="Escreva em Markdown…" aria-label="Texto da anotação" spellcheck="true"></textarea>
                        <div class="nt-preview md" hidden></div>
                    </div>
                </section>
                <button type="button" class="nt-fab" data-act="new" aria-label="Nova anotação">${icon('plus', 22)}</button>
            </div>`;
        const q = sel => this.panel.querySelector(sel);
        this.el = {
            root: q('.nt'), search: q('.nt-search input'), searchForm: q('.nt-search'), tags: q('.nt-tags'),
            trashbar: q('.nt-trashbar'), listEl: q('.nt-list'), empty: q('.nt-empty'), editor: q('.nt-editor'),
            status: q('.nt-status'), conflict: q('.nt-conflict'), title: q('.nt-title'), tagsInput: q('.nt-tags-input'),
            body: q('.nt-body'), previewEl: q('.nt-preview'), trashBtn: q('[data-act="trash"]'),
            restoreBtn: q('[data-act="restore"]'), pinBtn: q('[data-act="pin"]'), previewBtn: q('[data-act="preview"]'),
        };
        this.bind();
        this.load();
        this.connect();
    }

    bind() {
        const { el } = this;
        this.panel.addEventListener('click', e => {
            const act = e.target.closest('[data-act]');
            if (act) return this.onAction(act.dataset.act, act);
            const more = e.target.closest('[data-more]');
            if (more) return this.openRowMenu(more.dataset.more, more);
            const tag = e.target.closest('[data-tag]');
            if (tag) {
                this.tag = this.tag === tag.dataset.tag ? '' : tag.dataset.tag;
                return this.load();
            }
            const item = e.target.closest('.nt-item');
            if (item) this.openNote(item.dataset.id);
        });
        el.previewEl.addEventListener('click', e => onCodeClick(e));
        el.searchForm.addEventListener('submit', e => e.preventDefault());
        el.search.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.query = el.search.value;
                this.load();
            }, SEARCH_DELAY);
        });
        [el.title, el.tagsInput, el.body].forEach(input => input.addEventListener('input', () => this.edited()));
        this.panel.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                e.stopPropagation();
                void this.flush();
            } else if (e.key === 'Escape' && !e.target.closest('dialog')) {
                if (this.el.root.dataset.pane === 'editor') this.showList();
            }
        });
    }

    onAction(act, button) {
        switch (act) {
            case 'new': return this.newNote();
            case 'back': return this.showList();
            case 'trash': return this.toggleTrash();
            case 'empty-trash': return this.emptyTrash();
            case 'pin': return this.togglePin();
            case 'preview': return this.togglePreview();
            case 'restore': return this.restore(this.current?.id);
            case 'more': return this.openEditorMenu(button);
            case 'take-theirs': return this.takeTheirs();
            case 'keep-mine': return this.keepMine();
            default: return undefined;
        }
    }

    // ---------- list ----------

    async load({ quiet = false } = {}) {
        const seq = ++this.listSeq;
        const params = {};
        if (this.query.trim()) params.q = this.query.trim();
        if (this.tag && !this.trashView) params.tag = this.tag;
        if (this.trashView) params.trash = '1';
        try {
            const data = await request('GET', '', { params });
            if (seq !== this.listSeq || this.disposed) return;
            this.list = data.notes;
            this.tags = data.tags;
            this.trashCount = data.trashCount;
            if (this.tag && !this.tags.some(t => t.tag.toLowerCase() === this.tag.toLowerCase())) this.tag = '';
            this.renderList();
            this.hooks.onInfo?.(this);
        } catch (error) {
            if (!quiet) toast(error.message, { tone: 'error' });
        }
    }

    refreshSoon() {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.load({ quiet: true }), REFRESH_DELAY);
    }

    renderList() {
        const { el } = this;
        el.trashBtn.setAttribute('aria-pressed', String(this.trashView));
        el.trashBtn.classList.toggle('on', this.trashView);
        el.trashbar.hidden = !this.trashView || !this.list.length;
        el.tags.hidden = this.trashView || !this.tags.length;
        el.tags.innerHTML = this.tags.map(t => {
            const on = t.tag.toLowerCase() === this.tag.toLowerCase();
            return `<button type="button" class="nt-chip${on ? ' on' : ''}" data-tag="${esc(t.tag)}" aria-pressed="${on}">${esc(t.tag)} <small>${t.count}</small></button>`;
        }).join('');
        if (!this.list.length) {
            const text = this.trashView ? 'A lixeira está vazia.' : (this.query || this.tag ? 'Nenhuma anotação encontrada.' : 'Você ainda não tem anotações.');
            el.listEl.innerHTML = `<li class="nt-none">${text}</li>`;
            return;
        }
        el.listEl.innerHTML = this.list.map(n => {
            const selected = n.id === this.current?.id;
            const preview = n.preview.replace(/```[a-z]*|[#*_`>~]/gi, '').replace(/\s+/g, ' ').trim(); // Markdown marks are noise in a one-line preview
            return `<li class="nt-row${selected ? ' selected' : ''}">
                <button type="button" class="nt-item" role="option" aria-selected="${selected}" data-id="${esc(n.id)}">
                    <span class="nt-item-title">${n.pinned ? `<span class="nt-pin">${icon('pin', 12)}</span>` : ''}${esc(n.title) || '<em>Sem título</em>'}</span>
                    <span class="nt-item-preview">${esc(preview) || '&nbsp;'}</span>
                    <span class="nt-item-meta">${esc(formatDate(n.deletedAt || n.updatedAt))}${n.tags.length ? ` · ${esc(n.tags.join(', '))}` : ''}</span>
                </button>
                <button type="button" class="icon-btn nt-more" data-more="${esc(n.id)}" aria-label="Ações da anotação">${icon('more', 16)}</button>
            </li>`;
        }).join('');
    }

    toggleTrash() {
        this.trashView = !this.trashView;
        this.tag = '';
        this.load();
    }

    // ---------- editor ----------

    showList() {
        void this.flush();
        this.el.root.dataset.pane = 'list';
    }

    showEmpty() {
        this.current = null;
        this.dirty = false;
        this.conflict = null;
        this.el.empty.hidden = false;
        this.el.editor.hidden = true;
        this.el.root.dataset.pane = 'list';
        this.renderList();
    }

    fill(note) {
        const { el } = this;
        this.current = note;
        this.dirty = false;
        this.conflict = null;
        el.conflict.hidden = true;
        el.empty.hidden = true;
        el.editor.hidden = false;
        el.title.value = note.title;
        el.tagsInput.value = note.tags.join(', ');
        el.body.value = note.body;
        const locked = !!note.deletedAt;
        [el.title, el.tagsInput, el.body].forEach(input => { input.readOnly = locked; });
        el.restoreBtn.hidden = !locked;
        el.pinBtn.hidden = locked;
        el.pinBtn.setAttribute('aria-pressed', String(note.pinned));
        el.pinBtn.classList.toggle('on', note.pinned);
        this.setStatus(locked ? 'Na lixeira' : '');
        this.renderPreview();
    }

    async openNote(id) {
        if (this.current?.id === id) {
            this.el.root.dataset.pane = 'editor';
            return;
        }
        await this.flush();
        try {
            this.fill(await request('GET', `/${encodeURIComponent(id)}`));
            this.el.root.dataset.pane = 'editor';
            this.preview = !!this.current.deletedAt;
            this.applyPreview();
            this.renderList();
            if (!coarse() && !this.current.deletedAt && !this.current.title && !this.current.body) this.el.title.focus();
        } catch (error) {
            toast(error.message, { tone: 'error' });
            this.refreshSoon();
        }
    }

    async newNote() {
        await this.flush();
        if (this.trashView) {
            this.trashView = false;
            this.query = '';
            this.el.search.value = '';
        }
        try {
            const note = await request('POST', '', { body: { tags: this.tag ? [this.tag] : [] } });
            this.fill(note);
            this.preview = false;
            this.applyPreview();
            this.el.root.dataset.pane = 'editor';
            await this.load({ quiet: true });
            if (!coarse()) this.el.title.focus();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
    }

    togglePreview() {
        this.preview = !this.preview;
        this.applyPreview();
    }

    applyPreview() {
        const { el } = this;
        el.body.hidden = this.preview;
        el.previewEl.hidden = !this.preview;
        el.previewBtn.setAttribute('aria-pressed', String(this.preview));
        el.previewBtn.innerHTML = icon(this.preview ? 'edit' : 'eye', 18);
        el.previewBtn.setAttribute('aria-label', this.preview ? 'Editar' : 'Visualizar');
        if (this.preview) this.renderPreview();
    }

    renderPreview() {
        if (!this.preview || !this.current) return;
        const { previewEl } = this.el;
        previewEl.innerHTML = renderMarkdown(this.el.body.value) || '<p class="nt-none">Nada para mostrar ainda.</p>';
        void highlightIn(previewEl);
    }

    setStatus(text) {
        this.el.status.textContent = text;
    }

    // ---------- saving ----------

    edited() {
        if (!this.current || this.current.deletedAt) return;
        this.dirty = true;
        this.setStatus('Editando…');
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY);
    }

    async flush() {
        clearTimeout(this.saveTimer);
        while (this.saving) await new Promise(resolve => setTimeout(resolve, 50));
        if (this.dirty) await this.save();
    }

    async save() {
        const note = this.current;
        if (!note || !this.dirty || this.saving || this.conflict) return;
        const { el } = this;
        // Read the fields now: the user may keep typing (or the tab may close) while the request runs
        const patch = { title: el.title.value, body: el.body.value, tags: parseTags(el.tagsInput.value) };
        this.saving = true;
        this.dirty = false;
        this.setStatus('Salvando…');
        try {
            const saved = await request('PATCH', `/${encodeURIComponent(note.id)}`, { body: { ...patch, baseUpdatedAt: note.updatedAt } });
            if (this.current === note) {
                note.updatedAt = saved.updatedAt;
                note.title = saved.title;
                note.tags = saved.tags;
                this.setStatus(this.dirty ? 'Editando…' : 'Salvo');
            }
            this.refreshSoon();
        } catch (error) {
            this.dirty = true;
            if (error.status === 409 && error.note && this.current === note) {
                this.showConflict(error.note);
            } else {
                this.setStatus('Não salvo');
                if (!this.disposed) toast(error.message, { tone: 'error' });
            }
        } finally {
            this.saving = false;
        }
        if (this.dirty && !this.conflict && this.current === note) this.saveTimer = setTimeout(() => void this.save(), SAVE_DELAY);
        if (this.pendingRemote) {
            this.pendingRemote = false;
            void this.checkRemote();
        }
    }

    showConflict(theirs) {
        this.conflict = theirs;
        this.el.conflict.hidden = false;
        this.setStatus('Alteração em conflito');
    }

    takeTheirs() {
        if (!this.conflict) return;
        this.fill(this.conflict);
        this.refreshSoon();
    }

    keepMine() {
        if (!this.conflict || !this.current) return;
        this.current.updatedAt = this.conflict.updatedAt;
        this.conflict = null;
        this.el.conflict.hidden = true;
        void this.save();
    }

    /** Another device changed notes: reload the open one unless it has unsaved edits. */
    async checkRemote() {
        const note = this.current;
        if (!note) return;
        if (this.saving) {
            this.pendingRemote = true;
            return;
        }
        try {
            const fresh = await request('GET', `/${encodeURIComponent(note.id)}`);
            if (this.current !== note || fresh.updatedAt === note.updatedAt && !!fresh.deletedAt === !!note.deletedAt) return;
            if (fresh.deletedAt && !note.deletedAt) {
                if (!this.dirty) {
                    toast('Esta anotação foi para a lixeira em outro aparelho.');
                    this.showEmpty();
                } else {
                    this.showConflict(fresh);
                }
            } else if (this.dirty) {
                this.showConflict(fresh);
            } else {
                this.fill(fresh);
            }
        } catch (error) {
            if (error.status === 404 && !this.dirty) {
                toast('Esta anotação foi excluída em outro aparelho.');
                this.showEmpty();
            }
        }
    }

    // ---------- actions ----------

    async togglePin() {
        const note = this.current;
        if (!note || note.deletedAt) return;
        await this.flush();
        try {
            const saved = await request('PATCH', `/${encodeURIComponent(note.id)}`, { body: { pinned: !note.pinned, baseUpdatedAt: note.updatedAt } });
            note.pinned = saved.pinned;
            note.updatedAt = saved.updatedAt;
            this.el.pinBtn.setAttribute('aria-pressed', String(note.pinned));
            this.el.pinBtn.classList.toggle('on', note.pinned);
            this.refreshSoon();
        } catch (error) {
            if (error.status === 409 && error.note) this.showConflict(error.note);
            else toast(error.message, { tone: 'error' });
        }
    }

    async toTrash(id) {
        if (this.current?.id === id) await this.flush();
        try {
            await request('DELETE', `/${encodeURIComponent(id)}`);
            if (this.current?.id === id) this.showEmpty();
            toast('Anotação movida para a lixeira.', { action: { label: 'Desfazer', run: () => this.restore(id) } });
            this.refreshSoon();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
    }

    async restore(id) {
        if (!id) return;
        try {
            await request('POST', `/${encodeURIComponent(id)}/restore`);
            if (this.current?.id === id) this.showEmpty();
            toast('Anotação restaurada.');
            this.refreshSoon();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
    }

    async purge(id) {
        const ok = await askConfirm({
            title: 'Excluir para sempre?',
            message: 'Esta anotação será apagada definitivamente e não poderá ser recuperada.',
            confirm: 'Excluir',
            danger: true,
        });
        if (!ok) return;
        try {
            await request('DELETE', `/${encodeURIComponent(id)}`);
            if (this.current?.id === id) this.showEmpty();
            this.refreshSoon();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
    }

    async emptyTrash() {
        const ok = await askConfirm({
            title: 'Esvaziar a lixeira?',
            message: `${this.list.length} anotação(ões) serão apagadas definitivamente.`,
            confirm: 'Esvaziar',
            danger: true,
        });
        if (!ok) return;
        try {
            await request('DELETE', '/trash');
            if (this.current?.deletedAt) this.showEmpty();
            this.refreshSoon();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
    }

    openRowMenu(id, anchor) {
        const note = this.list.find(n => n.id === id);
        if (!note) return;
        const items = this.trashView
            ? [
                { label: 'Restaurar', icon: 'restore', run: () => this.restore(id) },
                { label: 'Excluir para sempre', icon: 'trash', danger: true, run: () => this.purge(id) },
            ]
            : [
                { label: note.pinned ? 'Desafixar' : 'Fixar no topo', icon: 'pin', run: () => this.pinRow(note) },
                'separator',
                { label: 'Mover para a lixeira', icon: 'trash', danger: true, run: () => this.toTrash(id) },
            ];
        showMenu(items, { anchor, label: 'Ações da anotação' });
    }

    async pinRow(note) {
        if (this.current?.id === note.id) return this.togglePin();
        try {
            await request('PATCH', `/${encodeURIComponent(note.id)}`, { body: { pinned: !note.pinned } });
            this.refreshSoon();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
        return undefined;
    }

    openEditorMenu(anchor) {
        const note = this.current;
        if (!note) return;
        const copy = { label: 'Copiar texto (Markdown)', icon: 'copy', run: () => copyText(this.el.body.value).then(ok => toast(ok ? 'Texto copiado.' : 'Não foi possível copiar.')) };
        const items = note.deletedAt
            ? [copy, 'separator', { label: 'Restaurar', icon: 'restore', run: () => this.restore(note.id) }, { label: 'Excluir para sempre', icon: 'trash', danger: true, run: () => this.purge(note.id) }]
            : [copy, 'separator', { label: 'Mover para a lixeira', icon: 'trash', danger: true, run: () => this.toTrash(note.id) }];
        showMenu(items, { anchor, label: 'Ações da anotação' });
    }

    // ---------- tab interface ----------

    setActive(active) {
        this.active = active;
        this.panel.classList.toggle('active', active);
        this.panel.setAttribute('aria-hidden', String(!active));
        if (active && this.mountedOnce) {
            this.load({ quiet: true });
            void this.checkRemote();
        }
        this.mountedOnce = true;
    }

    focus() {
        if (coarse() || !this.el) return;
        (this.current && !this.current.deletedAt && !this.preview ? this.el.body : this.el.search).focus({ preventScroll: true });
    }

    applySettings() { /* uses the app theme via CSS */ }

    applyRow(row) {
        this.name = row.name;
        this.pinned = !!row.pinned;
        if (SESSION_COLORS.includes(row.color)) this.color = row.color;
    }

    /** Workspace "search" (Ctrl+F) on this tab. */
    openFind() {
        this.el.root.dataset.pane = 'list';
        this.el.search.focus();
        this.el.search.select();
    }

    /** Dictation / clipboard paste: typed into the focused field of this tab, if any. */
    sendText(text) {
        const field = this.panel.querySelector('input:focus, textarea:focus');
        if (field && !field.readOnly) {
            field.focus();
            document.execCommand('insertText', false, text);
        } else {
            toast('Abra uma anotação e toque no texto para colar aqui.');
        }
    }

    sendInput(data) {
        if (data === '\r') {
            const field = this.panel.querySelector('input:focus, textarea:focus');
            if (field?.tagName === 'TEXTAREA') document.execCommand('insertText', false, '\n');
            else if (field) field.form?.requestSubmit();
            return;
        }
        if (/^[\x20-\x7e -￿]+$/.test(data)) this.sendText(data);
    }

    // ---------- connection (workspace notices and "notes changed") ----------

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.hooks.onStateChange(this);
    }

    connect() {
        if (this.disposed) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${window.location.host}${basePath()}/?${new URLSearchParams({ session: this.id })}`);
        this.ws = ws;
        ws.onopen = () => {
            // Anything could have changed while the socket was down
            if (this.reconnectAttempts) {
                this.refreshSoon();
                void this.checkRemote();
            }
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
            if (m.type === 'notes') {
                this.refreshSoon();
                if (this.current && (!m.id || m.id === this.current.id)) void this.checkRemote();
            } else if (m.type === 'workspace') {
                this.hooks.onWorkspaceChanged();
            } else if (m.nonce) {
                this.hooks.onServerMessage(m); // app-wide notices (open-tab, notify, split...)
            }
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

    later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
        return t;
    }

    dispose() {
        // Save what was typed last; the patch is read synchronously, so closing the tab does not lose it
        clearTimeout(this.saveTimer);
        if (this.dirty && !this.conflict) void this.save();
        this.disposed = true;
        clearTimeout(this.refreshTimer);
        clearTimeout(this.searchTimer);
        this.timers.forEach(clearTimeout);
        this.timers.clear();
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.panel.remove();
    }
}
