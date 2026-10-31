/**
 * oauth-authorize.js
 * Consent page of the Claude bridge (routes/remote.js → GET /oauth/authorize). Sends the OAuth
 * request (from the address bar) back with email + password (+ 2FA code) to
 * /oauth/authorize/approve, then follows the redirect to claude.ai with the code.
 */
(function () {
    const body = document.body;
    if (body.dataset.mode !== 'consent') {
        document.getElementById('failure').hidden = false;
        return;
    }
    const consent = document.getElementById('consent');
    const form = document.getElementById('consentForm');
    const error = document.getElementById('consentError');
    const codeField = form.querySelector('[data-code]');
    const buttons = form.querySelectorAll('button');
    consent.hidden = false;
    if (body.dataset.twoFactor) codeField.hidden = false;

    const query = Object.fromEntries(new URLSearchParams(location.search));

    async function send(extra) {
        buttons.forEach(b => { b.disabled = true; });
        error.textContent = '';
        try {
            const res = await fetch('oauth/authorize/approve', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, ...extra }),
            });
            const data = await res.json().catch(() => ({}));
            if (data.redirect) {
                location.replace(data.redirect);
                return;
            }
            if (data.needCode) {
                codeField.hidden = false;
                form.elements.code.focus();
            }
            error.textContent = data.error || (data.needCode ? 'Digite o código do app autenticador.' : `Erro ${res.status}`);
            if (typeof data.attemptsLeft === 'number') error.textContent += ` (${data.attemptsLeft} tentativa(s) restante(s))`;
        } catch {
            error.textContent = 'Sem conexão com o servidor.';
        }
        buttons.forEach(b => { b.disabled = false; });
    }

    form.addEventListener('submit', e => {
        e.preventDefault();
        send({
            decision: 'allow',
            email: form.elements.email.value,
            password: form.elements.password.value,
            code: form.elements.code.value.trim(),
        });
    });
    document.getElementById('denyBtn').addEventListener('click', () => send({ decision: 'deny' }));
    form.elements.email.focus();
})();
