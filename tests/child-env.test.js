const test = require('node:test');
const assert = require('node:assert/strict');
const { childEnv, appSecretValues, isAppSecret } = require('../scripts/child-env');

const base = {
    PATH: '/usr/bin', HOME: '/root', NPM_CONFIG_PREFIX: '/root/.npm-global',
    AUTH_EMAIL: 'eu@exemplo.com', AUTH_PASSWORD: 'senha-forte', AUTH_TOTP_SECRET: 'JBSWY3DPEHPK3PXP',
    MEUTERMINAL_PIN: '4821', WEBHOOK_SECRET_KEY: 'chave-webhooks', VERCEL_TOKEN: 'vercel-123',
    UNDEFINED_ONE: undefined,
};

test('childEnv: the app secrets never reach a child process', () => {
    const env = childEnv({}, base);
    for (const name of ['AUTH_EMAIL', 'AUTH_PASSWORD', 'AUTH_TOTP_SECRET', 'MEUTERMINAL_PIN', 'WEBHOOK_SECRET_KEY', 'VERCEL_TOKEN']) {
        assert.equal(name in env, false, `${name} leaked`);
    }
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.NPM_CONFIG_PREFIX, '/root/.npm-global', "the user's tools keep working");
    assert.equal('UNDEFINED_ONE' in env, false);
});

test('childEnv: extra variables are added (and can override the base)', () => {
    const env = childEnv({ TERM: 'xterm-256color', PATH: '/shims:/usr/bin' }, base);
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.PATH, '/shims:/usr/bin');
});

test('childEnv: does not modify process.env', () => {
    process.env.AUTH_PASSWORD_TEST_ONLY = 'x';
    childEnv();
    assert.equal(process.env.AUTH_PASSWORD_TEST_ONLY, 'x');
    delete process.env.AUTH_PASSWORD_TEST_ONLY;
});

test('isAppSecret / appSecretValues', () => {
    assert.equal(isAppSecret('AUTH_ANYTHING'), true);
    assert.equal(isAppSecret('PATH'), false);
    assert.equal(isAppSecret('MY_AUTH_TOKEN'), false);
    const values = appSecretValues(base);
    assert.ok(values.includes('senha-forte'));
    assert.ok(values.includes('vercel-123'));
    assert.ok(!values.includes('/usr/bin'));
});
