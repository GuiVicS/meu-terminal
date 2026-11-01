/**
 * agentSession.js
 * Agent UI tab (kind 'agent'): a conversation with a coding agent (Claude, OpenCode, Codex)
 * through the server's agent gateway. Chat + tool cards (public/agent/conversation.js), message
 * box (composer.js) and a side panel with plan, subagents, changed files and usage (sidepanel.js).
 * Same interface as TerminalSession, so tabs, status bar and menus work with it.
 */
import { STATE, SESSION_COLORS } from './session.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { showMenu } from '../ui/contextMenu.js';
import Conversation from '../agent/conversation.js';
import Composer from '../agent/composer.js';
import SidePanel from '../agent/sidepanel.js';
import { esc } from '../agent/markdown.js';
import { isIphonePortrait } from '../ui/device.js';

const MAX_RECONNECT_ATTEMPTS = 8;
const CLOSE_SESSION_GONE = 4404;
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const wide = () => window.matchMedia('(min-width: 1100px)').matches;

const STATUS = {
    starting: { label: 'Iniciando', tone: 'busy' },
    idle: { label: 'Pronto', tone: 'ok' },
    thinking: { label: 'Trabalhando', tone: 'busy' },
    waiting_permission: { label: 'Aguardando você', tone: 'warn' },
    error: { label: 'Erro', tone: 'bad' },
    stopped: { label: 'Parado', tone: 'bad' },
    closed: { label: 'Encerrado', tone: 'bad' },
};

const ROUTE_LABELS = { direto: 'Direto', economia: 'Economia de tokens', omniroute: 'Outros modelos' };

async function api(method, route, body) {
    const response = await fetch(`${basePath()}/api/${route}`, {
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
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
    return data;
}

export default class AgentSession {
    /**
     * @param {object} opts
     * @param {object} opts.row - tab from /api/sessions (kind 'agent', url = agent session id)
     * @param {object} opts.settings - SettingsManager
     * @param {object} opts.hooks - callbacks into the workspace
     */
    constructor({ row, settings, hooks }) {
        this.kind = 'agent';
        this.id = row.id;
        this.agentSessionId = row.url;
        this.name = row.name;
        this.pinned = !!row.pinned;
        this.color = SESSION_COLORS.includes(row.color) ? row.color : 'purple';
        this.settings = settings;
        this.hooks = hooks;

        // Fields the rest of the app reads from terminal sessions
        this.state = STATE.CONNECTING;
        this.shell = 'agente';
        this.startCwd = row.cwd || '';
        this.cwd = row.cwd || null;
        this.process = null;
        this.branch = null;
        this.pid = null;
        this.terminal = null;
        this.addons = null;
        this.hasActivity = false;

        this.session = null;      // agent session snapshot (capabilities, mode, status...)
        this.status = 'starting';
        this.lastSeq = 0;         // replay point for reconnects
        this.pending = new Map(); // permissionId -> permission.request data
        this.active = false;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.disposed = false;
        this.timers = new Set();
        this.panelOpen = null;    // null = automatic (open on wide screens)

        this.panel = document.createElement('div');
        this.panel.className = 'terminal-panel agent-panel';
        this.panel.id = `panel-${this.id}`;
        this.panel.setAttribute('role', 'tabpanel');
        this.panel.setAttribute('aria-labelledby', `tab-${this.id}`);
    }

    get sizeLabel() {
        return '';
    }

    // ---------- view ----------

    mount(parent) {
        parent.appendChild(this.panel);
        this.panel.innerHTML = `
            <header class="ag-head">
                <span class="ag-head-icon">${icon('bot', 18)}</span>
                <div class="ag-head-text">
                    <div class="ag-head-title"></div>
                    <div class="ag-head-sub"><span class="ag-agent"></span> · <span class="ag-cwd mono"></span></div>
                </div>
                <span class="ag-status" role="status"></span>
                <button type="button" class="btn btn-ghost btn-sm ag-publish" data-act="vibe-publish" aria-label="Publicar no Vercel" title="Publicar no Vercel" hidden>${icon('cloudUpload', 16)} <span class="ag-publish-label">Publicar</span></button>
                <button type="button" class="icon-btn" data-act="vibe-agent" aria-label="Trocar agente" title="Trocar agente (vibecoding)" hidden>${icon('swap', 18)}</button>
                <button type="button" class="btn btn-ghost btn-sm ag-route" data-act="route" aria-haspopup="menu" title="Rota do Claude Code" hidden></button>
                <button type="button" class="icon-btn" data-act="history" aria-label="Conversas">${icon('history', 18)}</button>
                <button type="button" class="icon-btn" data-act="terminal" aria-label="Abrir terminal nesta pasta">${icon('terminal', 18)}</button>
                <button type="button" class="icon-btn" data-act="files" aria-label="Abrir os arquivos da pasta">${icon('folder', 18)}</button>
                <button type="button" class="icon-btn" data-act="panel" aria-label="Painel do agente" aria-expanded="false">${icon('panelLeft', 18)}</button>
            </header>
            <div class="ag-banner" role="status" hidden></div>
            <div class="ag-body">
                <div class="ag-main">
                    <div class="ag-log" role="log" aria-label="Conversa com o agente" tabindex="0">
                        <div class="ag-empty">${icon('bot', 28)}<p>Conectando ao agente…</p></div>
                    </div>
                    <button type="button" class="ag-jump" hidden aria-label="Ir para o fim">${icon('chevronDown', 18)}</button>
                    <div class="ag-pending" hidden></div>
                    <div class="ag-composer"></div>
                </div>
                <aside class="ag-side" aria-label="Painel do agente"></aside>
                <div class="ag-side-scrim" hidden></div>
            </div>`;
        const q = sel => this.panel.querySelector(sel);
        this.el = {
            title: q('.ag-head-title'), agent: q('.ag-agent'), cwd: q('.ag-cwd'), status: q('.ag-status'),
            banner: q('.ag-banner'), body: q('.ag-body'), log: q('.ag-log'), jump: q('.ag-jump'),
            pending: q('.ag-pending'), side: q('.ag-side'), panelBtn: q('[data-act="panel"]'),
            scrim: q('.ag-side-scrim'),
            vibeBtn: q('[data-act="vibe-agent"]'), publishBtn: q('[data-act="vibe-publish"]'),
        };
        // On the iPhone the panel is a sheet: tapping outside closes it, like every other sheet
        this.el.scrim.addEventListener('click', () => {
            this.panelOpen = false;
            this.applyPanel();
        });
        this.vibeProject = null; // set once checkVibeProject() resolves, if this tab belongs to one
        this.conversation = new Conversation(this.el.log, {
            cwd: () => this.cwd,
            onPermission: (permissionId, optionId) => this.answerPermission(permissionId, optionId),
            onOpenFile: path => this.openFile(path),
        });
        this.composer = new Composer(q('.ag-composer'), {
            cwd: () => this.cwd,
            onSend: msg => this.sendPrompt(msg),
            onCancel: () => this.action('cancel').catch(e => toast(e.message, { tone: 'error' })),
            onMode: modeId => this.action('mode', { modeId }).then(s => this.applySession(s)).catch((e) => { toast(e.message, { tone: 'error' }); throw e; }),
            onConfig: (configId, value) => this.action('config', { configId, value }).then(s => this.applySession(s)).catch((e) => { toast(e.message, { tone: 'error' }); throw e; }),
            searchFiles: query => this.searchFiles(query),
            onLocalCommand: (name, args) => this.runLocalCommand(name, args),
            onQueueRemove: itemId => api('DELETE', `agent-sessions/${encodeURIComponent(this.agentSessionId)}/queue/${encodeURIComponent(itemId)}`)
                .catch((e) => { toast(e.message, { tone: 'error' }); throw e; }),
        });
        this.side = new SidePanel(this.el.side, {
            cwd: () => this.cwd,
            onOpenFile: path => this.openFile(path),
            onCommand: name => this.composer.insert(`/${name} `),
            onShowTool: toolId => this.showTool(toolId),
        });
        this.side.render();

        this.panel.querySelector('.ag-head').addEventListener('click', e => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            if (btn.dataset.act === 'panel') this.togglePanel();
            else if (btn.dataset.act === 'terminal') this.hooks.openTab({ cwd: this.cwd || undefined, afterId: this.id });
            else if (btn.dataset.act === 'files') this.hooks.openTab({ kind: 'files', url: 'local', cwd: this.cwd || undefined, afterId: this.id });
            else if (btn.dataset.act === 'history') this.openHistory(btn);
            else if (btn.dataset.act === 'route') this.openRouteMenu(btn);
            else if (btn.dataset.act === 'vibe-agent') this.openVibeAgentMenu(btn);
            else if (btn.dataset.act === 'vibe-publish') this.publishVibeProject();
        });
        this.el.banner.addEventListener('click', e => {
            if (e.target.closest('[data-resume]')) this.resume();
            if (e.target.closest('[data-reconnect]')) this.reconnectIfDropped();
        });
        this.el.pending.addEventListener('click', e => {
            const b = e.target.closest('[data-option]');
            if (b) this.answerPermission(b.dataset.perm, b.dataset.option);
            else if (e.target.closest('[data-goto]')) this.el.log.querySelector('.ag-perm:not(.answered)')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
        this.el.log.addEventListener('scroll', () => {
            this.el.jump.hidden = this.conversation.nearBottom();
        }, { passive: true });
        this.el.jump.addEventListener('click', () => {
            this.el.log.scrollTop = this.el.log.scrollHeight;
        });
        this.mediaQuery = window.matchMedia('(min-width: 1100px)');
        this.onMedia = () => this.applyPanel();
        this.mediaQuery.addEventListener('change', this.onMedia);
        this.applyPanel();
        this.renderHead();
        this.connect();
        void this.checkVibeProject();
    }

    /** Only vibecoding tabs get the agent switcher and "Publicar" - a plain agent conversation has no project. */
    async checkVibeProject() {
        try {
            this.vibeProject = await api('GET', `vibe/tab/${encodeURIComponent(this.id)}`);
            if (!this.vibeProject) return;
            this.el.vibeBtn.hidden = false;
            this.el.publishBtn.hidden = !this.vibeProject.can_publish;
        } catch {
            this.vibeProject = null;
        }
    }

    async openVibeAgentMenu(anchor) {
        if (!this.vibeProject) return;
        let agentOptions = [];
        try {
            ({ agents: agentOptions } = await api('GET', 'vibe/kinds'));
        } catch (e) {
            toast(e.message, { tone: 'error' });
            return;
        }
        const used = new Map(this.vibeProject.agents.map(a => [a.agent, a]));
        const items = agentOptions.filter(a => a.installed || used.has(a.id)).map(a => ({
            label: used.has(a.id) ? a.label : `${a.label} (nova conversa)`,
            icon: a.id === this.session?.agent ? 'check' : 'bot',
            run: () => this.switchVibeAgent(a.id),
        }));
        if (!items.length) {
            toast('Nenhum outro agente instalado para trocar.');
            return;
        }
        showMenu(items, { anchor, label: 'Trocar agente' });
    }

    async switchVibeAgent(agent) {
        if (agent === this.session?.agent) return;
        try {
            await api('POST', `vibe/${encodeURIComponent(this.vibeProject.id)}/open`, { agent });
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    }

    async publishVibeProject() {
        if (!this.vibeProject) return;
        const btn = this.el.publishBtn;
        if (btn.classList.contains('loading')) return;
        const label = btn.querySelector('.ag-publish-label');
        btn.classList.add('loading');
        btn.disabled = true;
        label.textContent = 'Publicando…';
        toast('Publicando no Vercel… pode levar alguns minutos.');
        try {
            const { url } = await api('POST', `vibe/${encodeURIComponent(this.vibeProject.id)}/publish`);
            toast('Publicado no Vercel!', { action: { label: 'Abrir', run: () => window.open(url, '_blank', 'noopener') } });
        } catch (e) {
            toast(`Falha ao publicar: ${e.message}`, { tone: 'error', duration: 8000 });
        } finally {
            btn.classList.remove('loading');
            btn.disabled = false;
            label.textContent = 'Publicar';
        }
    }

    setActive(active) {
        this.active = active;
        this.panel.classList.toggle('active', active);
        this.panel.setAttribute('aria-hidden', String(!active));
        if (active) this.hasActivity = false;
    }

    focus() {
        this.composer?.focus();
    }

    applySettings() { /* uses the app theme */ }

    applyRow(row) {
        this.name = row.name;
        this.pinned = !!row.pinned;
        if (SESSION_COLORS.includes(row.color)) this.color = row.color;
    }

    displayCwd() {
        return this.cwd || 'agente';
    }

    /**
     * The header's actions as menu items, for the iPhone's contextual ⋮ menu (the header there
     * only keeps the title and status). Same rules as the buttons: the vibecoding ones only
     * exist in a vibecoding project. Popovers open anchored to `anchor` (the ⋮ button).
     */
    menuActions(anchor) {
        const vibe = !this.el.vibeBtn.hidden;
        const route = this.session?.agent === 'claude'
            ? [{ label: `Rota: ${ROUTE_LABELS[this.session.route || 'direto'] || this.session.route}`, icon: 'swap', run: () => this.openRouteMenu(anchor) }] : [];
        return [
            ...route,
            { label: 'Abrir terminal na pasta', icon: 'terminal', run: () => this.hooks.openTab({ cwd: this.cwd || undefined, afterId: this.id }) },
            { label: 'Abrir arquivos da pasta', icon: 'folder',
                run: () => this.hooks.openTab({ kind: 'files', url: 'local', cwd: this.cwd || undefined, afterId: this.id }) },
            ...(vibe ? [{ label: 'Trocar agente', icon: 'swap', run: () => this.openVibeAgentMenu(anchor) }] : []),
            ...(!this.el.publishBtn.hidden ? [{ label: this.el.publishBtn.textContent.trim() || 'Publicar', icon: 'cloudUpload',
                disabled: this.el.publishBtn.disabled, run: () => this.publishVibeProject() }] : []),
            { label: 'Painel do agente', icon: 'panelLeft', checked: this.isPanelOpen(), run: () => this.togglePanel() },
        ];
    }

    // ---------- side panel ----------

    togglePanel() {
        this.panelOpen = !this.isPanelOpen();
        this.applyPanel();
    }

    isPanelOpen() {
        return this.panelOpen === null ? wide() : this.panelOpen;
    }

    applyPanel() {
        const open = this.isPanelOpen();
        this.el.body.classList.toggle('side-open', open);
        this.el.panelBtn.setAttribute('aria-expanded', String(open));
        // Only the iPhone turns the column into a modal sheet; elsewhere the panel stays as it was
        const sheet = open && isIphonePortrait();
        this.el.scrim.hidden = !sheet;
        this.el.side.setAttribute('aria-modal', String(sheet));
    }

    // ---------- connection ----------

    connect() {
        if (this.disposed) return;
        this.setState(this.reconnectAttempts > 0 ? STATE.RECONNECTING : STATE.CONNECTING);
        this.renderBanner();
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const query = new URLSearchParams({ session: this.id, since: String(this.lastSeq) });
        const ws = new WebSocket(`${protocol}//${window.location.host}${basePath()}/?${query}`);
        this.ws = ws;
        const timeout = this.later(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 8000);
        ws.onopen = () => {
            clearTimeout(timeout);
            this.reconnectAttempts = 0;
            this.setState(STATE.CONNECTED);
            this.renderBanner();
        };
        ws.onmessage = (event) => {
            let m;
            try {
                m = JSON.parse(event.data);
            } catch {
                return;
            }
            if (m.type === 'agent-session') this.applySession(m.session);
            else if (m.type === 'agent-event') this.applyEvent(m.event);
            else if (m.type === 'ready') this.onReady();
            else if (m.type === 'agent-missing') this.showMissing();
            else if (m.type === 'workspace') this.hooks.onWorkspaceChanged();
            else if (m.nonce) this.hooks.onServerMessage(m); // app-wide notices (open-tab, agent-launch...)
        };
        ws.onerror = () => ws.close();
        ws.onclose = (event) => {
            clearTimeout(timeout);
            if (this.ws !== ws || this.disposed) return;
            if (event.code === 1008) {
                this.setState(STATE.ERROR);
                this.hooks.onAuthRequired();
                return;
            }
            if (event.code === CLOSE_SESSION_GONE) {
                this.hooks.onRemoved(this);
                return;
            }
            if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                const delay = Math.min(15000, 1000 * Math.pow(2, this.reconnectAttempts++));
                this.setState(STATE.RECONNECTING);
                this.later(() => this.connect(), delay);
            } else {
                this.setState(STATE.DISCONNECTED);
            }
            this.renderBanner();
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

    onReady() {
        const empty = this.el.log.querySelector('.ag-empty');
        if (empty && this.lastSeq > 0) empty.remove();
        else if (empty) empty.querySelector('p').textContent = 'Escreva uma mensagem para começar.';
        this.el.log.scrollTop = this.el.log.scrollHeight;
    }

    showMissing() {
        this.el.log.innerHTML = `<div class="ag-empty">${icon('x', 28)}<p>Esta conversa não existe mais no servidor.</p></div>`;
        this.composer.setBusy(false, 'stopped');
    }

    // ---------- session & events ----------

    applySession(session) {
        this.session = session;
        this.cwd = session.cwd;
        this.status = session.status;
        this.pending = new Map((session.pendingPermissions || []).map(p => [p.id, p.request]));
        this.composer.setSession(session);
        this.renderHead();
        this.renderBanner();
        this.renderPending();
        this.hooks.onInfo?.(this);
    }

    applyEvent(event) {
        if (event.seq <= this.lastSeq) return; // replay overlap after a reconnect
        this.lastSeq = event.seq;
        this.el.log.querySelector('.ag-empty')?.remove();
        const d = event.data || {};
        this.conversation.apply(event);
        this.side.apply(event);
        this.scheduleSide();

        switch (event.type) {
            case 'status':
                this.status = d.state;
                if (this.session) this.session.status = d.state;
                this.renderHead();
                this.renderBanner();
                break;
            case 'session.start':
                if (this.session) Object.assign(this.session, { capabilities: d.capabilities, mode: d.mode });
                this.composer.setSession(this.session);
                break;
            case 'session.info':
                if (d.title && this.session) {
                    this.session.title = d.title;
                    this.renderHead();
                }
                break;
            case 'mode.update':
                if (this.session) this.session.mode = d.modeId;
                this.composer.setSession(this.session);
                this.renderBanner();
                break;
            case 'config.update':
                if (this.session) this.session.capabilities = { ...this.session.capabilities, configOptions: d.options };
                this.composer.setSession(this.session);
                break;
            case 'queue.update':
                this.composer.setQueue(d.items);
                break;
            case 'commands.update':
                this.composer.setCommands(d.commands);
                break;
            case 'permission.request':
                this.pending.set(d.permissionId, d);
                this.renderPending();
                if (!this.active) this.hasActivity = true;
                break;
            case 'permission.response':
                this.pending.delete(d.permissionId);
                this.renderPending();
                break;
            case 'message.user':
                if (this.session && !this.session.title) {
                    this.session.title = d.text.slice(0, 60);
                    this.renderHead();
                }
                break;
            case 'message.assistant.done':
                if (!this.active) this.hasActivity = true;
                break;
            default:
                break;
        }
    }

    scheduleSide() {
        if (this.sideFrame) return;
        this.sideFrame = requestAnimationFrame(() => {
            this.sideFrame = 0;
            this.side.render();
            this.el.panelBtn.classList.toggle('has-activity', this.side.hasActivity && !this.isPanelOpen());
        });
    }

    renderHead() {
        const s = this.session;
        this.el.title.textContent = (s && s.title) || 'Nova conversa';
        this.el.agent.textContent = (s && s.agentLabel) || this.name;
        this.el.cwd.textContent = this.cwd || '';
        this.el.cwd.title = this.cwd || '';
        const route = this.panel.querySelector('.ag-route');
        if (route) {
            route.hidden = !(s && s.agent === 'claude');
            route.innerHTML = `${icon('swap', 14)} ${ROUTE_LABELS[(s && s.route) || 'direto'] || s.route}`;
        }
        const st = STATUS[this.status] || { label: this.status, tone: '' };
        this.el.status.textContent = st.label;
        this.el.status.dataset.tone = st.tone;
        const busy = this.status === 'thinking' || this.status === 'waiting_permission';
        this.composer.setBusy(busy, this.status);
        this.process = busy ? 'agente' : null;
    }

    renderBanner() {
        const parts = [];
        if (this.state === STATE.RECONNECTING || this.state === STATE.CONNECTING && this.lastSeq > 0) {
            parts.push(`<div class="ag-banner-row info">${icon('loader', 14)} Reconectando…</div>`);
        } else if (this.state === STATE.DISCONNECTED) {
            parts.push(`<div class="ag-banner-row bad">Conexão perdida. <button type="button" class="ag-link" data-reconnect>Tentar de novo</button></div>`);
        }
        if (this.status === 'stopped') {
            parts.push(`<div class="ag-banner-row bad">O agente está parado (servidor reiniciado, erro ou aba reaberta). <button type="button" class="btn btn-primary" data-resume>Retomar conversa</button></div>`);
        }
        // Permanent warning while the agent may act without asking
        if (this.session && this.session.mode === 'bypassPermissions') {
            parts.push(`<div class="ag-banner-row bad">${icon('shield', 14)} Modo sem permissões: o agente executa e altera arquivos sem perguntar.</div>`);
        }
        this.el.banner.innerHTML = parts.join('');
        this.el.banner.hidden = !parts.length;
    }

    /** Sticky bar above the message box: pending permissions never scroll out of sight. */
    renderPending() {
        const list = [...this.pending.entries()];
        this.el.pending.hidden = !list.length;
        if (!list.length) {
            this.el.pending.innerHTML = '';
            return;
        }
        const [permissionId, d] = list[0];
        const options = d.options || [];
        this.el.pending.innerHTML = `
            <button type="button" class="ag-pending-title" data-goto>${icon('shield', 15)} <span>${esc(d.title)}</span>${list.length > 1 ? ` <em>+${list.length - 1}</em>` : ''}</button>
            <div class="ag-pending-actions">${options.map(o => `<button type="button" class="btn ${o.kind === 'allow_once' ? 'btn-primary' : o.kind.startsWith('reject') ? 'btn-ghost' : ''}" data-perm="${esc(permissionId)}" data-option="${esc(o.id)}">${esc(o.name)}</button>`).join('')}</div>`;
    }

    // ---------- actions ----------

    action(name, body = {}) {
        return api('POST', `agent-sessions/${encodeURIComponent(this.agentSessionId)}/${name}`, body);
    }

    async sendPrompt({ text, images }) {
        try {
            await this.action('prompt', { text, images });
        } catch (e) {
            toast(e.message, { tone: 'error' });
            throw e;
        }
    }

    async answerPermission(permissionId, optionId) {
        try {
            await this.action('permission', { permissionId, optionId });
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    }

    async resume() {
        try {
            this.applySession(await this.action('resume'));
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    }

    async searchFiles(query) {
        const params = new URLSearchParams({ source: 'local', path: this.cwd || '~', q: query });
        const r = await fetch(`${basePath()}/api/files/search?${params}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return [];
        return (await r.json()).results || [];
    }

    /** Opens the file's folder in an "Arquivos" tab. */
    openFile(path) {
        const norm = String(path).replace(/\\/g, '/');
        const folder = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : this.cwd;
        this.hooks.openTab({ kind: 'files', url: 'local', cwd: folder, afterId: this.id });
    }

    showTool(toolId) {
        const card = this.el.log.querySelector(`[data-tool-id="${CSS.escape(toolId)}"]`);
        if (!card) return;
        card.open = true;
        card.scrollIntoView({ block: 'center', behavior: 'smooth' });
        card.classList.add('flash');
        this.later(() => card.classList.remove('flash'), 1200);
        if (!wide()) {
            this.panelOpen = false;
            this.applyPanel();
        }
    }

    /** Commands of the agents' terminal UI that the adapters do not run (composer LOCAL_COMMANDS). */
    runLocalCommand(name, args) {
        const head = this.panel.querySelector('.ag-head');
        const caps = (this.session && this.session.capabilities) || {};
        // Picks an option of a select by name ("/model opus"), or opens it to choose
        const choose = (select, wanted) => {
            if (!select) {
                this.conversation.note('Este agente não oferece essa opção.', 'info');
                return;
            }
            if (wanted) {
                const w = wanted.toLowerCase();
                const opt = [...select.options].find(o => o.value.toLowerCase() === w)
                    || [...select.options].find(o => o.textContent.toLowerCase().includes(w) || o.value.toLowerCase().includes(w));
                if (!opt) {
                    this.conversation.note(`"${wanted}" não encontrado. Opções: ${[...select.options].map(o => o.textContent.trim()).join(', ')}`, 'info');
                    return;
                }
                if (select.value !== opt.value) {
                    select.value = opt.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                return;
            }
            const button = select.nextElementSibling?.matches?.('.ui-select') ? select.nextElementSibling : null;
            if (button) button.click();
            else select.focus();
        };
        const configSelect = category => {
            const option = (caps.configOptions || []).find(o => o.category === category && o.type !== 'boolean');
            return option ? this.panel.querySelector(`select[data-config="${CSS.escape(option.id)}"]`) : null;
        };
        const modeSelect = () => this.panel.querySelector('select[data-mode]')
            || (caps.modeSource === 'config' ? configSelect('mode') : null);
        switch (name) {
            case 'resume':
                return this.openHistory(head.querySelector('[data-act="history"]'), { onlyPast: true, query: args });
            case 'clear':
                return api('POST', 'agent-sessions', { agent: this.session.agent, cwd: this.cwd, afterId: this.id })
                    .then(data => this.hooks.showTab?.(data.tab.id))
                    .catch(e => toast(e.message, { tone: 'error' }));
            case 'model': return choose(configSelect('model'), args);
            case 'effort': return choose(configSelect('thought_level'), args);
            case 'mode': return choose(modeSelect(), args);
            case 'plan': return choose(modeSelect(), 'plan');
            case 'cost':
                this.panelOpen = true;
                return this.applyPanel();
            case 'terminal': return this.hooks.openTab({ cwd: this.cwd || undefined, afterId: this.id });
            case 'files': return this.hooks.openTab({ kind: 'files', url: 'local', cwd: this.cwd || undefined, afterId: this.id });
            case 'attach': return this.composer.openAttachMenu();
            case 'stop': return this.action('cancel').catch(e => toast(e.message, { tone: 'error' }));
            case 'help': {
                const list = this.composer.allCommands().map(c => `/${c.name}${c.description ? ` — ${c.description}` : ''}`);
                return this.conversation.note(`Comandos disponíveis:\n${list.join('\n')}`, 'info help');
            }
            default:
                return undefined;
        }
    }

    /** Rota da conversa do Claude Code: troca e retoma a mesma conversa (POST .../route). */
    async openRouteMenu(anchor) {
        let routes = [];
        try {
            routes = (await api('GET', 'agents')).claudeRoutes || [];
        } catch (e) {
            return toast(e.message, { tone: 'error' });
        }
        const current = this.session?.route || 'direto';
        showMenu(routes.map(r => ({
            label: r.label, icon: r.id === current ? 'check' : 'swap', disabled: r.id === current,
            run: async () => {
                toast(`Trocando para ${r.label}…`);
                try {
                    this.session = await api('POST', `agent-sessions/${encodeURIComponent(this.agentSessionId)}/route`, { route: r.id });
                    this.renderHead();
                } catch (e) {
                    toast(e.message, { tone: 'error', duration: 6000 });
                }
            },
        })), { anchor, label: 'Rota do Claude Code' });
    }

    /** Whether this agent can list its past conversations (ACP session/list). */
    get hasHistory() {
        return !!(this.session && this.session.capabilities && this.session.capabilities.history);
    }

    /**
     * Past conversations of this agent in this folder, newest first (incl. ones started in the
     * terminal). The agent is started just to answer, so the result is kept for a minute.
     * @returns {Promise<Array<{sessionId: string, title: string|null, updatedAt: string|null, cwd: string}>>}
     */
    async fetchHistory({ fresh = false } = {}) {
        if (!this.hasHistory) return [];
        const cached = this.historyCache;
        if (!fresh && cached && Date.now() - cached.at < 60000) return cached.sessions;
        const { sessions } = await api('GET', `agent-sessions/${encodeURIComponent(this.agentSessionId)}/history`);
        this.historyCache = { at: Date.now(), sessions };
        return sessions;
    }

    /** New conversation ({}) or resumes a past one ({ resumeAcpSessionId, title }) in a new tab. */
    startConversation(body = {}) {
        if (!this.session) return Promise.resolve();
        // Loading a long conversation from the terminal takes a few seconds
        if (body.resumeAcpSessionId) toast(`Abrindo "${body.title || 'conversa'}"…`);
        return api('POST', 'agent-sessions', { agent: this.session.agent, cwd: this.cwd, afterId: this.id, ...body })
            .then(data => this.hooks.showTab?.(data.tab.id))
            .catch(e => toast(e.message, { tone: 'error' }));
    }

    /** "Conversas" (desktop header button, /resume): new conversation, or a past one, as a menu. */
    async openHistory(anchor, { onlyPast = false, query = '' } = {}) {
        if (!this.session) return;
        const start = body => this.startConversation(body);
        const items = [{ label: 'Nova conversa', icon: 'plus', run: () => start({}) }];
        if (onlyPast && !this.hasHistory) {
            this.conversation.note('Este agente não lista conversas anteriores.', 'info');
            return;
        }
        if (this.hasHistory) {
            showMenu([...items, 'separator', { label: 'Carregando conversas…', icon: 'loader', run: () => {} }], { anchor, label: 'Conversas' });
            try {
                const sessions = await this.fetchHistory();
                const fmt = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
                const q = query.toLowerCase();
                const found = q ? sessions.filter(h => (h.title || '').toLowerCase().includes(q) || h.sessionId === query) : sessions;
                // "/resume <id>" or a single match: open it directly
                if (query && found.length === 1) {
                    return start({ resumeAcpSessionId: found[0].sessionId, title: found[0].title });
                }
                const past = found.slice(0, 20).map(h => ({
                    label: h.title || 'Sem título',
                    hint: h.updatedAt ? fmt.format(new Date(h.updatedAt)) : '',
                    icon: 'history',
                    run: () => start({ resumeAcpSessionId: h.sessionId, title: h.title }),
                }));
                items.push('separator', ...(past.length ? past : [{ label: 'Nenhuma conversa anterior nesta pasta', icon: 'info', run: () => {} }]));
            } catch (e) {
                items.push('separator', { label: `Histórico indisponível: ${e.message}`, icon: 'info', run: () => {} });
            }
        }
        showMenu(items, { anchor, label: 'Conversas' });
    }

    // ---------- lifecycle ----------

    later(fn, ms) {
        const t = setTimeout(() => {
            this.timers.delete(t);
            fn();
        }, ms);
        this.timers.add(t);
        return t;
    }

    /** Removes the view only; the agent keeps running on the server until the tab is closed. */
    dispose() {
        this.disposed = true;
        this.timers.forEach(clearTimeout);
        this.timers.clear();
        this.mediaQuery?.removeEventListener('change', this.onMedia);
        this.composer.dispose(); // its iPhone settings sheet lives on <body>
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.panel.remove();
    }
}
