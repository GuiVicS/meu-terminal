const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Addons, ADDONS, selectedAddons, mergeDefaults } = require('../scripts/addons');

function setup({ installed = [], failInstall = [] } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-addons-'));
    const calls = [];
    const plugins = new Set(installed);
    const run = async (args, opts) => {
        calls.push({ args, env: opts.env });
        if (args[1] === 'list') return { code: 0, stdout: JSON.stringify([...plugins].map(id => ({ id, installPath: `/cache/${id}` }))), stderr: '' };
        if (args[1] === 'install') {
            const addon = ADDONS.find(a => a.plugin === args[2]);
            if (failInstall.includes(addon.id)) return { code: 1, stdout: '', stderr: 'network down' };
            plugins.add(`${addon.plugin}@${addon.marketplace}`);
            return { code: 0, stdout: '{"ok":true}', stderr: '' };
        }
        return { code: 1, stdout: '', stderr: 'unexpected' };
    };
    const scripts = [];
    const runScript = async (script, opts) => { scripts.push({ script, env: opts.env }); return { code: 0, stdout: '', stderr: '' }; };
    const addons = new Addons({ stateFile: path.join(home, 'data', 'addons.json'), home, run, runScript, addons: ADDONS, env: { PATH: '/bin' } });
    return { home, calls, plugins, addons, scripts };
}
const installs = calls => calls.filter(c => c.args[1] === 'install').map(c => c.args[2]);

test('addons: first boot installs the three plugins (user scope, from their marketplaces)', async () => {
    const { calls, addons, plugins } = setup();
    const r = await addons.bootstrap();
    assert.deepStrictEqual(installs(calls), ['claude-code-setup', 'cartographer', 'claude-mem']);
    assert.ok(r.every(x => x.ok));
    const mem = calls.find(c => c.args[2] === 'claude-mem');
    assert.deepStrictEqual(mem.args.slice(3), ['--marketplace', 'thedotmack/claude-mem', '--scope', 'user', '--json']);
    assert.strictEqual(mem.env.CLAUDE_MEM_ONLINE_OPTIN, 'false'); // no trial sign-in
    assert.ok(plugins.has('cartographer@cartographer-marketplace'));
});

test('addons: claude-mem creates its "claude-mem" command right after install', async () => {
    const { addons, scripts } = setup();
    await addons.bootstrap();
    assert.strictEqual(scripts.length, 1);
    assert.strictEqual(scripts[0].script, '/cache/claude-mem@thedotmack/scripts/ensure-launcher.cjs');
    assert.strictEqual(scripts[0].env.CLAUDE_PLUGIN_ROOT, '/cache/claude-mem@thedotmack');
});

test('addons: claude-mem gets the user-plan defaults, without touching keys the user set', async () => {
    const { home, addons } = setup();
    const file = path.join(home, '.claude-mem', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ CLAUDE_MEM_MODEL: 'sonnet', OTHER: 'x' }));
    await addons.bootstrap();
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(s.CLAUDE_MEM_MODEL, 'sonnet');
    assert.strictEqual(s.OTHER, 'x');
    assert.strictEqual(s.CLAUDE_MEM_PROVIDER, 'claude');
    assert.strictEqual(s.CLAUDE_MEM_CLAUDE_AUTH_METHOD, 'subscription');
    assert.strictEqual(s.CLAUDE_MEM_WORKER_HOST, '127.0.0.1');
    assert.strictEqual(s.CLAUDE_MEM_CLOUD_SYNC_HUB_URL, '');
});

test('addons: a plugin the user removed later is not reinstalled on the next boot', async () => {
    const { calls, addons, plugins } = setup();
    await addons.bootstrap();
    plugins.delete('cartographer@cartographer-marketplace'); // user uninstalled it
    calls.length = 0;
    await addons.bootstrap();
    assert.deepStrictEqual(installs(calls), []);
});

test('addons: an already installed plugin is only marked, not reinstalled', async () => {
    const { calls, addons } = setup({ installed: ['claude-mem@thedotmack'] });
    await addons.bootstrap();
    assert.deepStrictEqual(installs(calls), ['claude-code-setup', 'cartographer']);
});

test('addons: a failed install is retried next boot; the others are kept', async () => {
    const env = setup({ failInstall: ['cartographer'] });
    const first = await env.addons.bootstrap();
    assert.deepStrictEqual(first.map(r => [r.id, r.ok]), [['claude-code-setup', true], ['cartographer', false], ['claude-mem', true]]);
    assert.match(first[1].error, /network down/);
    const retry = new Addons({ stateFile: env.addons.stateFile, home: env.home, run: env.addons.run, runScript: env.addons.runScript, addons: ADDONS });
    env.calls.length = 0;
    await retry.bootstrap();
    assert.deepStrictEqual(installs(env.calls), ['cartographer']);
});

test('addons: when "claude plugin list" fails nothing is installed or marked', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-addons-'));
    const run = async () => ({ code: 1, stdout: '', stderr: 'claude: not found' });
    const addons = new Addons({ stateFile: path.join(home, 'addons.json'), home, run, addons: ADDONS });
    assert.deepStrictEqual(await addons.bootstrap(), []);
    assert.strictEqual(fs.existsSync(path.join(home, 'addons.json')), false);
});

test('addons: MT_ADDONS selects all, none or a list', () => {
    assert.strictEqual(selectedAddons('').length, 3);
    assert.strictEqual(selectedAddons('off').length, 0);
    assert.deepStrictEqual(selectedAddons('claude-mem, cartographer').map(a => a.id), ['cartographer', 'claude-mem']);
});

test('addons: mergeDefaults only adds missing keys', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-m-')), 'a', 's.json');
    assert.deepStrictEqual(mergeDefaults(file, { A: '1', B: '2' }), ['A', 'B']);
    fs.writeFileSync(file, JSON.stringify({ A: 'mine' }));
    assert.deepStrictEqual(mergeDefaults(file, { A: '1', B: '2' }), ['B']);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { A: 'mine', B: '2' });
});
