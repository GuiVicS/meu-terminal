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
        form.hidden = false;
        form.email.focus();

        form.addEventListener('submit', async e => {
            e.preventDefault();
            const email = form.email.value.trim();
            const password = form.password.value;
            if (!email || !password) {
                errorEl.textContent = 'Informe email e senha.';
                return;
            }

            errorEl.textContent = '';
            button.disabled = true;
            button.textContent = 'Entrando…';
            try {
                const response = await fetch(joinPath('login'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email, password }),
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
                errorEl.textContent = data.attemptsLeft > 0
                    ? `${data.error} ${data.attemptsLeft} tentativa(s) restante(s).`
                    : (data.error || 'Não foi possível entrar.');
                form.password.value = '';
                form.password.focus();
            } catch (error) {
                console.error('Login error:', error);
                errorEl.textContent = 'Ocorreu um erro. Tente novamente.';
            } finally {
                if (!form.password.disabled) {
                    button.disabled = false;
                    button.textContent = 'Entrar';
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
    }
    
    initialize();
});