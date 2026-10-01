/**
 * markdown.js
 * Small, safe Markdown renderer for agent messages: everything is HTML-escaped first, then a
 * limited syntax is formatted (code, emphasis, headings, lists, quotes, links, tables).
 */

export function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Only http(s) and mailto links become <a>; anything else (javascript:...) stays text. */
function safeHref(url) {
    return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
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
        // [label](url) - the URL was escaped too, so &amp; etc. are already safe inside the attribute
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
            const href = safeHref(url.replace(/&amp;/g, '&'));
            return href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
        })
        // bare links
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, lead, url) => `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
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
        const fence = line.match(/^\s*(```|~~~)\s*([\w+.-]*)\s*$/);
        if (fence) {
            flush();
            const body = [];
            i++;
            while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
            i++;
            const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : '';
            out.push(`<div class="md-code"${lang}><pre><code>${esc(body.join('\n'))}</code></pre></div>`);
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
            out.push(`<h${level}>${inline(esc(heading[2]))}</h${level}>`);
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
            out.push(`<div class="md-table"><table><thead><tr>${head.map(c => `<th>${inline(esc(c))}</th>`).join('')}</tr></thead>`
                + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(esc(c))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
            continue;
        }

        const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (item) {
            flush();
            const ordered = /\d/.test(item[2]);
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
                } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
                    items[items.length - 1].html += `<br>${inline(esc(lines[i].trim()))}`; // continuation line
                    i++;
                } else break;
            }
            const tag = ordered ? 'ol' : 'ul';
            out.push(`<${tag}>${items.map(it => `<li${it.indent >= 2 ? ' class="md-nested"' : ''}>${it.html}</li>`).join('')}</${tag}>`);
            continue;
        }

        paragraph.push(line);
        i++;
    }
    flush();
    return out.join('');
}
