/**
 * fileMentions.js
 * Files the agent mentions in its answer become something to open: the path turns into a link
 * inside the text, and Markdown and HTML also get a card under the answer ("Abrir" / "Executar").
 * Works on the rendered message, so the Markdown renderer stays shared with the notes untouched.
 */
import { icon } from '../ui/icons.js';
import { esc } from './markdown.js';
import { viewerKind, fileExt } from './fileViewer.js';

const PATH_CHARS = `[^\\s"'\`<>()\\[\\]{}|,;:!?]`;
// Text: a path with a folder ("/root/PLANO.md", "docs/PLANO.md", "./a.html"), or [nome](caminho)
const IN_TEXT = new RegExp(`\\[([^\\]\\n]+)\\]\\(((?:~|\\.{0,2}/|[\\w.-]+/)${PATH_CHARS}*\\.[a-z0-9]+)\\)|(^|[\\s(])((?:~/|\\.{0,2}/|[\\w.-]+/)${PATH_CHARS}*\\.[a-z0-9]+)(?=$|[\\s).,;:!?])`, 'gi');
// A code span may be only the name ("PLANO.md")
const IN_CODE = new RegExp(`^(?:~/|\\.{0,2}/)?${PATH_CHARS}+\\.[a-z0-9]+$`, 'i');

const canOpen = () => !!window.appConfig?.filesAvailable;
const isUrl = text => /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^www\./i.test(text);
const looksLikeFile = text => !isUrl(text) && !!viewerKind(text);

const fileLink = (path, label) => {
    const a = document.createElement('button');
    a.type = 'button';
    a.className = 'ag-file-link';
    a.dataset.openFile = path;
    a.title = `Abrir ${path}`;
    a.textContent = label;
    return a;
};

function linkifyText(node) {
    const text = node.nodeValue;
    IN_TEXT.lastIndex = 0;
    let match = IN_TEXT.exec(text);
    if (!match) return;
    const frag = document.createDocumentFragment();
    let at = 0;
    for (; match; match = IN_TEXT.exec(text)) {
        const [whole, label, linked, lead = '', bare] = match;
        const path = linked || bare;
        if (!looksLikeFile(path)) continue;
        frag.append(text.slice(at, match.index), lead);
        frag.append(fileLink(path, label || path));
        at = match.index + whole.length;
    }
    if (!at) return;
    frag.append(text.slice(at));
    node.replaceWith(frag);
}

/** Turns the file paths of a rendered message into links (data-open-file). */
export function linkifyFiles(root) {
    if (!canOpen()) return;
    root.querySelectorAll('code').forEach(code => {
        if (code.closest('pre, a, button')) return;
        const text = code.textContent.trim();
        if (IN_CODE.test(text) && looksLikeFile(text)) {
            const link = fileLink(text, '');
            link.classList.add('is-code');
            code.replaceWith(link);
            link.append(code);
        }
    });
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: n => (n.parentElement.closest('pre, code, a, button') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(linkifyText);
}

/** Markdown and HTML files mentioned in a message, in order and without repeats. */
export function documentsIn(root) {
    const found = new Set();
    root.querySelectorAll('[data-open-file]').forEach(el => {
        const kind = viewerKind(el.dataset.openFile);
        if (kind === 'markdown' || kind === 'html') found.add(el.dataset.openFile);
    });
    return [...found].slice(0, 6);
}

/** The cards shown under the answer. */
export function documentCards(paths) {
    if (!paths.length) return '';
    return paths.map(path => {
        const name = path.split('/').pop();
        const html = viewerKind(path) === 'html';
        return `<div class="ag-doc-card">
            <button type="button" class="ag-doc-open" data-open-file="${esc(path)}" title="${esc(path)}">
                <span class="ag-doc-icon">${icon(html ? 'globe' : 'fileText', 20)}</span>
                <span class="ag-doc-text"><strong>${esc(name)}</strong><small>${html ? 'Página' : 'Documento'} · ${esc(fileExt(path).toUpperCase())}</small></span>
                <span class="ag-doc-action">${icon(html ? 'play' : 'maximize', 15)} ${html ? 'Executar' : 'Abrir'}</span>
            </button></div>`;
    }).join('');
}
