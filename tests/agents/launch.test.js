/**
 * launch.test.js
 * Phase 3: the "usar o modo UI?" decision (launch.js), the shim client's argument rules
 * (launch-client.js) and the generated bash shims (shims.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, spawnSync } = require('child_process');
const AgentStore = require('../../scripts/agents/agent-store');
const { AgentGateway } = require('../../scripts/agents/gateway');
const { AgentLauncher } = require('../../scripts/agents/launch');
const { classify, main, TERMINAL } = require('../../scripts/agents/launch-client');
const { writeShims } = require('../../scripts/agents/shims');

const FAKE = path.join(__dirname, '..', 'fixtures', 'fake-acp-agent.js');

/** Minimal stand-in for SessionManager: records broadcasts and created tabs. */
function fakeSessions({ windows = 1 } = {}) {
    return {
        sockets: new Set(Array.from({ length: windows }, (_, i) => i)),
        messages: [],
        tabs: [],
        broadcast(message) { this.messages.push(message); },
        create(opts) {
            const tab = { id: `tab-${this.tabs.length + 1}`, ...opts };
            this.tabs.push(tab);
            return tab;
        },
    };
}

function setup({ windows = 1, timeoutMs = 2000, installed = true } = {}) {
    const gateway = new AgentGateway({
        store: new AgentStore(':memory:'),
        agents: {
            claude: { label: 'Claude Code', uiName: 'Claude Code UI', command: process.execPath, args: [FAKE], install: 'npm i -g x' },
            agy: { label: 'agy', uiName: 'agy UI', terminalOnly: true },
        },
    });
    const sessions = fakeSessions({ windows });
    const meta = new Map();
    const launcher = new AgentLauncher({
        gateway,
        sessions,
        prefs: { get: k => meta.get(k) ?? null, set: (k, v) => meta.set(k, v) },
        commandExists: () => installed,
        timeoutMs,
    });
    return { gateway, sessions, launcher };
}

/** Answers the next popup as soon as it is broadcast. */
function answerNext(sessions, launcher, choice, remember = false) {
    const original = sessions.broadcast.bind(sessions);
    sessions.broadcast = (message) => {
        original(message);
        if (message.type === 'agent-launch') setImmediate(() => launcher.answer(message.requestId, { choice, remember }));
    };
}

test('"Sim" opens a UI tab next to the terminal and the shim is told to exit', async (t) => {
    const { gateway, sessions, launcher } = setup();
    t.after(() => gateway.shutdown());
    answerNext(sessions, launcher, 'ui');
    const result = await launcher.launch({ agent: 'claude', cwd: process.cwd(), tabId: 'term-1' });
    assert.equal(result.action, 'ui');
    assert.match(result.message, /Claude Code UI/);
    const popup = sessions.messages.find(m => m.type === 'agent-launch');
    assert.equal(popup.uiName, 'Claude Code UI');
    assert.equal(popup.cwd, process.cwd());
    assert.deepEqual(
        { kind: sessions.tabs[0].kind, afterId: sessions.tabs[0].afterId, url: sessions.tabs[0].url },
        { kind: 'agent', afterId: 'term-1', url: result.sessionId },
    );
    assert.ok(sessions.messages.some(m => m.type === 'agent-launch-close'), 'popup closes on other devices');
    assert.ok(sessions.messages.some(m => m.type === 'open-tab'));
    assert.equal(gateway.get(result.sessionId).status, 'idle');
});

test('"Não" keeps the terminal; "lembrar" stores the choice and skips the popup next time', async (t) => {
    const { gateway, sessions, launcher } = setup();
    t.after(() => gateway.shutdown());
    answerNext(sessions, launcher, 'terminal', true);
    assert.equal((await launcher.launch({ agent: 'claude', cwd: process.cwd() })).action, 'terminal');
    assert.equal(launcher.getPrefs().agents.claude, 'terminal');
    const before = sessions.messages.length;
    assert.equal((await launcher.launch({ agent: 'claude', cwd: process.cwd() })).action, 'terminal');
    assert.equal(sessions.messages.length, before, 'no popup once remembered');
});

test('"sempre UI" preference opens without asking; initial prompt is sent', async (t) => {
    const { gateway, sessions, launcher } = setup();
    t.after(() => gateway.shutdown());
    launcher.setPrefs({ agents: { claude: 'ui' } });
    gateway.on('event', (e) => {
        if (e.type === 'permission.request') gateway.respondPermission(e.sessionId, e.data.permissionId, { optionId: 'allow' });
    });
    const result = await launcher.launch({ agent: 'claude', cwd: process.cwd(), prompt: 'corrija o bug' });
    assert.equal(result.action, 'ui');
    assert.ok(!sessions.messages.some(m => m.type === 'agent-launch'));
    await new Promise(r => setTimeout(r, 300));
    const user = gateway.events(result.sessionId).find(e => e.type === 'message.user');
    assert.equal(user.data.text, 'corrija o bug');
});

test('no answer in time -> terminal, and the popup is closed everywhere', async (t) => {
    const { gateway, sessions, launcher } = setup({ timeoutMs: 50 });
    t.after(() => gateway.shutdown());
    assert.equal((await launcher.launch({ agent: 'claude', cwd: process.cwd() })).action, 'terminal');
    assert.ok(sessions.messages.some(m => m.type === 'agent-launch-close'));
    assert.equal(launcher.answer(sessions.messages[0].requestId, { choice: 'ui' }), false, 'late answer is refused');
});

test('only the first device to answer wins', async (t) => {
    const { gateway, sessions, launcher } = setup({ windows: 2 });
    t.after(() => gateway.shutdown());
    const pending = launcher.launch({ agent: 'claude', cwd: process.cwd() });
    const { requestId } = sessions.messages.find(m => m.type === 'agent-launch');
    assert.equal(launcher.answer(requestId, { choice: 'terminal' }), true);
    assert.equal(launcher.answer(requestId, { choice: 'ui' }), false);
    assert.equal((await pending).action, 'terminal');
});

test('terminal cases: interception off, terminal-only agent, missing adapter, no open window', async (t) => {
    const off = setup();
    t.after(() => off.gateway.shutdown());
    off.launcher.setPrefs({ intercept: false });
    assert.equal((await off.launcher.launch({ agent: 'claude', cwd: '/' })).action, 'terminal');

    assert.equal((await off.launcher.launch({ agent: 'agy', cwd: '/' })).action, 'terminal');

    const missing = setup({ installed: false });
    const result = await missing.launcher.launch({ agent: 'claude', cwd: '/' });
    assert.equal(result.action, 'terminal');
    assert.match(result.message, /npm i -g x/);

    const nobody = setup({ windows: 0 });
    assert.equal((await nobody.launcher.launch({ agent: 'claude', cwd: '/' })).action, 'terminal');
    assert.equal(nobody.sessions.messages.length, 0);
});

test('a failing agent start falls back to the terminal with a message', async (t) => {
    const { gateway, sessions, launcher } = setup();
    t.after(() => gateway.shutdown());
    gateway.agents.claude = { ...gateway.agents.claude, command: 'meuterminal-no-such-agent' };
    answerNext(sessions, launcher, 'ui');
    const result = await launcher.launch({ agent: 'claude', cwd: process.cwd() });
    assert.equal(result.action, 'terminal');
    assert.match(result.message, /Não foi possível abrir o modo UI/);
});

test('shim client: only bare starts or a single prompt are offered to the UI', () => {
    assert.deepEqual(classify('claude', []), { intercept: true, prompt: null });
    assert.deepEqual(classify('claude', ['corrija o bug']), { intercept: true, prompt: 'corrija o bug' });
    assert.equal(classify('claude', ['-p', 'oi']).intercept, false);
    assert.equal(classify('claude', ['--version']).intercept, false);
    assert.equal(classify('claude', ['mcp']).intercept, false);
    assert.equal(classify('claude', ['--resume']).intercept, false);
    assert.equal(classify('codex', ['exec', 'x']).intercept, false);
    assert.equal(classify('codex', ['login']).intercept, false);
    assert.equal(classify('opencode', ['run']).intercept, false);
    assert.equal(classify('opencode', ['serve']).intercept, false);
    assert.equal(classify('agy', []).intercept, false);
});

/** Tiny HTTP server standing in for MeuTerminal's /api/agent-launch. */
async function fakeApi(t, reply) {
    const requests = [];
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(reply));
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    return { url: `http://127.0.0.1:${server.address().port}/api`, requests };
}

test('shim client asks the server and maps its answer to an exit code', async (t) => {
    const ui = await fakeApi(t, { action: 'ui', message: 'Aberto' });
    const env = { MEUTERMINAL_API_URL: ui.url, MEUTERMINAL_MCP_TOKEN: 'tok', MEUTERMINAL_TAB_ID: 'tab-9' };
    assert.equal(await main(['claude', 'oi'], env), 0);
    assert.deepEqual(ui.requests[0].body, { agent: 'claude', cwd: process.cwd(), tabId: 'tab-9', prompt: 'oi' });
    assert.equal(ui.requests[0].auth, 'Bearer tok');
    assert.equal(ui.requests[0].url, '/api/agent-launch');

    const terminal = await fakeApi(t, { action: 'terminal' });
    assert.equal(await main(['claude'], { ...env, MEUTERMINAL_API_URL: terminal.url }), TERMINAL);
    assert.equal(await main(['claude', '-p', 'x'], env), TERMINAL, 'flags never reach the server');
    assert.equal(await main(['claude'], { MEUTERMINAL_API_URL: 'http://127.0.0.1:9/api', MEUTERMINAL_MCP_TOKEN: 't' }), TERMINAL, 'unreachable server');
});

const bash = spawnSync('bash', ['--version']).status === 0 && process.platform !== 'win32' ? 'bash' : null;

test('bash shim: runs the real binary when not a TTY and never recurses', { skip: !bash && 'needs bash (Linux/macOS)' }, (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-shims-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const shims = writeShims(path.join(dir, 'shims'), ['claude']);
    const realDir = path.join(dir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'claude'), '#!/usr/bin/env bash\necho "real claude $*"\n', { mode: 0o755 });
    const out = execFileSync(path.join(shims, 'claude'), ['-p', 'oi'], {
        env: { ...process.env, PATH: `${shims}:${realDir}:${process.env.PATH}`, MEUTERMINAL_API_URL: 'http://127.0.0.1:9/api' },
        encoding: 'utf8',
    });
    assert.equal(out.trim(), 'real claude -p oi');
});

test('writeShims keeps foreign files and removes our stale shims', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-shims-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    writeShims(dir, ['claude', 'codex']);
    fs.writeFileSync(path.join(dir, 'mine'), 'user file');
    writeShims(dir, ['claude']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['claude', 'mine']);
    assert.match(fs.readFileSync(path.join(dir, 'claude'), 'utf8'), /Generated by MeuTerminal/);
});
