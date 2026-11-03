const test = require('node:test');
const assert = require('node:assert');
const { turnRange, compactEvents, sideSummary } = require('../../scripts/agents/history');

test('turnRange: abre pelo fim e sobe sem repetir nem pular turno', () => {
    const starts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    assert.deepEqual(turnRange(starts), { from: 90, to: null, firstTurn: 8 });
    assert.deepEqual(turnRange(starts, 8), { from: 30, to: 90, firstTurn: 2 });
    assert.deepEqual(turnRange(starts, 2), { from: null, to: 30, firstTurn: 0 }); // inclui o que vem antes da 1ª mensagem
});

test('turnRange: conversa curta ou vazia vem inteira', () => {
    assert.deepEqual(turnRange([5, 9]), { from: null, to: null, firstTurn: 0 });
    assert.deepEqual(turnRange([]), { from: null, to: null, firstTurn: 0 });
});

test('turnRange: nova mensagem no fim não muda o que já foi paginado', () => {
    const a = turnRange([10, 20, 30, 40, 50, 60, 70, 80], 4);
    const b = turnRange([10, 20, 30, 40, 50, 60, 70, 80, 90], 4);
    assert.deepEqual(a, b);
});

const ev = (seq, type, data = {}) => ({ seq, type, data });

test('compactEvents: junta texto e atualizações seguidas, mantém a ordem e a última seq', () => {
    const out = compactEvents([
        ev(1, 'message.user', { text: 'oi' }),
        ev(2, 'message.assistant.delta', { text: 'a' }),
        ev(3, 'usage.update', { used: 1 }),
        ev(4, 'message.assistant.delta', { text: 'b' }),
        ev(5, 'tool.start', { toolId: 't' }),
        ev(6, 'tool.update', { toolId: 't', output: 'x', diffs: [{ path: 'f' }] }),
        ev(7, 'tool.update', { toolId: 't', output: 'xy', diffs: [] }),
        ev(8, 'usage.update', { used: 2 }),
        ev(9, 'tool.update', { toolId: 'u', output: 'z' }),
    ]);
    assert.deepEqual(out.map(e => [e.seq, e.type]), [[1, 'message.user'], [4, 'message.assistant.delta'], [5, 'tool.start'], [7, 'tool.update'], [8, 'usage.update'], [9, 'tool.update']]);
    assert.equal(out[1].data.text, 'ab');
    assert.equal(out[3].data.output, 'xy');
    assert.equal(out[3].data.diffs.length, 1); // lista vazia não apaga a anterior, igual à tela
    assert.equal(out[4].data.used, 2);
});

test('compactEvents: mídia não se perde; os originais não mudam', () => {
    const a = ev(1, 'message.assistant.delta', { text: 'a', media: [{ url: 'x' }] });
    const b = ev(2, 'message.assistant.delta', { text: 'b' });
    assert.equal(compactEvents([a, b]).length, 2);
    const c = ev(3, 'message.assistant.delta', { text: 'c' });
    compactEvents([b, c]);
    assert.equal(b.data.text, 'b');
    assert.equal(compactEvents([ev(1, 'status', { state: 'idle' }), ev(2, 'notice', { text: 'n' })], { keepState: false }).length, 1);
});

test('sideSummary: só o que o painel usa, sem o conteúdo das ferramentas', () => {
    const out = sideSummary([
        ev(1, 'plan.update', { steps: [1] }),
        ev(2, 'plan.update', { steps: [2] }),
        ev(3, 'tool.start', { toolId: 'a', title: 'grande', rawInput: 'x'.repeat(100) }),
        ev(4, 'tool.result', { toolId: 'b', output: 'x'.repeat(100), diffs: [{ path: 'f', oldText: '', newText: 'n' }] }),
        ev(5, 'tool.start', { toolId: 'c', parentToolId: 'p' }),
        ev(6, 'subagent.start', { subagentId: 'p' }),
        ev(7, 'usage.update', { used: 1 }),
        ev(8, 'usage.update', { cost: 2 }),
        ev(9, 'commands.update', { commands: ['x'] }),
    ]);
    assert.equal(out.filter(e => e.type === 'plan.update').length, 1);
    assert.deepEqual(out.find(e => e.type === 'plan.update').data.steps, [2]);
    assert.ok(!out.some(e => e.data.toolId === 'a'));
    assert.equal(out.find(e => e.data.toolId === 'b').data.output, undefined);
    assert.deepEqual(out.find(e => e.type === 'usage.update').data, { used: 1, cost: 2 });
});

test('agent-store: turnos, intervalo, estado e painel vindos do SQL', () => {
    const AgentStore = require('../../scripts/agents/agent-store');
    const store = new AgentStore(':memory:');
    const db = store.db;
    db.prepare("INSERT INTO agent_sessions (id, agent, cwd, status, created_at, updated_at) VALUES ('s', 'a', '/', 'idle', 0, 0)").run();
    const add = (seq, type, data) => db.prepare('INSERT INTO agent_events (session_id, seq, type, at, data) VALUES (?, ?, ?, 0, ?)').run('s', seq, type, JSON.stringify(data));
    add(1, 'session.start', { cwd: '/' }); add(2, 'status', { state: 'a' }); add(3, 'message.user', { text: 'um' });
    add(4, 'status', { state: 'b' }); add(5, 'message.user', { text: 'dois' }); add(6, 'tool.start', { toolId: 't', diffs: [{ path: 'f' }] });
    add(7, 'tool.start', { toolId: 'sem' }); add(8, 'status', { state: 'c' });
    assert.deepEqual(store.turnStarts('s'), [3, 5]);
    assert.deepEqual(store.eventsRange('s', 3, 5).map(e => e.seq), [3, 4]);
    assert.deepEqual(store.latestState('s', 5).map(e => [e.seq, e.data.state]), [[1, undefined], [4, 'b']]);
    assert.equal(store.latestState('s').find(e => e.type === 'status').data.state, 'c');
    assert.deepEqual(store.sideEvents('s').map(e => e.seq), [6]);
    assert.equal(store.lastSeq('s'), 8);
});
