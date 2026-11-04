/**
 * permissionDoc.js
 * Plano ou documento novo pedindo aprovação: é lido já formatado, não como código em verde.
 * Editar um documento que já existe continua mostrando o que muda (diff).
 * E o título não repete o comando, que já aparece inteiro logo abaixo.
 */
const MARKDOWN = /\.(md|markdown)$/i;
const nameOf = path => String(path).split(/[\\/]/).pop();

/**
 * @param {{ input?: object, diffs?: Array<{path?: string, oldText?: string|null, newText?: string}> }} d
 * @returns {{ text: string, name: string }|null}
 */
export function permissionDocument(d) {
    const input = d.input || {};
    if (typeof input.plan === 'string' && input.plan.trim()) return { text: input.plan, name: 'Plano' };
    const created = (d.diffs || []).find(x => MARKDOWN.test(x.path || '') && !x.oldText && x.newText);
    if (created) return { text: created.newText, name: nameOf(created.path) };
    const path = input.file_path || input.path;
    if (!d.diffs?.length && MARKDOWN.test(path || '') && typeof input.content === 'string' && input.content.trim()) {
        return { text: input.content, name: nameOf(path) };
    }
    return null;
}

const oneLine = text => String(text ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();

/** Título do pedido: quando é só o próprio comando, vira um nome curto. */
export function permissionTitle(d) {
    const command = oneLine(d.input?.command);
    const title = oneLine(d.title).replace(/(\.{3}|…)$/, '').trim();
    if (command && title && (title === command || (title.length >= 8 && command.startsWith(title)))) return 'Executar comando';
    return d.title;
}
