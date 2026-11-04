/**
 * html-preview.js
 * Runs an HTML file inside the chat viewer, without the embedded browser. The page gets a temporary
 * address (/preview/<token>/...) always served with `Content-Security-Policy: sandbox`, so it runs
 * with an opaque origin: it cannot read the app's cookies or call its API as the user.
 *
 * A sandboxed page sends no login cookie (SameSite=strict), so its own CSS, scripts and images are
 * authorised by the token. The token opens only the page's folder, only web asset types, and never
 * hidden files. A page sitting directly in the home or at the disk root gets no folder at all:
 * only the page itself is served.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads';
const ASSET_EXT = new Set([
    'html', 'htm', 'css', 'js', 'mjs', 'map', 'wasm',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
    'woff', 'woff2', 'ttf', 'otf', 'eot',
    'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'mov', 'vtt',
]);
const HTML_RE = /\.html?$/i;
const TTL_MS = 60 * 60 * 1000;
const MAX_LINKS = 100;

function inside(parent, child) {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

class HtmlPreview {
    /**
     * @param {object} opts
     * @param {string} opts.home - the user's home: a page directly in it does not share the folder
     * @param {number} [opts.ttlMs]
     * @param {() => number} [opts.now]
     */
    constructor({ home, ttlMs = TTL_MS, now = Date.now }) {
        this.home = fs.realpathSync(home);
        this.ttlMs = ttlMs;
        this.now = now;
        this.links = new Map(); // token -> { root, entry, shareFolder, expires }
    }

    /** @returns {{ token: string, name: string }} */
    create(filePath) {
        if (!HTML_RE.test(filePath)) throw Object.assign(new Error('Só arquivos HTML podem ser executados.'), { status: 400 });
        let real;
        try {
            real = fs.realpathSync(filePath);
        } catch {
            throw Object.assign(new Error('Arquivo não encontrado.'), { status: 404 });
        }
        if (!HTML_RE.test(real) || !fs.statSync(real).isFile()) {
            throw Object.assign(new Error('Só arquivos HTML podem ser executados.'), { status: 400 });
        }
        const root = path.dirname(real);
        const entry = path.basename(real);
        this.prune();
        const token = crypto.randomBytes(32).toString('hex');
        this.links.set(token, {
            root,
            entry,
            shareFolder: root !== this.home && root !== path.parse(root).root,
            expires: this.now() + this.ttlMs,
        });
        return { token, name: entry };
    }

    prune() {
        const now = this.now();
        for (const [token, link] of this.links) if (link.expires <= now) this.links.delete(token);
        while (this.links.size >= MAX_LINKS) this.links.delete(this.links.keys().next().value);
    }

    /**
     * What a request may read, or null.
     * @param {string} token
     * @param {string} relPath - decoded path after the token
     * @returns {{ root: string, rel: string }|null}
     */
    resolve(token, relPath) {
        const link = this.links.get(String(token));
        if (!link || link.expires <= this.now()) return null;
        const rel = path.posix.normalize(String(relPath || '').replace(/^\/+/, ''));
        if (!rel || rel === '.' || rel.includes('\0')) return null;
        if (rel === link.entry) return { root: link.root, rel };
        if (!link.shareFolder) return null;
        const parts = rel.split('/');
        if (parts.some(p => !p || p.startsWith('.'))) return null;
        if (!ASSET_EXT.has(path.extname(rel).slice(1).toLowerCase())) return null;
        let real;
        try {
            real = fs.realpathSync(path.join(link.root, rel));
        } catch {
            return null;
        }
        // A link inside the folder must not lead out of it
        if (!inside(link.root, real) || !ASSET_EXT.has(path.extname(real).slice(1).toLowerCase())) return null;
        return { root: link.root, rel: path.relative(link.root, real) };
    }
}

module.exports = { HtmlPreview, SANDBOX };
