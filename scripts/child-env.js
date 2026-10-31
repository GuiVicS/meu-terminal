/**
 * child-env.js
 * Environment for processes the app starts on the user's behalf (terminals, agents). The
 * app's own secrets (login, 2FA, webhook key, deploy token) stay in the server process:
 * without this, a plain `env` in any terminal - or any agent reading its environment -
 * would print them.
 */

/** Variables that never reach a child process. `*` at the end = prefix. */
const APP_SECRETS = [
    'AUTH_*',              // AUTH_EMAIL, AUTH_PASSWORD, AUTH_TOTP_SECRET
    'MEUTERMINAL_PIN',
    'WEBHOOK_SECRET_KEY',
    'VERCEL_TOKEN',
];

function isAppSecret(name) {
    return APP_SECRETS.some(p => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/**
 * Copy of `base` without the app's secrets, plus `extra`.
 * @param {Record<string, string|undefined>} [extra]
 * @param {NodeJS.ProcessEnv} [base]
 */
function childEnv(extra = {}, base = process.env) {
    const env = {};
    for (const [name, value] of Object.entries(base)) {
        if (value !== undefined && !isAppSecret(name)) env[name] = value;
    }
    return { ...env, ...extra };
}

/** Kept out of children, but not masked: an email shows up legitimately (git log, config files...). */
const NOT_MASKED = new Set(['AUTH_EMAIL']);

/** Non-empty values of the app's secrets, for masking them in output shown elsewhere. */
function appSecretValues(base = process.env) {
    return Object.entries(base)
        .filter(([name, value]) => isAppSecret(name) && !NOT_MASKED.has(name) && typeof value === 'string' && value.length >= 4)
        .map(([, value]) => value);
}

module.exports = { childEnv, appSecretValues, isAppSecret, APP_SECRETS };
