/**
 * fileViewer.js
 * Opens a file mentioned in the chat in full screen, already formatted: Markdown as a document,
 * HTML running (a sandboxed frame, not the embedded browser), PDF, picture, video and audio as
 * themselves, and code highlighted. Markdown and HTML also have the "Código" view.
 */
import { icon } from '../ui/icons.js';
import { renderMarkdown, esc } from './markdown.js';
import { highlightIn, onCodeClick, copyText, flashCopied } from './codeblock.js';
import { serverFileUrl } from '../ui/filePicker.js';
import { toast } from '../ui/toast.js';
import { linkifyFiles } from './fileMentions.js';

const IMAGE = 'png jpg jpeg gif webp avif svg bmp ico';
const VIDEO = 'mp4 webm mov m4v';
const AUDIO = 'mp3 wav ogg m4a flac';
const CODE = 'txt log csv tsv json jsonc yaml yml toml ini env xml js mjs cjs jsx ts tsx py sh bash zsh rb go rs java kt c h cpp hpp cs php sql css scss vue svelte lua dockerfile';

const KINDS = new Map([
    ...['md', 'markdown', 'mdx'].map(e => [e, 'markdown']),
    ...['html', 'htm'].map(e => [e, 'html']),
    ['pdf', 'pdf'],
    ...IMAGE.split(' ').map(e => [e, 'image']),
    ...VIDEO.split(' ').map(e => [e, 'video']),
    ...AUDIO.split(' ').map(e => [e, 'audio']),
    ...CODE.split(' ').map(e => [e, 'code']),
]);

export const fileExt = path => (String(path).split(/[\\/]/).pop().match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

/** How the viewer shows this file; null when it does not (those open in "Arquivos"). */
export function viewerKind(path) {
    return KINDS.get(fileExt(path)) || null;
}

const base = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');

/** Same permissions as the server's page address (scripts/html-preview.js): never the app's origin. */
const SANDBOX_ATTR = 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads';

/** Same as scripts/html-preview.js: links to other sites leave the frame (most refuse to open inside one). */
const EXTERNAL_LINKS = '<script>addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(a&&/^https?:/i.test(a.href)&&a.host!==location.host)a.target="_blank"},true)</script>';

/** A code fence that nothing inside the text can close. */
function asCodeBlock(text, lang) {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map(m => m[0].length));
    const fence = '`'.repeat(longest + 1);
    return renderMarkdown(`${fence}${lang}\n${text}\n${fence}`);
}

/** Pictures with a relative or absolute path in a document are served by the app. */
function withLocalImages(text, dir) {
    return text.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
        if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url) || !viewerKind(url)) return m;
        const full = url.startsWith('/') ? url : `${dir}/${url.replace(/^\.\//, '')}`;
        // SVGs only come as pictures with render=1 (the server's sandbox header stays on)
        const src = `${serverFileUrl(full)}${fileExt(url) === 'svg' ? '&render=1' : ''}`;
        return `![${alt}](${src.replace(/_/g, '%5F').replace(/\*/g, '%2A')})`;
    });
}

async function readText(path) {
    const params = new URLSearchParams({ source: 'local', path });
    const r = await fetch(`${base()}/api/files/text?${params}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
    if (data.text == null) throw new Error(data.reason === 'big' ? 'Arquivo grande demais para a prévia.' : 'Este arquivo não é texto.');
    return data.text;
}

async function pageAddress(path) {
    const r = await fetch(`${base()}/api/files/preview-link`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
    return data.url;
}

/**
 * @param {object} opts
 * @param {string} [opts.path] - absolute path of a file on the server
 * @param {string} [opts.text] - or the content itself (a code block from the chat)
 * @param {string} [opts.name]
 * @param {string} [opts.kind]
 * @param {(path: string) => void} [opts.onOpenInFiles]
 * @param {(path: string, dir?: string) => void} [opts.onOpenFile] - abrir um arquivo citado no documento, a partir da pasta dele
 */
export function openFileViewer({ path = null, text = null, name = null, kind = null, onOpenInFiles = null, onOpenFile = null }) {
    const title = name || String(path).split('/').pop();
    const type = kind || viewerKind(path) || 'code';
    const hasTabs = type === 'markdown' || type === 'html';
    const isText = hasTabs || type === 'code';
    const lang = type === 'code' ? fileExt(path || '') : type;
    const downloadUrl = path ? `${serverFileUrl(path)}&download=1` : null;
    let source = text;
    let view = 'preview';
    const previously = document.activeElement;

    const box = document.createElement('div');
    box.className = 'ag-viewer';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    if ('showPopover' in HTMLElement.prototype) box.setAttribute('popover', 'manual');
    box.innerHTML = `
        <header class="ag-viewer-bar">
            <span class="ag-viewer-title"><strong>${esc(title)}</strong>${path ? `<small>${esc(path)}</small>` : ''}</span>
            ${hasTabs ? `<span class="ag-viewer-tabs" role="group" aria-label="Modo de ver">
                <button type="button" data-view="preview" aria-pressed="true">${icon(type === 'html' ? 'play' : 'eye', 14)} ${type === 'html' ? 'Executar' : 'Prévia'}</button>
                <button type="button" data-view="code" aria-pressed="false">${icon('codeXml', 14)} Código</button>
            </span>` : ''}
            <span class="ag-viewer-actions">
                ${type === 'html' ? `<button type="button" class="icon-btn" data-act="reload" aria-label="Executar de novo" title="Executar de novo">${icon('rotate-cw', 18)}</button>` : ''}
                ${isText ? `<button type="button" class="icon-btn" data-act="copy" aria-label="Copiar conteúdo" title="Copiar conteúdo">${icon('copy', 18)}</button>` : ''}
                ${downloadUrl ? `<a class="icon-btn" href="${esc(downloadUrl)}" download aria-label="Baixar" title="Baixar">${icon('download', 18)}</a>` : ''}
                ${path && onOpenInFiles ? `<button type="button" class="icon-btn" data-act="files" aria-label="Abrir nos Arquivos" title="Abrir nos Arquivos">${icon('folder', 18)}</button>` : ''}
                <button type="button" class="icon-btn" data-act="close" aria-label="Fechar" title="Fechar (Esc)">${icon('x', 20)}</button>
            </span>
        </header>
        <div class="ag-viewer-body" tabindex="-1"></div>`;
    const body = box.querySelector('.ag-viewer-body');
    const note = message => { body.innerHTML = `<p class="ag-viewer-note">${esc(message)}</p>`; };

    const frame = src => {
        const f = document.createElement('iframe');
        f.className = 'ag-viewer-frame';
        f.title = title;
        f.setAttribute('sandbox', SANDBOX_ATTR);
        f.setAttribute('referrerpolicy', 'no-referrer');
        if (src.url) f.src = src.url;
        else f.srcdoc = src.html;
        body.replaceChildren(f);
    };

    const getSource = async () => {
        if (source == null) source = await readText(path);
        return source;
    };

    let seq = 0;
    const show = async () => {
        const mine = ++seq;
        const stale = () => mine !== seq;
        body.classList.toggle('is-frame', type === 'html' && view === 'preview');
        try {
            if (type === 'html' && view === 'preview') {
                if (path) {
                    note('Abrindo…');
                    const url = await pageAddress(path);
                    if (!stale()) frame({ url });
                } else frame({ html: EXTERNAL_LINKS + source });
            } else if (isText) {
                note('Abrindo…');
                const content = await getSource();
                if (stale()) return;
                const dir = path ? path.slice(0, path.lastIndexOf('/')) || '' : '';
                body.innerHTML = type === 'markdown' && view === 'preview'
                    ? `<article class="ag-viewer-doc md">${renderMarkdown(withLocalImages(content, dir))}</article>`
                    : `<div class="ag-viewer-code md">${asCodeBlock(content, lang)}</div>`;
                if (type === 'markdown' && view === 'preview') linkifyFiles(body);
                highlightIn(body);
            } else if (type === 'pdf') {
                body.classList.add('is-frame');
                body.innerHTML = `<iframe class="ag-viewer-frame" title="${esc(title)}" src="${esc(serverFileUrl(path))}"></iframe>`;
            } else if (type === 'image') {
                const src = `${serverFileUrl(path)}${fileExt(path) === 'svg' ? '&render=1' : ''}`;
                body.innerHTML = `<div class="ag-viewer-media"><img src="${esc(src)}" alt="${esc(title)}"></div>`;
            } else if (type === 'video') {
                body.innerHTML = `<div class="ag-viewer-media"><video controls playsinline src="${esc(serverFileUrl(path))}"></video></div>`;
            } else if (type === 'audio') {
                body.innerHTML = `<div class="ag-viewer-media"><audio controls src="${esc(serverFileUrl(path))}"></audio></div>`;
            }
        } catch (e) {
            if (!stale()) note(`Não deu para abrir: ${e.message}`);
        }
    };

    const close = () => {
        seq++;
        document.removeEventListener('keydown', onKey, true);
        box.remove(); // also stops whatever the page was running
        previously?.focus?.();
    };
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }

    box.addEventListener('click', e => {
        if (onCodeClick(e)) return;
        const mention = e.target.closest('[data-open-file]');
        if (mention) {
            // A link in a document points next to the document
            const target = mention.dataset.openFile;
            const dir = path ? path.slice(0, path.lastIndexOf('/')) : '';
            if (onOpenFile) {
                onOpenFile(target, dir || undefined);
                return;
            }
            const full = /^[/~]/.test(target) ? target : `${dir}/${target.replace(/^\.\//, '')}`;
            if (viewerKind(full)) openFileViewer({ path: full, onOpenInFiles });
            else onOpenInFiles?.(full);
            return;
        }
        const tab = e.target.closest('[data-view]');
        if (tab) {
            view = tab.dataset.view;
            box.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b === tab)));
            show();
            return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'close') close();
        else if (act.dataset.act === 'reload') {
            source = text; // the file may have changed
            if (view !== 'preview') {
                view = 'preview';
                box.querySelector('[data-view="preview"]')?.click();
            } else show();
        } else if (act.dataset.act === 'copy') {
            getSource().then(copyText).then(ok => flashCopied(act, ok)).catch(err => toast(err.message, { tone: 'error' }));
        } else if (act.dataset.act === 'files') {
            onOpenInFiles(path);
            close();
        }
    });
    document.addEventListener('keydown', onKey, true);
    // Um quadro que abre (PDF, página) pega o foco, e as teclas param de chegar aqui: o Esc não fecharia
    body.addEventListener('load', e => {
        if (e.target.tagName === 'IFRAME') body.focus({ preventScroll: true });
    }, true);
    document.body.appendChild(box);
    if (box.showPopover) box.showPopover();
    body.focus({ preventScroll: true }); // leaves the arrow keys scrolling the document
    show();
}
