/**
 * mapping.test.js
 * Unit tests for the event model validator and the ACP -> normalized event mapping.
 * Run with: npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEvent } = require('../../scripts/agents/events');
const { AcpMapper } = require('../../scripts/agents/acp-mapping');

const envelope = (type, data) => ({ sessionId: 's1', seq: 1, at: Date.now(), type, data });

test('validateEvent accepts a valid event and rejects broken ones', () => {
    assert.deepEqual(validateEvent(envelope('message.user', { text: 'oi' })), []);
    assert.match(validateEvent(envelope('message.user', {})).join(), /missing data.text/);
    assert.match(validateEvent(envelope('nope', {})).join(), /unknown type/);
    assert.match(validateEvent(envelope('status', { state: 'dancing' })).join(), /unknown state/);
    assert.match(validateEvent({ ...envelope('raw', { source: 'x', payload: 1 }), seq: 0 }).join(), /seq/);
});

test('text and thought chunks become deltas', () => {
    const m = new AcpMapper();
    const [msg] = m.mapUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Olá' }, messageId: 'a' });
    assert.deepEqual(msg, { type: 'message.assistant.delta', data: { text: 'Olá', messageId: 'a' } });
    const [thought] = m.mapUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    assert.equal(thought.type, 'thought.delta');
});

test('tool kinds: Claude tool names win over the ACP kind', () => {
    const m = new AcpMapper();
    const kindOf = (u) => m.mapUpdate({ sessionUpdate: 'tool_call', toolCallId: Math.random().toString(), ...u })[0].data.kind;
    assert.equal(kindOf({ kind: 'execute' }), 'bash');
    assert.equal(kindOf({ kind: 'edit', _meta: { claudeCode: { toolName: 'Write' } } }), 'write');
    assert.equal(kindOf({ kind: 'other', _meta: { claudeCode: { toolName: 'Task' } } }), 'task');
    assert.equal(kindOf({ kind: 'other', _meta: { claudeCode: { toolName: 'mcp__meuterminal__screenshot' } } }), 'mcp');
    assert.equal(kindOf({ kind: 'weird' }), 'other');
});

test('tool update for an unknown tool synthesizes tool.start; completion becomes tool.result', () => {
    const m = new AcpMapper();
    const events = m.mapUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'x', title: 'ls', kind: 'execute', status: 'completed', rawOutput: 'a\nb' });
    assert.deepEqual(events.map(e => e.type), ['tool.start', 'tool.result']);
    assert.equal(events[1].data.output, 'a\nb');
    assert.equal(events[1].data.status, 'completed');
});

test('diffs and long outputs are kept but truncated', () => {
    const m = new AcpMapper({ maxText: 10 });
    const [start] = m.mapUpdate({
        sessionUpdate: 'tool_call', toolCallId: 't', title: 'Edit', kind: 'edit',
        content: [
            { type: 'diff', path: '/a.txt', oldText: 'old', newText: 'x'.repeat(50) },
            { type: 'content', content: { type: 'text', text: 'y'.repeat(50) } },
        ],
    });
    assert.equal(start.data.diffs[0].path, '/a.txt');
    assert.equal(start.data.diffs[0].newText.length, 10);
    assert.equal(start.data.output.length, 10);
    assert.equal(start.data.truncated, true);
});

test('unknown updates become raw events (nothing is dropped)', () => {
    const m = new AcpMapper();
    const payload = { sessionUpdate: 'brand_new_thing', x: 1 };
    assert.deepEqual(m.mapUpdate(payload), [{ type: 'raw', data: { source: 'acp', payload } }]);
});

test('permission requests keep the agent option ids', () => {
    const m = new AcpMapper();
    const data = m.mapPermission({
        toolCall: { toolCallId: 't1', title: 'Run rm -rf', kind: 'execute', rawInput: { command: 'rm -rf x' } },
        options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
    });
    assert.equal(data.kind, 'bash');
    assert.equal(data.title, 'Run rm -rf');
    assert.deepEqual(data.input, { command: 'rm -rf x' });
    assert.deepEqual(data.options, [{ id: 'ok', name: 'Allow', kind: 'allow_once' }]);
});
