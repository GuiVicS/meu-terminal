/**
 * listPopover.js
 * Small list popup anchored to a button (quick commands, recently copied).
 * It never takes focus from the terminal, so the phone keyboard stays open while
 * the user picks an item. Esc or a tap outside closes it.
 */
import { icon } from './icons.js';

let current = null;

export function closePopover() {
    if (!current) return;
    current.cleanup();
    current.el.remove();
    current = null;
}

/** Buttons act on pointerdown + preventDefault so focus stays in the terminal. */
function bindPress(btn, handler) {
    btn.addEventListener('pointerdown', e => e.preventDefault());
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', handler);
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {Element} opts.anchor
 * @param {Array<{primary: string, secondary?: string, badge?: string, onSelect: Function,
 *   onRemove?: Function, removeLabel?: string}>} opts.items
 * @param {string} opts.empty - text shown when there are no items
 * @param {string} [opts.note] - small help text under the title
 * @param {Array<{label: string, onClick: Function, tone?: 'danger'}>} [opts.actions]
 */
export function openPopover({ title, anchor, items, empty, note, actions = [] }) {
    closePopover();
    const el = document.createElement('div');
    el.className = 'popover';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', title);
    el.innerHTML = `
        <div class="popover-header">
            <span class="popover-title"></span>
            <button type="button" class="icon-btn popover-close" aria-label="Fechar">${icon('x', 16)}</button>
        </div>
        <p class="popover-note" hidden></p>
        <ul class="popover-list" role="list"></ul>
        <p class="popover-empty" hidden></p>
        <div class="popover-actions" hidden></div>`;
    el.querySelector('.popover-title').textContent = title;
    bindPress(el.querySelector('.popover-close'), closePopover);

    if (note) {
        const p = el.querySelector('.popover-note');
        p.textContent = note;
        p.hidden = false;
    }

    const list = el.querySelector('.popover-list');
    items.forEach(item => {
        const li = document.createElement('li');
        li.className = 'popover-item';
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'popover-main';
        main.innerHTML = '<span class="popover-primary"></span><span class="popover-secondary mono"></span>';
        main.querySelector('.popover-primary').textContent = item.primary;
        const secondary = main.querySelector('.popover-secondary');
        if (item.secondary) secondary.textContent = item.secondary;
        else secondary.remove();
        if (item.badge) {
            const badge = document.createElement('span');
            badge.className = 'popover-badge';
            badge.textContent = item.badge;
            main.appendChild(badge);
        }
        bindPress(main, () => {
            closePopover();
            item.onSelect();
        });
        li.appendChild(main);
        if (item.onRemove) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'icon-btn popover-remove';
            remove.setAttribute('aria-label', item.removeLabel || 'Remover');
            remove.innerHTML = icon('x', 14);
            bindPress(remove, () => {
                item.onRemove();
                li.remove();
                if (!list.children.length) showEmpty();
            });
            li.appendChild(remove);
        }
        list.appendChild(li);
    });

    const showEmpty = () => {
        const p = el.querySelector('.popover-empty');
        p.textContent = empty;
        p.hidden = false;
    };
    if (!items.length) showEmpty();

    if (actions.length) {
        const bar = el.querySelector('.popover-actions');
        bar.hidden = false;
        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'popover-action' + (action.tone === 'danger' ? ' danger' : '');
            btn.textContent = action.label;
            bindPress(btn, () => {
                closePopover();
                action.onClick();
            });
            bar.appendChild(btn);
        });
    }

    document.body.appendChild(el);
    position(el, anchor);

    const onKey = e => {
        if (e.key === 'Escape') closePopover();
    };
    const onOutside = e => {
        if (!el.contains(e.target) && !anchor.contains(e.target)) closePopover();
    };
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => document.addEventListener('pointerdown', onOutside, true), 0);
    const reposition = () => position(el, anchor);
    window.visualViewport?.addEventListener('resize', reposition);

    current = {
        el,
        cleanup: () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('pointerdown', onOutside, true);
            window.visualViewport?.removeEventListener('resize', reposition);
        },
    };
    return closePopover;
}

/** Opens above the anchor when it sits in the lower half (the shortcut bar), else below. */
function position(el, anchor) {
    const vw = window.visualViewport?.width || window.innerWidth;
    const vh = window.visualViewport?.height || window.innerHeight;
    const top = window.visualViewport?.offsetTop || 0;
    const a = anchor.getBoundingClientRect();
    const width = Math.min(380, vw - 16);
    el.style.width = `${width}px`;
    el.style.left = `${Math.max(8, Math.min(a.left, vw - width - 8))}px`;
    if (a.top - top > vh / 2) {
        el.style.top = '';
        el.style.bottom = `${Math.max(8, window.innerHeight - a.top + 8)}px`;
        el.style.maxHeight = `${Math.max(160, a.top - top - 16)}px`;
    } else {
        el.style.bottom = '';
        el.style.top = `${a.bottom + 8}px`;
        el.style.maxHeight = `${Math.max(160, vh - a.bottom - 16)}px`;
    }
}
