/**
 * sessionSheet.js
 * iPhone session switcher: a bottom sheet ("Sessões abertas") listing the open sessions - tap to
 * switch, ✕ to close, hold for the tab menu (rename, pin, split...) - plus "Nova sessão". Opened
 * from the session pill at the top and from the status bar's list button. Same look as the agent
 * settings sheet (.ag-sheet in styles.css).
 */
import { icon } from './icons.js';
import { esc } from '../agent/markdown.js';

const LONG_PRESS_MS = 500;
let current = null;

/** Icon for a session kind (same mapping as the session list menu). */
export function sessionIcon(session) {
    if (session.pinned) return 'pin';
    return { browser: 'globe', files: 'folder', notes: 'notes', agent: 'bot' }[session.kind] || 'terminal';
}

export function closeSessionSheet() {
    if (!current) return;
    const { backdrop, onKey } = current;
    current = null;
    document.removeEventListener('keydown', onKey);
    backdrop.classList.remove('open');
    setTimeout(() => backdrop.remove(), 300);
}

/**
 * @param {object} opts
 * @param {() => Array<{id: string, name: string, sub: string, icon: string, color: string, state: string, active: boolean}>} opts.getItems
 * @param {(id: string) => void} opts.onPick
 * @param {(id: string) => Promise<any>} opts.onClose - resolves once the session is gone (or kept)
 * @param {() => void} opts.onNew
 * @param {(id: string, pos: {x: number, y: number, anchor: Element}) => void} opts.onMenu
 */
export function openSessionSheet({ getItems, onPick, onClose, onNew, onMenu }) {
    closeSessionSheet();
    const backdrop = document.createElement('div');
    backdrop.className = 'ag-sheet-backdrop sessions-sheet';
    backdrop.innerHTML = `
        <div class="ag-sheet" role="dialog" aria-modal="true" aria-label="Sessões abertas">
            <div class="ag-sheet-grabber" aria-hidden="true"></div>
            <div class="ag-sheet-head"><h3>Sessões abertas</h3>
                <button type="button" class="icon-btn ss-add" aria-label="Nova sessão">${icon('plus', 22)}</button></div>
            <div class="ss-list" role="list"></div>
            <button type="button" class="ss-new">${icon('plus', 20)} Nova sessão</button>
        </div>`;
    document.body.appendChild(backdrop);
    const list = backdrop.querySelector('.ss-list');
    const sheet = backdrop.querySelector('.ag-sheet');

    const render = () => {
        const items = getItems();
        if (!items.length) return closeSessionSheet();
        list.innerHTML = items.map(s => `
            <div class="ss-row${s.active ? ' active' : ''}" role="listitem" data-id="${esc(s.id)}" data-state="${esc(s.state || '')}"
                style="--c: var(--c-${esc(s.color || 'green')})" tabindex="0" aria-current="${s.active ? 'true' : 'false'}">
                <span class="ss-dot" aria-hidden="true"></span>
                <span class="ss-icon" aria-hidden="true">${icon(s.icon, 20)}</span>
                <span class="ss-text"><b>${esc(s.name)}</b>${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</span>
                ${s.active ? `<span class="ss-check" aria-hidden="true">${icon('check', 22)}</span>` : ''}
                <button type="button" class="ss-close" aria-label="Fechar ${esc(s.name)}">${icon('x', 20)}</button>
            </div>`).join('');
    };
    render();

    const newSession = () => {
        closeSessionSheet();
        onNew();
    };
    backdrop.querySelector('.ss-add').addEventListener('click', newSession);
    backdrop.querySelector('.ss-new').addEventListener('click', newSession);

    // Hold a row for the tab menu; a plain tap switches to it
    let pressTimer = null;
    let pressed = false;
    list.addEventListener('pointerdown', e => {
        const row = e.target.closest('.ss-row');
        if (!row || e.target.closest('.ss-close')) return;
        pressed = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
            pressed = true;
            const r = row.getBoundingClientRect();
            closeSessionSheet();
            onMenu(row.dataset.id, { x: r.left + 16, y: r.top, anchor: row });
        }, LONG_PRESS_MS);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(type => list.addEventListener(type, () => clearTimeout(pressTimer)));
    list.addEventListener('contextmenu', e => e.preventDefault());
    list.addEventListener('click', async e => {
        const row = e.target.closest('.ss-row');
        if (!row || pressed) return;
        if (e.target.closest('.ss-close')) {
            await onClose(row.dataset.id);
            if (current) render();
            return;
        }
        closeSessionSheet();
        onPick(row.dataset.id);
    });
    list.addEventListener('keydown', e => {
        const row = e.target.closest('.ss-row');
        if (row && e.key === 'Enter') {
            closeSessionSheet();
            onPick(row.dataset.id);
        }
    });

    backdrop.addEventListener('click', e => {
        if (e.target === backdrop) closeSessionSheet();
    });
    const onKey = e => {
        if (e.key === 'Escape') closeSessionSheet();
    };
    document.addEventListener('keydown', onKey);

    // Drag the sheet down to close it
    let startY = null;
    sheet.addEventListener('touchstart', e => {
        startY = sheet.scrollTop > 0 ? null : e.touches[0].clientY;
    }, { passive: true });
    sheet.addEventListener('touchmove', e => {
        if (startY === null) return;
        const dy = Math.max(0, e.touches[0].clientY - startY);
        if (dy > 8) clearTimeout(pressTimer);
        sheet.style.transition = 'none';
        sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', e => {
        if (startY === null) return;
        const dragged = e.changedTouches[0].clientY - startY;
        startY = null;
        sheet.style.transition = '';
        sheet.style.transform = '';
        if (dragged > 80) closeSessionSheet();
    });

    current = { backdrop, onKey };
    requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('open')));
}
