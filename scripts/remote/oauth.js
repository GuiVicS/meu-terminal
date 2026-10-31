/**
 * remote/oauth.js
 * OAuth 2.1 authorization server for the Claude bridge (/mcp/remote), as claude.ai's custom
 * connectors expect: authorization code + PKCE (S256 only), refresh tokens that rotate, an
 * optional fixed client from .env and dynamic client registration (RFC 7591).
 *
 * Only hashes of tokens and client secrets are stored (SQLite, same database as the app).
 * Every token also carries the "fingerprint" of the login credentials it was issued under:
 * changing the password or the 2FA secret invalidates all of them, like the app's own login.
 * No Express here - routes/remote.js turns HTTP into calls to this class (and tests call it directly).
 */
const crypto = require('crypto');

const CODE_TTL_MS = 60 * 1000;
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_DCR_CLIENTS = 50;
const DEFAULT_REDIRECT_URIS = [
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
];

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('base64url');
const randomToken = (prefix, bytes = 32) => `${prefix}${crypto.randomBytes(bytes).toString('base64url')}`;

class OAuthError extends Error {
    /** @param {string} code - RFC 6749 error code (invalid_request, invalid_grant...) */
    constructor(code, description, status = 400) {
        super(description || code);
        this.code = code;
        this.status = status;
    }

    toJSON() {
        return { error: this.code, error_description: this.message };
    }
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

class RemoteOAuth {
    /**
     * @param {object} opts
     * @param {import('node:sqlite').DatabaseSync} opts.db
     * @param {string} opts.issuer - public base of the app, e.g. "https://terminal.exemplo.com" (+ BASE_PATH)
     * @param {string} opts.fingerprint - changes whenever the login credentials change
     * @param {{id: string, secret: string}|null} [opts.envClient] - fixed client from .env
     * @param {boolean} [opts.dcr] - allow dynamic client registration
     * @param {string[]} [opts.extraRedirectUris] - besides claude.ai/claude.com (e.g. MCP Inspector)
     * @param {() => number} [opts.now]
     */
    constructor({ db, issuer, fingerprint, envClient = null, dcr = true, extraRedirectUris = [], now = Date.now }) {
        this.db = db;
        this.issuer = issuer.replace(/\/+$/, '');
        this.resource = `${this.issuer}/mcp/remote`;
        this.fingerprint = fingerprint;
        this.envClient = envClient && envClient.id && envClient.secret ? envClient : null;
        this.dcr = !!dcr;
        this.allowedRedirects = new Set([...DEFAULT_REDIRECT_URIS, ...extraRedirectUris.filter(Boolean)]);
        this.now = now;
        this.codes = new Map(); // code hash -> { clientId, redirectUri, challenge, scope, expiresAt }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS remote_clients (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                secret_hash TEXT,
                auth_method TEXT NOT NULL,
                redirect_uris TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER,
                revoked_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS remote_tokens (
                hash TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                client_id TEXT NOT NULL,
                grant_id TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                scope TEXT,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                revoked_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS remote_tokens_grant ON remote_tokens (grant_id);
        `);
    }

    // ---------- metadata ----------

    /** RFC 8414 */
    authorizationServerMetadata() {
        return {
            issuer: this.issuer,
            authorization_endpoint: `${this.issuer}/oauth/authorize`,
            token_endpoint: `${this.issuer}/oauth/token`,
            revocation_endpoint: `${this.issuer}/oauth/revoke`,
            ...(this.dcr ? { registration_endpoint: `${this.issuer}/oauth/register` } : {}),
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
            revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
            scopes_supported: ['mcp'],
        };
    }

    /** RFC 9728 */
    protectedResourceMetadata() {
        return {
            resource: this.resource,
            authorization_servers: [this.issuer],
            bearer_methods_supported: ['header'],
            scopes_supported: ['mcp'],
            resource_name: 'MeuTerminal',
        };
    }

    // ---------- clients ----------

    /** The client (env or registered), or null. */
    getClient(id) {
        if (!id || typeof id !== 'string') return null;
        if (this.envClient && id === this.envClient.id) {
            return { id, name: 'Claude (cliente fixo do .env)', authMethod: 'client_secret_post', redirectUris: [...this.allowedRedirects], source: 'env' };
        }
        const row = this.db.prepare('SELECT * FROM remote_clients WHERE id = ? AND revoked_at IS NULL').get(id);
        if (!row) return null;
        return { id: row.id, name: row.name, authMethod: row.auth_method, redirectUris: JSON.parse(row.redirect_uris), source: 'dcr', secretHash: row.secret_hash };
    }

    /** RFC 7591 dynamic registration. Redirect URIs must all be in the allowlist. */
    registerClient(body = {}) {
        if (!this.dcr) throw new OAuthError('invalid_request', 'Registro dinâmico desligado.', 404);
        const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter(u => typeof u === 'string') : [];
        if (!uris.length) throw new OAuthError('invalid_redirect_uri', 'Informe redirect_uris.');
        const bad = uris.find(u => !this.allowedRedirects.has(u));
        if (bad) throw new OAuthError('invalid_redirect_uri', `redirect_uri não permitido: ${bad}`);
        const method = body.token_endpoint_auth_method || 'client_secret_basic';
        if (!['none', 'client_secret_basic', 'client_secret_post'].includes(method)) {
            throw new OAuthError('invalid_client_metadata', `token_endpoint_auth_method não suportado: ${method}`);
        }
        const active = this.db.prepare('SELECT COUNT(*) AS n FROM remote_clients WHERE revoked_at IS NULL').get().n;
        if (active >= MAX_DCR_CLIENTS) throw new OAuthError('invalid_request', 'Clientes demais registrados. Revogue algum no /admin.', 429);

        const id = randomToken('mtc_', 16);
        const secret = method === 'none' ? null : randomToken('mts_', 32);
        const name = String(body.client_name || 'Cliente MCP').slice(0, 80);
        const now = this.now();
        this.db.prepare(`INSERT INTO remote_clients (id, name, secret_hash, auth_method, redirect_uris, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, secret ? sha256(secret) : null, method, JSON.stringify(uris), now);
        return {
            client_id: id,
            ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
            client_id_issued_at: Math.floor(now / 1000),
            client_name: name,
            redirect_uris: uris,
            token_endpoint_auth_method: method,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
        };
    }

    /**
     * Checks the client's credentials at the token/revoke endpoints.
     * @param {{clientId?: string, clientSecret?: string}} creds - from Basic auth or the form body
     */
    authenticateClient({ clientId, clientSecret }) {
        const client = this.getClient(clientId);
        if (!client) throw new OAuthError('invalid_client', 'Cliente desconhecido.', 401);
        if (client.source === 'env') {
            if (!clientSecret || !safeEqual(clientSecret, this.envClient.secret)) throw new OAuthError('invalid_client', 'Credenciais do cliente inválidas.', 401);
        } else if (client.authMethod !== 'none') {
            if (!clientSecret || !client.secretHash || !safeEqual(sha256(clientSecret), client.secretHash)) {
                throw new OAuthError('invalid_client', 'Credenciais do cliente inválidas.', 401);
            }
        }
        return client;
    }

    listClients() {
        const rows = this.db.prepare('SELECT * FROM remote_clients WHERE revoked_at IS NULL ORDER BY created_at DESC').all();
        const active = this.db.prepare(`SELECT client_id, COUNT(DISTINCT grant_id) AS grants, MAX(created_at) AS last
            FROM remote_tokens WHERE revoked_at IS NULL AND expires_at > ? AND fingerprint = ? GROUP BY client_id`).all(this.now(), this.fingerprint);
        const stats = new Map(active.map(r => [r.client_id, r]));
        const out = rows.map(r => ({
            id: r.id, name: r.name, source: 'dcr', createdAt: r.created_at,
            lastUsedAt: r.last_used_at, activeGrants: stats.get(r.id)?.grants || 0,
        }));
        if (this.envClient) {
            out.unshift({ id: this.envClient.id, name: 'Cliente fixo (.env)', source: 'env', createdAt: null,
                lastUsedAt: stats.get(this.envClient.id)?.last || null, activeGrants: stats.get(this.envClient.id)?.grants || 0 });
        }
        return out;
    }

    /** Revokes every token of a client; a registered client is also deleted (it must register again). */
    revokeClient(id) {
        const now = this.now();
        const tokens = this.db.prepare('UPDATE remote_tokens SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL').run(now, id).changes;
        const client = this.db.prepare('UPDATE remote_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now, id).changes;
        return { tokens, client: !!client };
    }

    revokeAll() {
        return this.db.prepare('UPDATE remote_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(this.now()).changes;
    }

    // ---------- authorization ----------

    /**
     * Validates the /oauth/authorize query. Errors about the client or the redirect_uri must be
     * shown on our own page (never redirected); the rest go back to the client as ?error=.
     * @returns {{client, redirectUri, state, codeChallenge, scope}}
     */
    validateAuthorizeRequest(q = {}) {
        const client = this.getClient(q.client_id);
        if (!client) throw new OAuthError('invalid_client', 'Cliente desconhecido. Remova e adicione o conector de novo.');
        const redirectUri = typeof q.redirect_uri === 'string' ? q.redirect_uri : '';
        if (!redirectUri || !client.redirectUris.includes(redirectUri) || !this.allowedRedirects.has(redirectUri)) {
            throw new OAuthError('invalid_request', 'redirect_uri não permitido.');
        }
        const redirectable = (code, desc) => Object.assign(new OAuthError(code, desc), { redirectUri, state: q.state });
        if (q.response_type !== 'code') throw redirectable('unsupported_response_type', 'Só response_type=code.');
        if (q.code_challenge_method !== 'S256') throw redirectable('invalid_request', 'PKCE com S256 é obrigatório.');
        if (typeof q.code_challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) {
            throw redirectable('invalid_request', 'code_challenge inválido.');
        }
        if (q.resource !== undefined && q.resource !== '' && !this.isOurResource(q.resource)) {
            throw redirectable('invalid_target', 'resource não é este servidor.');
        }
        return {
            client, redirectUri, state: typeof q.state === 'string' ? q.state : undefined,
            codeChallenge: q.code_challenge, scope: typeof q.scope === 'string' ? q.scope.slice(0, 200) : 'mcp',
        };
    }

    isOurResource(resource) {
        const norm = s => String(s).replace(/\/+$/, '');
        return norm(resource) === norm(this.resource) || norm(resource) === norm(this.issuer);
    }

    /** After the user approved: a single-use code valid for 60 s. Returns the redirect URL. */
    issueCode(req) {
        const code = randomToken('mtk_', 32);
        this.sweepCodes();
        this.codes.set(sha256(code), {
            clientId: req.client.id, redirectUri: req.redirectUri, challenge: req.codeChallenge,
            scope: req.scope, expiresAt: this.now() + CODE_TTL_MS,
        });
        const url = new URL(req.redirectUri);
        url.searchParams.set('code', code);
        if (req.state !== undefined) url.searchParams.set('state', req.state);
        url.searchParams.set('iss', this.issuer);
        return url.toString();
    }

    /** The user said no (or failed): where to send them back with error=access_denied. */
    denyUrl(req) {
        const url = new URL(req.redirectUri);
        url.searchParams.set('error', 'access_denied');
        if (req.state !== undefined) url.searchParams.set('state', req.state);
        return url.toString();
    }

    sweepCodes() {
        const now = this.now();
        for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k);
    }

    // ---------- tokens ----------

    /**
     * POST /oauth/token. `client` was already authenticated (authenticateClient).
     * @returns {{access_token, token_type, expires_in, refresh_token, scope}}
     */
    exchange(client, body = {}) {
        if (body.grant_type === 'authorization_code') return this.exchangeCode(client, body);
        if (body.grant_type === 'refresh_token') return this.refresh(client, body);
        throw new OAuthError('unsupported_grant_type', 'grant_type não suportado.');
    }

    exchangeCode(client, { code, redirect_uri, code_verifier }) {
        const key = sha256(code || '');
        const entry = this.codes.get(key);
        this.codes.delete(key); // single use, whatever happens next
        if (!entry || entry.expiresAt < this.now()) throw new OAuthError('invalid_grant', 'Código inválido ou expirado.');
        if (entry.clientId !== client.id) throw new OAuthError('invalid_grant', 'O código é de outro cliente.');
        if (redirect_uri !== undefined && redirect_uri !== entry.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri diferente.');
        if (typeof code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier)) {
            throw new OAuthError('invalid_grant', 'code_verifier inválido.');
        }
        const challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
        if (!safeEqual(challenge, entry.challenge)) throw new OAuthError('invalid_grant', 'PKCE não confere.');
        return this.issueTokens(client.id, crypto.randomUUID(), entry.scope);
    }

    refresh(client, { refresh_token }) {
        const row = this.db.prepare(`SELECT * FROM remote_tokens WHERE hash = ? AND kind = 'refresh'`).get(sha256(refresh_token || ''));
        if (!row || row.client_id !== client.id) throw new OAuthError('invalid_grant', 'Refresh token inválido.');
        if (row.revoked_at) {
            // A rotated-out token used again: someone kept a copy. Kill the whole grant.
            this.db.prepare('UPDATE remote_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(this.now(), row.grant_id);
            throw new OAuthError('invalid_grant', 'Refresh token já usado; a autorização foi revogada por segurança.');
        }
        if (row.expires_at < this.now() || row.fingerprint !== this.fingerprint) throw new OAuthError('invalid_grant', 'Autorização expirada. Conecte de novo.');
        this.db.prepare('UPDATE remote_tokens SET revoked_at = ? WHERE hash = ?').run(this.now(), row.hash);
        return this.issueTokens(client.id, row.grant_id, row.scope);
    }

    issueTokens(clientId, grantId, scope) {
        const now = this.now();
        const access = randomToken('mta_', 32);
        const refresh = randomToken('mtr_', 32);
        const insert = this.db.prepare(`INSERT INTO remote_tokens (hash, kind, client_id, grant_id, fingerprint, scope, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        insert.run(sha256(access), 'access', clientId, grantId, this.fingerprint, scope || null, now, now + ACCESS_TTL_MS);
        insert.run(sha256(refresh), 'refresh', clientId, grantId, this.fingerprint, scope || null, now, now + REFRESH_TTL_MS);
        this.db.prepare('UPDATE remote_clients SET last_used_at = ? WHERE id = ?').run(now, clientId);
        this.pruneTokens();
        return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scope || 'mcp' };
    }

    /** The access token's grant, or null (unknown, expired, revoked, or issued under old credentials). */
    verifyAccessToken(token) {
        if (!token || typeof token !== 'string' || !token.startsWith('mta_')) return null;
        const row = this.db.prepare(`SELECT * FROM remote_tokens WHERE hash = ? AND kind = 'access'`).get(sha256(token));
        if (!row || row.revoked_at || row.expires_at < this.now() || row.fingerprint !== this.fingerprint) return null;
        if (!this.getClient(row.client_id)) return null;
        return { clientId: row.client_id, grantId: row.grant_id, scope: row.scope };
    }

    /** RFC 7009: revoking either token of a grant ends the whole grant. Unknown tokens are not an error. */
    revokeToken(client, token) {
        const row = this.db.prepare('SELECT * FROM remote_tokens WHERE hash = ?').get(sha256(token || ''));
        if (!row || row.client_id !== client.id) return false;
        this.db.prepare('UPDATE remote_tokens SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(this.now(), row.grant_id);
        return true;
    }

    pruneTokens() {
        // Keep revoked refresh tokens until they'd have expired anyway (reuse detection needs them)
        this.db.prepare('DELETE FROM remote_tokens WHERE expires_at < ?').run(this.now() - 24 * 60 * 60 * 1000);
    }
}

module.exports = { RemoteOAuth, OAuthError, DEFAULT_REDIRECT_URIS, CODE_TTL_MS, ACCESS_TTL_MS, REFRESH_TTL_MS };
