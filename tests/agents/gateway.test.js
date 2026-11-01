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

// ---------- routes (scripts/addon-services.js) ----------

function setupRoutes(routeEnv) {
    const store = new AgentStore(':memory:');
    const gateway = new AgentGateway({
        store,
        agents: { fake: { label: 'Fake', command: process.execPath, args: [FAKE], install: 'n/a' } },
        env: { ...process.env },
        routeEnv,
        log: () => {},
    });
    return { store, gateway };
}

test('routes: the session keeps its route and the agent process gets the route env', async () => {
    const calls = [];
    const { store, gateway } = setupRoutes(async ({ agent, route }) => { calls.push([agent, route]); return { FAKE_ROUTE_MARK: route }; });
    const session = await gateway.startSession({ agent: 'fake', cwd: process.cwd(), route: 'economia' });
    assert.equal(store.getSession(session.id).route, 'economia');
    assert.deepEqual(calls, [['fake', 'economia'], ['fake', 'economia']]); // checked before saving, then for the process
    await gateway.closeSession?.(session.id);
    await gateway.shutdown();
});

test('routes: a route that cannot start fails before any session is saved (no dead tab)', async () => {
    const { store, gateway } = setupRoutes(async () => { const e = new Error('Ligue o Headroom'); e.status = 400; throw e; });
    await assert.rejects(gateway.startSession({ agent: 'fake', cwd: process.cwd(), route: 'economia' }), /Ligue o Headroom/);
    assert.equal(store.listSessions().length, 0);
    await gateway.shutdown();
});

// ---------- limite do Claude e troca de rota ----------

const { isUsageLimitText } = require('../../scripts/agents/gateway');

test('limite: reconhece os avisos de limite do Claude Code e mais nada', () => {
    assert.ok(isUsageLimitText("You've hit your 5-hour limit · resets 12:30am"));
    assert.ok(isUsageLimitText("You're out of extra usage"));
    assert.ok(isUsageLimitText('  Your org is out of usage · add funds to continue'));
    assert.ok(!isUsageLimitText('Vou criar o arquivo.'));
    assert.ok(!isUsageLimitText("Ok. You've hit your goal!"));
});

test('limite: a resposta de limite chama onUsageLimit com a mensagem que falhou', async () => {
    const calls = [];
    const store = new AgentStore(':memory:');
    const gateway = new AgentGateway({
        store, agents: { fake: { label: 'Fake', command: process.execPath, args: [FAKE], install: 'n/a' } },
        env: { ...process.env }, onUsageLimit: info => calls.push(info), log: () => {},
    });
    const s = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    await gateway.prompt(s.id, 'teste do limite');
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text, 'teste do limite');
    assert.equal(calls[0].sessionId, s.id);
    await gateway.prompt(s.id, 'markdown'); // resposta normal, que termina sozinha
    await new Promise(r => setTimeout(r, 30));
    assert.equal(calls.length, 1, 'uma resposta normal não dispara');
    await gateway.shutdown();
});

test('rota: setRoute grava a rota, reinicia com o ambiente novo e retoma a mesma conversa', async () => {
    const envCalls = [];
    const { store, gateway } = setupRoutes(async ({ route, routeModel }) => { envCalls.push([route, routeModel]); return {}; });
    const s = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const before = store.getSession(s.id).acp_session_id;
    const after = await gateway.setRoute(s.id, 'omniroute', 'groq/llama');
    assert.equal(store.getSession(s.id).route, 'omniroute');
    assert.equal(store.getSession(s.id).route_model, 'groq/llama');
    assert.equal(after.route, 'omniroute');
    assert.deepEqual(envCalls.at(-1), ['omniroute', 'groq/llama']);
    assert.equal(store.getSession(s.id).acp_session_id, before, 'mesma conversa');
    await gateway.setRoute(s.id, 'direto');
    assert.equal(store.getSession(s.id).route, null);
    await gateway.shutdown();
});

test('modelos: agente com o campo antigo "models" ganha o seletor com todos os modelos e troca por session/set_model', async () => {
    const { gateway } = setup({ env: { FAKE_AGENT_LEGACY_MODELS: '1' } });
    const s = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const model = gateway.get(s.id).capabilities.configOptions.find(o => o.category === 'model');
    assert.deepEqual(model.options.map(o => o.value), ['m-a', 'm-b', 'm-c']);
    assert.equal(model.currentValue, 'm-a');
    await gateway.setConfigOption(s.id, model.id, 'm-c');
    assert.equal(gateway.get(s.id).capabilities.configOptions.find(o => o.category === 'model').currentValue, 'm-c');
    await gateway.shutdown();
});

test('modelos: os de fora (OmniRoute) entram no seletor e escolher um troca a rota da conversa', async () => {
    const store = new AgentStore(':memory:');
    const seen = [];
    const gateway = new AgentGateway({
        store,
        agents: { fake: { label: 'Fake', command: process.execPath, args: [FAKE], install: 'n/a' } },
        env: { ...process.env },
        routeEnv: async ({ route, routeModel }) => { seen.push([route, routeModel]); return {}; },
        extraModels: async () => [{ value: 'omniroute:codex/gpt-5', name: 'GPT-5', model: 'codex/gpt-5', route: 'omniroute', group: 'OmniRoute · Codex' }],
        log: () => {},
    });
    const s = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const findModel = () => gateway.get(s.id).capabilities.configOptions.find(o => o.category === 'model');
    for (let i = 0; i < 50 && !findModel()?.options.some(o => o.extra); i++) await new Promise(r => setTimeout(r, 20));
    const model = findModel();
    assert.ok(model.options.some(o => o.value === 'omniroute:codex/gpt-5' && o.group === 'OmniRoute · Codex'));
    await gateway.setConfigOption(s.id, model.id, 'omniroute:codex/gpt-5');
    const row = store.getSession(s.id);
    assert.equal(row.route, 'omniroute');
    assert.equal(row.route_model, 'codex/gpt-5');
    for (let i = 0; i < 50 && findModel()?.currentValue !== 'omniroute:codex/gpt-5'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(findModel().currentValue, 'omniroute:codex/gpt-5');
    await gateway.shutdown();
});

test('conta: setAccount grava a conta, passa para o ambiente e retoma a mesma conversa', async () => {
    const calls = [];
    const { store, gateway } = setupRoutes(async ({ route, account }) => { calls.push([route, account]); return account ? { FAKE_ACCOUNT: account } : {}; });
    const s = await gateway.startSession({ agent: 'fake', cwd: process.cwd() });
    const acp = gateway.get(s.id).acpSessionId;
    await gateway.setAccount(s.id, 'trabalho');
    assert.equal(store.getSession(s.id).account, 'trabalho');
    assert.equal(gateway.get(s.id).account, 'trabalho');
    assert.equal(gateway.get(s.id).acpSessionId, acp);
    assert.deepEqual(calls.at(-1), [null, 'trabalho']);
    // trocar a rota mantém a conta
    await gateway.setRoute(s.id, 'economia');
    assert.deepEqual(calls.at(-1), ['economia', 'trabalho']);
    await gateway.shutdown();
});
