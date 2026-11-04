const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Integrations, tomlApply, publicSpec } = require('../scripts/integrations');
const { ClaudeAccounts } = require('../scripts/claude-accounts');
const { CodexAccounts, OpenCodeAccounts, AgyAccounts } = require('../scripts/agent-accounts');

const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const put = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

/** Lista do Codex lida do config.toml de teste, no formato de `codex mcp list --json`. */
function fakeCodex(home, extra = () => []) {
    return (cmd, args, opts, cb) => {
        const text = fs.existsSync(path.join(home, '.codex', 'config.toml')) ? fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8') : '';
        const list = [];
        for (const m of text.matchAll(/^\[mcp_servers\.([\w-]+)\]\n((?:(?!\[).*\n?)*)/gm)) {
            const url = m[2].match(/^url = "(.*)"/m)?.[1];
            const command = m[2].match(/^command = "(.*)"/m)?.[1];
            const args2 = m[2].match(/^args = (.*)/m)?.[1];
            const headers = text.match(new RegExp(`\\[mcp_servers\\.${m[1]}\\.http_headers\\]\\n((?:(?!\\[).*\\n?)*)`))?.[1];
            const http_headers = headers ? Object.fromEntries([...headers.matchAll(/^(\S+) = "(.*)"/gm)].map(h => [h[1], h[2]])) : null;
            list.push({ name: m[1], transport: url ? { type: 'streamable_http', url, http_headers } : { type: 'stdio', command, args: args2 ? JSON.parse(args2) : [], env: null } });
        }
        cb(null, JSON.stringify([...list, ...extra()]));
    };
}

function setup({ exec } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'integ-'));
    const accounts = {
        claude: new ClaudeAccounts({ home }),
        codex: new CodexAccounts({ home }),
        opencode: new OpenCodeAccounts({ home }),
        agy: new AgyAccounts({ home }),
    };
    return { home, accounts, it: new Integrations({ home, accounts, exec: exec || fakeCodex(home) }) };
}

const HTTP = { type: 'http', url: 'https://mcp.exemplo.com/mcp', headers: { Authorization: 'Bearer SEGREDO-123' } };
const STDIO = { type: 'stdio', command: 'npx', args: ['-y', 'pacote'], env: { CHAVE: 'SEGREDO-456' } };

test('MCP cadastrado chega a todas as contas e agentes, cada um no formato dele', async () => {
    const { home, accounts, it } = setup();
    const conta = accounts.claude.create('Dois');
    put(path.join(accounts.claude.dirOf(conta), '.claude.json'), '{"oauthAccount":{"x":1}}');
    const agyConta = accounts.agy.create('Tres');
    put(path.join(home, '.claude.json'), '{"keep":true,"mcpServers":{"meu":{"type":"stdio","command":"a","args":[],"env":{}}}}');
    await it.addServer('remoto', HTTP);
    await it.addServer('local', STDIO);

    const main = json(path.join(home, '.claude.json'));
    assert.equal(main.keep, true);
    assert.ok(main.mcpServers.meu, 'o que já existia fica');
    assert.deepEqual(main.mcpServers.remoto, { type: 'http', url: HTTP.url, headers: HTTP.headers });
    const extra = json(path.join(accounts.claude.dirOf(conta), '.claude.json'));
    assert.deepEqual(extra.oauthAccount, { x: 1 });
    assert.equal(extra.mcpServers.local.command, 'npx');

    const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /\[mcp_servers\.remoto\]\nurl = "https:\/\/mcp\.exemplo\.com\/mcp"/);
    assert.match(toml, /\[mcp_servers\.remoto\.http_headers\]\nAuthorization = "Bearer SEGREDO-123"/);
    assert.match(toml, /\[mcp_servers\.local\.env\]\nCHAVE = "SEGREDO-456"/);

    const oc = json(path.join(home, '.config', 'opencode', 'opencode.json')).mcp;
    assert.deepEqual(oc.remoto, { type: 'remote', url: HTTP.url, enabled: true, headers: HTTP.headers });
    assert.deepEqual(oc.local.command, ['npx', '-y', 'pacote']);
    assert.equal(oc.local.environment.CHAVE, 'SEGREDO-456');

    const agy = json(path.join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers;
    assert.deepEqual(agy.remoto, { serverUrl: HTTP.url, headers: HTTP.headers });
    const agyExtra = json(path.join(accounts.agy.dirOf(agyConta), '.gemini', 'config', 'mcp_config.json')).mcpServers;
    assert.equal(agyExtra.local.command, 'npx');

    const mode = f => (fs.statSync(f).mode & 0o777).toString(8);
    assert.equal(mode(path.join(home, '.config', 'opencode', 'opencode.json')), '600');
    assert.equal(mode(path.join(home, '.meuterminal', 'integracoes.json')), '600');
});

test('não altera entrada alheia: mesmo nome com conteúdo diferente vira conflito', async () => {
    const { home, it } = setup();
    const alheia = { mcpServers: { remoto: { type: 'http', url: 'https://outro.exemplo.com/mcp' } } };
    put(path.join(home, '.claude.json'), JSON.stringify(alheia));
    await it.addServer('remoto', HTTP);
    assert.deepEqual(json(path.join(home, '.claude.json')).mcpServers.remoto, alheia.mcpServers.remoto);
    const o = await it.overview();
    assert.equal(o.servers.find(s => s.name === 'remoto').targets.claude.state, 'conflict');
    await it.replaceIn('remoto', 'claude');
    assert.equal(json(path.join(home, '.claude.json')).mcpServers.remoto.url, HTTP.url);
});

test('mesmo endereço com outro nome não duplica, e só troca por pedido', async () => {
    const { home, it } = setup();
    put(path.join(home, '.codex', 'config.toml'), '[tui]\nx = true\n\n[mcp_servers.pediu]\nurl = "https://mcp.exemplo.com/mcp"\n');
    await it.addServer('remoto', HTTP);
    let toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.doesNotMatch(toml, /mcp_servers\.remoto/);
    const row = (await it.overview()).servers.find(s => s.name === 'remoto');
    assert.deepEqual(row.targets.codex, { state: 'alias', alias: 'pediu' });
    await it.replaceIn('remoto', 'codex');
    toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    assert.doesNotMatch(toml, /mcp_servers\.pediu/);
    assert.match(toml, /\[tui\]\nx = true/);
    assert.match(toml, /mcp_servers\.remoto\.http_headers/);
});

test('remover tira só o que foi gravado aqui e não foi mexido depois', async () => {
    const { home, it } = setup();
    await it.addServer('remoto', HTTP);
    const agyFile = path.join(home, '.gemini', 'config', 'mcp_config.json');
    const agy = json(agyFile);
    agy.mcpServers.remoto.serverUrl = 'https://mudado.exemplo.com/mcp'; // o usuário mexeu à mão
    fs.writeFileSync(agyFile, JSON.stringify(agy));
    await it.removeServer('remoto');
    assert.equal(json(agyFile).mcpServers.remoto.serverUrl, 'https://mudado.exemplo.com/mcp');
    assert.equal(json(path.join(home, '.config', 'opencode', 'opencode.json')).mcp.remoto, undefined);
    assert.doesNotMatch(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8'), /remoto/);
});

test('arquivo vazio vale como vazio; JSON quebrado não é sobrescrito e aparece como erro', async () => {
    const { home, it } = setup();
    const agyFile = path.join(home, '.gemini', 'config', 'mcp_config.json');
    put(agyFile, '');
    put(path.join(home, '.config', 'opencode', 'opencode.json'), '{ quebrado');
    const report = await it.addServer('remoto', HTTP);
    assert.ok(json(agyFile).mcpServers.remoto);
    assert.equal(fs.readFileSync(path.join(home, '.config', 'opencode', 'opencode.json'), 'utf8'), '{ quebrado');
    assert.ok(report.errors.some(e => e.target === 'opencode' && !e.error.includes('quebrado')));
});

test('faz cópia do arquivo antes da primeira gravação e só dela', async () => {
    const { home, it } = setup();
    put(path.join(home, '.claude.json'), '{"original":1}');
    await it.addServer('um', HTTP);
    await it.addServer('dois', STDIO);
    const copy = path.join(home, '.meuterminal', 'integracoes-copias', '.claude.json');
    assert.deepEqual(json(copy), { original: 1 });
    assert.equal((fs.statSync(copy).mode & 0o777).toString(8), '600');
});

test('conta do Claude sem login fica de fora até ter .claude.json', async () => {
    const { accounts, it } = setup();
    const id = accounts.claude.create('nova');
    await it.addServer('remoto', HTTP);
    const file = path.join(accounts.claude.dirOf(id), '.claude.json');
    assert.ok(!fs.existsSync(file));
    put(file, '{}');
    await it.sync();
    assert.ok(json(file).mcpServers.remoto);
});

test('a visão geral nunca entrega segredos', async () => {
    const { home, it } = setup();
    put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { alheio: { type: 'http', url: 'https://a.exemplo.com/mcp?token=SEGREDO-789', headers: { 'X-K': 'SEGREDO-000' } } } }));
    await it.addServer('remoto', HTTP);
    await it.addServer('local', STDIO);
    const text = JSON.stringify(await it.overview());
    assert.doesNotMatch(text, /SEGREDO/);
    assert.match(text, /X-K/);
    assert.deepEqual(publicSpec({ type: 'stdio', command: '/usr/bin/npx', args: ['--token=SEGREDO'] }), { type: 'stdio', address: 'npx', secretNames: [] });
});

test('token no campo do nome da variável do Codex: avisa sem mostrar o valor e não adota', async () => {
    const { it } = setup({
        exec: (cmd, args, opts, cb) => cb(null, JSON.stringify([{ name: 'pediu', transport: { url: 'https://p.exemplo.com/mcp', bearer_token_env_var: 'pmcp_SEGREDO-abc' } }])),
    });
    const o = await it.overview();
    assert.ok(o.warnings.some(w => /pediu/.test(w)));
    assert.doesNotMatch(JSON.stringify(o), /SEGREDO/);
    await assert.rejects(it.adoptServer('pediu', 'codex'), /variável/);
});

test('adotar leva para o cadastro e espalha sem mexer no original', async () => {
    const { home, it } = setup();
    const original = { type: 'http', url: HTTP.url, headers: HTTP.headers };
    put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { remoto: original } }));
    assert.equal((await it.overview()).servers[0].registered, false);
    await it.adoptServer('remoto', 'claude');
    assert.deepEqual(json(path.join(home, '.claude.json')).mcpServers.remoto, original);
    assert.ok(json(path.join(home, '.gemini', 'config', 'mcp_config.json')).mcpServers.remoto);
    assert.equal((await it.overview()).servers[0].registered, true);
});

test('recusa nome e especificação inválidos', async () => {
    const { it } = setup();
    assert.throws(() => it.addServer('a b', HTTP), /Nome inválido/);
    assert.throws(() => it.addServer('a.b', HTTP), /Nome inválido/);
    assert.throws(() => it.addServer('ok', { type: 'http', url: 'ftp://x' }), /http ou https/);
    assert.throws(() => it.addServer('ok', { type: 'stdio', command: ' ' }), /comando/);
    assert.throws(() => it.addServer('ok', { type: 'stdio', command: 'x', env: { 'A B': '1' } }), /variável/);
});

test('TOML: tira só as seções do MCP e preserva o resto', () => {
    const text = '# topo\n[tui]\na = 1\n\n[mcp_servers.um]\ncommand = "x"\n\n[mcp_servers.um.env]\nK = "v"\n\n[mcp_servers.umdois]\ncommand = "y"\n\n[outra]\nb = 2\n';
    const out = tomlApply(text, { remove: ['um'] });
    assert.match(out, /# topo\n\[tui\]\na = 1/);
    assert.match(out, /\[mcp_servers\.umdois\]\ncommand = "y"/);
    assert.match(out, /\[outra\]\nb = 2/);
    assert.doesNotMatch(out, /mcp_servers\.um\]|mcp_servers\.um\.env|K = /);
    assert.match(tomlApply('', { set: { n: { type: 'http', url: 'https://a"b' } } }), /url = "https:\/\/a\\"b"/);
});

const skill = (dir, name) => put(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);

test('skill da pasta única chega a Claude e Antigravity por link', async () => {
    const { home, accounts, it } = setup();
    const conta = accounts.agy.create('Tres');
    skill(path.join(home, '.agents', 'skills'), 'minha');
    await it.sync();
    for (const dir of [path.join(home, '.claude', 'skills'), path.join(home, '.gemini', 'config', 'skills'), path.join(accounts.agy.dirOf(conta), '.gemini', 'config', 'skills')]) {
        assert.ok(fs.lstatSync(path.join(dir, 'minha')).isSymbolicLink(), dir);
        assert.ok(fs.existsSync(path.join(dir, 'minha', 'SKILL.md')), dir);
    }
    const row = (await it.overview()).skills[0];
    assert.deepEqual(row, { name: 'minha', unified: true, claude: true, codex: true, opencode: true, agy: true });
});

test('espalhar skill do Claude: nada se perde, e o Claude segue vendo', async () => {
    const { home, it } = setup();
    skill(path.join(home, '.claude', 'skills'), 'minha');
    fs.mkdirSync(path.join(home, '.claude', 'skills', '.trash'));
    const before = (await it.overview()).skills;
    assert.deepEqual(before.map(s => [s.name, s.unified, s.opencode, s.codex]), [['minha', false, true, false]]);
    await it.spreadSkill('minha');
    assert.ok(!fs.lstatSync(path.join(home, '.agents', 'skills', 'minha')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(home, '.claude', 'skills', 'minha')).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'minha', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.gemini', 'config', 'skills', 'minha', 'SKILL.md')));
});

test('skill que é link para um projeto continua ligada ao projeto', async () => {
    const { home, it } = setup();
    const proj = path.join(home, 'projetos', 'x', 'minha');
    skill(path.dirname(proj), 'minha');
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync(proj, path.join(home, '.claude', 'skills', 'minha'));
    await it.spreadSkill('minha');
    assert.equal(fs.realpathSync(path.join(home, '.agents', 'skills', 'minha')), fs.realpathSync(proj));
    assert.ok(fs.existsSync(path.join(proj, 'SKILL.md')));
});

test('skill com o mesmo nome em outra pasta fica como está', async () => {
    const { home, it } = setup();
    skill(path.join(home, '.agents', 'skills'), 'minha');
    skill(path.join(home, '.claude', 'skills'), 'minha');
    const r = await it.spreadSkill('minha');
    assert.deepEqual(r.skipped, [path.join(home, '.claude', 'skills')]);
    assert.ok(!fs.lstatSync(path.join(home, '.claude', 'skills', 'minha')).isSymbolicLink());
});

test('instalar de uma pasta e remover de todos, guardando a pasta', async () => {
    const { home, it } = setup();
    const src = path.join(home, 'baixadas', 'nova');
    skill(path.dirname(src), 'nova');
    await assert.rejects(async () => it.installSkill(path.join(home, 'baixadas')), /SKILL\.md/);
    await it.installSkill(src);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'nova', 'SKILL.md')));
    await it.removeSkill('nova');
    assert.throws(() => fs.lstatSync(path.join(home, '.claude', 'skills', 'nova')));
    assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'nova')));
    assert.equal(fs.readdirSync(path.join(home, '.agents', '.skills-removidas')).length, 1);
    assert.ok(fs.existsSync(src), 'a origem não é tocada');
});

test('link quebrado de skill removida à mão é limpo; link alheio não', async () => {
    const { home, it } = setup();
    skill(path.join(home, '.agents', 'skills'), 'minha');
    await it.sync();
    fs.rmSync(path.join(home, '.agents', 'skills', 'minha'), { recursive: true });
    fs.symlinkSync(path.join(home, 'nao-existe'), path.join(home, '.claude', 'skills', 'alheio'));
    await it.sync();
    assert.throws(() => fs.lstatSync(path.join(home, '.claude', 'skills', 'minha')));
    assert.ok(fs.lstatSync(path.join(home, '.claude', 'skills', 'alheio')).isSymbolicLink());
});
