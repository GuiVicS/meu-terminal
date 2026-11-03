/**
 * agent-accounts.js
 * Mais de uma conta para cada agente, além do Claude Code (claude-accounts.js). Cada ferramenta
 * guarda o login de um jeito, então cada uma diz:
 *  - env: a variável que aponta a ferramenta para a pasta da conta;
 *  - status: quem está logado (só lê; nada secreto sai daqui);
 *  - loginCommand: o login é sempre o da própria ferramenta, num terminal do MeuTerminal;
 *  - shared: a conversa continua ao trocar de conta? Se não, a conta vale para conversas novas.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

class FolderAccounts {
    constructor({ agent, home }) {
        this.agent = agent;
        this.home = home;
        this.root = path.join(home, '.meuterminal-contas', agent);
    }

    dirOf(id) {
        if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('Conta inválida.'), { status: 400 });
        return path.join(this.root, id);
    }

    ids() {
        try {
            return fs.readdirSync(this.root).filter(n => ID_RE.test(n) && fs.statSync(path.join(this.root, n)).isDirectory());
        } catch {
            return [];
        }
    }

    /** Prepara a pasta da conta (idempotente). */
    link(id) {
        const dir = this.dirOf(id);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        return dir;
    }

    /** Liga em `dir` tudo de `from`, menos o que é só da conta. */
    linkAll(dir, from, own) {
        let names = [];
        try { names = fs.readdirSync(from); } catch { /* ainda não existe */ }
        for (const name of names) {
            if (own.has(name)) continue;
            const target = path.join(dir, name);
            try { fs.lstatSync(target); } catch { fs.symlinkSync(path.join(from, name), target); }
        }
    }

    create(name) {
        const base = String(name || 'conta').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'conta';
        let id = base;
        for (let i = 2; this.ids().includes(id); i++) id = `${base}-${i}`;
        this.link(id);
        return id;
    }

    remove(id) {
        const dir = this.dirOf(id);
        if (!fs.existsSync(dir)) return false;
        fs.rmSync(dir, { recursive: true, force: true }); // links não são seguidos
        return true;
    }
}

/** Codex: CODEX_HOME. Só o login é da conta; as conversas são as mesmas. */
class CodexAccounts extends FolderAccounts {
    shared = true;

    constructor({ home }) {
        super({ agent: 'codex', home });
        this.main = path.join(home, '.codex');
    }

    link(id) {
        const dir = super.link(id);
        this.linkAll(dir, this.main, new Set(['auth.json', 'auth.lock']));
        return dir;
    }

    env(id) { return id ? { CODEX_HOME: this.link(id) } : {}; }

    loginCommand(id) {
        return `${id ? `CODEX_HOME=${JSON.stringify(this.link(id))} ` : ''}codex login --device-auth\r`;
    }

    async status(id) {
        try {
            const auth = JSON.parse(fs.readFileSync(path.join(id ? this.dirOf(id) : this.main, 'auth.json'), 'utf8'));
            const token = auth.tokens?.id_token;
            if (token) {
                const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
                return { loggedIn: true, email: claims.email || null, plan: claims['https://api.openai.com/auth']?.chatgpt_plan_type || null };
            }
            return { loggedIn: !!auth.OPENAI_API_KEY, email: null, plan: null };
        } catch {
            return { loggedIn: false, email: null, plan: null };
        }
    }
}

/** OpenCode: o login fica no mesmo banco das conversas, então cada conta tem as suas (XDG_DATA_HOME). */
class OpenCodeAccounts extends FolderAccounts {
    shared = false;

    constructor({ home }) {
        super({ agent: 'opencode', home });
        this.main = path.join(home, '.local', 'share');
    }

    env(id) { return id ? { XDG_DATA_HOME: this.link(id) } : {}; }

    loginCommand(id) {
        return `${id ? `XDG_DATA_HOME=${JSON.stringify(this.link(id))} ` : ''}opencode auth login\r`;
    }

    async status(id) {
        const dir = path.join(id ? this.dirOf(id) : this.main, 'opencode');
        let loggedIn = false;
        let email = null;
        try {
            loggedIn = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8'))).length > 0;
        } catch { /* sem o arquivo */ }
        let db = null;
        try {
            const { DatabaseSync } = require('node:sqlite');
            db = new DatabaseSync(path.join(dir, 'opencode.db'), { readOnly: true });
            loggedIn ||= db.prepare('SELECT COUNT(*) AS n FROM credential WHERE active = 1').get().n > 0;
            email = db.prepare('SELECT email FROM account LIMIT 1').get()?.email || null;
        } catch { /* banco ainda não existe ou de outra versão */ } finally {
            db?.close();
        }
        return { loggedIn, email, plan: null };
    }
}

/** Antigravity: guarda tudo em ~/.gemini, sem variável própria. A conta é uma HOME em que só isso muda. */
class AgyAccounts extends FolderAccounts {
    shared = false;

    constructor({ home, env = process.env, execImpl = execFile, command = 'agy' }) {
        super({ agent: 'agy', home });
        this.baseEnv = env;
        this.exec = execImpl;
        this.command = command;
    }

    link(id) {
        const dir = super.link(id);
        this.linkAll(dir, this.home, new Set(['.gemini', '.meuterminal-contas']));
        return dir;
    }

    env(id) { return id ? { HOME: this.link(id) } : {}; }

    loginCommand(id) {
        return `${id ? `HOME=${JSON.stringify(this.link(id))} ` : ''}${this.command}\r`;
    }

    /** O agy não tem "status": listar os modelos pede login quando não há um. */
    status(id) {
        return new Promise(resolve => {
            const env = { ...this.baseEnv, ...this.env(id || null) };
            this.exec(this.command, ['models'], { env, timeout: 25000 }, (err, stdout = '', stderr = '') => {
                resolve({ loggedIn: !err && !/sign in/i.test(`${stdout}${stderr}`), email: null, plan: null });
            });
        });
    }
}

module.exports = { CodexAccounts, OpenCodeAccounts, AgyAccounts };
