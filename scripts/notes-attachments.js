/**
 * notes-attachments.js
 * Files dropped/pasted into a note's editor (images, PDFs, etc.), one folder per note under
 * `<NOTES_DIR>/.attachments/<noteId>/`. The note's Markdown body only stores a link to
 * `/api/notes/:id/attachments/:name`; the bytes live on disk, same volume as the notes themselves.
 */
const fs = require('fs');
const path = require('path');

const MAX_NAME = 150;
const MIME_BY_EXT = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
    '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.zip': 'application/zip', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function sanitizeFileName(name) {
    let clean = String(name ?? '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) clean = 'arquivo';
    return clean.slice(0, MAX_NAME);
}

/** `<base><ext>`, or `<base> (2)<ext>` etc. if that name is already taken in `dir`. */
function uniqueFileName(dir, name) {
    const ext = path.extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    let candidate = name;
    for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`;
    return candidate;
}

/** Only letters/digits/-/_ survive as a folder name; anything else (still a valid id in practice,
 * since note ids are UUIDs) is hashed so a crafted id can never escape `.attachments` via "..". */
function safeFolderName(id) {
    const str = String(id ?? '');
    if (/^[A-Za-z0-9_-]{1,100}$/.test(str)) return str;
    return require('crypto').createHash('sha1').update(str).digest('hex');
}

class NotesAttachments {
    /** @param {string} notesDir - same folder NotesStore keeps its .md files in */
    constructor(notesDir) {
        this.dir = path.join(notesDir, '.attachments');
        fs.mkdirSync(this.dir, { recursive: true });
    }

    noteDir(noteId) {
        const dir = path.join(this.dir, safeFolderName(noteId));
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    /** Streams the request body (the file's raw bytes - no multipart) into a free name; rejects past maxBytes. */
    save(req, noteId, rawName, { maxBytes = 25 * 1024 * 1024 } = {}) {
        const dir = this.noteDir(noteId);
        const name = uniqueFileName(dir, sanitizeFileName(rawName));
        const target = path.join(dir, name);
        return new Promise((resolve, reject) => {
            const out = fs.createWriteStream(target, { flags: 'wx' });
            let size = 0;
            let failed = false;
            const fail = e => {
                if (failed) return;
                failed = true;
                out.destroy();
                // Wait for the fd to actually close before unlinking - on Windows, deleting a file
                // that's still open for writing fails silently (EBUSY, swallowed by force:true).
                out.once('close', () => {
                    fs.promises.rm(target, { force: true }).catch(() => {}).finally(() => reject(e));
                });
            };
            req.on('data', chunk => {
                size += chunk.length;
                if (size > maxBytes) fail(Object.assign(new Error('Arquivo maior que 25 MB.'), { status: 413 }));
            });
            req.on('aborted', () => fail(new Error('Envio cancelado.')));
            req.on('error', fail);
            out.on('error', e => fail(e));
            out.on('finish', () => resolve({ name, size }));
            req.pipe(out);
        });
    }

    /** Absolute path for `<noteId>/<name>`, or null if it doesn't exist (also guards path traversal). */
    resolve(noteId, name) {
        const dir = this.noteDir(noteId);
        const target = path.join(dir, path.basename(String(name || '')));
        if (path.dirname(target) !== dir) return null;
        return fs.existsSync(target) ? target : null;
    }

    mimeFor(name) {
        return MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
    }

    /** Every attachment of a note, gone - called when the note itself is purged for good. */
    removeAll(noteId) {
        fs.rmSync(this.noteDir(noteId), { recursive: true, force: true });
    }
}

module.exports = NotesAttachments;
