const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/ui/pathInput.js');

test('limpa o caminho colado', async () => {
    const { cleanPath } = await load();
    assert.strictEqual(cleanPath('  /root/projeto/  '), '/root/projeto');
    assert.strictEqual(cleanPath('"/root/com espaco"'), '/root/com espaco');
    assert.strictEqual(cleanPath("'/root/x'\n"), '/root/x');
    assert.strictEqual(cleanPath('file:///root/meu%20site'), '/root/meu site');
    assert.strictEqual(cleanPath('/'), '/');
    assert.strictEqual(cleanPath('~'), '~');
    assert.strictEqual(cleanPath(''), '');
});

test('só caminho claro vira navegação', async () => {
    const { looksLikePath } = await load();
    for (const yes of ['/root', '~', '~/a', '"/root/a b"', 'file:///root']) assert.ok(looksLikePath(yes), yes);
    for (const no of ['texto qualquer', 'a/b', '/root\n/outra', 'https://site.com/a', '~abc', '']) assert.ok(!looksLikePath(no), no);
});
