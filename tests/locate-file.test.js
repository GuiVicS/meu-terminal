const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/agent/locateFile.js');
const deps = (files, extra = {}) => ({
    cwd: '/root',
    exists: async p => files.includes(p),
    search: async name => files.filter(f => f.split('/').pop() === name).map(path => ({ path, name, type: 'file' })),
    ...extra,
});

test('o caminho certo abre direto, sem busca', async () => {
    const { locateFile } = await load();
    const found = await locateFile('/root/a/b.html', deps(['/root/a/b.html'], { search: async () => { throw new Error('não devia buscar'); } }));
    assert.deepStrictEqual(found, { status: 'found', path: '/root/a/b.html' });
});

test('só o nome: acha na subpasta', async () => {
    const { locateFile } = await load();
    const found = await locateFile('index.html', deps(['/root/projetos/site/index.html']));
    assert.deepStrictEqual(found, { status: 'found', path: '/root/projetos/site/index.html' });
});

test('caminho relativo a outra pasta: fica com o que termina igual', async () => {
    const { locateFile } = await load();
    const found = await locateFile('site/index.html', deps(['/root/x/index.html', '/root/projetos/site/index.html']));
    assert.deepStrictEqual(found, { status: 'found', path: '/root/projetos/site/index.html' });
});

test('dois arquivos com o mesmo nome: pergunta qual', async () => {
    const { locateFile } = await load();
    const found = await locateFile('index.html', deps(['/root/a/index.html', '/root/b/index.html']));
    assert.deepStrictEqual(found, { status: 'choose', paths: ['/root/a/index.html', '/root/b/index.html'] });
});

test('caminho completo que não existe nunca abre outro arquivo sozinho', async () => {
    const { locateFile } = await load();
    const found = await locateFile('/root/sumiu/index.html', deps(['/root/a/index.html']));
    assert.deepStrictEqual(found, { status: 'choose', paths: ['/root/a/index.html'] });
});

test('espaço codificado no link', async () => {
    const { locateFile } = await load();
    const found = await locateFile('/root/meu%20site/a.html', deps(['/root/meu site/a.html']));
    assert.deepStrictEqual(found, { status: 'found', path: '/root/meu site/a.html' });
});

test('ignora node_modules', async () => {
    const { locateFile } = await load();
    const found = await locateFile('index.html', deps(['/root/app/node_modules/x/index.html', '/root/app/index.html']));
    assert.deepStrictEqual(found, { status: 'found', path: '/root/app/index.html' });
});

test('não existe: avisa, mesmo se a busca falhar', async () => {
    const { locateFile } = await load();
    assert.deepStrictEqual(await locateFile('nada.html', deps([])), { status: 'missing', name: 'nada.html' });
    const falhou = await locateFile('nada.html', deps([], { search: async () => { throw new Error('x'); } }));
    assert.deepStrictEqual(falhou, { status: 'missing', name: 'nada.html' });
});
