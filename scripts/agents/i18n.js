/**
 * i18n.js
 * Os termos do seletor do Modo UI (modo, modelo, esforço...) em português. Cada agente manda os
 * seus em inglês; mapeados de Claude Code, Codex, OpenCode e agy. Só muda o texto mostrado: o id e o
 * valor enviados de volta ao agente ficam intactos. Nomes de modelo não são traduzidos.
 * Termo novo de um agente aparece em inglês até entrar aqui (nada quebra).
 */
const NAMES = {
    // títulos dos seletores
    'mode': 'Modo', 'session mode': 'Modo da sessão', 'model': 'Modelo', 'effort': 'Esforço',
    'reasoning effort': 'Esforço de raciocínio', 'agent': 'Agente', 'fast mode': 'Modo rápido',
    'collaboration mode': 'Modo de colaboração', 'thinking': 'Raciocínio', 'turbo': 'Turbo',
    // modos
    'manual': 'Manual', 'accept edits': 'Aceitar edições', 'plan': 'Planejar', 'auto': 'Automático',
    'read-only': 'Somente leitura', 'read only': 'Somente leitura', 'workspace access': 'Acesso à pasta do projeto',
    'auto review': 'Revisão automática', 'full access': 'Acesso total', 'build': 'Executar',
    'bypass permissions': 'Ignorar permissões', "don't ask": 'Não perguntar',
    // níveis e chaves
    'default': 'Padrão', 'default (recommended)': 'Padrão (recomendado)', 'recommended': 'Recomendado',
    'none': 'Nenhum', 'minimal': 'Mínimo', 'low': 'Baixo', 'medium': 'Médio', 'high': 'Alto',
    'xhigh': 'Muito alto', 'max': 'Máximo', 'on': 'Ligado', 'off': 'Desligado',
};

const DESCRIPTIONS = {
    'always ask before making changes': 'Sempre pergunta antes de fazer alterações',
    'automatically accept all file edits': 'Aceita sozinho todas as edições de arquivo',
    'create a plan before making changes': 'Cria um plano antes de fazer alterações',
    'claude handles permission decisions': 'O Claude decide as permissões',
    'session permission mode': 'Modo de permissão da sessão',
    'ai model to use': 'Modelo de IA a usar',
    'available effort levels for this model': 'Níveis de esforço deste modelo',
    'dynamic workflows on every task, at any effort level': 'Fluxos dinâmicos em toda tarefa, em qualquer nível de esforço',
    'main-thread agent persona': 'Perfil do agente principal',
    'standard claude code agent': 'Agente padrão do Claude Code',
    'faster responses on supported models': 'Respostas mais rápidas nos modelos compatíveis',
    'requires approval to edit files and access the internet.': 'Pede aprovação para editar arquivos e acessar a internet.',
    'edit workspace files; ask before writing outside the workspace or accessing the network.': 'Edita os arquivos do projeto; pergunta antes de escrever fora dele ou acessar a rede.',
    'only ask for actions detected as potentially unsafe': 'Só pergunta em ações detectadas como potencialmente inseguras',
    'unrestricted access to the internet and any file on your computer': 'Acesso sem restrição à internet e a qualquer arquivo do computador',
    'approval and sandboxing preset for the session': 'Aprovação e isolamento da sessão',
    'how codex collaborates for subsequent turns': 'Como o Codex colabora nos próximos turnos',
    'plan before making changes': 'Planeja antes de fazer alterações',
    'model codex uses for the session': 'Modelo que o Codex usa na sessão',
    'how much reasoning effort the model should use': 'Quanto esforço de raciocínio o modelo deve usar',
    'fast responses with lighter reasoning': 'Respostas rápidas com raciocínio mais leve',
    'balances speed and reasoning depth for everyday tasks': 'Equilibra velocidade e profundidade para o dia a dia',
    'greater reasoning depth for complex problems': 'Mais profundidade para problemas complexos',
    'extra high reasoning depth for complex problems': 'Profundidade muito alta para problemas complexos',
    'maximum reasoning depth for the hardest problems': 'Profundidade máxima para os problemas mais difíceis',
    'the default agent. executes tools based on configured permissions.': 'O agente padrão. Usa as ferramentas conforme as permissões configuradas.',
    'plan mode. disallows all edit tools.': 'Modo de planejamento. Bloqueia as ferramentas de edição.',
    'read-only agent for exploring the codebase and planning work before implementation.': 'Agente somente leitura, para explorar o código e planejar antes de implementar.',
    'from gateway': 'Pelo gateway',
};

// Pedaços das descrições de modelo ("Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok")
const FRAGMENTS = [
    [/Best for everyday, complex tasks/gi, 'Melhor para o dia a dia e tarefas complexas'],
    [/For complex work and everyday tasks/gi, 'Para trabalho complexo e o dia a dia'],
    [/Most capable for your hardest and longest-running tasks/gi, 'O mais capaz, para as tarefas mais difíceis e longas'],
    [/For your toughest challenges/gi, 'Para os desafios mais difíceis'],
    [/Most efficient for simpler tasks/gi, 'O mais econômico, para tarefas simples'],
    [/Efficient for routine tasks/gi, 'Eficiente para tarefas de rotina'],
    [/Fastest for quick answers/gi, 'O mais rápido, para respostas curtas'],
    [/Fast and affordable model for easier tasks\.?/gi, 'Rápido e barato, para tarefas mais fáceis'],
    [/Older balanced model for straightforward work\.?/gi, 'Modelo anterior e equilibrado, para trabalho direto'],
    [/Older fast and efficient model\.?/gi, 'Modelo anterior, rápido e eficiente'],
    [/\bper Mtok\b/gi, 'por milhão de tokens'],
    [/\busage vs\b/gi, 'de uso em relação ao'],
];

const lookup = (map, text) => {
    const hit = map[String(text ?? '').trim().toLowerCase()];
    return hit === undefined ? null : hit;
};

const translateName = name => lookup(NAMES, name) ?? String(name ?? '').replace(/ Free$/, ' (grátis)');

function translateDescription(text) {
    if (!text) return text || '';
    const exact = lookup(DESCRIPTIONS, text);
    if (exact !== null) return exact;
    return FRAGMENTS.reduce((t, [re, to]) => t.replace(re, to), String(text));
}

/** Uma opção normalizada (normalizeConfigOptions): traduz o que aparece, nunca id nem valor. */
function translateOption(option) {
    return {
        ...option,
        name: translateName(option.name),
        description: translateDescription(option.description),
        options: (option.options || []).map(o => ({ ...o, name: translateName(o.name), description: translateDescription(o.description) })),
    };
}

const translateMode = mode => ({ ...mode, name: translateName(mode.name), description: translateDescription(mode.description) });

/** Capacidades guardadas antes desta versão também aparecem traduzidas (repetir não muda nada). */
function translateCapabilities(caps) {
    if (!caps || typeof caps !== 'object') return caps;
    return {
        ...caps,
        ...(Array.isArray(caps.configOptions) ? { configOptions: caps.configOptions.map(translateOption) } : {}),
        ...(Array.isArray(caps.modeList) ? { modeList: caps.modeList.map(translateMode) } : {}),
    };
}

module.exports = { translateName, translateDescription, translateOption, translateMode, translateCapabilities };
