/**
 * tabbar.js
 * Browser-style tab strip: rendering, keyboard navigation (WAI-ARIA tabs pattern),
 * drag-and-drop reordering (mouse), long press menu (touch) and inline rename.
 * Holds no session logic - it only reports user intent through the handlers.
 */
import { icon } from './icons.js';

const STATE_LABELS = {
    connecting: 'Conectando',
    connected: 'Conectado',
    reconnecting: 'Reconectando',
    disconnected: 'Desconectado',
    exited: 'Encerrado',
    error: 'Erro',
};

const LONG_PRESS_MS = 500;
const canDrag = () => window.matchMedia('(pointer: fine)').matches;

export default class TabBar {
    /**
     * @param {HTMLElement} list - element with role="tablist"
     * @param {object} handlers - onActivate, onClose, onMenu, onReorder, onRename, onRenameDone
     */
    constructor(list, handlers) {
        this.list = list;
        this.handlers = handlers;
        this.tabs = new Map(); // id -> element
        this.activeId = null;
        this.list.addEventListener('keydown', e => this.onKeyDown(e));
        // Vertical wheel scrolls the strip horizontally (mouse users with many tabs)
        this.list.addEventListener('wheel', e => {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
                this.list.scrollLeft += e.deltaY;
                e.preventDefault();
            }
        }, { passive: false });
    }

    add(session, index = this.tabs.size) {
        const el = document.createElement('div');
        el.className = 'tab';
        el.id = `tab-${session.id}`;
        el.dataset.id = session.id;
        el.setAttribute('role', 'tab');
        el.setAttribute('aria-controls', `panel-${session.id}`);
        el.tabIndex = -1;
        el.innerHTML = `
            <span class="tab-dot" aria-hidden="true"></span>
            <span class="tab-text">
                <span class="tab-name"></span>
                <span class="tab-sub"></span>
            </span>
            <span class="tab-pin" aria-hidden="true">${icon('pin', 13)}</span>
            <button type="button" class="tab-close" tabindex="-1">${icon('x', 15)}</button>`;

        this.bindTab(el, session.id);
        const before = this.list.children[index] || null;
        this.list.insertBefore(el, before);
        this.tabs.set(session.id, el);
        this.update(session);
        return el;
    }

    bindTab(el, id) {
        const closeBtn = el.querySelector('.tab-close');
        let suppressClick = false;
        let pressTimer = null;
        let pressStart = null;
        let lastMenuAt = 0;

        const openMenu = (x, y) => {
            lastMenuAt = Date.now();
            this.handlers.onMenu(id, { x, y, anchor: el });
        };

        el.addEventListener('click', e => {
            if (suppressClick) { suppressClick = false; return; }
            if (e.target.closest('.tab-close') || el.querySelector('.tab-rename')) return;
            this.handlers.onActivate(id);
        });
        closeBtn.addEventListener('click', e => {
            e.stopPropagation();
            this.handlers.onClose(id);
        });
        el.addEventListener('dblclick', e => {
            if (!e.target.closest('.tab-close')) this.startRename(id);
        });
        el.addEventListener('auxclick', e => {
            if (e.button === 1) { // middle click closes, like a browser
                e.preventDefault();
                this.handlers.onClose(id);
            }
        });
        el.addEventListener('contextmenu', e => {
            e.preventDefault();
            // Android fires contextmenu on long press too - avoid opening twice
            if (Date.now() - lastMenuAt < 800) return;
            openMenu(e.clientX, e.clientY);
        });

        // Long press for touch (iOS never fires contextmenu)
        el.addEventListener('pointerdown', e => {
            if (e.pointerType !== 'touch') return;
            pressStart = { x: e.clientX, y: e.clientY };
            pressTimer = setTimeout(() => {
                suppressClick = true;
                navigator.vibrate?.(10);
                openMenu(pressStart.x, pressStart.y);
            }, LONG_PRESS_MS);
        });
        const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
        el.addEventListener('pointermove', e => {
            // Moving the finger means the user is scrolling the strip, not pressing
            if (pressTimer && pressStart
                && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 8) cancelPress();
        });
        el.addEventListener('pointerup', cancelPress);
        el.addEventListener('pointercancel', cancelPress);

        // Mouse drag-and-drop reordering
        el.draggable = canDrag();
        el.addEventListener('dragstart', e => {
            this.dragId = id;
            el.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(id));
        });
        el.addEventListener('dragend', () => {
            el.classList.remove('dragging');
            this.dragId = null;
            this.handlers.onReorder(this.order());
        });
        el.addEventListener('dragover', e => {
            if (this.dragId == null || this.dragId === id) return;
            e.preventDefault();
            const dragged = this.tabs.get(this.dragId);
            const rect = el.getBoundingClientRect();
            const after = e.clientX > rect.left + rect.width / 2;
            const ref = after ? el.nextSibling : el;
            if (ref !== dragged && dragged.nextSibling !== ref) this.list.insertBefore(dragged, ref);
        });
        el.addEventListener('drop', e => e.preventDefault());
    }

    remove(id) {
        this.tabs.get(id)?.remove();
        this.tabs.delete(id);
    }

    /** Re-renders one tab from its session (cheap: only touches that element). */
    update(session) {
        const el = this.tabs.get(session.id);
        if (!el) return;
        const nameEl = el.querySelector('.tab-name');
        if (nameEl && nameEl.textContent !== session.name) nameEl.textContent = session.name;
        el.dataset.state = session.state;
        el.dataset.color = session.color;
        el.classList.toggle('browser', session.kind === 'browser');
        el.classList.toggle('pinned', session.pinned);
        el.classList.toggle('activity', session.hasActivity && session.id !== this.activeId);
        const stateLabel = STATE_LABELS[session.state] || session.state;
        const where = session.displayCwd();
        // Second line: where the session is; while not connected, say why
        const sub = session.state === 'connected' ? (where || session.shell || '') : stateLabel;
        const subEl = el.querySelector('.tab-sub');
        if (subEl.textContent !== sub) subEl.textContent = sub;
        el.setAttribute('aria-label', `${session.name}, ${stateLabel}${session.pinned ? ', fixada' : ''}`);
        el.title = [session.name, stateLabel, session.process, where].filter(Boolean).join(' · ');
        el.querySelector('.tab-close').setAttribute('aria-label', `Fechar ${session.name}`);
    }

    setActive(id) {
        this.activeId = id;
        this.tabs.forEach((el, tabId) => {
            const active = tabId === id;
            el.classList.toggle('active', active);
            el.setAttribute('aria-selected', String(active));
            el.tabIndex = active ? 0 : -1; // roving tabindex
            if (active) el.classList.remove('activity');
        });
        this.scrollIntoView(id);
    }

    scrollIntoView(id) {
        const el = this.tabs.get(id);
        if (!el) return;
        const reduce = document.documentElement.hasAttribute('data-reduced-motion')
            || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    }

    /** Applies an order (array of ids) to the DOM. */
    reorder(ids) {
        ids.forEach(id => {
            const el = this.tabs.get(id);
            if (el) this.list.appendChild(el);
        });
    }

    order() {
        return Array.from(this.list.children).map(el => el.dataset.id);
    }

    focusTab(id) {
        this.tabs.get(id)?.focus();
    }

    onKeyDown(e) {
        const tab = e.target.closest('.tab');
        if (!tab || e.target.closest('.tab-rename')) return;
        const ids = this.order();
        const i = ids.indexOf(tab.dataset.id);
        const move = j => {
            const el = this.tabs.get(ids[(j + ids.length) % ids.length]);
            el?.focus();
            el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        };
        const id = ids[i];
        switch (e.key) {
            case 'ArrowRight': e.preventDefault(); move(i + 1); break;
            case 'ArrowLeft': e.preventDefault(); move(i - 1); break;
            case 'Home': e.preventDefault(); move(0); break;
            case 'End': e.preventDefault(); move(ids.length - 1); break;
            case 'Enter':
            case ' ': e.preventDefault(); this.handlers.onActivate(id); break;
            case 'Delete': e.preventDefault(); this.handlers.onClose(id); break;
            case 'F2': e.preventDefault(); this.startRename(id); break;
            case 'ContextMenu': {
                e.preventDefault();
                const r = tab.getBoundingClientRect();
                this.handlers.onMenu(id, { x: r.left, y: r.bottom + 4, anchor: tab });
                break;
            }
            default:
                if (e.key === 'F10' && e.shiftKey) {
                    e.preventDefault();
                    const r = tab.getBoundingClientRect();
                    this.handlers.onMenu(id, { x: r.left, y: r.bottom + 4, anchor: tab });
                }
        }
    }

    startRename(id) {
        const el = this.tabs.get(id);
        const nameEl = el?.querySelector('.tab-name');
        if (!nameEl || el.querySelector('.tab-rename')) return;
        const current = nameEl.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'tab-rename';
        input.value = current;
        input.maxLength = 60;
        input.setAttribute('aria-label', 'Nome da sessão');
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('autocorrect', 'off');
        input.spellcheck = false;
        el.draggable = false;
        nameEl.hidden = true;
        nameEl.after(input);
        input.focus();
        input.select();

        let done = false;
        const finish = commit => {
            if (done) return;
            done = true;
            const name = input.value.trim();
            input.remove();
            nameEl.hidden = false;
            el.draggable = canDrag();
            if (commit && name && name !== current) this.handlers.onRename(id, name);
            this.handlers.onRenameDone(id);
        };
        input.addEventListener('keydown', e => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', e => e.stopPropagation());
    }
}
