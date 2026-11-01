/**
 * addon-bridges.js
 * As telas dos complementos dentro de Configurações → Complementos, sem abrir o painel de cada
 * um no navegador e sem login próprio: o servidor do MeuTerminal (já atrás do login do usuário)
 * fala com cada serviço em 127.0.0.1 e expõe só as ações que a tela usa.
 * - OmniRoute: entra com a senha gerada pelo MeuTerminal (addons.serviceSecrets), lista/adiciona/
 *   testa/remove provedores, mostra uso e modelos, e cria sozinho a chave usada pela rota.
 * - Claude Mem: números, projetos, memórias, busca e apagar uma memória.
 * - Headroom: economia de tokens e de custo.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

class BridgeError extends Error {
    constructor(message, status = 502) {
        super(message);
        this.status = status;
    }
}

async function getJson(fetchImpl, url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
    let r;
    try {
        r = await fetchImpl(url, {
            method,
            headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new BridgeError('O serviço não respondeu. Ele está ligado?', 503);
    }
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 200) }; }
    return { status: r.status, ok: r.ok, data, headers: r.headers };
}

const errorText = data => data?.error?.message || data?.error || data?.message || 'erro desconhecido';

// ---------- OmniRoute ----------

class OmniRouteBridge {
    /**
     * @param {object} opts
     * @param {number} opts.port
     * @param {() => string} opts.password - senha do painel gerada pelo MeuTerminal
     * @param {string} [opts.packageDir] - onde o pacote omniroute está instalado (catálogo de provedores)
     */
    constructor({ port = 20128, password, packageDir = '/usr/local/lib/node_modules/omniroute', fetchImpl = fetch, cacheDir = path.join(os.tmpdir(), 'mt-omniroute-catalog') }) {
        this.base = `http://127.0.0.1:${port}`;
        this.password = password;
        this.packageDir = packageDir;
        this.fetch = fetchImpl;
        this.cacheDir = cacheDir;
        this.cookie = null;
        this.catalogCache = null;
    }

    async login() {
        const r = await getJson(this.fetch, `${this.base}/api/auth/login`, { method: 'POST', body: { password: this.password() } });
        if (!r.ok) throw new BridgeError(`O OmniRoute recusou o login automático: ${errorText(r.data)}`, 502);
        const set = r.headers.get('set-cookie') || '';
        const m = set.match(/auth_token=([^;]+)/);
        if (!m) throw new BridgeError('O OmniRoute não devolveu a sessão.', 502);
        this.cookie = `auth_token=${m[1]}`;
    }

    /** Chamada à API de gerenciamento, entrando (de novo) quando a sessão expira. */
    async api(method, route, body) {
        if (!this.cookie) await this.login();
        let r = await getJson(this.fetch, `${this.base}${route}`, { method, body, headers: { Cookie: this.cookie } });
        if (r.status === 401) {
            await this.login();
            r = await getJson(this.fetch, `${this.base}${route}`, { method, body, headers: { Cookie: this.cookie } });
        }
        if (!r.ok) throw new BridgeError(errorText(r.data), r.status >= 500 ? 502 : r.status);
        return r.data;
    }

    /**
     * Catálogo de provedores com chave, lido do próprio pacote instalado (dados puros em .ts, que o
     * Node carrega direto): sempre a lista da versão em uso, sem cópia para manter.
     */
    async catalog() {
        if (this.catalogCache) return this.catalogCache;
        const src = path.join(this.packageDir, 'src/shared/constants/providers/apikey');
        let list = [];
        try {
            fs.mkdirSync(this.cacheDir, { recursive: true });
            for (const f of fs.readdirSync(src).filter(f => f.endsWith('.ts'))) {
                // os imports vêm sem extensão ("./gateways"); o Node exige ".ts"
                const code = fs.readFileSync(path.join(src, f), 'utf8').replace(/from "(\.\/[^"]+?)"/g, (_, p) => `from "${p}.ts"`);
                fs.writeFileSync(path.join(this.cacheDir, f), code);
            }
            const mod = await import(pathToFileURL(path.join(this.cacheDir, 'index.ts')).href);
            const all = mod.APIKEY_PROVIDERS || Object.values(mod).find(v => v && typeof v === 'object' && !Array.isArray(v)) || {};
            list = Object.values(all).filter(p => p && p.id).map(p => ({
                id: p.id, name: p.name || p.id, website: p.website || null,
                free: !!p.hasFree, freeNote: p.freeNote || null,
            }));
        } catch {
            list = []; // sem catálogo a tela ainda aceita o id do provedor digitado
        }
        list.sort((a, b) => (b.free - a.free) || a.name.localeCompare(b.name));
        let noKey = [];
        try {
            const r = await this.api('GET', '/api/providers/free-onboarding');
            noKey = (r.providers || []).map(p => ({ id: p.id, name: p.name, website: p.website || null, note: p.caution || null }));
        } catch { /* opcional */ }
        this.catalogCache = { providers: list, noKey };
        return this.catalogCache;
    }

    async panel() {
        const [conns, usage] = await Promise.all([
            this.api('GET', '/api/providers'),
            this.api('GET', '/api/usage/analytics').catch(() => null),
        ]);
        const s = usage?.summary || {};
        return {
            connections: (conns.connections || []).map(c => ({
                id: c.id, provider: c.provider, name: c.name, active: !!c.isActive,
                status: c.testStatus || 'unknown', error: c.lastError || null,
            })),
            usage: {
                requests: s.totalRequests || 0, tokens: s.totalTokens || 0, cost: s.totalCost || 0,
                successPct: s.successRatePct || 0, models: s.uniqueModels || 0,
            },
        };
    }

    addProvider({ provider, apiKey, name }) {
        if (typeof provider !== 'string' || !/^[\w.-]{1,100}$/.test(provider)) throw new BridgeError('Provedor inválido.', 400);
        const key = typeof apiKey === 'string' ? apiKey.trim() : '';
        return this.api('POST', '/api/providers', {
            provider, name: String(name || provider).slice(0, 200),
            ...(key ? { apiKey: key } : { allowNoCredential: true }),
        });
    }

    removeProvider(id) { return this.api('DELETE', `/api/providers/${encodeURIComponent(id)}`); }
    testProvider(id) { return this.api('POST', `/api/providers/${encodeURIComponent(id)}/test`); }

    /** Modelos de uma conexão, já no formato que o Claude Code usa (provedor/modelo). */
    async models(id) {
        const r = await this.api('GET', `/api/providers/${encodeURIComponent(id)}/models`);
        return (r.models || []).map(m => ({ id: `${r.provider}/${m.id}`, name: m.name || m.id }));
    }

    /**
     * Conecta a conta do ChatGPT/Codex já logada no servidor (~/.codex/auth.json, do "codex login"):
     * o arquivo vai direto do disco para o OmniRoute, nunca passa pela tela.
     */
    async importCodex(home) {
        const file = path.join(home, '.codex', 'auth.json');
        let json;
        try {
            json = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            throw new BridgeError('Nenhuma conta do Codex neste servidor. Rode "codex login" no terminal primeiro.', 404);
        }
        return this.api('POST', '/api/providers/codex-auth/import', {
            source: { kind: 'json', json }, name: 'Codex (conta do ChatGPT)', overwriteExisting: true,
        });
    }

    /** Se existe um login do Codex no servidor (para mostrar o botão). */
    static hasCodexLogin(home) {
        return fs.existsSync(path.join(home, '.codex', 'auth.json'));
    }

    /** Cria a chave da rota "Outros modelos" (uma vez). */
    async createKey() {
        const r = await this.api('POST', '/api/keys', { name: 'MeuTerminal' });
        if (!r?.key) throw new BridgeError('O OmniRoute não devolveu a chave.', 502);
        return r.key;
    }
}

// ---------- Claude Mem ----------

class ClaudeMemBridge {
    constructor({ port = 37700, fetchImpl = fetch } = {}) {
        this.base = `http://127.0.0.1:${port}`;
        this.fetch = fetchImpl;
    }

    async get(route, timeoutMs) {
        const r = await getJson(this.fetch, `${this.base}${route}`, { timeoutMs });
        if (!r.ok) throw new BridgeError(errorText(r.data), 502);
        return r.data;
    }

    /** Espera o trabalhador responder (o "claude-mem start" volta antes de ele estar pronto). */
    async waitReady(timeoutMs = 60000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const r = await getJson(this.fetch, `${this.base}/api/health`, { timeoutMs: 3000 });
                if (r.ok) return true;
            } catch { /* ainda subindo */ }
            await new Promise(r => setTimeout(r, 1000));
        }
        return false;
    }

    async panel() {
        const [stats, projects] = await Promise.all([this.get('/api/stats'), this.get('/api/projects')]);
        const db = stats?.database || {};
        return {
            stats: { observations: db.observations || 0, sessions: db.sessions || 0, summaries: db.summaries || 0, sizeBytes: db.size || 0 },
            projects: projects?.projects || [],
        };
    }

    async observations({ project = '', offset = 0, limit = 20 } = {}) {
        const q = new URLSearchParams({ offset: String(Math.max(0, offset | 0)), limit: String(Math.min(50, Math.max(1, limit | 0))) });
        if (project) q.set('project', String(project));
        const r = await this.get(`/api/observations?${q}`);
        return {
            hasMore: !!r.hasMore,
            items: (r.items || []).map(o => ({
                id: o.id, type: o.type || null, title: o.title || o.subtitle || null,
                text: o.narrative || o.text || o.facts || '', project: o.project || null,
                at: o.created_at_epoch || o.createdAtEpoch || o.created_at || null,
            })),
        };
    }

    async search(query) {
        const q = String(query || '').trim().slice(0, 200);
        if (!q) return { text: '' };
        // a primeira busca prepara o índice semântico (Chroma, baixado pelo uv): pode levar minutos
        const r = await this.get(`/api/search?${new URLSearchParams({ query: q, limit: '20' })}`, 180000);
        return { text: (r.content || []).map(c => c.text || '').join('\n').trim() };
    }

    async deleteObservation(id) {
        const r = await getJson(this.fetch, `${this.base}/api/observation/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!r.ok) throw new BridgeError(errorText(r.data), 502);
        return { ok: true };
    }
}

// ---------- Headroom ----------

class HeadroomBridge {
    constructor({ port = 8787, fetchImpl = fetch } = {}) {
        this.base = `http://127.0.0.1:${port}`;
        this.fetch = fetchImpl;
    }

    async panel() {
        const r = await getJson(this.fetch, `${this.base}/stats`);
        if (!r.ok) throw new BridgeError(errorText(r.data), 502);
        const s = r.data?.summary || {};
        const c = s.compression || {};
        const cost = s.cost || {};
        return {
            requests: s.api_requests || 0,
            compressed: c.requests_compressed || 0,
            avgPct: c.avg_compression_pct || 0,
            bestPct: c.best_compression_pct || 0,
            tokensSaved: c.total_tokens_saved_all_layers || c.total_tokens_removed || 0,
            tokensBefore: c.total_tokens_before || 0,
            savedUsd: cost.total_saved_usd || 0,
            savingsPct: cost.savings_pct || 0,
            model: s.primary_model && s.primary_model !== 'unknown' ? s.primary_model : null,
        };
    }
}

module.exports = { OmniRouteBridge, ClaudeMemBridge, HeadroomBridge, BridgeError };
