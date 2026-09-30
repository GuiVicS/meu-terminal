/**
 * agentSession.js
 * Agent UI tab (kind 'agent'): a conversation with a coding agent (Claude, OpenCode, Codex)
 * through the server's agent gateway. PROVISIONAL view for phase 3; the full UI is phase 4.
 * Same interface as TerminalSession, so tabs, status bar and menus work with it.
 */
import { STATE, SESSION_COLORS } from './session.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

const MAX_RECONNECT_ATTEMPTS = 6;
const CLOSE_SESSION_GONE = 4404;
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const coarse = () => window.matchMedia('(pointer: coarse)').matches;

const STATUS_LABEL = {
    starting: 'iniciando', idle: 'pronto', thinking: 'trabalhando', waiting_permission: 'aguardando permissão',
    error: 'erro', stopped: 'parado', closed: 'encerrado',
};
const TOOL_ICON = { bash: 'terminal', read: 'fileText', edit: 'edit', write: 'filePlus', search: 'search', fetch: 'globe', mcp: 'bolt', task: 'bot', think: 'info', other: 'bolt' };

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(method, route, body) {
    const response = await fetch(`${basePath()}/api/${route}`, {
        method,
        credentials: 'same-origin',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
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

        this.session = null;     // agent session snapshot from the server
        this.lastSeq = 0;        // replay point for reconnects
        this.tools = new Map();  // toolId -> card element
        this.current = null;     // assistant message element receiving deltas
        this.active = false;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.disposed = false;
        this.timers = new Set();

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
            <div class="agent-bar">
                <span class="agent-title">${icon('bot', 16)} <b></b></span>
                <span class="agent-status"></span>
                <select class="agent-mode" aria-label="Modo" hidden></select>
                <select class="agent-model" aria-label="Modelo" hidden></select>
                <button type="button" class="btn agent-resume" hidden>Retomar</button>
            </div>
            <div class="agent-log" role="log" aria-live="polite" tabindex="0"></div>
            <form class="agent-composer" autocomplete="off">
                <textarea rows="1" placeholder="Mensagem para o agente…" aria-label="Mensagem" enterkeyhint="send"></textarea>
                <button type="button" class="icon-btn agent-stop" aria-label="Parar" hidden>${icon('square', 18)}</button>
                <button type="submit" class="icon-btn agent-send" aria-label="Enviar">${icon('arrowUp', 18)}</button>
            </form>`;
        const q = sel => this.panel.querySelector(sel);
        this.el = {
            title: q('.agent-title b'), status: q('.agent-status'), mode: q('.agent-mode'), model: q('.agent-model'),
            resume: q('.agent-resume'), log: q('.agent-log'), form: q('.agent-composer'),
            input: q('.agent-composer textarea'), stop: q('.agent-stop'), send: q('.agent-send'),
        };
        this.el.form.addEventListener('submit', e => {
            e.preventDefault();
            this.sendPrompt();
        });
        this.el.input.addEventListener('keydown', e => {
            // Enter sends on desktop; on phones Enter is a new line (send button instead)
            if (e.key === 'Enter' && !e.shiftKey && !coarse()) {
                e.preventDefault();
                this.sendPrompt();
            }
        });
        this.el.stop.addEventListener('click', () => this.action('cancel').catch(e => toast(e.message, { tone: 'error' })));
        this.el.resume.addEventListener('click', () => this.action('resume').catch(e => toast(e.message, { tone: 'error' })));
        this.el.mode.addEventListener('change', () => this.action('mode', { modeId: this.el.mode.value }).catch(e => toast(e.message, { tone: 'error' })));
        this.el.model.addEventListener('change', () => {
            const option = this.modelOption();
            if (option) this.action('config', { configId: option.id, value: this.el.model.value }).catch(e => toast(e.message, { tone: 'error' }));
        });
        this.el.log.addEventListener('click', e => this.onLogClick(e));
        this.connect();
    }

    setActive(active) {
        this.active = active;
        this.panel.classList.toggle('active', active);
        this.panel.setAttribute('aria-hidden', String(!active));
        if (active) this.hasActivity = false;
    }

    focus() {
        if (!coarse()) this.el?.input.focus({ preventScroll: true });
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

    // ---------- connection ----------

    connect() {
        if (this.disposed) return;
        this.setState(this.reconnectAttempts > 0 ? STATE.RECONNECTING : STATE.CONNECTING);
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const query = new URLSearchParams({ session: this.id, since: String(this.lastSeq) });
        const ws = new WebSocket(`${protocol}//${window.location.host}${basePath()}/?${query}`);
        this.ws = ws;
        const timeout = this.later(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 8000);
        ws.onopen = () => {
            clearTimeout(timeout);
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
            if (m.type === 'agent-session') this.applySession(m.session);
            else if (m.type === 'agent-event') this.applyEvent(m.event);
            else if (m.type === 'agent-missing') this.note('Esta sessão de agente não existe mais.', 'error');
            else if (m.type === 'workspace') this.hooks.onWorkspaceChanged();
            else if (m.nonce) this.hooks.onServerMessage(m); // app-wide notices (open-tab, agent-launch...)
        };
        ws.onerror = () => ws.close();
        ws.onclose = event => {
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
                const delay = 1000 * Math.pow(2, this.reconnectAttempts++);
                this.setState(STATE.RECONNECTING);
                this.later(() => this.connect(), delay);
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

    action(name, body = {}) {
        return api('POST', `agent-sessions/${encodeURIComponent(this.agentSessionId)}/${name}`, body);
    }

    async sendPrompt() {
        const text = this.el.input.value.trim();
        if (!text) return;
        this.el.input.value = '';
        try {
            await this.action('prompt', { text });
        } catch (e) {
            this.el.input.value = text;
            toast(e.message, { tone: 'error' });
        }
    }

    // ---------- rendering ----------

    applySession(session) {
        this.session = session;
        this.cwd = session.cwd;
        this.el.title.textContent = session.agentLabel;
        this.renderStatus(session.status);
        this.renderSelectors();
    }

    modelOption() {
        return (this.session?.capabilities?.configOptions || []).find(o => o.category === 'model' && o.type === 'select') || null;
    }

    renderSelectors() {
        const caps = this.session?.capabilities || {};
        const modes = caps.modeList || [];
        this.el.mode.hidden = !modes.length;
        this.el.mode.innerHTML = modes.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
        if (this.session?.mode) this.el.mode.value = this.session.mode;
        const model = this.modelOption();
        this.el.model.hidden = !model;
        if (model) {
            this.el.model.innerHTML = model.options.map(o => `<option value="${esc(o.value)}">${esc(o.name)}</option>`).join('');
            this.el.model.value = model.currentValue;
        }
    }

    renderStatus(status) {
        if (this.session) this.session.status = status;
        this.el.status.textContent = STATUS_LABEL[status] || status;
        this.el.status.dataset.state = status;
        const busy = status === 'thinking' || status === 'waiting_permission';
        this.el.stop.hidden = !busy;
        this.el.send.disabled = busy || status === 'starting';
        this.el.resume.hidden = status !== 'stopped';
        this.process = busy ? 'agente' : null;
        this.hooks.onInfo?.(this);
    }

    append(html, className) {
        const log = this.el.log;
        const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        const div = document.createElement('div');
        div.className = className;
        div.innerHTML = html;
        log.appendChild(div);
        if (stick) log.scrollTop = log.scrollHeight;
        if (!this.active) this.hasActivity = true;
        return div;
    }

    note(text, tone = '') {
        this.append(esc(text), `agent-note ${tone}`);
    }

    applyEvent(event) {
        if (event.seq <= this.lastSeq) return; // already shown (replay overlap)
        this.lastSeq = event.seq;
        const d = event.data || {};
        switch (event.type) {
            case 'status':
                this.renderStatus(d.state);
                if (d.state !== 'thinking') this.current = null;
                break;
            case 'session.start':
                if (this.session) Object.assign(this.session, { capabilities: d.capabilities, mode: d.mode });
                this.renderSelectors();
                this.note(d.resumed ? 'Conversa retomada.' : `Sessão iniciada em ${d.cwd}`);
                break;
            case 'message.user':
                this.current = null;
                this.append(esc(d.text), 'agent-msg user');
                break;
            case 'message.assistant.delta':
                if (!this.current) this.current = this.append('', 'agent-msg assistant');
                this.current.textContent += d.text;
                break;
            case 'message.assistant.done':
                this.current = null;
                if (d.stopReason === 'cancelled') this.note('Interrompido.');
                break;
            case 'thought.delta':
                // Reasoning is shown dimmed and compact (full view in phase 4)
                if (!this.thought || this.current) this.thought = this.append('', 'agent-thought');
                this.thought.textContent += d.text;
                break;
            case 'tool.start':
                this.thought = null;
                this.current = null;
                this.renderTool(d, 'running');
                break;
            case 'tool.update':
                this.renderTool(d, d.status === 'in_progress' ? 'running' : null);
                break;
            case 'tool.result':
                this.renderTool(d, d.status);
                break;
            case 'subagent.update':
                if (d.agentType || d.description) this.note(`Subagente ${d.agentType || ''}: ${d.description || ''}${d.async ? ' (em segundo plano)' : ''}`);
                break;
            case 'subagent.end':
                this.note(`Subagente terminou${d.totalTokens ? ` · ${d.totalTokens} tokens` : ''}`);
                break;
            case 'permission.request':
                this.renderPermission(d);
                break;
            case 'permission.response': {
                const card = this.el.log.querySelector(`[data-permission="${CSS.escape(d.permissionId)}"]`);
                if (card) {
                    card.classList.add('answered');
                    card.querySelector('.agent-perm-actions').textContent = d.outcome === 'selected' ? `Respondido: ${d.optionId}` : 'Cancelado';
                }
                break;
            }
            case 'mode.update':
                if (this.session) this.session.mode = d.modeId;
                this.el.mode.value = d.modeId;
                break;
            case 'config.update':
                if (this.session) this.session.capabilities = { ...this.session.capabilities, configOptions: d.options };
                this.renderSelectors();
                break;
            case 'plan.update':
                this.append(d.steps.map(s => `<div>${s.status === 'completed' ? '✓' : '○'} ${esc(s.content)}</div>`).join(''), 'agent-plan');
                break;
            case 'error':
                this.note(d.message + (d.detail ? `\n${d.detail}` : ''), 'error');
                break;
            case 'raw':
                // Nothing is hidden: unmapped events are listed (collapsed) for inspection
                this.append(`<details><summary>evento bruto · ${esc(d.source)}</summary><pre>${esc(JSON.stringify(d.payload, null, 2))}</pre></details>`, 'agent-raw');
                break;
            default:
                break; // usage, commands, session.info...: shown by the full UI (phase 4)
        }
    }

    renderTool(d, status) {
        let card = this.tools.get(d.toolId);
        if (!card) {
            card = this.append(`<details><summary><span class="agent-tool-icon"></span><span class="agent-tool-title"></span><span class="agent-tool-state"></span></summary><pre class="agent-tool-out"></pre></details>`,
                `agent-tool${d.parentToolId ? ' nested' : ''}`);
            card.querySelector('.agent-tool-icon').innerHTML = icon(TOOL_ICON[d.kind] || 'bolt', 14);
            this.tools.set(d.toolId, card);
        }
        if (d.title) card.querySelector('.agent-tool-title').textContent = d.title;
        if (status) {
            card.dataset.status = status;
            card.querySelector('.agent-tool-state').textContent = status === 'running' ? '…' : status === 'completed' ? '✓' : '✕';
        }
        const out = [];
        if (d.input && d.input.command) out.push(`$ ${d.input.command}`);
        if (d.diffs && d.diffs.length) out.push(...d.diffs.map(x => `--- ${x.path}\n${x.newText}`));
        if (d.output) out.push(d.output);
        if (out.length) card.querySelector('.agent-tool-out').textContent = out.join('\n');
    }

    renderPermission(d) {
        const detail = d.input && d.input.command ? d.input.command
            : d.diffs && d.diffs.length ? d.diffs.map(x => x.path).join(', ') : '';
        const html = `
            <div class="agent-perm-title">${icon('shield', 15)} ${esc(d.title)}</div>
            ${detail ? `<pre>${esc(detail)}</pre>` : ''}
            <div class="agent-perm-actions">${d.options.map(o => `<button type="button" class="btn ${o.kind.startsWith('allow') ? 'btn-primary' : ''}" data-perm-option="${esc(o.id)}">${esc(o.name)}</button>`).join('')}</div>`;
        const card = this.append(html, 'agent-perm');
        card.dataset.permission = d.permissionId;
        if (!this.active) this.hooks.onActivity?.(this);
    }

    async onLogClick(e) {
        const button = e.target.closest('[data-perm-option]');
        if (!button) return;
        const card = button.closest('[data-permission]');
        card.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
            await this.action('permission', { permissionId: card.dataset.permission, optionId: button.dataset.permOption });
        } catch (err) {
            toast(err.message, { tone: 'error' });
        }
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
        if (this.ws) {
            this.ws.onclose = null;
            this.ws.close();
        }
        this.panel.remove();
    }
}
