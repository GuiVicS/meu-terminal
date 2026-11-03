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

// Só o que flutua. Vidro em cada mensagem (são muitas, e rolam) deixaria a rolagem pesada
const FLOATING = ['.tabstrip', '.topbar-actions .icon-btn', '.ag-jump', '.dk-reopen', '.ns-close', '.ns-settings',
    '.browser-toolbar [data-act="back"]', '.browser-more', '.browser-pill', '.fm-toolbar', '.nt-toolbar',
    '.ag-composer::before', '.ag-side', '.menu', '.toast', '.dialog', '.cp', '.search-bar', '.fm-selbar', '.fm-pastebar', '.nt-fbar',
    '.settings-sheet.sheet-page .ag-sheet', '.agent-picker .ag-sheet', '.dk-cmds:not([hidden])', '.popover'];

test('desktop com a cor original do app: nenhum gradiente próprio', () => {
    assert.ok(!/--dk-wall/.test(css));
    const rules = [...css.matchAll(/([^{}]*\[data-desktop\][^{}]*)\{([^{}]*)\}/g)].filter(m => /gradient\(/.test(m[2]));
    assert.deepEqual(rules.map(m => m[1].trim()), []);
});

test('orçamento: no desktop, desfoque só nas peças que flutuam', () => {
    const rules = [...css.matchAll(/([^{}]*\[data-desktop\][^{}]*)\{([^{}]*)\}/g)]
        .filter(m => /(^|[\s;])backdrop-filter\s*:\s*(?!\s|none)/.test(m[2]))
        .flatMap(m => m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(x => x.trim().replace(/\s+/g, ' ').replace(':root[data-desktop] ', '')));
    assert.deepEqual([...new Set(rules)].sort(), [...FLOATING].sort());
});

test('orçamento: a lista lateral não anima variável CSS no app inteiro', () => {
    assert.ok(!/setProperty\(\s*'--cv-p'/.test(js), 'variável CSS por quadro recalcula a tela toda');
    assert.ok(!/var\(--cv-p/.test(css));
});

test('orçamento: mensagens fora da tela não são calculadas', () => {
    assert.match(css, /\.ag-turn \{[^}]*content-visibility: auto/);
});
