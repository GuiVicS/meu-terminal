/**
 * claude-accounts.js
 * Contas extras do Claude Code no mesmo servidor, para a troca automática quando o limite de uma
 * acaba. Cada conta é uma pasta de configuração própria (CLAUDE_CONFIG_DIR) que só tem de seu o
 * login (.credentials.json) e o .claude.json (conta, preferências); o resto (conversas, plugins,
 * skills, configurações) aponta para o ~/.claude principal. Assim uma conversa troca de conta e
 * continua a mesma. A conta principal é o ~/.claude de sempre (id null).
 * O login é feito pelo próprio Claude Code ("claude auth login") num terminal do MeuTerminal: a
 * senha e o token nunca passam por aqui.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
// O que fica separado por conta: o login e o arquivo da conta
const OWN = new Set(['.credentials.json', '.claude.json']);

class ClaudeAccounts {
    /**
     * @param {object} opts
     * @param {string} opts.home
     * @param {object} opts.env - ambiente para rodar "claude auth status"
     * @param {Function} [opts.execImpl]
     */
    constructor({ home, env = process.env, execImpl = execFile }) {
        this.home = home;
        this.baseEnv = env;
        this.exec = execImpl;
        this.root = path.join(home, '.meuterminal-contas', 'claude');
        this.main = path.join(home, '.claude');
    }

    dirOf(id) {
        if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('Conta inválida.'), { status: 400 });
        return path.join(this.root, id);
    }

    /** ids das contas extras criadas. */
    ids() {
        try {
            return fs.readdirSync(this.root).filter(n => ID_RE.test(n) && fs.statSync(path.join(this.root, n)).isDirectory());
        } catch {
            return [];
        }
    }

    /** Liga na pasta da conta tudo do ~/.claude principal, menos o que é da conta. Idempotente. */
    link(id) {
        const dir = this.dirOf(id);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(this.main, { recursive: true });
        for (const name of fs.readdirSync(this.main)) {
            if (OWN.has(name)) continue;
            const target = path.join(dir, name);
            try { fs.lstatSync(target); continue; } catch { /* ainda não existe */ }
            fs.symlinkSync(path.join(this.main, name), target);
        }
        // Pastas que o Claude Code cria depois: já nascem compartilhadas
        for (const name of ['projects', 'plugins', 'skills', 'agents', 'commands', 'todos', 'settings.json']) {
            const src = path.join(this.main, name);
            const target = path.join(dir, name);
            if (fs.existsSync(target) || fs.existsSync(src)) continue;
            if (name.endsWith('.json')) fs.writeFileSync(src, '{}\n');
            else fs.mkdirSync(src, { recursive: true });
            fs.symlinkSync(src, target);
        }
        return dir;
    }

    /** Cria a pasta da conta (sem login ainda). @returns {string} id */
    create(name) {
        const base = String(name || 'conta').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'conta';
        let id = base;
        for (let i = 2; this.ids().includes(id); i++) id = `${base}-${i}`;
        this.link(id);
        return id;
    }

    /** Apaga a pasta da conta (só a dela: os links apontam para o principal e não são seguidos). */
    remove(id) {
        const dir = this.dirOf(id);
        if (!fs.existsSync(dir)) return false;
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
    }

    /** Ambiente que faz o Claude Code usar a conta (null = principal). */
    env(id) {
        return id ? { CLAUDE_CONFIG_DIR: this.link(id) } : {};
    }

    /** Comando para o login da conta, digitado num terminal do MeuTerminal. */
    loginCommand(id) {
        return `CLAUDE_CONFIG_DIR=${JSON.stringify(this.link(id))} claude auth login\r`;
    }

    /** Situação da conta pelo próprio Claude Code: logada?, e-mail, plano. Nada secreto. */
    status(id) {
        return new Promise(resolve => {
            const env = { ...this.baseEnv, ...(id ? { CLAUDE_CONFIG_DIR: this.dirOf(id) } : {}) };
            this.exec('claude', ['auth', 'status', '--json'], { env, timeout: 20000 }, (err, stdout) => {
                try {
                    const j = JSON.parse(stdout);
                    resolve({ loggedIn: !!j.loggedIn, email: j.email || null, plan: j.subscriptionType || null });
                } catch {
                    resolve({ loggedIn: false, email: null, plan: null });
                }
            });
        });
    }
}

module.exports = { ClaudeAccounts };
