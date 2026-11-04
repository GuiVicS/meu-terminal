/**
 * locateFile.js
 * O agente costuma citar só o nome ou um caminho relativo a outra pasta ("index.html"), e o arquivo
 * está numa subpasta. Antes de dizer que não existe, procura a partir da pasta da conversa.
 */
const IGNORED = /(^|\/)(node_modules|\.git|\.cache|\.npm|dist-ssr)(\/|$)/;
const MAX_CHOICES = 6;

const baseName = path => path.split('/').pop();
const decoded = path => {
    try { return decodeURIComponent(path); } catch { return path; }
};
const isAbsolute = path => path.startsWith('/') || path.startsWith('~');
const relativePart = path => path.replace(/^(\.{0,2}\/)+/, '');

/**
 * @param {string} path - como o agente escreveu
 * @param {object} deps
 * @param {string} deps.cwd - pasta da conversa
 * @param {(full: string) => Promise<boolean>} deps.exists
 * @param {(name: string) => Promise<Array<{path: string, name: string, type: string}>>} deps.search
 * @returns {Promise<{status: 'found', path: string}|{status: 'choose', paths: string[]}|{status: 'missing', name: string}>}
 */
export async function locateFile(path, { cwd, exists, search }) {
    const norm = String(path).replace(/\\/g, '/');
    const full = p => (isAbsolute(p) ? p : `${String(cwd || '').replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`);
    for (const attempt of new Set([norm, decoded(norm)])) {
        if (await exists(full(attempt))) return { status: 'found', path: full(attempt) };
    }
    const wanted = decoded(norm);
    const name = baseName(wanted);
    let results = [];
    try {
        results = await search(name);
    } catch { /* sem a busca, fica o aviso */ }
    const matches = results
        .filter(r => r.type !== 'dir' && r.name === name && !IGNORED.test(r.path))
        .map(r => r.path);
    if (!matches.length) return { status: 'missing', name };
    // Caminho completo que não existe: o parecido pode ser outro arquivo, então quem decide é você
    if (isAbsolute(wanted)) return { status: 'choose', paths: matches.slice(0, MAX_CHOICES) };
    const suffix = `/${relativePart(wanted)}`;
    const exact = matches.filter(p => p.endsWith(suffix));
    const best = exact.length ? exact : matches;
    if (best.length === 1) return { status: 'found', path: best[0] };
    return { status: 'choose', paths: best.slice(0, MAX_CHOICES) };
}
