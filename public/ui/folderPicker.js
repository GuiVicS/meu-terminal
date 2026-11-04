/**
 * folderPicker.js
 * Escolher a pasta de uma conversa nova, como no Claude Code: um menu com as pastas recentes e
 * "Escolher pasta…", que navega pelas pastas do servidor.
 */
import { icon } from './icons.js';
import { showMenu } from './contextMenu.js';
import { openSheet } from './sheet.js';
import { toast } from './toast.js';
import { cleanPath, looksLikePath } from './pathInput.js';

const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const baseName = p => String(p).split('/').filter(Boolean).pop() || p;

async function getJson(route) {
    const r = await fetch(`${basePath()}/api/${route}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `Erro ${r.status}`);
    return data;
}

/** Navega pelas pastas do servidor e devolve a escolhida. */
function browseFolders(start, onPick) {
    const sheet = openSheet({ title: 'Escolher pasta', className: 'folder-picker' });
    let state = null;
    sheet.body.innerHTML = `
        <p class="fp-path mono"></p>
        <input type="text" class="fp-go mono" placeholder="Cole ou digite um caminho" aria-label="Caminho da pasta" autocapitalize="off" autocorrect="off" spellcheck="false">
        <ul class="fp-list"></ul>
        <div class="fp-actions"><button type="button" class="btn btn-primary" data-fp="use">Usar esta pasta</button></div>`;
    const list = sheet.body.querySelector('.fp-list');
    const pathEl = sheet.body.querySelector('.fp-path');
    const go = async dir => {
        try {
            const data = await getJson(`files/list?${new URLSearchParams({ source: 'local', path: dir || '' })}`);
            state = data;
            pathEl.textContent = data.path;
            const dirs = (data.entries || []).filter(e => e.type === 'dir' && !e.name.startsWith('.'))
                .sort((a, b) => a.name.localeCompare(b.name));
            list.innerHTML = `${data.parent ? `<li><button type="button" class="fp-row" data-dir="${esc(data.parent)}">${icon('chevronLeft', 16)}<span>Pasta acima</span></button></li>` : ''}
                ${dirs.map(e => `<li><button type="button" class="fp-row" data-dir="${esc(e.path || `${data.path.replace(/\/+$/, '')}/${e.name}`)}">${icon('folder', 16)}<span>${esc(e.name)}</span></button></li>`).join('')
                || '<li class="fp-empty">Nenhuma subpasta aqui.</li>'}`;
            list.scrollTop = 0;
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    };
    const typed = sheet.body.querySelector('.fp-go');
    const goTyped = () => {
        const path = cleanPath(typed.value);
        if (!path) return;
        go(path);
        typed.value = '';
    };
    typed.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        goTyped();
    });
    typed.addEventListener('paste', e => {
        const pasted = e.clipboardData?.getData('text') || '';
        if (typed.value || !looksLikePath(pasted)) return;
        e.preventDefault();
        typed.value = pasted;
        goTyped();
    });
    sheet.body.addEventListener('click', e => {
        const row = e.target.closest('[data-dir]');
        if (row) return void go(row.dataset.dir);
        if (e.target.closest('[data-fp="use"]') && state) {
            sheet.close();
            onPick(state.path);
        }
        return undefined;
    });
    void go(start);
}

/**
 * @param {Element} anchor
 * @param {object} o
 * @param {string} o.current - pasta atual
 * @param {string} [o.agent]
 * @param {boolean} [o.startsNew] - conversa em andamento: a escolha abre uma nova
 * @param {(path: string) => void} o.onPick
 */
export async function openFolderMenu(anchor, { current, agent = '', startsNew = false, onPick }) {
    const { folders = [] } = await getJson(`agent-folders?${new URLSearchParams({ agent })}`).catch(() => ({}));
    const list = [...new Set([current, ...folders].filter(Boolean))].slice(0, 8);
    showMenu([
        ...(startsNew ? [{ label: 'Abrir nova conversa em:', disabled: true }] : []),
        ...list.map(path => ({
            label: baseName(path), hint: path === current ? '' : path.replace(/^\/root(?=\/|$)/, '~'),
            icon: path === current ? 'check' : 'folder', disabled: path === current && !startsNew,
            run: () => onPick(path),
        })),
        ...(list.length ? ['separator'] : []),
        { label: 'Escolher pasta…', icon: 'folderOpen', run: () => browseFolders(current, onPick) },
    ], { anchor, label: 'Pasta da conversa' });
}
