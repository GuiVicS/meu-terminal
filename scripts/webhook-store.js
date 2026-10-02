/**
 * webhook-store.js
 * CRUD, tokens, versions and run history for webhooks (see docs/PLANO-WEBHOOKS.md). Shares the
 * SQLite connection opened by SessionStore, same pattern as command-store.js / notes-store.js.
 */
const crypto = require('crypto');
const { validateDefs, normalizeScript } = require('./webhook-inputs');
const { generateToken, hashToken, encrypt, decrypt } = require('./webhook-crypto');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,58}[a-z0-9]$/;
const MAX_NAME = 80;
const MAX_SCRIPT = 20000;
const MAX_ERROR = 4000;

function cleanSlug(raw) {
    return String(raw || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/** validateDefs() attaches compiled _pattern/_extract RegExps for its own use; never store or serve those. */
function serializeDefs(defs) {
    return JSON.stringify(defs.map(({ _pattern, _extract, ...rest }) => rest));
}

function maskValues(values, defs) {
    const secretNames = new Set(defs.filter(d => d.type === 'secret').map(d => d.name));
    const out = {};
    for (const [k, v] of Object.entries(values || {})) out[k] = secretNames.has(k) ? '••••' : v;
    return out;
}

function toWebhook(row, { includeScript = true } = {}) {
    if (!row) return null;
    const inputs = JSON.parse(row.inputs || '[]');
    const out = {
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        enabled: !!row.enabled,
        preset: row.preset,
        inputs,
        cwd: row.cwd,
        runMode: row.run_mode,
        concurrency: row.concurrency,
        timeoutSec: row.timeout_sec,
        ratePerMin: row.rate_per_min,
        authMode: row.auth_mode,
        hasHmacSecret: !!row.hmac_secret,
        allowedIps: JSON.parse(row.allowed_ips || '[]'),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
    if (includeScript) out.script = row.script;
    return out;
}

class WebhookStore {
    /** @param {import('node:sqlite').DatabaseSync} db */
    constructor(db) {
        this.db = db;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS webhooks (
                id            TEXT PRIMARY KEY,
                slug          TEXT NOT NULL UNIQUE,
                name          TEXT NOT NULL,
                description   TEXT NOT NULL DEFAULT '',
                enabled       INTEGER NOT NULL DEFAULT 1,
                preset        TEXT,
                script        TEXT NOT NULL DEFAULT '',
                inputs        TEXT NOT NULL DEFAULT '[]',
                cwd           TEXT,
                run_mode      TEXT NOT NULL DEFAULT 'background',
                concurrency   TEXT NOT NULL DEFAULT 'queue',
                timeout_sec   INTEGER NOT NULL DEFAULT 300,
                rate_per_min  INTEGER NOT NULL DEFAULT 6,
                auth_mode     TEXT NOT NULL DEFAULT 'bearer',
                hmac_secret   TEXT,
                allowed_ips   TEXT NOT NULL DEFAULT '[]',
                created_at    INTEGER NOT NULL,
                updated_at    INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS webhook_tokens (
                id            TEXT PRIMARY KEY,
                webhook_id    TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
                name          TEXT NOT NULL,
                prefix        TEXT NOT NULL,
                token_hash    TEXT NOT NULL UNIQUE,
                expires_at    INTEGER,
                last_used_at  INTEGER,
                revoked_at    INTEGER,
                created_at    INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS webhook_secrets (
                webhook_id    TEXT NOT NULL,
                name          TEXT NOT NULL,
                value_enc     TEXT NOT NULL,
                PRIMARY KEY (webhook_id, name)
            );
            CREATE TABLE IF NOT EXISTS webhook_versions (
                webhook_id    TEXT NOT NULL,
                version       INTEGER NOT NULL,
                script        TEXT NOT NULL,
                inputs        TEXT NOT NULL,
                changed_at    INTEGER NOT NULL,
                PRIMARY KEY (webhook_id, version)
            );
            CREATE TABLE IF NOT EXISTS webhook_runs (
                id            TEXT PRIMARY KEY,
                webhook_id    TEXT NOT NULL,
                trigger       TEXT NOT NULL,
                source_ip     TEXT,
                token_id      TEXT,
                inputs        TEXT NOT NULL DEFAULT '{}',
                status        TEXT NOT NULL,
                exit_code     INTEGER,
                output        TEXT,
                started_at    INTEGER NOT NULL,
                finished_at   INTEGER
            );
            CREATE INDEX IF NOT EXISTS webhook_runs_wh ON webhook_runs (webhook_id, started_at DESC);
        `);
    }

    // ---------- webhooks ----------

    list() {
        return this.db.prepare('SELECT * FROM webhooks ORDER BY name').all()
            .map(row => toWebhook(row, { includeScript: false }));
    }

    get(id) {
        return toWebhook(this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id));
    }

    getBySlug(slug) {
        return toWebhook(this.db.prepare('SELECT * FROM webhooks WHERE slug = ?').get(slug));
    }

    /** @returns {{ok:true, webhook:object}|{ok:false, error:string}} */
    create({ name, slug, description, preset, script, inputs, cwd, runMode, concurrency, timeoutSec, ratePerMin, allowedIps }) {
        const cleanedSlug = cleanSlug(slug || name);
        if (!SLUG_RE.test(cleanedSlug)) return { ok: false, error: 'Slug inválido. Use letras minúsculas, números e hífen.' };
        if (this.db.prepare('SELECT 1 FROM webhooks WHERE slug = ?').get(cleanedSlug)) {
            return { ok: false, error: `Já existe um webhook com o slug "${cleanedSlug}".` };
        }
        const defsResult = validateDefs(inputs || []);
        if (!defsResult.ok) return { ok: false, error: defsResult.error };
        const cleanScript = normalizeScript(String(script || '').slice(0, MAX_SCRIPT));

        const id = crypto.randomUUID();
        const now = Date.now();
        this.db.prepare(`INSERT INTO webhooks (id, slug, name, description, enabled, preset, script, inputs,
                cwd, run_mode, concurrency, timeout_sec, rate_per_min, allowed_ips, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, cleanedSlug, String(name || cleanedSlug).slice(0, MAX_NAME), String(description || '').slice(0, 500),
                preset || null, cleanScript, serializeDefs(defsResult.defs), cwd || null,
                ['background', 'tab'].includes(runMode) ? runMode : 'background',
                ['queue', 'skip', 'cancel'].includes(concurrency) ? concurrency : 'queue',
                Math.min(Math.max(5, Number(timeoutSec) || 300), 3600),
                Math.min(Math.max(1, Number(ratePerMin) || 6), 120),
                JSON.stringify(Array.isArray(allowedIps) ? allowedIps.slice(0, 50) : []), now, now);
        this.db.prepare('INSERT INTO webhook_versions (webhook_id, version, script, inputs, changed_at) VALUES (?, 1, ?, ?, ?)')
            .run(id, cleanScript, serializeDefs(defsResult.defs), now);
        return { ok: true, webhook: this.get(id) };
    }

    /** @returns {{ok:true, webhook:object}|{ok:false, error:string}} */
    update(id, patch = {}) {
        const current = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
        if (!current) return { ok: false, error: 'Webhook não encontrado.' };

        let script = current.script;
        let inputs = current.inputs;
        let scriptChanged = false;
        if (patch.script !== undefined) {
            script = normalizeScript(String(patch.script).slice(0, MAX_SCRIPT));
            scriptChanged = script !== current.script;
        }
        if (patch.inputs !== undefined) {
            const defsResult = validateDefs(patch.inputs);
            if (!defsResult.ok) return { ok: false, error: defsResult.error };
            inputs = serializeDefs(defsResult.defs);
            scriptChanged = scriptChanged || inputs !== current.inputs;
        }
        let slug = current.slug;
        if (patch.slug !== undefined) {
            slug = cleanSlug(patch.slug);
            if (!SLUG_RE.test(slug)) return { ok: false, error: 'Slug inválido.' };
            const clash = this.db.prepare('SELECT 1 FROM webhooks WHERE slug = ? AND id != ?').get(slug, id);
            if (clash) return { ok: false, error: `Já existe um webhook com o slug "${slug}".` };
        }

        const name = patch.name !== undefined ? String(patch.name).slice(0, MAX_NAME) : current.name;
        const description = patch.description !== undefined ? String(patch.description).slice(0, 500) : current.description;
        const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
        const cwd = patch.cwd !== undefined ? (patch.cwd || null) : current.cwd;
        const runMode = patch.runMode !== undefined ? (['background', 'tab'].includes(patch.runMode) ? patch.runMode : 'background') : current.run_mode;
        const concurrency = patch.concurrency !== undefined ? (['queue', 'skip', 'cancel'].includes(patch.concurrency) ? patch.concurrency : 'queue') : current.concurrency;
        const timeoutSec = patch.timeoutSec !== undefined ? Math.min(Math.max(5, Number(patch.timeoutSec) || 300), 3600) : current.timeout_sec;
        const ratePerMin = patch.ratePerMin !== undefined ? Math.min(Math.max(1, Number(patch.ratePerMin) || 6), 120) : current.rate_per_min;
        const allowedIps = patch.allowedIps !== undefined ? JSON.stringify(patch.allowedIps.slice(0, 50)) : current.allowed_ips;
        const now = Date.now();

        this.db.prepare(`UPDATE webhooks SET slug=?, name=?, description=?, enabled=?, script=?, inputs=?,
                cwd=?, run_mode=?, concurrency=?, timeout_sec=?, rate_per_min=?, allowed_ips=?, updated_at=?
            WHERE id = ?`)
            .run(slug, name, description, enabled, script, inputs, cwd, runMode, concurrency, timeoutSec,
                ratePerMin, allowedIps, now, id);

        if (scriptChanged) {
            const last = this.db.prepare('SELECT MAX(version) AS v FROM webhook_versions WHERE webhook_id = ?').get(id);
            this.db.prepare('INSERT INTO webhook_versions (webhook_id, version, script, inputs, changed_at) VALUES (?, ?, ?, ?, ?)')
                .run(id, (last.v || 0) + 1, script, inputs, now);
        }
        return { ok: true, webhook: this.get(id) };
    }

    remove(id) {
        return this.db.prepare('DELETE FROM webhooks WHERE id = ?').run(id).changes > 0;
    }

    duplicate(id) {
        const src = this.db.prepare('SELECT * FROM webhooks WHERE id = ?').get(id);
        if (!src) return null;
        let n = 2;
        let slug = `${src.slug}-copia`;
        while (this.db.prepare('SELECT 1 FROM webhooks WHERE slug = ?').get(slug)) slug = `${src.slug}-copia-${n++}`;
        return this.create({
            name: `${src.name} (cópia)`, slug, description: src.description, preset: src.preset,
            script: src.script, inputs: JSON.parse(src.inputs), cwd: src.cwd, runMode: src.run_mode,
            concurrency: src.concurrency, timeoutSec: src.timeout_sec, ratePerMin: src.rate_per_min,
            allowedIps: JSON.parse(src.allowed_ips),
        });
    }

    versions(webhookId) {
        return this.db.prepare('SELECT version, changed_at AS changedAt FROM webhook_versions WHERE webhook_id = ? ORDER BY version DESC')
            .all(webhookId);
    }

    // ---------- tokens ----------

    /** @returns {{id, token, prefix, name}} - `token` (the plain value) is only ever returned here. */
    createToken(webhookId, name, { expiresAt } = {}) {
        const { token, prefix, hash } = generateToken();
        const id = crypto.randomUUID();
        this.db.prepare(`INSERT INTO webhook_tokens (id, webhook_id, name, prefix, token_hash, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(id, webhookId, String(name || 'token').slice(0, 60), prefix, hash, expiresAt || null, Date.now());
        return { id, token, prefix, name };
    }

    listTokens(webhookId) {
        return this.db.prepare(`SELECT id, name, prefix, expires_at AS expiresAt, last_used_at AS lastUsedAt,
                revoked_at AS revokedAt, created_at AS createdAt FROM webhook_tokens
                WHERE webhook_id = ? ORDER BY created_at DESC`).all(webhookId);
    }

    revokeToken(webhookId, tokenId) {
        return this.db.prepare('UPDATE webhook_tokens SET revoked_at = ? WHERE id = ? AND webhook_id = ? AND revoked_at IS NULL')
            .run(Date.now(), tokenId, webhookId).changes > 0;
    }

    /** Looks a webhook up by slug and matches a bearer token against its live tokens. Used by the public route. */
    findByToken(slug, bearerToken) {
        const webhook = this.db.prepare('SELECT * FROM webhooks WHERE slug = ?').get(slug);
        if (!webhook) return null;
        const hash = hashToken(bearerToken);
        const now = Date.now();
        const tokenRow = this.db.prepare(`SELECT * FROM webhook_tokens WHERE webhook_id = ? AND token_hash = ?
                AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`).get(webhook.id, hash, now);
        if (!tokenRow) return null;
        this.db.prepare('UPDATE webhook_tokens SET last_used_at = ? WHERE id = ?').run(now, tokenRow.id);
        return { webhook: toWebhook(webhook), tokenId: tokenRow.id };
    }

    // ---------- secrets (input type "secret", and the webhook's own HMAC secret) ----------

    setSecretInput(webhookId, name, value) {
        this.db.prepare(`INSERT INTO webhook_secrets (webhook_id, name, value_enc) VALUES (?, ?, ?)
            ON CONFLICT (webhook_id, name) DO UPDATE SET value_enc = excluded.value_enc`)
            .run(webhookId, name, encrypt(value));
    }

    getSecretInput(webhookId, name) {
        const row = this.db.prepare('SELECT value_enc FROM webhook_secrets WHERE webhook_id = ? AND name = ?').get(webhookId, name);
        return row ? decrypt(row.value_enc) : undefined;
    }

    /**
     * Fills in every 'secret'-type input's value from storage (resolveInputs() skips them on
     * purpose - see the comment there). Call after resolveInputs() succeeds, before running.
     * @returns {{ok:true}|{ok:false, error:string, input:string}}
     */
    resolveSecrets(webhookId, defs, values) {
        for (const def of defs) {
            if (def.type !== 'secret') continue;
            const stored = this.getSecretInput(webhookId, def.name);
            if (stored === undefined) {
                if (def.required) return { ok: false, error: 'Segredo não configurado.', input: def.name };
                if (def.default !== undefined) values[def.name] = def.default;
                continue;
            }
            values[def.name] = stored;
        }
        return { ok: true };
    }

    setHmacSecret(webhookId, secret) {
        this.db.prepare('UPDATE webhooks SET auth_mode = ?, hmac_secret = ?, updated_at = ? WHERE id = ?')
            .run(secret ? 'hmac' : 'bearer', secret ? encrypt(secret) : null, Date.now(), webhookId);
    }

    getHmacSecret(webhookId) {
        const row = this.db.prepare('SELECT hmac_secret FROM webhooks WHERE id = ?').get(webhookId);
        return row?.hmac_secret ? decrypt(row.hmac_secret) : undefined;
    }

    // ---------- runs ----------

    createRun({ id, webhookId, trigger, sourceIp, tokenId, values, startedAt }) {
        const webhook = this.db.prepare('SELECT inputs FROM webhooks WHERE id = ?').get(webhookId);
        const defs = webhook ? JSON.parse(webhook.inputs || '[]') : [];
        this.db.prepare(`INSERT INTO webhook_runs (id, webhook_id, trigger, source_ip, token_id, inputs, status, started_at)
            VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`)
            .run(id, webhookId, trigger, sourceIp || null, tokenId || null, JSON.stringify(maskValues(values, defs)), startedAt);
    }

    finishRun(runId, { status, exitCode, output, finishedAt }) {
        this.db.prepare('UPDATE webhook_runs SET status = ?, exit_code = ?, output = ?, finished_at = ? WHERE id = ?')
            .run(status, exitCode ?? null, output ? String(output).slice(0, MAX_ERROR) : null, finishedAt, runId);
    }

    runs(webhookId, limit = 20) {
        return this.db.prepare(`SELECT id, trigger, source_ip AS sourceIp, inputs, status, exit_code AS exitCode,
                output, started_at AS startedAt, finished_at AS finishedAt FROM webhook_runs
                WHERE webhook_id = ? ORDER BY started_at DESC LIMIT ?`)
            .all(webhookId, Math.min(Math.max(1, limit), 100))
            .map(r => ({ ...r, inputs: JSON.parse(r.inputs || '{}') }));
    }

    getRun(webhookId, runId) {
        const r = this.db.prepare(`SELECT id, trigger, source_ip AS sourceIp, inputs, status, exit_code AS exitCode,
                output, started_at AS startedAt, finished_at AS finishedAt FROM webhook_runs
                WHERE webhook_id = ? AND id = ?`).get(webhookId, runId);
        return r ? { ...r, inputs: JSON.parse(r.inputs || '{}') } : null;
    }

    /** Disparos nos últimos `windowMs` (rate limiting). */
    recentRunCount(webhookId, windowMs) {
        return this.db.prepare('SELECT COUNT(*) AS n FROM webhook_runs WHERE webhook_id = ? AND started_at > ?')
            .get(webhookId, Date.now() - windowMs).n;
    }
}

module.exports = WebhookStore;
