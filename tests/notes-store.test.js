const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const NotesStore = require('../scripts/notes-store');

/** A DB with the old (pre file-storage) `notes` table, pre-populated with `rows`. */
function legacyDb(rows) {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT, body TEXT, tags TEXT,
        pinned INTEGER, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER)`);
    const insert = db.prepare(`INSERT INTO notes (id, title, body, tags, pinned, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) insert.run(r.id, r.title, r.body, JSON.stringify(r.tags || []), r.pinned ? 1 : 0, r.createdAt, r.updatedAt, r.deletedAt || null);
    return db;
}

const tmpDirs = [];
const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-notes-'));
    tmpDirs.push(dir);
    return new NotesStore(dir);
};

test.after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('create trims the title, normalizes tags and stores the body as is', () => {
    const s = make();
    const n = s.create({ title: '  Ideias  ', body: '# oi', tags: ['Casa', 'casa', ' ', 'Trabalho'], pinned: 1 });
    assert.equal(n.title, 'Ideias');
    assert.equal(n.body, '# oi');
    assert.deepEqual(n.tags, ['Casa', 'Trabalho']);
    assert.equal(n.pinned, true);
    assert.equal(n.deletedAt, null);
});

test('a note is a real .md file named after its title, with YAML frontmatter', () => {
    const s = make();
    const n = s.create({ title: 'Minha nota', body: 'Olá mundo', tags: ['x'] });
    const file = path.join(s.dir, 'Minha nota.md');
    assert.ok(fs.existsSync(file));
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /^---\nid: /);
    assert.match(raw, new RegExp(`id: ${n.id}`));
    assert.match(raw, /Olá mundo$/);
});

test('limits: title, body and tag count are capped', () => {
    const s = make();
    const n = s.create({ title: 'x'.repeat(500), body: 'y'.repeat(300 * 1024), tags: Array.from({ length: 40 }, (_, i) => `t${i}`) });
    assert.equal(n.title.length, 150);
    assert.equal(n.body.length, 200 * 1024);
    assert.equal(n.tags.length, 20);
});

test('list: pinned first, then most recently updated; body is cut to a preview', async () => {
    const s = make();
    const a = s.create({ title: 'a', body: 'z'.repeat(1000) });
    const b = s.create({ title: 'b' });
    const c = s.create({ title: 'c', pinned: true });
    s.update(a.id, { title: 'a2' });
    const rows = s.list();
    assert.deepEqual(rows.map(r => r.title), ['c', 'a2', 'b']);
    assert.equal(rows[1].preview.length, 160);
    assert.equal('body' in rows[1], false);
    assert.ok(b && c);
});

test('update: changing the title renames the file; a collision picks "(2)"', () => {
    const s = make();
    const a = s.create({ title: 'Nota' });
    s.create({ title: 'Outra' });
    assert.ok(fs.existsSync(path.join(s.dir, 'Nota.md')));
    s.update(a.id, { title: 'Outra' });
    assert.equal(s.get(a.id).title, 'Outra (2)');
    assert.ok(fs.existsSync(path.join(s.dir, 'Outra (2).md')));
    assert.ok(!fs.existsSync(path.join(s.dir, 'Nota.md')));
});

test('list: tasks counts the checklist, or null when the note has none', () => {
    const s = make();
    s.create({ title: 'sem checklist', body: 'só texto' });
    s.create({ title: 'com checklist', body: '- [ ] a\n- [x] b\n- [X] c\n* [ ] d\n1. [x] e' });
    const rows = s.list();
    const byTitle = Object.fromEntries(rows.map(r => [r.title, r.tasks]));
    assert.equal(byTitle['sem checklist'], null);
    assert.deepEqual(byTitle['com checklist'], { total: 5, done: 3 });
});

test('search matches title, body and tags, case-insensitively', () => {
    const s = make();
    s.create({ title: 'Compras', body: 'leite e pão' });
    s.create({ title: 'Meta', body: 'chegar a 100% do plano' });
    s.create({ title: 'Outra', tags: ['viagem'] });
    assert.deepEqual(s.list({ q: 'leite' }).map(r => r.title), ['Compras']);
    assert.deepEqual(s.list({ q: 'compras' }).map(r => r.title), ['Compras']);
    assert.deepEqual(s.list({ q: 'viag' }).map(r => r.title), ['Outra']);
    assert.deepEqual(s.list({ q: '100%' }).map(r => r.title), ['Meta']);
    assert.deepEqual(s.list({ q: 'nada aqui' }), []);
});

test('tag filter is case-insensitive and tags() counts notes outside the trash', () => {
    const s = make();
    s.create({ title: '1', tags: ['Casa'] });
    const two = s.create({ title: '2', tags: ['casa', 'Ideia'] });
    assert.deepEqual(s.list({ tag: 'CASA' }).map(r => r.title).sort(), ['1', '2']);
    assert.deepEqual(s.tags().map(t => [t.tag.toLowerCase(), t.count]), [['casa', 2], ['ideia', 1]]);
    s.trash(two.id);
    assert.deepEqual(s.tags().map(t => [t.tag.toLowerCase(), t.count]), [['casa', 1]]);
});

test('update patches only given fields and bumps updatedAt strictly', () => {
    const s = make();
    const n = s.create({ title: 'a', body: 'b', tags: ['x'] });
    const { note } = s.update(n.id, { body: 'novo' });
    assert.equal(note.title, 'a');
    assert.equal(note.body, 'novo');
    assert.deepEqual(note.tags, ['x']);
    assert.ok(note.updatedAt > n.updatedAt);
    assert.equal(s.update('nope', { body: 'x' }), null);
});

test('update with a stale baseUpdatedAt returns a conflict and writes nothing', () => {
    const s = make();
    const n = s.create({ title: 'a', body: 'um' });
    const first = s.update(n.id, { body: 'dois' }, n.updatedAt);
    assert.equal(first.conflict, undefined);
    const stale = s.update(n.id, { body: 'tres' }, n.updatedAt);
    assert.equal(stale.conflict, true);
    assert.equal(stale.note.body, 'dois');
    assert.equal(s.get(n.id).body, 'dois');
});

test('trash, restore, purge and emptyTrash', () => {
    const s = make();
    const a = s.create({ title: 'a', pinned: true });
    const b = s.create({ title: 'b' });
    assert.equal(s.purge(a.id), false, 'a live note cannot be purged');
    assert.equal(s.trash(a.id), true);
    assert.equal(s.trash(a.id), false, 'already in the trash');
    assert.equal(s.update(a.id, { title: 'x' }), null, 'trashed notes are read-only');
    assert.deepEqual(s.list().map(r => r.title), ['b']);
    assert.deepEqual(s.list({ trash: true }).map(r => r.title), ['a']);
    assert.equal(s.get(a.id).pinned, false);
    assert.equal(s.restore(a.id), true);
    assert.deepEqual(s.list().map(r => r.title).sort(), ['a', 'b']);
    s.trash(a.id);
    s.trash(b.id);
    assert.equal(s.trashCount(), 2);
    assert.equal(s.emptyTrash(), 2);
    assert.equal(s.trashCount(), 0);
    assert.deepEqual(s.list({ trash: true }), []);
});

test('migrateFromSqlite: imports live and trashed legacy rows as .md files, preserving id/tags/pin', () => {
    const s = make();
    const db = legacyDb([
        { id: 'a1', title: 'Compras', body: 'leite, pão', tags: ['casa'], pinned: true, createdAt: 1, updatedAt: 2 },
        { id: 'a2', title: 'Velha', body: 'apagada', tags: [], pinned: false, createdAt: 1, updatedAt: 2, deletedAt: 5 },
    ]);
    const n = NotesStore.migrateFromSqlite(db, s);
    assert.equal(n, 2);

    const live = s.get('a1');
    assert.equal(live.title, 'Compras');
    assert.equal(live.body, 'leite, pão');
    assert.deepEqual(live.tags, ['casa']);
    assert.equal(live.pinned, true);

    assert.ok(s.get('a2').deletedAt, 'the legacy trashed note lands in the trash, not the live list');
    assert.deepEqual(s.list().map(r => r.id), ['a1']);
    assert.deepEqual(s.list({ trash: true }).map(r => r.id), ['a2']);
    assert.ok(fs.existsSync(path.join(s.dir, '.sqlite-migrated')));
});

test('migrateFromSqlite: does nothing (and writes the marker) when there is no legacy table', () => {
    const s = make();
    const db = new DatabaseSync(':memory:'); // never had the old `notes` table
    assert.equal(NotesStore.migrateFromSqlite(db, s), 0);
    assert.deepEqual(s.list(), []);
    assert.ok(fs.existsSync(path.join(s.dir, '.sqlite-migrated')));
});

test('migrateFromSqlite: runs only once - a second call (e.g. next boot) never re-imports or resurrects a deleted note', () => {
    const s = make();
    const db = legacyDb([{ id: 'a1', title: 'Nota', body: 'x', createdAt: 1, updatedAt: 2 }]);
    assert.equal(NotesStore.migrateFromSqlite(db, s), 1);
    s.trash('a1');
    s.purge('a1'); // the user deleted it for good after the first migration
    assert.equal(NotesStore.migrateFromSqlite(db, s), 0, 'already migrated once: must not run again');
    assert.deepEqual(s.list(), []);
    assert.deepEqual(s.list({ trash: true }), []);
});

test('resolveNotesDir: NOTES_DIR wins; default is the home folder, copying old notes only once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-notesdir-'));
    tmpDirs.push(root);
    const dbPath = path.join(root, 'app-data', 'meuterminal.db');
    const home = path.join(root, 'home');
    assert.equal(NotesStore.resolveNotesDir({ env: '/x/notes', dbPath, home }), '/x/notes');

    const legacy = path.join(root, 'app-data', 'notes');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'Velha.md'), 'oi');
    const dir = NotesStore.resolveNotesDir({ env: '', dbPath, home });
    assert.equal(dir, path.join(home, '.meuterminal', 'notes'));
    assert.equal(fs.readFileSync(path.join(dir, 'Velha.md'), 'utf8'), 'oi');

    fs.unlinkSync(path.join(dir, 'Velha.md')); // deleted on purpose: must not come back
    NotesStore.resolveNotesDir({ env: '', dbPath, home });
    assert.equal(fs.existsSync(path.join(dir, 'Velha.md')), false);
});
