/**
 * reauth.js
 * A short step-up check before a sensitive action (creating a webhook, editing its script,
 * issuing a token... - docs/PLANO-WEBHOOKS.md section 3.6.2): re-asks the password+2FA code
 * (email login) or the PIN, without logging the user out. The server remembers it for a few
 * minutes (requireReauth() in server.js). Callers don't call this directly - see webhooks.js's
 * api(): it retries the original request once reauthenticate() resolves true.
 */
import { askText } from './prompt.js';

function basePath() {
    return (window.appConfig?.basePath || '').replace(/\/+$/, '');
}

async function postReauth(body) {
    const res = await fetch(`${basePath()}/api/reauth`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, data };
}

/** @returns {Promise<boolean>} true once the server accepts it, false if the user cancels. */
export async function reauthenticate() {
    const mode = window.appConfig?.authMode;
    if (mode === 'none' || !mode) return true;
    const isPin = mode === 'pin';

    const value = await askText({
        title: isPin ? 'Confirme o PIN' : 'Confirme sua senha',
        label: isPin ? 'Esta ação precisa do PIN de novo, por segurança.' : 'Esta ação precisa da sua senha de novo, por segurança.',
        type: 'password',
        confirm: 'Confirmar',
    });
    if (value === null) return false;

    const body = isPin ? { pin: value } : { password: value };
    let { ok, data } = await postReauth(body);

    if (!ok && data.needCode) {
        const code = await askText({ title: 'Código de verificação', label: 'Código do app autenticador.', confirm: 'Confirmar' });
        if (code === null) return false;
        ({ ok, data } = await postReauth({ ...body, code }));
    }
    return ok;
}
