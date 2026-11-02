/**
 * commandPalette.js
 * Paleta do desktop (⌘K / Ctrl+Alt+K): busca num lugar só as ações, as abas abertas, os apps e as
 * conversas. Setas navegam, Enter abre, Esc fecha.
 */
import { icon } from './icons.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Sem acento e sem maiúscula: "anotacoes" acha "Anotações"
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let openNow = null;

/**
 * @param {() => Array<{group: string, label: string, hint?: string, icon?: string, run: () => void}>} getItems
 */
export function openCommandPalette(getItems) {
    if (openNow) { openNow.close(); return; }
    const opener = document.activeElement;
    const all = getItems();
    let shown = [];
    let selected = 0;

    const backdrop = document.createElement('div');
    backdrop.className = 'cp-backdrop';
    backdrop.innerHTML = `
        <div class="cp" role="dialog" aria-modal="true" aria-label="Buscar">
            <label class="cp-search">${icon('search', 17)}
                <input type="text" placeholder="Buscar conversas, abas, apps e ações…" aria-label="Buscar" autocomplete="off" spellcheck="false">
            </label>
            <div class="cp-list" role="listbox"></div>
        </div>`;
    document.body.appendChild(backdrop);
    const input = backdrop.querySelector('input');
    const list = backdrop.querySelector('.cp-list');

    const close = (restore = true) => {
        openNow = null;
        backdrop.remove();
        if (restore) opener?.focus?.();
    };
    openNow = { close };

    function render() {
        const q = fold(input.value.trim());
        shown = all.filter(i => !q || fold(`${i.label} ${i.hint || ''} ${i.group}`).includes(q)).slice(0, 60);
        selected = Math.min(selected, Math.max(shown.length - 1, 0));
        let html = '';
        let group = null;
        shown.forEach((item, i) => {
            if (item.group !== group) {
                group = item.group;
                html += `<div class="cp-group">${esc(group)}</div>`;
            }
            html += `<button type="button" class="cp-item${i === selected ? ' is-selected' : ''}" role="option" aria-selected="${i === selected}" data-i="${i}">
                <span class="cp-ic">${icon(item.icon || 'bolt', 16)}</span>
                <span class="cp-label">${esc(item.label)}</span>
                ${item.hint ? `<span class="cp-hint">${esc(item.hint)}</span>` : ''}
            </button>`;
        });
        list.innerHTML = html || '<p class="cp-empty">Nada encontrado.</p>';
        list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' });
    }

    function run(i) {
        const item = shown[i];
        if (!item) return;
        close(false);
        item.run();
    }

    input.addEventListener('input', () => { selected = 0; render(); });
    backdrop.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); selected = Math.min(selected + 1, shown.length - 1); render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(selected); }
    });
    backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
    list.addEventListener('click', e => {
        const item = e.target.closest('[data-i]');
        if (item) run(Number(item.dataset.i));
    });
    render();
    input.focus();
    return { close };
}
