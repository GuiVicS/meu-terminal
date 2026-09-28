/**
 * command-store.js
 * Quick commands ("snippets") saved on the server so every device shows the same list.
 * Shares the SQLite connection opened by SessionStore.
 */
const crypto = require('crypto');

const MAX_LABEL = 60;
const MAX_COMMAND = 4000;

function clean(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

class CommandStore {
    /** @param {import('node:sqlite').DatabaseSync} db */
    constructor(db) {
        this.db = db;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS quick_commands (
                id          TEXT PRIMARY KEY,
                label       TEXT NOT NULL,
                command     TEXT NOT NULL,
                run         INTEGER NOT NULL DEFAULT 0,  -- 1 = press Enter after typing it
                position    INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL
            );
        `);
    }

    list() {
        return this.db.prepare('SELECT id, label, command, run FROM quick_commands ORDER BY position, created_at')
            .all()
            .map(row => ({ ...row, run: !!row.run }));
    }

    /** @returns {object|null} the created command, or null when invalid */
    create({ label, command, run }) {
        const cmd = clean(command, MAX_COMMAND);
        if (!cmd.trim()) return null;
        const id = crypto.randomUUID();
        const last = this.db.prepare('SELECT MAX(position) AS p FROM quick_commands').get();
        this.db.prepare(`INSERT INTO quick_commands (id, label, command, run, position, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`)
            .run(id, clean(label, MAX_LABEL).trim() || cmd.trim().slice(0, MAX_LABEL), cmd, run ? 1 : 0,
                (last && last.p !== null ? last.p : -1) + 1, Date.now());
        return this.list().find(c => c.id === id);
    }

    update(id, { label, command, run }) {
        const current = this.db.prepare('SELECT * FROM quick_commands WHERE id = ?').get(id);
        if (!current) return null;
        const cmd = command !== undefined ? clean(command, MAX_COMMAND) : current.command;
        if (!cmd.trim()) return null;
        const name = label !== undefined ? clean(label, MAX_LABEL).trim() : current.label;
        this.db.prepare('UPDATE quick_commands SET label = ?, command = ?, run = ? WHERE id = ?')
            .run(name || cmd.trim().slice(0, MAX_LABEL), cmd, run !== undefined ? (run ? 1 : 0) : current.run, id);
        return this.list().find(c => c.id === id);
    }

    remove(id) {
        return this.db.prepare('DELETE FROM quick_commands WHERE id = ?').run(id).changes > 0;
    }
}

module.exports = CommandStore;
