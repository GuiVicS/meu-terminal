/**
 * agy.test.js
 * The agy ACP adapter (scripts/agents/agy-acp.js) against a scripted fake `agy`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentStore = require('../../scripts/agents/agent-store');
const { AgentGateway } = require('../../scripts/agents/gateway');
const { AGENTS } = require('../../scripts/agents/registry');

const FAKE_AGY = path.join(__dirname, '..', 'fixtures', 'fake-agy.js');

function setup() {
    // The adapter runs AGY_BIN directly: a tiny wrapper script runs the fake with node
    const wrapper = path.join(os.tmpdir(), `fake-agy-${process.pid}.sh`);
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`, { mode: 0o755 });
    const gateway = new AgentGateway({
        store: new AgentStore(':memory:'),
        agents: { agy: { ...AGENTS.agy } },
        env: { ...process.env, AGY_BIN: wrapper },
        validate: true,
    });
    return { gateway, wrapper };
}

test('agy is available in the agent UI (not terminal-only)', () => {
    assert.equal(!!AGENTS.agy.terminalOnly, false);
});

test('agy turn: tool card, streamed text, usage and a clean end', async (t) => {
    const { gateway, wrapper } = setup();
    t.after(() => { gateway.shutdown(); fs.rmSync(wrapper, { force: true }); });
    const session = await gateway.startSession({ agent: 'agy', cwd: process.cwd() });
    assert.deepEqual(session.capabilities.modeList.map(m => m.id), ['default', 'accept-edits', 'plan']);
    assert.deepEqual(session.capabilities.configOptions[0].options.map(o => o.value), ['fake-fast', 'fake-pro']);
    assert.equal(await gateway.prompt(session.id, 'oi'), 'end_turn');
    const types = gateway.events(session.id).map(e => e.type);
    for (const type of ['tool.start', 'tool.result', 'message.assistant.delta', 'usage.update', 'message.assistant.done']) {
        assert.ok(types.includes(type), `missing ${type}`);
    }
    assert.equal(gateway.events(session.id).find(e => e.type === 'tool.start').data.kind, 'read');
});

test('agy mode and model changes restart the same conversation with the new flags', async (t) => {
    const { gateway, wrapper } = setup();
    t.after(() => { gateway.shutdown(); fs.rmSync(wrapper, { force: true }); });
    const session = await gateway.startSession({ agent: 'agy', cwd: process.cwd() });
    await gateway.setMode(session.id, 'plan');
    await gateway.setConfigOption(session.id, 'model', 'fake-pro');
    await gateway.prompt(session.id, 'x');
    const text = gateway.events(session.id).filter(e => e.type === 'message.assistant.delta').map(e => e.data.text).join('');
    assert.match(text, /eco: x \[fake-pro\/plan\]/);
});
