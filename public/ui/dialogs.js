/**
 * dialogs.js
 * Settings and keyboard-shortcut dialogs built on the native <dialog> element
 * (focus trapping, Esc to close and the backdrop come from the browser).
 */
import { icon } from './icons.js';
import { isHandset } from './device.js';
import { pushStatus, enablePush, disablePush, testPush } from '../managers/push.js';
import { toast } from './toast.js';

function createDialog(id, title) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog';
    dialog.id = id;
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.innerHTML = `
        <header class="dialog-header">
            <h2 class="dialog-title" id="${id}-title"></h2>
            <button type="button" class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button>
        </header>
        <div class="dialog-body"></div>`;
    dialog.querySelector('.dialog-title').textContent = title;
    dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
    // Click on the backdrop closes
    dialog.addEventListener('click', e => {
        if (e.target === dialog) dialog.close();
    });
    document.body.appendChild(dialog);
    return dialog;
}

/**
 * "Quick commands" admin: list + add/edit/delete form. Saved on the server.
 * @param {HTMLElement} section
 * @param {import('../managers/commands.js').default} commands
 */
function mountCommandsAdmin(section, commands) {
    section.innerHTML = `
        <h3 class="section-label">Comandos rápidos</h3>
        <p class="setting-help commands-help">Aparecem no botão ${icon('bolt', 13)} da barra de atalhos.
            Salvos no servidor: iguais em todos os aparelhos.</p>
        <ul class="commands-list" role="list"></ul>
        <form class="commands-form" autocomplete="off">
            <label class="field">
                <span class="field-label">Nome</span>
                <input name="label" type="text" maxlength="60" placeholder="Ex.: Subir o projeto">
            </label>
            <label class="field">
                <span class="field-label">Comando</span>
                <textarea name="command" rows="2" class="mono" required maxlength="4000"
                    autocapitalize="off" autocorrect="off" spellcheck="false"
                    placeholder="cd ~/projetos/api && npm run dev"></textarea>
            </label>
            <label class="setting setting-inline">
                <span class="setting-text">Executar ao tocar
                    <span class="setting-help">Aperta Enter sozinho. Desligado: só digita, você confere e envia.</span></span>
                <input type="checkbox" class="switch" name="run">
            </label>
            <p class="commands-error" role="alert"></p>
            <div class="commands-actions">
                <button type="button" class="btn btn-ghost" data-cancel hidden>Cancelar</button>
                <button type="submit" class="btn btn-primary">Adicionar</button>
            </div>
        </form>`;

    const list = section.querySelector('.commands-list');
    const form = section.querySelector('.commands-form');
    const submit = form.querySelector('[type="submit"]');
    const cancel = form.querySelector('[data-cancel]');
    const error = section.querySelector('.commands-error');
    const fields = {
        label: form.querySelector('[name="label"]'),
        command: form.querySelector('[name="command"]'),
        run: form.querySelector('[name="run"]'),
    };
    let editingId = null;

    const resetForm = () => {
        editingId = null;
        form.reset();
        submit.textContent = 'Adicionar';
        cancel.hidden = true;
        error.textContent = '';
    };

    const render = items => {
        list.innerHTML = '';
        if (!items.length) {
            const li = document.createElement('li');
            li.className = 'commands-empty';
            li.textContent = 'Nenhum comando cadastrado ainda.';
            list.appendChild(li);
            return;
        }
        items.forEach(item => {
            const li = document.createElement('li');
            li.className = 'command-row';
            li.innerHTML = `
                <span class="command-text">
                    <span class="command-label"></span>
                    <span class="command-code mono"></span>
                </span>
                <span class="command-badge" hidden>Enter</span>
                <button type="button" class="icon-btn" data-edit>${icon('edit', 15)}</button>
                <button type="button" class="icon-btn" data-delete>${icon('trash', 15)}</button>`;
            li.querySelector('.command-label').textContent = item.label;
            li.querySelector('.command-code').textContent = item.command;
            li.querySelector('.command-badge').hidden = !item.run;
            li.querySelector('[data-edit]').setAttribute('aria-label', `Editar ${item.label}`);
            li.querySelector('[data-delete]').setAttribute('aria-label', `Excluir ${item.label}`);
            li.querySelector('[data-edit]').addEventListener('click', () => {
                editingId = item.id;
                fields.label.value = item.label;
                fields.command.value = item.command;
                fields.run.checked = item.run;
                submit.textContent = 'Salvar';
                cancel.hidden = false;
                fields.command.focus();
            });
            li.querySelector('[data-delete]').addEventListener('click', async () => {
                try {
                    await commands.remove(item.id);
                    if (editingId === item.id) resetForm();
                } catch {
                    error.textContent = 'Não foi possível excluir.';
                }
            });
            list.appendChild(li);
        });
    };

    cancel.addEventListener('click', resetForm);
    form.addEventListener('submit', async e => {
        e.preventDefault();
        const data = {
            label: fields.label.value.trim(),
            command: fields.command.value.replace(/\r?\n$/, ''),
            run: fields.run.checked,
        };
        if (!data.command.trim()) {
            error.textContent = 'Informe o comando.';
            return;
        }
        submit.disabled = true;
        try {
            if (editingId) await commands.update(editingId, data);
            else await commands.add(data);
            resetForm();
        } catch {
            error.textContent = 'Não foi possível salvar. Tente novamente.';
        } finally {
            submit.disabled = false;
        }
    });

    commands.onChange(render);
    render(commands.items);
    return { refresh: () => commands.load().catch(() => {}) };
}

/**
 * Builds every settings section (quick commands, terminal, interface, session, pairing, push,
 * agent UI) into `body`. Used by both the settings popup and the /admin page, so this is the
 * single place that owns the markup and the wiring - neither caller re-implements any of it.
 * Each top-level section carries data-page="<slug>" so a page-based UI (like /admin) can show
 * one at a time; the popup ignores it and just shows everything in one scroll, as before.
 * @param {HTMLElement} body
 * @param {import('../managers/settings.js').default} settings
 * @param {() => any} getSession - active session (for read-only shell info)
 * @param {import('../managers/commands.js').default} commands - quick commands (server)
 * @returns {{ refresh: () => void, stopPair: () => void }}
 */
export function mountSettingsSections(body, { settings, getSession, commands }) {
    body.innerHTML = `
        <section class="settings-section" data-commands data-page="comandos"></section>
        <section class="settings-section" data-page="terminal">
            <h3 class="section-label">Terminal</h3>
            <label class="setting">
                <span class="setting-text">Tamanho da fonte</span>
                <span class="setting-control">
                    <input type="range" min="11" max="22" step="1" data-setting="fontSize" data-type="number">
                    <output class="setting-value" data-for="fontSize"></output>
                </span>
            </label>
            <label class="setting">
                <span class="setting-text">Altura da linha</span>
                <span class="setting-control">
                    <input type="range" min="1" max="1.6" step="0.05" data-setting="lineHeight" data-type="number">
                    <output class="setting-value" data-for="lineHeight"></output>
                </span>
            </label>
            <label class="setting">
                <span class="setting-text">Cursor</span>
                <select data-setting="cursorStyle">
                    <option value="block">Bloco</option>
                    <option value="bar">Barra</option>
                    <option value="underline">Sublinhado</option>
                </select>
            </label>
            <label class="setting">
                <span class="setting-text">Cursor piscando</span>
                <input type="checkbox" class="switch" data-setting="cursorBlink">
            </label>
            <label class="setting">
                <span class="setting-text">Histórico de rolagem
                    <span class="setting-help">Linhas mantidas em memória por aba</span></span>
                <select data-setting="scrollback" data-type="number">
                    <option value="1000">1.000</option>
                    <option value="5000">5.000</option>
                    <option value="10000">10.000</option>
                    <option value="50000">50.000</option>
                </select>
            </label>
            <div class="setting">
                <span class="setting-text">Shell
                    <span class="setting-help">Definido no servidor (variável SHELL)</span></span>
                <span class="setting-readonly mono" data-shell>—</span>
            </div>
        </section>
        <section class="settings-section" data-page="interface">
            <h3 class="section-label">Interface</h3>
            <label class="setting" data-iphone-visual>
                <span class="setting-text">Visual do celular
                    <span class="setting-help">Vidro flutuante, como no iPhone. “Em qualquer celular” leva o
                    mesmo visual para outros celulares; “Clássico” mantém a interface normal.</span></span>
                <select data-setting="iphoneVisual">
                    <option value="glass">Vidro (iPhone)</option>
                    <option value="glass-any">Vidro em qualquer celular</option>
                    <option value="classic">Clássico</option>
                </select>
            </label>
            <label class="setting">
                <span class="setting-text">Tema</span>
                <select data-setting="theme">
                    <option value="dark">Escuro</option>
                    <option value="light">Claro</option>
                    <option value="system">Seguir o sistema</option>
                </select>
            </label>
            <label class="setting">
                <span class="setting-text">Animações</span>
                <select data-setting="motion">
                    <option value="system">Seguir o sistema</option>
                    <option value="reduced">Reduzidas</option>
                </select>
            </label>
            <label class="setting">
                <span class="setting-text">Barra de atalhos (celular)
                    <span class="setting-help">ESC, TAB, CTRL e setas acima do teclado</span></span>
                <select data-setting="shortcutBar">
                    <option value="auto">Com o teclado aberto</option>
                    <option value="always">Sempre</option>
                    <option value="never">Nunca</option>
                </select>
            </label>
        </section>
        <section class="settings-section" data-page="sessoes">
            <h3 class="section-label">Sessão</h3>
            <label class="setting setting-stack">
                <span class="setting-text">Diretório padrão
                    <span class="setting-help">Usado em novas sessões. Vazio = diretório padrão do servidor</span></span>
                <input type="text" class="mono" data-setting="defaultCwd" placeholder="~"
                    autocapitalize="off" autocorrect="off" spellcheck="false">
            </label>
            <div class="setting">
                <span class="setting-text">Sessões no servidor
                    <span class="setting-help">As abas e os processos ficam no servidor: fechar o app não
                    encerra nada. Só fechar a aba (✕) encerra o processo dela.</span></span>
            </div>
        </section>
        <section class="settings-section pair-section" data-page="aparelhos">
            <h3 class="section-label">Conectar outro aparelho</h3>
            <p class="setting-help">Mostre um QR code e aponte a câmera do celular: ele entra sem digitar a senha.
                O código vale uma vez só, por 2 minutos.</p>
            <div class="pair-box" hidden>
                <div class="pair-qr" data-pair-qr></div>
                <p class="setting-help" data-pair-info></p>
            </div>
            <button type="button" class="btn btn-ghost" data-pair-show>Mostrar QR code</button>
        </section>
        <section class="settings-section push-section" data-page="notificacoes">
            <h3 class="section-label">Notificações</h3>
            <p class="setting-help">Receba avisos dos agentes (MCP <code class="mono">notify</code>) com som, mesmo
                com o app fechado. Ative em cada aparelho.</p>
            <p class="push-status" data-push-status>Verificando…</p>
            <div class="push-actions">
                <button type="button" class="btn btn-primary" data-push-toggle hidden>Ativar neste aparelho</button>
                <button type="button" class="btn btn-ghost" data-push-test hidden>Enviar teste</button>
            </div>
        </section>
        <section class="settings-section agent-ui-section" data-page="agentes">
            <h3 class="section-label">Modo UI dos agentes</h3>
            <p class="setting-help">Ao digitar <code class="mono">claude</code>, <code class="mono">codex</code> ou
                <code class="mono">opencode</code> num terminal, o MeuTerminal pergunta se você quer abrir o agente
                numa aba com chat, ferramentas, diffs e pedidos de permissão.</p>
            <label class="setting">
                <span class="setting-text">Perguntar ao abrir agentes</span>
                <input type="checkbox" class="switch" data-agent-intercept>
            </label>
            <div data-agent-prefs></div>
        </section>
        <section class="settings-section mcp-section" data-page="agentes">
            <h3 class="section-label">Agentes (MCP)</h3>
            <p class="setting-help mcp-help">Agentes rodando nos terminais (Claude Code e outros com MCP) podem
                abrir páginas numa aba de navegador, ver a tela (screenshot), ler o texto, listar abas e portas
                e mostrar avisos. Rode uma vez num terminal do MeuTerminal:</p>
            <div class="mcp-command">
                <code class="mono" data-mcp-command>carregando…</code>
                <button type="button" class="btn btn-ghost" data-copy-mcp>Copiar</button>
            </div>
            <p class="setting-help">Outros agentes: MCP por HTTP em <code class="mono" data-mcp-url></code>,
                com o cabeçalho <code class="mono">Authorization: Bearer $MEUTERMINAL_MCP_TOKEN</code>
                (variável já definida em todo terminal). Só funciona de dentro do servidor.</p>
        </section>`;
    // The phone visual preference means nothing on a desktop/iPad: keep the section short there.
    body.querySelector('[data-iphone-visual]').hidden = !isHandset();
    const mcpCommand = body.querySelector('[data-mcp-command]');
    body.querySelector('[data-copy-mcp]').addEventListener('click', async e => {
        const button = e.currentTarget;
        try {
            await navigator.clipboard.writeText(mcpCommand.textContent);
            button.textContent = 'Copiado';
        } catch {
            // No clipboard permission (e.g. plain HTTP): select the text for manual copy
            const range = document.createRange();
            range.selectNodeContents(mcpCommand);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
            button.textContent = 'Selecionado';
        }
        setTimeout(() => { button.textContent = 'Copiar'; }, 2000);
    });
    const loadMcpInfo = () => {
        const base = (window.appConfig?.basePath || '').replace(/\/+$/, '');
        fetch(`${base}/api/mcp-info`, { credentials: 'same-origin', cache: 'no-store' })
            .then(r => r.json())
            .then(info => {
                mcpCommand.textContent = info.claude;
                body.querySelector('[data-mcp-url]').textContent = info.url;
            })
            .catch(() => { mcpCommand.textContent = 'Não foi possível carregar.'; });
    };

    const sync = () => {
        body.querySelectorAll('[data-setting]').forEach(input => {
            const value = settings.get(input.dataset.setting);
            if (input.type === 'checkbox') input.checked = !!value;
            else input.value = String(value);
        });
        body.querySelectorAll('output[data-for]').forEach(out => {
            const v = settings.get(out.dataset.for);
            out.textContent = out.dataset.for === 'fontSize' ? `${v}px` : Number(v).toFixed(2);
        });
        body.querySelector('[data-shell]').textContent = getSession()?.shell || '—';
    };

    body.addEventListener('input', e => {
        const input = e.target.closest('[data-setting]');
        if (!input) return;
        let value = input.type === 'checkbox' ? input.checked : input.value;
        if (input.dataset.type === 'number') value = Number(value);
        // Text fields persist on change, not on every keystroke
        if (input.type === 'text') return;
        settings.set(input.dataset.setting, value);
        sync();
    });
    body.addEventListener('change', e => {
        const input = e.target.closest('[data-setting]');
        if (input?.type === 'text') settings.set(input.dataset.setting, input.value.trim());
    });

    const commandsAdmin = mountCommandsAdmin(body.querySelector('[data-commands]'), commands);

    // Pairing another device by QR code (single-use, 2 minutes)
    const pairBox = body.querySelector('.pair-box');
    const pairInfo = body.querySelector('[data-pair-info]');
    const pairShow = body.querySelector('[data-pair-show]');
    let pairTimer = null;
    const stopPair = () => {
        clearInterval(pairTimer);
        pairTimer = null;
        pairBox.hidden = true;
        body.querySelector('[data-pair-qr]').innerHTML = '';
        pairShow.textContent = 'Mostrar QR code';
    };
    pairShow.addEventListener('click', async () => {
        if (pairTimer) return stopPair();
        pairShow.disabled = true;
        try {
            const base = (window.appConfig?.basePath || '').replace(/\/+$/, '');
            const r = await fetch(`${base}/api/pair`, { method: 'POST', credentials: 'same-origin' });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
            body.querySelector('[data-pair-qr]').innerHTML = data.svg; // generated by the server from our own URL
            pairBox.hidden = false;
            pairShow.textContent = 'Esconder';
            let left = data.expiresIn;
            const tick = () => {
                pairInfo.textContent = left > 0 ? `Expira em ${left} s.` : 'Expirou. Gere outro.';
                if (left-- <= 0) {
                    clearInterval(pairTimer);
                    pairTimer = null;
                    body.querySelector('[data-pair-qr]').innerHTML = '';
                    pairShow.textContent = 'Gerar outro QR code';
                }
            };
            tick();
            pairTimer = setInterval(tick, 1000);
        } catch (e) {
            toast(e.message, { tone: 'error' });
        } finally {
            pairShow.disabled = false;
        }
        return undefined;
    });
    // Push notifications for this device
    const pushEl = {
        status: body.querySelector('[data-push-status]'),
        toggle: body.querySelector('[data-push-toggle]'),
        test: body.querySelector('[data-push-test]'),
    };
    const loadPush = async () => {
        let s;
        try {
            s = await pushStatus();
        } catch (e) {
            s = { supported: false, reason: e.message };
        }
        pushEl.toggle.hidden = !s.supported;
        pushEl.test.hidden = !s.subscribed;
        if (!s.supported) {
            pushEl.status.textContent = s.reason;
            return;
        }
        const others = s.devices ? ` Aparelhos com notificações: ${s.devices}.` : '';
        pushEl.status.textContent = s.subscribed ? `Ativadas neste aparelho.${others}`
            : s.permission === 'denied' ? 'Bloqueadas neste navegador: libere as notificações do site nas configurações.'
                : `Desativadas neste aparelho.${others}`;
        pushEl.toggle.textContent = s.subscribed ? 'Desativar neste aparelho' : 'Ativar neste aparelho';
        pushEl.toggle.className = `btn ${s.subscribed ? 'btn-ghost' : 'btn-primary'}`;
        pushEl.toggle.dataset.on = s.subscribed ? '1' : '';
    };
    pushEl.toggle.addEventListener('click', async () => {
        pushEl.toggle.disabled = true;
        try {
            if (pushEl.toggle.dataset.on) await disablePush();
            else {
                await enablePush();
                toast('Notificações ativadas. Enviando um teste…');
                await testPush();
            }
        } catch (e) {
            toast(e.message, { tone: 'error', duration: 6000 });
        } finally {
            pushEl.toggle.disabled = false;
            loadPush();
        }
    });
    pushEl.test.addEventListener('click', async () => {
        try {
            const r = await testPush();
            toast(r.sent ? `Teste enviado para ${r.sent} aparelho(s).` : 'Nenhum aparelho recebeu o teste.');
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    });

    // Agent UI preferences (server side: the same on every device)
    const agentIntercept = body.querySelector('[data-agent-intercept]');
    const agentPrefs = body.querySelector('[data-agent-prefs]');
    const agentApi = (method, route, data) => {
        const base = (window.appConfig?.basePath || '').replace(/\/+$/, '');
        return fetch(`${base}/api/${route}`, {
            method,
            credentials: 'same-origin',
            cache: 'no-store',
            headers: data ? { 'Content-Type': 'application/json' } : undefined,
            body: data ? JSON.stringify(data) : undefined,
        }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`Erro ${r.status}`))));
    };
    const renderAgentPrefs = (agents, prefs) => {
        agentIntercept.checked = prefs.intercept;
        agentPrefs.innerHTML = agents.filter(a => !a.terminalOnly).map(a => `
            <label class="setting">
                <span class="setting-text">${a.label}
                    <span class="setting-help">${a.installed ? '' : 'Adaptador não instalado: abre sempre no terminal.'}</span></span>
                <select data-agent-pref="${a.id}"${prefs.intercept ? '' : ' disabled'}>
                    <option value="ask">Perguntar</option>
                    <option value="ui">Sempre no modo UI</option>
                    <option value="terminal">Sempre no terminal</option>
                </select>
            </label>`).join('');
        agentPrefs.querySelectorAll('[data-agent-pref]').forEach(sel => { sel.value = prefs.agents[sel.dataset.agentPref] || 'ask'; });
    };
    let agentList = [];
    const loadAgentPrefs = () => Promise.all([agentApi('GET', 'agents'), agentApi('GET', 'agent-prefs')])
        .then(([info, prefs]) => {
            agentList = info.agents;
            body.querySelector('.agent-ui-section').hidden = !info.enabled;
            renderAgentPrefs(agentList, prefs);
        })
        .catch(() => { body.querySelector('.agent-ui-section').hidden = true; });
    const saveAgentPrefs = data => agentApi('PUT', 'agent-prefs', data)
        .then(prefs => renderAgentPrefs(agentList, prefs))
        .catch(e => toast(`Não foi possível salvar: ${e.message}`, { tone: 'error' }));
    agentIntercept.addEventListener('change', () => saveAgentPrefs({ intercept: agentIntercept.checked }));
    agentPrefs.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-agent-pref]');
        if (sel) saveAgentPrefs({ agents: { [sel.dataset.agentPref]: sel.value } });
    });

    return {
        refresh() {
            sync();
            commandsAdmin.refresh();
            loadMcpInfo();
            loadPush();
            loadAgentPrefs();
        },
        stopPair,
    };
}

/**
 * Settings popup (the `<dialog>` wrapper). Every control maps to a real setting in SettingsManager.
 * @param {import('../managers/settings.js').default} settings
 * @param {() => any} getSession - active session (for read-only shell info)
 * @param {import('../managers/commands.js').default} commands - quick commands (server)
 */
export function createSettingsDialog(settings, getSession, commands) {
    const dialog = createDialog('settings-dialog', 'Configurações');
    const body = dialog.querySelector('.dialog-body');
    const sections = mountSettingsSections(body, { settings, getSession, commands });
    dialog.addEventListener('close', sections.stopPair);
    return {
        open() {
            sections.refresh();
            dialog.showModal();
        },
    };
}

/**
 * Keyboard shortcut reference.
 * @param {Array<{keys: string, label: string}>} shortcuts
 */
export function createShortcutsDialog(shortcuts) {
    const dialog = createDialog('shortcuts-dialog', 'Atalhos de teclado');
    const body = dialog.querySelector('.dialog-body');
    const list = document.createElement('dl');
    list.className = 'shortcut-list';
    shortcuts.forEach(({ keys, label }) => {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        keys.split(' / ').forEach((combo, i) => {
            if (i > 0) dd.append(' ou ');
            combo.split('+').forEach((k, j) => {
                if (j > 0) dd.append('+');
                const kbd = document.createElement('kbd');
                kbd.textContent = k;
                dd.appendChild(kbd);
            });
        });
        list.append(dt, dd);
    });
    const note = document.createElement('p');
    note.className = 'dialog-note';
    note.textContent = 'Ctrl+T e Ctrl+W sozinhos não são usados: no navegador eles abrem/fecham abas do '
        + 'próprio navegador e, no shell, Ctrl+W apaga a palavra anterior.';
    body.append(list, note);
    return { open: () => dialog.showModal() };
}
