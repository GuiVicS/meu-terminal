/**
 * gateway.test.js
 * Gateway tests against the scripted fake ACP agent (tests/fixtures/fake-acp-agent.js):
 * full turn, permissions, cancel, modes, replay, crash, resume and limits.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const AgentStore = require('../../scripts/agents/agent-store');
const { AgentGateway } = require('../../scripts/agents/gateway');
const { assertValidSequence, assertTurn, waitForEvent } = require('./contract');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-acp-agent.js');

function setup({ env = {}, maxSessions = 4, agents } = {}) {
    const store = new AgentStore(':memory:');
    const gateway = new AgentGateway({
        store,
        agents: agents || {
            fake: { label: 'Fake', command: process.execPath, args: [FAKE], install: 'n/a' },
            missing: { label: 'Missing', command: 'meuterminal-no-such-agent', args: [], install: 'npm i -g nada' },
            agy: { label: 'agy', terminalOnly: true },
        },
        env: { ...process.env, ...env },
        maxSessions,
        validate: true,
        log: () => {},
    });
    return { store, gateway };
}

/** Answers every permission request with the option of the given kind prefix. */
function autoAnswer(gateway, kindPrefix) {
    gateway.on('event', (event) => {
        if (event.type !== 'permission.request') return;
        const option = event.data.options.find(o => o.kind.startsWith(kindPrefix));
        setImmediate(() => gateway.respondPermission(event.sessionId, event.data.permissionId, { optionId: option.id, answeredBy: 'test' }));
    });
}

test('full turn with an allowed permission produces a valid event sequence', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    autoAnswer(gateway, 'allow');

    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    assert.equal(session.status, 'idle');
    assert.equal(session.capabilities.plan, true);
    assert.equal(session.capabilities.subagents, true);
    assert.equal(session.mode, 'default');

    const stopReason = await gateway.prompt(session.id, 'crie ola.txt');
    assert.equal(stopReason, 'end_turn');

    const events = gateway.events(session.id);
    assertValidSequence(events);
    assertTurn(events);
    const types = events.map(e => e.type);
    for (const type of ['session.start', 'thought.delta', 'plan.update', 'tool.start', 'permission.request',
        'permission.response', 'tool.result', 'usage.update', 'commands.update', 'raw']) {
        assert.ok(types.includes(type), `missing ${type}`);
    }
    const result = events.find(e => e.type === 'tool.result' && e.data.toolId === 't1');
    assert.equal(result.data.status, 'completed');
    const permission = events.find(e => e.type === 'permission.request');
    assert.equal(permission.data.diffs[0].newText, 'oi');
    // Our title (first message) is set first, then replaced by the agent's own session_info_update
    assert.ok(events.some(e => e.type === 'session.info'));
    assert.equal(gateway.get(session.id).title, 'Criar ola.txt');
    assert.equal(gateway.get(session.id).capabilities.usage, true);
});

test('denied permission is passed to the agent', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    autoAnswer(gateway, 'reject');
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await gateway.prompt(session.id, 'crie ola.txt');
    const result = gateway.events(session.id).find(e => e.type === 'tool.result' && e.data.toolId === 't1');
    assert.equal(result.data.status, 'failed');
});

test('a permission can only be answered once (second device loses)', async (t) => {
    const { gateway, store } = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const turn = gateway.prompt(session.id, 'oi');
    const request = await waitForEvent(gateway, e => e.type === 'permission.request');
    assert.equal(gateway.get(session.id).status, 'waiting_permission');
    assert.equal(gateway.get(session.id).pendingPermissions.length, 1);
    assert.equal(gateway.respondPermission(session.id, request.data.permissionId, { optionId: 'allow', answeredBy: 'phone' }), true);
    assert.equal(gateway.respondPermission(session.id, request.data.permissionId, { optionId: 'reject', answeredBy: 'desktop' }), false);
    await turn;
    const row = store.db.prepare('SELECT answered_by, option_id FROM agent_permissions WHERE id = ?').get(request.data.permissionId);
    assert.deepEqual({ ...row }, { answered_by: 'phone', option_id: 'allow' });
});

test('cancel answers pending permissions and ends the turn as cancelled', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const turn = gateway.prompt(session.id, 'oi');
    await waitForEvent(gateway, e => e.type === 'permission.request');
    gateway.cancel(session.id);
    assert.equal(await turn, 'cancelled');
    const events = gateway.events(session.id);
    assertValidSequence(events);
    assert.equal(events.find(e => e.type === 'permission.response').data.outcome, 'cancelled');
    assert.equal(gateway.get(session.id).status, 'idle');
});

test('set mode emits a single mode.update', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await gateway.setMode(session.id, 'plan');
    await new Promise(r => setTimeout(r, 100)); // let the agent's current_mode_update arrive
    const modeEvents = gateway.events(session.id).filter(e => e.type === 'mode.update');
    assert.equal(modeEvents.length, 1);
    assert.equal(gateway.get(session.id).mode, 'plan');
    await assert.rejects(gateway.setMode(session.id, 'nope'), /Modo desconhecido/);
});

test('replay returns only events after the given seq', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    autoAnswer(gateway, 'allow');
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const before = gateway.get(session.id).lastSeq;
    await gateway.prompt(session.id, 'oi');
    const replay = gateway.events(session.id, before);
    assert.equal(replay[0].seq, before + 1);
    assert.equal(replay[0].type, 'message.user');
    assert.equal(replay.at(-1).seq, gateway.get(session.id).lastSeq);
});

test('agent crash: error event, stopped session, expired permissions, then resume', async (t) => {
    const { gateway, store } = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const stopped = gateway.get(session.id).status === 'stopped'
        ? Promise.resolve()
        : waitForEvent(gateway, e => e.type === 'status' && e.data.state === 'stopped');
    await assert.rejects(gateway.prompt(session.id, 'crash now'));
    await stopped;
    const after = gateway.get(session.id);
    assert.equal(after.status, 'stopped');
    assert.equal(after.running, false);
    assert.ok(gateway.events(session.id).some(e => e.type === 'error' && /parou inesperadamente/.test(e.data.message)));
    assert.equal(store.pendingPermissions(session.id).length, 0);

    const resumed = await gateway.resumeSession(session.id);
    assert.equal(resumed.status, 'idle');
    assert.equal(resumed.capabilities.resumed, true);
    assertValidSequence(gateway.events(session.id));
});

test('missing agent command gives an install hint', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    await assert.rejects(gateway.startSession({ agent: 'missing', cwd: process.cwd() }), (error) => {
        assert.equal(error.status, 424);
        assert.match(error.message, /npm i -g nada/);
        return true;
    });
});

test('agent that crashes on start is reported once', async (t) => {
    const { gateway, store } = setup({ env: { FAKE_AGENT_CRASH: 'on-start' } });
    t.after(() => gateway.shutdown());
    await assert.rejects(gateway.startSession({ agent: 'fake', cwd: process.cwd() }));
    const [row] = store.listSessions();
    const errors = gateway.events(row.id).filter(e => e.type === 'error');
    assert.equal(errors.length, 1);
    assert.equal(row.status, 'stopped');
});

test('terminal-only agents and unknown agents are refused', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    await assert.rejects(gateway.startSession({ agent: 'agy', cwd: process.cwd() }), /só funciona no terminal/);
    await assert.rejects(gateway.startSession({ agent: 'nope', cwd: process.cwd() }), /desconhecido/);
});

test('limit of running agents', async (t) => {
    const { gateway } = setup({ maxSessions: 1 });
    t.after(() => gateway.shutdown());
    await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await assert.rejects(gateway.startSession({ agent: 'fake', cwd: process.cwd() }), (error) => error.status === 429);
});

test('close stops the agent and hides the session from the open list', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await gateway.closeSession(session.id);
    assert.equal(gateway.list().length, 0);
    assert.equal(gateway.list({ includeClosed: true })[0].status, 'closed');
    assertValidSequence(gateway.events(session.id));
});

test('server restart marks running sessions stopped and expires permissions', () => {
    const store = new AgentStore(':memory:');
    store.insertSession({ id: 's1', agent: 'fake', cwd: '/', status: 'thinking' });
    store.insertPermission({ id: 'p1', sessionId: 's1', request: {} });
    new AgentGateway({ store, agents: {} });
    assert.equal(store.getSession('s1').status, 'stopped');
    assert.equal(store.pendingPermissions('s1').length, 0);
});

test('modo fila: messages sent while the agent works wait and go in order', async (t) => {
    const { gateway } = setup();
    t.after(() => gateway.shutdown());
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });

    // The fake agent stops at a permission: the turn stays open
    assert.deepEqual(gateway.enqueue(session.id, 'primeira'), { queued: false });
    await waitForEvent(gateway, e => e.sessionId === session.id && e.type === 'permission.request');
    const second = gateway.enqueue(session.id, 'segunda');
    const third = gateway.enqueue(session.id, 'terceira');
    assert.equal(second.queued, true);
    assert.deepEqual(gateway.get(session.id).queue.map(i => i.text), ['segunda', 'terceira']);
    assert.equal(gateway.dequeue(session.id, third.id), true);
    assert.deepEqual(gateway.get(session.id).queue.map(i => i.text), ['segunda']);

    autoAnswer(gateway, 'allow');
    const first = gateway.events(session.id).find(e => e.type === 'permission.request');
    gateway.respondPermission(session.id, first.data.permissionId, { optionId: 'allow', answeredBy: 'test' });
    // Turn 1 ends -> "segunda" is sent on its own
    const deadline = Date.now() + 10000;
    let users = [];
    while (Date.now() < deadline) {
        const events = gateway.events(session.id);
        users = events.filter(e => e.type === 'message.user').map(e => e.data.text);
        if (events.filter(e => e.type === 'message.assistant.done').length >= 2) break;
        await new Promise(r => setTimeout(r, 50));
    }
    assert.deepEqual(users, ['primeira', 'segunda']);
    assert.deepEqual(gateway.get(session.id).queue, []);
    assertValidSequence(gateway.events(session.id));
});
