/**
 * loading.js
 * Tela "Abrindo…" enquanto uma aba nova (arquivos, navegador, agente, anotações) é criada no
 * servidor: aparece na hora do toque e segura toques repetidos, que antes abriam várias iguais.
 */
import { icon } from './icons.js';

let el = null;
let busy = null; // a promessa da abertura em andamento

function show(label, iconName) {
    if (!el) {
        el = document.createElement('div');
        el.className = 'mt-loading';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    el.innerHTML = `
        <div class="mt-loading-card">
            <span class="mt-loading-icon">${iconName ? icon(iconName, 26) : ''}</span>
            <span class="mt-loading-spin" aria-hidden="true"></span>
            <p class="mt-loading-text">Abrindo ${label}…</p>
            <p class="mt-loading-sub">Está carregando, só um instante.</p>
        </div>`;
    el.hidden = false;
    // Só aparece se demorar mais que um piscar (aberturas rápidas não piscam a tela)
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
 * @template T @param {string} label @param {string|null} iconName @param {() => Promise<T>} fn
 */
export function withLoading(label, iconName, fn) {
    if (busy) return busy;
    show(label, iconName);
    busy = Promise.resolve().then(fn).finally(() => {
        busy = null;
        hide();
    });
    return busy;
}

export const isLoading = () => !!busy;

/** Nome e ícone de cada tipo de aba, para a mensagem. */
export const KIND_LABEL = {
    terminal: ['o terminal', 'terminal'],
    browser: ['o navegador', 'globe'],
    files: ['os arquivos', 'folder'],
    notes: ['as anotações', 'notes'],
};
