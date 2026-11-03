const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { readOpenCodeLogin, listOpenCodeModels } = require('../scripts/opencode-login');
const { OmniRouteBridge } = require('../scripts/addon-bridges');

function homeWith(rows) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-oc-'));
    const dir = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'opencode.db'));
    db.exec('CREATE TABLE credential (integration_id TEXT, active INT, value TEXT)');
    for (const [id, active, value] of rows) db.prepare('INSERT INTO credential VALUES (?,?,?)').run(id, active, JSON.stringify(value));
    db.close();
    return { home, dir };
}

test('login: lê só a credencial ativa do OpenCode no banco; sem ela, cai no auth.json', () => {
    const a = homeWith([['opencode', 0, { access: 'velho' }], ['outro', 1, { access: 'x' }], ['opencode', 1, { access: 'novo', expires: 123 }]]);
    assert.deepEqual(readOpenCodeLogin(a.home), { access: 'novo', expires: 123 });
    const b = homeWith([]);
    assert.equal(readOpenCodeLogin(b.home), null);
    fs.writeFileSync(path.join(b.dir, 'auth.json'), JSON.stringify({ opencode: { type: 'oauth', access: 'doarquivo' } }));
    assert.equal(readOpenCodeLogin(b.home).access, 'doarquivo');
    assert.equal(readOpenCodeLogin(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-oc-vazio-'))), null);
});

test('modelos: tira o prefixo e as cores; se o comando falhar, null (não filtra)', async () => {
    const ok = await listOpenCodeModels({ execImpl: (c, a, o, cb) => cb(null, '\x1b[0mopencode/big-pickle\nopencode/x-free\nlixo\n') });
    assert.deepEqual(ok, ['big-pickle', 'x-free']);
    assert.equal(await listOpenCodeModels({ execImpl: (c, a, o, cb) => cb(new Error('não instalado')) }), null);
});

function bridgeWith(home, connections = []) {
    const calls = [];
    const b = new OmniRouteBridge({ password: () => 'x', home, openCodeModels: async () => ['big-pickle', 'x-free'] });
    b.api = async (method, url, body) => {
        calls.push({ method, url, body });
        if (method === 'GET' && url === '/api/providers') return { connections };
        if (method === 'GET') return { provider: 'opencode-zen', models: [{ id: 'gpt-pago', name: 'Pago' }, { id: 'big-pickle', name: 'Big Pickle' }] };
        return { connection: { id: 'novo' } };
    };
    return { b, calls };
}
const CONN = { id: 'c1', provider: 'opencode-zen', name: 'OpenCode (login do servidor)' };

test('conectar: cria a conexão com o token; se já existe, atualiza; a resposta não traz o token', async () => {
    const { home } = homeWith([['opencode', 1, { access: 'tok-1' }]]);
    const a = bridgeWith(home);
    const r = await a.b.importOpenCode(home);
    assert.deepEqual(a.calls.at(-1), { method: 'POST', url: '/api/providers', body: { provider: 'opencode-zen', name: CONN.name, apiKey: 'tok-1' } });
    assert.ok(!JSON.stringify(r).includes('tok-1'));
    const b = bridgeWith(home, [CONN]);
    await b.b.importOpenCode(home);
    assert.deepEqual(b.calls.at(-1), { method: 'PUT', url: '/api/providers/c1', body: { apiKey: 'tok-1' } });
    await assert.rejects(a.b.importOpenCode(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-oc-sem-'))), /opencode auth login/);
});

test('renovação: só envia quando o token muda e a conexão existe', async () => {
    const { home, dir } = homeWith([['opencode', 1, { access: 'tok-1' }]]);
    const none = bridgeWith(home);
    assert.equal(await none.b.syncOpenCode(home), false); // nunca conectou: não cria nada
    const { b, calls } = bridgeWith(home, [CONN]);
    assert.equal(await b.syncOpenCode(home), true);
    const n = calls.length;
    assert.equal(await b.syncOpenCode(home), false); // igual: nem consulta
    assert.equal(calls.length, n);
    const db = new DatabaseSync(path.join(dir, 'opencode.db'));
    db.prepare('UPDATE credential SET value = ?').run(JSON.stringify({ access: 'tok-2' }));
    db.close();
    assert.equal(await b.syncOpenCode(home), true);
    assert.deepEqual(calls.at(-1).body, { apiKey: 'tok-2' });
});

test('modelos da conexão: só os pagos que a conta enxerga; outra conexão Zen fica como está', async () => {
    const { home } = homeWith([['opencode', 1, { access: 'tok-1' }]]);
    const { b } = bridgeWith(home, [CONN]);
    const seen = [];
    b.fetch = async (url, opts) => { seen.push([url, opts.headers.Authorization]); return { ok: true, json: async () => ({ data: [{ id: 'big-pickle' }, { id: 'y-free' }, { id: 'gpt-pago' }] }) }; };
    assert.deepEqual(await b.models('c1'), [{ id: 'opencode-zen/gpt-pago', name: 'Pago' }]);
    assert.deepEqual(seen, [['https://opencode.ai/zen/v1/models', 'Bearer tok-1']]);
    const outra = await b.models('chave-de-api');
    assert.deepEqual(outra.map(m => m.id), ['opencode-zen/gpt-pago', 'opencode-zen/big-pickle']);
});
