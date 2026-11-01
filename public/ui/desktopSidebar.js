/**
 * desktopSidebar.js
 * Barra lateral do desktop (como a do Claude Desktop), com os mesmos hábitos da lista lateral do
 * celular: Nova conversa, busca, agente em pílulas, conversas abertas (bolinha online / círculo
 * girando), Fixadas e Recentes da pasta, apagar e fixar (clique direito ou "⋯"), Apps e Ajustes.
 * Só existe no layout de desktop ([data-desktop]); recolhe com ⌘B / Ctrl+B.
 */
import { icon } from './icons.js';
import { showMenu } from './contextMenu.js';
import { askConfirm } from './prompt.js';
import { toast } from './toast.js';
import { haptic } from './haptics.js';

const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WORKING = new Set(['thinking', 'waiting_permission', 'starting']);
const BUBBLE = `<svg class="icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7.5 19.2 4 20.5l1.1-3.4A8 8 0 1 1 7.5 19.2Z"/></svg>`;
const COLLAPSED_KEY = 'meuterminal-sidebar-recolhida';
const AGENT_KEY = 'meuterminal-sidebar-agente';
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
        this.open = [];
        this.history = null;
        this.historyFolder = null;
        this.pins = [];
        this.query = '';
        this.sig = '';
        this.canDelete = false;

        this.el = document.createElement('aside');
        this.el.className = 'dk-side';
        this.el.setAttribute('aria-label', 'Conversas e apps');
        this.el.innerHTML = `
            <div class="dk-side-head">
                <button type="button" class="dk-icon" data-dk="toggle" aria-label="Recolher a barra lateral (⌘B)" title="Recolher (⌘B)">${icon('panelLeft', 18)}</button>
                <span class="dk-brand">MeuTerminal</span>
            </div>
            <button type="button" class="dk-new" data-dk="new">${icon('plus', 17)}<span>Nova conversa</span><kbd>${/Mac/.test(navigator.platform) ? '⌘⇧O' : 'Ctrl+Alt+J'}</kbd></button>
            <label class="dk-search">${icon('search', 15)}<input type="search" placeholder="Buscar conversas" aria-label="Buscar conversas" spellcheck="false"></label>
            <div class="dk-agents" role="tablist" aria-label="Agente"></div>
            <nav class="dk-scroll">
                <div class="dk-convs"></div>
                <h3 class="dk-section">Apps</h3>
                <ul class="dk-ul dk-apps">${APPS.filter(a => !a.flag || window.appConfig?.[a.flag]).map(a => `
                    <li><button type="button" class="dk-row" data-app="${a.kind}">
                        <span class="dk-app-ic" style="--tc: var(--c-${a.color})">${icon(a.icon, 14)}</span><span class="dk-row-title">${a.label}</span>
                    </button></li>`).join('')}</ul>
            </nav>
            <div class="dk-side-foot">
                <button type="button" class="dk-row" data-dk="settings">${icon('settings', 17)}<span class="dk-row-title">Ajustes</span></button>
            </div>`;
        document.body.appendChild(this.el);
        this.reopen = document.createElement('button');
        this.reopen.type = 'button';
        this.reopen.className = 'dk-reopen';
        this.reopen.setAttribute('aria-label', 'Mostrar a barra lateral (⌘B)');
        this.reopen.title = 'Mostrar a barra lateral (⌘B)';
        this.reopen.innerHTML = icon('panelLeft', 18);
        document.body.appendChild(this.reopen);
        this.convs = this.el.querySelector('.dk-convs');
        this.agentsEl = this.el.querySelector('.dk-agents');
        this.input = this.el.querySelector('.dk-search input');
        this.setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1', false);
        this.bind();
        this.loadAgents();
        this.refresh();
        this.timer = setInterval(() => { if (document.visibilityState === 'visible' && !this.collapsed) this.refreshOpen(); }, 3000);
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
        if (s && s.kind === 'agent' && s.session?.agent && s.session.agent !== this.agent) {
            this.setAgent(s.session.agent);
            return;
        }
        const folder = this.ws.currentFolder();
        if (folder !== this.historyFolder) this.loadHistory();
        else this.render();
    }

    setAgent(id) {
        this.agent = id;
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

    refresh() {
        this.refreshOpen();
        this.loadHistory();
        api('GET', 'agent-pins').then(p => { this.pins = Array.isArray(p) ? p : p.pins || []; this.render(); }).catch(() => {});
    }

    async refreshOpen() {
        try {
            const r = await api('GET', `agent-sessions?agent=${encodeURIComponent(this.agent)}`);
            const sig = JSON.stringify([r.sessions, r.canDelete]);
            if (sig === this.sig) return;
            this.sig = sig;
            this.open = (r.sessions || []).filter(s => s.status !== 'closed');
            this.canDelete = !!r.canDelete;
            this.render();
        } catch { /* tenta no próximo ciclo */ }
    }

    async loadHistory() {
        const folder = this.ws.currentFolder();
        const agent = this.agent;
        this.historyFolder = folder;
        this.render();
        try {
            const r = await api('GET', `agent-history?agent=${encodeURIComponent(agent)}&cwd=${encodeURIComponent(folder)}`);
            if (agent !== this.agent || folder !== this.historyFolder) return;
            this.history = r.sessions || [];
        } catch {
            this.history = []; // sem histórico: só não lista (nada de aviso de "indisponível")
        }
        this.render();
    }

    // ---------- desenho ----------

    renderAgents() {
        this.agentsEl.hidden = this.agents.length < 2;
        this.agentsEl.innerHTML = this.agents.map(a => `<button type="button" role="tab" class="dk-agent" data-agent="${esc(a.id)}"
            aria-selected="${a.id === this.agent}">${esc(a.label)}</button>`).join('');
    }

    render() {
        this.renderAgents();
        const active = this.ws.active;
        const curId = active?.kind === 'agent' ? active.agentSessionId : null;
        const curAcp = active?.kind === 'agent' ? active.session?.acpSessionId : null;
        const q = this.query.trim().toLowerCase();
        const history = this.history || [];
        const known = new Set(history.map(h => h.sessionId));
        // Parada e fora do histórico (sem mensagens, ou apagada): não dá para retomar, não aparece
        const opens = this.open.filter(o => o.id === curId || o.status !== 'stopped'
            || (o.acpSessionId && (this.history === null || known.has(o.acpSessionId))));
        const byAcp = new Map(opens.filter(o => o.acpSessionId).map(o => [o.acpSessionId, o]));
        const rows = [
            ...opens.filter(o => !o.acpSessionId || !known.has(o.acpSessionId))
                .map(o => ({ key: `open:${o.id}`, acp: o.acpSessionId, title: o.title || 'Nova conversa', open: o, at: null })),
            ...history.map(h => ({ key: h.sessionId, acp: h.sessionId, title: h.title, open: byAcp.get(h.sessionId) || null, at: h.updatedAt })),
        ];
        this.rows = new Map(rows.map(r => [r.key, r]));
        const match = r => !q || (r.title || '').toLowerCase().includes(q);
        const pinned = rows.filter(r => r.acp && this.pins.includes(r.acp) && match(r));
        const recent = rows.filter(r => !(r.acp && this.pins.includes(r.acp)) && match(r));
        const row = r => {
            const cur = (r.open && r.open.id === curId) || (r.acp && r.acp === curAcp);
            const working = r.open && WORKING.has(r.open.status);
            const online = r.open && r.open.status !== 'stopped';
            return `<li><button type="button" class="dk-row dk-conv${cur ? ' is-current' : ''}" data-key="${esc(r.key)}" ${cur ? 'aria-current="true"' : ''} title="${esc(r.title || '')}">
                <span class="dk-conv-ic">${working ? '<span class="cv-spin" aria-label="trabalhando"></span>' : BUBBLE}</span>
                <span class="dk-row-title">${esc(r.title || 'Sem título')}</span>
                ${online ? '<span class="cv-online" aria-label="aberta"></span>' : `<span class="dk-when">${esc(when(r.at))}</span>`}
                <span class="dk-more" data-more aria-label="Mais ações" role="button">${icon('more', 15)}</span>
            </button></li>`;
        };
        let html = '';
        if (pinned.length) html += `<h3 class="dk-section">Fixadas</h3><ul class="dk-ul">${pinned.map(row).join('')}</ul>`;
        html += `<h3 class="dk-section">Recentes <span class="dk-folder" title="${esc(this.historyFolder || '')}">${esc(this.historyFolder || '')}</span></h3>`;
        if (this.history === null && !rows.length) html += '<p class="dk-note"><span class="cv-spin"></span> Carregando…</p>';
        else if (!recent.length) html += `<p class="dk-note">${q ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa nesta pasta ainda.'}</p>`;
        else html += `<ul class="dk-ul">${recent.slice(0, q ? 200 : 40).map(row).join('')}</ul>`;
        this.convs.innerHTML = html;
    }

    // ---------- ações ----------

    newConversation() {
        haptic('light');
        return this.ws.createAgent(this.agent, this.ws.currentFolder());
    }

    pick(key) {
        const r = this.rows?.get(key);
        if (!r) return;
        if (r.open) return this.ws.openAgentConversation(this.agent, { session: r.open });
        return this.ws.openAgentConversation(this.agent, { acpSessionId: r.acp, title: r.title });
    }

    async togglePin(acp) {
        const next = this.pins.includes(acp) ? this.pins.filter(p => p !== acp) : [acp, ...this.pins];
        try {
            const r = await api('PUT', 'agent-pins', { pins: next });
            this.pins = r.pins || next;
        } catch (e) { toast(e.message, { tone: 'error' }); }
        this.render();
    }

    async remove(key) {
        const r = this.rows?.get(key);
        if (!r?.acp) return;
        if (!await askConfirm({ title: 'Apagar conversa', message: `Apagar "${r.title || 'Sem título'}"? Ela vai para a lixeira do servidor.`, confirm: 'Apagar', danger: true })) return;
        try {
            await api('DELETE', `agent-history/${encodeURIComponent(this.agent)}/${encodeURIComponent(r.acp)}`);
            if (this.history) this.history = this.history.filter(h => h.sessionId !== r.acp);
            this.open = this.open.filter(o => o.acpSessionId !== r.acp);
            if (this.pins.includes(r.acp)) await this.togglePin(r.acp);
            this.render();
            toast('Conversa apagada.');
        } catch (e) { toast(e.message, { tone: 'error', duration: 6000 }); }
    }

    rowMenu(key, anchor) {
        const r = this.rows?.get(key);
        if (!r) return;
        showMenu([
            { label: 'Abrir', icon: 'bot', run: () => this.pick(key) },
            ...(r.acp ? [{ label: this.pins.includes(r.acp) ? 'Desafixar' : 'Fixar', icon: 'pin', run: () => this.togglePin(r.acp) }] : []),
            ...(r.acp ? [{ label: 'Apagar', icon: 'trash', disabled: !this.canDelete, hint: this.canDelete ? '' : 'não disponível neste agente', run: () => this.remove(key) }] : []),
        ], { anchor, label: 'Conversa' });
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
            const app = e.target.closest('[data-app]');
            if (app) return this.openApp(app.dataset.app);
            const act = e.target.closest('[data-dk]')?.dataset.dk;
            if (act === 'toggle') this.toggle();
            else if (act === 'new') this.newConversation();
            else if (act === 'settings') this.openSettings();
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
