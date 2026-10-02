/**
 * prompt.js
 * Small modal questions (name input, confirmation, info) on the native <dialog>, styled
 * like the settings dialog. Promise-based: askText() resolves to the text or null.
 */
import { icon } from './icons.js';

function build(title) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog prompt-dialog';
    dialog.innerHTML = `
        <form method="dialog" class="prompt-form">
            <header class="dialog-header">
                <h2 class="dialog-title"></h2>
                <button type="button" class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button>
            </header>
            <div class="dialog-body"></div>
            <footer class="prompt-actions"></footer>
        </form>`;
    dialog.querySelector('.dialog-title').textContent = title;
    document.body.appendChild(dialog);
    return dialog;
}

function run(dialog, { onSubmit, cancelValue = null }) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            dialog.close();
            dialog.remove();
            resolve(value);
        };
        dialog.querySelector('[data-close]').addEventListener('click', () => finish(cancelValue));
        dialog.querySelector('[data-cancel]')?.addEventListener('click', () => finish(cancelValue));
        dialog.addEventListener('cancel', e => {
            e.preventDefault();
            finish(cancelValue);
        });
        dialog.addEventListener('click', e => { if (e.target === dialog) finish(cancelValue); });
        dialog.querySelector('form').addEventListener('submit', e => {
            e.preventDefault();
            const value = onSubmit();
            if (value !== undefined) finish(value);
        });
        dialog.showModal();
    });
}

function actions(dialog, { confirm, danger = false, cancel = 'Cancelar' }) {
    const footer = dialog.querySelector('.prompt-actions');
    footer.innerHTML = `
        ${cancel ? '<button type="button" class="btn btn-ghost" data-cancel></button>' : ''}
        <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}"></button>`;
    if (cancel) footer.querySelector('[data-cancel]').textContent = cancel;
    footer.querySelector('[type="submit"]').textContent = confirm;
}

/**
 * Asks for a text (a name). Selects the part before the extension, like file managers.
 * @returns {Promise<string|null>}
 */
export function askText({ title, label, value = '', confirm = 'OK', placeholder = '', selectStem = false, validate, type = 'text' }) {
    const dialog = build(title);
    const body = dialog.querySelector('.dialog-body');
    body.innerHTML = `
        <label class="field">
            <span class="field-label"></span>
            <input type="text" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
        </label>
        <p class="prompt-error" role="alert"></p>`;
    body.querySelector('.field-label').textContent = label;
    const input = body.querySelector('input');
    input.type = type;
    input.value = value;
    input.placeholder = placeholder;
    actions(dialog, { confirm });
    const error = body.querySelector('.prompt-error');
    const done = run(dialog, {
        onSubmit: () => {
            const text = input.value.trim();
            const problem = !text ? 'Digite um nome.' : validate?.(text);
            if (problem) {
                error.textContent = problem;
                input.focus();
                return undefined;
            }
            return text;
        },
    });
    requestAnimationFrame(() => {
        input.focus();
        const dot = value.lastIndexOf('.');
        if (selectStem && dot > 0) input.setSelectionRange(0, dot);
        else input.select();
    });
    return done;
}

/** @returns {Promise<boolean>} */
export function askConfirm({ title, message, confirm = 'Confirmar', danger = false, details = [] }) {
    const dialog = build(title);
    const body = dialog.querySelector('.dialog-body');
    const p = document.createElement('p');
    p.className = 'prompt-message';
    p.textContent = message;
    body.appendChild(p);
    if (details.length) {
        const ul = document.createElement('ul');
        ul.className = 'prompt-details';
        details.slice(0, 8).forEach(text => {
            const li = document.createElement('li');
            li.textContent = text;
            ul.appendChild(li);
        });
        if (details.length > 8) {
            const li = document.createElement('li');
            li.textContent = `e mais ${details.length - 8}…`;
            ul.appendChild(li);
        }
        body.appendChild(ul);
    }
    actions(dialog, { confirm, danger });
    const done = run(dialog, { onSubmit: () => true, cancelValue: false });
    requestAnimationFrame(() => dialog.querySelector('[data-cancel]')?.focus());
    return done;
}

/**
 * Read-only facts (file properties). rows: [label, value, {mono?, action?: {label, run}}]
 */
export function showInfo({ title, rows }) {
    const dialog = build(title);
    const body = dialog.querySelector('.dialog-body');
    const dl = document.createElement('dl');
    dl.className = 'info-list';
    rows.forEach(([label, value, opts = {}]) => {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        const span = document.createElement('span');
        span.textContent = value;
        if (opts.mono) span.className = 'mono';
        dd.appendChild(span);
        if (opts.action) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-ghost btn-sm';
            btn.textContent = opts.action.label;
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                span.textContent = 'Calculando…';
                try {
                    span.textContent = await opts.action.run();
                    btn.remove();
                } catch (e) {
                    span.textContent = e.message || 'Erro';
                    btn.disabled = false;
                }
            });
            dd.appendChild(btn);
        }
        dl.append(dt, dd);
    });
    body.appendChild(dl);
    actions(dialog, { confirm: 'Fechar', cancel: '' });
    return run(dialog, { onSubmit: () => true });
}
