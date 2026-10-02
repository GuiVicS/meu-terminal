/**
 * notes-store.js
 * Notes (Markdown title + body, tags, pin, trash) saved as plain .md files in a folder, one file
 * per note, Obsidian-style: the title *is* the filename, metadata lives in YAML frontmatter.
 * Trashed notes just live in a ".trash" subfolder until purged or restored.
 *
 * This on purpose instead of a SQLite table: notes are readable (and editable) directly on disk
 * by an agent, any other tool, or the user over SFTP - no DB client needed - and they live
 * wherever the caller points NOTES_DIR, same volume as everything else that must survive a deploy.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_TITLE = 200;
const MAX_BODY = 200 * 1024;
const MAX_TAGS = 20;
const MAX_TAG = 30;
const PREVIEW = 160;
const TRASH_DIR_NAME = '.trash';
const UNTITLED = 'Sem título';

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

// ---------- filenames (the title *is* the filename) ----------

/** Strips characters that are invalid (or awkward) in a filename on any common OS. */
function sanitizeFileName(title) {
    let name = String(title ?? '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
    if (!name) name = UNTITLED;
    return name.slice(0, 150);
}

/** `<base>.md`, or `<base> (2).md` etc. if that name is taken - `keep` lets a note "collide" with its own current file. */
function uniqueFileName(dir, base, keep) {
    let name = `${base}.md`;
    for (let n = 2; name !== keep && fs.existsSync(path.join(dir, name)); n++) name = `${base} (${n}).md`;
    return name;
}

// ---------- frontmatter (hand-rolled: fixed, small schema - no need for a YAML dependency) ----------

function serialize(meta, body) {
    const tags = meta.tags.length ? `[${meta.tags.map(t => JSON.stringify(t)).join(', ')}]` : '[]';
    const lines = [
        '---',
        `id: ${meta.id}`,
        `tags: ${tags}`,
        `pinned: ${meta.pinned ? 'true' : 'false'}`,
        `created: ${new Date(meta.createdAt).toISOString()}`,
        `updated: ${new Date(meta.updatedAt).toISOString()}`,
    ];
    if (meta.deletedAt) lines.push(`deleted: ${new Date(meta.deletedAt).toISOString()}`);
    lines.push('---', '');
    return `${lines.join('\n')}${body}`;
}

function parseFrontmatter(text) {
    const meta = {};
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const kv = /^(\w+):[ \t]*(.*)$/.exec(lines[i]);
        if (!kv) continue;
        const [, key, rawVal] = kv;
        const val = rawVal.trim();
        if (key === 'tags') {
            const inline = /^\[(.*)\]$/.exec(val);
            if (inline) {
                meta.tags = inline[1].trim() ? inline[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')) : [];
            } else {
                const tags = [];
                while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
                    tags.push(lines[++i].replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
                }
                meta.tags = tags;
            }
        } else if (key === 'pinned') {
            meta.pinned = val === 'true';
        } else {
            meta[key] = val.replace(/^["']|["']$/g, '');
        }
    }
    return meta;
}

/** A .md file -> {id, title, body, tags, pinned, createdAt, updatedAt, deletedAt} + file (its current name), or null if not one of ours. */
function parseNote(raw, file) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!m) return null;
    const meta = parseFrontmatter(m[1]);
    if (!meta.id) return null;
    return {
        file,
        id: meta.id,
        title: file.replace(/\.md$/i, ''),
        body: m[2],
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        pinned: !!meta.pinned,
        createdAt: meta.created ? Date.parse(meta.created) : Date.now(),
        updatedAt: meta.updated ? Date.parse(meta.updated) : Date.now(),
        deletedAt: meta.deleted ? Date.parse(meta.deleted) : null,
    };
}

/** Every note file in `dir` (not recursive - .trash lives inside but is read separately). */
function scanDir(dir) {
    let names;
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    const out = [];
    for (const file of names) {
        if (!file.endsWith('.md')) continue;
        try {
            const note = parseNote(fs.readFileSync(path.join(dir, file), 'utf8'), file);
            if (note) out.push(note);
        } catch { /* unreadable file: skip rather than fail the whole list */ }
    }
    return out;
}

function toSummary(n) {
    return {
        id: n.id, title: n.title, preview: n.body.slice(0, PREVIEW), tags: n.tags, pinned: n.pinned,
        createdAt: n.createdAt, updatedAt: n.updatedAt, deletedAt: n.deletedAt, tasks: taskStats(n.body),
    };
}

function toFull(n) {
    return { id: n.id, title: n.title, body: n.body, tags: n.tags, pinned: n.pinned, createdAt: n.createdAt, updatedAt: n.updatedAt, deletedAt: n.deletedAt };
}

class NotesStore {
    /** @param {string} dir - folder to keep notes in (created if missing); trashed notes go in `<dir>/.trash` */
    constructor(dir) {
        this.dir = dir;
        this.trashDir = path.join(dir, TRASH_DIR_NAME);
        fs.mkdirSync(this.dir, { recursive: true });
        fs.mkdirSync(this.trashDir, { recursive: true });
    }

    _find(id, { liveOnly = false, trashOnly = false } = {}) {
        if (!trashOnly) {
            const hit = scanDir(this.dir).find(n => n.id === id);
            if (hit) return hit;
        }
        if (!liveOnly) {
            const hit = scanDir(this.trashDir).find(n => n.id === id);
            if (hit) return hit;
        }
        return null;
    }

    /**
     * Light rows for the list (body is cut to a preview).
     * @param {{q?: string, tag?: string, trash?: boolean}} opts
     */
    list({ q, tag, trash } = {}) {
        let entries = scanDir(trash ? this.trashDir : this.dir);
        const query = typeof q === 'string' ? q.trim().toLowerCase().slice(0, 100) : '';
        if (query) {
            entries = entries.filter(n => n.title.toLowerCase().includes(query) || n.body.toLowerCase().includes(query)
                || n.tags.some(t => t.toLowerCase().includes(query)));
        }
        if (typeof tag === 'string' && tag.trim()) {
            const needle = tag.trim().toLowerCase();
            entries = entries.filter(n => n.tags.some(t => t.toLowerCase() === needle));
        }
        entries.sort(trash
            ? (a, b) => b.deletedAt - a.deletedAt
            : (a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
        return entries.map(toSummary);
    }

    trashCount() {
        return scanDir(this.trashDir).length;
    }

    /** Every tag in use (outside the trash) with its note count, for the tag filter. */
    tags() {
        const counts = new Map(); // lowercase -> { tag, count }
        for (const n of scanDir(this.dir)) {
            for (const t of n.tags) {
                const key = t.toLowerCase();
                const cur = counts.get(key) || { tag: t, count: 0 };
                cur.count++;
                counts.set(key, cur);
            }
        }
        return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }

    get(id) {
        const hit = this._find(id);
        return hit ? toFull(hit) : null;
    }

    create({ title, body, tags, pinned } = {}) {
        const id = crypto.randomUUID();
        const now = Date.now();
        const file = uniqueFileName(this.dir, sanitizeFileName(clean(title, MAX_TITLE).trim()));
        const meta = { id, tags: cleanTags(tags), pinned: !!pinned, createdAt: now, updatedAt: now, deletedAt: null };
        fs.writeFileSync(path.join(this.dir, file), serialize(meta, clean(body, MAX_BODY)));
        return this.get(id);
    }

    /**
     * Patch a note. When `baseUpdatedAt` is given and differs from what is stored, the note was
     * changed elsewhere in the meantime: nothing is written and the current note is returned.
     * A title change renames the file (colliding with another note's name picks " (2)" etc.).
     * @returns {{note: object}|{conflict: true, note: object}|null} null when missing or in the trash
     */
    update(id, patch = {}, baseUpdatedAt) {
        const current = this._find(id, { liveOnly: true });
        if (!current) return null;
        if (baseUpdatedAt !== undefined && baseUpdatedAt !== current.updatedAt) {
            return { conflict: true, note: toFull(current) };
        }
        const title = patch.title !== undefined ? clean(patch.title, MAX_TITLE).trim() : current.title;
        const body = patch.body !== undefined ? clean(patch.body, MAX_BODY) : current.body;
        const tags = patch.tags !== undefined ? cleanTags(patch.tags) : current.tags;
        const pinned = patch.pinned !== undefined ? !!patch.pinned : current.pinned;
        const updatedAt = Math.max(Date.now(), current.updatedAt + 1); // strictly increasing: a stale baseUpdatedAt is always detectable

        let file = current.file;
        const wantedBase = sanitizeFileName(title);
        if (`${wantedBase}.md` !== current.file && wantedBase !== current.title) {
            file = uniqueFileName(this.dir, wantedBase, current.file);
            if (file !== current.file) fs.renameSync(path.join(this.dir, current.file), path.join(this.dir, file));
        }
        const meta = { id, tags, pinned, createdAt: current.createdAt, updatedAt, deletedAt: null };
        fs.writeFileSync(path.join(this.dir, file), serialize(meta, body));
        return { note: this.get(id) };
    }

    /** Move to the trash (unpinned, so it does not stay on top once restored by accident). */
    trash(id) {
        const current = this._find(id, { liveOnly: true });
        if (!current) return false;
        const meta = { id, tags: current.tags, pinned: false, createdAt: current.createdAt, updatedAt: current.updatedAt, deletedAt: Date.now() };
        fs.writeFileSync(path.join(this.dir, current.file), serialize(meta, current.body));
        const destFile = uniqueFileName(this.trashDir, current.file.replace(/\.md$/i, ''));
        fs.renameSync(path.join(this.dir, current.file), path.join(this.trashDir, destFile));
        return true;
    }

    restore(id) {
        const current = this._find(id, { trashOnly: true });
        if (!current) return false;
        const meta = { id, tags: current.tags, pinned: current.pinned, createdAt: current.createdAt, updatedAt: Date.now(), deletedAt: null };
        fs.writeFileSync(path.join(this.trashDir, current.file), serialize(meta, current.body));
        const destFile = uniqueFileName(this.dir, current.file.replace(/\.md$/i, ''));
        fs.renameSync(path.join(this.trashDir, current.file), path.join(this.dir, destFile));
        return true;
    }

    /** Delete for good; only notes already in the trash. */
    purge(id) {
        const current = this._find(id, { trashOnly: true });
        if (!current) return false;
        fs.unlinkSync(path.join(this.trashDir, current.file));
        return true;
    }

    emptyTrash() {
        const entries = scanDir(this.trashDir);
        for (const n of entries) fs.unlinkSync(path.join(this.trashDir, n.file));
        return entries.length;
    }
}

module.exports = NotesStore;
