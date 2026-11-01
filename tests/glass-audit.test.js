/**
 * Auditoria do vidro (public/styles.css): todo glassmorphism do app segue um sistema só, como o
 * expo-glass-effect faz no iOS nativo (que não roda na web):
 * - todo backdrop-filter usa o token --glass-blur (que vira sólido em "Reduzir transparência",
 *   "Aumentar contraste" e no visual Clássico), menos os véus/scrims listados abaixo;
 * - toda peça com o material tem a borda especular --glass-edge.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Não são vidro: véus atrás de algo e o cabeçalho fixo dos blocos de código (efeito de borda de rolagem)
const NOT_GLASS = ['.ui-select-menu.sheet::backdrop', '.ag-lightbox', '.md-code-head', '.mt-loading'];

/** Each declaration block with its own declarations (nested blocks removed) and its selector. */
function blocks(text) {
    const out = [];
    const stack = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '{') {
            const selector = text.slice(start, i).trim().split(/[;}]/).pop().trim();
            stack.push({ selector, open: i, own: '' });
            start = i + 1;
        } else if (text[i] === '}') {
            const b = stack.pop();
            if (b) {
                b.own += text.slice(start, i);
                out.push({ selector: b.selector, decls: b.own });
                if (stack.length) stack[stack.length - 1].own += ''; // parent keeps only its own text
            }
            start = i + 1;
        } else if (text[i] === ';' && stack.length) {
            stack[stack.length - 1].own += text.slice(start, i + 1);
            start = i + 1;
        }
    }
    return out;
}

const all = blocks(css).filter(b => !b.selector.startsWith('@'));

test('vidro: todo backdrop-filter usa o token --glass-blur (fora os véus listados)', () => {
    const bad = all.filter(b => /(^|[\s;])(-webkit-)?backdrop-filter\s*:/.test(b.decls)
        && !/backdrop-filter\s*:\s*(var\(--glass-blur\)|none)/.test(b.decls) // "none" tira o vidro
        && !NOT_GLASS.some(sel => b.selector.includes(sel)));
    assert.deepStrictEqual(bad.map(b => b.selector), []);
});

test('vidro: toda peça com o material tem a borda especular (--glass-edge)', () => {
    const bad = all.filter(b => /backdrop-filter\s*:\s*var\(--glass-blur\)/.test(b.decls)
        && !/var\(--glass-edge\)/.test(b.decls));
    assert.deepStrictEqual(bad.map(b => b.selector), []);
});

test('vidro: "Reduzir transparência" e "Aumentar contraste" deixam o material sólido', () => {
    const m = css.match(/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{([\s\S]*?)\n\}/);
    assert.ok(m, 'bloco de acessibilidade ausente');
    assert.match(m[1], /--glass-blur:\s*none/);
    assert.match(m[1], /--glass-edge:\s*inset 0 0 0 1px var\(--border-strong\)/);
});

test('css: sem comentário aberto e com chaves equilibradas', () => {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
    assert.strictEqual((raw.match(/\/\*/g) || []).length, (raw.match(/\*\//g) || []).length);
    assert.strictEqual((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length);
});
