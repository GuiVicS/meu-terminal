const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const VibeStore = require('../scripts/vibe-store');

const make = () => new VibeStore(new DatabaseSync(':memory:'));

test('create: a project round-trips with empty agents and no tabs yet', () => {
    const s = make();
    const p = s.create({ name: 'Loja da Ana', folder: '/home/u/projetos/loja-da-ana', kind: 'static', description: 'uma loja', git: true });
    assert.equal(p.name, 'Loja da Ana');
    assert.equal(p.folder, '/home/u/projetos/loja-da-ana');
    assert.deepEqual(p.agents, {});
    assert.equal(p.browserTabId, null);
    assert.equal(p.filesTabId, null);
});

test('byFolder: finds the project created for that exact folder', () => {
    const s = make();
    s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    assert.equal(s.byFolder('/f/x').name, 'X');
    assert.equal(s.byFolder('/f/missing'), null);
});

test('setAgentTab: remembers the tab per agent, each with its own lastUsedAt', () => {
    const s = make();
    const p = s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    s.setAgentTab(p.id, 'claude', { tabId: 'tab-1', kind: 'agent' });
    s.setAgentTab(p.id, 'codex', { tabId: 'tab-2', kind: 'agent' });
    const reloaded = s.get(p.id);
    assert.equal(reloaded.agents.claude.tabId, 'tab-1');
    assert.equal(reloaded.agents.codex.tabId, 'tab-2');
    assert.ok(reloaded.agents.claude.lastUsedAt > 0);
});

test('setAgentTab: switching back to an agent overwrites its own entry, not the others', () => {
    const s = make();
    const p = s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    s.setAgentTab(p.id, 'claude', { tabId: 'tab-1', kind: 'agent' });
    s.setAgentTab(p.id, 'claude', { tabId: 'tab-1b', kind: 'agent' });
    const reloaded = s.get(p.id);
    assert.equal(reloaded.agents.claude.tabId, 'tab-1b');
    assert.equal(Object.keys(reloaded.agents).length, 1);
});

test('lastAgent: the most recently touched agent wins', async () => {
    const s = make();
    const p = s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    s.setAgentTab(p.id, 'claude', { tabId: 'tab-1', kind: 'agent' });
    await new Promise(r => setTimeout(r, 2));
    s.setAgentTab(p.id, 'codex', { tabId: 'tab-2', kind: 'agent' });
    assert.equal(s.lastAgent(p.id), 'codex');
});

test('lastAgent: null when no agent has been used yet', () => {
    const s = make();
    const p = s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    assert.equal(s.lastAgent(p.id), null);
});

test('setTabs: sets browser/files tab ids, a later partial call keeps the other one', () => {
    const s = make();
    const p = s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    s.setTabs(p.id, { browserTabId: 'b-1', filesTabId: 'f-1' });
    s.setTabs(p.id, { browserTabId: 'b-2' });
    const reloaded = s.get(p.id);
    assert.equal(reloaded.browserTabId, 'b-2');
    assert.equal(reloaded.filesTabId, 'f-1');
});

test('byTab: finds the project whether the tab is the agent, the preview or the files tab', () => {
    const s = make();
    const p = s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    s.setAgentTab(p.id, 'claude', { tabId: 'agent-1', kind: 'agent' });
    s.setTabs(p.id, { browserTabId: 'browser-1', filesTabId: 'files-1' });
    assert.equal(s.byTab('agent-1').id, p.id);
    assert.equal(s.byTab('browser-1').id, p.id);
    assert.equal(s.byTab('files-1').id, p.id);
    assert.equal(s.byTab('unrelated-tab'), null);
    assert.equal(s.byTab(null), null);
});

test('byTab: a tab from another, unrelated project never matches', () => {
    const s = make();
    const a = s.create({ name: 'A', folder: '/f/a', kind: 'static', description: '', git: true });
    s.create({ name: 'B', folder: '/f/b', kind: 'static', description: '', git: true });
    s.setAgentTab(a.id, 'claude', { tabId: 'agent-a', kind: 'agent' });
    assert.equal(s.byTab('agent-a').id, a.id);
});

test('list: newest-touched project first', async () => {
    const s = make();
    s.create({ name: 'Older', folder: '/f/older', kind: 'static', description: '', git: true });
    await new Promise(r => setTimeout(r, 2));
    const b = s.create({ name: 'Newer', folder: '/f/newer', kind: 'static', description: '', git: true });
    const names = s.list().map(p => p.name);
    assert.deepEqual(names, ['Newer', 'Older']);
    assert.equal(s.list()[0].id, b.id);
});

test('remove: deletes the project; byFolder and byTab stop finding it', () => {
    const s = make();
    const p = s.create({ name: 'X', folder: '/f/x', kind: 'static', description: '', git: true });
    s.setAgentTab(p.id, 'claude', { tabId: 'agent-1', kind: 'agent' });
    s.remove(p.id);
    assert.equal(s.get(p.id), null);
    assert.equal(s.byFolder('/f/x'), null);
    assert.equal(s.byTab('agent-1'), null);
});
