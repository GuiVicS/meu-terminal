/**
 * gateway.js
 * Agent gateway: one ACP agent process per UI session, normalized events persisted with a
 * monotonic seq (replay after reconnect), permission requests that wait for any device to answer.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { AcpClient } = require('./acp-client');
const { AcpMapper, normalizeConfigOptions } = require('./acp-mapping');
const { validateEvent } = require('./events');
const { loadAgents } = require('./registry');

const MAX_QUEUE = 20; // messages waiting while the agent works ("modo fila")

const ACP_PROTOCOL_VERSION = 1;

class GatewayError extends Error {
    /** status: HTTP-like code the routes can pass through (400, 404, 409, 429...). */
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/**
 * Modes come either as ACP `modes` (Claude) or only as a config option of category 'mode'
 * (OpenCode: build/plan). Returns { modeList, modeSource, modeConfigId, currentMode }.
 */
function deriveModes(session, configOptions) {
    const modes = session && session.modes;
    if (modes && Array.isArray(modes.availableModes) && modes.availableModes.length) {
        return {
            modeList: modes.availableModes.map(m => ({ id: m.id, name: m.name || m.id, description: m.description || '' })),
            modeSource: 'modes',
            modeConfigId: null,
            currentMode: modes.currentModeId || null,
        };
    }
    const option = configOptions.find(o => o.category === 'mode' && o.type === 'select');
    if (option) {
        return {
            modeList: option.options.map(o => ({ id: o.value, name: o.name, description: o.description })),
            modeSource: 'config',
            modeConfigId: option.id,
            currentMode: option.currentValue,
        };
    }
    return { modeList: [], modeSource: null, modeConfigId: null, currentMode: null };
}

function currentModel(configOptions) {
    const option = configOptions.find(o => o.category === 'model' && o.type === 'select');
    return option ? option.currentValue : null;
}

/** Initialize + session/new results -> the capability flags the UI uses (events.js CAPABILITIES). */
function deriveCapabilities(init, session) {
    const agentCaps = (init && init.agentCapabilities) || {};
    const sessionCaps = agentCaps.sessionCapabilities || {};
    const prompt = agentCaps.promptCapabilities || {};
    const mcp = agentCaps.mcpCapabilities || {};
    const configOptions = normalizeConfigOptions(session && session.configOptions);
    const modes = deriveModes(session, configOptions);
    return {
        modes: modes.modeList.length > 0,
        plan: modes.modeList.some(m => m.id === 'plan'),
        todos: false,           // ACP reports todo lists as plan updates
        subagents: sessionCaps.subagents != null,
        slashCommands: false,   // turned on by the first commands.update
        mcp: !!(mcp.http || mcp.sse),
        images: !!prompt.image,
        resume: !!(agentCaps.loadSession || sessionCaps.resume),
        history: sessionCaps.list != null,
        config: configOptions.length > 0,
        usage: false,           // turned on by the first usage.update
        permissions: true,
        cancel: true,
        ...modes,
        configOptions,
        agentInfo: (init && init.agentInfo) || null,
    };
}

/** Last meaningful stderr line (the reason an agent failed), without ANSI colors. */
function lastLine(text) {
    const lines = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const line = lines.reverse().find(l => /error|erro|fail|not|unknown|invalid|denied|cannot|missing/i.test(l)) || lines[0] || '';
    return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

class AgentGateway extends EventEmitter {
    /**
     * @param {object} deps
     * @param {import('./agent-store')} deps.store
     * @param {object} [deps.agents] - registry (registry.js loadAgents())
     * @param {object} [deps.env] - environment for agent processes
     * @param {number} [deps.maxSessions] - agent processes running at the same time
     * @param {number} [deps.startTimeoutMs] - initialize / session/new timeout
     * @param {number} [deps.maxText] - max chars per tool output / diff side
     * @param {boolean} [deps.validate] - check every event against events.js (dev/tests)
     * @param {object[]} [deps.mcpServers] - ACP MCP servers given to every session (e.g. MeuTerminal's own)
     * @param {Function} [deps.routeEnv] - async ({ agent, route }) => extra env for that route
     * @param {Function} [deps.log]
     *
     * Emits 'event' with every normalized event envelope ({ sessionId, seq, type, at, data }).
     */
    constructor({ store, agents = loadAgents(), env = process.env, maxSessions = 4, startTimeoutMs = 60000,
        maxText, validate = false, mcpServers = [], mediaDir = null, routeEnv = null, log = () => {} }) {
        super();
        this.store = store;
        this.agents = agents;
        this.env = env;
        // async ({ agent, route }) => extra env (scripts/addon-services.js); may start a service or throw
        this.routeEnv = routeEnv;
        this.maxSessions = maxSessions;
        this.startTimeoutMs = startTimeoutMs;
        this.maxText = maxText;
        this.validate = validate;
        this.mcpServers = mcpServers;
        this.mediaDir = mediaDir; // images/files the agents produce (served by /api/agent-media)
        this.log = log;
        this.runtimes = new Map(); // sessionId -> running agent state
        // Agent processes never survive a server restart
        this.store.recoverAfterRestart();
    }

    // ---------- queries ----------

    listAgents() {
        return Object.entries(this.agents).map(([id, a]) => ({
            id, label: a.label, uiName: a.uiName, terminalOnly: !!a.terminalOnly,
        }));
    }

    list({ includeClosed = false } = {}) {
        return this.store.listSessions({ includeClosed }).map(row => this.toPublic(row));
    }

    get(sessionId) {
        const row = this.store.getSession(sessionId);
        return row ? this.toPublic(row) : null;
    }

    toPublic(row) {
        const agent = this.agents[row.agent] || {};
        return {
            id: row.id,
            agent: row.agent,
            agentLabel: agent.label || row.agent,
            cwd: row.cwd,
            title: row.title,
            route: row.route || null,
            status: row.status,
            running: this.runtimes.has(row.id),
            mode: row.mode,
            capabilities: row.capabilities,
            lastSeq: row.last_seq,
            pendingPermissions: this.store.pendingPermissions(row.id),
            queue: this.queueSummary(this.runtimes.get(row.id)),
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    /** Replay: events after `sinceSeq` (exclusive). */
    events(sessionId, sinceSeq = 0) {
        this.requireSession(sessionId);
        return this.store.eventsSince(sessionId, sinceSeq);
    }

    requireSession(sessionId) {
        const row = this.store.getSession(sessionId);
        if (!row) throw new GatewayError('Sessão não encontrada.', 404);
        return row;
    }

    requireRuntime(sessionId) {
        this.requireSession(sessionId);
        const runtime = this.runtimes.get(sessionId);
        if (!runtime || !runtime.ready) throw new GatewayError('O agente desta sessão não está rodando.', 409);
        return runtime;
    }

    // ---------- lifecycle ----------

    /**
     * Starts a new agent session. Resolves once the agent is ready for a prompt.
     * resumeAcpSessionId continues a conversation the agent already has (listHistory), e.g. one
     * started in the terminal; if the agent cannot resume it, a new conversation starts.
     */
    async startSession({ agent, cwd, title = null, resumeAcpSessionId = null, route = null }) {
        const def = this.agents[agent];
        if (!def) throw new GatewayError(`Agente desconhecido: ${agent}`);
        if (def.terminalOnly) throw new GatewayError(`${def.label} só funciona no terminal.`);
        if (typeof cwd !== 'string' || !cwd) throw new GatewayError('Pasta inválida.');
        this.checkCapacity();
        // Before saving anything: a route whose service can't start fails here, without a dead tab
        await this.envFor({ agent, route });
        const id = crypto.randomUUID();
        this.store.insertSession({ id, agent, cwd, title, route });
        if (resumeAcpSessionId) this.store.updateSession(id, { acp_session_id: String(resumeAcpSessionId) });
        // A conversation from the terminal (or another app): its history is not in our log yet
        await this.spawnAgent(id, { resume: !!resumeAcpSessionId, importHistory: !!resumeAcpSessionId });
        return this.get(id);
    }

    /** Restarts the agent of a stopped session, resuming its conversation when the agent can. */
    async resumeSession(sessionId) {
        const row = this.requireSession(sessionId);
        if (row.status === 'closed') throw new GatewayError('Sessão encerrada.', 409);
        if (this.runtimes.has(sessionId)) return this.get(sessionId);
        this.checkCapacity();
        await this.spawnAgent(sessionId, { resume: true });
        return this.get(sessionId);
    }

    /**
     * Past conversations the agent itself knows for a folder (ACP session/list), including ones
     * started in the terminal. Starts a short-lived agent process just to ask.
     */
    /** Environment for an agent process: the gateway's own plus the session's route. */
    async envFor({ agent, route }) {
        if (!this.routeEnv) return this.env;
        try {
            return { ...this.env, ...(await this.routeEnv({ agent, route })) };
        } catch (e) {
            throw new GatewayError(e.message, e.status || 400);
        }
    }

    async listHistory({ agent, cwd, maxPages = 5 }) {
        const def = this.agents[agent];
        if (!def || def.terminalOnly) throw new GatewayError(`Agente sem histórico: ${agent}`);
        const client = new AcpClient({ command: def.command, args: def.args, cwd, env: this.env, log: this.log });
        try {
            await client.start();
            const init = await client.request('initialize', {
                protocolVersion: ACP_PROTOCOL_VERSION,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            }, { timeoutMs: this.startTimeoutMs });
            const caps = (init && init.agentCapabilities && init.agentCapabilities.sessionCapabilities) || {};
            if (caps.list == null) return [];
            const sessions = [];
            let cursor = null;
            for (let page = 0; page < maxPages; page++) {
                const result = await client.request('session/list', { cwd, ...(cursor ? { cursor } : {}) }, { timeoutMs: this.startTimeoutMs });
                for (const s of (result && result.sessions) || []) {
                    sessions.push({ sessionId: s.sessionId, cwd: s.cwd, title: s.title || null, updatedAt: s.updatedAt || null });
                }
                cursor = result && result.nextCursor;
                if (!cursor) break;
            }
            return sessions;
        } catch (error) {
            if (/Could not start/.test(error.message)) throw new GatewayError(`Não encontrei "${def.command}". Instale com: ${def.install}`, 424);
            throw new GatewayError(`Não foi possível listar o histórico: ${error.message}`, 502);
        } finally {
            await client.kill();
        }
    }

    checkCapacity() {
        if (this.runtimes.size >= this.maxSessions) {
            throw new GatewayError(`Limite de ${this.maxSessions} agentes rodando ao mesmo tempo. Feche uma sessão.`, 429);
        }
    }

    async spawnAgent(sessionId, { resume, importHistory = false }) {
        const row = this.store.getSession(sessionId);
        const def = this.agents[row.agent];
        const mapper = new AcpMapper({ maxText: this.maxText });
        const runtime = {
            client: null, mapper, ready: false, closing: false, loading: false,
            acpSessionId: null, prompting: false, mode: row.mode, capabilities: row.capabilities || {},
            permissions: new Map(), // permissionId -> resolve(outcome)
        };
        this.runtimes.set(sessionId, runtime);
        this.setState(sessionId, 'starting');

        let env;
        try {
            env = await this.envFor(row);
        } catch (e) {
            this.runtimes.delete(sessionId);
            this.setState(sessionId, 'stopped');
            throw e;
        }
        const client = new AcpClient({
            command: def.command,
            args: def.args,
            cwd: row.cwd,
            env,
            log: this.log,
            onRequest: (method, params) => this.onAgentRequest(sessionId, method, params),
        });
        runtime.client = client;
        client.on('notification', (method, params) => this.onNotification(sessionId, method, params));
        client.on('exit', (info) => this.onExit(sessionId, info));

        try {
            await client.start();
            const init = await client.request('initialize', {
                protocolVersion: ACP_PROTOCOL_VERSION,
                // The agents use their own file and shell tools; the UI only observes and approves
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
                clientInfo: { name: 'meuterminal', version: require('../../package.json').version },
            }, { timeoutMs: this.startTimeoutMs });

            const session = await this.openAcpSession(runtime, row, init, resume, importHistory);
            if (session.imported) this.finishImport(sessionId, runtime);
            runtime.acpSessionId = session.sessionId;
            runtime.capabilities = { ...deriveCapabilities(init, session.result), resumed: session.resumed };
            runtime.mode = runtime.capabilities.currentMode || runtime.mode;
            runtime.ready = true;
            const model = currentModel(runtime.capabilities.configOptions);
            this.store.updateSession(sessionId, {
                acp_session_id: session.sessionId,
                capabilities: runtime.capabilities,
                mode: runtime.mode,
                model,
            });
            this.emitEvent(sessionId, 'session.start', {
                agent: row.agent, cwd: row.cwd, capabilities: runtime.capabilities, mode: runtime.mode, model, resumed: session.resumed,
            });
            this.setState(sessionId, 'idle');
        } catch (error) {
            const stderr = client.stderr.slice(-5).join('\n');
            const missing = /Could not start/.test(error.message);
            const message = missing
                ? `Não encontrei "${def.command}". Instale com: ${def.install}`
                : `Falha ao iniciar ${def.label}: ${error.message}${lastLine(stderr) ? ` — ${lastLine(stderr)}` : ''}`;
            this.emitEvent(sessionId, 'error', { message, detail: stderr || null });
            runtime.closing = true;
            await client.kill();
            this.runtimes.delete(sessionId);
            this.setState(sessionId, 'stopped');
            throw new GatewayError(message, missing ? 424 : 502);
        }
    }

    /**
     * New session, or the previous agent session: session/resume (no history replay) when
     * supported, else session/load (the agent replays history, which we already have: ignored).
     * importHistory (a conversation we never saw, e.g. from the terminal): session/load first,
     * and its replay becomes our events so the UI shows the whole conversation.
     */
    async openAcpSession(runtime, row, init, resume, importHistory = false) {
        const params = { cwd: row.cwd, mcpServers: this.mcpServers };
        const caps = (init && init.agentCapabilities) || {};
        const timeout = { timeoutMs: this.startTimeoutMs };
        if (resume && row.acp_session_id && importHistory && caps.loadSession) {
            runtime.importing = { user: null, assistantOpen: false };
            try {
                // A long conversation takes a while to replay
                const result = await runtime.client.request('session/load', { ...params, sessionId: row.acp_session_id }, { timeoutMs: Math.max(this.startTimeoutMs, 120000) });
                return { sessionId: row.acp_session_id, result, resumed: true, imported: true };
            } catch (error) {
                this.log('Agent session load (import) failed, trying resume:', error.message);
                runtime.importing = null;
            }
        }
        if (resume && row.acp_session_id) {
            try {
                if (caps.sessionCapabilities && caps.sessionCapabilities.resume) {
                    const result = await runtime.client.request('session/resume', { ...params, sessionId: row.acp_session_id }, timeout);
                    return { sessionId: row.acp_session_id, result, resumed: true };
                }
                if (caps.loadSession) {
                    runtime.loading = true;
                    const result = await runtime.client.request('session/load', { ...params, sessionId: row.acp_session_id }, timeout);
                    return { sessionId: row.acp_session_id, result, resumed: true };
                }
            } catch (error) {
                this.log('Agent session resume failed, starting a new one:', error.message);
            } finally {
                runtime.loading = false;
            }
        }
        const result = await runtime.client.request('session/new', params, timeout);
        return { sessionId: result.sessionId, result, resumed: false };
    }

    /** Stops the agent and closes the session for good. */
    async closeSession(sessionId) {
        this.requireSession(sessionId);
        await this.stopAgent(sessionId);
        this.emitEvent(sessionId, 'session.end', { reason: 'closed' });
        this.store.updateSession(sessionId, { status: 'closed', closed_at: Date.now() });
        this.emit('sessions');
    }

    /** Stops the agent process but keeps the session (it can be resumed). */
    async stopAgent(sessionId) {
        const runtime = this.runtimes.get(sessionId);
        if (!runtime) return;
        runtime.closing = true;
        this.cancelPermissions(sessionId, runtime);
        await runtime.client.kill();
        this.runtimes.delete(sessionId);
        this.setState(sessionId, 'stopped');
    }

    async shutdown() {
        await Promise.all([...this.runtimes.keys()].map(id => this.stopAgent(id)));
    }

    onExit(sessionId, { code, signal, stderr }) {
        const runtime = this.runtimes.get(sessionId);
        // Still starting: the pending initialize/session/new rejects and spawnAgent reports it
        if (!runtime || runtime.closing || !runtime.ready) return;
        this.runtimes.delete(sessionId);
        this.cancelPermissions(sessionId, runtime);
        this.emitEvent(sessionId, 'error', {
            message: `O agente parou inesperadamente (código ${code}${signal ? `, sinal ${signal}` : ''}).`,
            detail: stderr.slice(-5).join('\n') || null,
        });
        this.setState(sessionId, 'stopped');
    }

    // ---------- conversation ----------

    /**
     * Sends a user message and resolves with the stop reason when the turn ends.
     * One turn at a time per session (the UI disables the send button meanwhile).
     */
    /**
     * @param {string} sessionId
     * @param {string} text
     * @param {{ images?: Array<{ mimeType: string, data: string }> }} [opts] - base64 images (pasted/attached)
     */
    async prompt(sessionId, text, { images = [] } = {}) {
        const runtime = this.requireRuntime(sessionId);
        if (typeof text !== 'string') text = '';
        if (!text.trim() && !images.length) throw new GatewayError('Mensagem vazia.');
        if (runtime.prompting) throw new GatewayError('O agente ainda está respondendo.', 409);
        if (images.length && !runtime.capabilities.images) throw new GatewayError('Este agente não aceita imagens.');
        for (const image of images) {
            if (!/^image\/(png|jpeg|gif|webp)$/.test(image && image.mimeType) || typeof image.data !== 'string') {
                throw new GatewayError('Imagem inválida (use PNG, JPEG, GIF ou WebP).');
            }
        }
        runtime.prompting = true;
        const row = this.store.getSession(sessionId);
        if (!row.title && text.trim()) this.store.updateSession(sessionId, { title: text.trim().replace(/\s+/g, ' ').slice(0, 60) });
        // The event log keeps only the images' type and size (not the bytes)
        this.emitEvent(sessionId, 'message.user', {
            text,
            // Saved to disk too, so the conversation shows them again after a reload
            ...(images.length ? { images: images.map(i => this.storeMedia(sessionId, { kind: 'image', mimeType: i.mimeType, data: i.data })) } : {}),
        });
        this.setState(sessionId, 'thinking');
        try {
            const prompt = [
                ...images.map(i => ({ type: 'image', mimeType: i.mimeType, data: i.data })),
                ...(text.trim() ? [{ type: 'text', text }] : []),
            ];
            const result = await runtime.client.request('session/prompt', {
                sessionId: runtime.acpSessionId,
                prompt,
            }, { timeoutMs: 0 });
            const stopReason = (result && result.stopReason) || 'end_turn';
            this.emitEvent(sessionId, 'message.assistant.done', { stopReason });
            if (this.runtimes.has(sessionId)) this.setState(sessionId, 'idle');
            return stopReason;
        } catch (error) {
            // A dead agent is reported by onExit; only report errors of a live agent here
            if (this.runtimes.has(sessionId)) {
                this.emitEvent(sessionId, 'error', { message: error.message });
                this.setState(sessionId, 'idle');
            }
            throw new GatewayError(error.message, 502);
        } finally {
            runtime.prompting = false;
            // "modo fila": the next message goes on its own (setImmediate: after this turn's events)
            if ((runtime.queue || []).length) setImmediate(() => this.drainQueue(sessionId));
        }
    }

    // ---------- queue ("modo fila"): messages written while the agent works ----------

    /**
     * Sends now when the agent is free, else queues the message; queued messages go one per
     * turn, in order, as soon as the current turn ends. Returns { queued, id? }.
     */
    enqueue(sessionId, text, { images = [] } = {}) {
        const runtime = this.requireRuntime(sessionId);
        if (typeof text !== 'string') text = '';
        if (!text.trim() && !images.length) throw new GatewayError('Mensagem vazia.');
        if (images.length && !runtime.capabilities.images) throw new GatewayError('Este agente não aceita imagens.');
        runtime.queue = runtime.queue || [];
        if (!runtime.prompting && !runtime.queue.length) {
            this.prompt(sessionId, text, { images }).catch(e => this.log('Agent prompt:', e.message));
            return { queued: false };
        }
        if (runtime.queue.length >= MAX_QUEUE) throw new GatewayError(`A fila já tem ${MAX_QUEUE} mensagens.`, 429);
        const item = { id: crypto.randomUUID(), text, images, createdAt: new Date().toISOString() };
        runtime.queue.push(item);
        this.emitQueue(sessionId, runtime);
        return { queued: true, id: item.id };
    }

    /** Removes a queued message (it was not sent yet). */
    dequeue(sessionId, itemId) {
        const runtime = this.requireRuntime(sessionId);
        const before = (runtime.queue || []).length;
        runtime.queue = (runtime.queue || []).filter(i => i.id !== itemId);
        const removed = runtime.queue.length !== before;
        if (removed) this.emitQueue(sessionId, runtime);
        return removed;
    }

    /** What the windows show: text and image count (never the image bytes). */
    queueSummary(runtime) {
        return (runtime && runtime.queue || []).map(i => ({ id: i.id, text: i.text, images: i.images.length, createdAt: i.createdAt }));
    }

    emitQueue(sessionId, runtime) {
        this.emitEvent(sessionId, 'queue.update', { items: this.queueSummary(runtime) });
    }

    /** Turn over: the next queued message goes (unless the agent stopped or the session closed). */
    drainQueue(sessionId) {
        const runtime = this.runtimes.get(sessionId);
        if (!runtime || runtime.prompting || !runtime.ready || !(runtime.queue || []).length) return;
        const item = runtime.queue.shift();
        this.emitQueue(sessionId, runtime);
        this.prompt(sessionId, item.text, { images: item.images }).catch(e => this.log('Queued prompt:', e.message));
    }

    /** Stops the current turn (ESC / stop button). The prompt resolves with stopReason 'cancelled'. */
    cancel(sessionId) {
        const runtime = this.requireRuntime(sessionId);
        // ACP: the client must answer every pending permission request with "cancelled"
        this.cancelPermissions(sessionId, runtime);
        runtime.client.notify('session/cancel', { sessionId: runtime.acpSessionId });
    }

    async setMode(sessionId, modeId) {
        const runtime = this.requireRuntime(sessionId);
        const modes = runtime.capabilities.modeList || [];
        if (!modes.some(m => m.id === modeId)) throw new GatewayError(`Modo desconhecido: ${modeId}`);
        // OpenCode-style agents expose the mode only as a config option
        if (runtime.capabilities.modeSource === 'config') {
            await this.setConfigOption(sessionId, runtime.capabilities.modeConfigId, modeId);
            return;
        }
        await runtime.client.request('session/set_mode', { sessionId: runtime.acpSessionId, modeId });
        this.applyMode(sessionId, runtime, modeId);
    }

    /** Changes a session config option (model, reasoning effort, mode...). */
    async setConfigOption(sessionId, configId, value) {
        const runtime = this.requireRuntime(sessionId);
        const option = (runtime.capabilities.configOptions || []).find(o => o.id === configId);
        if (!option) throw new GatewayError(`Opção desconhecida: ${configId}`);
        const params = { sessionId: runtime.acpSessionId, configId };
        if (option.type === 'boolean') {
            if (typeof value !== 'boolean') throw new GatewayError(`${option.name}: valor inválido.`);
            Object.assign(params, { type: 'boolean', value });
        } else {
            if (!option.options.some(o => o.value === value)) throw new GatewayError(`${option.name}: valor inválido.`);
            params.value = value;
        }
        const result = await runtime.client.request('session/set_config_option', params);
        // The agent answers with the full, possibly changed, list (a new model may change efforts)
        const options = result && Array.isArray(result.configOptions)
            ? normalizeConfigOptions(result.configOptions)
            : runtime.capabilities.configOptions.map(o => (o.id === configId ? { ...o, currentValue: value } : o));
        this.applyConfigOptions(sessionId, runtime, options);
    }

    /** New config options from the agent: persist, notify, and keep mode/model in sync. */
    applyConfigOptions(sessionId, runtime, options) {
        runtime.capabilities = { ...runtime.capabilities, configOptions: options, config: options.length > 0 };
        this.store.updateSession(sessionId, { capabilities: runtime.capabilities, model: currentModel(options) });
        this.emitEvent(sessionId, 'config.update', { options });
        if (runtime.capabilities.modeSource === 'config') {
            const modeOption = options.find(o => o.id === runtime.capabilities.modeConfigId);
            if (modeOption) this.applyMode(sessionId, runtime, modeOption.currentValue);
        }
    }

    applyMode(sessionId, runtime, modeId) {
        if (runtime.mode === modeId) return;
        runtime.mode = modeId;
        this.store.updateSession(sessionId, { mode: modeId });
        this.emitEvent(sessionId, 'mode.update', { modeId });
    }

    // ---------- permissions ----------

    /**
     * Answer from any device. optionId = one of the request's options, or null to cancel.
     * Returns false when the permission was already answered (e.g. on another device).
     */
    respondPermission(sessionId, permissionId, { optionId = null, answeredBy = null } = {}) {
        const runtime = this.runtimes.get(sessionId);
        const resolve = runtime && runtime.permissions.get(permissionId);
        if (!resolve) return false;
        const outcome = optionId ? 'selected' : 'cancelled';
        if (!this.store.answerPermission(permissionId, { outcome, optionId, answeredBy })) return false;
        runtime.permissions.delete(permissionId);
        this.emitEvent(sessionId, 'permission.response', { permissionId, outcome, optionId, answeredBy });
        if (!runtime.permissions.size && runtime.prompting) this.setState(sessionId, 'thinking');
        resolve(optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' });
        return true;
    }

    cancelPermissions(sessionId, runtime) {
        for (const permissionId of [...runtime.permissions.keys()]) {
            this.respondPermission(sessionId, permissionId, { optionId: null, answeredBy: 'system' });
        }
        this.store.expirePermissions(sessionId);
    }

    /** Agent -> client requests. Permissions wait for a human; fs/terminal are not offered. */
    onAgentRequest(sessionId, method, params) {
        if (method === 'session/request_permission') {
            const runtime = this.runtimes.get(sessionId);
            const permissionId = crypto.randomUUID();
            const request = { permissionId, ...runtime.mapper.mapPermission(params) };
            this.store.insertPermission({ id: permissionId, sessionId, request });
            const answer = new Promise(resolve => runtime.permissions.set(permissionId, resolve));
            this.emitEvent(sessionId, 'permission.request', request);
            this.setState(sessionId, 'waiting_permission');
            return answer.then(outcome => ({ outcome }));
        }
        const error = new Error(`${method} não é suportado pelo MeuTerminal`);
        error.code = -32601;
        throw error;
    }

    onNotification(sessionId, method, params) {
        const runtime = this.runtimes.get(sessionId);
        if (!runtime) return;
        if (method !== 'session/update') {
            this.emitEvent(sessionId, 'raw', { source: `acp:${method}`, payload: params ?? null });
            return;
        }
        // session/load replays the whole conversation: we already have it in our event log
        if (runtime.loading) return;
        for (const { type, data } of runtime.mapper.mapUpdate(params && params.update)) {
            // Importing a conversation: rebuild its turns from the replay
            if (runtime.importing) {
                const imp = runtime.importing;
                if (type === 'message.user') {
                    // A user message arrives in several chunks: one bubble
                    if (imp.user === null) {
                        if (imp.assistantOpen) this.emitEvent(sessionId, 'message.assistant.done', { stopReason: 'end_turn', replayed: true });
                        imp.assistantOpen = false;
                        imp.user = '';
                    }
                    imp.user += data.text || '';
                    continue;
                }
                this.flushImportedUser(sessionId, imp);
                if (type === 'message.assistant.delta' || type === 'thought.delta' || type.startsWith('tool.')) imp.assistantOpen = true;
            }
            if (type === 'mode.update') {
                this.applyMode(sessionId, runtime, data.modeId);
                continue;
            }
            if (type === 'config.update') {
                this.applyConfigOptions(sessionId, runtime, data.options);
                continue;
            }
            if (type === 'session.info' && data.title) this.store.updateSession(sessionId, { title: String(data.title).slice(0, 120) });
            if (type === 'commands.update') this.enableCapability(sessionId, runtime, 'slashCommands');
            if (type === 'usage.update') this.enableCapability(sessionId, runtime, 'usage');
            if (data && Array.isArray(data.media)) data.media = data.media.map(m => this.storeMedia(sessionId, m));
            this.emitEvent(sessionId, type, data);
        }
    }

    flushImportedUser(sessionId, imp) {
        if (imp.user === null) return;
        if (imp.user.trim()) this.emitEvent(sessionId, 'message.user', { text: imp.user, replayed: true });
        imp.user = null;
    }

    /** End of an imported replay: closes the last turn. */
    finishImport(sessionId, runtime) {
        const imp = runtime.importing;
        if (!imp) return;
        this.flushImportedUser(sessionId, imp);
        if (imp.assistantOpen) this.emitEvent(sessionId, 'message.assistant.done', { stopReason: 'end_turn', replayed: true });
        runtime.importing = null;
    }

    enableCapability(sessionId, runtime, name) {
        if (runtime.capabilities[name]) return;
        runtime.capabilities = { ...runtime.capabilities, [name]: true };
        this.store.updateSession(sessionId, { capabilities: runtime.capabilities });
    }

    // ---------- events ----------

    setState(sessionId, state) {
        const row = this.store.getSession(sessionId);
        if (!row || row.status === state) return;
        this.store.updateSession(sessionId, { status: state });
        this.emitEvent(sessionId, 'status', { state });
        this.emit('sessions');
    }

    /**
     * Media from an agent (or attached by the user): base64 data is written to
     * <mediaDir>/<sessionId>/ and replaced by a URL, so the event log stays small. Links to
     * files on this server keep their path (the UI opens them through the files API).
     */
    storeMedia(sessionId, media) {
        if (!media || typeof media !== 'object') return media;
        const { data, ...rest } = media;
        if (!data) {
            const uri = String(media.uri || '');
            const local = /^file:\/\//i.test(uri) ? decodeURIComponent(uri.replace(/^file:\/\//i, '')).replace(/^\/([a-zA-Z]:)/, '$1')
                : (uri.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(uri)) ? uri : null;
            return { ...rest, ...(local ? { path: local } : /^https?:\/\//i.test(uri) ? { url: uri } : {}) };
        }
        if (!this.mediaDir) return { ...rest, error: 'sem pasta para guardar' };
        let bytes;
        try {
            bytes = Buffer.from(String(data), 'base64');
        } catch {
            return { ...rest, error: 'conteúdo inválido' };
        }
        if (bytes.length > 25 * 1024 * 1024) return { ...rest, bytes: bytes.length, error: 'grande demais (máx. 25 MB)' };
        const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
            'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'application/pdf': 'pdf', 'text/plain': 'txt' };
        const fromName = /\.([a-z0-9]{1,8})$/i.exec(media.name || '');
        const ext = EXT[media.mimeType] || (fromName ? fromName[1].toLowerCase() : 'bin');
        const file = `${crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${ext}`;
        const dir = path.join(this.mediaDir, sessionId);
        try {
            fs.mkdirSync(dir, { recursive: true });
            const target = path.join(dir, file);
            if (!fs.existsSync(target)) fs.writeFileSync(target, bytes);
        } catch (e) {
            this.log('Agent media not saved:', e.message);
            return { ...rest, error: 'não foi possível salvar' };
        }
        return { ...rest, bytes: bytes.length, url: `api/agent-media/${encodeURIComponent(sessionId)}/${file}` };
    }

    emitEvent(sessionId, type, data) {
        const event = this.store.appendEvent(sessionId, type, data);
        if (this.validate) {
            const problems = validateEvent(event);
            if (problems.length) this.log('Invalid agent event:', problems.join('; '), JSON.stringify(event).slice(0, 300));
        }
        this.emit('event', event);
        return event;
    }
}

module.exports = { AgentGateway, GatewayError, deriveCapabilities, deriveModes };
