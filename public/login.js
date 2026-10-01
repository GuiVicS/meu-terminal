/**
 * login.js
 * Login page: email + password (AUTH_EMAIL/AUTH_PASSWORD) or the legacy PIN,
 * depending on what the server reports at /auth-mode.
 */
document.addEventListener('DOMContentLoaded', () => {
    // Helper function to join paths with base path
    function joinPath(path) {
        const basePath = window.appConfig?.basePath || '';
        // Remove any leading slash from path and trailing slash from basePath
        const cleanPath = path.replace(/^\/+/, '');
        const cleanBase = basePath.replace(/\/+$/, '');
        
        // Join with single slash
        return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
    }

    // PIN input functionality
    async function setupPinInputs() {
        const form = document.getElementById('pinForm');
        if (!form) return; // Only run on login page

        // Fetch PIN length from server
        fetch(joinPath('pin-length'))
            .then(response => response.json())
            .then(data => {
                const pinLength = data.length;
                const container = document.querySelector('.pin-input-container');
                
                // Create PIN input fields
                for (let i = 0; i < pinLength; i++) {
                    const input = document.createElement('input');
                    input.type = 'password';
                    input.maxLength = 1;
                    input.className = 'pin-input';
                    input.setAttribute('inputmode', 'numeric');
                    input.pattern = '[0-9]*';
                    input.setAttribute('autocomplete', 'off');
                    container.appendChild(input);
                }

                // Handle input behavior
                const inputs = container.querySelectorAll('.pin-input');
                
                // Focus first input immediately
                if (inputs.length > 0) {
                    inputs[0].focus();
                }

                inputs.forEach((input, index) => {
                    input.addEventListener('input', (e) => {
                        // Only allow numbers
                        e.target.value = e.target.value.replace(/[^0-9]/g, '');
                        
                        if (e.target.value) {
                            e.target.classList.add('has-value');
                            if (index < inputs.length - 1) {
                                inputs[index + 1].focus();
                            } else {
                                // Last digit entered, submit the form
                                const pin = Array.from(inputs).map(input => input.value).join('');
                                submitPin(pin, inputs);
                            }
                        } else {
                            e.target.classList.remove('has-value');
                        }
                    });

                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Backspace' && !e.target.value && index > 0) {
                            inputs[index - 1].focus();
                        }
                    });

                    // Prevent paste of multiple characters
                    input.addEventListener('paste', (e) => {
                        e.preventDefault();
                        const pastedData = e.clipboardData.getData('text');
                        const numbers = pastedData.match(/\d/g);
                        
                        if (numbers) {
                            numbers.forEach((num, i) => {
                                if (inputs[index + i]) {
                                    inputs[index + i].value = num;
                                    inputs[index + i].classList.add('has-value');
                                    if (index + i + 1 < inputs.length) {
                                        inputs[index + i + 1].focus();
                                    } else {
                                        // If paste fills all inputs, submit the form
                                        const pin = Array.from(inputs).map(input => input.value).join('');
                                        submitPin(pin, inputs);
                                    }
                                }
                            });
                        }
                    });
                });
            });
    }

    // Handle PIN submission with security features
    function submitPin(pin, inputs) {
        const errorElement = document.querySelector('.pin-error');
        
        fetch(joinPath('verify-pin'), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ pin }),
            credentials: 'same-origin', // Ensure cookies are sent
            redirect: 'follow' // Follow server redirects
        })
        .then(async response => {
            // If redirected, the response will be a redirect status (3xx)
            if (response.redirected) {
                window.location.replace(response.url);
                return;
            }
            
            const data = await response.json();
            
            if (response.status === 429) {
                // Handle lockout
                errorElement.textContent = data.error;
                errorElement.setAttribute('aria-hidden', 'false');
                inputs.forEach(input => {
                    input.value = '';
                    input.classList.remove('has-value');
                    input.disabled = true;
                });
            } else {
                // Handle invalid PIN
                const message = data.attemptsLeft > 0
                    ? `PIN incorreto. ${data.attemptsLeft} tentativa(s) restante(s).`
                    : 'PIN incorreto. Última tentativa antes do bloqueio.';
                
                errorElement.textContent = message;
                errorElement.setAttribute('aria-hidden', 'false');
                inputs.forEach(input => {
                    input.value = '';
                    input.classList.remove('has-value');
                });
                inputs[0].focus();
            }
        })
        .catch(error => {
            console.error('Error:', error);
            errorElement.textContent = 'Ocorreu um erro. Tente novamente.';
            errorElement.setAttribute('aria-hidden', 'false');
        });
    }

    // Email + password login
    function setupEmailForm() {
        const form = document.getElementById('emailForm');
        const errorEl = document.getElementById('loginError');
        const button = form.querySelector('button[type="submit"]');
        const codeField = form.querySelector('[data-step="code"]');
        const credentialFields = [form.email.closest('.field'), form.password.closest('.field')];
        // 'credentials' (email + password) or 'code' (two-factor, when enabled on the server)
        let step = 'credentials';
        form.hidden = false;
        form.email.focus();

        const buttonLabel = () => (step === 'code' ? 'Verificar' : 'Entrar');

        function showCodeStep() {
            step = 'code';
            credentialFields.forEach(field => { field.hidden = true; });
            codeField.hidden = false;
            document.getElementById('loginSubtitle').textContent = 'Verificação em duas etapas';
            form.code.value = '';
            form.code.focus();
        }

        // Six digits typed (or pasted/auto-filled): submit right away
        form.code.addEventListener('input', () => {
            form.code.value = form.code.value.replace(/\D/g, '').slice(0, 6);
            if (form.code.value.length === 6 && !button.disabled) form.requestSubmit();
        });

        form.addEventListener('submit', async e => {
            e.preventDefault();
            const email = form.email.value.trim();
            const password = form.password.value;
            const code = step === 'code' ? form.code.value.trim() : undefined;
            if (!email || !password) {
                errorEl.textContent = 'Informe email e senha.';
                return;
            }
            if (step === 'code' && code.length !== 6) {
                errorEl.textContent = 'Digite os 6 dígitos do app autenticador.';
                return;
            }

            errorEl.textContent = '';
            button.disabled = true;
            button.textContent = step === 'code' ? 'Verificando…' : 'Entrando…';
            try {
                const response = await fetch(joinPath('login'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password, code }),
                    credentials: 'same-origin',
                });
                const data = await response.json().catch(() => ({}));

                if (response.ok && data.success) {
                    window.location.replace(data.redirect || './');
                    return;
                }
                if (response.status === 429) {
                    errorEl.textContent = data.error;
                    form.querySelectorAll('input').forEach(input => { input.disabled = true; });
                    return;
                }
                // Right email/password, and the server wants the authenticator code
                if (data.needCode && step !== 'code') {
                    showCodeStep();
                    return;
                }
                errorEl.textContent = data.attemptsLeft > 0
                    ? `${data.error} ${data.attemptsLeft} tentativa(s) restante(s).`
                    : (data.error || 'Não foi possível entrar.');
                if (step === 'code') {
                    form.code.value = '';
                    form.code.focus();
                } else {
                    form.password.value = '';
                    form.password.focus();
                }
            } catch (error) {
                console.error('Login error:', error);
                errorEl.textContent = 'Ocorreu um erro. Tente novamente.';
            } finally {
                if (!form.password.disabled) {
                    button.disabled = false;
                    button.textContent = buttonLabel();
                }
            }
        });
    }

    async function initialize() {
        // Set site title
        const siteTitle = window.appConfig?.siteTitle || 'MeuTerminal';
        document.getElementById('pageTitle').textContent = siteTitle;
        document.getElementById('siteTitle').textContent = siteTitle;
        // Show demo banner if in demo mode
        if (window.appConfig?.isDemoMode) {
            document.getElementById('demo-banner').hidden = false;
        }

        // Opened from a QR code ("Conectar outro aparelho"): log in with the one-time code
        const pair = new URLSearchParams(location.search).get('pair');
        let pairError = '';
        if (pair) {
            history.replaceState(null, '', location.pathname); // the code doesn't stay in the address bar
            const subtitle = document.getElementById('loginSubtitle');
            subtitle.textContent = 'Conectando este aparelho…';
            try {
                const r = await fetch(joinPath('login/pair'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: pair }),
                });
                const data = await r.json().catch(() => ({}));
                if (r.ok) {
                    window.location.href = data.redirect || joinPath('');
                    return;
                }
                pairError = data.error || 'Não foi possível conectar. Entre com sua senha.';
            } catch {
                pairError = 'Sem conexão. Entre com sua senha.';
            }
        }

        let mode = window.appConfig?.authMode;
        if (!mode) {
            try {
                mode = (await (await fetch(joinPath('auth-mode'))).json()).mode;
            } catch {
                mode = 'pin';
            }
        }

        if (mode === 'email') {
            setupEmailForm();
        } else {
            document.getElementById('loginSubtitle').textContent = 'Digite seu PIN';
            document.getElementById('pinForm').hidden = false;
            setupPinInputs();
        }

        if (pairError) document.getElementById('loginSubtitle').textContent = pairError;
    }
    
    initialize();
});