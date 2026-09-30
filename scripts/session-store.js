/**
 * session-store.js
 * SQLite persistence (node:sqlite, built into Node 22.13+) for terminal sessions:
 * tab metadata, order, the shell PID and a screen snapshot used after a server restart.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const COLUMNS = ['name', 'color', 'pinned', 'position', 'cwd', 'start_cwd', 'status',
    'pid', 'snapshot', 'updated_at', 'closed_at', 'url'];

class SessionStore {
    /** @param {string} file - database file path (directory is created if missing) */
    constructor(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS sessions (
                id          TEXT PRIMARY KEY,           -- UUID (PIDs get reused after restarts)
                name        TEXT NOT NULL,
                color       TEXT NOT NULL,
                pinned      INTEGER NOT NULL DEFAULT 0,
                position    INTEGER NOT NULL DEFAULT 0,
                cwd         TEXT,                       -- last known directory
                start_cwd   TEXT,                       -- directory requested at creation
                status      TEXT NOT NULL DEFAULT 'open', -- 'open' | 'closed'
                pid         INTEGER,                    -- current shell process, if running
                snapshot    TEXT,                       -- serialized screen (restart recovery)
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL,
                closed_at   INTEGER
            );
            CREATE INDEX IF NOT EXISTS sessions_status ON sessions(status, position);
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        `);
        // Columns added after the first release (databases created by 2.1.x lack them)
        const existing = new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name));
        if (!existing.has('kind')) this.db.exec(`ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'terminal'`);
        if (!existing.has('url')) this.db.exec('ALTER TABLE sessions ADD COLUMN url TEXT');
    }

    listOpen() {
        return this.db.prepare(`SELECT * FROM sessions WHERE status = 'open' ORDER BY position, created_at`).all();
    }

    listClosed(limit = 8) {
        return this.db.prepare(`SELECT id, name, color, cwd, start_cwd, closed_at, kind, url FROM sessions
            WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?`).all(limit);
    }

    get(id) {
        return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
    }

    insert(row) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO sessions (id, name, color, pinned, position, cwd, start_cwd,
            status, created_at, updated_at, kind, url) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
            .run(row.id, row.name, row.color, row.pinned ? 1 : 0, row.position,
                row.cwd || null, row.start_cwd || null, now, now, row.kind || 'terminal', row.url || null);
        return this.get(row.id);
    }

    /** Updates whitelisted columns only. */
    update(id, fields) {
        const keys = Object.keys(fields).filter(k => COLUMNS.includes(k));
        if (!keys.length) return this.get(id);
        const values = keys.map(k => (typeof fields[k] === 'boolean' ? Number(fields[k]) : fields[k]));
        if (!keys.includes('updated_at')) {
            keys.push('updated_at');
            values.push(Date.now());
        }
        this.db.prepare(`UPDATE sessions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
            .run(...values, id);
        return this.get(id);
    }

    /** Rewrites positions to match the given id order, atomically. */
    setOrder(ids) {
        const stmt = this.db.prepare('UPDATE sessions SET position = ? WHERE id = ?');
        this.transaction(() => ids.forEach((id, i) => stmt.run(i, id)));
    }

    /** Opens a gap after `afterId` so a new session can be inserted next to it. */
    positionAfter(afterId) {
        const open = this.listOpen();
        const index = afterId ? open.findIndex(s => s.id === afterId) : -1;
        if (index === -1) return open.length ? open[open.length - 1].position + 1 : 0;
        const stmt = this.db.prepare('UPDATE sessions SET position = position + 1 WHERE id = ?');
        this.transaction(() => open.slice(index + 1).forEach(s => stmt.run(s.id)));
        return open[index].position + 1;
    }

    close(id) {
        this.db.prepare(`UPDATE sessions SET status = 'closed', pid = NULL, closed_at = ?, updated_at = ?
            WHERE id = ?`).run(Date.now(), Date.now(), id);
        // Keep only the most recent closed sessions (the "recent" list)
        this.db.prepare(`DELETE FROM sessions WHERE status = 'closed' AND id NOT IN
            (SELECT id FROM sessions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 20)`).run();
    }

    forget(id) {
        this.db.prepare(`DELETE FROM sessions WHERE id = ? AND status = 'closed'`).run(id);
    }

    /** Monotonic counter for default names ("Term N") and tab colors. */
    nextCounter() {
        const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'counter'`).get();
        const next = (row ? Number(row.value) : 0) + 1;
        this.db.prepare(`INSERT INTO meta (key, value) VALUES ('counter', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(next));
        return next;
    }

    /** Small app settings kept with the sessions (e.g. agent UI preferences). */
    getMeta(key) {
        const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    setMeta(key, value) {
        this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
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
}

module.exports = SessionStore;
