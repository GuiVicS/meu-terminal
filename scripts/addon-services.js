/**
 * addon-services.js
 * Os complementos que são serviços (Headroom e OmniRoute, definidos em addons.js) e as rotas
 * que decidem por onde o Claude Code fala com o modelo.
 *
 * - Cada serviço só escuta em 127.0.0.1 e só roda enquanto estiver ligado nas Configurações.
 * - Sem redundância: cada função fica num complemento só. A memória é do Claude Mem (Headroom e
 *   OmniRoute com a deles desligada), o mapa do código é do Cartographer (sem o code graph do
 *   Headroom), e cada rota usa um compressor só: "economia" passa pelo Headroom até a Anthropic,
 *   "omniroute" usa a compressão do próprio OmniRoute.
 * - routeEnv() é a única fonte das variáveis de rota: o terminal e o Modo UI usam a mesma.
 */
const { spawn } = require('child_process');
const { killGroup } = require('./process-runner');

const ROUTES = {
    direto: { label: 'Direto (Anthropic)', service: null },
    economia: { label: 'Economia de tokens (Headroom)', service: 'headroom' },
    omniroute: { label: 'Outros modelos (OmniRoute)', service: 'omniroute' },
};
const DEFAULT_ROUTE = 'direto';

class RouteError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const normalizeRoute = route => (ROUTES[route] ? route : DEFAULT_ROUTE);

/**
 * Environment for a Claude Code process on this route (empty = the default, straight to
 * Anthropic with the user's own login).
 * @param {string} route
 * @param {{ services?: object }} prefs - addons.json preferences
 */
function routeEnv(route, prefs = {}, defs = {}, { model = null } = {}) {
    route = normalizeRoute(route);
    if (route === 'direto') return {};
    const def = defs[ROUTES[route].service];
    const base = `http://127.0.0.1:${def.port}`;
    if (route === 'economia') return { ANTHROPIC_BASE_URL: base };
    const omni = prefs.services?.omniroute || {};
    if (!omni.apiKey) throw new RouteError('Falta a chave do OmniRoute: crie no painel dele e cole em Configurações → Complementos.');
    return {
        ANTHROPIC_BASE_URL: base,
        ANTHROPIC_AUTH_TOKEN: omni.apiKey,
        ...((model || omni.model) ? { ANTHROPIC_MODEL: model || omni.model } : {}),
        // O /model do Claude Code lista os modelos que o OmniRoute expõe
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    };
}

const MAX_LOG_LINES = 200;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const MAX_RESTARTS = 3;

class ServiceManager {
    /**
     * @param {object} opts
     * @param {object} opts.defs - id -> service definition (addons.js, kind 'service')
     * @param {string} opts.home
     * @param {object} opts.env - base environment (already without the app's secrets)
     * @param {Function} [opts.fetchImpl]
     * @param {Function} [opts.spawnImpl]
     * @param {number} [opts.healthTimeoutMs]
     */
    constructor({ defs, home, env = process.env, secrets = () => ({}), log = () => {}, fetchImpl = fetch, spawnImpl = spawn, healthTimeoutMs = 90000, healthIntervalMs = 1000 }) {
        this.defs = defs;
        this.home = home;
        this.env = env;
        this.secrets = secrets; // id -> env com segredos gerados uma vez (Addons.serviceSecrets)
        this.log = log;
        this.fetch = fetchImpl;
        this.spawn = spawnImpl;
        this.healthTimeoutMs = healthTimeoutMs;
        this.healthIntervalMs = healthIntervalMs;
        this.state = {}; // id -> { child, wanted, starting, restarts: [], logs: [], lastError, startedAt }
    }

    s(id) {
        if (!this.defs[id]) throw new RouteError(`Serviço desconhecido: ${id}`, 404);
        return (this.state[id] ||= { child: null, wanted: false, starting: null, restarts: [], logs: [], lastError: null, startedAt: null });
    }

    async healthy(id) {
        const def = this.defs[id];
        try {
            const r = await this.fetch(`http://127.0.0.1:${def.port}${def.health}`, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
            return r.status < 500;
        } catch {
            return false;
        }
    }

    pushLog(id, chunk) {
        const st = this.s(id);
        for (const line of String(chunk).split('\n')) {
            if (!line.trim()) continue;
            st.logs.push(line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 400));
            if (st.logs.length > MAX_LOG_LINES) st.logs.shift();
        }
    }

    /** Starts the service if it isn't running and waits until it answers. Concurrent calls share one start. */
    ensure(id) {
        const st = this.s(id);
        st.wanted = true;
        if (!st.starting) st.starting = this.doStart(id).finally(() => { st.starting = null; });
        return st.starting;
    }

    async doStart(id) {
        const st = this.s(id);
        const def = this.defs[id];
        if (await this.healthy(id)) return; // já rodando (inclusive iniciado antes de um restart do servidor)
        const child = this.spawn(def.command, def.args, {
            cwd: this.home,
            env: { ...this.env, HOME: this.home, ...(typeof def.env === 'function' ? def.env(this.home) : def.env), ...this.secrets(id) },
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: true, // um grupo próprio: parar mata também os processos filhos dele
        });
        st.child = child;
        st.startedAt = Date.now();
        st.lastError = null;
        child.stdout?.on('data', d => this.pushLog(id, d));
        child.stderr?.on('data', d => this.pushLog(id, d));
        child.on('error', e => { st.lastError = e.message; this.pushLog(id, `erro: ${e.message}`); });
        child.on('exit', (code, signal) => this.onExit(id, child, code, signal));
        this.log(`Complementos: iniciando ${def.label}`);

        const deadline = Date.now() + this.healthTimeoutMs;
        while (Date.now() < deadline) {
            if (st.child !== child) throw new RouteError(`${def.label} parou ao iniciar: ${st.lastError || 'veja o log'}`, 503);
            if (await this.healthy(id)) {
                this.log(`Complementos: ${def.label} pronto em 127.0.0.1:${def.port}`);
                return;
            }
            await new Promise(r => setTimeout(r, this.healthIntervalMs));
        }
        throw new RouteError(`${def.label} não respondeu em ${Math.round(this.healthTimeoutMs / 1000)}s.`, 503);
    }

    onExit(id, child, code, signal) {
        const st = this.s(id);
        if (st.child !== child) return;
        st.child = null;
        const def = this.defs[id];
        if (!st.wanted) return;
        st.lastError = `encerrou (${signal || `código ${code}`})`;
        const now = Date.now();
        st.restarts = st.restarts.filter(t => now - t < RESTART_WINDOW_MS);
        if (st.restarts.length >= MAX_RESTARTS) {
            this.log(`Complementos: ${def.label} caiu ${MAX_RESTARTS} vezes em 5 minutos; não reinicio mais`);
            st.wanted = false;
            return;
        }
        st.restarts.push(now);
        this.log(`Complementos: ${def.label} ${st.lastError}; reiniciando`);
        setTimeout(() => { if (st.wanted && !st.child) this.ensure(id).catch(() => {}); }, 2000 * st.restarts.length).unref?.();
    }

    async stop(id) {
        const st = this.s(id);
        st.wanted = false;
        const child = st.child;
        if (child) {
            killGroup(child);
            await new Promise(resolve => {
                const t = setTimeout(resolve, 5000);
                child.once('exit', () => { clearTimeout(t); resolve(); });
            });
        }
        st.child = null;
    }

    /** Liga os serviços marcados nas preferências e desliga os outros. */
    async apply(prefs = {}) {
        for (const id of Object.keys(this.defs)) {
            const on = !!prefs.services?.[id]?.enabled;
            if (on) await this.ensure(id).catch(e => this.log(`Complementos: ${e.message}`));
            else if (this.state[id]?.child || this.state[id]?.wanted) await this.stop(id);
        }
    }

    async status(id) {
        const st = this.s(id);
        return {
            running: await this.healthy(id),
            managed: !!st.child,
            pid: st.child?.pid || null,
            startedAt: st.startedAt,
            lastError: st.lastError,
            log: st.logs.slice(-40),
        };
    }

    shutdown() {
        for (const id of Object.keys(this.state)) {
            const st = this.state[id];
            st.wanted = false;
            if (st.child) killGroup(st.child);
        }
    }
}

module.exports = { ServiceManager, ROUTES, DEFAULT_ROUTE, RouteError, routeEnv, normalizeRoute };
