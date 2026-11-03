/**
 * desktopSidebar.js
 * Barra lateral do desktop (como a do Claude Desktop), com os mesmos hábitos da lista lateral do
 * celular: Nova conversa, busca, agentes, conversas abertas (bolinha online / círculo girando), Fixadas
 * e Recentes, menu da conversa (clique direito ou "⋯"), e a conta no pé. Só aparece nas abas de agente.
 * Só existe no layout de desktop ([data-desktop]); recolhe com ⌘B / Ctrl+B.
 */
import { icon } from './icons.js';
import { attachEdgeFade } from './edgeFade.js';
import { createAccountRow } from './accountRow.js';
import { agentIconName } from './agent-logos.js';
import { fetchConversations, conversationRows, updateConversation } from '../agent/conversations.js';
import { conversationMenuItems } from '../agent/conversationMenu.js';
import { showMenu } from './contextMenu.js';
import { toast } from './toast.js';
import { haptic } from './haptics.js';

const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BUBBLE = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7.5 19.2 4 20.5l1.1-3.4A8 8 0 1 1 7.5 19.2Z"/></svg>`;
const COLLAPSED_KEY = 'meuterminal-sidebar-recolhida';
const AGENT_KEY = 'meuterminal-sidebar-agente';
const FOLDER_KEY = 'meuterminal-sidebar-so-pasta';
const APPS = [
    { kind: 'terminal', label: 'Terminal', icon: 'terminal', color: 'green' },
    { kind: 'files', label: 'Arquivos', icon: 'folder', color: 'orange', flag: 'filesAvailable' },
    { kind: 'notes', label: 'Anotações', icon: 'notes', color: 'yellow', flag: 'notesAvailable' },
    { kind: 'browser', label: 'Navegador', icon: 'globe', color: 'blue', flag: 'browserAvailable' },
];

async function api(method, route, body) {
    const r = await fetch(`${basePath()}/api/${route}`, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
    return data;
}

function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return 'ontem';
    if (days < 7) return d.toLocaleDateString('pt-BR', { weekday: 'short' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export default class DesktopSidebar {
    /**
     * @param {object} opts
     * @param {any} opts.workspace - TerminalManager
     * @param {() => void} opts.openSettings
     */
    constructor({ workspace, openSettings }) {
        this.ws = workspace;
        this.openSettings = openSettings;
        this.agents = [];
        this.agent = localStorage.getItem(AGENT_KEY) || 'claude';
        this.history = null;
        this.historyFolder = null;
        this.onlyFolder = localStorage.getItem(FOLDER_KEY) === '1';
        this.error = null;
        this.archived = null; // null = seção fechada
        this.keepUnread = null;
        this.pins = [];
        this.query = '';
        this.sig = '';

        this.el = document.createElement('aside');
        this.el.className = 'dk-side';
        this.el.setAttribute('aria-label', 'Conversas e apps');
        this.el.innerHTML = `
            <div class="dk-side-head">
                <button type="button" class="dk-icon" data-dk="toggle" aria-label="Recolher a barra lateral" title="Recolher a barra lateral">${icon('panelLeft', 18)}</button>
                <span class="dk-brand">MeuTerminal</span>
                <div class="dk-agents" role="tablist" aria-label="Agente"></div>
            </div>
            <div class="dk-nav">
                <button type="button" class="dk-new dk-row" data-dk="new">${icon('plus', 18)}<span class="dk-row-title">Nova conversa</span></button>
                <label class="dk-search dk-row">${icon('search', 18)}<input type="search" placeholder="Buscar" aria-label="Buscar conversas" spellcheck="false"></label>
            </div>
            <nav class="dk-scroll"><div class="dk-convs"></div></nav>
            <div class="dk-side-foot"></div>`;
        this.account = createAccountRow({
            getAgentId: () => this.agent,
            getSession: () => (this.ws.active?.kind === 'agent' ? this.ws.active : null),
            showTab: id => this.ws.activate(id, { focus: true }),
            className: 'dk-row',
        });
        this.el.querySelector('.dk-side-foot').appendChild(this.account.el);
        document.body.appendChild(this.el);
        this.reopen = document.createElement('button');
        this.reopen.type = 'button';
        this.reopen.className = 'dk-reopen';
        this.reopen.setAttribute('aria-label', 'Mostrar a barra lateral (⌘B)');
        this.reopen.title = 'Mostrar a barra lateral (⌘B)';
        this.reopen.innerHTML = icon('panelLeft', 18);
        document.body.appendChild(this.reopen);
        this.convs = this.el.querySelector('.dk-convs');
        attachEdgeFade(this.el.querySelector('.dk-scroll'));
        this.agentsEl = this.el.querySelector('.dk-agents');
        this.input = this.el.querySelector('.dk-search input');
        this.setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1', false);
        this.bind();
        this.loadAgents();
        this.refresh();
        this.timer = setInterval(() => { if (document.visibilityState === 'visible' && !this.collapsed && !document.documentElement.hasAttribute('data-no-sidebar')) this.refresh(); }, 3000);
    }

    // ---------- estado ----------

    setCollapsed(on, save = true) {
        this.collapsed = on;
        document.documentElement.toggleAttribute('data-sidebar-collapsed', on);
        if (save) localStorage.setItem(COLLAPSED_KEY, on ? '1' : '0');
        // o terminal recalcula o tamanho depois da animação
        setTimeout(() => window.dispatchEvent(new Event('resize')), 260);
    }

    toggle() { this.setCollapsed(!this.collapsed); }

    focusSearch() {
        if (this.collapsed) this.setCollapsed(false);
        this.input.focus();
        this.input.select();
    }

    /** O agente da aba ativa (se for de agente) manda na lista. */
    syncActive() {
        const s = this.ws.active;
        // A lista é da conversa: nas outras abas ela some e a tela fica inteira
        const inChat = s?.kind === 'agent';
        if (document.documentElement.hasAttribute('data-no-sidebar') === inChat) {
            document.documentElement.toggleAttribute('data-no-sidebar', !inChat);
            setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
        }
        if (!inChat) return;
        void this.account.sync();
        if (s && s.kind === 'agent' && s.session?.agent && s.session.agent !== this.agent) return this.setAgent(s.session.agent);
        if (this.onlyFolder && this.ws.currentFolder() !== this.historyFolder) return this.refresh();
        this.render();
    }

    setAgent(id) {
        this.agent = id;
        void this.account.sync();
        localStorage.setItem(AGENT_KEY, id);
        this.sig = '';
        this.history = null;
        this.refresh();
    }

    async loadAgents() {
        try {
            const r = await api('GET', 'agents');
            this.agents = (r.agents || []).filter(a => !a.terminalOnly && a.installed);
            this.ws.agentList = r.agents || this.ws.agentList;
            if (this.agents.length && !this.agents.some(a => a.id === this.agent)) this.agent = this.agents[0].id;
        } catch { this.agents = []; }
        this.renderAgents();
    }

    /** A lista vem inteira do SQL (uma consulta barata): é o que mantém tudo igual e sem sumiço. */
    async refresh() {
        const agent = this.agent;
        const folder = this.onlyFolder ? this.ws.currentFolder() : null;
        this.historyFolder = this.ws.currentFolder();
        try {
            const [list, pins, archived] = await Promise.all([fetchConversations(agent, { cwd: folder }), api('GET', 'agent-pins').catch(() => null),
                this.archived ? fetchConversations(agent, { cwd: folder, archived: true }) : null]);
            if (agent !== this.agent) return;
            if (pins) this.pins = pins.pins || [];
            if (archived) this.archived = archived;
            this.clearCurrentUnread(list);
            const sig = JSON.stringify([list, this.pins, folder, archived]);
            this.error = null;
            this.history = list;
            if (sig !== this.sig) { this.sig = sig; this.render(); }
        } catch (e) {
            // Mantém a lista que já estava na tela; só avisa se nunca carregou
            this.error = e.message;
            if (this.history === null) this.render();
        }
    }

    /** Você está olhando a conversa: ela deixa de ser não lida (com a janela à vista). */
    clearCurrentUnread(list) {
        const active = this.ws.active;
        const acp = active?.kind === 'agent' ? active.session?.acpSessionId : null;
        if (this.keepUnread && this.keepUnread !== acp) this.keepUnread = null;
        const row = acp && list.find(c => c.acpSessionId === acp);
        if (!row?.unread || this.keepUnread === acp || document.visibilityState !== 'visible') return;
        row.unread = false;
        updateConversation(this.agent, acp, { unread: false }).catch(() => {});
    }

    // ---------- desenho ----------

    renderAgents() {
        this.agentsEl.hidden = this.agents.length < 2;
        this.agentsEl.innerHTML = this.agents.map(a => `<button type="button" role="tab" class="dk-agent" data-agent="${esc(a.id)}"
            aria-selected="${a.id === this.agent}" title="${esc(a.label)}">${icon(agentIconName(a.id), 13)}<span>${esc(a.label)}</span></button>`).join('');
    }

    render() {
        this.renderAgents();
        const active = this.ws.active?.kind === 'agent' && this.ws.active.session?.agent === this.agent ? this.ws.active : null;
        const q = this.query.trim().toLowerCase();
        const rows = conversationRows(this.history || [], active);
        this.rows = new Map(rows.map(r => [r.key, r]));
        const match = r => !q || `${r.title || ''} ${r.cwd || ''}`.toLowerCase().includes(q);
        const pinned = rows.filter(r => r.acp && this.pins.includes(r.acp) && match(r));
        const recent = rows.filter(r => !(r.acp && this.pins.includes(r.acp)) && match(r));
        const row = r => `<li><button type="button" class="dk-row dk-conv${r.current ? ' is-current' : ''}${r.unread ? ' is-unread' : ''}" data-key="${esc(r.key)}" ${r.current ? 'aria-current="true"' : ''} title="${esc(r.title || '')}${r.cwd ? ` · ${esc(r.cwd)}` : ''}">
                <span class="dk-conv-ic">${r.working ? '<span class="cv-spin" aria-label="trabalhando"></span>' : BUBBLE}</span>
                <span class="dk-row-title">${esc(r.title || 'Sem título')}</span>
                ${r.unread || r.waiting ? `<span class="conv-unread${r.waiting ? ' is-waiting' : ''}" aria-label="${r.waiting ? 'esperando você' : 'não lida'}"></span>` : ''}
                ${r.online ? '<span class="cv-online" aria-label="agente ligado"></span>' : `<span class="dk-when">${esc(when(r.at))}</span>`}
                ${r.acp ? `<span class="dk-more" data-more aria-label="Mais ações" role="button">${icon('more', 15)}</span>` : ''}
            </button></li>`;
        let html = '';
        if (pinned.length) html += `<h3 class="dk-section">Fixadas</h3><ul class="dk-ul">${pinned.map(row).join('')}</ul>`;
        html += `<h3 class="dk-section">Recentes <button type="button" class="dk-filter" data-dk="folder" aria-pressed="${this.onlyFolder}"
            title="${this.onlyFolder ? `Só de ${esc(this.historyFolder || '')}. Clique para ver todas` : 'Clique para ver só as desta pasta'}">${this.onlyFolder ? `só ${esc(this.historyFolder || '')}` : 'todas as pastas'}</button></h3>`;
        if (this.history === null && !this.error) html += '<p class="dk-note"><span class="cv-spin"></span> Carregando…</p>';
        else if (this.history === null) html += `<p class="dk-note">Não deu para carregar. <button type="button" class="ag-link" data-dk="retry">Tentar de novo</button></p>`;
        else if (!recent.length) html += `<p class="dk-note">${q ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa ainda.'}</p>`;
        else html += `<ul class="dk-ul">${recent.slice(0, q ? 300 : 60).map(row).join('')}</ul>`;
        if (this.archived) {
            const rowsA = conversationRows(this.archived, null).map(r => ({ ...r, archived: true }));
            rowsA.forEach(r => this.rows.set(r.key, r));
            html += `<h3 class="dk-section">Arquivadas <button type="button" class="dk-filter" data-dk="archived">ocultar</button></h3>`
                + (rowsA.length ? `<ul class="dk-ul">${rowsA.filter(match).map(row).join('')}</ul>` : '<p class="dk-note">Nenhuma conversa arquivada.</p>');
        } else {
            html += '<button type="button" class="dk-filter dk-archived" data-dk="archived">Ver arquivadas</button>';
        }
        this.convs.innerHTML = html;
    }

    // ---------- ações ----------

    newConversation() {
        haptic('light');
        return this.ws.createAgent(this.agent, this.ws.settings?.get('defaultCwd') || this.ws.currentFolder());
    }

    pick(key) {
        const r = this.rows?.get(key);
        if (!r || r.current) return;
        // Só abre para ler: o agente sobe se você enviar uma mensagem
        return this.ws.openAgentConversation(this.agent, { acpSessionId: r.acp, title: r.title, cwd: r.cwd });
    }

    async togglePin(acp) {
        const next = this.pins.includes(acp) ? this.pins.filter(p => p !== acp) : [acp, ...this.pins];
        try {
            const r = await api('PUT', 'agent-pins', { pins: next });
            this.pins = r.pins || next;
        } catch (e) { toast(e.message, { tone: 'error' }); }
        this.render();
    }

    rowMenu(key, anchor) {
        const r = this.rows?.get(key);
        if (!r?.acp) return;
        const items = [...conversationMenuItems({
            agent: this.agent, row: r, pins: this.pins,
            togglePin: acp => this.togglePin(acp),
            openTab: opts => this.ws.create(opts),
            refresh: () => this.refresh(),
            afterDeleteCurrent: () => this.newConversation(),
            keepUnread: acp => { if (r.current) this.keepUnread = acp; },
        })];
        showMenu(items, { anchor, label: 'Conversa' });
    }

    /** Itens da paleta ⌘K: conversas deste agente e os apps. */
    paletteItems() {
        const convs = [...(this.rows?.values() || [])].map(r => ({
            group: 'Conversas', label: r.title || 'Sem título', hint: r.open ? 'aberta' : when(r.at), icon: 'history', run: () => this.pick(r.key),
        }));
        const apps = APPS.filter(a => !a.flag || window.appConfig?.[a.flag]).map(a => ({
            group: 'Apps', label: a.label, icon: a.icon, run: () => this.openApp(a.kind),
        }));
        return [...convs, ...apps];
    }

    openApp(kind) {
        if (kind === 'notes') {
            const notes = [...this.ws.sessions.values()].find(x => x.kind === 'notes');
            if (notes) return this.ws.activate(notes.id, { focus: true });
        }
        if (kind === 'files') return this.ws.create({ kind: 'files', cwd: this.ws.currentFolder() === '~' ? undefined : this.ws.currentFolder() });
        return this.ws.create({ kind });
    }

    bind() {
        this.el.addEventListener('click', e => {
            const more = e.target.closest('[data-more]');
            const conv = e.target.closest('.dk-conv');
            if (more && conv) { e.stopPropagation(); return this.rowMenu(conv.dataset.key, more); }
            if (conv) return this.pick(conv.dataset.key);
            const agentBtn = e.target.closest('[data-agent]');
            if (agentBtn) return this.setAgent(agentBtn.dataset.agent);
            const act = e.target.closest('[data-dk]')?.dataset.dk;
            if (act === 'toggle') this.toggle();
            else if (act === 'new') this.newConversation();
            else if (act === 'retry') this.refresh();
            else if (act === 'archived') {
                this.archived = this.archived ? null : [];
                this.sig = '';
                this.refresh();
            }
            else if (act === 'folder') {
                this.onlyFolder = !this.onlyFolder;
                localStorage.setItem(FOLDER_KEY, this.onlyFolder ? '1' : '0');
                this.history = null;
                this.refresh();
            }
        });
        this.el.addEventListener('contextmenu', e => {
            const conv = e.target.closest('.dk-conv');
            if (!conv) return;
            e.preventDefault();
            this.rowMenu(conv.dataset.key, conv);
        });
        this.reopen.addEventListener('click', () => this.setCollapsed(false));
        this.input.addEventListener('input', () => { this.query = this.input.value; this.render(); });
        this.input.addEventListener('keydown', e => {
            if (e.key === 'Escape') { this.input.value = ''; this.query = ''; this.render(); this.input.blur(); }
            if (e.key === 'Enter') this.convs.querySelector('.dk-conv')?.click();
        });
    }
}
