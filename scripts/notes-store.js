/**
 * notes-store.js
 * Notes (Markdown title + body, tags, pin, trash) saved on the server so every device shows the same notes.
 * Shares the SQLite connection opened by SessionStore.
 */
const crypto = require('crypto');

const MAX_TITLE = 200;
const MAX_BODY = 200 * 1024;
const MAX_TAGS = 20;
const MAX_TAG = 30;
const PREVIEW = 160;

function clean(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Trim, drop empties and case-insensitive duplicates, cap count and length. */
function cleanTags(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        const tag = clean(raw, MAX_TAG).trim();
        const key = tag.toLowerCase();
        if (!tag || seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/** Escape LIKE wildcards so a search for "100%" matches literally. */
function likePattern(q) {
    return `%${q.replace(/[\\%_]/g, '\\$&')}%`;
}

function parseTags(json) {
    try {
        const tags = JSON.parse(json);
        return Array.isArray(tags) ? tags : [];
    } catch {
        return [];
    }
}

const TASK_LINE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\][ \t]/gm;

/** Checklist progress for the note card's progress bar; null when the note has no task list. */
function taskStats(body) {
    let total = 0;
    let done = 0;
    for (const m of body.matchAll(TASK_LINE)) {
        total++;
        if (m[1] !== ' ') done++;
    }
    return total ? { total, done } : null;
}

function toNote(row) {
    return {
        id: row.id,
        title: row.title,
        body: row.body,
        tags: parseTags(row.tags),
        pinned: !!row.pinned,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        deletedAt: row.deleted_at,
    };
}

class NotesStore {
    /** @param {import('node:sqlite').DatabaseSync} db */
    constructor(db) {
        this.db = db;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS notes (
                id          TEXT PRIMARY KEY,
                title       TEXT NOT NULL DEFAULT '',
                body        TEXT NOT NULL DEFAULT '',
                tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
                pinned      INTEGER NOT NULL DEFAULT 0,
                created_at  INTEGER NOT NULL,
                updated_at  INTEGER NOT NULL,
                deleted_at  INTEGER                      -- set = in the trash
            );
            CREATE INDEX IF NOT EXISTS notes_updated ON notes (deleted_at, pinned, updated_at);
        `);
    }

    /**
     * Light rows for the list (body is cut to a preview).
     * @param {{q?: string, tag?: string, trash?: boolean}} opts
     */
    list({ q, tag, trash } = {}) {
        const where = [trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL'];
        const args = [];
        const query = typeof q === 'string' ? q.trim().slice(0, 100) : '';
        if (query) {
            where.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
                OR EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE value LIKE ? ESCAPE '\\'))`);
            const pattern = likePattern(query);
            args.push(pattern, pattern, pattern);
        }
        if (typeof tag === 'string' && tag.trim()) {
            where.push('EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE lower(value) = lower(?))');
            args.push(tag.trim());
        }
        const order = trash ? 'deleted_at DESC' : 'pinned DESC, updated_at DESC';
        return this.db.prepare(`SELECT id, title, body, tags, pinned,
                created_at, updated_at, deleted_at FROM notes WHERE ${where.join(' AND ')} ORDER BY ${order}`)
            .all(...args)
            .map(r => ({
                id: r.id, title: r.title, preview: r.body.slice(0, PREVIEW), tags: parseTags(r.tags), pinned: !!r.pinned,
                createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at, tasks: taskStats(r.body),
            }));
    }

    trashCount() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM notes WHERE deleted_at IS NOT NULL').get().n;
    }

    /** Every tag in use (outside the trash) with its note count, for the tag filter. */
    tags() {
        return this.db.prepare(`SELECT value AS tag, COUNT(*) AS count FROM notes, json_each(notes.tags)
            WHERE deleted_at IS NULL GROUP BY lower(value) ORDER BY count DESC, lower(value)`).all();
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
        return row ? toNote(row) : null;
    }

    create({ title, body, tags, pinned } = {}) {
        const id = crypto.randomUUID();
        const now = Date.now();
        this.db.prepare(`INSERT INTO notes (id, title, body, tags, pinned, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(id, clean(title, MAX_TITLE).trim(), clean(body, MAX_BODY), JSON.stringify(cleanTags(tags)),
                pinned ? 1 : 0, now, now);
        return this.get(id);
    }

    /**
     * Patch a note. When `baseUpdatedAt` is given and differs from what is stored, the note was
     * changed elsewhere in the meantime: nothing is written and the current note is returned.
     * @returns {{note: object}|{conflict: true, note: object}|null} null when missing or in the trash
     */
    update(id, patch = {}, baseUpdatedAt) {
        const current = this.db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id);
        if (!current) return null;
        if (baseUpdatedAt !== undefined && baseUpdatedAt !== current.updated_at) {
            return { conflict: true, note: toNote(current) };
        }
        const title = patch.title !== undefined ? clean(patch.title, MAX_TITLE).trim() : current.title;
        const body = patch.body !== undefined ? clean(patch.body, MAX_BODY) : current.body;
        const tags = patch.tags !== undefined ? JSON.stringify(cleanTags(patch.tags)) : current.tags;
        const pinned = patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : current.pinned;
        // Strictly increasing, so a stale `baseUpdatedAt` is always detectable even within one millisecond.
        const updatedAt = Math.max(Date.now(), current.updated_at + 1);
        this.db.prepare('UPDATE notes SET title = ?, body = ?, tags = ?, pinned = ?, updated_at = ? WHERE id = ?')
            .run(title, body, tags, pinned, updatedAt, id);
        return { note: this.get(id) };
    }

    /** Move to the trash (unpinned, so it does not stay on top once restored by accident). */
    trash(id) {
        return this.db.prepare('UPDATE notes SET deleted_at = ?, pinned = 0 WHERE id = ? AND deleted_at IS NULL')
            .run(Date.now(), id).changes > 0;
    }

    restore(id) {
        return this.db.prepare('UPDATE notes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL')
            .run(Date.now(), id).changes > 0;
    }

    /** Delete for good; only notes already in the trash. */
    purge(id) {
        return this.db.prepare('DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0;
    }

    emptyTrash() {
        return Number(this.db.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL').run().changes);
    }
}

module.exports = NotesStore;
