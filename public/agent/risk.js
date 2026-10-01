/**
 * risk.js
 * Flags dangerous agent actions in permission requests (rm -rf, sudo, curl | sh, force push,
 * writes outside the project...) so the permission sheet can warn before approving.
 */

const COMMAND_RISKS = [
    [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, 'apaga arquivos de forma recursiva/forçada'],
    [/\bsudo\b/, 'executa como administrador (sudo)'],
    [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'baixa e executa um script da internet'],
    [/\bgit\s+push\b.*(--force|-f\b)/, 'git push forçado (reescreve o histórico remoto)'],
    [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, 'descarta alterações do git'],
    [/\bchmod\s+(-R\s+)?777\b/, 'libera permissão total (chmod 777)'],
    [/\b(mkfs|fdisk|dd\s+if=)/, 'mexe em disco/partição'],
    [/>\s*\/dev\/sd[a-z]/, 'escreve direto num disco'],
    [/\b(drop|truncate)\s+(table|database)\b/i, 'apaga dados do banco'],
    [/\b(shutdown|reboot|poweroff)\b/, 'desliga/reinicia a máquina'],
    [/\bkill\s+-9\s+(-1|1)\b/, 'mata todos os processos'],
    [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork bomb'],
];

function insideFolder(file, folder) {
    if (!file || !folder) return true;
    const norm = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const f = norm(file);
    const d = norm(folder);
    // Relative paths are resolved by the agent inside its cwd
    if (!/^([a-z]:)?\//.test(f)) return !f.startsWith('..');
    return f === d || f.startsWith(`${d}/`);
}

/**
 * @param {object} request - permission.request data (title, kind, input, diffs, locations)
 * @param {string} cwd - the session's project folder
 * @returns {string[]} human reasons (empty = nothing special)
 */
export function assessRisk(request, cwd) {
    const reasons = [];
    const command = request.input && (request.input.command || request.input.cmd);
    if (typeof command === 'string') {
        for (const [pattern, reason] of COMMAND_RISKS) {
            if (pattern.test(command)) reasons.push(reason);
        }
    }
    const paths = [
        ...(request.diffs || []).map(d => d.path),
        ...(request.locations || []).map(l => l.path),
        request.input && (request.input.file_path || request.input.path),
    ].filter(p => typeof p === 'string');
    if ((request.kind === 'edit' || request.kind === 'write') && paths.some(p => !insideFolder(p, cwd))) {
        reasons.push('altera arquivos fora da pasta do projeto');
    }
    if (paths.some(p => /(^|\/)(\.env|\.ssh\/|id_rsa|\.aws\/|\.git\/config)/.test(p.replace(/\\/g, '/')))) {
        reasons.push('mexe em credenciais ou configuração sensível');
    }
    return [...new Set(reasons)];
}

// ---------- secrets ----------

const MASK = value => `${value.slice(0, 4)}…••••••`;

const SECRET_PATTERNS = [
    // PEM private keys: the whole body goes
    [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, (m, a, b) => `${a}\n••••••\n${b}`],
    // Known token formats (OpenAI/Anthropic, GitHub, AWS, Slack, Google, JWT)
    [/\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,})\b/g, m => MASK(m)],
    // Authorization: Bearer <token>
    [/(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/gi, (m, a, v) => a + MASK(v)],
    // NAME_KEY=value / "password": "value" / token: value
    [/((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth)[A-Za-z0-9_]*["']?\s*[=:]\s*["']?)([^\s"'&,;]{6,})/gi, (m, a, v) => a + MASK(v)],
    // https://user:password@host
    [/(\/\/[^/\s:@]+:)([^/\s@]{3,})(@)/g, (m, a, v, b) => `${a}••••••${b}`],
];

/**
 * Hides secrets (API keys, tokens, passwords, private keys) in commands and outputs shown
 * in the agent UI: screens get shared and photographed. Keeps the first characters so the
 * user still recognizes which key it is.
 * @param {string} text
 */
export function maskSecrets(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const [pattern, replace] of SECRET_PATTERNS) out = out.replace(pattern, replace);
    return out;
}
