/**
 * history-files.js
 * Apagar uma conversa da lista lateral do Modo UI. O ACP não tem "apagar sessão", então o
 * arquivo da conversa de cada agente é movido para uma lixeira (~/.meuterminal-lixeira/<agente>/),
 * de onde dá para recuperar. Agentes cujo histórico não é um arquivo por conversa (OpenCode guarda
 * num SQLite) ficam sem a opção.
 */
const fs = require('fs');
const path = require('path');

const ID_RE = /^[\w-]{6,80}$/;

/** Onde cada agente guarda uma conversa: devolve o caminho do arquivo ou null. */
const FINDERS = {
    // ~/.claude/projects/<pasta>/<id>.jsonl
    claude(home, id) {
        const root = path.join(home, '.claude', 'projects');
        let dirs = [];
        try { dirs = fs.readdirSync(root); } catch { return null; }
        for (const d of dirs) {
            const f = path.join(root, d, `${id}.jsonl`);
            if (fs.existsSync(f)) return f;
        }
        return null;
    },
    // ~/.codex/sessions/AAAA/MM/DD/rollout-<data>-<id>.jsonl
    codex(home, id) {
        const root = path.join(home, '.codex', 'sessions');
        const walk = (dir, depth) => {
            let entries = [];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
            for (const e of entries) {
                const p = path.join(dir, e.name);
                if (e.isDirectory() && depth < 4) {
                    const found = walk(p, depth + 1);
                    if (found) return found;
                } else if (e.isFile() && e.name.endsWith(`${id}.jsonl`)) {
                    return p;
                }
            }
            return null;
        };
        return walk(root, 0);
    },
};

const canDelete = agent => !!FINDERS[agent];

/** Primeiras linhas (JSON) do arquivo da conversa. */
function firstLines(file, max = 65536) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(max);
        const n = fs.readSync(fd, buf, 0, max, 0);
        return buf.subarray(0, n).toString('utf8').split('\n').slice(0, -1)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * A conversa foi aberta pela pessoa no terminal? Na dúvida, não: o que o agente dispara sozinho
 * (subagentes, "claude -p", plugins) não pode aparecer na lista.
 *  - Claude Code: entrypoint "cli" (a sessão interativa); o resto é "sdk-*".
 *  - Codex: origem "codex-tui", fora de subagente.
 */
function startedInTerminal(agent, id, home) {
    try {
        const file = typeof id === 'string' && ID_RE.test(id) && FINDERS[agent] ? FINDERS[agent](home, id) : null;
        if (!file) return false;
        const lines = firstLines(file);
        if (agent === 'claude') return lines.find(l => l.entrypoint)?.entrypoint === 'cli';
        if (agent === 'codex') {
            const meta = lines.find(l => l.payload?.originator)?.payload;
            return meta?.originator === 'codex-tui' && typeof meta.source === 'string';
        }
    } catch { /* sem o arquivo: não é */ }
    return false;
}

/**
 * Move a conversa para a lixeira. @returns {{ ok: true, trashed: string }}
 * @throws {Error & { status: number }}
 */
function deleteConversation(agent, id, home) {
    const fail = (msg, status) => Object.assign(new Error(msg), { status });
    if (!canDelete(agent)) throw fail('Este agente não permite apagar conversas por aqui.', 501);
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('Conversa inválida.', 400);
    const file = FINDERS[agent](home, id);
    if (!file) throw fail('Conversa não encontrada.', 404);
    const trash = path.join(home, '.meuterminal-lixeira', agent);
    fs.mkdirSync(trash, { recursive: true });
    const dest = path.join(trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${path.basename(file)}`);
    fs.renameSync(file, dest);
    return { ok: true, trashed: dest };
}

module.exports = { deleteConversation, canDelete, startedInTerminal };
