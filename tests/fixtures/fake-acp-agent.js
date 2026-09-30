/**
 * fake-acp-agent.js
 * Scripted ACP agent for tests: answers initialize/session/new and plays a fixed turn with
 * thought, text, a tool call that needs permission, a plan, usage and an unknown update.
 */
const readline = require('readline');

const SESSION_ID = 'fake-session-1';
let pendingPermission = null; // id of our permission request waiting for the client
let promptId = null;          // id of the session/prompt being answered
let cancelled = false;
let nextId = 1000;

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (u) => send({ method: 'session/update', params: { sessionId: SESSION_ID, update: u } });

// Some real agents print banners on stdout; the client must ignore them
process.stdout.write('fake agent banner (not JSON)\n');

if (process.env.FAKE_AGENT_CRASH === 'on-start') process.exit(3);

function finishTurn(stopReason) {
    send({ id: promptId, result: { stopReason } });
    promptId = null;
}

function playTurn(text) {
    if (text.includes('crash')) process.exit(7);
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
                        sessionCapabilities: { resume: {}, subagents: {} },
                    },
                },
            });
            break;
        case 'session/new':
        case 'session/resume':
            update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review' }] });
            send({
                id: msg.id,
                result: {
                    sessionId: SESSION_ID,
                    modes: {
                        currentModeId: 'default',
                        availableModes: [{ id: 'default', name: 'Manual' }, { id: 'plan', name: 'Plan' }],
                    },
                },
            });
            break;
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
