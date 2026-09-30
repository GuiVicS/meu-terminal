/**
 * agent-store.js
 * SQLite persistence for agent UI sessions: session metadata, the ordered event log
 * (monotonic seq per session, used for replay after reconnecting) and permission decisions.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SESSION_COLUMNS = ['title', 'status', 'mode', 'model', 'acp_session_id', 'capabilities',
    'updated_at', 'closed_at', 'last_seq'];

function parseJson(text, fallback) {
    if (text == null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

class AgentStore {
    /** @param {string} file - database file (shared with session-store.js is fine: WAL mode) */
    constructor(file) {
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id              TEXT PRIMARY KEY,       -- our UUID (stable across agent restarts)
                agent           TEXT NOT NULL,          -- registry id: claude | opencode | codex...
                cwd             TEXT NOT NULL,
                title           TEXT,
                status          TEXT NOT NULL,          -- see events.js STATES, plus 'closed'
                mode            TEXT,
                model           TEXT,
                acp_session_id  TEXT,                   -- the agent's own id (for resume/load)
                capabilities    TEXT,                   -- JSON
                last_seq        INTEGER NOT NULL DEFAULT 0,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                closed_at       INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_events (
                session_id  TEXT NOT NULL,
                seq         INTEGER NOT NULL,
                type        TEXT NOT NULL,
                at          INTEGER NOT NULL,
                data        TEXT NOT NULL,              -- JSON
                PRIMARY KEY (session_id, seq)
            );
            CREATE TABLE IF NOT EXISTS agent_permissions (
                id           TEXT PRIMARY KEY,
                session_id   TEXT NOT NULL,
                request      TEXT NOT NULL,             -- JSON (permission.request data)
                status       TEXT NOT NULL,             -- pending | answered | expired
                outcome      TEXT,                      -- selected | cancelled
                option_id    TEXT,
                answered_by  TEXT,                      -- who approved (audit)
                created_at   INTEGER NOT NULL,
                answered_at  INTEGER
            );
            CREATE INDEX IF NOT EXISTS agent_permissions_pending ON agent_permissions(session_id, status);
        `);
    }

    // ---------- sessions ----------

    insertSession({ id, agent, cwd, title = null, status = 'starting', mode = null, model = null }) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO agent_sessions (id, agent, cwd, title, status, mode, model, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, agent, cwd, title, status, mode, model, now, now);
        return this.getSession(id);
    }

    getSession(id) {
        const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id);
        return row ? { ...row, capabilities: parseJson(row.capabilities, {}) } : null;
    }

    listSessions({ includeClosed = false, limit = 50 } = {}) {
        const rows = includeClosed
            ? this.db.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?').all(limit)
            : this.db.prepare(`SELECT * FROM agent_sessions WHERE status != 'closed' ORDER BY updated_at DESC LIMIT ?`).all(limit);
        return rows.map(row => ({ ...row, capabilities: parseJson(row.capabilities, {}) }));
    }

    /** Updates whitelisted columns only. */
    updateSession(id, fields) {
        const keys = Object.keys(fields).filter(k => SESSION_COLUMNS.includes(k));
        if (!keys.length) return this.getSession(id);
        const values = keys.map(k => (k === 'capabilities' ? JSON.stringify(fields[k]) : fields[k]));
        if (!keys.includes('updated_at')) {
            keys.push('updated_at');
            values.push(Date.now());
        }
        this.db.prepare(`UPDATE agent_sessions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
            .run(...values, id);
        return this.getSession(id);
    }

    // ---------- events ----------

    /**
     * Appends an event and returns the full envelope. seq comes from agent_sessions.last_seq
     * inside a transaction, so it stays gap-free and monotonic even across server restarts.
     */
    appendEvent(sessionId, type, data) {
        const at = Date.now();
        let seq;
        this.transaction(() => {
            this.db.prepare('UPDATE agent_sessions SET last_seq = last_seq + 1, updated_at = ? WHERE id = ?').run(at, sessionId);
            const row = this.db.prepare('SELECT last_seq FROM agent_sessions WHERE id = ?').get(sessionId);
            if (!row) throw new Error(`Unknown agent session ${sessionId}`);
            seq = row.last_seq;
            this.db.prepare('INSERT INTO agent_events (session_id, seq, type, at, data) VALUES (?, ?, ?, ?, ?)')
                .run(sessionId, seq, type, at, JSON.stringify(data));
        });
        return { sessionId, seq, type, at, data };
    }

    /** Events after `sinceSeq` (exclusive), oldest first. */
    eventsSince(sessionId, sinceSeq = 0, limit = 5000) {
        return this.db.prepare(`SELECT seq, type, at, data FROM agent_events
            WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(sessionId, sinceSeq, limit)
            .map(row => ({ sessionId, seq: row.seq, type: row.type, at: row.at, data: parseJson(row.data, {}) }));
    }

    // ---------- permissions ----------

    insertPermission({ id, sessionId, request }) {
        this.db.prepare(`INSERT INTO agent_permissions (id, session_id, request, status, created_at)
            VALUES (?, ?, ?, 'pending', ?)`).run(id, sessionId, JSON.stringify(request), Date.now());
    }

    /** Marks a pending permission as answered. Returns false if it was not pending anymore. */
    answerPermission(id, { outcome, optionId = null, answeredBy = null }) {
        const result = this.db.prepare(`UPDATE agent_permissions SET status = 'answered', outcome = ?, option_id = ?,
            answered_by = ?, answered_at = ? WHERE id = ? AND status = 'pending'`)
            .run(outcome, optionId, answeredBy, Date.now(), id);
        return result.changes > 0;
    }

    pendingPermissions(sessionId) {
        return this.db.prepare(`SELECT id, request, created_at FROM agent_permissions
            WHERE session_id = ? AND status = 'pending' ORDER BY created_at`).all(sessionId)
            .map(row => ({ id: row.id, request: parseJson(row.request, {}), createdAt: row.created_at }));
    }

    /** Pending permissions of a session whose agent died can never be answered. */
    expirePermissions(sessionId) {
        this.db.prepare(`UPDATE agent_permissions SET status = 'expired', answered_at = ?
            WHERE session_id = ? AND status = 'pending'`).run(Date.now(), sessionId);
    }

    /**
     * After a server restart no agent process survives: sessions that were running are
     * marked stopped (they can be resumed) and their pending permissions expire.
     */
    recoverAfterRestart() {
        const now = Date.now();
        this.transaction(() => {
            this.db.prepare(`UPDATE agent_permissions SET status = 'expired', answered_at = ? WHERE status = 'pending'`).run(now);
            this.db.prepare(`UPDATE agent_sessions SET status = 'stopped', updated_at = ?
                WHERE status NOT IN ('closed', 'stopped')`).run(now);
        });
    }

    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            fn();
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    close() {
        this.db.close();
    }
}

module.exports = AgentStore;
