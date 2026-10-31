/**
 * remote/risk.js
 * Which commands from the Claude bridge need the user's OK before running. Same list the
 * agent chat uses to warn about permission requests (public/agent/risk.js, an ES module shared
 * with the browser), plus a few patterns that only matter for commands sent from outside.
 */
const path = require('path');
const { pathToFileURL } = require('url');

const EXTRA_RISKS = [
    [/(^|[\s/'"])(\.env\b|\.ssh\/|id_rsa|id_ed25519|\.aws\/|\.config\/rclone\/|\.git-credentials|\.netrc)/, 'lê ou altera credenciais'],
    [/\bdocker\s+(rm|rmi|system\s+prune|volume\s+(rm|prune)|compose\s+down)\b/, 'remove contêineres, imagens ou volumes'],
    [/\bcrontab\s+-r\b/, 'apaga o crontab'],
    [/\b(systemctl|service)\s+\S*\s*(stop|disable|mask)\b/, 'para um serviço do sistema'],
    [/\b(useradd|userdel|passwd|chpasswd|usermod)\b/, 'mexe em usuários do sistema'],
    [/\b(iptables|ufw|nft)\b/, 'mexe no firewall'],
    [/\brclone\s+(delete|purge|sync)\b/, 'apaga ou sincroniza (pode apagar) arquivos na nuvem'],
    [/\b(npm|pnpm|yarn)\s+publish\b/, 'publica um pacote'],
];

let shared = null;
function loadShared() {
    shared ??= import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'agent', 'risk.js')).href);
    return shared;
}

/** Human reasons why `command` is dangerous ([] = nothing special). */
async function assessCommand(command) {
    const text = String(command || '');
    const { assessRisk } = await loadShared();
    const reasons = assessRisk({ kind: 'execute', input: { command: text } }, '');
    for (const [pattern, reason] of EXTRA_RISKS) if (pattern.test(text)) reasons.push(reason);
    return [...new Set(reasons)];
}

module.exports = { assessCommand };
