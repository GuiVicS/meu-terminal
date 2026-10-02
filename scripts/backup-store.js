/**
 * backup-store.js
 * Config and run history for the automatic backup (server data -> rclone remote).
 * One config row (id = 1); shares the SQLite connection opened by SessionStore.
 */
const MAX_TEXT = 200;
const MAX_ERROR = 2000;

function clean(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function clampInt(value, min, max) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}

function cleanPaths(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        const p = clean(raw, MAX_TEXT).trim();
        if (!p || seen.has(p)) continue;
        seen.add(p);
        out.push(p);
        if (out.length >= 20) break;
    }
    return out;
}

function parsePaths(json) {
    try {
        const paths = JSON.parse(json);
        return Array.isArray(paths) ? paths : [];
    } catch {
        return [];
    }
}

function toConfig(row) {
    return {
        enabled: !!row.enabled,
        remote: row.remote,
        remotePath: row.remote_path,
        intervalHours: row.interval_hours,
        keepLast: row.keep_last,
        paths: parsePaths(row.paths),
        lastRunAt: row.last_run_at,
        lastStatus: row.last_status,
        lastError: row.last_error,
        lastSizeBytes: row.last_size_bytes,
    };
}

class BackupStore {
    /** @param {import('node:sqlite').DatabaseSync} db */
    constructor(db) {
        this.db = db;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS backup_config (
                id              INTEGER PRIMARY KEY CHECK (id = 1),
                enabled         INTEGER NOT NULL DEFAULT 0,
                remote          TEXT NOT NULL DEFAULT '',
                remote_path     TEXT NOT NULL DEFAULT 'meuterminal-backup',
                interval_hours  INTEGER NOT NULL DEFAULT 24,
                keep_last       INTEGER NOT NULL DEFAULT 7,
                paths           TEXT NOT NULL DEFAULT '[]',
                last_run_at     INTEGER,
                last_status     TEXT,
                last_error      TEXT,
                last_size_bytes INTEGER
            );
            CREATE TABLE IF NOT EXISTS backup_runs (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                trigger      TEXT NOT NULL,   -- 'manual' | 'scheduled'
                started_at   INTEGER NOT NULL,
                finished_at  INTEGER,
                status       TEXT NOT NULL,   -- 'ok' | 'error'
                size_bytes   INTEGER,
                error        TEXT
            );
        `);
        this.db.prepare('INSERT OR IGNORE INTO backup_config (id) VALUES (1)').run();
    }

    get() {
        return toConfig(this.db.prepare('SELECT * FROM backup_config WHERE id = 1').get());
    }

    update(patch = {}) {
        const current = this.db.prepare('SELECT * FROM backup_config WHERE id = 1').get();
        const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : current.enabled;
        const remote = patch.remote !== undefined ? clean(patch.remote, 60).trim() : current.remote;
        const remotePath = patch.remotePath !== undefined
            ? clean(patch.remotePath, MAX_TEXT).trim().replace(/^\/+|\/+$/g, '') || 'meuterminal-backup'
            : current.remote_path;
        const intervalHours = patch.intervalHours !== undefined ? clampInt(patch.intervalHours, 1, 24 * 30) : current.interval_hours;
        const keepLast = patch.keepLast !== undefined ? clampInt(patch.keepLast, 0, 365) : current.keep_last;
        const paths = patch.paths !== undefined ? JSON.stringify(cleanPaths(patch.paths)) : current.paths;
        this.db.prepare(`UPDATE backup_config SET enabled = ?, remote = ?, remote_path = ?, interval_hours = ?,
                keep_last = ?, paths = ? WHERE id = 1`)
            .run(enabled, remote, remotePath, intervalHours, keepLast, paths);
        return this.get();
    }

    /** Records a run and updates the config's "last" fields. @returns the run id */
    recordRun({ trigger, status, sizeBytes, error, startedAt, finishedAt }) {
        const errText = error ? String(error).slice(0, MAX_ERROR) : null;
        const { lastInsertRowid } = this.db.prepare(`INSERT INTO backup_runs
                (trigger, started_at, finished_at, status, size_bytes, error) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(trigger, startedAt, finishedAt, status, sizeBytes ?? null, errText);
        this.db.prepare(`UPDATE backup_config SET last_run_at = ?, last_status = ?, last_error = ?,
                last_size_bytes = ? WHERE id = 1`)
            .run(finishedAt, status, errText, sizeBytes ?? null);
        // Keep the history from growing forever
        this.db.prepare(`DELETE FROM backup_runs WHERE id NOT IN
                (SELECT id FROM backup_runs ORDER BY started_at DESC LIMIT 50)`).run();
        return lastInsertRowid;
    }

    history(limit = 20) {
        return this.db.prepare(`SELECT trigger, started_at, finished_at, status, size_bytes, error
                FROM backup_runs ORDER BY started_at DESC LIMIT ?`)
            .all(clampInt(limit, 1, 50))
            .map(r => ({
                trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at,
                status: r.status, sizeBytes: r.size_bytes, error: r.error,
            }));
    }
}

module.exports = BackupStore;
