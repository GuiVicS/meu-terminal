/**
 * live-contract.test.js
 * Optional contract test against REAL agents (spends tokens/credits). Skipped unless
 * MT_LIVE_AGENTS is set, e.g. MT_LIVE_AGENTS=claude,opencode npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentStore = require('../../scripts/agents/agent-store');
const { AgentGateway } = require('../../scripts/agents/gateway');
const { loadAgents } = require('../../scripts/agents/registry');
const { assertValidSequence, assertTurn } = require('./contract');

/**
 * MT_LIVE_AGENTS: comma-separated registry ids (claude,opencode,codex), or a JSON object
 * { "claude": ["node", "/path/to/claude-agent-acp/dist/index.js"] } to choose the command.
 */
function liveAgents() {
    const value = process.env.MT_LIVE_AGENTS;
    if (!value) return {};
    const registry = loadAgents();
    if (value.trim().startsWith('{')) {
        return Object.fromEntries(Object.entries(JSON.parse(value)).map(([id, [command, ...args]]) => (
            [id, { ...registry[id], label: (registry[id] && registry[id].label) || id, command, args }]
        )));
    }
    return Object.fromEntries(value.split(',').map(id => id.trim()).filter(Boolean).map(id => [id, registry[id]]));
}

const PROMPT = 'Crie o arquivo ola.txt com o texto oi nesta pasta e depois responda apenas "feito".';

for (const [id, agent] of Object.entries(liveAgents())) {
    test(`live contract: ${id}`, { timeout: 240000 }, async (t) => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `mt-live-${id}-`));
        const gateway = new AgentGateway({ store: new AgentStore(':memory:'), agents: { [id]: agent }, validate: true });
        t.after(async () => {
            await gateway.shutdown();
            fs.rmSync(cwd, { recursive: true, force: true });
        });
        // Approve file writes so the scripted turn can complete
        gateway.on('event', (event) => {
            if (event.type !== 'permission.request') return;
            const option = event.data.options.find(o => o.kind.startsWith('allow')) || event.data.options[0];
            gateway.respondPermission(event.sessionId, event.data.permissionId, { optionId: option.id, answeredBy: 'live-test' });
        });

        const session = await gateway.startSession({ agent: id, cwd });
        // e.g. MT_LIVE_MODEL_OPENCODE=opencode/big-pickle when the agent's default model is down
        const model = process.env[`MT_LIVE_MODEL_${id.toUpperCase()}`];
        const modelOption = (session.capabilities.configOptions || []).find(o => o.category === 'model');
        if (model && modelOption) await gateway.setConfigOption(session.id, modelOption.id, model);
        const stopReason = await gateway.prompt(session.id, PROMPT);
        assert.equal(stopReason, 'end_turn');

        const events = gateway.events(session.id);
        assertValidSequence(events);
        assertTurn(events);
        assert.ok(events.some(e => e.type === 'message.assistant.delta'), 'no streamed text');
        assert.ok(events.some(e => e.type === 'tool.start'), 'no tool call');
        assert.ok(fs.existsSync(path.join(cwd, 'ola.txt')), 'ola.txt was not created');
        const unknown = [...new Set(events.filter(e => e.type === 'raw').map(e => e.data.payload && e.data.payload.sessionUpdate || e.data.source))];
        if (unknown.length) t.diagnostic(`raw (unmapped) events: ${unknown.join(', ')}`);
    });
}
