const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HtmlPreview, SANDBOX, withExternalLinks } = require('../scripts/html-preview');

function setup() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-')));
    const site = path.join(home, 'site');
    fs.mkdirSync(path.join(site, 'img'), { recursive: true });
    fs.mkdirSync(path.join(site, '.git'));
    fs.writeFileSync(path.join(home, 'solta.html'), '<p>solta');
    fs.writeFileSync(path.join(home, 'segredo.png'), 'x');
    for (const f of ['index.html', 'app.js', 'img/a.png', '.env', '.git/config.js', 'dados.db']) fs.writeFileSync(path.join(site, f), 'x');
    fs.symlinkSync(path.join(home, 'segredo.png'), path.join(site, 'fuga.png'));
    return { home, site };
}

test('a página é servida com sandbox que permite scripts e nunca a mesma origem', () => {
    assert.match(SANDBOX, /^sandbox /);
    assert.match(SANDBOX, /allow-scripts/);
    assert.doesNotMatch(SANDBOX, /allow-same-origin/);
});

test('recusa o que não é HTML e arquivo que não existe', () => {
    const { home, site } = setup();
    const p = new HtmlPreview({ home });
    assert.throws(() => p.create(path.join(site, 'app.js')), /HTML/);
    assert.throws(() => p.create(path.join(site, 'nada.html')), /não encontrado/);
});

test('libera os recursos da pasta e bloqueia o resto', () => {
    const { home, site } = setup();
    const p = new HtmlPreview({ home });
    const { token, name } = p.create(path.join(site, 'index.html'));
    assert.strictEqual(name, 'index.html');
    assert.deepStrictEqual(p.resolve(token, 'index.html'), { root: site, rel: 'index.html' });
    assert.strictEqual(p.resolve(token, 'img/a.png').rel, 'img/a.png');
    for (const bad of ['.env', '.git/config.js', 'dados.db', '../segredo.png', 'img/../../segredo.png', 'fuga.png', '', '.']) {
        assert.strictEqual(p.resolve(token, bad), null, bad);
    }
    assert.strictEqual(p.resolve('token-falso', 'index.html'), null);
});

test('página solta na home não abre a home', () => {
    const { home } = setup();
    const p = new HtmlPreview({ home });
    const { token } = p.create(path.join(home, 'solta.html'));
    assert.ok(p.resolve(token, 'solta.html'));
    assert.strictEqual(p.resolve(token, 'segredo.png'), null);
});

test('o endereço expira', () => {
    const { home, site } = setup();
    let t = 1000;
    const p = new HtmlPreview({ home, ttlMs: 50, now: () => t });
    const { token } = p.create(path.join(site, 'index.html'));
    assert.ok(p.resolve(token, 'index.html'));
    t += 51;
    assert.strictEqual(p.resolve(token, 'index.html'), null);
});

test('links para outros sites saem do quadro, e a janela aberta não herda o sandbox', () => {
    assert.match(SANDBOX, /allow-popups-to-escape-sandbox/);
    assert.ok(withExternalLinks('<h1>x</h1>').endsWith('<h1>x</h1>'));
    assert.match(withExternalLinks(''), /target="_blank"/);
});
