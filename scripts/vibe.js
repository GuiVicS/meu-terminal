/**
 * vibe.js
 * "Vibecoding" mode: a project form (name, type, what to build...) that sets up the
 * workspace for building with an AI agent:
 *   - split view: the agent's UI tab (chat, tools, diffs - never a typed shell command) + a
 *     live preview browser (reloads on save)
 *   - a separate "Arquivos" tab at the project folder
 * Started from the app menu (opens the agent UI) or by an agent already working in a terminal
 * via MCP (the form appears on the user's screen; that agent keeps using its own terminal -
 * it is already mid-conversation there, so it cannot be switched to the UI mid-flight).
 *
 * Every project is persisted (vibe-store.js): "Abrir projeto anterior" lists them, and
 * switching agents on an open project reuses or creates that agent's own UI tab, so each
 * agent keeps its own conversation for the same project. This agent switcher is specific to
 * vibecoding - a plain "Nova conversa com agente" tab has no project behind it to switch within.
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
     * @param {import('./agents/gateway').AgentGateway} deps.gateway - starts agents in UI mode
     * @param {(command: string) => boolean} deps.commandExists
     * @param {import('./vibe-store')} deps.vibeStore - persisted projects (previous projects, agent switcher)
     * @param {Function} [deps.log]
     */
    constructor({ sessions, store, live, setLiveReload, home, gateway, commandExists, vibeStore, log = () => {} }) {
        this.sessions = sessions;
        this.store = store;
        this.live = live;
        this.setLiveReload = setLiveReload;
        this.home = home;
        this.gateway = gateway;
        this.commandExists = commandExists;
        this.vibeStore = vibeStore;
        this.log = log;
        this.pending = new Map(); // requestId -> { resolve, reject, timer }
    }

    kinds() {
        return Object.entries(KINDS).map(([id, k]) => ({ id, label: k.label, port: k.port || null }));
    }

    /** Agents that can run vibecoding's UI mode (excludes terminal-only ones), plus "none". */
    agentOptions() {
        return this.gateway.listAgents().filter(a => !a.terminalOnly)
            .map(a => ({ id: a.id, label: a.label, installed: this.agentInstalled(a.id) }));
    }

    agentInstalled(agent) {
        const def = this.gateway.agents[agent];
        return !!def && this.commandExists(def.requires || def.command);
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
        const validAgent = answers.agent === 'none' || (this.gateway.agents[answers.agent] && !this.gateway.agents[answers.agent].terminalOnly);
        const agent = validAgent ? answers.agent : 'claude';
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

    /** Only used for the MCP flow's fallback (no live agentTabId to reuse): types the agent into a fresh terminal. */
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
     * Starts (or reuses) `agent`'s UI tab for `project`, remembering it so switching back to this
     * agent later reuses the same conversation. Throws a user-facing message if the agent isn't
     * installed. Not used for p.agent === 'none' - callers handle that as a plain terminal.
     */
    async startAgentTab(project, agent, promptText, { afterId } = {}) {
        const existing = project.agents[agent];
        if (existing?.kind === 'agent' && existing.tabId) {
            const row = this.store.get(existing.tabId);
            if (row && row.status === 'open' && row.kind === 'agent') {
                this.sessions.broadcast({ type: 'open-tab', id: existing.tabId });
                return { tabId: existing.tabId, reused: true };
            }
        }
        const def = this.gateway.agents[agent];
        if (!def || def.terminalOnly) throw new Error(`"${agent}" não suporta o modo UI.`);
        if (!this.agentInstalled(agent)) throw new Error(`${def.label} não está instalado: ${def.install}`);
        const session = await this.gateway.startSession({ agent, cwd: project.folder, title: project.name });
        const tab = this.sessions.create({ kind: 'agent', url: session.id, cwd: project.folder, name: `${project.name} · ${def.label}`, afterId });
        this.vibeStore.setAgentTab(project.id, agent, { tabId: tab.id, kind: 'agent' });
        if (promptText) this.gateway.prompt(session.id, promptText).catch(e => this.log('Vibecoding: initial prompt failed:', e.message));
        return { tabId: tab.id, reused: false };
    }

    /**
     * Creates the folder and the tabs for a brand-new project, always in the agent UI (never a
     * typed shell command) - except the MCP flow (agentTabId given): that agent is already
     * running in its own terminal mid-conversation, so it keeps using it.
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

        let project = this.vibeStore.byFolder(p.folder) || this.vibeStore.create(p);

        // Primary tab: the MCP agent's own terminal, a fresh plain terminal ("none"), or the agent UI
        let primaryId;
        if (agentTabId) {
            const agentRow = this.store.get(agentTabId);
            if (agentRow && agentRow.status === 'open' && (!agentRow.kind || agentRow.kind === 'terminal')) {
                primaryId = agentTabId;
            } else {
                primaryId = this.sessions.create({ kind: 'terminal', cwd: p.folder, name: p.name }).id;
            }
            const command = this.agentCommand(p);
            if (command) this.sessions.runCommand(primaryId, command);
            if (p.agent !== 'none') this.vibeStore.setAgentTab(project.id, p.agent, { tabId: primaryId, kind: 'terminal' });
        } else if (p.agent === 'none') {
            primaryId = this.sessions.create({ kind: 'terminal', cwd: p.folder, name: p.name }).id;
        } else {
            ({ tabId: primaryId } = await this.startAgentTab(project, p.agent, this.prompt(p)));
        }

        // Preview: live server for static sites (reload on save), waiting page for dev servers
        const k = KINDS[p.kind];
        const base = await this.live.serve(p.folder);
        const previewUrl = k.port ? `${base}?wait=${k.port}` : base;
        const browser = this.sessions.create({ kind: 'browser', url: previewUrl, name: `${p.name} · prévia`, afterId: primaryId });
        if (k.live) await this.setLiveReload(browser.id, p.folder);

        // Files: separate tab (not split), at the project folder
        const files = this.sessions.create({ kind: 'files', url: 'local', cwd: p.folder, name: `${p.name} · arquivos`, afterId: browser.id });
        this.vibeStore.setTabs(project.id, { browserTabId: browser.id, filesTabId: files.id });

        // Every open window shows the split: agent | preview
        this.sessions.broadcast({ type: 'split', a: primaryId, b: browser.id, focus: primaryId });
        this.log(`Vibecoding: ${p.name} at ${p.folder}`);
        return {
            project: p.name,
            project_id: project.id,
            kind: p.kind,
            kind_label: k.label,
            path: p.folder,
            description: p.description,
            folder_had_files: existing.length > 0,
            terminal_tab_id: primaryId,
            browser_tab_id: browser.id,
            files_tab_id: files.id,
            preview_url: base,
            dev_url: k.port ? `http://localhost:${k.port}/` : null,
            live_reload: !!k.live,
            instructions: k.hint,
        };
    }

    // ---------- previous projects + agent switcher (vibecoding only) ----------

    /** For "Abrir projeto anterior": every known project, most recently touched first. */
    list() {
        return this.vibeStore.list().map(p => ({
            id: p.id,
            name: p.name,
            folder: p.folder,
            kind: p.kind,
            kind_label: (KINDS[p.kind] || {}).label || p.kind,
            description: p.description,
            updated_at: p.updatedAt,
            agents: Object.keys(p.agents),
            last_agent: this.vibeStore.lastAgent(p.id),
        }));
    }

    /** The vibecoding project a tab belongs to (its agent tab, preview or files tab), or null. */
    projectForTab(tabId) {
        const p = this.vibeStore.byTab(tabId);
        if (!p) return null;
        return {
            id: p.id,
            name: p.name,
            agents: Object.entries(p.agents)
                .filter(([, info]) => info.kind === 'agent') // the MCP flow's terminal entry can't be "switched to"
                .map(([agent, info]) => ({ agent, tab_id: info.tabId, last_used_at: info.lastUsedAt })),
        };
    }

    /**
     * Reopens a known project: recreates the preview/files tabs if they were closed, then opens
     * (or switches to) `agent`'s UI tab - the same operation whether this is "abrir projeto
     * anterior" or "trocar agente" on an already-open project.
     */
    async openProject(id, { agent = null } = {}) {
        const project = this.vibeStore.get(id);
        if (!project) throw new Error('Projeto não encontrado.');
        const chosenAgent = agent && (agent === 'none' || this.gateway.agents[agent]) ? agent : (this.vibeStore.lastAgent(id) || 'claude');
        const k = KINDS[project.kind] || KINDS.static;

        let browserTabId = project.browserTabId && this.store.get(project.browserTabId)?.status === 'open' ? project.browserTabId : null;
        if (!browserTabId) {
            const base = await this.live.serve(project.folder);
            const previewUrl = k.port ? `${base}?wait=${k.port}` : base;
            const browser = this.sessions.create({ kind: 'browser', url: previewUrl, name: `${project.name} · prévia` });
            if (k.live) await this.setLiveReload(browser.id, project.folder);
            browserTabId = browser.id;
        }
        let filesTabId = project.filesTabId && this.store.get(project.filesTabId)?.status === 'open' ? project.filesTabId : null;
        if (!filesTabId) {
            filesTabId = this.sessions.create({ kind: 'files', url: 'local', cwd: project.folder, name: `${project.name} · arquivos`, afterId: browserTabId }).id;
        }
        this.vibeStore.setTabs(project.id, { browserTabId, filesTabId });

        let primaryId;
        if (chosenAgent === 'none') {
            primaryId = this.sessions.create({ kind: 'terminal', cwd: project.folder, name: project.name, afterId: browserTabId }).id;
        } else {
            // Only used if this agent has no tab yet for the project (startAgentTab skips it when reusing one)
            ({ tabId: primaryId } = await this.startAgentTab(project, chosenAgent, this.prompt(project), { afterId: browserTabId }));
        }

        this.sessions.broadcast({ type: 'open-tab', id: filesTabId });
        this.sessions.broadcast({ type: 'split', a: primaryId, b: browserTabId, focus: primaryId });
        this.log(`Vibecoding: reabriu ${project.name} (${chosenAgent})`);
        return { project_id: project.id, agent: chosenAgent, terminal_tab_id: primaryId, browser_tab_id: browserTabId, files_tab_id: filesTabId };
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
