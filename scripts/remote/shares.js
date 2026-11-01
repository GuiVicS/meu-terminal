/**
 * remote/shares.js
 * Temporary links, random token, expiring in minutes, kept in memory (a restart ends every link,
 * which is fine for "baixe/envie isto agora"):
 * - download (share_link): /dl/<token> serves one file;
 * - upload (upload_link): /up/<token> is a page where the user sends files of any size straight
 *   to a folder on the server (never through the conversation); each one is recorded with its
 *   size and sha256 so the agent can verify what arrived (upload_received).
 */
const crypto = require('crypto');

const MAX_LINKS = 100;
const MAX_MINUTES = 24 * 60;

class Shares {
    constructor({ now = Date.now } = {}) {
        this.now = now;
        this.links = new Map(); // token -> { source, path, expiresAt } | { kind: 'upload', dir, maxBytes, received, expiresAt }
    }

    sweep() {
        const now = this.now();
        for (const [t, l] of this.links) if (l.expiresAt < now) this.links.delete(t);
    }

    create({ source, path, minutes = 30 }) {
        this.sweep();
        if (this.links.size >= MAX_LINKS) throw new Error('Links demais ativos. Espere alguns expirarem.');
        const mins = Math.min(Math.max(Number(minutes) || 30, 1), MAX_MINUTES);
        const token = crypto.randomBytes(24).toString('base64url');
        const expiresAt = this.now() + mins * 60 * 1000;
        this.links.set(token, { source, path, expiresAt });
        return { token, expiresAt };
    }

    /** Upload link: files go to `dir`; `maxBytes` caps each file. */
    createUpload({ dir, minutes = 60, maxBytes }) {
        this.sweep();
        if (this.links.size >= MAX_LINKS) throw new Error('Links demais ativos. Espere alguns expirarem.');
        const mins = Math.min(Math.max(Number(minutes) || 60, 1), MAX_MINUTES);
        const token = crypto.randomBytes(24).toString('base64url');
        const expiresAt = this.now() + mins * 60 * 1000;
        this.links.set(token, { kind: 'upload', dir, maxBytes, received: [], expiresAt });
        return { token, expiresAt };
    }

    get(token) {
        this.sweep();
        return typeof token === 'string' ? this.links.get(token) || null : null;
    }

    revokeAll() {
        this.links.clear();
    }
}

module.exports = { Shares };
