/**
 * pathInput.js
 * Caminho colado de qualquer lugar: com aspas, como file:// ou com espaço sobrando no fim.
 */
export function cleanPath(text) {
    let path = String(text ?? '').trim().replace(/^(['"`])(.*)\1$/s, '$2').trim();
    if (/^file:\/\//i.test(path)) {
        path = path.replace(/^file:\/\/(localhost)?/i, '');
        try { path = decodeURIComponent(path); } catch { /* fica como veio */ }
    }
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Texto colado fora de um campo: só vira navegação se for claramente um caminho. */
export function looksLikePath(text) {
    const path = cleanPath(text);
    return path.length < 4096 && !/[\r\n]/.test(path) && /^(\/|~(\/|$))/.test(path);
}
