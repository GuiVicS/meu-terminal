/**
 * markdown.js
 * Small, safe Markdown renderer for agent messages: everything is HTML-escaped first, then a
 * limited syntax is formatted (code, emphasis, headings, lists, quotes, links, tables, images,
 * GitHub callouts). Code blocks get a header with actions (codeblock.js does the rest).
 */
import { icon } from '../ui/icons.js';
import { parseFenceInfo } from './codeblock.js';

const COLLAPSE_LINES = 30; // longer code blocks start collapsed ("Mostrar tudo")
const CALLOUTS = {
    NOTE: { label: 'Nota', icon: 'info' },
    TIP: { label: 'Dica', icon: 'lightbulb' },
    IMPORTANT: { label: 'Importante', icon: 'messageWarning' },
    WARNING: { label: 'Atenção', icon: 'triangleAlert' },
    CAUTION: { label: 'Cuidado', icon: 'octagonAlert' },
};

export function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Only http(s) and mailto links become <a>; anything else (javascript:...) stays text. */
function safeHref(url) {
    return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

/** Images: https, or files this app serves (agent media). No data:/javascript: URLs. */
function safeImage(url) {
    return /^(https:\/\/|api\/agent-media\/|\/api\/agent-media\/)/i.test(url) ? url : null;
}

/** Inline syntax on already-escaped text. Code spans are protected from other rules. */
function inline(escaped) {
    const codes = [];
    let text = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
        codes.push(`<code>${code}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });
    text = text
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
        .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
        .replace(/(^|[^_\w])_([^_\n]+)_(?=[^_\w]|$)/g, '$1<em>$2</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        // ![alt](url): a picture that opens in the lightbox
        .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
            const src = safeImage(url.replace(/&amp;/g, '&'));
            if (!src) return m;
            return `<button type="button" class="md-img" data-media-view="${esc(src)}" data-media-name="${alt}" aria-label="Ampliar imagem${alt ? `: ${alt}` : ''}">`
                + `<img src="${esc(src)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer"></button>`;
        })
        // [label](url) - the URL was escaped too, so &amp; etc. are already safe inside the attribute
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
            const href = safeHref(url.replace(/&amp;/g, '&'));
            return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
        })
        // bare links
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

/** A fenced code block: header (language/file + actions), code, "Mostrar tudo" when long. */
function codeBlock(info, body, closed) {
    const meta = parseFenceInfo(info);
    const code = body.join('\n');
    const lines = body.length;
    const long = closed && lines > COLLAPSE_LINES;
    const more = `${icon('chevronDown', 14)} Mostrar tudo · ${lines} linhas`;
    const attrs = [
        meta.lang ? `data-lang="${esc(meta.lang)}"` : '',
        `data-ext="${esc(meta.ext)}"`,
        meta.file ? `data-file="${esc(meta.file)}"` : '',
        closed ? 'data-closed' : '',
    ].filter(Boolean).join(' ');
    return `<div class="md-code${long ? ' long' : ''}${closed ? '' : ' streaming'}" ${attrs}>`
        + `<div class="md-code-head">`
        + `<span class="md-code-lang">${icon(meta.file ? 'fileCode' : 'codeXml', 14)}<span>${esc(meta.file || meta.label)}</span>${meta.file && meta.lang ? `<em>${esc(meta.label)}</em>` : ''}</span>`
        + (closed ? '' : '<span class="md-code-writing">escrevendo…</span>')
        + `<span class="md-code-actions">`
        + `<button type="button" class="md-code-btn" data-code-act="wrap" aria-pressed="false" aria-label="Quebrar linhas" title="Quebrar linhas">${icon('wrapText', 14)}</button>`
        + `<button type="button" class="md-code-btn" data-code-act="download" aria-label="Baixar" title="Baixar como arquivo">${icon('download', 14)}</button>`
        + `<button type="button" class="md-code-btn md-code-copy" data-code-act="copy" aria-label="Copiar código">${icon('copy', 14)}<span>Copiar</span></button>`
        + `</span></div>`
        + `<pre><code>${esc(code)}</code></pre>`
        + (long ? `<button type="button" class="md-code-more" data-code-act="expand" data-more="${esc(more)}">${more}</button>` : '')
        + `</div>`;
}

function tableRow(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
}

/**
 * Markdown -> HTML string (safe to assign to innerHTML).
 * @param {string} source
 */
export function renderMarkdown(source) {
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let paragraph = [];
    const flush = () => {
        if (paragraph.length) out.push(`<p>${inline(esc(paragraph.join('\n'))).replace(/\n/g, '<br>')}</p>`);
        paragraph = [];
    };

    while (i < lines.length) {
        const line = lines[i];

        // fenced code (an unfinished fence while streaming renders as code so far)
        const fence = line.match(/^(\s*)(`{3,}|~{3,})\s*([^`]*)$/);
        if (fence) {
            flush();
            const body = [];
            const indent = fence[1].length;
            const close = new RegExp(`^\\s*${fence[2][0] === '`' ? '`' : '~'}{${fence[2].length},}\\s*$`);
            i++;
            while (i < lines.length && !close.test(lines[i])) {
                // Fences inside list items are indented: drop that indent from the code
                body.push(indent ? lines[i].replace(new RegExp(`^ {0,${indent}}`), '') : lines[i]);
                i++;
            }
            const closed = i < lines.length;
            i++;
            out.push(codeBlock(fence[3], body, closed));
            continue;
        }

        if (!line.trim()) {
            flush();
            i++;
            continue;
        }

        const heading = line.match(/^(#{1,6})\s+(.*)$/);
        if (heading) {
            flush();
            const level = Math.min(heading[1].length + 2, 6); // chat headings stay small (h3..h6)
            out.push(`<h${level} class="md-h${heading[1].length}">${inline(esc(heading[2]))}</h${level}>`);
            i++;
            continue;
        }

        if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
            flush();
            out.push('<hr>');
            i++;
            continue;
        }

        if (/^\s*>/.test(line)) {
            flush();
            const quote = [];
            while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
            // GitHub callouts: > [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION]
            const callout = quote[0] && quote[0].match(/^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
            if (callout) {
                const kind = callout[1].toUpperCase();
                const def = CALLOUTS[kind];
                const rest = [callout[2], ...quote.slice(1)].join('\n').trim();
                out.push(`<div class="md-callout ${kind.toLowerCase()}"><div class="md-callout-title">${icon(def.icon, 15)} ${def.label}</div>${renderMarkdown(rest)}</div>`);
                continue;
            }
            out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
            continue;
        }

        // table: header row + separator row
        if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
            flush();
            const head = tableRow(line);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableRow(lines[i++]));
            out.push(`<div class="md-table"><button type="button" class="md-code-btn md-table-copy" data-code-act="copy" aria-label="Copiar tabela" title="Copiar tabela (cola em planilhas)">${icon('copy', 13)}<span>Copiar</span></button><table><thead><tr>${head.map(c => `<th>${inline(esc(c))}</th>`).join('')}</tr></thead>`
                + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
            continue;
        }

        const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (item) {
            flush();
            const ordered = /\d/.test(item[2]);
            const start = ordered ? parseInt(item[2], 10) : 1;
            const items = [];
            while (i < lines.length) {
                const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
                if (m) {
                    const task = m[3].match(/^\[([ xX])\]\s+(.*)$/);
                    items.push({
                        indent: m[1].length,
                        html: task ? `<span class="md-task${task[1] !== ' ' ? ' done' : ''}">${task[1] !== ' ' ? '✓' : '○'}</span> ${inline(esc(task[2]))}` : inline(esc(m[3])),
                    });
                    i++;
                } else if (/^\s*(`{3,}|~{3,})/.test(lines[i])) {
                    break; // a code block inside the item: rendered as a block, the list goes on after it
                } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
                    items[items.length - 1].html += `<br>${inline(esc(lines[i].trim()))}`; // continuation line
                    i++;
                } else break;
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map(it => `<li${it.indent >= 2 ? ' class="md-nested"' : ''}>${it.html}</li>`).join('')}</${tag}>`);
            continue;
        }

        paragraph.push(line);
        i++;
    }
    flush();
    return out.join('');
}
