/**
 * dialogs.js
 * Settings and keyboard-shortcut dialogs built on the native <dialog> element
 * (focus trapping, Esc to close and the backdrop come from the browser).
 */
import { icon } from './icons.js';

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
 * Settings dialog. Every control maps to a real setting in SettingsManager.
 * @param {import('../managers/settings.js').default} settings
 * @param {() => any} getSession - active session (for read-only shell info)
 */
export function createSettingsDialog(settings, getSession) {
    const dialog = createDialog('settings-dialog', 'Configurações');
    const body = dialog.querySelector('.dialog-body');
    body.innerHTML = `
        <section class="settings-section">
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
        <section class="settings-section">
            <h3 class="section-label">Interface</h3>
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
        <section class="settings-section">
            <h3 class="section-label">Sessão</h3>
            <label class="setting setting-stack">
                <span class="setting-text">Diretório padrão
                    <span class="setting-help">Usado em novas sessões. Vazio = diretório padrão do servidor</span></span>
                <input type="text" class="mono" data-setting="defaultCwd" placeholder="~"
                    autocapitalize="off" autocorrect="off" spellcheck="false">
            </label>
            <label class="setting">
                <span class="setting-text">Restaurar conteúdo das abas
                    <span class="setting-help">Guarda a última saída neste navegador para mostrar ao reabrir.
                    Desative se o terminal exibir dados sensíveis.</span></span>
                <input type="checkbox" class="switch" data-setting="restoreContent">
            </label>
        </section>`;

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

    return {
        open() {
            sync();
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
