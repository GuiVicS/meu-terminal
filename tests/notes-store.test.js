const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const NotesStore = require('../scripts/notes-store');

const make = () => new NotesStore(new DatabaseSync(':memory:'));

test('create trims the title, normalizes tags and stores the body as is', () => {
    const s = make();
    const n = s.create({ title: '  Ideias  ', body: '# oi', tags: ['Casa', 'casa', ' ', 'Trabalho'], pinned: 1 });
    assert.equal(n.title, 'Ideias');
    assert.equal(n.body, '# oi');
    assert.deepEqual(n.tags, ['Casa', 'Trabalho']);
    assert.equal(n.pinned, true);
    assert.equal(n.deletedAt, null);
});

test('limits: title, body and tag count are capped', () => {
    const s = make();
    const n = s.create({ title: 'x'.repeat(500), body: 'y'.repeat(300 * 1024), tags: Array.from({ length: 40 }, (_, i) => `t${i}`) });
    assert.equal(n.title.length, 200);
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

test('list: tasks counts the checklist, or null when the note has none', () => {
    const s = make();
    s.create({ title: 'sem checklist', body: 'só texto' });
    s.create({ title: 'com checklist', body: '- [ ] a\n- [x] b\n- [X] c\n* [ ] d\n1. [x] e' });
    const rows = s.list();
    const byTitle = Object.fromEntries(rows.map(r => [r.title, r.tasks]));
    assert.equal(byTitle['sem checklist'], null);
    assert.deepEqual(byTitle['com checklist'], { total: 5, done: 3 });
});

test('search matches title, body and tags, and treats % and _ literally', () => {
    const s = make();
    s.create({ title: 'Compras', body: 'leite e pão' });
    s.create({ title: 'Meta', body: 'chegar a 100% do plano' });
    s.create({ title: 'Outra', tags: ['viagem'] });
    assert.deepEqual(s.list({ q: 'leite' }).map(r => r.title), ['Compras']);
    assert.deepEqual(s.list({ q: 'compras' }).map(r => r.title), ['Compras']);
    assert.deepEqual(s.list({ q: 'viag' }).map(r => r.title), ['Outra']);
    assert.deepEqual(s.list({ q: '100%' }).map(r => r.title), ['Meta']);
    assert.deepEqual(s.list({ q: '_' }), []);
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
