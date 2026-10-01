/**
 * filePicker.js
 * "Escolher arquivos do servidor": a modal that browses this server's folders (the same API as
 * the files tab) and resolves with the files picked. Multi-select, filter, folder navigation.
 */
import { icon } from './icons.js';

const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const ICON_BY_EXT = [
    [IMAGE_EXT, 'fileImage'],
    [/\.(mp4|webm|mov|mkv|avi)$/i, 'fileVideo'],
    [/\.(mp3|wav|ogg|m4a|flac|opus)$/i, 'fileAudio'],
    [/\.(zip|tar|gz|tgz|rar|7z|xz|bz2)$/i, 'fileArchive'],
    [/\.(csv|xlsx?|ods)$/i, 'fileSheet'],
    [/\.(json|ya?ml|toml)$/i, 'fileJson'],
    [/\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|c|cpp|h|rb|php|sh|css|html|vue|svelte)$/i, 'fileCode'],
    [/\.(md|txt|log|pdf|docx?|rtf)$/i, 'fileText'],
];

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatBytes(n) {
    if (n == null) return '';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const fileIcon = name => (ICON_BY_EXT.find(([re]) => re.test(name)) || [null, 'file'])[1];

async function listDir(dir) {
    const params = new URLSearchParams({ source: 'local', path: dir || '' });
    const response = await fetch(`${basePath()}/api/files/list?${params}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Erro ${response.status}`);
    return data;
}

/** URL of a server file (for <img> previews and to read it as a Blob). */
export function serverFileUrl(filePath) {
    return `${basePath()}/api/files/raw?${new URLSearchParams({ source: 'local', path: filePath })}`;
}

/**
 * Opens the picker.
 * @param {{ start?: string, title?: string, confirm?: string, max?: number }} [opts]
 * @returns {Promise<Array<{ name: string, path: string, size: number|null, image: boolean }>|null>}
 *   null when cancelled
 */
export function pickServerFiles({ start = '', title = 'Arquivos do servidor', confirm = 'Anexar', max = 10 } = {}) {
    const dialog = document.createElement('dialog');
    dialog.className = 'dialog file-picker';
    dialog.innerHTML = `
        <header class="dialog-header">
            <h2 class="dialog-title"></h2>
            <button type="button" class="icon-btn" data-close aria-label="Fechar">${icon('x')}</button>
        </header>
        <div class="fp-bar">
            <button type="button" class="icon-btn" data-up aria-label="Pasta acima">${icon('arrowUp', 16)}</button>
            <button type="button" class="icon-btn" data-home aria-label="Pasta inicial">${icon('house', 16)}</button>
            <div class="fp-path" title=""></div>
        </div>
        <label class="fp-filter">${icon('search', 14)}
            <input type="search" placeholder="Filtrar nesta pasta" aria-label="Filtrar nesta pasta" autocapitalize="off" autocorrect="off" spellcheck="false">
        </label>
        <div class="fp-list" role="listbox" aria-multiselectable="true" tabindex="0"></div>
        <footer class="fp-footer">
            <span class="fp-count" aria-live="polite"></span>
            <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
            <button type="button" class="btn btn-primary" data-ok disabled></button>
        </footer>`;
    dialog.querySelector('.dialog-title').textContent = title;
    document.body.appendChild(dialog);
    const q = sel => dialog.querySelector(sel);
    const ui = { list: q('.fp-list'), path: q('.fp-path'), filter: q('.fp-filter input'), up: q('[data-up]'), ok: q('[data-ok]'), count: q('.fp-count') };

    let state = { path: '', parent: null, sep: '/', entries: [] };
    let home = '';
    const selected = new Map(); // path -> entry
    let seq = 0;

    const full = name => (state.path.endsWith(state.sep) ? state.path : state.path + state.sep) + name;

    function renderFooter() {
        ui.ok.disabled = !selected.size;
        ui.ok.textContent = selected.size ? `${confirm} (${selected.size})` : confirm;
        ui.count.textContent = selected.size >= max ? `Máximo de ${max}` : '';
    }

    function render() {
        const filter = ui.filter.value.trim().toLowerCase();
        const entries = state.entries
            .filter(e => !filter || e.name.toLowerCase().includes(filter))
            .sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1)
                : (a.name.startsWith('.') - b.name.startsWith('.')) || a.name.localeCompare(b.name, undefined, { numeric: true }));
        ui.path.textContent = state.path;
        ui.path.title = state.path;
        ui.up.disabled = !state.parent;
        if (!entries.length) {
            ui.list.innerHTML = `<p class="fp-empty">${filter ? 'Nada com esse nome aqui.' : 'Pasta vazia.'}</p>`;
            return;
        }
        ui.list.innerHTML = entries.map(e => {
            const p = full(e.name);
            const dir = e.type === 'dir';
            const on = selected.has(p);
            const thumb = !dir && IMAGE_EXT.test(e.name) && e.size < 8 * 1024 * 1024
                ? `<img src="${esc(serverFileUrl(p))}" alt="" loading="lazy" onerror="this.remove()">` : '';
            return `<button type="button" class="fp-item${dir ? ' dir' : ''}${on ? ' selected' : ''}" role="option"
                    aria-selected="${on}" data-name="${esc(e.name)}" data-type="${dir ? 'dir' : 'file'}">
                <span class="fp-icon">${icon(dir ? 'folder' : fileIcon(e.name), 18)}${thumb}</span>
                <span class="fp-name">${esc(e.name)}</span>
                <span class="fp-meta">${dir ? icon('chevronRight', 14) : esc(formatBytes(e.size))}</span>
                ${dir ? '' : `<span class="fp-check">${icon('check', 13)}</span>`}
            </button>`;
        }).join('');
    }

    async function go(dir) {
        const mine = ++seq;
        ui.list.innerHTML = `<p class="fp-empty">${icon('loader', 16)} Carregando…</p>`;
        try {
            const data = await listDir(dir);
            if (mine !== seq) return;
            state = data;
            if (!home) home = data.path;
            ui.filter.value = '';
            render();
            ui.list.scrollTop = 0;
            return true;
        } catch (error) {
            if (mine === seq) ui.list.innerHTML = `<p class="fp-empty error">${esc(error.message)}</p>`;
            return false;
        }
    }

    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            dialog.classList.add('closing');
            setTimeout(() => { dialog.close(); dialog.remove(); }, 140);
            resolve(value);
        };
        q('[data-close]').addEventListener('click', () => finish(null));
        q('[data-cancel]').addEventListener('click', () => finish(null));
        dialog.addEventListener('cancel', e => { e.preventDefault(); finish(null); });
        dialog.addEventListener('click', e => { if (e.target === dialog) finish(null); });
        ui.ok.addEventListener('click', () => finish([...selected.values()]));
        ui.up.addEventListener('click', () => state.parent && go(state.parent));
        q('[data-home]').addEventListener('click', () => go(''));
        ui.filter.addEventListener('input', render);
        ui.filter.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                ui.list.querySelector('.fp-item')?.click();
            }
        });
        ui.list.addEventListener('click', e => {
            const item = e.target.closest('.fp-item');
            if (!item) return;
            const p = full(item.dataset.name);
            if (item.dataset.type === 'dir') return go(p);
            if (selected.has(p)) selected.delete(p);
            else if (selected.size < max) {
                const entry = state.entries.find(x => x.name === item.dataset.name);
                selected.set(p, { name: item.dataset.name, path: p, size: entry?.size ?? null, image: IMAGE_EXT.test(item.dataset.name) });
            }
            const on = selected.has(p);
            item.classList.toggle('selected', on);
            item.setAttribute('aria-selected', String(on));
            renderFooter();
        });
        // Double click / double tap on a file: pick just that one
        ui.list.addEventListener('dblclick', e => {
            const item = e.target.closest('.fp-item:not(.dir)');
            if (!item) return;
            const p = full(item.dataset.name);
            const entry = state.entries.find(x => x.name === item.dataset.name);
            selected.set(p, { name: item.dataset.name, path: p, size: entry?.size ?? null, image: IMAGE_EXT.test(item.dataset.name) });
            finish([...selected.values()]);
        });
        renderFooter();
        dialog.showModal();
        // The session folder; if it is gone, the home folder
        go(start).then(ok => { if (!ok && start) go(''); });
    });
}
