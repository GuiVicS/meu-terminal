/**
 * opencode-login.js
 * O login do OpenCode instalado no servidor ("opencode auth login"), para conectar no OmniRoute sem
 * chave de API, como a conta do Codex. Só lê: quem renova o token é o próprio OpenCode (renovar por
 * fora poderia invalidar o login dele). O token nunca sai daqui para a tela.
 * As versões novas guardam no banco (credential); as antigas, em auth.json.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** @returns {{ access: string, expires: number|null }|null} */
function readOpenCodeLogin(home) {
    const dir = path.join(home, '.local', 'share', 'opencode');
    const db = path.join(dir, 'opencode.db');
    if (fs.existsSync(db)) {
        let handle = null;
        try {
            const { DatabaseSync } = require('node:sqlite');
            handle = new DatabaseSync(db, { readOnly: true });
            const row = handle.prepare("SELECT value FROM credential WHERE integration_id = 'opencode' AND active = 1 LIMIT 1").get();
            const cred = row ? JSON.parse(row.value) : null;
            if (cred?.access) return { access: cred.access, expires: cred.expires || null };
        } catch { /* banco de outra versão: tenta o auth.json */ } finally {
            try { handle?.close(); } catch { /* já fechado */ }
        }
    }
    try {
        const cred = JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')).opencode;
        if (cred?.access) return { access: cred.access, expires: cred.expires || null };
    } catch { /* sem login */ }
    return null;
}

/** Modelos que o OpenCode instalado oferece ("opencode models opencode"): ids sem o prefixo. */
function listOpenCodeModels({ env = process.env, execImpl = execFile } = {}) {
    return new Promise(resolve => {
        execImpl('opencode', ['models', 'opencode'], { env, timeout: 30000, maxBuffer: 1 << 20 }, (err, stdout) => {
            if (err) return resolve(null);
            const ids = String(stdout).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
                .map(l => l.trim()).filter(l => l.startsWith('opencode/')).map(l => l.slice('opencode/'.length));
            resolve(ids.length ? ids : null);
        });
    });
}

module.exports = { readOpenCodeLogin, listOpenCodeModels };
