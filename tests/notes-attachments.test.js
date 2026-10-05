const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const NotesAttachments = require('../scripts/notes-attachments');

const tmpDirs = [];
const make = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-notes-files-'));
    tmpDirs.push(dir);
    return new NotesAttachments(dir);
};

/** A minimal stand-in for the Express request object save() reads: a Readable with an .aborted flag. */
function reqFrom(buffer) {
    const req = new Readable({ read() {} });
    process.nextTick(() => {
        req.push(buffer);
        req.push(null);
    });
    return req;
}

test.after(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test('save: streams the body to disk under <noteId>/<name>, no multipart involved', async () => {
    const files = make();
    const { name, size } = await files.save(reqFrom(Buffer.from('fake png bytes')), 'note-1', 'photo.png');
    assert.equal(name, 'photo.png');
    assert.equal(size, 'fake png bytes'.length);
    const resolved = files.resolve('note-1', 'photo.png');
    assert.ok(resolved);
    assert.equal(fs.readFileSync(resolved, 'utf8'), 'fake png bytes');
});

test('save: a name collision in the same note picks "(2)", keeping the extension', async () => {
    const files = make();
    await files.save(reqFrom(Buffer.from('a')), 'note-1', 'img.png');
    const second = await files.save(reqFrom(Buffer.from('b')), 'note-1', 'img.png');
    assert.equal(second.name, 'img (2).png');
});

test('save: a crafted/odd name is sanitized (no path separators), still readable back', async () => {
    const files = make();
    const { name } = await files.save(reqFrom(Buffer.from('x')), 'note-1', '../../etc/passwd');
    assert.ok(!name.includes('/'));
    assert.ok(files.resolve('note-1', name));
});

test('save: rejects a body past maxBytes and leaves no partial file behind', async () => {
    const files = make();
    await assert.rejects(
        files.save(reqFrom(Buffer.alloc(100)), 'note-1', 'big.bin', { maxBytes: 10 }),
        /maior/,
    );
    assert.equal(files.resolve('note-1', 'big.bin'), null);
});

test('resolve: unknown file -> null', async () => {
    const files = make();
    await files.save(reqFrom(Buffer.from('x')), 'note-1', 'real.txt');
    assert.equal(files.resolve('note-1', 'missing.txt'), null);
});

test('resolve: ".." in the name cannot escape the note folder (basename strips the traversal)', async () => {
    const files = make();
    // A file named "secret.txt" exists for a *different* note; naive ".." traversal must not reach it.
    await files.save(reqFrom(Buffer.from('top secret')), 'note-2', 'secret.txt');
    const escaped = files.resolve('note-1', '../note-2/secret.txt');
    assert.equal(escaped, null); // note-1 has no "secret.txt" of its own - basename() left just that name
    const dir = files.noteDir('note-1');
    assert.ok(!dir.includes('note-2'));
});

test('resolve: two different note ids never see each other\'s files', async () => {
    const files = make();
    await files.save(reqFrom(Buffer.from('a')), 'note-1', 'same.txt');
    assert.equal(files.resolve('note-2', 'same.txt'), null);
});

test('mimeFor: known extensions map to a real content-type, unknown falls back to octet-stream', () => {
    const files = make();
    assert.equal(files.mimeFor('photo.PNG'), 'image/png');
    assert.equal(files.mimeFor('doc.pdf'), 'application/pdf');
    assert.equal(files.mimeFor('weird.xyz'), 'application/octet-stream');
});

test('removeAll: deletes every attachment of a note, leaves other notes untouched', async () => {
    const files = make();
    await files.save(reqFrom(Buffer.from('a')), 'note-1', 'a.txt');
    await files.save(reqFrom(Buffer.from('b')), 'note-2', 'b.txt');
    files.removeAll('note-1');
    assert.equal(files.resolve('note-1', 'a.txt'), null);
    assert.ok(files.resolve('note-2', 'b.txt'));
});
