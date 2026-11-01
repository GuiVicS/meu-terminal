/**
 * fake-acp-agent.js
 * Scripted ACP agent for tests: answers initialize/session/new and plays a fixed turn with
 * thought, text, a permission, a plan, a subagent, usage and an unknown update.
 *
 * FAKE_AGENT_STYLE=config -> modes only as a config option (like OpenCode), not as ACP modes.
 * FAKE_AGENT_CRASH=on-start -> exits right away.
 * FAKE_AGENT_NO_RESUME=1 -> no session/resume: the client must fall back to session/load.
 */
const readline = require('readline');

const SESSION_ID = 'fake-session-1';
let pendingPermission = null; // id of our permission request waiting for the client
let promptId = null;          // id of the session/prompt being answered
let cancelled = false;
let nextId = 1000;
const CONFIG_STYLE = process.env.FAKE_AGENT_STYLE === 'config';

// Config options as real agents send them: grouped model select, mode select (config style), boolean
const config = {
    model: 'fast-1',
    mode: 'build',
    turbo: false,
};
function configOptions() {
    const options = [
        {
            id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: config.model,
            options: [{ group: 'fast', name: 'Rápidos', options: [{ value: 'fast-1', name: 'Fast 1' }] },
                { group: 'smart', name: 'Espertos', options: [{ value: 'smart-1', name: 'Smart 1' }] }],
        },
        { id: 'turbo', name: 'Turbo', category: 'model_config', type: 'boolean', currentValue: config.turbo },
    ];
    if (CONFIG_STYLE) {
        options.push({
            id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: config.mode,
            options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }],
        });
    }
    return options;
}

function sessionResult() {
    const result = { sessionId: SESSION_ID, configOptions: configOptions() };
    if (!CONFIG_STYLE) {
        result.modes = {
            currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan' }],
        };
    }
    return result;
}

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (u) => send({ method: 'session/update', params: { sessionId: SESSION_ID, update: u } });

// Some real agents print banners on stdout; the client must ignore them
process.stdout.write('fake agent banner (not JSON)\n');

if (process.env.FAKE_AGENT_CRASH === 'on-start') process.exit(3);

function finishTurn(stopReason) {
    send({ id: promptId, result: { stopReason } });
    promptId = null;
}

// "markdown" in the prompt: a rich answer (code, table, callout...) streamed in small chunks
const RICH_ANSWER = [
    '## Servidor HTTP em Node', '',
    'Crie o arquivo e rode com `node server.js`:', '',
    '```js title=server.js',
    "const http = require('http');",
    '',
    '// Responde "ok" em qualquer rota',
    'const server = http.createServer((req, res) => {',
    "    res.writeHead(200, { 'Content-Type': 'text/plain' });",
    "    res.end(`ok ${req.url}`);",
    '});',
    '',
    'server.listen(3000, () => console.log("ouvindo na 3000"));',
    '```', '',
    '> [!TIP]', '> Use `PORT=8080 node server.js` para outra porta.', '',
    '| Rota | Método | Resposta |', '|---|---|---|', '| `/` | GET | ok / |', '| `/saude` | GET | ok /saude |', '',
    '1. Instale as dependências:', '   ```bash', '   npm install', '   ```', '2. Rode o servidor', '',
    '```diff', '- const port = 3000;', '+ const port = process.env.PORT || 3000;', '```', '',
    'Pronto! Veja a [documentação](https://nodejs.org/api/http.html).',
].join('\n');

function playRich() {
    const chunks = RICH_ANSWER.match(/[\s\S]{1,24}/g);
    let i = 0;
    const timer = setInterval(() => {
        if (i < chunks.length) {
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunks[i++] }, messageId: 'rich' });
            return;
        }
        clearInterval(timer);
        finishTurn('end_turn');
    }, 15);
}

function playTurn(text) {
    if (text.includes('crash')) process.exit(7);
    if (text.includes('markdown')) return playRich();
    // "limite": responde como o Claude Code quando o limite da conta acaba (texto sintético)
    if (text.includes('limite')) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: "You've hit your 5-hour limit · resets 12:30am" }, messageId: 'lim' });
        return finishTurn('end_turn');
    }
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Pensando...' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Vou criar ' }, messageId: 'm1' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'o arquivo.' }, messageId: 'm1' });
    update({ sessionUpdate: 'plan', entries: [{ content: 'Criar ola.txt', status: 'in_progress', priority: 'high' }] });
    update({
        sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write ola.txt', kind: 'edit', status: 'pending',
        _meta: { claudeCode: { toolName: 'Write' } },
    });
    pendingPermission = nextId++;
    send({
        id: pendingPermission,
        method: 'session/request_permission',
        params: {
            sessionId: SESSION_ID,
            toolCall: {
                toolCallId: 't1', title: 'Write ola.txt', kind: 'edit',
                content: [{ type: 'diff', path: '/tmp/ola.txt', oldText: null, newText: 'oi' }],
            },
            options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
        },
    });
}

function afterPermission(outcome) {
    if (cancelled || outcome.outcome === 'cancelled') {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed' });
        finishTurn('cancelled');
        return;
    }
    const allowed = outcome.optionId === 'allow';
    update({
        sessionUpdate: 'tool_call_update', toolCallId: 't1', status: allowed ? 'completed' : 'failed',
        content: [{ type: 'content', content: { type: 'text', text: allowed ? 'Created ola.txt' : 'Denied' } }],
    });
    // A tool update for a tool never announced (the client must synthesize a card)
    update({ sessionUpdate: 'tool_call_update', toolCallId: 't2', title: 'git --version', kind: 'execute', status: 'completed', rawOutput: 'git version 2.x' });
    // A subagent, the way Claude reports it: details and summary arrive in updates
    const agentMeta = { claudeCode: { toolName: 'Agent' } };
    update({ sessionUpdate: 'tool_call', toolCallId: 'sub1', title: 'Task', kind: 'other', status: 'pending', rawInput: {}, _meta: agentMeta });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'sub1', rawInput: { description: 'Listar arquivos', subagent_type: 'Explore' }, _meta: agentMeta });
    update({
        sessionUpdate: 'tool_call', toolCallId: 'child1', title: 'ls', kind: 'execute', status: 'pending',
        _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'sub1' } },
    });
    update({
        sessionUpdate: 'tool_call_update', toolCallId: 'child1', status: 'completed',
        _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'sub1', toolResponse: { stdout: 'ola.txt', stderr: '' } } },
    });
    update({
        sessionUpdate: 'tool_call_update', toolCallId: 'sub1',
        _meta: { claudeCode: { toolName: 'Agent', toolResponse: { agentId: 'ag1', agentType: 'Explore', totalTokens: 500, totalDurationMs: 1200, totalToolUseCount: 1, content: [{ type: 'text', text: 'Só ola.txt.' }] } } },
    });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'sub1', status: 'completed', _meta: agentMeta });
    // FAKE_AGENT_MEDIA=1: an image generation tool (image block + link to a saved file), an
    // image in the answer itself and an internal "_auth" notice (like Codex/agy send)
    if (process.env.FAKE_AGENT_MEDIA) {
        const png = process.env.FAKE_AGENT_IMAGE
            ? require('fs').readFileSync(process.env.FAKE_AGENT_IMAGE).toString('base64')
            : 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: '_auth/status_update', params: { status: 'ok' } })}\n`);
        update({ sessionUpdate: 'tool_call', toolCallId: 'img1', title: 'Image generation', kind: 'other', status: 'pending', rawInput: { id: 'exec-1' } });
        update({
            sessionUpdate: 'tool_call_update', toolCallId: 'img1', status: 'completed',
            content: [
                { type: 'content', content: { type: 'text', text: 'Revised prompt: logo roxo' } },
                { type: 'content', content: { type: 'image', mimeType: 'image/png', data: png } },
                { type: 'content', content: { type: 'resource_link', uri: 'file:///tmp/relatorio.pdf', name: 'relatorio.pdf', mimeType: 'application/pdf', size: 2048 } },
            ],
        });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: png }, messageId: 'm2' });
    }
    update({ sessionUpdate: 'session_info_update', title: 'Criar ola.txt' });
    update({ sessionUpdate: 'usage_update', used: 1234, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
    update({ sessionUpdate: 'something_new_from_the_future', value: 42 });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Pronto.' : 'Negado.' }, messageId: 'm2' });
    finishTurn('end_turn');
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
    const msg = JSON.parse(line);
    // Response to our permission request
    if (msg.id === pendingPermission && !msg.method) {
        pendingPermission = null;
        afterPermission(msg.result.outcome);
        return;
    }
    switch (msg.method) {
        case 'initialize':
            send({
                id: msg.id,
                result: {
                    protocolVersion: 1,
                    agentInfo: { name: 'fake-agent', version: '1.0.0' },
                    agentCapabilities: {
                        loadSession: true,
                        promptCapabilities: { image: true },
                        mcpCapabilities: { http: true },
                        sessionCapabilities: process.env.FAKE_AGENT_NO_RESUME ? { subagents: {}, list: {} } : { resume: {}, subagents: {}, list: {} },
                    },
                },
            });
            break;
        case 'session/new':
        case 'session/resume':
            update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review' }] });
            send({ id: msg.id, result: sessionResult() });
            break;
        case 'session/load':
            // load replays the conversation before answering; the client must not duplicate it
            update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'mensagem antiga' } });
            update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'resposta antiga' } });
            send({ id: msg.id, result: sessionResult() });
            break;
        case 'session/list': {
            // Two pages, to exercise the cursor
            const page = msg.params.cursor === 'p2'
                ? { sessions: [{ sessionId: 'old-2', cwd: msg.params.cwd, title: 'Conversa 2' }] }
                : { sessions: [{ sessionId: 'old-1', cwd: msg.params.cwd, title: 'Conversa 1', updatedAt: '2026-09-30T10:00:00Z' }], nextCursor: 'p2' };
            send({ id: msg.id, result: page });
            break;
        }
        case 'session/set_config_option': {
            const { configId, value } = msg.params;
            config[configId] = value;
            send({ id: msg.id, result: { configOptions: configOptions() } });
            break;
        }
        case 'session/set_mode':
            send({ id: msg.id, result: {} });
            update({ sessionUpdate: 'current_mode_update', currentModeId: msg.params.modeId });
            break;
        case 'session/prompt':
            promptId = msg.id;
            cancelled = false;
            playTurn(msg.params.prompt.map(p => p.text).join(' '));
            break;
        case 'session/cancel':
            cancelled = true;
            break;
        default:
            if (msg.id != null) send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
});
