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

// Floating formatting bar: inline wraps (**bold**) or line prefixes (> quote).
const FORMAT_ACTIONS = [
    { key: 'bold', icon: 'bold', label: 'Negrito', wrap: ['**', '**'] },
    { key: 'italic', icon: 'italic', label: 'Itálico', wrap: ['*', '*'] },
    { key: 'code', icon: 'code', label: 'Código', wrap: ['`', '`'] },
    { key: 'link', icon: 'link', label: 'Link', wrap: ['[', '](url)'] },
    { key: 'heading', icon: 'heading', label: 'Título', prefix: '## ' },
    { key: 'quote', icon: 'quote', label: 'Citação', prefix: '> ' },
    { key: 'list', icon: 'list', label: 'Lista', prefix: '- ' },
    { key: 'listOrdered', icon: 'listOrdered', label: 'Lista numerada', prefix: '1. ' },
    { key: 'check', icon: 'squareCheck', label: 'Checklist', prefix: '- [ ] ' },
];

// "/" command palette (Notion-style): replaces "/query" with a block snippet.
const SLASH_BLOCKS = [
    { key: 'h1', icon: 'heading', label: 'Título 1', snippet: '# ' },
    { key: 'h2', icon: 'heading', label: 'Título 2', snippet: '## ' },
    { key: 'h3', icon: 'heading', label: 'Título 3', snippet: '### ' },
    { key: 'list', icon: 'list', label: 'Lista', snippet: '- ' },
    { key: 'listOrdered', icon: 'listOrdered', label: 'Lista numerada', snippet: '1. ' },
    { key: 'check', icon: 'squareCheck', label: 'Checklist', snippet: '- [ ] ' },
    { key: 'quote', icon: 'quote', label: 'Citação', snippet: '> ' },
    { key: 'code', icon: 'codeXml', label: 'Bloco de código', snippet: '```\n\n```', caretOffset: 4 },
    { key: 'hr', icon: 'minus', label: 'Divisória', snippet: '---\n' },
    // caretOffset lands right after the first "| ", selectLength selects "Coluna 1" so typing replaces
    // it immediately - same as tabbing into a cell (see handleTableTab() below).
    { key: 'table', icon: 'table', label: 'Tabela', snippet: '| Coluna 1 | Coluna 2 | Coluna 3 |\n| --- | --- | --- |\n|  |  |  |\n', caretOffset: 2, selectLength: 8 },
];

/**
 * Offsets (within `line`) of every unescaped "|" - the cell boundaries of one table row/separator.
 * Only recognizes well-formed rows (leading and trailing "|"); anything else isn't a table line as
 * far as Tab/Enter-in-a-table is concerned, same as the renderer's own table detection.
 * @returns {number[]|null}
 */
function tableCellPipes(line) {
    if (!/^\s*\|.*\|\s*$/.test(line)) return null;
    const pipes = [];
    for (let j = 0; j < line.length; j++) {
        if (line[j] === '|' && line[j - 1] !== '\\') pipes.push(j);
    }
    return pipes.length >= 2 ? pipes : null;
}

const isTableSeparatorCells = cells => cells.every(c => /^\s*:?-{1,}:?\s*$/.test(c));

/**
 * Re-pads every pipe-table in `text` so its columns line up visually in the raw source (and keeps
 * the ":---"/"---:"/":---:" alignment markers as-is). Everything outside a table is untouched.
 */
function formatTablesText(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const headPipes = tableCellPipes(lines[i]);
        const sepPipes = headPipes && i + 1 < lines.length ? tableCellPipes(lines[i + 1]) : null;
        const colCount = headPipes ? headPipes.length - 1 : 0;
        const sepCells = sepPipes && sepPipes.length - 1 === colCount
            ? Array.from({ length: colCount }, (_, k) => lines[i + 1].slice(sepPipes[k] + 1, sepPipes[k + 1]))
            : null;
        if (!sepCells || !isTableSeparatorCells(sepCells)) {
            out.push(lines[i]);
            i++;
            continue;
        }

        const cellsOf = (line, pipes) => Array.from({ length: colCount }, (_, k) => line.slice(pipes[k] + 1, pipes[k + 1]).trim());
        const rows = [cellsOf(lines[i], headPipes)];
        const aligns = sepCells.map(c => {
            const t = c.trim();
            if (/^:-+:$/.test(t)) return 'center';
            if (/^-+:$/.test(t)) return 'right';
            if (/^:-+$/.test(t)) return 'left';
            return null;
        });
        i += 2;
        while (i < lines.length) {
            const rowPipes = tableCellPipes(lines[i]);
            if (!rowPipes || rowPipes.length - 1 !== colCount) break;
            rows.push(cellsOf(lines[i], rowPipes));
            i++;
        }

        const widths = Array.from({ length: colCount }, (_, c) => Math.max(3, ...rows.map(r => r[c].length)));
        const pad = (cell, width, align) => {
            const gap = width - cell.length;
            if (align === 'right') return ' '.repeat(gap) + cell;
            if (align === 'center') { const l = Math.floor(gap / 2); return ' '.repeat(l) + cell + ' '.repeat(gap - l); }
            return cell + ' '.repeat(gap);
        };
        const renderRow = cells => `| ${cells.map((c, k) => pad(c, widths[k], aligns[k])).join(' | ')} |`;
        const renderSep = () => `| ${widths.map((w, k) => {
            const dashes = '-'.repeat(w);
            if (aligns[k] === 'center') return `:${dashes.slice(0, -2)}:`;
            if (aligns[k] === 'right') return `${dashes.slice(0, -1)}:`;
            if (aligns[k] === 'left') return `:${dashes.slice(0, -1)}`;
            return dashes;
        }).join(' | ')} |`;

        out.push(renderRow(rows[0]), renderSep());
        for (let r = 1; r < rows.length; r++) out.push(renderRow(rows[r]));
    }
    return out.join('\n');
}

/** Replaces the selection (or inserts a placeholder) wrapped in markers, via execCommand so undo keeps working. */
function wrapSelection(textarea, before, after) {
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const selected = value.slice(start, end);
    const placeholder = selected || 'texto';
    textarea.focus();
    textarea.setSelectionRange(start, end);
    document.execCommand('insertText', false, `${before}${placeholder}${after}`);
    if (!selected) textarea.setSelectionRange(start + before.length, start + before.length + placeholder.length);
}

/** Prepends a prefix to the current line (not the selection: lists/quotes/headings work on whole lines). */
function prefixLine(textarea, prefix) {
    const { selectionStart: start, value } = textarea;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = value.indexOf('\n', start) === -1 ? value.length : value.indexOf('\n', start);
    textarea.focus();
    textarea.setSelectionRange(lineStart, lineEnd);
    document.execCommand('insertText', false, prefix + value.slice(lineStart, lineEnd));
}

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
        this.listSeq = 0;
        this.slashStart = null; // caret position of "/" while the command palette is open
        this.slashQuery = '';
        this.slashIndex = 0;
        this.slashItems = [];

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
                            <textarea class="nt-body" placeholder="Escreva em Markdown… (digite / para inserir um bloco)" aria-label="Texto da anotação" spellcheck="true"></textarea>
                            <div class="nt-preview md"></div>
                        </div>
                        <div class="nt-fbar" hidden>
                            <ul class="nt-slash" role="listbox" aria-label="Inserir bloco" hidden></ul>
                            <div class="nt-fbar-row" role="toolbar" aria-label="Formatação">
                                ${FORMAT_ACTIONS.map(a => `<button type="button" class="nt-fbtn" data-fmt="${a.key}" aria-label="${a.label}" title="${a.label}">${icon(a.icon, 17)}</button>`).join('')}
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
            body: q('.nt-body'), previewEl: q('.nt-preview'), trashBtn: q('[data-act="trash"]'),
            restoreBtn: q('[data-act="restore"]'), pinBtn: q('[data-act="pin"]'),
            fbar: q('.nt-fbar'), slashEl: q('.nt-slash'),
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
            if (item) return this.openNote(item.dataset.id);
            const fmt = e.target.closest('[data-fmt]');
            if (fmt) return this.applyFormat(fmt.dataset.fmt);
            const slash = e.target.closest('[data-slash]');
            if (slash) this.pickSlash(slash.dataset.slash);
        });
        el.previewEl.addEventListener('click', e => {
            const task = e.target.closest('[data-task-index]');
            if (task) return this.toggleTaskAt(Number(task.dataset.taskIndex));
            onCodeClick(e);
        });
        el.previewEl.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const task = e.target.closest('[data-task-index]');
            if (!task) return;
            e.preventDefault();
            this.toggleTaskAt(Number(task.dataset.taskIndex));
        });
        // Clicking a toolbar/slash button must not blur the textarea (that would close the bar first)
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
        el.body.addEventListener('input', () => {
            this.edited();
            this.renderPreview();
            this.handleSlashInput();
        });
        el.body.addEventListener('focus', () => this.showFormatBar());
        el.body.addEventListener('blur', () => this.hideFormatBar());
        this.onViewportChange = () => { if (!el.fbar.hidden) this.positionFormatBar(); };
        window.visualViewport?.addEventListener('resize', this.onViewportChange);
        window.visualViewport?.addEventListener('scroll', this.onViewportChange);
        this.panel.addEventListener('keydown', e => {
            if (this.slashStart !== null && e.target === el.body) {
                if (e.key === 'ArrowDown') { e.preventDefault(); return this.moveSlash(1); }
                if (e.key === 'ArrowUp') { e.preventDefault(); return this.moveSlash(-1); }
                if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    const block = this.slashItems[this.slashIndex];
                    if (block) this.pickSlash(block.key);
                    return;
                }
                if (e.key === 'Escape') { e.preventDefault(); return this.closeSlash(); }
            }
            if (e.target === el.body && this.slashStart === null) {
                if (e.key === 'Tab' && this.handleTableTab(e.shiftKey)) { e.preventDefault(); return; }
                if (e.key === 'Enter' && !e.shiftKey && this.handleTableEnter()) { e.preventDefault(); return; }
            }
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
            const progress = n.tasks ? `<span class="nt-item-progress"><span class="nt-item-bar"><span style="width:${Math.round(n.tasks.done / n.tasks.total * 100)}%"></span></span><small>${n.tasks.done}/${n.tasks.total}</small></span>` : '';
            return `<li class="nt-row${selected ? ' selected' : ''}">
                <button type="button" class="nt-item" role="option" aria-selected="${selected}" data-id="${esc(n.id)}">
                    <span class="nt-item-title">${n.pinned ? `<span class="nt-pin">${icon('pin', 12)}</span>` : ''}${esc(n.title) || '<em>Sem título</em>'}</span>
                    <span class="nt-item-preview">${esc(preview) || '&nbsp;'}</span>
                    ${progress}
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
            this.el.root.dataset.pane = 'editor';
            await this.load({ quiet: true });
            if (!coarse()) this.el.title.focus();
        } catch (error) {
            toast(error.message, { tone: 'error' });
        }
    }

    renderPreview() {
        if (!this.current) return;
        const { previewEl } = this.el;
        previewEl.innerHTML = renderMarkdown(this.el.body.value) || '<p class="nt-none">Nada para mostrar ainda.</p>';
        void highlightIn(previewEl);
    }

    /** Toggles the Nth "- [ ]" line in the raw body (N = the clicked checkbox's data-task-index). */
    toggleTaskAt(index) {
        const note = this.current;
        if (!note || note.deletedAt) return;
        const lines = this.el.body.value.split('\n');
        let seen = -1;
        for (let li = 0; li < lines.length; li++) {
            const m = lines[li].match(/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/);
            if (!m) continue;
            seen++;
            if (seen === index) {
                lines[li] = lines[li].replace(/\[[ xX]\]/, m[1] === ' ' ? '[x]' : '[ ]');
                break;
            }
        }
        this.el.body.value = lines.join('\n');
        this.edited();
        this.renderPreview();
    }

    // ---------- formatting bar & "/" command palette ----------

    applyFormat(key) {
        if (!this.current || this.current.deletedAt) return;
        const action = FORMAT_ACTIONS.find(a => a.key === key);
        if (!action) return;
        if (action.wrap) wrapSelection(this.el.body, action.wrap[0], action.wrap[1]);
        else prefixLine(this.el.body, action.prefix);
        this.edited();
        this.renderPreview();
    }

    showFormatBar() {
        if (!this.current || this.current.deletedAt) return;
        this.el.fbar.hidden = false;
        this.positionFormatBar();
    }

    hideFormatBar() {
        this.el.fbar.hidden = true;
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
    }

    /** Detects "/" typed at the start of a line (or after a space) and opens/filters the block palette. */
    handleSlashInput() {
        const { body } = this.el;
        const { selectionStart: caret, value } = body;
        if (this.slashStart !== null) {
            const sinceSlash = value.slice(this.slashStart, caret);
            if (caret <= this.slashStart || /[\n ]/.test(sinceSlash.slice(1))) {
                this.closeSlash();
            } else {
                this.slashQuery = sinceSlash.slice(1);
                this.renderSlashMenu();
                return;
            }
        }
        const before = caret >= 2 ? value[caret - 2] : undefined;
        if (value[caret - 1] === '/' && (before === undefined || before === '\n' || before === ' ')) {
            this.slashStart = caret - 1;
            this.slashQuery = '';
            this.slashIndex = 0;
            this.renderSlashMenu();
        }
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
        this.slashStart = null;
        this.slashQuery = '';
        this.slashIndex = 0;
        this.slashItems = [];
        this.el.slashEl.hidden = true;
    }

    pickSlash(key) {
        const block = this.slashItems.find(b => b.key === key) || SLASH_BLOCKS.find(b => b.key === key);
        if (!block || this.slashStart === null) return;
        const { body } = this.el;
        const start = this.slashStart; // execCommand below fires 'input' synchronously, which closes the
        const caret = body.selectionStart; // palette and resets this.slashStart - capture it first
        body.focus();
        body.setSelectionRange(start, Math.max(caret, start));
        document.execCommand('insertText', false, block.snippet);
        if (block.caretOffset) body.setSelectionRange(start + block.caretOffset, start + block.caretOffset + (block.selectLength || 0));
        this.closeSlash();
        this.edited();
        this.renderPreview();
    }

    // ---------- Markdown tables: Tab/Enter navigate cells, "Formatar tabelas" aligns columns ----------

    /** Tab inside a table row selects the next cell (ready to type over); Shift+Tab the previous one. */
    handleTableTab(reverse) {
        if (!this.current || this.current.deletedAt) return false;
        const { body } = this.el;
        const { selectionStart: caret, value } = body;
        const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
        const lineEnd = value.indexOf('\n', caret) === -1 ? value.length : value.indexOf('\n', caret);
        const pipes = tableCellPipes(value.slice(lineStart, lineEnd));
        if (!pipes) return false;

        const cellCount = pipes.length - 1;
        const rel = caret - lineStart;
        let idx = 0;
        for (let k = 0; k < cellCount; k++) {
            if (rel >= pipes[k] && rel <= pipes[k + 1]) { idx = k; break; }
        }
        const target = reverse ? idx - 1 : idx + 1;
        if (target >= cellCount) return this.handleTableEnter(); // Tab past the last cell: start a new row
        const clamped = Math.max(0, target);
        body.focus();
        body.setSelectionRange(lineStart + pipes[clamped] + 1, lineStart + pipes[clamped + 1]);
        return true;
    }

    /** Enter on a table row (not the "---" separator) adds a new row with the same number of cells. */
    handleTableEnter() {
        if (!this.current || this.current.deletedAt) return false;
        const { body } = this.el;
        const { selectionStart: caret, value } = body;
        const lineStart = value.lastIndexOf('\n', caret - 1) + 1;
        const lineEnd = value.indexOf('\n', caret) === -1 ? value.length : value.indexOf('\n', caret);
        const line = value.slice(lineStart, lineEnd);
        const pipes = tableCellPipes(line);
        if (!pipes) return false;

        const cellCount = pipes.length - 1;
        const cells = Array.from({ length: cellCount }, (_, k) => line.slice(pipes[k] + 1, pipes[k + 1]));
        if (isTableSeparatorCells(cells)) return false; // a plain Enter on "| --- | --- |" is fine as is

        const newRow = `\n|${Array(cellCount).fill(' ').join('|')}|`;
        body.focus();
        body.setSelectionRange(lineEnd, lineEnd);
        document.execCommand('insertText', false, newRow);
        body.setSelectionRange(lineEnd + 2, lineEnd + 2); // right inside the new row's first cell
        this.edited();
        this.renderPreview();
        return true;
    }

    /** "Formatar tabelas" (editor menu): re-pads every table's columns so they line up in the raw text. */
    formatTables() {
        if (!this.current || this.current.deletedAt) return;
        const { body } = this.el;
        const formatted = formatTablesText(body.value);
        if (formatted === body.value) {
            toast('Nenhuma tabela para formatar.');
            return;
        }
        const caret = body.selectionStart;
        body.focus();
        body.setSelectionRange(0, body.value.length);
        document.execCommand('insertText', false, formatted);
        body.setSelectionRange(Math.min(caret, formatted.length), Math.min(caret, formatted.length));
        this.edited();
        this.renderPreview();
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
        const formatTables = { label: 'Formatar tabelas', icon: 'table', run: () => this.formatTables() };
        const items = note.deletedAt
            ? [copy, 'separator', { label: 'Restaurar', icon: 'restore', run: () => this.restore(note.id) }, { label: 'Excluir para sempre', icon: 'trash', danger: true, run: () => this.purge(note.id) }]
            : [copy, formatTables, 'separator', { label: 'Mover para a lixeira', icon: 'trash', danger: true, run: () => this.toTrash(note.id) }];
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
        (this.current && !this.current.deletedAt ? this.el.body : this.el.search).focus({ preventScroll: true });
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
        if (this.onViewportChange) {
            window.visualViewport?.removeEventListener('resize', this.onViewportChange);
            window.visualViewport?.removeEventListener('scroll', this.onViewportChange);
        }
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.panel.remove();
    }
}
