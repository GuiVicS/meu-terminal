/**
 * history.js
 * Abrir uma conversa sem mandar tudo: ela chega já pelo fim, em blocos de turnos (um turno começa em
 * cada mensagem do usuário), e o que é anterior vem conforme a pessoa sobe. Só funções puras: quem
 * lê do SQL ou do arquivo é o servidor.
 */
const FIRST_PAGE = 4;
const OLDER_PAGE = 6;

// Só mudam o estado da tela; nenhum aparece na conversa. Vale o último de cada tipo
const STATE_ONLY = /^(status|usage\.update|commands\.update|config\.update|mode\.update|queue\.update|session\.info)$/;
const CONVERSATION = /^(message\.|tool\.|thought\.|plan\.|permission\.|subagent\.)/;

/**
 * Que pedaço entregar. `starts` são as posições (seq ou índice) de cada mensagem do usuário, em ordem;
 * `before` é quantas já foram entregues a partir do começo (null = primeira abertura).
 * @returns {{ from: number|null, to: number|null, firstTurn: number }} from null = desde o início; to null = até o fim
 */
function turnRange(starts, before = null, size = before === null ? FIRST_PAGE : OLDER_PAGE) {
    const total = starts.length;
    const end = before === null ? total : Math.min(Math.max(0, before), total);
    const firstTurn = Math.max(0, end - size);
    return {
        from: firstTurn === 0 ? null : starts[firstTurn],
        to: before === null || end >= total ? null : starts[end],
        firstTurn,
    };
}

/** Junta o que dá para juntar: milhares de pedacinhos de texto viram um só. Não altera os originais. */
function compactEvents(events, { keepState = true } = {}) {
    const lastState = new Map();
    if (keepState) for (const e of events) if (STATE_ONLY.test(e.type)) lastState.set(e.type, e);
    const out = [];
    for (const e of events) {
        if (STATE_ONLY.test(e.type)) {
            if (lastState.get(e.type) === e) out.push(e);
            continue;
        }
        const prev = out[out.length - 1];
        const d = e.data || {};
        if (prev && prev.type === e.type) {
            if ((e.type === 'message.assistant.delta' || e.type === 'thought.delta') && !d.media?.length && !prev.data.media?.length) {
                out[out.length - 1] = { ...prev, seq: e.seq, data: { ...prev.data, text: (prev.data.text || '') + (d.text || '') } };
                continue;
            }
            if (e.type === 'tool.update' && prev.data.toolId === d.toolId) {
                const merged = { ...prev.data };
                for (const [k, v] of Object.entries(d)) {
                    if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length && merged[k]?.length)) merged[k] = v;
                }
                out[out.length - 1] = { ...prev, seq: e.seq, data: merged };
                continue;
            }
        }
        out.push(e);
    }
    return out;
}

/** O que o painel lateral precisa da conversa inteira (arquivos, subagentes, plano, uso, comandos), sem o resto. */
function sideSummary(events) {
    const out = [];
    let plan = null;
    let commands = null;
    let usage = null;
    for (const e of events) {
        const d = e.data || {};
        if (e.type === 'plan.update') plan = e;
        else if (e.type === 'commands.update') commands = e;
        else if (e.type === 'usage.update') usage = { type: e.type, data: { ...usage?.data, ...d } };
        else if (e.type.startsWith('subagent.')) out.push(e);
        else if ((e.type === 'tool.start' || e.type === 'tool.result') && (d.diffs?.length || d.parentToolId)) {
            out.push({ type: e.type, data: { toolId: d.toolId, parentToolId: d.parentToolId, diffs: d.diffs } });
        }
    }
    return out.concat([plan, commands, usage].filter(Boolean));
}

module.exports = { turnRange, compactEvents, sideSummary, STATE_ONLY, CONVERSATION, FIRST_PAGE, OLDER_PAGE };
