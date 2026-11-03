const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexAccounts, OpenCodeAccounts, AgyAccounts } = require('../scripts/agent-accounts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'contas-'));
const jwt = claims => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;

test('Codex: login separado, conversas e ajustes compartilhados', async () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'x=1');
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: jwt({ email: 'um@x.y' }) } }));
    const a = new CodexAccounts({ home });
    assert.deepEqual(await a.status(null), { loggedIn: true, email: 'um@x.y', plan: null });
    const id = a.create('Conta Dois');
    assert.equal(id, 'conta-dois');
    const dir = a.env(id).CODEX_HOME;
    assert.ok(fs.lstatSync(path.join(dir, 'sessions')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(dir, 'config.toml')).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(dir, 'auth.json')), 'o login da principal não vaza');
    assert.equal((await a.status(id)).loggedIn, false);
    assert.match(a.loginCommand(id), /CODEX_HOME=.*codex login --device-auth/);
    assert.deepEqual(a.env(null), {});
    assert.equal(a.shared, true);
    a.remove(id);
    assert.ok(fs.existsSync(path.join(home, '.codex', 'config.toml')), 'remover não segue os links');
    fs.rmSync(home, { recursive: true, force: true });
});

test('OpenCode: cada conta com a própria pasta de dados', async () => {
    const home = tmp();
    const a = new OpenCodeAccounts({ home });
    assert.equal((await a.status(null)).loggedIn, false);
    const id = a.create('dois');
    assert.equal(a.env(id).XDG_DATA_HOME, path.join(home, '.meuterminal-contas', 'opencode', 'dois'));
    fs.mkdirSync(path.join(a.dirOf(id), 'opencode'));
    fs.writeFileSync(path.join(a.dirOf(id), 'opencode', 'auth.json'), '{"x":{}}');
    assert.equal((await a.status(id)).loggedIn, true);
    assert.equal(a.shared, false);
    assert.match(a.loginCommand(id), /XDG_DATA_HOME=.*opencode auth login/);
    fs.rmSync(home, { recursive: true, force: true });
});

test('Antigravity: HOME própria, só o login separado; pedir login conta como deslogado', async () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.gemini'));
    fs.mkdirSync(path.join(home, 'projetos'));
    let seen = null;
    const a = new AgyAccounts({ home, env: {}, execImpl: (c, args, opts, cb) => { seen = opts.env.HOME; cb(new Error('x'), '', 'Please sign in'); } });
    const id = a.create('dois');
    const dir = a.env(id).HOME;
    assert.ok(fs.lstatSync(path.join(dir, 'projetos')).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(dir, '.gemini')));
    assert.ok(!fs.existsSync(path.join(dir, '.meuterminal-contas')), 'não aponta para si mesma');
    assert.equal((await a.status(id)).loggedIn, false);
    assert.equal(seen, dir);
    const b = new AgyAccounts({ home, env: {}, execImpl: (c, args, opts, cb) => cb(null, 'gemini-x', '') });
    assert.equal((await b.status(null)).loggedIn, true);
    fs.rmSync(home, { recursive: true, force: true });
});

test('conta inválida não vira caminho', () => {
    const a = new CodexAccounts({ home: '/tmp' });
    assert.throws(() => a.dirOf('../../etc'));
});
