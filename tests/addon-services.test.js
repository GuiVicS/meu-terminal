const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { ServiceManager, routeEnv, normalizeRoute, RouteError } = require('../scripts/addon-services');
const { Addons, SERVICES } = require('../scripts/addons');

// ---------- routeEnv ----------

test('routes: "direto" (and anything unknown) adds nothing - the user\'s own Anthropic login', () => {
    assert.deepStrictEqual(routeEnv('direto', {}, SERVICES), {});
    assert.deepStrictEqual(routeEnv('qualquer', {}, SERVICES), {});
    assert.strictEqual(normalizeRoute(undefined), 'direto');
});

test('routes: "economia" points Claude Code at the local Headroom, keeping the user\'s login', () => {
    assert.deepStrictEqual(routeEnv('economia', {}, SERVICES), { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' });
});

test('routes: "omniroute" needs the OmniRoute key, and sends key + model', () => {
    assert.throws(() => routeEnv('omniroute', { services: {} }, SERVICES), RouteError);
    const env = routeEnv('omniroute', { services: { omniroute: { apiKey: 'oma_live_x', model: 'glm/glm-5.2' } } }, SERVICES);
    assert.deepStrictEqual(env, {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:20128',
        ANTHROPIC_AUTH_TOKEN: 'oma_live_x',
        ANTHROPIC_MODEL: 'glm/glm-5.2',
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    });
});

test('services: both bind to 127.0.0.1 and keep the redundant features off', () => {
    const hr = SERVICES.headroom.args.join(' ');
    assert.match(hr, /--host 127\.0\.0\.1/);
    for (const flag of ['--no-learn', '--no-telemetry', '--no-subscription-tracking', '--disable-kompress']) assert.ok(hr.includes(flag), flag);
    assert.ok(!/--memory|--code-graph/.test(hr));
    const omni = SERVICES.omniroute.env('/root');
    assert.strictEqual(omni.OMNIROUTE_SERVER_HOST, '127.0.0.1');
    assert.strictEqual(omni.REQUIRE_API_KEY, 'true');
    assert.strictEqual(omni.DATA_DIR, '/root/.omniroute');
});

// ---------- ServiceManager ----------

function fakeWorld({ healthyAfter = 2, dies = false } = {}) {
    let up = false, polls = 0;
    const spawned = [];
    const spawnImpl = (cmd, args, opts) => {
        const child = new EventEmitter();
        child.pid = 4242 + spawned.length;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        spawned.push({ cmd, args, opts, child });
        if (dies) setTimeout(() => child.emit('exit', 1, null), 5);
        else polls = 0;
        return child;
    };
    const fetchImpl = async () => {
        if (spawned.length && !dies && ++polls >= healthyAfter) up = true;
        if (!up) throw new Error('ECONNREFUSED');
        return { status: 200 };
    };
    return { spawnImpl, fetchImpl, spawned, setUp: v => { up = v; } };
}

test('ServiceManager: starts the service once (concurrent callers share it) and waits for health', async () => {
    const w = fakeWorld();
    const m = new ServiceManager({ defs: SERVICES, home: '/h', env: { PATH: '/bin' }, fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, healthIntervalMs: 1 });
    await Promise.all([m.ensure('headroom'), m.ensure('headroom')]);
    assert.strictEqual(w.spawned.length, 1);
    assert.strictEqual(w.spawned[0].cmd, 'headroom');
    assert.strictEqual(w.spawned[0].opts.detached, true);
    assert.strictEqual(w.spawned[0].opts.env.DO_NOT_TRACK, '1');
    assert.strictEqual(w.spawned[0].opts.env.HOME, '/h');
    await m.ensure('headroom'); // already healthy: no second process
    assert.strictEqual(w.spawned.length, 1);
});

test('ServiceManager: a service that dies while starting reports the error', async () => {
    const w = fakeWorld({ dies: true });
    const m = new ServiceManager({ defs: SERVICES, home: '/h', fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, healthIntervalMs: 2 });
    m.onExit = function (id, child) { const st = this.s(id); if (st.child === child) st.child = null; }; // no auto-restart here
    await assert.rejects(m.ensure('omniroute'), /parou ao iniciar/);
});

test('ServiceManager: apply() starts enabled services and leaves the others off', async () => {
    const w = fakeWorld({ healthyAfter: 1 });
    const m = new ServiceManager({ defs: SERVICES, home: '/h', fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, healthIntervalMs: 1 });
    await m.apply({ services: { omniroute: { enabled: true } } });
    assert.deepStrictEqual(w.spawned.map(s => s.cmd), ['omniroute']);
});

// ---------- prefs ----------

test('addons prefs: key and model are stored (file 0600), never returned by status()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-prefs-'));
    const run = async () => ({ code: 0, stdout: '[]', stderr: '' });
    const a = new Addons({ stateFile: path.join(dir, 'addons.json'), home: dir, run });
    a.setPrefs({ services: { omniroute: { enabled: true, apiKey: ' oma_live_secret ', model: 'kimi/kimi-k2.6' }, nope: { enabled: true } }, terminalRoute: 'economia' });
    const prefs = a.prefs();
    assert.strictEqual(prefs.services.omniroute.apiKey, 'oma_live_secret');
    assert.strictEqual(prefs.terminalRoute, 'economia');
    assert.strictEqual(prefs.services.nope, undefined);
    assert.strictEqual(fs.statSync(path.join(dir, 'addons.json')).mode & 0o777, 0o600);
    const status = await a.status();
    assert.ok(!JSON.stringify(status).includes('oma_live_secret'));
    assert.strictEqual(status.find(s => s.id === 'omniroute').hasApiKey, true);
    a.setPrefs({ services: { omniroute: { apiKey: '' } } });
    assert.strictEqual(a.prefs().services.omniroute.apiKey, undefined);
});

test('OmniRoute: panel password and secrets are generated once, kept, and passed to the process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sec-'));
    const a = new Addons({ stateFile: path.join(dir, 'addons.json'), home: dir, run: async () => ({ code: 0, stdout: '[]', stderr: '' }) });
    const first = a.serviceSecrets('omniroute');
    assert.ok(first.INITIAL_PASSWORD && first.INITIAL_PASSWORD !== 'CHANGEME' && first.INITIAL_PASSWORD.length >= 16);
    assert.ok(first.JWT_SECRET && first.API_KEY_SECRET);
    assert.deepStrictEqual(a.serviceSecrets('omniroute'), first); // same on the next start
    assert.deepStrictEqual(a.serviceSecrets('headroom'), {});
    const status = (await a.status()).find(s => s.id === 'omniroute');
    assert.ok(!JSON.stringify(status).includes(first.INITIAL_PASSWORD)); // a tela não precisa mais da senha
    assert.ok(!JSON.stringify(status).includes(first.JWT_SECRET));
    const w = fakeWorld({ healthyAfter: 1 });
    const m = new ServiceManager({ defs: SERVICES, home: dir, secrets: id => a.serviceSecrets(id), fetchImpl: w.fetchImpl, spawnImpl: w.spawnImpl, healthIntervalMs: 1 });
    await m.ensure('omniroute');
    assert.strictEqual(w.spawned[0].opts.env.INITIAL_PASSWORD, first.INITIAL_PASSWORD);
});
