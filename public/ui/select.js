/**
 * select.js
 * Themed replacement for native <select> popups (the OS list ignores the app's theme).
 * Every <select> in the app is enhanced automatically: the native element stays in the DOM
 * (hidden) as the source of truth, so forms, `select.value` and change listeners keep
 * working; a button + listbox mirror it. Phones get a bottom sheet. Opt out with
 * <select data-native>.
 */
import { icon } from './icons.js';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const phone = () => coarse() && window.innerWidth < 640;
const FILTER_FROM = 10; // long lists (agent models) get a search box
const hasPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

let current = null; // the open select, if any
let seq = 0;

class UiSelect {
    constructor(select) {
        this.select = select;
        this.id = `ui-select-${++seq}`;
        select._uiSelect = this;
        select.classList.add('ui-select-native');
        select.tabIndex = -1;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ui-select';
        btn.setAttribute('role', 'combobox');
        btn.setAttribute('aria-haspopup', 'listbox');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-controls', `${this.id}-list`);
        btn.innerHTML = `<span class="ui-select-value"></span><span class="ui-select-chevron" aria-hidden="true">${icon('chevronDown', 15)}</span>`;
        select.after(btn);
        this.btn = btn;
        this.valueEl = btn.querySelector('.ui-select-value');

        btn.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
        // Clicking the rest of the label (icon, setting name) opens it too, like a native select
        select.closest('label')?.addEventListener('click', e => {
            if (btn.contains(e.target) || e.target.closest('input, textarea, a, button')) return;
            e.preventDefault();
            btn.focus({ preventScroll: true });
            if (!this.isOpen) this.open();
        });
        btn.addEventListener('keydown', e => this.onButtonKey(e));
        this.observer = new MutationObserver(() => this.sync());
        this.observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true,
            attributeFilter: ['disabled', 'selected', 'label', 'aria-label', 'title'] });
        this.sync();
    }

    get isOpen() {
        return current === this;
    }

    label() {
        const s = this.select;
        return s.getAttribute('aria-label') || s.title || s.closest('label')?.querySelector('.setting-text, .field-label')?.firstChild?.textContent?.trim() || '';
    }

    /** Mirrors the native select (value, disabled, accessible name) on the button. */
    sync() {
        if (!this.select.isConnected) {
            this.observer.disconnect();
            return;
        }
        const option = this.select.selectedOptions[0];
        const text = option ? option.textContent.trim() : '—';
        if (this.valueEl.textContent !== text) {
            this.valueEl.textContent = text;
            this.btn.classList.remove('changed');
            void this.btn.offsetWidth; // restart the flash animation
            this.btn.classList.add('changed');
        }
        this.btn.disabled = this.select.disabled;
        const label = this.label();
        this.btn.setAttribute('aria-label', label ? `${label}: ${text}` : text);
        if (this.select.title) this.btn.title = this.select.title;
    }

    items() {
        return [...this.select.options].map((o, index) => ({
            option: o, index,
            group: o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : null,
        }));
    }

    // ---------- open / close ----------

    open() {
        if (this.btn.disabled) return;
        if (current) current.close({ restoreFocus: false });
        current = this;
        const sheet = phone();
        const menu = document.createElement('div');
        menu.className = `ui-select-menu${sheet ? ' sheet' : ''}`;
        menu.id = `${this.id}-list`;
        if (hasPopover) menu.setAttribute('popover', 'manual');
        const items = this.items();
        const label = this.label();
        menu.innerHTML = `
            ${sheet ? `<div class="ui-select-grabber" aria-hidden="true"></div>${label ? `<div class="ui-select-title"></div>` : ''}` : ''}
            ${items.length >= FILTER_FROM ? `<div class="ui-select-filter">${icon('search', 15)}<input type="search" placeholder="Filtrar…" aria-label="Filtrar opções" autocomplete="off" autocapitalize="off" spellcheck="false"></div>` : ''}
            <div class="ui-select-list" role="listbox" id="${this.id}-listbox"></div>`;
        if (sheet && label) menu.querySelector('.ui-select-title').textContent = label;
        this.menu = menu;
        this.list = menu.querySelector('.ui-select-list');
        this.filterInput = menu.querySelector('.ui-select-filter input');
        this.renderOptions('');

        // Top layer (above modal dialogs) when the browser has the Popover API
        (hasPopover ? document.body : (this.select.closest('dialog[open]') || document.body)).appendChild(menu);
        if (hasPopover) menu.showPopover();
        this.position();
        this.btn.setAttribute('aria-expanded', 'true');
        this.btn.classList.add('open');

        menu.addEventListener('click', e => {
            const row = e.target.closest('.ui-select-option');
            if (row && !row.classList.contains('disabled')) this.choose(Number(row.dataset.index));
            else if (e.target === menu && sheet) this.close(); // backdrop of the sheet
        });
        menu.addEventListener('pointermove', e => {
            const row = e.target.closest('.ui-select-option:not(.disabled)');
            if (row && e.pointerType === 'mouse') this.setActive(row);
        });
        menu.addEventListener('keydown', e => this.onMenuKey(e));
        this.filterInput?.addEventListener('input', () => this.renderOptions(this.filterInput.value));

        this.onOutside = e => {
            if (!menu.contains(e.target) && !this.btn.contains(e.target)) this.close({ restoreFocus: false });
        };
        this.onViewport = e => {
            if (e.type === 'scroll' && menu.contains(e.target)) return;
            if (sheet) return;
            this.close({ restoreFocus: false });
        };
        setTimeout(() => document.addEventListener('pointerdown', this.onOutside, true), 0);
        window.addEventListener('resize', this.onViewport);
        window.addEventListener('scroll', this.onViewport, true);

        const selected = this.list.querySelector('[aria-selected="true"]') || this.list.querySelector('.ui-select-option:not(.disabled)');
        if (selected) {
            this.setActive(selected);
            selected.scrollIntoView({ block: 'nearest' });
        }
        (this.filterInput && !coarse() ? this.filterInput : this.list).focus({ preventScroll: true });
    }

    close({ restoreFocus = true } = {}) {
        if (!this.isOpen) return;
        current = null;
        const menu = this.menu;
        this.menu = null;
        document.removeEventListener('pointerdown', this.onOutside, true);
        window.removeEventListener('resize', this.onViewport);
        window.removeEventListener('scroll', this.onViewport, true);
        this.btn.setAttribute('aria-expanded', 'false');
        this.btn.classList.remove('open');
        this.btn.removeAttribute('aria-activedescendant');
        // Short exit animation, then gone
        menu.classList.add('closing');
        const remove = () => {
            try { if (hasPopover && menu.matches(':popover-open')) menu.hidePopover(); } catch { /* already hidden */ }
            menu.remove();
        };
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) remove();
        else setTimeout(remove, 120);
        if (restoreFocus) this.btn.focus({ preventScroll: true });
    }

    /** Under the button (or above when there's no room); phones use a bottom sheet (CSS). */
    position() {
        const menu = this.menu;
        if (menu.classList.contains('sheet')) return;
        const r = this.btn.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        menu.style.minWidth = `${Math.max(r.width, 180)}px`;
        menu.style.maxWidth = `${Math.min(360, vw - 16)}px`;
        const h = Math.min(menu.scrollHeight, 340);
        const below = vh - r.bottom - 8;
        const up = below < Math.min(h, 220) && r.top > below;
        menu.classList.toggle('up', up);
        menu.style.maxHeight = `${Math.max(140, Math.min(340, (up ? r.top : below) - 8))}px`;
        const width = menu.offsetWidth;
        menu.style.left = `${Math.max(8, Math.min(r.left, vw - width - 8))}px`;
        menu.style.top = up ? 'auto' : `${r.bottom + 6}px`;
        menu.style.bottom = up ? `${vh - r.top + 6}px` : 'auto';
    }

    renderOptions(filter) {
        const q = filter.trim().toLowerCase();
        let lastGroup;
        const html = [];
        for (const { option, index, group } of this.items()) {
            if (q && !option.textContent.toLowerCase().includes(q) && !(group || '').toLowerCase().includes(q)) continue;
            if (group !== lastGroup) {
                if (group) html.push(`<div class="ui-select-group" role="presentation">${escapeHtml(group)}</div>`);
                lastGroup = group;
            }
            const selected = option.selected;
            html.push(`<div class="ui-select-option${option.disabled ? ' disabled' : ''}" role="option" id="${this.id}-o${index}"
                data-index="${index}" aria-selected="${selected}"${option.disabled ? ' aria-disabled="true"' : ''}>
                <span class="ui-select-check" aria-hidden="true">${icon('check', 15)}</span>
                <span class="ui-select-text">${escapeHtml(option.textContent.trim())}</span></div>`);
        }
        this.list.innerHTML = html.join('') || '<div class="ui-select-empty">Nada encontrado</div>';
        this.list.tabIndex = -1;
        const first = this.list.querySelector('.ui-select-option:not(.disabled)');
        if (q && first) this.setActive(first);
    }

    setActive(row) {
        this.list.querySelectorAll('.ui-select-option.active').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        this.list.setAttribute('aria-activedescendant', row.id);
        this.btn.setAttribute('aria-activedescendant', row.id);
    }

    move(delta) {
        const rows = [...this.list.querySelectorAll('.ui-select-option:not(.disabled)')];
        if (!rows.length) return;
        const i = rows.findIndex(r => r.classList.contains('active'));
        const next = delta === Infinity ? rows.length - 1 : delta === -Infinity ? 0
            : Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i + delta)));
        this.setActive(rows[next]);
        rows[next].scrollIntoView({ block: 'nearest' });
    }

    choose(index) {
        const option = this.select.options[index];
        if (!option || option.disabled) return;
        const changed = this.select.selectedIndex !== index;
        this.select.selectedIndex = index;
        this.sync();
        this.close();
        if (changed) {
            this.select.dispatchEvent(new Event('input', { bubbles: true }));
            this.select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    // ---------- keyboard ----------

    onButtonKey(e) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
            e.preventDefault();
            this.open();
        } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
            // Type-ahead without opening: jump to the next option starting with the letter
            const items = this.items().filter(x => !x.option.disabled);
            const start = items.findIndex(x => x.index === this.select.selectedIndex);
            const order = [...items.slice(start + 1), ...items.slice(0, start + 1)];
            const hit = order.find(x => x.option.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
            if (hit) {
                e.preventDefault();
                this.select.selectedIndex = hit.index;
                this.sync();
                this.select.dispatchEvent(new Event('input', { bubbles: true }));
                this.select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    onMenuKey(e) {
        const typingFilter = e.target === this.filterInput;
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); return this.move(1);
            case 'ArrowUp': e.preventDefault(); return this.move(-1);
            case 'PageDown': e.preventDefault(); return this.move(8);
            case 'PageUp': e.preventDefault(); return this.move(-8);
            case 'Home': if (typingFilter) return undefined; e.preventDefault(); return this.move(-Infinity);
            case 'End': if (typingFilter) return undefined; e.preventDefault(); return this.move(Infinity);
            case 'Enter': {
                e.preventDefault();
                const row = this.list.querySelector('.ui-select-option.active');
                return row ? this.choose(Number(row.dataset.index)) : undefined;
            }
            case ' ':
                if (typingFilter) return undefined;
                e.preventDefault();
                return this.list.querySelector('.ui-select-option.active') && this.choose(Number(this.list.querySelector('.ui-select-option.active').dataset.index));
            case 'Escape': e.preventDefault(); e.stopPropagation(); return this.close();
            case 'Tab': return this.close({ restoreFocus: false });
            default:
                if (!typingFilter && e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
                    const rows = [...this.list.querySelectorAll('.ui-select-option:not(.disabled)')];
                    const i = rows.findIndex(r => r.classList.contains('active'));
                    const order = [...rows.slice(i + 1), ...rows.slice(0, i + 1)];
                    const hit = order.find(r => r.textContent.trim().toLowerCase().startsWith(e.key.toLowerCase()));
                    if (hit) {
                        this.setActive(hit);
                        hit.scrollIntoView({ block: 'nearest' });
                    }
                }
                return undefined;
        }
    }
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Programmatic changes (`select.value = x`, `selectedIndex = n`) don't fire events: patch the
// setters once so enhanced selects always show the real value.
['value', 'selectedIndex'].forEach(prop => {
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(HTMLSelectElement.prototype, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get() { return desc.get.call(this); },
        set(v) {
            desc.set.call(this, v);
            this._uiSelect?.sync();
        },
    });
});

/** Enhances every select under `root` (idempotent). */
export function enhanceSelects(root = document) {
    const list = root.matches?.('select') ? [root] : [...root.querySelectorAll('select')];
    list.forEach(select => {
        if (!select._uiSelect && !select.hasAttribute('data-native') && !select.multiple && !(select.size > 1)) {
            new UiSelect(select);
        }
    });
}

/** Watches the page: selects rendered later (dialogs, agent tab) are enhanced too. */
export function autoEnhanceSelects() {
    enhanceSelects(document);
    new MutationObserver(records => {
        for (const r of records) {
            r.addedNodes.forEach(node => {
                if (node.nodeType === 1 && (node.tagName === 'SELECT' || node.querySelector?.('select'))) enhanceSelects(node);
            });
        }
    }).observe(document.body, { childList: true, subtree: true });
}
