#!/usr/bin/env node
/**
 * agy-acp.js
 * ACP adapter for agy (Antigravity CLI), which has no ACP mode of its own. Speaks ACP over
 * stdio to the gateway and drives `agy --input-format stream-json --output-format stream-json`
 * underneath (one process per session, one NDJSON line in per prompt, `step_update` events out).
 *
 * Limits of agy's headless mode: it never asks for permissions (the tools just run) and does not
 * stream its reasoning; history cannot be listed or replayed, but a conversation can be resumed
 * (`--conversation <id>`).
 */
const { spawn, execFile } = require('child_process');
const readline = require('readline');

const AGY = process.env.AGY_BIN || 'agy';
const PROTOCOL_VERSION = 1;

const MODES = [
    { id: 'default', name: 'Padrão', description: 'Comportamento padrão do agy' },
    { id: 'accept-edits', name: 'Aceitar edições', description: 'Aplica as edições de arquivo sem perguntar' },
    { id: 'plan', name: 'Plan', description: 'Planeja sem alterar arquivos' },
];

/** agy tool name -> ACP ToolKind. */
function toolKind(name) {
    if (/^(view_file|list_dir|read_resource|list_resources)$/.test(name)) return 'read';
    if (/^(write_to_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$/.test(name)) return 'edit';
    if (/^(run_command|command_status|send_command_input)$/.test(name)) return 'execute';
    if (/^(grep_search|find_by_name)$/.test(name)) return 'search';
    if (/^(read_url_content|search_web|open_browser_url|read_browser_page)$/.test(name)) return 'fetch';
    return 'other';
}

const PATH_KEYS = ['AbsolutePath', 'TargetFile', 'File', 'FilePath', 'Path', 'DirectoryPath', 'SearchPath'];

function locationsOf(parameters) {
    const found = PATH_KEYS.map(k => parameters && parameters[k]).filter(v => typeof v === 'string' && v.startsWith('/'));
    return found.slice(0, 1).map(path => ({ path }));
}

function titleOf(name, parameters) {
    const p = parameters || {};
    const detail = p.CommandLine || p.Query || p.Url || p.URL || p.AbsolutePath || p.TargetFile || p.DirectoryPath || '';
    const label = name.replace(/_/g, ' ');
    return detail ? `${label}: ${String(detail).slice(0, 140)}` : label;
}

function blockText(block) {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') return block.text || '';
    if (block.type === 'resource_link') return block.uri || block.name || '';
    if (block.type === 'resource' && block.resource) return block.resource.text || block.resource.uri || '';
    return '';
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const fail = (id, message, code = -32000) => send({ id, error: { code, message } });
const log = (...args) => process.stderr.write(`${args.join(' ')}\n`);

/** Model list from `agy models` ("id<TAB>Label" lines); empty when it cannot be fetched. */
function fetchModels() {
    return new Promise((resolve) => {
        execFile(AGY, ['models'], { timeout: 15000 }, (error, stdout) => {
            if (error) return resolve([]);
            resolve(String(stdout).split('\n').map(l => l.split('\t')).filter(p => p.length >= 2 && /^[\w.-]+$/.test(p[0].trim()))
                .map(([value, name]) => ({ value: value.trim(), name: name.trim() })));
        });
    });
}

class Session {
    constructor({ cwd, model, mode }) {
        this.cwd = cwd;
        this.model = model;
        this.mode = mode;
        this.id = null;          // agy conversation id (= ACP session id)
        this.child = null;
        this.turn = null;        // { resolve, reject, tools: Set } of the prompt being answered
        this.lastError = '';
    }

    args() {
        const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
        if (this.id) args.push('--conversation', this.id);
        if (this.model) args.push('--model', this.model);
        if (this.mode && this.mode !== 'default') args.push('--mode', this.mode);
        args.push('-p=');
        return args;
    }

    /** Starts agy and resolves once its `init` event arrives (it carries the conversation id). */
    start() {
        return new Promise((resolve, reject) => {
            const child = spawn(AGY, this.args(), { cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
            this.child = child;
            let ready = false;
            child.once('error', error => !ready && reject(new Error(`Não foi possível iniciar "${AGY}": ${error.message}`)));
            child.stdin.on('error', () => {});
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => { this.lastError = chunk.trim().split('\n').pop() || this.lastError; });
            readline.createInterface({ input: child.stdout }).on('line', (line) => {
                let event;
                try { event = JSON.parse(line); } catch { return; }
                if (event.event === 'init') {
                    this.id = this.id || event.conversation_id;
                    if (!ready) { ready = true; resolve(event); }
                    return;
                }
                this.onEvent(event);
            });
            child.once('close', (code) => {
                if (this.child === child) this.child = null;
                if (!ready) reject(new Error(this.lastError || `agy saiu com código ${code}`));
                else if (this.turn) this.endTurn(new Error(this.lastError || `agy encerrou (código ${code})`));
            });
        });
    }

    stop() {
        const child = this.child;
        this.child = null;
        if (child) child.kill('SIGTERM');
    }

    update(update) {
        send({ method: 'session/update', params: { sessionId: this.id, update } });
    }

    onEvent(event) {
        if (event.event === 'result') {
            const r = event.result || {};
            if (r.status === 'SUCCESS') this.endTurn(null, 'end_turn', r.usage);
            else this.endTurn(new Error(r.error || 'agy falhou'));
            return;
        }
        if (event.event !== 'step_update' || !this.turn) return;
        const s = event.step_update;
        if (s.step_type === 'agent_response' && s.text_delta) {
            this.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: s.text_delta } });
        } else if (s.step_type === 'tool') {
            const info = s.tool_info || {};
            const name = s.tool_name || info.name || 'tool';
            const toolCallId = `${this.id}-${s.step_index}`;
            if (!this.turn.tools.has(toolCallId)) {
                this.turn.tools.add(toolCallId);
                this.update({
                    sessionUpdate: 'tool_call', toolCallId, title: titleOf(name, info.parameters), kind: toolKind(name),
                    status: 'in_progress', rawInput: info.parameters || {}, locations: locationsOf(info.parameters),
                });
            }
            if (s.state === 'DONE') {
                this.update({
                    sessionUpdate: 'tool_call_update', toolCallId, status: s.error ? 'failed' : 'completed',
                    title: titleOf(name, info.parameters), rawInput: info.parameters || {},
                    ...(info.output != null ? { rawOutput: info.output } : {}),
                });
            }
        }
    }

    endTurn(error, stopReason, usage) {
        const turn = this.turn;
        if (!turn) return;
        this.turn = null;
        if (error) return turn.reject(error);
        if (usage && usage.total_tokens) this.update({ sessionUpdate: 'usage_update', used: usage.total_tokens, size: null });
        turn.resolve(stopReason);
    }

    async prompt(text) {
        if (!this.child) await this.start(); // after a cancel/crash: continue the same conversation
        return new Promise((resolve, reject) => {
            this.turn = { resolve, reject, tools: new Set() };
            this.child.stdin.write(JSON.stringify({ event: 'user', message: { content: text } }) + '\n');
        });
    }

    cancel() {
        if (!this.turn) return;
        // agy has no cancel message: end the process; the next prompt resumes the conversation
        this.endTurn(null, 'cancelled');
        this.stop();
    }
}

const sessions = new Map();
let models = null;

async function configOptions(session) {
    if (!models) models = await fetchModels();
    const list = models.slice();
    if (session.model && !list.some(m => m.value === session.model)) list.unshift({ value: session.model, name: session.model });
    if (!list.length) return [];
    return [{
        id: 'model', name: 'Modelo', category: 'model', type: 'select',
        currentValue: session.model || list[0].value, options: list,
    }];
}

async function sessionResult(session) {
    return {
        sessionId: session.id,
        modes: { currentModeId: session.mode || 'default', availableModes: MODES },
        configOptions: await configOptions(session),
    };
}

async function openSession({ cwd, sessionId }) {
    const session = new Session({ cwd: cwd || process.cwd(), model: null, mode: 'default' });
    if (sessionId) session.id = sessionId;
    await session.start();
    sessions.set(session.id, session);
    return session;
}

function requireSession(id) {
    const session = sessions.get(id);
    if (!session) throw new Error(`Sessão desconhecida: ${id}`);
    return session;
}

/** Model or mode changed: restart agy on the same conversation with the new flags. */
async function restart(session) {
    session.stop();
    await session.start();
}

const handlers = {
    initialize: async () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
            mcpCapabilities: { http: false, sse: false },
            sessionCapabilities: { resume: {} },
        },
        agentInfo: { name: 'agy', title: 'agy (Antigravity CLI)', version: '1' },
        authMethods: [],
    }),
    'session/new': async (params) => sessionResult(await openSession({ cwd: params.cwd })),
    'session/resume': async (params) => sessionResult(await openSession({ cwd: params.cwd, sessionId: params.sessionId })),
    'session/prompt': async (params) => {
        const session = requireSession(params.sessionId);
        const text = (params.prompt || []).map(blockText).filter(Boolean).join('\n');
        return { stopReason: await session.prompt(text) };
    },
    'session/set_mode': async (params) => {
        const session = requireSession(params.sessionId);
        if (!MODES.some(m => m.id === params.modeId)) throw new Error(`Modo desconhecido: ${params.modeId}`);
        session.mode = params.modeId;
        await restart(session);
        return {};
    },
    'session/set_config_option': async (params) => {
        const session = requireSession(params.sessionId);
        if (params.configId !== 'model') throw new Error(`Opção desconhecida: ${params.configId}`);
        session.model = params.value;
        await restart(session);
        return { configOptions: await configOptions(session) };
    },
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'session/cancel') {
        const session = sessions.get(message.params && message.params.sessionId);
        if (session) session.cancel();
        return;
    }
    if (message.method == null || message.id == null) return; // notifications and responses we do not use
    const handler = handlers[message.method];
    if (!handler) return fail(message.id, `${message.method} não é suportado pelo adaptador do agy`, -32601);
    try {
        reply(message.id, await handler(message.params || {}));
    } catch (error) {
        log(error.message);
        fail(message.id, error.message);
    }
});

const shutdown = () => { for (const s of sessions.values()) s.stop(); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.on('end', shutdown);
