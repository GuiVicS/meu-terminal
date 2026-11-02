/**
 * Orçamento de desempenho verificado no CSS: as causas conhecidas de lentidão, sem depender de
 * tempo medido (na mesma versão, o tempo variou 2x só com a carga da máquina). Para medir de
 * verdade, compare duas versões com scripts/perf/measure.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui', 'conversationDrawer.js'), 'utf8');

test('orçamento: no desktop, desfoque só na barra lateral e na barra de cima', () => {
    const rules = [...css.matchAll(/([^{}]*\[data-desktop\][^{}]*)\{([^{}]*)\}/g)]
        .filter(m => /(^|[\s;])backdrop-filter\s*:\s*(?!none)/.test(m[2]))
        .map(m => m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' '));
    assert.deepEqual(rules.sort(), [':root[data-desktop] .dk-side', ':root[data-desktop] .topbar'].sort());
});

test('orçamento: a lista lateral não anima variável CSS no app inteiro', () => {
    assert.ok(!/setProperty\(\s*'--cv-p'/.test(js), 'variável CSS por quadro recalcula a tela toda');
    assert.ok(!/var\(--cv-p/.test(css));
});

test('orçamento: mensagens fora da tela não são calculadas', () => {
    assert.match(css, /\.ag-turn \{[^}]*content-visibility: auto/);
});
