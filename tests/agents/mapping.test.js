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
        options: [
            { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
            { optionId: 'sempre', name: 'Always Allow', kind: 'allow_always' },
            { optionId: 'nao', name: 'Reject', kind: 'reject_once' },
            { optionId: 'git', name: "Yes, and don't ask again for git", kind: 'allow_always' },
        ],
    });
    assert.equal(data.kind, 'bash');
    assert.equal(data.title, 'Run rm -rf');
    assert.deepEqual(data.input, { command: 'rm -rf x' });
    // genéricos em inglês viram português pelo tipo; nomes específicos ficam como o agente mandou
    assert.deepEqual(data.options, [
        { id: 'ok', name: 'Permitir', kind: 'allow_once' },
        { id: 'sempre', name: 'Permitir sempre', kind: 'allow_always' },
        { id: 'nao', name: 'Recusar', kind: 'reject_once' },
        { id: 'git', name: "Yes, and don't ask again for git", kind: 'allow_always' },
    ]);
});

test('media: image, audio, embedded file and file link blocks become media items', () => {
    const { blockMedia, AcpMapper } = require('../../scripts/agents/acp-mapping');
    assert.equal(blockMedia({ type: 'text', text: 'oi' }), null);
    assert.deepEqual(
        { ...blockMedia({ type: 'image', mimeType: 'image/png', data: 'AAAA' }) },
        { kind: 'image', mimeType: 'image/png', data: 'AAAA', uri: null, name: null },
    );
    assert.equal(blockMedia({ type: 'audio', mimeType: 'audio/wav', data: 'AA' }).kind, 'audio');
    assert.equal(blockMedia({ type: 'resource', resource: { uri: 'file:///x/a.png', mimeType: 'image/png', blob: 'AA' } }).kind, 'image');
    const link = blockMedia({ type: 'resource_link', uri: 'file:///tmp/foto.jpg', name: 'foto.jpg' });
    assert.equal(link.kind, 'image');
    assert.equal(blockMedia({ type: 'resource_link', uri: 'file:///tmp/r.pdf', name: 'r.pdf' }).kind, 'file');

    const mapper = new AcpMapper();
    const [tool] = mapper.mapUpdate({
        sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'feito' } },
            { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } }],
    });
    assert.equal(tool.data.output, 'feito');
    assert.equal(tool.data.media.length, 1);
    const [msg] = mapper.mapUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } });
    assert.equal(msg.type, 'message.assistant.delta');
    assert.equal(msg.data.text, '');
    assert.equal(msg.data.media[0].kind, 'image');
});

test('media: the gateway stores base64 on disk and keeps only a URL; file links keep their path', () => {
    const fs = require('fs');
    const os = require('os');
    const pathMod = require('path');
    const { AgentGateway } = require('../../scripts/agents/gateway');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'mt-media-'));
    const gw = Object.create(AgentGateway.prototype);
    gw.mediaDir = dir;
    gw.log = () => {};
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const stored = gw.storeMedia('sess-1', { kind: 'image', mimeType: 'image/png', data: png });
    assert.equal(stored.data, undefined);
    assert.match(stored.url, /^api\/agent-media\/sess-1\/[a-f0-9]{16}\.png$/);
    assert.ok(fs.existsSync(pathMod.join(dir, 'sess-1', stored.url.split('/').pop())));
    assert.equal(gw.storeMedia('sess-1', { kind: 'file', uri: 'file:///tmp/r.pdf', name: 'r.pdf' }).path, '/tmp/r.pdf');
    assert.equal(gw.storeMedia('sess-1', { kind: 'image', uri: 'https://x.com/a.png' }).url, 'https://x.com/a.png');
    fs.rmSync(dir, { recursive: true, force: true });
});
