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

/** Eventos que são conversa (tiram a tela vazia); o resto é aviso de sistema. */
const CONVERSATION_EVENT = /^(message\.|tool\.|thought\.|plan\.|permission\.|subagent\.|media)/;
import { isIphonePortrait } from '../ui/device.js';
import { attachEdgeFade } from '../ui/edgeFade.js';
import { watchEdgeBlur } from '../ui/edgeBlur.js';
import { openFolderMenu } from '../ui/folderPicker.js';
import { haptic } from '../ui/haptics.js';
import { keepScreenOn } from '../ui/permissions.js';
import { openFileViewer, viewerKind } from '../agent/fileViewer.js';
import { locateFile } from '../agent/locateFile.js';
import { permissionTitle } from '../agent/permissionDoc.js';
import { agentIconName, agentIdFromName } from '../ui/agent-logos.js';
import { loaderHtml } from '../ui/loading.js';

const MAX_RECONNECT_ATTEMPTS = 8;
const CLOSE_SESSION_GONE = 4404;
// Começa a buscar as mensagens anteriores antes de chegar no topo: o bloco entra sem a pessoa ver o fim
const OLDER_MARGIN = 1200;
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const PANEL_KEY = 'meuterminal-painel-agente';
const wide = () => window.matchMedia('(min-width: 1100px)').matches;

const STATUS = {
    starting: { label: 'Iniciando', tone: 'busy' },
    idle: { label: 'Pronto', tone: 'ok' },
    thinking: { label: 'Trabalhando', tone: 'busy' },
    waiting_permission: { label: 'Aguardando você', tone: 'warn' },
    error: { label: 'Erro', tone: 'bad' },
    stopped: { label: 'Offline', tone: '' }, // normal: o agente só sobe ao enviar uma mensagem
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
        // Desktop: o painel lembra se ficou aberto ou fechado
        if (document.documentElement.hasAttribute('data-desktop')) {
            const saved = localStorage.getItem(PANEL_KEY);
            this.panelOpen = saved === '1'; // fechado até você abrir: a conversa ocupa a tela
        }

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

    /** A conversa passa por trás do título: a altura dele vira espaço no início dela. */
    watchOverlayHeights() {
        if (typeof ResizeObserver === 'undefined') return;
        const head = this.panel.querySelector('.ag-head');
        this.overlayHeights = new ResizeObserver(() => {
            this.panel.style.setProperty('--ag-head-h', `${head.offsetHeight}px`);
            const log = this.el?.log;
            if (log) this.panel.style.setProperty('--ag-bar-w', `${log.offsetWidth - log.clientWidth}px`);
        });
        this.overlayHeights.observe(head);
        if (this.el?.log) this.overlayHeights.observe(this.el.log);
    }

    mount(parent) {
        parent.appendChild(this.panel);
        this.panel.innerHTML = `
            <header class="ag-head">
                <span class="ag-head-icon">${icon(agentIconName(this.agentId), 18)}</span>
                <div class="ag-head-text">
                    <div class="ag-head-title"></div>
                    <div class="ag-head-sub"><span class="ag-agent"></span> · <span class="ag-cwd mono"></span></div>
                </div>
                <span class="ag-status" role="status"></span>
                <button type="button" class="btn btn-ghost btn-sm ag-publish" data-act="vibe-publish" aria-label="Publicar no Vercel" title="Publicar no Vercel" hidden>${icon('cloudUpload', 16)} <span class="ag-publish-label">Publicar</span></button>
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
                        <div class="ag-empty">${loaderHtml({ iconName: agentIconName(this.agentId), title: 'Conectando ao agente…', small: true })}</div>
                    </div>
                    <button type="button" class="ag-jump" hidden aria-label="Ir para o fim">${icon('chevronDown', 18)}</button>
                    <div class="ag-pending" hidden></div>
                    <div class="ag-composer"></div>
                    <div class="ag-edge ag-edge-top" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
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
            publishBtn: q('[data-act="vibe-publish"]'),
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
            onOpenFile: (path, opts) => this.openFile(path, opts),
            onRetry: text => this.sendPrompt({ text, images: [] }),
        });
        this.composer = new Composer(q('.ag-composer'), {
            cwd: () => this.cwd,
            canChangeFolder: () => !this.vibeProject,
            onFolder: anchor => this.chooseFolder(anchor),
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
        // Arrastar arquivos para qualquer parte da conversa
        let dragDepth = 0;
        const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
        this.panel.addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; this.panel.classList.add('ag-dropping'); } });
        this.panel.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; this.panel.classList.remove('ag-dropping'); } });
        this.panel.addEventListener('dragover', e => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
        this.panel.addEventListener('drop', e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            dragDepth = 0;
            this.panel.classList.remove('ag-dropping');
            this.composer.addDeviceFiles([...e.dataTransfer.files]);
            this.composer.focus();
        });
        // Desktop: seta para cima com o campo vazio traz a última mensagem para editar
        this.panel.addEventListener('keydown', e => {
            if (e.key !== 'ArrowUp' || !document.documentElement.hasAttribute('data-desktop')) return;
            const field = e.target.closest?.('.ag-composer textarea');
            if (!field || field.value || !this.conversation.lastUserText) return;
            e.preventDefault();
            this.composer.insert(this.conversation.lastUserText);
        });
        // Permissão pendente: Enter permite e Esc recusa (com o campo de mensagem vazio)
        this.panel.addEventListener('keydown', e => {
            if (!this.pending?.size || e.isComposing || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key !== 'Enter' && e.key !== 'Escape') return;
            const field = e.target.closest?.('textarea, input');
            if (field && field.value.trim()) return;
            const [permissionId, d] = [...this.pending.entries()][0];
            const want = e.key === 'Enter' ? 'allow_once' : 'reject_once';
            const opt = (d.options || []).find(o => o.kind === want) || (d.options || []).find(o => o.kind.startsWith(e.key === 'Enter' ? 'allow' : 'reject'));
            if (!opt) return;
            e.preventDefault();
            e.stopPropagation();
            this.answerPermission(permissionId, opt.id);
        }, true);
        this.el.log.addEventListener('scroll', () => {
            this.el.jump.hidden = this.conversation.nearBottom();
            if (this.pendingHistory && this.conversation.nearBottom()) this.applyHistory(this.pendingHistory);
            if (this.el.log.scrollTop < OLDER_MARGIN) this.loadOlderIfNeeded();
        }, { passive: true });
        this.el.jump.addEventListener('click', () => {
            this.el.log.scrollTop = this.el.log.scrollHeight;
        });
        this.logFade = attachEdgeFade(this.el.log, { overlay: false }); // tem as camadas dela (.ag-edge-top/bottom)
        this.watchOverlayHeights();
        watchEdgeBlur();
        this.probeEvery = setInterval(() => {
            if (document.visibilityState === 'visible') this.probeConnection();
        }, 30000);
        // A área mudou de tamanho (painel abriu, campo cresceu): quem estava no fim continua no fim
        this.logResize = new ResizeObserver(() => {
            if (this.conversation.nearBottom()) this.el.log.scrollTop = this.el.log.scrollHeight;
        });
        this.logResize.observe(this.el.log);
        this.mediaQuery = window.matchMedia('(min-width: 1100px)');
        this.onMedia = () => this.applyPanel();
        this.mediaQuery.addEventListener('change', this.onMedia);
        this.applyPanel();
        this.renderHead();
        this.connect();
        void this.checkVibeProject();
    }

    /** O agente desta aba, mesmo antes de a sessão chegar. */
    get agentId() {
        return this.session?.agent || agentIdFromName(this.name);
    }

    /** ⌘L: foco no campo de mensagem. */
    focusComposer() { this.composer.focus(); }

    /** ⌘⇧C: copia a última resposta do agente. */
    lastAnswerText() { return this.conversation.lastAnswerText(); }

    /** Only vibecoding tabs get "Publicar" - a plain agent conversation has no project. */
    async checkVibeProject() {
        try {
            this.vibeProject = await api('GET', `vibe/tab/${encodeURIComponent(this.id)}`);
            if (!this.vibeProject) return;
            this.hooks.onPairChanged?.(); // celular: dá para puxar a prévia
            this.el.publishBtn.hidden = !this.vibeProject.can_publish;
        } catch {
            this.vibeProject = null;
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
        const route = this.session?.agent === 'claude'
            ? [{ label: `Rota: ${ROUTE_LABELS[this.session.route || 'direto'] || this.session.route}`, icon: 'swap', run: () => this.openRouteMenu(anchor) }] : [];
        return [
            ...route,
            { label: 'Abrir terminal na pasta', icon: 'terminal', run: () => this.hooks.openTab({ cwd: this.cwd || undefined, afterId: this.id }) },
            { label: 'Abrir arquivos da pasta', icon: 'folder',
                run: () => this.hooks.openTab({ kind: 'files', url: 'local', cwd: this.cwd || undefined, afterId: this.id }) },
            ...(!this.el.publishBtn.hidden ? [{ label: this.el.publishBtn.textContent.trim() || 'Publicar', icon: 'cloudUpload',
                disabled: this.el.publishBtn.disabled, run: () => this.publishVibeProject() }] : []),
            { label: 'Painel do agente', icon: 'panelLeft', checked: this.isPanelOpen(), run: () => this.togglePanel() },
        ];
    }

    // ---------- side panel ----------

    togglePanel() {
        this.panelOpen = !this.isPanelOpen();
        if (document.documentElement.hasAttribute('data-desktop')) localStorage.setItem(PANEL_KEY, this.panelOpen ? '1' : '0');
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
            else if (m.type === 'app-pong') clearTimeout(this.probeTimer);
            else if (m.type === 'agent-history') this.applyHistory(m);
            else if (m.type === 'agent-side') this.applySide(m.events);
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
        } else {
            this.probeConnection();
        }
    }

    /**
     * Celular que dormiu: a conexão parece aberta, mas morreu, e nada mais chega. Pergunta ao servidor;
     * sem resposta, reconecta e busca o que perdeu.
     */
    probeConnection() {
        const ws = this.ws;
        if (this.disposed || !ws || ws.readyState !== WebSocket.OPEN) return;
        clearTimeout(this.probeTimer);
        try {
            ws.send(JSON.stringify({ type: 'app-ping' }));
        } catch { /* a resposta não vem: reconecta abaixo */ }
        this.probeTimer = setTimeout(() => {
            if (this.ws !== ws || this.disposed) return;
            this.ws = null; // a conexão morta pode demorar a avisar que fechou
            try { ws.close(); } catch { /* já era */ }
            this.reconnectAttempts = 0;
            this.connect();
        }, 4000);
    }

    setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.hooks.onStateChange(this);
    }

    onReady() {
        const empty = this.el.log.querySelector('.ag-empty');
        if (empty && this.hasConversation) empty.remove();
        else if (empty) this.renderWelcome(empty);
        this.panel.classList.toggle('ag-is-empty', !!this.el.log.querySelector('.ag-empty'));
        this.el.log.scrollTop = this.el.log.scrollHeight;
    }

    /** Conversa nova: saudação, a pasta e sugestões (no desktop o campo fica no centro, como no Claude). */
    renderWelcome(empty) {
        const h = new Date().getHours();
        const hello = h < 5 ? 'Boa noite' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
        const tips = [
            ['Me explica este projeto', 'Me explica este projeto: o que ele faz e como está organizado.'],
            ['Revisar as mudanças', 'Revise as mudanças que ainda não foram salvas no git e aponte problemas.'],
            ['Rodar os testes', 'Rode os testes do projeto e corrija o que falhar.'],
        ];
        empty.classList.add('ag-welcome');
        empty.innerHTML = `
            <span class="ag-hello-logo">${icon(agentIconName(this.agentId), 34)}</span>
            <h2 class="ag-hello">${hello}</h2>
            <p>Em que vamos trabalhar em <span class="mono">${esc(this.displayCwd?.() || this.cwd || '~')}</span>?</p>
            <div class="ag-tips">${tips.map(([label, text]) => `<button type="button" class="ag-tip" data-tip="${esc(text)}">${esc(label)}</button>`).join('')}</div>`;
        empty.addEventListener('click', e => {
            const tip = e.target.closest('[data-tip]');
            if (tip) this.composer.insert(tip.dataset.tip);
        });
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

    /** A abertura: o fim da conversa de uma vez só, já na última mensagem. O resto vem ao subir. */
    applyHistory(message) {
        const { transcript = false, meta = [], events = [], firstTurn = 0, lastSeq = 0, title = null } = message;
        if (this.historyShown) {
            // De novo: a conexão voltou, ou a conversa andou fora do app. Quem está lendo lá em cima
            // não é tirado do lugar: atualiza ao voltar para o fim
            if (!events.length && !meta.length) return;
            if (!this.conversation.nearBottom()) {
                this.pendingHistory = message;
                return;
            }
            this.pendingHistory = null;
            this.conversation.clear();
            this.lastSeq = 0;
        }
        this.historyShown = true;
        if (title && this.session && !this.session.title) this.session.title = title; // da primeira mensagem, que pode não ter vindo
        const activity = this.hasActivity; // o que já aconteceu não é novidade
        this.conversation.batch(() => {
            for (const e of meta) this.applyEvent(e, { silent: true });
            for (const e of events) {
                if (!transcript) {
                    this.applyEvent(e);
                    continue;
                }
                this.conversation.apply(e);
                this.side.apply(e);
            }
        });
        this.hasActivity = activity;
        if (this.lastSeq < lastSeq) this.lastSeq = lastSeq;
        if (transcript && events.length || firstTurn > 0) {
            this.hasConversation = true;
            this.el.log.querySelector('.ag-empty')?.remove();
            this.panel.classList.remove('ag-is-empty');
        }
        this.renderHead();
        this.setOlder(firstTurn);
        this.pinToEnd();
    }

    /** Painel lateral: o resumo da conversa inteira, inclusive do que ainda não subiu. */
    applySide(events = []) {
        this.side.reset();
        for (const e of events) this.side.apply(e);
        this.scheduleSide();
    }

    /** Vai ao fim e confere de novo no quadro seguinte (a altura só assenta depois de desenhar). */
    pinToEnd() {
        const log = this.el.log;
        log.scrollTop = log.scrollHeight;
        requestAnimationFrame(() => {
            log.scrollTop = log.scrollHeight;
            this.loadOlderIfNeeded();
        });
    }

    // ---------- turnos anteriores ----------

    setOlder(firstTurn) {
        this.olderCursor = firstTurn;
        let mark = this.el.log.querySelector(':scope > .ag-older');
        if (firstTurn <= 0) {
            mark?.remove();
            return;
        }
        if (!mark) {
            mark = document.createElement('div');
            mark.className = 'ag-older';
            mark.addEventListener('click', e => {
                if (e.target.closest('button')) this.loadOlderIfNeeded(true);
            });
            this.el.log.prepend(mark);
        }
        mark.innerHTML = `<span class="cv-spin"></span> Carregando mensagens anteriores…`;
    }

    /** Perto do topo (ou sem conteúdo para rolar): busca o bloco anterior. */
    async loadOlderIfNeeded(force = false) {
        const log = this.el.log;
        if (this.loadingOlder || !(this.olderCursor > 0) || !this.session?.id) return false;
        if (this.olderFailed && !force) return false;
        if (!force && log.scrollTop > OLDER_MARGIN) return false;
        this.loadingOlder = true;
        this.olderFailed = false;
        const mark = log.querySelector(':scope > .ag-older');
        if (force && mark) mark.innerHTML = `<span class="cv-spin"></span> Carregando mensagens anteriores…`;
        try {
            const res = await fetch(`${basePath()}/api/agent-sessions/${encodeURIComponent(this.session.id)}/older?before=${this.olderCursor}`);
            if (!res.ok) throw new Error(String(res.status));
            const { events, firstTurn } = await res.json();
            if (this.disposed) return false;
            const nodes = this.conversation.renderOlder(events);
            // Medido do fim: o que está na tela não sai do lugar quando entra conteúdo em cima
            const fromEnd = log.scrollHeight - log.scrollTop;
            if (mark) mark.after(...nodes);
            else log.prepend(...nodes);
            log.scrollTop = log.scrollHeight - fromEnd;
            this.setOlder(firstTurn);
            this.loadingOlder = false;
            requestAnimationFrame(() => this.loadOlderIfNeeded());
            return true;
        } catch {
            this.olderFailed = true;
            if (mark) mark.innerHTML = 'Não deu para carregar as mensagens anteriores. <button type="button" class="ag-link">Tentar de novo</button>';
            return false;
        } finally {
            this.loadingOlder = false;
        }
    }

    applyEvent(event, { silent = false } = {}) {
        if (event.seq <= this.lastSeq) return; // replay overlap after a reconnect
        this.lastSeq = event.seq;
        // A tela vazia (saudação) só sai quando aparece conversa de verdade; avisos de sistema
        // ("Sessão iniciada em…", comandos, modelo) não contam
        if (CONVERSATION_EVENT.test(event.type)) {
            this.hasConversation = true;
            this.el.log.querySelector('.ag-empty')?.remove();
            this.panel.classList.remove('ag-is-empty');
        }
        const d = event.data || {};
        if (!silent) {
            this.conversation.apply(event);
            this.side.apply(event);
            this.scheduleSide();
        }

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
        const headIcon = this.panel.querySelector('.ag-head-icon');
        if (headIcon && headIcon.dataset.agent !== this.agentId) {
            headIcon.dataset.agent = this.agentId || '';
            headIcon.innerHTML = icon(agentIconName(this.agentId), 18);
        }
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
        keepScreenOn(this.id, busy); // se liberado em Permissões: tela ligada enquanto o agente trabalha
        this.process = busy ? 'agente' : null;
    }

    renderBanner() {
        const parts = [];
        if (this.state === STATE.RECONNECTING || this.state === STATE.CONNECTING && this.lastSeq > 0) {
            parts.push(`<div class="ag-banner-row info">${icon('loader', 14)} Reconectando…</div>`);
        } else if (this.state === STATE.DISCONNECTED) {
            parts.push(`<div class="ag-banner-row bad">Conexão perdida. <button type="button" class="ag-link" data-reconnect>Tentar de novo</button></div>`);
        }
        if (this.status === 'starting') parts.push(`<div class="ag-banner-row info">${icon('loader', 14)} Iniciando o agente…</div>`);
        // Permanent warning while the agent may act without asking
        if (this.session && this.session.mode === 'bypassPermissions') {
            parts.push(`<div class="ag-banner-row bad">${icon('shield', 14)} Modo sem permissões: o agente executa e altera arquivos sem perguntar.</div>`);
        }
        this.el.banner.innerHTML = parts.join('');
        this.el.banner.hidden = !parts.length;
    }

    /** Sticky bar above the message box: pending permissions never scroll out of sight. */
    renderPending() {
        this.later?.(() => this.panel.style.setProperty('--ag-pending-h', `${this.el.pending.offsetHeight}px`), 0);
        const list = [...this.pending.entries()];
        this.el.pending.hidden = !list.length;
        if (!list.length) {
            this.el.pending.innerHTML = '';
            return;
        }
        const [permissionId, d] = list[0];
        const options = d.options || [];
        this.later(() => this.watchPermissionCard(permissionId), 60);
        this.el.pending.innerHTML = `
            <button type="button" class="ag-pending-title" data-goto>${icon('shield', 15)} <span>${esc(permissionTitle(d))}</span>${list.length > 1 ? ` <em>+${list.length - 1}</em>` : ''}</button>
            <div class="ag-pending-actions">${options.map(o => `<button type="button" class="btn ${o.kind === 'allow_once' ? 'btn-primary' : o.kind.startsWith('reject') ? 'btn-ghost' : ''}" data-perm="${esc(permissionId)}" data-option="${esc(o.id)}">${esc(o.name)}</button>`).join('')}</div>`;
    }

    /** Com o cartão do pedido à vista, ele já tem os botões: a barra só aparece quando ele sai da tela. */
    watchPermissionCard(permissionId) {
        this.permissionSeen?.disconnect();
        this.permissionSeen = null;
        const { pending, log } = this.el;
        pending.classList.remove('card-seen');
        const card = log.querySelector(`.ag-perm[data-permission-id="${CSS.escape(permissionId)}"]`);
        if (!card || typeof IntersectionObserver === 'undefined') return;
        this.permissionSeen = new IntersectionObserver(([entry]) => {
            pending.classList.toggle('card-seen', entry.isIntersecting);
        }, { root: log, rootMargin: `0px 0px -${pending.offsetHeight + (this.composer?.el?.offsetHeight || 0)}px 0px`, threshold: 0.5 });
        this.permissionSeen.observe(card);
    }

    // ---------- actions ----------

    action(name, body = {}) {
        return api('POST', `agent-sessions/${encodeURIComponent(this.agentSessionId)}/${name}`, body);
    }

    async sendPrompt({ text, images }) {
        haptic('light');
        try {
            await this.action('prompt', { text, images });
        } catch (e) {
            toast(e.message, { tone: 'error' });
            throw e;
        }
    }

    async answerPermission(permissionId, optionId) {
        haptic('medium');
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

    async searchFiles(query, folder = this.cwd) {
        const params = new URLSearchParams({ source: 'local', path: folder || '~', q: query });
        const r = await fetch(`${basePath()}/api/files/search?${params}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return [];
        return (await r.json()).results || [];
    }

    /** O caminho como o agente escreveu -> caminho completo no servidor. */
    fullPath(path) {
        const norm = String(path).replace(/\\/g, '/');
        return norm.startsWith('/') || norm.startsWith('~') ? norm : `${String(this.cwd || '').replace(/\/+$/, '')}/${norm.replace(/^\.\//, '')}`;
    }

    /** Arquivo citado na conversa: abre formatado em tela cheia; o que não tem prévia vai para os Arquivos. */
    async openFile(path, { folder = false, cwd = this.cwd } = {}) {
        const direct = this.fullPath(path);
        if (folder) return this.openInFiles(direct);
        const place = await locateFile(path, {
            cwd,
            exists: p => this.fileExists(p),
            search: name => this.searchFiles(name, cwd),
        });
        if (place.status === 'found') return this.showFile(place.path);
        if (place.status === 'missing') {
            toast(`Não achei "${place.name}" em ${cwd || 'nesta pasta'}. Ele pode ter sido apagado ou estar em outra pasta.`, { tone: 'error' });
            return null;
        }
        const folderOf = p => p.slice(0, p.lastIndexOf('/')) || '/';
        return showMenu(place.paths.map(p => ({ label: folderOf(p), run: () => this.showFile(p) })), {
            x: window.innerWidth / 2, y: window.innerHeight / 2, label: 'Qual destes arquivos?',
        });
    }

    showFile(full) {
        if (!viewerKind(full)) return this.openInFiles(full);
        return openFileViewer({
            path: full,
            onOpenInFiles: p => this.openInFiles(p),
            onOpenFile: (p, dir) => this.openFile(p, { cwd: dir }),
        });
    }

    async fileExists(full) {
        const params = new URLSearchParams({ source: 'local', path: full });
        const r = await fetch(`${basePath()}/api/files/stat?${params}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return false;
        const info = await r.json().catch(() => ({}));
        return info.type !== 'dir';
    }

    /** Opens the file's folder in an "Arquivos" tab. */
    openInFiles(path) {
        const norm = String(path).replace(/\\/g, '/');
        const folder = norm.includes('/') ? norm.slice(0, norm.lastIndexOf('/')) || '/' : this.cwd;
        this.hooks.openTab({ kind: 'files', url: 'local', cwd: folder, afterId: this.id });
    }

    async showTool(toolId) {
        const find = () => this.el.log.querySelector(`[data-tool-id="${CSS.escape(toolId)}"]`);
        // O cartão pode estar num trecho que ainda não subiu
        let loaded = false;
        while (!find() && this.olderCursor > 0) {
            if (!await this.loadOlderIfNeeded(true)) break;
            loaded = true;
        }
        const card = find();
        if (!card) return;
        card.closest('.ag-tool-group')?.classList.add('is-open');
        card.open = true;
        // Veio de um trecho que acabou de entrar: vai direto (mais conteúdo ainda pode entrar em cima)
        card.scrollIntoView({ block: 'center', behavior: loaded ? 'auto' : 'smooth' });
        if (loaded) {
            requestAnimationFrame(() => card.scrollIntoView({ block: 'center' }));
            this.later(() => card.scrollIntoView({ block: 'center' }), 400);
        }
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

    /** Troca a rota ou a conta da conversa e retoma a mesma conversa. */
    switchClaude(path, body, label, onDone) {
        return async () => {
            toast(`Trocando para ${label}…`);
            try {
                this.session = await api('POST', `agent-sessions/${encodeURIComponent(this.agentSessionId)}/${path}`, body);
                this.renderHead();
                onDone?.();
            } catch (e) {
                toast(e.message, { tone: 'error', duration: 6000 });
            }
        };
    }

    /** Rota da conversa do Claude Code (a conta fica no pé da lista de conversas). */
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
            run: this.switchClaude('route', { route: r.id }, r.label),
        })), { anchor, label: 'Rota do Claude Code' });
    }

    /** Troca a conta desta conversa. Agente que separa as conversas por conta: vale para a nova. */
    useAccount(account, { fresh = false } = {}) {
        if (fresh) return this.startConversation({ account: account.id });
        return this.switchClaude('account', { account: account.id }, `a conta ${account.name}`)();
    }

    /** Whether this agent can list its past conversations (ACP session/list). */
    get hasHistory() {
        return true; // a lista vem do banco do app, não do agente
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
        // Na mesma aba (uma aba por agente; a anterior segue na lista lateral)
        // Conversa nova: na pasta padrão, se houver (projeto de vibecoding fica sempre na pasta dele)
        const cwd = (!body.resumeAcpSessionId && !this.vibeProject && this.settings.get('defaultCwd')) || this.cwd;
        return api('POST', 'agent-sessions', { agent: this.session.agent, cwd, afterId: this.id, intoTab: this.id, ...body })
            .then(data => this.hooks.showTab?.(data.tab.id))
            .catch(e => toast(e.message, { tone: 'error' }));
    }

    /**
     * Pasta da conversa: a escolhida vira a padrão das próximas. Conversa em andamento não troca de
     * pasta (o agente já trabalha nela): a escolha abre uma nova, e esta segue na lista.
     */
    chooseFolder(anchor) {
        return openFolderMenu(anchor, {
            current: this.cwd,
            startsNew: !!this.hasConversation,
            agent: this.session?.agent || '',
            onPick: path => {
                this.settings.set('defaultCwd', path);
                return this.startConversation({ cwd: path });
            },
        });
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
                /* histórico indisponível: só não lista as anteriores */
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
        this.logResize?.disconnect();
        this.logFade?.destroy();
        clearInterval(this.probeEvery);
        clearTimeout(this.probeTimer);
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
