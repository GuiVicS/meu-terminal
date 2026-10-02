/**
 * webhook-crypto.js
 * Tokens (mtwh_...), constant-time comparison and encryption of HMAC secrets for webhooks.
 * Tokens are never stored in plain text - only their SHA-256 hash. HMAC secrets need the
 * plain value back (to recompute the signature), so they are encrypted with AES-256-GCM
 * using a key derived from WEBHOOK_SECRET_KEY (.env).
 */
const crypto = require('crypto');

const TOKEN_PREFIX = 'mtwh_';
const AES_ALGO = 'aes-256-gcm';

/** A new bearer token: the plain value (shown once), its prefix (to recognize it in a list) and its hash (stored). */
function generateToken() {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    return { token, prefix: token.slice(0, 10), hash: hashToken(token) };
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time string comparison (equal-length inputs; unequal lengths are rejected, which is not secret). */
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a ?? ''));
    const bufB = Buffer.from(String(b ?? ''));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

function secretKey() {
    const secret = process.env.WEBHOOK_SECRET_KEY;
    if (!secret) throw new Error('WEBHOOK_SECRET_KEY não configurado no .env.');
    return crypto.createHash('sha256').update(secret).digest(); // always 32 bytes, whatever the input length
}

/** AES-256-GCM encrypt -> base64 (iv + authTag + ciphertext). */
function encrypt(plaintext) {
    const key = secretKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
    const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(blob) {
    const key = secretKey();
    const buf = Buffer.from(blob, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv(AES_ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Verifies a GitHub/Stripe-style "sha256=<hex>" signature over the raw request body. */
function verifyHmacSignature(rawBody, header, secret) {
    if (typeof header !== 'string') return false;
    const [alg, sig] = header.split('=');
    if (alg !== 'sha256' || !sig) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(sig, expected);
}

module.exports = { generateToken, hashToken, safeEqual, encrypt, decrypt, verifyHmacSignature, TOKEN_PREFIX };
