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
import { toast } from '../ui/toast.js';
import { esc } from './markdown.js';
import Dictation from '../ui/dictation.js';
import { bindVibecodeEdgeSwipe } from '../ui/edgeSwipe.js';

const coarse = () => window.matchMedia('(pointer: coarse)').matches;
// iPhone layout: floating box + settings sheet (attribute set in index.html before first paint)
const IPHONE = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-iphone');
const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024; // per image sent (base64 grows ~33%; the route takes 40 MB)
const MAX_IMAGE_INPUT = 40 * 1024 * 1024;  // bigger photos are refused; smaller ones are reduced
const MAX_IMAGE_SIDE = 2000;               // px: larger photos are scaled down before sending
const DRAFT_PREFIX = 'mt-agent-draft:';
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

/**
 * Phone photos are often 4-12 MB: scale down to MAX_IMAGE_SIDE and re-encode as JPEG (WebP when
 * the image has transparency is not worth checking: PNG screenshots are usually small already).
 * Returns the original file when it is small enough or cannot be decoded.
 */
async function shrinkImage(file) {
    if (file.size <= 1.5 * 1024 * 1024 && file.type !== 'image/heic') return file;
    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        return file;
    }
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    for (const quality of [0.85, 0.7, 0.55]) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= MAX_IMAGE_BYTES) {
            return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
        }
    }
    return file;
}

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
        this.queue = []; // "modo fila": messages waiting on the server ({ id, text, images })
        this.draftKey = null;
        this.busy = false;
        this.suggest = { items: [], index: 0, kind: null, start: 0 };
        this.searchSeq = 0;

        el.innerHTML = `
            <div class="ag-queue" hidden></div>
            <div class="ag-selectors"></div>
            <div class="ag-images" hidden></div>
            <div class="ag-suggest" role="listbox" hidden></div>
            <form class="ag-input-row" autocomplete="off">
                <button type="button" class="icon-btn ag-attach-btn" aria-label="Anexar" aria-haspopup="menu" title="Anexar">${IPHONE ? icon('plus', 22) : icon('paperclip', 18)}</button>
                <button type="button" class="icon-btn ag-preview-btn" aria-label="Prévia" hidden>
                    <span class="ag-preview-label">Prévia</span>${icon('eye', 18)}
                </button>
                <button type="button" class="ag-settings-btn" aria-haspopup="dialog" aria-label="Modelo e configurações" hidden>
                    <span class="ag-settings-label"></span>${icon('chevronDown', 16)}</button>
                <input type="file" multiple hidden>
                <textarea rows="1" aria-label="Mensagem para o agente" enterkeyhint="send"
                    placeholder="Mensagem…"></textarea>
                <button type="button" class="icon-btn ag-stop" aria-label="Parar" hidden>${icon('square', 16)}</button>
                <button type="submit" class="icon-btn ag-send" aria-label="Enviar">${icon('arrowUp', 18)}</button>
            </form>`;
        const q = sel => el.querySelector(sel);
        this.ui = {
            selectors: q('.ag-selectors'), images: q('.ag-images'), suggest: q('.ag-suggest'), queue: q('.ag-queue'),
            form: q('form'), input: q('textarea'), file: q('input[type="file"]'),
            attach: q('.ag-attach-btn'), stop: q('.ag-stop'), send: q('.ag-send'),
            settingsBtn: q('.ag-settings-btn'), settingsLabel: q('.ag-settings-label'),
            previewBtn: q('.ag-preview-btn'),
        };
        this.bind();
        if (IPHONE) this.setupIphone();
    }

    // ---------- iPhone layout ----------

    /**
     * On iPhones the box floats over the conversation (styles.css, "Liquid glass (iPhone)") and the
     * row of selectors is replaced by one summary button ("Default  Auto") that opens a bottom
     * sheet with all of them - like the Claude app. The selectors element itself moves into the
     * sheet, so its change listener and the themed selects keep working as they are.
     */
    setupIphone() {
        const backdrop = document.createElement('div');
        backdrop.className = 'ag-sheet-backdrop';
        backdrop.hidden = true;
        backdrop.innerHTML = `
            <div class="ag-sheet" role="dialog" aria-modal="true" aria-label="Modelo e configurações">
                <div class="ag-sheet-grabber" aria-hidden="true"></div>
                <div class="ag-sheet-head"><h3>Modelo e configurações</h3>
                    <button type="button" class="icon-btn ag-sheet-close" aria-label="Fechar">${icon('x', 18)}</button></div>
                <div class="ag-sheet-body"></div>
            </div>`;
        document.body.appendChild(backdrop);
        backdrop.querySelector('.ag-sheet-body').appendChild(this.ui.selectors);
        this.ui.sheet = backdrop;
        backdrop.addEventListener('click', e => {
            if (e.target === backdrop || e.target.closest('.ag-sheet-close')) this.closeSheet();
        });
        this.ui.settingsBtn.addEventListener('click', () => this.openSheet());
        this.onSheetKey = e => {
            if (e.key === 'Escape' && !backdrop.hidden) this.closeSheet();
        };
        document.addEventListener('keydown', this.onSheetKey);

        // Drag the sheet down to close it (from anywhere except the selects themselves)
        const sheet = backdrop.querySelector('.ag-sheet');
        let startY = null;
        sheet.addEventListener('touchstart', e => {
            startY = e.target.closest('.ui-select, select, input') || sheet.scrollTop > 0 ? null : e.touches[0].clientY;
        }, { passive: true });
        sheet.addEventListener('touchmove', e => {
            if (startY === null) return;
            sheet.style.transition = 'none';
            sheet.style.transform = `translateY(${Math.max(0, e.touches[0].clientY - startY)}px)`;
        }, { passive: true });
        sheet.addEventListener('touchend', e => {
            if (startY === null) return;
            const dragged = e.changedTouches[0].clientY - startY;
            startY = null;
            sheet.style.transition = '';
            sheet.style.transform = '';
            if (dragged > 80) this.closeSheet();
        });

        // Dictation, like the Claude app: a round mic between the settings pill and send. One
        // phrase per tap; the words land in the box so the user reviews before sending.
        this.setupDictation();

        // Vibecoding edge swipes: right edge of agent chat opens preview, left edge of preview goes back
        const previewContainer = document.querySelector('.ag-preview-container');
        bindVibecodeEdgeSwipe(
            // getAgentChat: returns the agent chat element (the composer's el)
            () => this.el,
            // getPreviewContainer: returns the preview container element
            () => previewContainer,
            // onOpenPreview: called when user swipes right on agent chat
            () => {
                // Open the preview
                vibeState.isPreviewOpen = true;
                this.el.classList.add('preview-open');
                // Show the eye button
                if (this.ui.previewBtn) this.ui.previewBtn.hidden = false;
                // Render a minimal preview of the last messages
                renderPreview(previewContainer);
            },
            // onClosePreview: called when user swipes left on preview or taps back
            () => {
                vibeState.isPreviewOpen = false;
                this.el.classList.remove('preview-open');
                // Hide the eye button
                if (this.ui.previewBtn) this.ui.previewBtn.hidden = true;
                // Remove the preview
                if (previewContainer && previewContainer.parentNode) {
                    previewContainer.remove();
                }
            }
        );

        // The conversation scrolls under the floating box: its height goes into --ag-composer-h on
        // the parent, so the last message, the pending bar and the "jump" button stay clear of it.
        // the parent, so the last message, the pending bar and the "jump" button stay clear of it.
        const host = this.el.parentElement;
        if (host && typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => host.style.setProperty('--ag-composer-h', `${this.el.offsetHeight}px`));
            this.resizeObserver.observe(this.el);
        }
    }

    setupDictation() {
        if (!Dictation.supported) return; // no microphone button when the browser cannot transcribe
        const mic = document.createElement('button');
        mic.type = 'button';
        mic.className = 'icon-btn ag-mic';
        mic.setAttribute('aria-label', 'Transcrever voz');
        mic.setAttribute('aria-pressed', 'false');
        mic.title = 'Transcrever voz';
        mic.innerHTML = icon('mic', 20);
        this.ui.form.insertBefore(mic, this.ui.send);
        this.ui.mic = mic;

        this.dictation = new Dictation({
            // While listening the box shows "what was already written + what is being heard", so a
            // half sentence is not lost; the text before the mic was tapped is the base.
            onInterim: text => {
                const input = this.ui.input;
                input.value = (this.micBase || '') + text;
                this.autosize();
            },
            onFinal: text => {
                const input = this.ui.input;
                input.value = (this.micBase || '') + text;
                this.micBase = null;
                this.autosize();
                this.saveDraftSoon();
            },
            onStateChange: listening => {
                mic.classList.toggle('recording', listening);
                mic.setAttribute('aria-pressed', String(listening));
                mic.setAttribute('aria-label', listening ? 'Parar transcrição' : 'Transcrever voz');
                if (listening) {
                    const value = this.ui.input.value;
                    this.micBase = value ? value.replace(/\s*$/, ' ') : '';
                } else if (this.micBase !== null) {
                    // Nothing was recognized: put the box back the way it was
                    if (this.ui.input.value === this.micBase) this.ui.input.value = this.micBase.trimEnd();
                    this.micBase = null;
                    this.autosize();
                }
            },
            onError: message => toast(message, { tone: 'error' }),
        });
        mic.addEventListener('click', () => this.dictation.toggle());
    }

    openSheet() {
        const backdrop = this.ui.sheet;
        if (!backdrop) return;
        this.ui.input.blur(); // the keyboard would cover the sheet
        backdrop.hidden = false;
        requestAnimationFrame(() => requestAnimationFrame(() => backdrop.classList.add('open')));
    }

    closeSheet() {
        const backdrop = this.ui.sheet;
        if (!backdrop) return;
        backdrop.classList.remove('open');
        setTimeout(() => {
            if (!backdrop.classList.contains('open')) backdrop.hidden = true;
        }, 300);
    }

    /** Short text for the summary button: model, then mode - "Default (recommended)" -> "Default". */
    settingsSummary() {
        const caps = (this.session && this.session.capabilities) || {};
        const short = text => String(text || '').replace(/\s*\([^)]*\)/g, '').trim();
        const model = (caps.configOptions || []).find(o => o.category === 'model');
        const modelName = model && (model.options.find(o => o.value === model.currentValue) || {}).name;
        const mode = (caps.modeList || []).find(m => m.id === (this.session && this.session.mode));
        const first = short(modelName) || short(mode && mode.name) || 'Configurações';
        const second = modelName && mode ? short(mode.name) : '';
        return `<strong>${esc(first)}</strong>${second ? `<span>${esc(second)}</span>` : ''}`;
    }

    /** Removes what lives outside the composer's own element (the iPhone sheet). */
    dispose() {
        this.dictation?.stop();
        this.resizeObserver?.disconnect();
        if (this.onSheetKey) document.removeEventListener('keydown', this.onSheetKey);
        this.ui.sheet?.remove();
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
            this.saveDraftSoon();
        });
        this.ui.queue.addEventListener('click', e => {
            const btn = e.target.closest('[data-queue-act]');
            if (!btn) return;
            const item = this.queue.find(i => i.id === btn.dataset.id);
            if (!item) return;
            if (btn.dataset.queueAct === 'edit') {
                // Back to the box (and out of the queue) to change it
                this.opts.onQueueRemove?.(item.id).then(() => {
                    this.ui.input.value = item.text + (this.ui.input.value ? `\n${this.ui.input.value}` : '');
                    this.autosize();
                    this.ui.input.focus();
                    this.saveDraftSoon();
                }).catch(() => {});
            } else {
                this.opts.onQueueRemove?.(item.id).catch(() => {});
            }
        });
        input.addEventListener('keydown', e => this.onKey(e));
        input.addEventListener('blur', () => setTimeout(() => this.closeSuggestions(), 150));
        input.addEventListener('paste', e => {
            const files = [...(e.clipboardData?.files || [])].filter(f => IMAGE_TYPES.includes(f.type));
            if (files.length && this.canAttach()) { // big photos are reduced in addImages
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
            this.saveDraftSoon();
        });
    }

    // ---------- state from the session ----------

    setSession(session) {
        this.session = session;
        if (!this.draftKey && session && session.id) this.restoreDraft(DRAFT_PREFIX + session.id);
        this.setQueue(session && session.queue);
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
        // While the agent works the send button queues the message ("modo fila")
        this.ui.send.classList.toggle('queue', busy);
        this.ui.send.setAttribute('aria-label', busy ? 'Adicionar à fila' : 'Enviar');
        this.ui.send.title = busy ? 'Adicionar à fila (vai quando o agente terminar)' : 'Enviar';
        // Short texts on phones: the field is a single line there
        const narrow = window.matchMedia('(max-width: 600px)').matches;
        this.ui.input.placeholder = status === 'stopped'
            ? 'Agente parado: toque em Retomar'
            : busy ? (narrow ? 'Trabalhando… a próxima entra na fila' : 'O agente está trabalhando… a próxima mensagem entra na fila')
                : (narrow ? 'Mensagem, / ou @' : 'Mensagem… ( / comandos · @ arquivos )');
        this.ui.send.disabled = status === 'starting' || status === 'stopped';
    }

    // ---------- queue ("modo fila") ----------

    setQueue(items) {
        this.queue = Array.isArray(items) ? items : [];
        const box = this.ui.queue;
        box.hidden = !this.queue.length;
        if (!this.queue.length) {
            box.innerHTML = '';
            return;
        }
        box.innerHTML = `
            <div class="ag-queue-head">${icon('list', 13)} Na fila · ${this.queue.length}<span>vai quando o agente terminar</span></div>
            <ol class="ag-queue-list">${this.queue.map((item, i) => `
                <li class="ag-queue-item">
                    <span class="ag-queue-n">${i + 1}</span>
                    <span class="ag-queue-text">${esc(item.text.trim() || '(só imagens)')}${item.images ? ` <em>${icon('fileImage', 12)} ${item.images}</em>` : ''}</span>
                    <button type="button" class="icon-btn" data-queue-act="edit" data-id="${esc(item.id)}" aria-label="Editar" title="Editar (volta para a caixa)">${icon('edit', 14)}</button>
                    <button type="button" class="icon-btn" data-queue-act="remove" data-id="${esc(item.id)}" aria-label="Tirar da fila" title="Tirar da fila">${icon('x', 14)}</button>
                </li>`).join('')}</ol>`;
    }

    // ---------- draft (kept per conversation: survives reloads and tab switches) ----------

    restoreDraft(key) {
        this.draftKey = key;
        let draft = null;
        try {
            draft = JSON.parse(localStorage.getItem(key) || 'null');
        } catch { /* storage blocked or bad JSON */ }
        if (!draft) return;
        if (draft.text && !this.ui.input.value) {
            this.ui.input.value = draft.text;
            requestAnimationFrame(() => this.autosize());
        }
        if (Array.isArray(draft.files) && !this.files.length) {
            this.files = draft.files.filter(f => f && f.path).map(f => ({ name: f.name, path: f.path, size: f.size, status: 'ready' }));
            this.renderImages();
        }
    }

    saveDraftSoon() {
        clearTimeout(this.draftTimer);
        this.draftTimer = setTimeout(() => this.saveDraft(), 250);
    }

    saveDraft() {
        if (!this.draftKey) return;
        const text = this.ui.input.value;
        const files = this.files.filter(f => f.status === 'ready').map(({ name, path, size }) => ({ name, path, size }));
        try {
            if (!text.trim() && !files.length) localStorage.removeItem(this.draftKey);
            else localStorage.setItem(this.draftKey, JSON.stringify({ text, files, at: Date.now() }));
        } catch { /* storage full or blocked: the draft only lives in the box */ }
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
            parts.push(`<label class="ag-select" title="Modo"><span>${icon('shield', 13)}</span><em class="ag-select-name">Modo</em><select data-mode aria-label="Modo">${modes.map(m => `<option value="${esc(m.id)}"${m.id === this.session.mode ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>`);
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
                parts.push(`<label class="ag-select" title="${esc(option.name)}"><span>${label}</span><em class="ag-select-name">${esc(option.name)}</em><select data-config="${esc(option.id)}" aria-label="${esc(option.name)}">${opts}</select></label>`);
            }
        }
        this.ui.selectors.innerHTML = parts.join('');
        this.ui.selectors.hidden = !parts.length;
        // iPhone: the selectors live in the sheet; the button shows what's selected
        if (IPHONE) {
            this.ui.settingsBtn.hidden = !parts.length;
            this.ui.settingsLabel.innerHTML = this.settingsSummary();
        }
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
        return this.canAttach() && IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE_INPUT
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
        this.saveDraftSoon();
    }

    async addImages(files) {
        for (const original of files) {
            if (this.images.length >= MAX_IMAGES) break;
            if (!IMAGE_TYPES.includes(original.type) || original.size > MAX_IMAGE_INPUT) continue;
            const file = await shrinkImage(original);
            if (file.size > MAX_IMAGE_BYTES) {
                toast(`"${original.name}" é grande demais mesmo reduzida.`, { tone: 'error' });
                continue;
            }
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
        if ((!typed && !this.images.length && !ready.length) || this.ui.send.disabled) return;
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
            this.saveDraft(); // the box is empty now: drops the saved draft
        } catch {
            // Keep what the user wrote if it was not accepted
            this.ui.input.value = previous.text;
            this.images = previous.images;
            this.files = previous.files;
            this.renderImages();
            this.saveDraftSoon();
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
