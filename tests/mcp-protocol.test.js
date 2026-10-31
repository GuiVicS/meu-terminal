const test = require('node:test');
const assert = require('node:assert/strict');
const { createJsonRpcHandler, SUPPORTED_VERSIONS } = require('../scripts/mcp-protocol');

/** Calls the Express handler with a fake req/res and returns { status, body }. */
async function call(handler, body) {
    let status = 200;
    let out;
    const res = {
        status(code) { status = code; return this; },
        json(b) { out = b; return this; },
        end() { return this; },
    };
    await handler({ body }, res);
    return { status, body: out };
}

const calls = [];
const handler = createJsonRpcHandler({
    tools: [{ name: 'echo', description: 'eco', inputSchema: { type: 'object', properties: {} } }],
    impl: {
        echo: args => ({ content: [{ type: 'text', text: String(args.text) }] }),
        boom: () => { throw new Error('quebrou'); },
    },
    serverInfo: { name: 'teste', version: '1.0.0' },
    instructions: 'use echo',
    onCall: (name, args, outcome) => calls.push({ name, ...outcome }),
});

test('initialize: echoes a supported version, falls back to the newest', async () => {
    const ok = await call(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    assert.equal(ok.body.result.protocolVersion, '2025-03-26');
    assert.equal(ok.body.result.serverInfo.name, 'teste');
    assert.equal(ok.body.result.instructions, 'use echo');
    const old = await call(handler, { jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    assert.equal(old.body.result.protocolVersion, SUPPORTED_VERSIONS[0]);
});

test('tools/list and tools/call', async () => {
    const list = await call(handler, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(list.body.result.tools.map(t => t.name), ['echo']);
    const r = await call(handler, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'oi' } } });
    assert.equal(r.body.result.content[0].text, 'oi');
    assert.equal(calls.at(-1).name, 'echo');
    assert.equal(calls.at(-1).ok, true);
});

test('tools/call: a throwing tool becomes an isError result; unknown/prototype names are refused', async () => {
    const r = await call(handler, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'boom' } });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /quebrou/);
    assert.equal(calls.at(-1).ok, false);
    for (const name of ['nada', 'toString', 'constructor', '__proto__']) {
        const u = await call(handler, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name } });
        assert.equal(u.body.error.code, -32602, name);
    }
});

test('notifications get 202 with no body; unknown methods -32601; batches', async () => {
    const n = await call(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(n.status, 202);
    assert.equal(n.body, undefined);
    const u = await call(handler, { jsonrpc: '2.0', id: 5, method: 'resources/list' });
    assert.equal(u.body.error.code, -32601);
    const b = await call(handler, [
        { jsonrpc: '2.0', id: 6, method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
    ]);
    assert.equal(b.body.length, 1);
    assert.equal(b.body[0].id, 6);
});
