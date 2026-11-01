/**
 * sheet.js
 * A bottom sheet for the phone layout, with the same look as the agent's "Modelo e configurações"
 * and the session sheet (.ag-sheet in styles.css): inset from the screen edges, large radius,
 * grabber on top. Closes by tapping outside, the ✕, Esc, or dragging it down (from the top of its
 * content). The title bar can show a "‹ back" button for sheets with pages (Configurações).
 */
import { icon } from './icons.js';
import { present, dismiss } from './morph.js';

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.className] - extra class on the backdrop (to style one kind of sheet)
 * @param {() => void} [opts.onClose]
 * @param {HTMLElement} [opts.source] - the control that opened it: the sheet grows out of it (morph.js)
 * @param {boolean} [opts.page] - a full-screen page that slides in from the right (iOS navigation)
 *   instead of a bottom sheet: no grabber, no drag-down to close, no morph
 * @returns {{ body: HTMLElement, sheet: HTMLElement, setHead: (title: string, back?: {label: string, run: () => void}|null) => void, close: () => void }}
 */
export function openSheet({ title, className = '', onClose, source, page = false }) {
    if (page) source = null; // a página entra pela direita, não nasce do botão
    const backdrop = document.createElement('div');
    backdrop.className = `ag-sheet-backdrop ${page ? 'sheet-page ' : ''}${className}`.trim();
    backdrop.innerHTML = `
        <div class="ag-sheet" role="dialog" aria-modal="true">
            <div class="ag-sheet-grabber" aria-hidden="true"></div>
            <div class="ag-sheet-head">
                <button type="button" class="sheet-back" hidden></button>
                <h3></h3>
                <button type="button" class="icon-btn ag-sheet-close" aria-label="Fechar">${icon('x', 18)}</button>
            </div>
            <div class="sheet-body"></div>
        </div>`;
    document.body.appendChild(backdrop);
    const sheet = backdrop.querySelector('.ag-sheet');
    const heading = backdrop.querySelector('h3');
    const backBtn = backdrop.querySelector('.sheet-back');
    const body = backdrop.querySelector('.sheet-body');
    const opener = document.activeElement;
    let backAction = null;
    let closed = false;

    const setHead = (text, back = null) => {
        heading.textContent = text;
        sheet.setAttribute('aria-label', text);
        backAction = back?.run || null;
        backBtn.hidden = !back;
        if (back) backBtn.innerHTML = `${icon('chevronLeft', 20)}<span>${back.label}</span>`;
    };
    setHead(title);

    // Página: o "voltar" do sistema (Android, gesto do navegador) volta uma seção ou fecha
    let fromHistory = false;
    const onPop = () => {
        if (closed) return;
        if (backAction) { backAction(); history.pushState({ mtSheetPage: true }, ''); return; }
        fromHistory = true;
        close();
    };
    if (page) {
        history.pushState({ mtSheetPage: true }, '');
        window.addEventListener('popstate', onPop);
    }

    const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKey);
        if (page) {
            window.removeEventListener('popstate', onPop);
            if (!fromHistory && history.state?.mtSheetPage) history.back();
        }
        dismiss(backdrop, source, () => backdrop.remove(), body);
        onClose?.();
        if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus({ preventScroll: true });
    };
    const onKey = e => {
        // Esc goes back a page first, then closes - like the iOS navigation stack
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (document.querySelector('.ui-select-menu:popover-open, .menu')) return; // a list on top handles it
        e.preventDefault();
        if (backAction) backAction();
        else close();
    };
    document.addEventListener('keydown', onKey);
    backBtn.addEventListener('click', () => backAction?.());
    backdrop.querySelector('.ag-sheet-close').addEventListener('click', close);
    backdrop.addEventListener('click', e => {
        if (e.target === backdrop) close();
    });

    // Drag down to close: only when the content is scrolled to the top, so scrolling still works
    let startY = null;
    sheet.addEventListener('touchstart', e => {
        startY = page || sheet.scrollTop > 0 ? null : e.touches[0].clientY;
    }, { passive: true });
    sheet.addEventListener('touchmove', e => {
        if (startY === null) return;
        const dy = e.touches[0].clientY - startY;
        if (dy <= 0) return;
        sheet.style.transition = 'none';
        sheet.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    sheet.addEventListener('touchend', e => {
        if (startY === null) return;
        const dragged = e.changedTouches[0].clientY - startY;
        startY = null;
        sheet.style.transition = '';
        sheet.style.transform = '';
        if (dragged > 90) close();
    });

    present(backdrop, source, body);
    return { body, sheet, setHead, close };
}
