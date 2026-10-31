/**
 * auth.js
 * The pure pieces of the login, kept out of server.js so they can be tested on their own:
 * signed login tokens, constant-time comparisons, the brute-force limiter, the same-origin
 * check and the list of routes that skip the login. server.js wires them to Express.
 */
const crypto = require('crypto');

/** Constant-time comparison for strings of any length (hashes first). */
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** Constant-time PIN comparison (both must be non-empty). */
function verifyPin(storedPin, providedPin) {
    if (!storedPin || !providedPin || typeof providedPin !== 'string') return false;
    return safeEqual(storedPin, providedPin);
}

/**
 * Login tokens for the email login. The cookie never contains the password: it holds an
 * expiry and an HMAC signature. The key is derived from the credentials (and the 2FA secret),
 * so changing the password or turning 2FA on/off in .env logs everyone out; a restart does not.
 */
function createTokenSigner({ email, password, totpSecret = '' }) {
    const key = crypto.createHash('sha256')
        .update(`meu-terminal-auth\0${email}\0${password}\0${totpSecret}`)
        .digest();
    const sign = expiresAt => crypto.createHmac('sha256', key).update(`${email}|${expiresAt}`).digest('base64url');
    return {
        /** Short fingerprint of the key: changes whenever the credentials change. */
        fingerprint: crypto.createHash('sha256').update(key).digest('base64url').slice(0, 16),
        create(maxAgeMs, now = Date.now()) {
            const expiresAt = now + maxAgeMs;
            return `${expiresAt}.${sign(expiresAt)}`;
        },
        verify(token, now = Date.now()) {
            if (!token || typeof token !== 'string') return false;
            const [expiresAt, signature] = token.split('.');
            if (!expiresAt || !signature || !/^\d+$/.test(expiresAt)) return false;
            if (Number(expiresAt) < now) return false;
            return safeEqual(signature, sign(expiresAt));
        },
    };
}

/**
 * Brute-force protection: after `max` failures a key (an IP) is locked for `lockoutMs`.
 * One instance per surface (login, webhooks...) so they don't share counters.
 */
class AttemptLimiter {
    constructor({ max = 5, lockoutMs = 15 * 60 * 1000, now = Date.now } = {}) {
        this.max = max;
        this.lockoutMs = lockoutMs;
        this.now = now;
        this.attempts = new Map(); // key -> { count, lastAttempt }
    }

    isLockedOut(key) {
        const a = this.attempts.get(key);
        if (!a || a.count < this.max) return false;
        if (this.now() - a.lastAttempt < this.lockoutMs) return true;
        this.attempts.delete(key);
        return false;
    }

    record(key) {
        const a = this.attempts.get(key) || { count: 0, lastAttempt: 0 };
        a.count += 1;
        a.lastAttempt = this.now();
        this.attempts.set(key, a);
    }

    reset(key) {
        this.attempts.delete(key);
    }

    attemptsLeft(key) {
        const a = this.attempts.get(key);
        return Math.max(0, this.max - (a ? a.count : 0));
    }

    /** Whole minutes until the lockout ends (0 when not locked). */
    minutesLeft(key) {
        const a = this.attempts.get(key);
        if (!a) return 0;
        return Math.max(0, Math.ceil((this.lockoutMs - (this.now() - a.lastAttempt)) / 60000));
    }

    /** Drops entries whose lockout window has passed (called on a timer). */
    sweep() {
        const now = this.now();
        for (const [key, a] of this.attempts) {
            if (now - a.lastAttempt >= this.lockoutMs) this.attempts.delete(key);
        }
    }
}

/**
 * Cross-site check: a request with an Origin header must come from this app's own host
 * (or one of `extraOrigins`). Requests without Origin (curl, agents) are not browser attacks.
 * @param {{ headers: object }} req
 * @param {Set<string>} [extraOrigins]
 */
function isSameOrigin(req, extraOrigins = new Set()) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    let parsed;
    try {
        parsed = new URL(origin); // "null" (sandboxed pages, file://) fails here
    } catch {
        return false;
    }
    const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')]
        .map(h => String(h || '').trim().toLowerCase()).filter(Boolean);
    return hosts.includes(parsed.host.toLowerCase()) || extraOrigins.has(parsed.origin);
}

/**
 * Does `reqPath` skip the login? Entries ending in "/" are folders (prefix match);
 * everything else must match exactly, so "/mcp" doesn't also open "/mcp/remote" or "/mcpx".
 */
function isPublicPath(reqPath, publicPaths) {
    return publicPaths.some(p => (p.endsWith('/') ? reqPath.startsWith(p) : reqPath === p));
}

module.exports = { safeEqual, verifyPin, createTokenSigner, AttemptLimiter, isSameOrigin, isPublicPath };
