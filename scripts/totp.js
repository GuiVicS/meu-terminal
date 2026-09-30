/**
 * totp.js
 * Time-based one-time passwords (RFC 6238, the codes shown by Google Authenticator,
 * Microsoft Authenticator, Authy, 1Password...). Node crypto only: HMAC-SHA1,
 * 6 digits, 30-second steps.
 */
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

/** Decodes a base32 secret (spaces/dashes/padding ignored). Throws on invalid input. */
function base32Decode(text) {
    const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
    if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error('segredo TOTP inválido (use base32: A-Z e 2-7)');
    let bits = 0;
    let value = 0;
    const bytes = [];
    for (const char of clean) {
        value = (value << 5) | ALPHABET.indexOf(char);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

/** 20 random bytes (160 bits), the size authenticator apps expect for SHA-1. */
function generateSecret() {
    return base32Encode(crypto.randomBytes(20));
}

/** Code for a given 30-second step (RFC 4226 dynamic truncation). */
function codeAt(key, step) {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = crypto.createHmac('sha1', key).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
    return String(number).padStart(DIGITS, '0');
}

function currentStep(now = Date.now()) {
    return Math.floor(now / 1000 / STEP_SECONDS);
}

class TotpVerifier {
    /** @param {string} secret - base32 secret (throws if invalid) */
    constructor(secret) {
        this.key = base32Decode(secret);
        if (this.key.length < 10) throw new Error('segredo TOTP muito curto (mínimo 16 caracteres base32)');
        this.lastUsedStep = -1;
    }

    /**
     * Accepts the current code and the ones right before/after it (clock drift up to
     * ±30s). A code that was already used can't be used again (replay protection).
     */
    verify(code) {
        if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
        const given = Buffer.from(code.trim());
        const now = currentStep();
        let matched = -1;
        // Check every candidate (no early exit) so timing doesn't reveal which one matched
        for (const step of [now - 1, now, now + 1]) {
            if (crypto.timingSafeEqual(given, Buffer.from(codeAt(this.key, step))) && step > this.lastUsedStep) {
                matched = step;
            }
        }
        if (matched === -1) return false;
        this.lastUsedStep = matched;
        return true;
    }
}

module.exports = { TotpVerifier, generateSecret, codeAt, currentStep, base32Decode };
