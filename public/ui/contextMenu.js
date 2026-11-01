/**
 * contextMenu.js
 * Accessible popup menu used for tab actions (right click / long press) and the
 * header overflow menu. Keyboard: arrows move, Enter activates, Esc closes.
 */
import { icon } from './icons.js';

let openMenu = null;

export function closeMenu() {
    if (!openMenu) return;
    const { el, restoreFocus, cleanup } = openMenu;
    openMenu = null;
    cleanup();
    // Phones: the menu shrinks back into its button (styles.css .menu-out); elsewhere it just goes
    if (document.documentElement.hasAttribute('data-iphone') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.classList.add('menu-out');
        el.setAttribute('inert', '');
        setTimeout(() => el.remove(), 180);
    } else {
        el.remove();
    }
    restoreFocus?.focus?.({ preventScroll: true });
}

/**
 * Opens a menu.
 * @param {Array<{label:string, icon?:string, hint?:string, run?:Function, disabled?:boolean,
 *   danger?:boolean, checked?:boolean} | 'separator'>} items
 * @param {{ x?: number, y?: number, anchor?: Element, label?: string, restoreFocus?: Element }} opts
 */
export function showMenu(items, { x = 0, y = 0, anchor = null, label = 'Menu', restoreFocus = null } = {}) {
    const pointer = { x, y }; // where a touch/right click opened it (x/y are moved to fit the screen)
    closeMenu();

    const el = document.createElement('div');
    el.className = 'menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', label);

    items.forEach(item => {
        if (item === 'separator') {
            const sep = document.createElement('div');
            sep.className = 'menu-separator';
            sep.setAttribute('role', 'separator');
            el.appendChild(sep);
            return;
        }
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'menu-item' + (item.danger ? ' danger' : '');
        btn.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
        if (item.checked !== undefined) btn.setAttribute('aria-checked', String(item.checked));
        btn.tabIndex = -1;
        btn.disabled = !!item.disabled;
        btn.innerHTML = `<span class="menu-icon">${item.icon ? icon(item.icon, 15) : ''}</span>`
            + `<span class="menu-label"></span>`
            + (item.hint ? `<kbd class="menu-hint"></kbd>` : '');
        btn.querySelector('.menu-label').textContent = item.label;
        if (item.hint) btn.querySelector('.menu-hint').textContent = item.hint;
        btn.addEventListener('click', () => {
            closeMenu();
            item.run?.();
        });
        el.appendChild(btn);
    });

    document.body.appendChild(el);

    // Position: under the anchor, or at the pointer; always kept inside the viewport
    const vw = window.visualViewport?.width || window.innerWidth;
    const vh = window.visualViewport?.height || window.innerHeight;
    const rect = el.getBoundingClientRect();
    if (anchor) {
        const a = anchor.getBoundingClientRect();
        x = a.right - rect.width;
        y = a.bottom + 4;
        if (x < 8) x = a.left;
        // No room below (a button at the bottom, like the agent composer): open above it
        if (y + rect.height > vh - 8 && a.top - rect.height - 4 >= 8) y = a.top - rect.height - 4;
    }
    x = Math.max(8, Math.min(x, vw - rect.width - 8));
    y = Math.max(8, Math.min(y, vh - rect.height - 8));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    // Grow out of what opened it (iOS 26 menus come out of their button): the anchor's center,
    // or the touch point, as the transform origin
    const a = anchor?.getBoundingClientRect();
    const ox = a ? a.left + a.width / 2 - x : pointer.x - x;
    const oy = a ? a.top + a.height / 2 - y : pointer.y - y;
    el.style.transformOrigin = `${Math.round(ox)}px ${Math.round(oy)}px`;

    const buttons = () => Array.from(el.querySelectorAll('.menu-item:not(:disabled)'));
    const focusAt = i => {
        const list = buttons();
        if (list.length) list[(i + list.length) % list.length].focus();
    };

    const onKey = e => {
        const list = buttons();
        const i = list.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); focusAt(i + 1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); focusAt(i - 1); }
        else if (e.key === 'Home') { e.preventDefault(); focusAt(0); }
        else if (e.key === 'End') { e.preventDefault(); focusAt(-1); }
        else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); }
    };
    const onPointer = e => {
        if (!el.contains(e.target)) closeMenu();
    };
    el.addEventListener('keydown', onKey);
    // Defer so the event that opened the menu doesn't immediately close it
    setTimeout(() => document.addEventListener('pointerdown', onPointer, true), 0);
    window.addEventListener('resize', closeMenu, { once: true });

    openMenu = {
        el,
        restoreFocus: restoreFocus || anchor,
        cleanup: () => document.removeEventListener('pointerdown', onPointer, true),
    };
    focusAt(0);
}
