/**
 * search.js
 * Find-in-terminal bar for the active session (xterm search addon), with match count.
 * Lives over the top-right corner of the terminal area; Esc closes it.
 */
import { icon } from './icons.js';

function decorations() {
    const css = getComputedStyle(document.documentElement);
    const v = name => css.getPropertyValue(name).trim();
    return {
        matchBackground: v('--search-match'),
        matchOverviewRuler: v('--search-match'),
        activeMatchBackground: v('--search-active'),
        activeMatchColorOverviewRuler: v('--search-active'),
    };
}

export default class SearchBar {
    /**
     * @param {HTMLElement} host - workspace element
     * @param {{ getSession: () => any }} deps
     */
    constructor(host, { getSession }) {
        this.getSession = getSession;
        this.el = document.createElement('div');
        this.el.className = 'search-bar';
        this.el.hidden = true;
        this.el.setAttribute('role', 'search');
        this.el.innerHTML = `
            ${icon('search', 15)}
            <input type="search" placeholder="Buscar no terminal" aria-label="Buscar no terminal"
                autocapitalize="off" autocorrect="off" spellcheck="false">
            <span class="search-count" aria-live="polite"></span>
            <button type="button" class="icon-btn" data-dir="prev" aria-label="Resultado anterior">${icon('chevronLeft', 15)}</button>
            <button type="button" class="icon-btn" data-dir="next" aria-label="Próximo resultado">${icon('chevronRight', 15)}</button>
            <button type="button" class="icon-btn" data-close aria-label="Fechar busca">${icon('x', 15)}</button>`;
        host.appendChild(this.el);

        this.input = this.el.querySelector('input');
        this.count = this.el.querySelector('.search-count');
        let debounce;
        this.input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => this.find('next', true), 150);
        });
        this.input.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this.find(e.shiftKey ? 'prev' : 'next');
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.close();
            }
        });
        this.el.querySelector('[data-dir="prev"]').addEventListener('click', () => this.find('prev'));
        this.el.querySelector('[data-dir="next"]').addEventListener('click', () => this.find('next'));
        this.el.querySelector('[data-close]').addEventListener('click', () => this.close());
    }

    get isOpen() {
        return !this.el.hidden;
    }

    open() {
        this.el.hidden = false;
        this.input.focus();
        this.input.select();
        this.bind(this.getSession());
    }

    /** Hooks the result counter to the active session's search addon. */
    bind(session) {
        this.resultsListener?.dispose();
        this.resultsListener = session?.addons.search.onDidChangeResults?.(({ resultIndex, resultCount }) => {
            this.count.textContent = resultCount
                ? `${resultIndex + 1}/${resultCount}` : (this.input.value ? '0/0' : '');
        });
        if (this.isOpen && this.input.value) this.find('next', true);
    }

    find(dir, incremental = false) {
        const session = this.getSession();
        const term = this.input.value;
        if (!session) return;
        const search = session.addons.search;
        if (!term) {
            search.clearDecorations();
            this.count.textContent = '';
            return;
        }
        const opts = { incremental, decorations: decorations() };
        try {
            if (dir === 'prev') search.findPrevious(term, opts);
            else search.findNext(term, opts);
        } catch (e) {
            console.warn('Search failed:', e);
        }
    }

    close() {
        this.el.hidden = true;
        this.count.textContent = '';
        const session = this.getSession();
        session?.addons.search.clearDecorations();
        session?.focus();
    }
}
