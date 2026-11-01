/**
 * launch.js
 * "Deseja usar o modo <agente> UI?": decides, when a coding agent is typed in a terminal,
 * whether it opens in the agent UI (new tab) or runs in the terminal as usual.
 */
const crypto = require('crypto');

const CHOICES = ['ask', 'ui', 'terminal'];
const PREF_KEY = agent => `agent-ui-pref:${agent}`;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

class AgentLauncher {
    /**
     * @param {object} deps
     * @param {import('./gateway').AgentGateway} deps.gateway
     * @param {import('../session-manager')} deps.sessions - tabs + broadcast to every window
     * @param {{ get(key): string|null, set(key, value): void }} deps.prefs - small key/value store
     * @param {(command: string) => boolean} deps.commandExists - is the agent's ACP command installed?
     * @param {number} [deps.timeoutMs] - no answer -> terminal (never leave the user stuck)
     * @param {Function} [deps.log]
     */
    constructor({ gateway, sessions, prefs, commandExists, timeoutMs = DEFAULT_TIMEOUT_MS, defaultRoute = () => null, log = () => {} }) {
        this.gateway = gateway;
        // Rota da conversa aberta a partir do terminal: a mesma do terminal (Configurações → Complementos)
        this.defaultRoute = defaultRoute;
        this.sessions = sessions;
        this.prefs = prefs;
        this.commandExists = commandExists;
        this.timeoutMs = timeoutMs;
        this.log = log;
        this.pending = new Map(); // requestId -> { resolve, timer, request }
    }

    // ---------- preferences ----------

    /** Per agent: 'ask' (default), 'ui' or 'terminal'. Global switch under key 'intercept'. */
    getPrefs() {
        const agents = {};
        for (const a of this.gateway.listAgents()) {
            if (a.terminalOnly) continue;
            const value = this.prefs.get(PREF_KEY(a.id));
            agents[a.id] = CHOICES.includes(value) ? value : 'ask';
        }
        return { intercept: this.prefs.get('agent-ui-intercept') !== 'off', agents };
    }

    setPrefs({ intercept, agents } = {}) {
        if (typeof intercept === 'boolean') this.prefs.set('agent-ui-intercept', intercept ? 'on' : 'off');
        for (const [agent, value] of Object.entries(agents || {})) {
            if (this.uiAgent(agent) && CHOICES.includes(value)) this.prefs.set(PREF_KEY(agent), value);
        }
        return this.getPrefs();
    }

    /** The agent definition if it can open in the UI, else null. */
    uiAgent(agent) {
        return this.gateway.listAgents().find(a => a.id === agent && !a.terminalOnly) || null;
    }

    // ---------- the launch request (from the shim in the terminal) ----------

    /**
     * Resolves with what the shim must do:
     *   { action: 'ui', tabId, message }        -> the agent opened in a new tab; the shim exits
     *   { action: 'terminal', message? }        -> exec the real binary (today's behaviour)
     * Never rejects: any problem means "terminal".
     */
    async launch({ agent, cwd, tabId = null, prompt = null }) {
        try {
            const def = this.uiAgent(agent);
            if (!def) return { action: 'terminal' };
            const prefs = this.getPrefs();
            if (!prefs.intercept || prefs.agents[agent] === 'terminal') return { action: 'terminal' };
            const command = this.gateway.agents[agent].command;
            if (!this.commandExists(command)) {
                return {
                    action: 'terminal',
                    message: `Modo ${def.uiName} indisponível: instale com ${this.gateway.agents[agent].install}`,
                };
            }
            if (typeof cwd !== 'string' || !cwd) return { action: 'terminal' };

            let choice = prefs.agents[agent];
            if (choice === 'ask') {
                if (!this.sessions.sockets.size) return { action: 'terminal' }; // no window to ask in
                const answer = await this.ask({ agent, uiName: def.uiName, label: def.label, cwd, tabId, prompt });
                choice = answer.choice;
                if (answer.remember && CHOICES.includes(choice)) this.setPrefs({ agents: { [agent]: choice } });
            }
            if (choice !== 'ui') return { action: 'terminal' };
            return await this.openUi({ agent, cwd, tabId, prompt, uiName: def.uiName });
        } catch (error) {
            this.log('Agent launch failed, using the terminal:', error.message);
            return { action: 'terminal', message: `Não foi possível abrir o modo UI: ${error.message}` };
        }
    }

    /** Shows the popup on every window and waits for the first answer (or the timeout). */
    ask(request) {
        const requestId = crypto.randomUUID();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                this.sessions.broadcast({ type: 'agent-launch-close', requestId });
                resolve({ choice: 'terminal', timedOut: true });
            }, this.timeoutMs);
            this.pending.set(requestId, { resolve, timer, request });
            this.sessions.broadcast({ type: 'agent-launch', requestId, ...request, timeoutMs: this.timeoutMs });
        });
    }

    /** Answer from a window. Returns false when already answered (other device) or expired. */
    answer(requestId, { choice, remember = false } = {}) {
        const entry = this.pending.get(requestId);
        if (!entry) return false;
        this.pending.delete(requestId);
        clearTimeout(entry.timer);
        // The popup closes on the other devices too
        this.sessions.broadcast({ type: 'agent-launch-close', requestId });
        entry.resolve({ choice: choice === 'ui' ? 'ui' : 'terminal', remember: !!remember });
        return true;
    }

    /** Starts the agent session and opens its tab next to the terminal that launched it. */
    async openUi({ agent, cwd, tabId, prompt, uiName }) {
        const session = await this.gateway.startSession({ agent, cwd, route: this.defaultRoute(agent) });
        const tab = this.sessions.create({ kind: 'agent', url: session.id, cwd, name: uiName, afterId: tabId || undefined });
        this.sessions.broadcast({ type: 'open-tab', id: tab.id });
        // "claude 'corrija o bug'": the initial prompt becomes the first message
        if (prompt) {
            this.gateway.prompt(session.id, prompt).catch(error => this.log('Initial agent prompt failed:', error.message));
        }
        return { action: 'ui', tabId: tab.id, sessionId: session.id, message: `Aberto no modo ${uiName} ↗` };
    }
}

module.exports = { AgentLauncher, CHOICES };
