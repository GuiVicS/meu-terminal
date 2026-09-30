/**
 * vibe.js
 * "Vibecoding" mode: a project form (name, type, what to build...) that sets up the
 * workspace for building with an AI agent:
 *   - split view: the agent's terminal + a live preview browser (reloads on save)
 *   - a separate "Arquivos" tab at the project folder
 * Started from the app menu (opens a new terminal running the agent) or by an agent via
 * MCP (the form appears on the user's screen; the agent waits for the answers).
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

/** Project types: preview behaviour and what to tell the agent. */
const KINDS = {
    static: {
        label: 'Site (HTML, CSS e JS)',
        live: true,
        hint: 'Use HTML, CSS e JavaScript puros, com index.html na raiz da pasta. A pré-visualização ao lado '
            + 'já está aberta e recarrega sozinha a cada arquivo salvo: não precisa de servidor.',
    },
    vite: {
        label: 'React + Vite',
        port: 5173,
        hint: 'Crie com Vite + React (npm create vite@latest . -- --template react, depois npm install) e rode '
            + 'npm run dev -- --host 127.0.0.1 --port 5173. A aba ao lado abre sozinha quando o servidor subir.',
    },
    next: {
        label: 'Next.js',
        port: 3000,
        hint: 'Crie com Next.js (npx create-next-app@latest . --yes) e rode npm run dev -- -p 3000. '
            + 'A aba ao lado abre sozinha quando o servidor subir.',
    },
    api: {
        label: 'API Node.js',
        port: 3000,
        hint: 'Crie uma API Node.js que escute em 127.0.0.1:3000. A aba ao lado abre a rota / quando o servidor subir.',
    },
    other: {
        label: 'Outro',
        live: true,
        hint: 'Escolha a melhor stack para o pedido. Se tiver servidor de desenvolvimento, use a ferramenta '
            + 'navigate do MCP meuterminal para abrir o endereço na aba de navegador ao lado.',
    },
};

function slugify(name) {
    return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'projeto';
}

/** Single-quoted shell string (the prompt is typed into bash). */
function shellQuote(text) {
    return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

function oneLine(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
}

class Vibe {
    /**
     * @param {object} deps
     * @param {import('./session-manager')} deps.sessions
     * @param {import('./session-store')} deps.store
     * @param {import('./live-server').LiveServers} deps.live
     * @param {Function} deps.setLiveReload - (tabId, folder|null) => Promise
     * @param {string} deps.home
     * @param {Function} [deps.log]
     */
    constructor({ sessions, store, live, setLiveReload, home, log = () => {} }) {
        this.sessions = sessions;
        this.store = store;
        this.live = live;
        this.setLiveReload = setLiveReload;
        this.home = home;
        this.log = log;
        this.pending = new Map(); // requestId -> { resolve, reject, timer }
    }

    kinds() {
        return Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, port: k.port || null }));
    }

    defaults(partial = {}) {
        const name = oneLine(partial.name || partial.project_name || '');
        return {
            name,
            path: partial.path || (name ? `~/projetos/${slugify(name)}` : ''),
            kind: KINDS[partial.kind] ? partial.kind : 'static',
            description: String(partial.description || '').slice(0, 4000),
            agent: partial.agent || 'claude',
            git: partial.git !== false,
        };
    }

    /** Checks and normalizes form answers. Throws with a user-facing message. */
    clean(answers) {
        const name = oneLine(answers.name).slice(0, 80);
        if (!name) throw new Error('Dê um nome ao projeto.');
        const kind = KINDS[answers.kind] ? answers.kind : 'static';
        const raw = oneLine(answers.path) || `~/projetos/${slugify(name)}`;
        if (raw.length > 1024 || raw.includes('\0')) throw new Error('Pasta inválida.');
        const folder = path.resolve(this.home, raw.replace(/^~(?=$|[\\/])/, this.home));
        const agent = ['claude', 'codex', 'none'].includes(answers.agent) ? answers.agent : 'claude';
        return {
            name, kind, folder, agent,
            description: String(answers.description || '').trim().slice(0, 4000),
            git: answers.git !== false && answers.git !== 'false',
        };
    }

    /** Prompt given to the agent (one line, typed into the shell). */
    prompt(p) {
        const k = KINDS[p.kind];
        return oneLine(`Modo vibecoding do MeuTerminal. Projeto: "${p.name}". Tipo: ${k.label}. `
            + `O que o usuário quer: ${p.description || '(não descrito; pergunte antes de começar)'}. `
            + `Trabalhe na pasta ${p.folder} (você já está nela). ${k.hint} `
            + 'Use as ferramentas do MCP meuterminal para conferir o resultado (screenshot, read_page) e avise o '
            + 'usuário com notify quando terminar cada etapa. Comece planejando em poucos passos e depois implemente.');
    }

    agentCommand(p) {
        if (p.agent === 'none') return '';
        const prompt = shellQuote(this.prompt(p));
        if (p.agent === 'codex') return `codex ${prompt}\r`;
        // Registers the MeuTerminal MCP in Claude Code once, then starts it with the prompt
        return 'claude mcp get meuterminal >/dev/null 2>&1 || claude mcp add --transport http --scope user meuterminal '
            + '"$MEUTERMINAL_MCP_URL" --header "Authorization: Bearer $MEUTERMINAL_MCP_TOKEN" >/dev/null 2>&1; '
            + `claude ${prompt}\r`;
    }

    /**
     * Creates the folder and the tabs. agentTabId = the terminal already running the agent
     * (MCP flow); without it a new terminal is created and the agent is started there.
     */
    async setup(answers, { agentTabId = null } = {}) {
        const p = this.clean(answers);
        await fsp.mkdir(p.folder, { recursive: true });
        const existing = (await fsp.readdir(p.folder)).filter(n => !n.startsWith('.'));
        if (p.git) {
            try {
                await fsp.access(path.join(p.folder, '.git'));
            } catch {
                await new Promise(resolve => {
                    const child = spawn('git', ['init', '-q'], { cwd: p.folder, stdio: 'ignore' });
                    child.on('error', resolve);
                    child.on('close', resolve);
                });
            }
        }

        // Terminal: the agent's own tab, or a new one that starts the agent
        let terminalId = agentTabId;
        const agentRow = agentTabId ? this.store.get(agentTabId) : null;
        if (!agentRow || agentRow.status !== 'open' || (agentRow.kind && agentRow.kind !== 'terminal')) {
            terminalId = this.sessions.create({ kind: 'terminal', cwd: p.folder, name: p.name }).id;
            const command = this.agentCommand(p);
            if (command) this.sessions.runCommand(terminalId, command);
        }

        // Preview: live server for static sites (reload on save), waiting page for dev servers
        const k = KINDS[p.kind];
        const base = await this.live.serve(p.folder);
        const previewUrl = k.port ? `${base}?wait=${k.port}` : base;
        const browser = this.sessions.create({ kind: 'browser', url: previewUrl, name: `${p.name} · prévia`, afterId: terminalId });
        if (k.live) await this.setLiveReload(browser.id, p.folder);

        // Files: separate tab (not split), at the project folder
        const files = this.sessions.create({ kind: 'files', url: 'local', cwd: p.folder, name: `${p.name} · arquivos`, afterId: browser.id });

        // Every open window shows the split: agent terminal | preview
        this.sessions.broadcast({ type: 'split', a: terminalId, b: browser.id, focus: terminalId });
        this.log(`Vibecoding: ${p.name} at ${p.folder}`);
        return {
            project: p.name,
            kind: p.kind,
            kind_label: k.label,
            path: p.folder,
            description: p.description,
            folder_had_files: existing.length > 0,
            terminal_tab_id: terminalId,
            browser_tab_id: browser.id,
            files_tab_id: files.id,
            preview_url: base,
            dev_url: k.port ? `http://localhost:${k.port}/` : null,
            live_reload: !!k.live,
            instructions: k.hint,
        };
    }

    // ---------- form round-trip (MCP flow) ----------

    /** Shows the form on every open window and waits for the answers (or cancel). */
    ask(defaults, { timeoutMs = 15 * 60 * 1000 } = {}) {
        if (!this.sessions.sockets.size) {
            return Promise.reject(new Error('O MeuTerminal não está aberto em nenhum aparelho: abra o app para preencher o formulário.'));
        }
        const requestId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                this.sessions.broadcast({ type: 'vibe-form-close', requestId });
                reject(new Error('O formulário ficou sem resposta por 15 minutos.'));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });
            this.sessions.broadcast({ type: 'vibe-form', requestId, defaults: this.defaults(defaults), fromAgent: true });
        });
    }

    /** Answer from the app. Returns false when the request no longer exists. */
    answer(requestId, data) {
        const entry = this.pending.get(requestId);
        if (!entry) return false;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        // The form closes on the other devices too
        this.sessions.broadcast({ type: 'vibe-form-close', requestId });
        entry.resolve(data);
        return true;
    }
}

module.exports = { Vibe, KINDS, slugify };
