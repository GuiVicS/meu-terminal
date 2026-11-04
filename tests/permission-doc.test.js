const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/agent/permissionDoc.js');

test('plano do modo plano vira documento', async () => {
    const { permissionDocument } = await load();
    assert.deepStrictEqual(permissionDocument({ input: { plan: '# Plano' } }), { text: '# Plano', name: 'Plano' });
});

test('arquivo .md novo vira documento', async () => {
    const { permissionDocument } = await load();
    const doc = permissionDocument({ diffs: [{ path: '/root/x/plano-de-acao.md', oldText: null, newText: '# Oi' }] });
    assert.deepStrictEqual(doc, { text: '# Oi', name: 'plano-de-acao.md' });
});

test('editar um .md que já existe continua sendo diff', async () => {
    const { permissionDocument } = await load();
    assert.strictEqual(permissionDocument({ diffs: [{ path: '/root/a.md', oldText: 'a', newText: 'b' }] }), null);
});

test('outros arquivos e comandos não mudam', async () => {
    const { permissionDocument } = await load();
    assert.strictEqual(permissionDocument({ diffs: [{ path: '/root/a.js', oldText: null, newText: 'x' }] }), null);
    assert.strictEqual(permissionDocument({ input: { command: 'ls' } }), null);
});

test('escrita sem diff usa o conteúdo pedido', async () => {
    const { permissionDocument } = await load();
    const doc = permissionDocument({ input: { file_path: '/root/n.md', content: 'texto' } });
    assert.deepStrictEqual(doc, { text: 'texto', name: 'n.md' });
});
