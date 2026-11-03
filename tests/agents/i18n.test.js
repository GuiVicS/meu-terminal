const test = require('node:test');
const assert = require('node:assert');
const { translateOption, translateMode, translateCapabilities, translateName, translateDescription } = require('../../scripts/agents/i18n');
const { normalizeConfigOptions } = require('../../scripts/agents/acp-mapping');

// Termos que Claude Code, Codex e OpenCode mandam de verdade (mapeados dos dados reais em 2026-11-03)
const REAIS = {
    Mode: 'Modo', 'Session Mode': 'Modo da sessão', Model: 'Modelo', Effort: 'Esforço', 'Reasoning effort': 'Esforço de raciocínio',
    Agent: 'Agente', 'Fast mode': 'Modo rápido', 'Collaboration mode': 'Modo de colaboração',
    Manual: 'Manual', 'Accept edits': 'Aceitar edições', Plan: 'Planejar', plan: 'Planejar', Auto: 'Automático',
    'Read-only': 'Somente leitura', 'Workspace access': 'Acesso à pasta do projeto', 'Auto review': 'Revisão automática', 'Full access': 'Acesso total',
    Build: 'Executar', build: 'Executar', Default: 'Padrão', 'Default (recommended)': 'Padrão (recomendado)',
    None: 'Nenhum', Minimal: 'Mínimo', Low: 'Baixo', Medium: 'Médio', High: 'Alto', Xhigh: 'Muito alto', Max: 'Máximo', On: 'Ligado', Off: 'Desligado',
};

test('tradução: todos os termos mapeados dos agentes', () => {
    for (const [en, pt] of Object.entries(REAIS)) assert.equal(translateName(en), pt, en);
});

test('tradução: descrições, inclusive as compostas dos modelos', () => {
    assert.equal(translateDescription('Always ask before making changes'), 'Sempre pergunta antes de fazer alterações');
    assert.equal(translateDescription('Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok'), 'Opus 5.5 · Melhor para o dia a dia e tarefas complexas · $4/$20 por milhão de tokens');
    assert.equal(translateDescription('From gateway'), 'Pelo gateway');
    assert.equal(translateDescription(''), '');
});

test('tradução: nunca muda id nem valor; nomes de modelo ficam; repetir não muda nada', () => {
    const [o] = normalizeConfigOptions([{ id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }, { value: 'xhigh', name: 'Xhigh' }] }]);
    assert.equal(o.id, 'effort');
    assert.equal(o.currentValue, 'high');
    assert.deepEqual(o.options.map(x => [x.value, x.name]), [['high', 'Alto'], ['xhigh', 'Muito alto']]);
    assert.deepEqual(translateOption(o), o);
    assert.equal(translateName('Opus 5.5'), 'Opus 5.5');
    assert.equal(translateName('OpenCode/Big Pickle'), 'OpenCode/Big Pickle');
    assert.equal(translateName('OpenCode/Beam Free'), 'OpenCode/Beam (grátis)');
    assert.deepEqual(translateMode({ id: 'acceptEdits', name: 'Accept edits', description: '' }).id, 'acceptEdits');
    assert.equal(translateCapabilities({ modeList: [{ id: 'plan', name: 'Plan', description: '' }] }).modeList[0].name, 'Planejar');
    assert.equal(translateCapabilities(null), null);
});
