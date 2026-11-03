/**
 * loading.js
 * Tela de carregamento: o logo do app ou agente numa peça arredondada, com um anel girando em volta.
 * withLoading aparece ao abrir uma aba nova e segura toques repetidos (antes cada toque abria outra
 * igual); loaderHtml é a mesma peça dentro de uma tela ("Conectando ao agente…").
 */
import { icon } from './icons.js';

let el = null;
let busy = null; // a promessa da abertura em andamento

/** @param {{ iconName?: string, title: string, sub?: string, color?: string, small?: boolean }} o */
export function loaderHtml({ iconName = 'bot', title, sub = '', color = '', small = false }) {
    return `<div class="mt-loader${small ? ' is-small' : ''}" ${color ? `style="--mark: var(--c-${color})"` : ''}>
            <span class="mt-loader-mark" aria-hidden="true">
                <span class="mt-loader-ring"></span>
                <span class="mt-loader-logo">${icon(iconName, small ? 26 : 34)}</span>
            </span>
            <p class="mt-loader-title">${title}</p>
            ${sub ? `<p class="mt-loader-sub">${sub}</p>` : ''}
        </div>`;
}

function show(label, iconName, color) {
    if (!el) {
        el = document.createElement('div');
        el.className = 'mt-loading';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    el.innerHTML = loaderHtml({ iconName: iconName || 'bot', title: `Abrindo ${label}`, sub: 'Está carregando…', color });
    el.hidden = false;
    // Segura os toques já; só aparece se demorar mais que um piscar (a demora vem do CSS)
    el.classList.remove('is-on');
    requestAnimationFrame(() => el && el.classList.add('is-on'));
}

function hide() {
    if (el) {
        el.classList.remove('is-on');
        el.hidden = true;
    }
}

/**
 * Roda fn com a tela de carregamento. Uma abertura por vez: se já há uma em andamento, devolve a
 * mesma promessa (o segundo toque não abre outra aba).
 * @template T @param {string} label @param {string|null} iconName @param {() => Promise<T>} fn @param {string} [color]
 */
export function withLoading(label, iconName, fn, color = '') {
    if (busy) return busy;
    show(label, iconName, color);
    busy = Promise.resolve().then(fn).finally(() => {
        busy = null;
        hide();
    });
    return busy;
}

export const isLoading = () => !!busy;

/** Nome, ícone e cor de cada tipo de aba, para a mensagem. */
export const KIND_LABEL = {
    terminal: ['o terminal', 'terminal', 'green'],
    browser: ['o navegador', 'globe', 'blue'],
    files: ['os arquivos', 'folder', 'orange'],
    notes: ['as anotações', 'notes', 'yellow'],
};
