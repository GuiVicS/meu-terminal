/**
 * notesSession.js
 * "Anotações" tab: Markdown notes saved on the server, so every device shows the same notes.
 * List with search, tags, pin and trash; a single Tiptap editor (write = preview, Notion-style -
 * no separate textarea/preview split) with autosave, a "/" block palette, a per-line drag handle
 * and drag-and-drop/paste of files (uploaded to the server, inserted as an image or a link).
 * When another device changes the open note the tab reloads it, or asks which version to keep.
 * Same interface as TerminalSession, so tabs, status bar and menus work with it.
 */
import { STATE, SESSION_COLORS } from './session.js';
import { icon } from '../ui/icons.js';
import { showMenu } from '../ui/contextMenu.js';
import { toast } from '../ui/toast.js';
import { askConfirm, askText } from '../ui/prompt.js';
import { esc } from '../agent/markdown.js';
import { copyText } from '../agent/codeblock.js';
import { Editor, StarterKit, Image, Placeholder, TaskList, TaskItem, Link, Markdown, Table, TableRow, TableHeader, TableCell } from '../vendor/tiptap.bundle.js';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const SAVE_DELAY = 800;
const REFRESH_DELAY = 300;
const SEARCH_DELAY = 250;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function formatDate(ms) {
    const date = new Date(ms);
    return date.toDateString() === new Date().toDateString() ? timeFormat.format(date) : dayFormat.format(date);
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

/** Uploads a file's raw bytes (no multipart, same convention as the file manager) for `noteId`. */
async function uploadAttachment(noteId, file) {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error(`"${file.name}" passa de 25 MB.`);
    const query = new URLSearchParams({ name: file.name });
    const response = await fetch(`${basePath()}/api/notes/${encodeURIComponent(noteId)}/attachments?${query}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
    });
    let data = null;
    try {
        data = await response.json();
    } catch { /* empty body */ }
    if (!response.ok) throw new Error(data?.error || `Erro ${response.status}`);
    return data; // { name, url }
}

const parseTags = text => text.split(',').map(t => t.trim()).filter(Boolean);

/** Async, but callers (applyFormat/pickSlash) just fire-and-forget it like the sync actions: askText()
 *  never rejects, and nothing downstream awaits the result. Doubles as a proper mobile dialog instead
 *  of the native window.prompt() (styled, becomes a bottom-sheet on phones, no browser chrome). */
async function insertLink(editor) {
    const previousUrl = editor.getAttributes('link').href;
    const url = await askText({
        title: 'Link', label: 'URL', value: previousUrl || 'https://',
        confirm: 'Aplicar', placeholder: 'https://exemplo.com',
    });
    if (url === null || editor.isDestroyed) return;
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url) chain.unsetLink().run();
    else chain.setLink({ href: url }).run();
}

// Floating formatting bar: each entry runs a Tiptap command on the live editor.
// `phoneExtra: true` marks actions that already exist in SLASH_BLOCKS below (headings, quote, table) -
// on phones they're hidden from the always-visible row and reached instead through the "+" button,
// which opens that same "/" menu (see openSlashMenu). Desktop keeps every action visible, unchanged.
const headingAction = level => ({
    key: `h${level}`, text: `H${level}`, label: `Título ${level}`, phoneExtra: true,
    run: e => e.chain().focus().toggleHeading({ level }).run(),
    active: e => e.isActive('heading', { level }),
});
const FORMAT_ACTIONS = [
    headingAction(1), headingAction(2), headingAction(3),
    { key: 'bold', icon: 'bold', label: 'Negrito', sep: true, run: e => e.chain().focus().toggleBold().run(), active: e => e.isActive('bold') },
    { key: 'italic', icon: 'italic', label: 'Itálico', run: e => e.chain().focus().toggleItalic().run(), active: e => e.isActive('italic') },
    { key: 'strike', icon: 'strikethrough', label: 'Riscado', run: e => e.chain().focus().toggleStrike().run(), active: e => e.isActive('strike') },
    { key: 'code', icon: 'code', label: 'Código', run: e => e.chain().focus().toggleCode().run(), active: e => e.isActive('code') },
    { key: 'link', icon: 'link', label: 'Link', run: insertLink, active: e => e.isActive('link') },
    { key: 'quote', icon: 'quote', label: 'Citação', sep: true, phoneExtra: true, run: e => e.chain().focus().toggleBlockquote().run(), active: e => e.isActive('blockquote') },
    { key: 'list', icon: 'list', label: 'Lista', run: e => e.chain().focus().toggleBulletList().run(), active: e => e.isActive('bulletList') },
    { key: 'listOrdered', icon: 'listOrdered', label: 'Lista numerada', run: e => e.chain().focus().toggleOrderedList().run(), active: e => e.isActive('orderedList') },
    { key: 'check', icon: 'squareCheck', label: 'Checklist', run: e => e.chain().focus().toggleTaskList().run(), active: e => e.isActive('taskList') },
    { key: 'table', icon: 'table', label: 'Tabela', phoneExtra: true, run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), active: e => e.isActive('table') },
    { key: 'more', icon: 'plus', label: 'Inserir bloco', cls: 'nt-fbtn-plus', run: (e, self) => self.openSlashMenu() },
];

// Table bar: only shown while the cursor is inside a table.
const TABLE_ACTIONS = [
    { key: 'rowBefore', label: '+ Linha acima', title: 'Inserir linha acima', run: e => e.chain().focus().addRowBefore().run() },
    { key: 'rowAfter', label: '+ Linha abaixo', title: 'Inserir linha abaixo', run: e => e.chain().focus().addRowAfter().run() },
    { key: 'rowDel', label: '− Linha', title: 'Excluir linha', danger: true, run: e => e.chain().focus().deleteRow().run() },
    { key: 'colBefore', label: '+ Coluna à esquerda', title: 'Inserir coluna à esquerda', run: e => e.chain().focus().addColumnBefore().run() },
    { key: 'colAfter', label: '+ Coluna à direita', title: 'Inserir coluna à direita', run: e => e.chain().focus().addColumnAfter().run() },
    { key: 'colDel', label: '− Coluna', title: 'Excluir coluna', danger: true, run: e => e.chain().focus().deleteColumn().run() },
    { key: 'tableDel', label: 'Excluir tabela', title: 'Excluir a tabela inteira', danger: true, run: e => e.chain().focus().deleteTable().run() },
];

// "/" command palette (Notion-style): replaces "/query" with a block.
const SLASH_BLOCKS = [
    { key: 'h1', icon: 'heading', label: 'Título 1', run: e => e.chain().focus().setHeading({ level: 1 }).run() },
    { key: 'h2', icon: 'heading', label: 'Título 2', run: e => e.chain().focus().setHeading({ level: 2 }).run() },
    { key: 'h3', icon: 'heading', label: 'Título 3', run: e => e.chain().focus().setHeading({ level: 3 }).run() },
    { key: 'list', icon: 'list', label: 'Lista', run: e => e.chain().focus().toggleBulletList().run() },
    { key: 'listOrdered', icon: 'listOrdered', label: 'Lista numerada', run: e => e.chain().focus().toggleOrderedList().run() },
    { key: 'check', icon: 'squareCheck', label: 'Checklist', run: e => e.chain().focus().toggleTaskList().run() },
    { key: 'quote', icon: 'quote', label: 'Citação', run: e => e.chain().focus().toggleBlockquote().run() },
    { key: 'code', icon: 'codeXml', label: 'Bloco de código', run: e => e.chain().focus().toggleCodeBlock().run() },
    { key: 'table', icon: 'table', label: 'Tabela', run: e => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { key: 'hr', icon: 'minus', label: 'Divisória', run: e => e.chain().focus().setHorizontalRule().run() },
    { key: 'image', icon: 'image', label: 'Imagem', run: (e, self) => self.pickImage() },
];

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
        this.listLoaded = false;
        this.trashCount = 0;
        this.query = '';
        this.tag = '';
        this.trashView = false;
        this.current = null; // full note open in the editor
        this.dirty = false;
        this.saving = false;
        this.conflict = null; // the other device's version, while the user decides
        this.pendingRemote = false;
        this.listSeq = 0;
        this.editor = null;
        this.slashFrom = null; // doc position of "/" while the command palette is open
        this.slashTo = null;
        this.slashQuery = '';
        this.slashIndex = 0;
        this.slashItems = [];
        this.dragHoverPos = null; // top-level node position under the mouse (for the drag handle)
        this.dragFromPos = null; // top-level node position being dragged
        this.dragOverPos = null;

        this.active = false;
        this.disposed = false;
        this.full = false;
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
                            <button type="button" class="icon-btn nt-fs" data-act="fullscreen" aria-label="Tela cheia" aria-pressed="false" title="Tela cheia">${icon('maximize', 18)}</button>
                            <button type="button" class="icon-btn" data-act="pin" aria-label="Fixar no topo" aria-pressed="false" title="Fixar no topo">${icon('pin', 18)}</button>
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
                        <div class="nt-write">
                            <div class="nt-doc-wrap">
                                <button type="button" class="nt-draghandle" draggable="true" aria-label="Arrastar para reordenar" hidden>${icon('gripVertical', 16)}</button>
                                <div class="nt-doc"></div>
                            </div>
                        </div>
                        <div class="nt-fbar" hidden>
                            <ul class="nt-slash" role="listbox" aria-label="Inserir bloco" hidden></ul>
                            <div class="nt-fbar-row" role="toolbar" aria-label="Formatação">
                                ${FORMAT_ACTIONS.map(a => `<button type="button" class="nt-fbtn${a.text ? ' nt-fbtn-text' : ''}${a.sep ? ' nt-fsep' : ''}${a.phoneExtra ? ' nt-fbtn-extra' : ''}${a.cls ? ` ${a.cls}` : ''}" data-fmt="${a.key}" aria-label="${a.label}" title="${a.label}">${a.text || icon(a.icon, 17)}</button>`).join('')}
                            </div>
                            <div class="nt-fbar-row nt-tbar" role="toolbar" aria-label="Tabela" hidden>
                                ${TABLE_ACTIONS.map(a => `<button type="button" class="nt-tbtn${a.danger ? ' danger' : ''}" data-tbl="${a.key}" title="${a.title}">${a.label}</button>`).join('')}
                            </div>
                        </div>
                    </div>
                </section>
                <button type="button" class="nt-fab" data-act="new" aria-label="Nova anotação">${icon('plus', 22)}</button>
            </div>`;
        const q = sel => this.panel.querySelector(sel);
        this.el = {
            root: q('.nt'), search: q('.nt-search input'), searchForm: q('.nt-search'), tags: q('.nt-tags'),
            trashbar: q('.nt-trashbar'), listEl: q('.nt-list'), empty: q('.nt-empty'), editor: q('.nt-editor'),
            status: q('.nt-status'), conflict: q('.nt-conflict'), title: q('.nt-title'), tagsInput: q('.nt-tags-input'),
            docWrap: q('.nt-doc-wrap'), docEl: q('.nt-doc'), dragHandle: q('.nt-draghandle'), trashBtn: q('[data-act="trash"]'),
            restoreBtn: q('[data-act="restore"]'), fsBtn: q('[data-act="fullscreen"]'), pinBtn: q('[data-act="pin"]'),
            fbar: q('.nt-fbar'), tbar: q('.nt-tbar'), slashEl: q('.nt-slash'),
        };
        this.createEditor();
        this.bind();
        this.load();
        this.connect();
    }

    createEditor() {
        this.editor = new Editor({
            element: this.el.docEl,
            editable: false,
            autofocus: false,
            extensions: [
                StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
                Image.configure({ inline: false, allowBase64: false }),
                Link.configure({ openOnClick: false, autolink: true }),
                TaskList,
                TaskItem.configure({ nested: true }),
                Table.configure({ resizable: false }),
                TableRow,
                TableHeader,
                TableCell,
                Placeholder.configure({ placeholder: 'Escreva aqui… (ou arraste um arquivo para qualquer linha)' }),
                Markdown.configure({ html: false, transformPastedText: true, transformCopiedText: true }),
            ],
            editorProps: {
                handleDrop: (view, event, slice, moved) => {
                    if (moved) return false; // internal text drag, let ProseMirror handle it
                    const files = Array.from(event.dataTransfer?.files || []);
                    if (!files.length || !this.current || this.current.deletedAt) return false;
                    event.preventDefault();
                    const coords = view.posAtCoords({ left: event.clientX, top: event.clientY });
                    void this.insertFiles(files, coords ? coords.pos : view.state.doc.content.size);
                    return true;
                },
                handlePaste: (view, event) => {
                    const files = Array.from(event.clipboardData?.files || []);
                    if (!files.length || !this.current || this.current.deletedAt) return false;
                    event.preventDefault();
                    void this.insertFiles(files, view.state.selection.from);
                    return true;
                },
                handleKeyDown: (view, event) => {
                    if (!this.slashItems.length) return false;
                    if (event.key === 'ArrowDown') { event.preventDefault(); this.moveSlash(1); return true; }
                    if (event.key === 'ArrowUp') { event.preventDefault(); this.moveSlash(-1); return true; }
                    if (event.key === 'Enter' || event.key === 'Tab') {
                        event.preventDefault();
                        this.pickSlash(this.slashItems[this.slashIndex]?.key);
                        return true;
                    }
                    if (event.key === 'Escape') { event.preventDefault(); this.closeSlash(); return true; }
                    return false;
                },
            },
            onUpdate: () => {
                this.edited();
                this.detectSlash();
            },
            onSelectionUpdate: () => this.detectSlash(),
            onFocus: () => this.showFormatBar(),
            onBlur: () => { if (!coarse()) this.hideFormatBar(); },
            onTransaction: () => this.updateFormatBar(),
        });
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
            if (item) return this.openNote(item.dataset.id);
            const fmt = e.target.closest('[data-fmt]');
            if (fmt) return this.applyFormat(fmt.dataset.fmt);
            const tbl = e.target.closest('[data-tbl]');
            if (tbl) return this.applyTableAction(tbl.dataset.tbl);
            const slash = e.target.closest('[data-slash]');
            if (slash) this.pickSlash(slash.dataset.slash);
        });
        // Clicking a toolbar/slash button must not blur the editor (that would close the bar first)
        el.fbar.addEventListener('mousedown', e => e.preventDefault());
        el.searchForm.addEventListener('submit', e => e.preventDefault());
        el.search.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.query = el.search.value;
                this.load();
            }, SEARCH_DELAY);
        });
        [el.title, el.tagsInput].forEach(input => input.addEventListener('input', () => this.edited()));
        this.onViewportChange = () => { if (!el.fbar.hidden) this.positionFormatBar(); };
        this.onFullscreenChange = () => { if (!document.fullscreenElement && this.full) this.setFullscreen(false); };
        document.addEventListener('fullscreenchange', this.onFullscreenChange);
        window.visualViewport?.addEventListener('resize', this.onViewportChange);
        window.visualViewport?.addEventListener('scroll', this.onViewportChange);
        this.bindDragHandle();
        this.panel.addEventListener('keydown', e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                e.stopPropagation();
                void this.flush();
            } else if (e.key === 'Escape' && !e.target.closest('dialog')) {
                if (this.full) this.setFullscreen(false);
                else if (this.el.root.dataset.pane === 'editor') this.showList();
            }
        });
    }

    onAction(act, button) {
        switch (act) {
            case 'new': return this.newNote();
            case 'back': return this.full ? this.setFullscreen(false) : this.showList();
            case 'fullscreen': return this.setFullscreen(!this.full);
            case 'trash': return this.toggleTrash();
            case 'empty-trash': return this.emptyTrash();
            case 'pin': return this.togglePin();
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
        // Before the very first response, show a skeleton instead of letting the "sem anotações"
        // empty-state flash for an instant on a slow connection.
        if (!this.listLoaded && !quiet) this.renderListSkeleton();
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
            this.listLoaded = true;
            if (this.tag && !this.tags.some(t => t.tag.toLowerCase() === this.tag.toLowerCase())) this.tag = '';
            this.renderList();
            this.hooks.onInfo?.(this);
        } catch (error) {
            if (!quiet) toast(error.message, { tone: 'error' });
        }
    }

    renderListSkeleton() {
        this.el.listEl.innerHTML = Array.from({ length: 4 }, () => '<li class="nt-skel" aria-hidden="true"></li>').join('');
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
            const preview = n.preview.replace(/```[a-z]*|[#*_`>~|\/-]/gi, '').replace(/\s+/g, ' ').trim(); // Markdown marks are noise in a one-line preview
            const progress = n.tasks ? `<span class="nt-item-progress"><span class="nt-item-bar"><span style="width:${Math.round(n.tasks.done / n.tasks.total * 100)}%"></span></span><small>${n.tasks.done}/${n.tasks.total}</small></span>` : '';
            // Show at most 2 tags plus a count, instead of letting a long joined list get cut mid-word by the ellipsis
            const tagList = n.tags.length > 2 ? `${n.tags.slice(0, 2).join(', ')} +${n.tags.length - 2}` : n.tags.join(', ');
            return `<li class="nt-row${selected ? ' selected' : ''}">
                <button type="button" class="nt-item" role="option" aria-selected="${selected}" data-id="${esc(n.id)}">
                    <span class="nt-item-title">${n.pinned ? `<span class="nt-pin">${icon('pin', 12)}</span>` : ''}${esc(n.title) || '<em>Sem título</em>'}</span>
                    <span class="nt-item-preview">${esc(preview) || '&nbsp;'}</span>
                    ${progress}
                    <span class="nt-item-meta"${n.tags.length ? ` title="${esc(n.tags.join(', '))}"` : ''}>${esc(formatDate(n.deletedAt || n.updatedAt))}${tagList ? ` · ${esc(tagList)}` : ''}</span>
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

    /** Phones show one pane at a time. The formatting bar stays docked while a note is open; leaving it exits full screen. */
    setPane(pane) {
        this.el.root.dataset.pane = pane;
        if (pane === 'list') {
            this.setFullscreen(false);
            this.hideFormatBar();
        } else if (coarse()) {
            requestAnimationFrame(() => { if (this.el.root.dataset.pane === 'editor') this.showFormatBar(); });
        }
    }

    /** Phone-only "tela cheia": the note covers the whole screen (CSS), plus the browser's own full screen where supported. */
    setFullscreen(on) {
        if (this.full === on) return;
        this.full = on;
        this.el.root.classList.toggle('nt-full', on);
        this.el.fsBtn.innerHTML = icon(on ? 'minimize' : 'maximize', 18);
        this.el.fsBtn.setAttribute('aria-label', on ? 'Sair da tela cheia' : 'Tela cheia');
        this.el.fsBtn.setAttribute('aria-pressed', String(on));
        if (on) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {});
        else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
        this.positionFormatBar();
    }

    showList() {
        void this.flush();
        this.setPane('list');
    }

    showEmpty() {
        this.current = null;
        this.dirty = false;
        this.conflict = null;
        this.el.empty.hidden = false;
        this.el.editor.hidden = true;
        this.setPane('list');
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
        // emitUpdate: false - this is a programmatic load, not a user edit (must not mark the note dirty)
        this.editor.commands.setContent(note.body, { emitUpdate: false });
        const locked = !!note.deletedAt;
        [el.title, el.tagsInput].forEach(input => { input.readOnly = locked; });
        this.editor.setEditable(!locked, false);
        el.docWrap.classList.toggle('readonly', locked);
        el.restoreBtn.hidden = !locked;
        el.pinBtn.hidden = locked;
        el.pinBtn.setAttribute('aria-pressed', String(note.pinned));
        el.pinBtn.classList.toggle('on', note.pinned);
        this.setStatus(locked ? 'Na lixeira' : '');
    }

    async openNote(id) {
        if (this.current?.id === id) {
            this.setPane('editor');
            return;
        }
        await this.flush();
        try {
            this.fill(await request('GET', `/${encodeURIComponent(id)}`));
            this.setPane('editor');
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
            this.setPane('editor');
            await this.load({ quiet: true });
            if (!coarse()) this.el.title.focus();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
    }

    // ---------- attachments (drag-and-drop / paste of files) ----------

    /** Uploads each file to the server and inserts it (image -> <img>, anything else -> a link). */
    async insertFiles(files, pos) {
        const note = this.current;
        if (!note || note.deletedAt) return;
        if (files.length > 1) toast(`Enviando ${files.length} arquivos…`);
        let at = pos;
        for (const file of files) {
            try {
                if (files.length === 1) toast(`Enviando "${file.name}"…`, { duration: 1500 });
                const result = await uploadAttachment(note.id, file);
                if (this.current !== note || this.disposed) return; // navigated away mid-upload
                if (file.type.startsWith('image/')) {
                    this.editor.chain().focus().insertContentAt(at, { type: 'image', attrs: { src: result.url, alt: file.name } }).run();
                } else {
                    this.editor.chain().focus().insertContentAt(at, {
                        type: 'paragraph',
                        content: [{ type: 'text', text: `📎 ${file.name} (${formatSize(file.size)})`, marks: [{ type: 'link', attrs: { href: result.url } }] }],
                    }).run();
                }
                at = this.editor.state.selection.to;
            } catch (error) {
                toast(error.message, { tone: 'error' });
            }
        }
    }

    pickImage() {
        if (!this.current || this.current.deletedAt) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = () => {
            if (input.files[0]) void this.insertFiles([input.files[0]], this.editor.state.selection.to);
        };
        input.click();
    }

    // ---------- formatting bar & "/" command palette ----------

    applyFormat(key) {
        if (!this.current || this.current.deletedAt) return;
        const action = FORMAT_ACTIONS.find(a => a.key === key);
        if (action) action.run(this.editor, this);
    }

    applyTableAction(key) {
        if (!this.current || this.current.deletedAt) return;
        const action = TABLE_ACTIONS.find(a => a.key === key);
        if (action) action.run(this.editor);
    }

    updateFormatBar() {
        if (this.el.fbar.hidden) return;
        this.el.tbar.hidden = !this.editor.isActive('table');
        this.reserveBarSpace();
        this.panel.querySelectorAll('[data-fmt]').forEach(btn => {
            const action = FORMAT_ACTIONS.find(a => a.key === btn.dataset.fmt);
            btn.classList.toggle('on', !!action?.active?.(this.editor));
        });
    }

    showFormatBar() {
        if (!this.current || this.current.deletedAt) return;
        this.el.fbar.hidden = false;
        this.el.root.classList.add('nt-bar-open');
        this.positionFormatBar();
        this.updateFormatBar();
    }

    hideFormatBar() {
        this.el.fbar.hidden = true;
        this.el.root.classList.remove('nt-bar-open');
        this.reserveBarSpace();
        this.closeSlash();
    }

    /** Mobile: keeps the bar sitting right above the on-screen keyboard. Desktop uses CSS (sticky). */
    positionFormatBar() {
        const vv = window.visualViewport;
        if (!coarse() || !vv) {
            this.el.fbar.style.bottom = '';
            return;
        }
        const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
        this.el.fbar.style.bottom = `${kb}px`;
        this.reserveBarSpace();
    }

    /** Phones: the bar floats over the editor, so the note gets bottom padding as tall as the bar (CSS var). */
    reserveBarSpace() {
        this.el.root.style.setProperty('--nt-fbar-h', coarse() && !this.el.fbar.hidden ? `${this.el.fbar.offsetHeight}px` : '0px');
    }

    /** Mobile "+": inserts "/" at the cursor so the existing onUpdate -> detectSlash flow below opens
     *  the same "/" menu used when typing it manually - no separate list of blocks to maintain. */
    openSlashMenu() {
        if (!this.current || this.current.deletedAt || this.editor.isDestroyed) return;
        const { $from, empty } = this.editor.state.selection;
        const before = empty && $from.parentOffset > 0
            ? $from.parent.textBetween($from.parentOffset - 1, $from.parentOffset, undefined, '￼')
            : '\n';
        const needsSpace = empty && $from.parentOffset > 0 && before !== ' ' && before !== '\n';
        this.editor.chain().focus().insertContent(needsSpace ? ' /' : '/').run();
    }

    /** Detects "/" typed at the start of a line (or after a space) in the current text block. */
    detectSlash() {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        if (!empty || !$from.parent.isTextblock) return this.closeSlash();
        const start = Math.max(0, $from.parentOffset - 40);
        const textBefore = $from.parent.textBetween(start, $from.parentOffset, undefined, '￼');
        const match = /(?:^|[\n ])\/(\w*)$/.exec(textBefore);
        if (!match) return this.closeSlash();
        this.slashQuery = match[1];
        this.slashTo = $from.pos;
        this.slashFrom = $from.pos - match[1].length - 1;
        this.slashIndex = 0;
        this.renderSlashMenu();
    }

    renderSlashMenu() {
        const q = this.slashQuery.toLowerCase();
        this.slashItems = SLASH_BLOCKS.filter(b => !q || b.label.toLowerCase().includes(q));
        const { slashEl } = this.el;
        if (!this.slashItems.length) {
            slashEl.hidden = true;
            return;
        }
        this.slashIndex = Math.min(this.slashIndex, this.slashItems.length - 1);
        slashEl.innerHTML = this.slashItems.map((b, i) => `
            <li role="option" aria-selected="${i === this.slashIndex}" class="${i === this.slashIndex ? 'active' : ''}" data-slash="${b.key}">
                ${icon(b.icon, 15)}<span>${b.label}</span>
            </li>`).join('');
        slashEl.hidden = false;
    }

    moveSlash(delta) {
        if (!this.slashItems.length) return;
        this.slashIndex = (this.slashIndex + delta + this.slashItems.length) % this.slashItems.length;
        this.renderSlashMenu();
    }

    closeSlash() {
        this.slashFrom = null;
        this.slashTo = null;
        this.slashQuery = '';
        this.slashIndex = 0;
        this.slashItems = [];
        if (this.el) this.el.slashEl.hidden = true;
    }

    pickSlash(key) {
        const block = this.slashItems.find(b => b.key === key) || SLASH_BLOCKS.find(b => b.key === key);
        if (!block || this.slashFrom === null) return;
        const { from, to } = { from: this.slashFrom, to: this.slashTo };
        this.closeSlash();
        this.editor.chain().focus().deleteRange({ from, to }).run();
        block.run(this.editor, this);
    }

    setStatus(text) {
        this.el.status.textContent = text;
    }

    // ---------- per-line drag handle (reorders top-level blocks) ----------

    bindDragHandle() {
        const { docWrap, dragHandle } = this.el;
        docWrap.addEventListener('mousemove', e => {
            if (this.dragFromPos !== null || !this.current || this.current.deletedAt) return;
            const result = this.editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
            if (!result) return this.hideDragHandle();
            const $pos = this.editor.state.doc.resolve(result.pos);
            if ($pos.depth < 1) return this.hideDragHandle();
            const topPos = $pos.before(1);
            const dom = this.editor.view.nodeDOM(topPos);
            if (!dom || dom.nodeType !== 1) return this.hideDragHandle();
            const rect = dom.getBoundingClientRect();
            const wrapRect = docWrap.getBoundingClientRect();
            dragHandle.hidden = false;
            dragHandle.style.top = `${rect.top - wrapRect.top}px`;
            dragHandle.style.height = `${rect.height}px`;
            this.dragHoverPos = topPos;
        });
        docWrap.addEventListener('mouseleave', () => {
            if (this.dragFromPos === null) this.hideDragHandle();
        });
        dragHandle.addEventListener('dragstart', e => {
            if (this.dragHoverPos === null) { e.preventDefault(); return; }
            this.dragFromPos = this.dragHoverPos;
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', 'reorder');
            this.editor.view.nodeDOM(this.dragFromPos)?.classList.add('nt-drag-source');
        });
        dragHandle.addEventListener('dragend', () => {
            this.clearDragHighlights();
            this.dragFromPos = null;
            this.dragOverPos = null;
            this.hideDragHandle();
        });
        docWrap.addEventListener('dragover', e => {
            if (this.dragFromPos === null) return; // an external file drag: editorProps.handleDrop deals with it
            e.preventDefault();
            const result = this.editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
            if (!result) return;
            const $pos = this.editor.state.doc.resolve(result.pos);
            if ($pos.depth < 1) return;
            const topPos = $pos.before(1);
            if (topPos === this.dragOverPos) return;
            this.panel.querySelectorAll('.nt-drag-target').forEach(elx => elx.classList.remove('nt-drag-target'));
            this.editor.view.nodeDOM(topPos)?.classList.add('nt-drag-target');
            this.dragOverPos = topPos;
        });
        docWrap.addEventListener('drop', e => {
            if (this.dragFromPos === null) return;
            e.preventDefault();
            if (this.dragOverPos !== null && this.dragOverPos !== this.dragFromPos) {
                this.moveNode(this.dragFromPos, this.dragOverPos);
                this.edited();
            }
            this.clearDragHighlights();
            this.dragFromPos = null;
            this.dragOverPos = null;
            this.hideDragHandle();
        });
    }

    hideDragHandle() {
        this.el.dragHandle.hidden = true;
        this.dragHoverPos = null;
    }

    clearDragHighlights() {
        this.panel.querySelectorAll('.nt-drag-source, .nt-drag-target').forEach(elx => elx.classList.remove('nt-drag-source', 'nt-drag-target'));
    }

    /** Moves the top-level block at `fromPos` to sit where the block at `toPos` is. */
    moveNode(fromPos, toPos) {
        this.editor.commands.command(({ tr, state }) => {
            const node = state.doc.nodeAt(fromPos);
            if (!node) return false;
            const size = node.nodeSize;
            tr.delete(fromPos, fromPos + size);
            tr.insert(toPos > fromPos ? toPos - size : toPos, node);
            return true;
        });
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
        const patch = { title: el.title.value, body: this.editor.storage.markdown.getMarkdown(), tags: parseTags(el.tagsInput.value) };
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
        const copy = { label: 'Copiar texto (Markdown)', icon: 'copy', run: () => copyText(this.editor.storage.markdown.getMarkdown()).then(ok => toast(ok ? 'Texto copiado.' : 'Não foi possível copiar.')) };
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
        if (this.current && !this.current.deletedAt) this.editor.commands.focus();
        else this.el.search.focus();
    }

    applySettings() { /* uses the app theme via CSS */ }

    applyRow(row) {
        this.name = row.name;
        this.pinned = !!row.pinned;
        if (SESSION_COLORS.includes(row.color)) this.color = row.color;
    }

    /** Workspace "search" (Ctrl+F) on this tab. */
    openFind() {
        this.setPane('list');
        this.el.search.focus();
        this.el.search.select();
    }

    /** Dictation / clipboard paste: typed into the focused field of this tab, if any. */
    sendText(text) {
        const field = this.panel.querySelector('input:focus');
        if (field && !field.readOnly) {
            field.focus();
            document.execCommand('insertText', false, text);
        } else if (this.editor?.isFocused && this.current && !this.current.deletedAt) {
            this.editor.chain().focus().insertContent(text).run();
        } else {
            toast('Abra uma anotação e toque no texto para colar aqui.');
        }
    }

    sendInput(data) {
        if (data === '\r') {
            const field = this.panel.querySelector('input:focus');
            if (field) field.form?.requestSubmit();
            else if (this.editor?.isFocused) this.editor.chain().focus().splitBlock().run();
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
        if (this.onViewportChange) {
            document.removeEventListener('fullscreenchange', this.onFullscreenChange);
            window.visualViewport?.removeEventListener('resize', this.onViewportChange);
            window.visualViewport?.removeEventListener('scroll', this.onViewportChange);
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.editor?.destroy();
        this.panel.remove();
    }
}
