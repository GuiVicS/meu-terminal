const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClaudeAccounts } = require('../scripts/claude-accounts');

test('contas: a pasta da conta compartilha tudo do ~/.claude menos o login', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-acc-'));
    const main = path.join(home, '.claude');
    fs.mkdirSync(path.join(main, 'projects', '-root'), { recursive: true });
    fs.writeFileSync(path.join(main, '.credentials.json'), '{"segredo":1}');
    fs.writeFileSync(path.join(main, 'settings.json'), '{"a":1}');
    const acc = new ClaudeAccounts({ home, execImpl: () => {} });
    const id = acc.create('Trabalho Ção');
    assert.equal(id, 'trabalho-cao');
    assert.equal(acc.create('Trabalho Ção'), 'trabalho-cao-2');
    const dir = acc.env(id).CLAUDE_CONFIG_DIR;
    assert.equal(fs.readlinkSync(path.join(dir, 'projects')), path.join(main, 'projects'));
    assert.equal(fs.readlinkSync(path.join(dir, 'settings.json')), path.join(main, 'settings.json'));
    assert.ok(!fs.existsSync(path.join(dir, '.credentials.json')), 'o login da principal não pode ir para a conta');
    assert.deepEqual(acc.env(null), {});
    assert.match(acc.loginCommand(id), /^CLAUDE_CONFIG_DIR=".*trabalho-cao" claude auth login\r$/);
    assert.throws(() => acc.env('../fora'), /inválida/);
    // remover a conta não mexe no principal (os links não são seguidos)
    acc.remove(id);
    assert.ok(fs.existsSync(path.join(main, 'projects', '-root')) && fs.existsSync(path.join(main, '.credentials.json')));
    assert.deepEqual(acc.ids(), ['trabalho-cao-2']);
    fs.rmSync(home, { recursive: true, force: true });
});

test('contas: status vem do "claude auth status" com a pasta da conta', async () => {
    const seen = [];
    const acc = new ClaudeAccounts({ home: os.tmpdir(), env: { PATH: '/bin' }, execImpl: (cmd, args, opts, cb) => {
        seen.push(opts.env.CLAUDE_CONFIG_DIR || null);
        cb(null, JSON.stringify({ loggedIn: true, email: 'a@b.c', subscriptionType: 'max' }));
    } });
    assert.deepEqual(await acc.status(null), { loggedIn: true, email: 'a@b.c', plan: 'max' });
    await acc.status('outra');
    assert.equal(seen[0], null);
    assert.match(seen[1], /\.meuterminal-contas\/claude\/outra$/);
});
