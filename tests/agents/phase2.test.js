/**
 * phase2.test.js
 * Adapter features beyond the basic turn: subagents, config options (model/mode like OpenCode),
 * agent history (session/list), resuming a conversation started elsewhere, MCP servers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const AgentStore = require('../../scripts/agents/agent-store');
const { AgentGateway } = require('../../scripts/agents/gateway');
const { AcpMapper, normalizeConfigOptions } = require('../../scripts/agents/acp-mapping');
const { assertValidSequence, assertTurn } = require('./contract');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-acp-agent.js');

function setup(env = {}, opts = {}) {
    const gateway = new AgentGateway({
        store: new AgentStore(':memory:'),
        agents: { fake: { label: 'Fake', command: process.execPath, args: [FAKE], install: 'n/a' } },
        env: { ...process.env, ...env },
        validate: true,
        ...opts,
    });
    gateway.on('event', (event) => {
        if (event.type !== 'permission.request') return;
        setImmediate(() => gateway.respondPermission(event.sessionId, event.data.permissionId, { optionId: 'allow' }));
    });
    return gateway;
}

test('subagent: start once, details as updates, child tools carry parentToolId, end with summary', async (t) => {
    const gateway = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await gateway.prompt(session.id, 'oi');
    const events = gateway.events(session.id);
    assertValidSequence(events);
    assertTurn(events);

    const starts = events.filter(e => e.type === 'subagent.start');
    assert.equal(starts.length, 1);
    // Details arrive after the start, as Claude streams the tool input
    const details = events.filter(e => e.type === 'subagent.update').pop();
    assert.deepEqual(
        { type: details.data.agentType, description: details.data.description },
        { type: 'Explore', description: 'Listar arquivos' },
    );
    assert.ok(events.indexOf(starts[0]) < events.indexOf(details));
    const child = events.find(e => e.type === 'tool.result' && e.data.toolId === 'child1');
    assert.equal(child.data.parentToolId, 'sub1');
    assert.equal(child.data.output, 'ola.txt', 'Claude toolResponse stdout is the output');

    const end = events.find(e => e.type === 'subagent.end');
    assert.equal(end.data.subagentId, 'sub1');
    assert.equal(end.data.totalTokens, 500);
    assert.equal(end.data.agentType, 'Explore');
    assert.ok(events.indexOf(end) > events.indexOf(child), 'subagent ends after its child tool');
});

test('session.info title from the agent replaces ours', async (t) => {
    const gateway = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await gateway.prompt(session.id, 'uma mensagem qualquer');
    assert.equal(gateway.get(session.id).title, 'Criar ola.txt');
});

test('config options: model select and boolean, persisted and announced', async (t) => {
    const gateway = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    assert.equal(session.capabilities.config, true);
    const model = session.capabilities.configOptions.find(o => o.id === 'model');
    assert.deepEqual(model.options.map(o => [o.value, o.group]), [['fast-1', 'Rápidos'], ['smart-1', 'Espertos']]);
    assert.equal(gateway.store.getSession(session.id).model, 'fast-1');

    await gateway.setConfigOption(session.id, 'model', 'smart-1');
    await gateway.setConfigOption(session.id, 'turbo', true);
    assert.equal(gateway.store.getSession(session.id).model, 'smart-1');
    const turbo = gateway.get(session.id).capabilities.configOptions.find(o => o.id === 'turbo');
    assert.equal(turbo.currentValue, true);
    assert.equal(gateway.events(session.id).filter(e => e.type === 'config.update').length, 2);

    await assert.rejects(gateway.setConfigOption(session.id, 'model', 'nope'), /valor inválido/);
    await assert.rejects(gateway.setConfigOption(session.id, 'turbo', 'yes'), /valor inválido/);
    await assert.rejects(gateway.setConfigOption(session.id, 'color', 'red'), /Opção desconhecida/);
});

test('OpenCode style: modes only as config option still drive the mode selector', async (t) => {
    const gateway = setup({ FAKE_AGENT_STYLE: 'config' });
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    assert.equal(session.capabilities.modeSource, 'config');
    assert.deepEqual(session.capabilities.modeList.map(m => m.id), ['build', 'plan']);
    assert.equal(session.capabilities.plan, true);
    assert.equal(session.mode, 'build');

    await gateway.setMode(session.id, 'plan');
    assert.equal(gateway.get(session.id).mode, 'plan');
    const modeEvents = gateway.events(session.id).filter(e => e.type === 'mode.update');
    assert.deepEqual(modeEvents.map(e => e.data.modeId), ['plan']);
    assertValidSequence(gateway.events(session.id));
});

test('history: pages through session/list', async (t) => {
    const gateway = setup();
    t.after(() => gateway.shutdown());
    const history = await gateway.listHistory({ agent: 'fake', cwd: process.cwd() });
    assert.deepEqual(history.map(h => h.sessionId), ['old-1', 'old-2']);
    assert.equal(history[0].title, 'Conversa 1');
    assert.equal(gateway.runtimes.size, 0, 'the short-lived process is not a session');
});

test('a conversation started elsewhere (terminal) is imported with its history', async (t) => {
    const gateway = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd(), resumeAcpSessionId: 'old-1' });
    assert.equal(session.capabilities.resumed, true);
    assert.equal(gateway.store.getSession(session.id).acp_session_id, 'old-1');
    // session/load replays it: it becomes our events, as a closed turn
    const events = gateway.events(session.id);
    const messages = events.filter(e => e.type.startsWith('message.')).map(e => [e.type, e.data.text || e.data.stopReason]);
    assert.deepEqual(messages, [
        ['message.user', 'mensagem antiga'],
        ['message.assistant.delta', 'resposta antiga'],
        ['message.assistant.done', 'end_turn'],
    ]);
    assertValidSequence(events);
});

test('resuming our own session through session/load ignores the replayed history', async (t) => {
    const gateway = setup({ FAKE_AGENT_NO_RESUME: '1' });
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await gateway.stopAgent(session.id);
    const resumed = await gateway.resumeSession(session.id);
    assert.equal(resumed.capabilities.resumed, true);
    const texts = gateway.events(session.id).filter(e => e.type.startsWith('message.'));
    assert.equal(texts.length, 0, 'replayed messages must not be duplicated in our log');
});

test('MCP servers are passed to the agent session', async (t) => {
    const mcp = [{ type: 'http', name: 'meuterminal', url: 'http://127.0.0.1:1/mcp', headers: [{ name: 'Authorization', value: 'Bearer x' }] }];
    const gateway = setup({}, { mcpServers: mcp });
    t.after(() => gateway.shutdown());
    const seen = [];
    const { AcpClient } = require('../../scripts/agents/acp-client');
    const original = AcpClient.prototype.request;
    AcpClient.prototype.request = function (method, params, opts) {
        if (method === 'session/new') seen.push(params.mcpServers);
        return original.call(this, method, params, opts);
    };
    t.after(() => { AcpClient.prototype.request = original; });
    await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    assert.deepEqual(seen, [mcp]);
});

test('normalizeConfigOptions flattens grouped options and keeps booleans', () => {
    const [select, flag] = normalizeConfigOptions([
        { id: 'm', name: 'M', category: 'model', type: 'select', currentValue: 'a', options: [{ group: 'g', name: 'G', options: [{ value: 'a', name: 'A' }] }, { value: 'b' }] },
        { id: 'f', name: 'F', type: 'boolean', currentValue: false },
    ]);
    assert.deepEqual(select.options.map(o => o.value), ['a', 'b']);
    assert.equal(select.options[0].group, 'G');
    assert.equal(flag.type, 'boolean');
    assert.deepEqual(flag.options, []);
});

test('subagent details streamed in pieces produce updates, never a second start', () => {
    const m = new AcpMapper();
    const meta = { claudeCode: { toolName: 'Agent' } };
    const events = [
        ...m.mapUpdate({ sessionUpdate: 'tool_call', toolCallId: 's', kind: 'other', rawInput: {}, _meta: meta }),
        ...m.mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 's', rawInput: { description: 'Listar' }, _meta: meta }),
        ...m.mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 's', rawInput: { description: 'Listar' }, _meta: meta }),
        ...m.mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 's', rawInput: { description: 'Listar', subagent_type: 'Explore' }, _meta: meta }),
    ];
    assert.deepEqual(events.map(e => e.type), ['tool.start', 'subagent.start', 'subagent.update', 'tool.update', 'tool.update', 'subagent.update', 'tool.update']);
    assert.equal(events[5].data.agentType, 'Explore');
    assert.equal(events[5].data.description, 'Listar');
});

test('a subagent without details still starts and ends', () => {
    const m = new AcpMapper();
    const events = [
        ...m.mapUpdate({ sessionUpdate: 'tool_call', toolCallId: 's', kind: 'other', _meta: { claudeCode: { toolName: 'Task' } } }),
        ...m.mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 's', status: 'failed', _meta: { claudeCode: { toolName: 'Task' } } }),
    ];
    const types = events.map(e => e.type);
    assert.deepEqual(types, ['tool.start', 'subagent.start', 'tool.result', 'subagent.end']);
});

test('background (async) subagent: no premature end, children still attach', () => {
    const m = new AcpMapper();
    const meta = (extra = {}) => ({ claudeCode: { toolName: 'Agent', ...extra } });
    const events = [
        ...m.mapUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'other', rawInput: {}, _meta: meta() }),
        ...m.mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', rawInput: { subagent_type: 'Explore' }, _meta: meta({ toolResponse: { isAsync: true, agentId: 'bg1', status: 'async_launched' } }) }),
        ...m.mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', rawOutput: [{ type: 'text', text: 'Async agent launched' }], _meta: meta() }),
        ...m.mapUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', kind: 'execute', _meta: { claudeCode: { toolName: 'Bash', parentToolUseId: 'a' } } }),
    ];
    assert.ok(!events.some(e => e.type === 'subagent.end'), 'async subagent must not end with its tool call');
    const asyncUpdate = events.find(e => e.type === 'subagent.update' && e.data.async);
    assert.equal(asyncUpdate.data.agentId, 'bg1');
    assert.equal(events.at(-1).data.parentToolId, 'a');
});
