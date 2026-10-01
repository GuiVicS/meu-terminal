/**
 * codeblock.js
 * Code blocks of the agent chat, like the big chat apps do them: a header with the language
 * (or file name), Copiar / Quebrar linhas / Baixar, syntax highlighting (highlight.js, loaded
 * per language on demand from /vendor/hljs) and long blocks collapsed with "Mostrar tudo".
 * Also copies tables (as TSV, pastes into spreadsheets) and whole messages.
 */
import { icon } from '../ui/icons.js';

const base = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const vendor = () => `${base()}/vendor/hljs/${window.appConfig?.hljsVersion || '11.12.0'}`;

/** Fence info -> highlight.js language file + label + extension for "Baixar". */
const LANGS = {
    javascript: { file: 'javascript', label: 'JavaScript', ext: 'js', aliases: ['js', 'mjs', 'cjs', 'node'] },
    jsx: { file: 'javascript', label: 'JSX', ext: 'jsx' },
    typescript: { file: 'typescript', label: 'TypeScript', ext: 'ts', aliases: ['ts', 'mts', 'cts'] },
    tsx: { file: 'typescript', label: 'TSX', ext: 'tsx' },
    python: { file: 'python', label: 'Python', ext: 'py', aliases: ['py', 'python3'] },
    bash: { file: 'bash', label: 'Bash', ext: 'sh', aliases: ['sh', 'shell', 'zsh', 'console', 'terminal'] },
    powershell: { file: 'powershell', label: 'PowerShell', ext: 'ps1', aliases: ['ps1', 'ps', 'pwsh'] },
    json: { file: 'json', label: 'JSON', ext: 'json', aliases: ['jsonc', 'json5'] },
    html: { file: 'xml', label: 'HTML', ext: 'html', aliases: ['htm', 'vue', 'svelte'] },
    xml: { file: 'xml', label: 'XML', ext: 'xml', aliases: ['svg'] },
    css: { file: 'css', label: 'CSS', ext: 'css' },
    scss: { file: 'scss', label: 'SCSS', ext: 'scss', aliases: ['sass'] },
    sql: { file: 'sql', label: 'SQL', ext: 'sql', aliases: ['postgres', 'postgresql', 'mysql', 'sqlite'] },
    yaml: { file: 'yaml', label: 'YAML', ext: 'yml', aliases: ['yml'] },
    toml: { file: 'ini', label: 'TOML', ext: 'toml' },
    ini: { file: 'ini', label: 'INI', ext: 'ini', aliases: ['env', 'dotenv', 'conf'] },
    dockerfile: { file: 'dockerfile', label: 'Dockerfile', ext: 'Dockerfile', aliases: ['docker'] },
    markdown: { file: 'markdown', label: 'Markdown', ext: 'md', aliases: ['md', 'mdx'] },
    diff: { file: 'diff', label: 'Diff', ext: 'diff', aliases: ['patch'] },
    go: { file: 'go', label: 'Go', ext: 'go', aliases: ['golang'] },
    rust: { file: 'rust', label: 'Rust', ext: 'rs', aliases: ['rs'] },
    java: { file: 'java', label: 'Java', ext: 'java' },
    kotlin: { file: 'kotlin', label: 'Kotlin', ext: 'kt', aliases: ['kt'] },
    swift: { file: 'swift', label: 'Swift', ext: 'swift' },
    c: { file: 'c', label: 'C', ext: 'c', aliases: ['h'] },
    cpp: { file: 'cpp', label: 'C++', ext: 'cpp', aliases: ['c++', 'cc', 'hpp'] },
    csharp: { file: 'csharp', label: 'C#', ext: 'cs', aliases: ['cs', 'c#'] },
    php: { file: 'php', label: 'PHP', ext: 'php' },
    ruby: { file: 'ruby', label: 'Ruby', ext: 'rb', aliases: ['rb'] },
    lua: { file: 'lua', label: 'Lua', ext: 'lua' },
    dart: { file: 'dart', label: 'Dart', ext: 'dart' },
    r: { file: 'r', label: 'R', ext: 'r' },
    graphql: { file: 'graphql', label: 'GraphQL', ext: 'graphql', aliases: ['gql'] },
    nginx: { file: 'nginx', label: 'Nginx', ext: 'conf' },
    makefile: { file: 'makefile', label: 'Makefile', ext: 'mk', aliases: ['make', 'mk'] },
    prisma: { file: null, label: 'Prisma', ext: 'prisma' },
    plaintext: { file: null, label: 'Texto', ext: 'txt', aliases: ['text', 'txt', 'plain', 'output', 'log'] },
};
const ALIAS = new Map();
for (const [id, def] of Object.entries(LANGS)) {
    ALIAS.set(id, id);
    (def.aliases || []).forEach(a => ALIAS.set(a, id));
}
// "app.py" as the fence info -> python
const EXT_LANG = new Map(Object.entries(LANGS).map(([id, def]) => [def.ext.toLowerCase(), id]));

/**
 * Parses the fence info: "js", "js title=app.js", "js:src/app.js", "app.py", "python file=x.py".
 * @returns {{ lang: string|null, label: string, file: string|null, ext: string }}
 */
export function parseFenceInfo(info) {
    const raw = String(info || '').trim();
    let [word, ...rest] = raw.split(/\s+/);
    word = word || '';
    let file = null;
    const titled = rest.join(' ').match(/(?:title|file|filename|path)=["']?([^"'\s]+)/i);
    if (titled) file = titled[1];
    if (word.includes(':')) [word, file] = [word.slice(0, word.indexOf(':')), word.slice(word.indexOf(':') + 1) || file];
    let lang = ALIAS.get(word.toLowerCase()) || null;
    if (!lang && /\.[\w]+$/.test(word)) {
        file = file || word;
        lang = EXT_LANG.get(word.split('.').pop().toLowerCase()) || null;
    }
    if (!lang && file) lang = EXT_LANG.get(file.split('.').pop().toLowerCase()) || null;
    const def = lang ? LANGS[lang] : null;
    return {
        lang,
        label: def ? def.label : (word || 'Código'),
        file: file ? file.split(/[\\/]/).pop() : null,
        path: file,
        ext: def ? def.ext : (word && /^[\w+-]{1,10}$/.test(word) ? word : 'txt'),
    };
}

// ---------- highlighting ----------

let corePromise = null;
const languagePromises = new Map();
const cache = new Map(); // `${lang}\0${code}` -> highlighted HTML (re-renders while streaming)
const CACHE_MAX = 200;
const MAX_HIGHLIGHT = 200 * 1024; // bigger blocks stay plain (fast)

function core() {
    if (!corePromise) corePromise = import(`${vendor()}/core.min.js`).then(m => m.default).catch(() => null);
    return corePromise;
}

async function language(hljs, lang) {
    const file = LANGS[lang] && LANGS[lang].file;
    if (!file) return false;
    if (hljs.getLanguage(file)) return true;
    if (!languagePromises.has(file)) {
        languagePromises.set(file, import(`${vendor()}/languages/${file}.min.js`)
            .then((m) => { hljs.registerLanguage(file, m.default); return true; })
            .catch(() => false));
    }
    return languagePromises.get(file);
}

/** Highlights the finished code blocks under root (unfinished ones while streaming wait). */
export async function highlightIn(root) {
    const blocks = [...root.querySelectorAll('.md-code[data-closed]:not([data-hl])')];
    if (!blocks.length) return;
    let hljs = null;
    for (const block of blocks) {
        block.dataset.hl = '1';
        const lang = block.dataset.lang;
        const code = block.querySelector('code');
        if (!lang || !code || !LANGS[lang] || !LANGS[lang].file) continue;
        const text = code.textContent;
        if (text.length > MAX_HIGHLIGHT) continue;
        const key = `${lang}\0${text}`;
        if (cache.has(key)) {
            code.innerHTML = cache.get(key);
            code.classList.add('hljs');
            continue;
        }
        hljs = hljs || await core();
        if (!hljs || !await language(hljs, lang)) continue;
        if (!code.isConnected) continue; // re-rendered meanwhile: the next pass does it
        try {
            const html = hljs.highlight(text, { language: LANGS[lang].file, ignoreIllegals: true }).value;
            if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
            cache.set(key, html);
            code.innerHTML = html;
            code.classList.add('hljs');
        } catch { /* stays plain */ }
    }
}

// ---------- block state across re-renders (streaming re-renders the whole message) ----------

/** What the user changed (wrap, expanded) per block index, to put back after a re-render. */
export function saveState(root) {
    return [...root.querySelectorAll('.md-code')].map(b => ({ wrap: b.classList.contains('wrap'), open: b.classList.contains('expanded') }));
}

export function restoreState(root, state) {
    if (!state || !state.length) return;
    root.querySelectorAll('.md-code').forEach((b, i) => {
        if (!state[i]) return;
        b.classList.toggle('wrap', state[i].wrap);
        b.classList.toggle('expanded', state[i].open);
    });
}

// ---------- actions ----------

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Plain http or no permission: the old way
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch { /* no clipboard at all */ }
        ta.remove();
        return ok;
    }
}

/** "Copiar" -> "Copiado" with a check for a moment. */
export function flashCopied(button, ok = true) {
    const label = button.querySelector('span');
    const before = button.innerHTML;
    button.classList.add(ok ? 'copied' : 'copy-failed');
    button.innerHTML = `${icon(ok ? 'check' : 'x', 14)}${label ? `<span>${ok ? 'Copiado' : 'Falhou'}</span>` : ''}`;
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => {
        button.innerHTML = before;
        button.classList.remove('copied', 'copy-failed');
    }, 1600);
}

function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Table -> TSV (pastes as cells into Sheets/Excel). */
function tableText(table) {
    return [...table.rows].map(row => [...row.cells].map(c => c.innerText.replace(/\s+/g, ' ').trim()).join('\t')).join('\n');
}

/**
 * Click handler for the chat log. Returns true when it handled the click.
 * @param {MouseEvent} e
 */
export function onCodeClick(e) {
    const btn = e.target.closest('[data-code-act]');
    if (!btn) return false;
    const block = btn.closest('.md-code, .md-table, .pre-box');
    if (!block) return false;
    const act = btn.dataset.codeAct;
    if (act === 'copy') {
        const text = block.matches('.md-table') ? tableText(block.querySelector('table')) : block.querySelector('pre').textContent;
        copyText(text.replace(/\n$/, '')).then(ok => flashCopied(btn, ok));
    } else if (act === 'wrap') {
        const on = block.classList.toggle('wrap');
        btn.setAttribute('aria-pressed', String(on));
    } else if (act === 'download') {
        download(block.dataset.file || `codigo.${block.dataset.ext || 'txt'}`, block.querySelector('pre').textContent);
    } else if (act === 'expand') {
        const open = block.classList.toggle('expanded');
        btn.innerHTML = open ? `${icon('chevronUp', 14)} Recolher` : btn.dataset.more;
        if (!open) block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    return true;
}
