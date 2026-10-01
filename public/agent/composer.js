/**
 * composer.js
 * The agent message box: multiline text, "/" slash-command and "@" file autocomplete, pasted or
 * attached images, send/stop, and the agent's selectors (mode, model, effort...) above it.
 * The paperclip attaches files from this server (picker) or from the device (uploaded next to
 * the session); images go to the agent as images when it accepts them, the rest as paths.
 */
import { icon } from '../ui/icons.js';
import { askConfirm } from '../ui/prompt.js';
import { showMenu } from '../ui/contextMenu.js';
import { pickServerFiles, serverFileUrl } from '../ui/filePicker.js';
import { esc } from './markdown.js';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // the request body limit is 5 MB (base64 grows ~33%)
const MAX_FILES = 10;
const UPLOAD_DIR = 'anexos'; // device uploads go to <session folder>/anexos
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// Commands of the agent's own terminal UI that the ACP adapters do not run (Claude answers
// "/resume isn't available in this environment"): this tab runs them. An agent command with
// the same name wins.
export const LOCAL_COMMANDS = [
    { name: 'resume', aliases: ['continue', 'conversas'], description: 'Retomar uma conversa anterior' },
    { name: 'clear', aliases: ['new', 'nova', 'reset'], description: 'Começar uma conversa nova' },
    { name: 'model', aliases: ['modelo'], description: 'Trocar o modelo (/model <nome>)' },
    { name: 'mode', aliases: ['permissions', 'modo'], description: 'Trocar o modo de permissões (/mode <nome>)' },
    { name: 'plan', aliases: [], description: 'Ativar o modo plano' },
    { name: 'effort', aliases: ['think', 'reasoning'], description: 'Trocar o nível de raciocínio' },
    { name: 'cost', aliases: ['usage', 'status', 'context'], description: 'Uso, custo e contexto (painel)' },
    { name: 'terminal', aliases: ['shell'], description: 'Abrir um terminal nesta pasta' },
    { name: 'files', aliases: ['arquivos'], description: 'Abrir os arquivos desta pasta' },
    { name: 'attach', aliases: ['anexar'], description: 'Anexar arquivos' },
    { name: 'stop', aliases: ['cancel'], description: 'Parar o agente' },
    { name: 'help', aliases: ['ajuda', 'commands'], description: 'Listar os comandos' },
];

// Modes that skip the permission questions: they need an explicit confirmation
const DANGEROUS_MODES = ['bypassPermissions'];

function readAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

export default class Composer {
    /**
     * @param {HTMLElement} el - container
     * @param {object} opts
     * @param {(msg: { text: string, images: Array<{mimeType: string, data: string}> }) => Promise<void>} opts.onSend
     * @param {() => void} opts.onCancel
     * @param {(modeId: string) => Promise<void>} opts.onMode
     * @param {(configId: string, value: any) => Promise<void>} opts.onConfig
     * @param {(query: string) => Promise<Array<{ name: string, path: string, type: string }>>} opts.searchFiles
     * @param {() => string} opts.cwd
     * @param {(name: string, args: string) => void} [opts.onLocalCommand] - see LOCAL_COMMANDS
     */
    constructor(el, opts) {
        this.el = el;
        this.opts = opts;
        this.session = null;
        this.commands = [];
        this.images = [];
        this.files = []; // { name, path|null, size, status: 'uploading'|'ready'|'error', error? }
        this.busy = false;
        this.suggest = { items: [], index: 0, kind: null, start: 0 };
        this.searchSeq = 0;

        el.innerHTML = `
            <div class="ag-selectors"></div>
            <div class="ag-images" hidden></div>
            <div class="ag-suggest" role="listbox" hidden></div>
            <form class="ag-input-row" autocomplete="off">
                <button type="button" class="icon-btn ag-attach-btn" aria-label="Anexar" aria-haspopup="menu" title="Anexar">${icon('paperclip', 18)}</button>
                <input type="file" multiple hidden>
                <textarea rows="1" aria-label="Mensagem para o agente" enterkeyhint="send"
                    placeholder="Mensagem…"></textarea>
                <button type="button" class="icon-btn ag-stop" aria-label="Parar" hidden>${icon('square', 16)}</button>
                <button type="submit" class="icon-btn ag-send" aria-label="Enviar">${icon('arrowUp', 18)}</button>
            </form>`;
        const q = sel => el.querySelector(sel);
        this.ui = {
            selectors: q('.ag-selectors'), images: q('.ag-images'), suggest: q('.ag-suggest'),
            form: q('form'), input: q('textarea'), file: q('input[type="file"]'),
            attach: q('.ag-attach-btn'), stop: q('.ag-stop'), send: q('.ag-send'),
        };
        this.bind();
    }

    bind() {
        const { form, input, file, attach, stop, selectors, suggest, images } = this.ui;
        form.addEventListener('submit', e => {
            e.preventDefault();
            this.send();
        });
        input.addEventListener('input', () => {
            this.autosize();
            this.updateSuggestions();
        });
        input.addEventListener('keydown', e => this.onKey(e));
        input.addEventListener('blur', () => setTimeout(() => this.closeSuggestions(), 150));
        input.addEventListener('paste', e => {
            const files = [...(e.clipboardData?.files || [])].filter(f => IMAGE_TYPES.includes(f.type));
            if (files.length && this.canAttach()) {
                e.preventDefault();
                this.addImages(files);
            }
        });
        attach.addEventListener('click', () => this.openAttachMenu());
        file.addEventListener('change', () => {
            this.addDeviceFiles([...file.files]);
            file.value = '';
        });
        stop.addEventListener('click', () => this.opts.onCancel());
        selectors.addEventListener('change', e => this.onSelector(e));
        suggest.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the textarea
        suggest.addEventListener('click', e => {
            const item = e.target.closest('[data-index]');
            if (item) this.pick(Number(item.dataset.index));
        });
        images.addEventListener('click', e => {
            const remove = e.target.closest('[data-remove], [data-remove-file]');
            if (!remove) return;
            if (remove.dataset.removeFile !== undefined) this.files.splice(Number(remove.dataset.removeFile), 1);
            else this.images.splice(Number(remove.dataset.remove), 1);
            this.renderImages();
        });
    }

    // ---------- state from the session ----------

    setSession(session) {
        this.session = session;
        this.renderSelectors();
    }

    setCommands(commands) {
        this.commands = commands || [];
    }

    /** The agent's commands, then ours that it does not have. */
    allCommands() {
        const names = new Set(this.commands.map(c => c.name));
        return [...this.commands, ...LOCAL_COMMANDS.filter(c => !names.has(c.name))];
    }

    /** "/resume", "/model opus"... -> a local command the agent does not have, or null. */
    localCommand(text) {
        const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
        if (!m || !this.opts.onLocalCommand) return null;
        const typed = m[1].toLowerCase();
        if (this.commands.some(c => c.name.toLowerCase() === typed)) return null;
        const command = LOCAL_COMMANDS.find(c => c.name === typed || c.aliases.includes(typed));
        return command ? { name: command.name, args: m[2].trim() } : null;
    }

    setBusy(busy, status) {
        this.busy = busy;
        this.ui.stop.hidden = !busy;
        this.ui.send.hidden = busy;
        // Short texts on phones: the field is a single line there
        const narrow = window.matchMedia('(max-width: 600px)').matches;
        this.ui.input.placeholder = status === 'stopped'
            ? 'Agente parado: toque em Retomar'
            : busy ? (narrow ? 'Trabalhando… escreva a próxima' : 'O agente está trabalhando… (pode escrever a próxima mensagem)')
                : (narrow ? 'Mensagem, / ou @' : 'Mensagem… ( / comandos · @ arquivos )');
        this.ui.send.disabled = status === 'starting' || status === 'stopped';
    }

    canAttach() {
        return !!(this.session && this.session.capabilities && this.session.capabilities.images);
    }

    // ---------- selectors ----------

    renderSelectors() {
        const caps = (this.session && this.session.capabilities) || {};
        const parts = [];
        const modes = caps.modeList || [];
        if (modes.length) {
            parts.push(`<label class="ag-select" title="Modo"><span>${icon('shield', 13)}</span><select data-mode aria-label="Modo">${modes.map(m => `<option value="${esc(m.id)}"${m.id === this.session.mode ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`);
        }
        for (const option of caps.configOptions || []) {
            if (option.category === 'mode' && caps.modeSource === 'config') continue; // shown as the mode select
            if (option.type === 'boolean') {
                parts.push(`<label class="ag-toggle"><input type="checkbox" data-config="${esc(option.id)}"${option.currentValue ? ' checked' : ''}> ${esc(option.name)}</label>`);
            } else if (option.options.length) {
                const label = option.category === 'model' ? icon('bot', 13) : option.category === 'thought_level' ? icon('activity', 13) : icon('settings', 13);
                // Big model lists are grouped as the agent grouped them
                const groups = new Map();
                for (const o of option.options) {
                    if (!groups.has(o.group)) groups.set(o.group, []);
                    groups.get(o.group).push(o);
                }
                const opts = [...groups.entries()].map(([group, list]) => {
                    const html = list.map(o => `<option value="${esc(o.value)}"${o.value === option.currentValue ? ' selected' : ''}>${esc(o.name)}</option>`).join('');
                    return group ? `<optgroup label="${esc(group)}">${html}</optgroup>` : html;
                }).join('');
                parts.push(`<label class="ag-select" title="${esc(option.name)}"><span>${label}</span><select data-config="${esc(option.id)}" aria-label="${esc(option.name)}">${opts}</select></label>`);
            }
        }
        this.ui.selectors.innerHTML = parts.join('');
        this.ui.selectors.hidden = !parts.length;
    }

    async onSelector(e) {
        const target = e.target;
        try {
            if (target.matches('[data-mode]')) {
                const modeId = target.value;
                if (DANGEROUS_MODES.includes(modeId)) {
                    const ok = await askConfirm({
                        title: 'Ativar modo sem permissões?',
                        message: 'O agente vai executar comandos e alterar arquivos SEM pedir sua aprovação. Use só em pastas descartáveis ou que você revisa depois.',
                        confirm: 'Ativar mesmo assim',
                        danger: true,
                    });
                    if (!ok) {
                        target.value = this.session.mode;
                        return;
                    }
                }
                await this.opts.onMode(modeId);
            } else if (target.matches('[data-config]')) {
                await this.opts.onConfig(target.dataset.config, target.type === 'checkbox' ? target.checked : target.value);
            }
        } catch {
            this.renderSelectors(); // back to the real value (the error is shown by the caller)
        }
    }

    // ---------- attachments ----------

    openAttachMenu() {
        const filesOk = !!window.appConfig?.filesAvailable;
        showMenu([
            { label: 'Arquivos do servidor', icon: 'server', run: () => this.pickFromServer(), disabled: !filesOk },
            { label: 'Enviar do dispositivo', icon: 'upload', run: () => this.ui.file.click() },
        ], { anchor: this.ui.attach, label: 'Anexar', restoreFocus: this.ui.input });
    }

    /** An image the agent can see goes as an image; anything else as a file path. */
    isImageForAgent(file) {
        return this.canAttach() && IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE_BYTES
            && this.images.length < MAX_IMAGES;
    }

    async pickFromServer() {
        const picked = await pickServerFiles({ start: this.opts.cwd() || '', max: Math.max(1, MAX_FILES - this.files.length) });
        if (!picked) return;
        for (const f of picked) {
            if (f.image && this.canAttach() && this.images.length < MAX_IMAGES && (f.size ?? 0) <= MAX_IMAGE_BYTES) {
                try {
                    const blob = await (await fetch(serverFileUrl(f.path), { credentials: 'same-origin' })).blob();
                    if (IMAGE_TYPES.includes(blob.type)) {
                        await this.addImages([new File([blob], f.name, { type: blob.type })]);
                        continue;
                    }
                } catch { /* attached as a path below */ }
            }
            if (!this.files.some(x => x.path === f.path)) this.files.push({ name: f.name, path: f.path, size: f.size, status: 'ready' });
        }
        this.renderImages();
        this.focus();
    }

    addDeviceFiles(list) {
        const images = list.filter(f => this.isImageForAgent(f));
        if (images.length) this.addImages(images);
        for (const file of list.filter(f => !images.includes(f))) {
            if (this.files.length >= MAX_FILES) break;
            const entry = { name: file.name, path: null, size: file.size, status: 'uploading' };
            this.files.push(entry);
            this.upload(file, entry);
        }
        this.renderImages();
    }

    /** Device file -> <session folder>/anexos on the server (the agent reads it from there). */
    async upload(file, entry) {
        const cwd = this.opts.cwd() || '';
        const api = route => `${basePath()}/api/files/${route}`;
        try {
            await fetch(api('op'), {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ op: 'mkdir', source: 'local', path: cwd, name: UPLOAD_DIR }),
            }).catch(() => {}); // already there: fine
            const sep = /^[a-z]:\\/i.test(cwd) ? '\\' : '/';
            const dir = cwd.replace(/[\\/]+$/, '') + sep + UPLOAD_DIR;
            const params = new URLSearchParams({ source: 'local', path: dir, name: file.name });
            const response = await fetch(`${api('upload')}?${params}`, {
                method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || `Erro ${response.status}`);
            Object.assign(entry, { path: data.path, name: data.name || file.name, status: 'ready' });
        } catch (error) {
            Object.assign(entry, { status: 'error', error: error.message });
        }
        this.renderImages();
    }

    async addImages(files) {
        for (const file of files) {
            if (this.images.length >= MAX_IMAGES) break;
            if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_IMAGE_BYTES) continue;
            const data = await readAsBase64(file);
            this.images.push({ mimeType: file.type, data, url: URL.createObjectURL(file), name: file.name });
        }
        this.renderImages();
    }

    renderImages() {
        this.ui.images.hidden = !this.images.length && !this.files.length;
        const size = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
        this.ui.images.innerHTML = this.images.map((img, i) => `
            <span class="ag-thumb"><img src="${img.url}" alt="${esc(img.name || 'imagem')}">
            <button type="button" data-remove="${i}" aria-label="Remover imagem">${icon('x', 12)}</button></span>`).join('')
            + this.files.map((f, i) => `
            <span class="ag-file-chip ${f.status}" title="${esc(f.error || f.path || f.name)}">
                <span class="ag-file-chip-icon">${icon(f.status === 'uploading' ? 'loader' : f.status === 'error' ? 'x' : 'file', 15)}</span>
                <span class="ag-file-chip-text"><span class="ag-file-chip-name">${esc(f.name)}</span>
                <span class="ag-file-chip-meta">${f.status === 'uploading' ? 'Enviando…' : f.status === 'error' ? esc(f.error || 'Falhou') : esc(size(f.size))}</span></span>
                <button type="button" data-remove-file="${i}" aria-label="Remover ${esc(f.name)}">${icon('x', 12)}</button>
            </span>`).join('');
    }

    // ---------- sending ----------

    autosize() {
        const input = this.ui.input;
        input.style.height = 'auto';
        // scrollHeight leaves out the border: add it back, or a scrollbar shows on one line
        const border = input.offsetHeight - input.clientHeight;
        const height = input.scrollHeight + border;
        input.style.height = `${Math.min(height, 200)}px`;
        input.style.overflowY = height > 200 ? 'auto' : 'hidden';
    }

    async send() {
        const typed = this.ui.input.value.trim();
        const local = !this.images.length && !this.files.length && this.localCommand(typed);
        if (local) {
            this.ui.input.value = '';
            this.autosize();
            this.closeSuggestions();
            this.opts.onLocalCommand(local.name, local.args);
            return;
        }
        const ready = this.files.filter(f => f.status === 'ready');
        if ((!typed && !this.images.length && !ready.length) || this.busy || this.ui.send.disabled) return;
        if (this.files.some(f => f.status === 'uploading')) return; // wait for the uploads
        // Files go as their paths on the server: every agent can read them from there
        const text = ready.length
            ? `${typed}${typed ? '\n\n' : ''}Arquivos anexados:\n${ready.map(f => `- ${f.path}`).join('\n')}`
            : typed;
        const images = this.images.map(({ mimeType, data }) => ({ mimeType, data }));
        const previous = { text: this.ui.input.value, images: this.images, files: this.files };
        this.ui.input.value = '';
        this.images = [];
        this.files = [];
        this.renderImages();
        this.autosize();
        this.closeSuggestions();
        try {
            await this.opts.onSend({ text, images });
            previous.images.forEach(img => URL.revokeObjectURL(img.url));
        } catch {
            // Keep what the user wrote if it was not accepted
            this.ui.input.value = previous.text;
            this.images = previous.images;
            this.files = previous.files;
            this.renderImages();
            this.autosize();
        }
    }

    insert(text) {
        const input = this.ui.input;
        input.value = text + input.value.replace(/^\/\S*\s?/, '');
        input.focus();
        input.setSelectionRange(text.length, text.length);
        this.autosize();
    }

    focus() {
        if (!coarse()) this.ui.input.focus({ preventScroll: true });
    }

    // ---------- keyboard & suggestions ----------

    onKey(e) {
        const open = !this.ui.suggest.hidden;
        if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            const n = this.suggest.items.length;
            this.suggest.index = (this.suggest.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
            this.renderSuggestions();
            return;
        }
        if (open && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            this.pick(this.suggest.index);
            return;
        }
        if (open && e.key === 'Escape') {
            e.preventDefault();
            this.closeSuggestions();
            return;
        }
        if (e.key === 'Escape' && this.busy) {
            e.preventDefault();
            this.opts.onCancel();
            return;
        }
        // Enter sends on desktop; on phones Enter is a new line (send button instead)
        if (e.key === 'Enter' && !e.shiftKey && !coarse()) {
            e.preventDefault();
            this.send();
        }
    }

    /** "/" at the start -> commands; "@word" at the cursor -> files of the project. */
    updateSuggestions() {
        const input = this.ui.input;
        const before = input.value.slice(0, input.selectionStart);
        const slash = before.match(/^\/(\S*)$/);
        if (slash) {
            const q = slash[1].toLowerCase();
            const items = this.allCommands().filter(c => c.name.toLowerCase().includes(q)
                || (c.aliases || []).some(a => a.startsWith(q))).slice(0, 40)
                .map(c => ({ label: `/${c.name}`, hint: c.description, value: `/${c.name} ` }));
            this.showSuggestions('command', items, 0);
            return;
        }
        const at = before.match(/(^|\s)@([^\s@]*)$/);
        if (at) {
            const start = before.length - at[2].length - 1;
            const q = at[2];
            const seq = ++this.searchSeq;
            if (q.length < 2) {
                this.showSuggestions('file', [{ label: 'Digite 2 letras do nome do arquivo…', hint: '', value: null }], start);
                return;
            }
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(async () => {
                const results = await this.opts.searchFiles(q).catch(() => []);
                if (seq !== this.searchSeq) return; // a newer query is running
                const cwd = String(this.opts.cwd() || '').replace(/\\/g, '/').replace(/\/+$/, '');
                const items = results.slice(0, 30).map((r) => {
                    const p = String(r.path).replace(/\\/g, '/');
                    const rel = cwd && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p;
                    return { label: rel + (r.type === 'dir' ? '/' : ''), hint: r.type === 'dir' ? 'pasta' : '', value: `@${rel} ` };
                });
                this.showSuggestions('file', items.length ? items : [{ label: 'Nada encontrado', hint: '', value: null }], start);
            }, 200);
            return;
        }
        this.closeSuggestions();
    }

    showSuggestions(kind, items, start) {
        this.suggest = { items, index: 0, kind, start };
        if (!items.length) {
            this.closeSuggestions();
            return;
        }
        this.renderSuggestions();
    }

    renderSuggestions() {
        const { items, index } = this.suggest;
        this.ui.suggest.hidden = false;
        this.ui.suggest.innerHTML = items.map((it, i) => `
            <div class="ag-suggest-item${i === index ? ' active' : ''}${it.value ? '' : ' muted'}" role="option" aria-selected="${i === index}" data-index="${i}">
                <span class="mono">${esc(it.label)}</span>${it.hint ? `<span class="ag-suggest-hint">${esc(it.hint)}</span>` : ''}
            </div>`).join('');
        this.ui.suggest.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    }

    pick(i) {
        const item = this.suggest.items[i];
        if (!item || !item.value) return;
        const input = this.ui.input;
        if (this.suggest.kind === 'command') {
            input.value = item.value + input.value.slice(input.selectionStart);
            input.setSelectionRange(item.value.length, item.value.length);
        } else {
            const cursor = input.selectionStart;
            input.value = input.value.slice(0, this.suggest.start) + item.value + input.value.slice(cursor);
            const pos = this.suggest.start + item.value.length;
            input.setSelectionRange(pos, pos);
        }
        this.closeSuggestions();
        this.autosize();
        input.focus();
    }

    closeSuggestions() {
        this.ui.suggest.hidden = true;
        this.suggest.items = [];
    }
}
