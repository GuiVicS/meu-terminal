const test = require('node:test');
const assert = require('node:assert/strict');
const {
    safeEqual, verifyPin, createTokenSigner, AttemptLimiter, isSameOrigin, isPublicPath,
} = require('../scripts/auth');

const creds = { email: 'eu@exemplo.com', password: 'senha-forte', totpSecret: '' };
const HOUR = 60 * 60 * 1000;

test('safeEqual: equal and different strings, any length', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), true);
});

test('verifyPin: right PIN only, never with an empty side', () => {
    assert.equal(verifyPin('4821', '4821'), true);
    assert.equal(verifyPin('4821', '4822'), false);
    assert.equal(verifyPin('4821', ''), false);
    assert.equal(verifyPin('', ''), false);
    assert.equal(verifyPin('4821', undefined), false);
    assert.equal(verifyPin('4821', ['4821']), false);
});

test('token: a fresh token verifies; an expired one does not', () => {
    const t = createTokenSigner(creds);
    const now = Date.now();
    assert.equal(t.verify(t.create(HOUR, now), now), true);
    assert.equal(t.verify(t.create(HOUR, now), now + 2 * HOUR), false);
});

test('token: tampering with the expiry or the signature breaks it', () => {
    const t = createTokenSigner(creds);
    const token = t.create(HOUR);
    const [exp, sig] = token.split('.');
    assert.equal(t.verify(`${Number(exp) + 10 * HOUR}.${sig}`), false);
    assert.equal(t.verify(`${exp}.${sig.slice(0, -2)}xx`), false);
    for (const bad of ['', 'abc', '123', '.sig', 'abc.def', null, undefined, 42, {}]) {
        assert.equal(t.verify(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
});

test('token: changing the password or turning 2FA on invalidates old tokens', () => {
    const before = createTokenSigner(creds);
    const token = before.create(HOUR);
    assert.equal(createTokenSigner({ ...creds, password: 'outra' }).verify(token), false);
    assert.equal(createTokenSigner({ ...creds, totpSecret: 'JBSWY3DPEHPK3PXP' }).verify(token), false);
    assert.equal(createTokenSigner(creds).verify(token), true, 'a restart (same credentials) keeps it valid');
    assert.notEqual(before.fingerprint, createTokenSigner({ ...creds, password: 'outra' }).fingerprint);
});

test('token: same format and key as before the extraction (existing cookies stay valid)', () => {
    const crypto = require('crypto');
    const key = crypto.createHash('sha256')
        .update(`meu-terminal-auth\0${creds.email}\0${creds.password}\0`).digest();
    const exp = Date.now() + HOUR;
    const legacy = `${exp}.${crypto.createHmac('sha256', key).update(`${creds.email}|${exp}`).digest('base64url')}`;
    assert.equal(createTokenSigner(creds).verify(legacy), true);
});

test('AttemptLimiter: locks after max failures, unlocks after the window', () => {
    let now = 1_000_000;
    const lim = new AttemptLimiter({ max: 3, lockoutMs: 60_000, now: () => now });
    for (let i = 0; i < 2; i++) lim.record('1.2.3.4');
    assert.equal(lim.isLockedOut('1.2.3.4'), false);
    assert.equal(lim.attemptsLeft('1.2.3.4'), 1);
    lim.record('1.2.3.4');
    assert.equal(lim.isLockedOut('1.2.3.4'), true);
    assert.equal(lim.isLockedOut('5.6.7.8'), false, 'other IPs are not affected');
    assert.equal(lim.minutesLeft('1.2.3.4'), 1);
    now += 60_000;
    assert.equal(lim.isLockedOut('1.2.3.4'), false);
    assert.equal(lim.attemptsLeft('1.2.3.4'), 3, 'counter starts over');
});

test('AttemptLimiter: reset on success and sweep of old entries', () => {
    let now = 0;
    const lim = new AttemptLimiter({ max: 2, lockoutMs: 1000, now: () => now });
    lim.record('a');
    lim.reset('a');
    assert.equal(lim.attemptsLeft('a'), 2);
    lim.record('b');
    now = 1000;
    lim.sweep();
    assert.equal(lim.attempts.size, 0);
});

test('isSameOrigin: no Origin passes; same host passes; others and "null" fail', () => {
    const req = (origin, host = 'terminal.exemplo.com', fwd) => ({
        headers: { ...(origin !== undefined ? { origin } : {}), host, ...(fwd ? { 'x-forwarded-host': fwd } : {}) },
    });
    assert.equal(isSameOrigin(req(undefined)), true);
    assert.equal(isSameOrigin(req('https://terminal.exemplo.com')), true);
    assert.equal(isSameOrigin(req('https://TERMINAL.exemplo.com')), true);
    assert.equal(isSameOrigin(req('https://outro.exemplo.com')), false);
    assert.equal(isSameOrigin(req('null')), false);
    assert.equal(isSameOrigin(req('https://terminal.exemplo.com', 'interno:3000', 'terminal.exemplo.com')), true);
});

test('isSameOrigin: extra allowed origins', () => {
    const r = { headers: { origin: 'https://app.exemplo.com', host: 'terminal.exemplo.com' } };
    assert.equal(isSameOrigin(r, new Set(['https://app.exemplo.com'])), true);
    assert.equal(isSameOrigin(r, new Set(['https://outro.com'])), false);
});

test('isPublicPath: exact match, prefix only for entries ending in "/"', () => {
    const list = ['/login', '/login/pair', '/mcp', '/assets/', '/hooks/'];
    assert.equal(isPublicPath('/login', list), true);
    assert.equal(isPublicPath('/login/pair', list), true);
    assert.equal(isPublicPath('/mcp', list), true);
    assert.equal(isPublicPath('/assets/icon.png', list), true);
    assert.equal(isPublicPath('/hooks/deploy', list), true);
    // These used to slip through with startsWith
    assert.equal(isPublicPath('/mcp/remote', list), false);
    assert.equal(isPublicPath('/mcpqualquer', list), false);
    assert.equal(isPublicPath('/login.html', list), false);
    assert.equal(isPublicPath('/loginx', list), false);
    assert.equal(isPublicPath('/assets', list), false);
    assert.equal(isPublicPath('/api/sessions', list), false);
});
