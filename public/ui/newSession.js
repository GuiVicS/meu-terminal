/**
 * newSession.js
 * "Home screen" for the workspace: an app grid (like a phone's home screen) to open a Terminal,
 * Navegador, Arquivos, Anotações, an agent conversation or a vibecoding project, plus recently
 * closed sessions. Shown whenever no tab is open (it stays until something is), and as a
 * dismissible overlay from "+" / the menu otherwise. "Opções avançadas" reaches the classic form
 * (custom name, starting directory, URL). Rendered inside the workspace (over the terminals),
 * not as a blocking modal.
 */
import { icon } from './icons.js';

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function relativeTime(timestamp) {
    const diff = (timestamp - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [unit, secs] of units) {
        if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
    }
    return 'agora';
}

// data-kind -> handlers.onCreate({ kind }); data-special -> its own handler. data-flag gates on appConfig.
const APPS = [
    { kind: 'terminal', icon: 'terminal', label: 'Terminal', color: 'green' },
    { kind: 'browser', icon: 'globe', label: 'Navegador', color: 'blue', flag: 'browserAvailable' },
    { kind: 'files', icon: 'folder', label: 'Arquivos', color: 'orange', flag: 'filesAvailable' },
    { kind: 'notes', icon: 'notes', label: 'Anotações', color: 'yellow', flag: 'notesAvailable' },
    { special: 'agent', icon: 'bot', label: 'Agente', color: 'purple' },
    { special: 'vibecode', icon: 'zap', label: 'Vibecoding', color: 'cyan' },
];

export default class NewSessionPage {
    /**
     * @param {HTMLElement} host - workspace element the page is placed in
     * @param {{ onCreate: Function, onAgent: Function, onVibecode: Function, onCancel: Function, onForget: Function }} handlers
     */
    constructor(host, handlers) {
        this.handlers = handlers;
        this.view = 'grid';
        this.closable = true;
        this.el = document.createElement('section');
        this.el.className = 'new-session';
        this.el.hidden = true;
        this.el.setAttribute('role', 'dialog');
        this.el.setAttribute('aria-modal', 'false');
        this.el.setAttribute('aria-labelledby', 'new-session-title');
        this.el.innerHTML = `
            <button type="button" class="icon-btn ns-close" aria-label="Fechar">${icon('x', 18)}</button>
            <div class="new-session-inner">
                <div class="ns-home">
                    <div class="new-session-mark" aria-hidden="true">${icon('terminal', 22)}</div>
                    <h2 id="app-grid-title" class="app-grid-title"></h2>
                    <div class="app-grid" role="list" aria-label="Abrir">
                        ${APPS.map(a => `
                            <button type="button" class="app-tile" data-color="${a.color}"
                                ${a.kind ? `data-kind="${a.kind}"` : `data-special="${a.special}"`}
                                ${a.flag ? `data-flag="${a.flag}"` : ''} role="listitem">
                                <span class="app-tile-icon">${icon(a.icon, 24)}</span>
                                <span class="app-tile-label">${a.label}</span>
                            </button>`).join('')}
                    </div>
                </div>

                <form class="new-session-form" autocomplete="off" hidden>
                    <button type="button" class="ns-back">${icon('arrowLeft', 16)} Início</button>
                    <h2 id="new-session-title" class="new-session-title"></h2>
                    <div class="kind-toggle" role="radiogroup" aria-label="Tipo de aba">
                        <button type="button" role="radio" data-kind="terminal" aria-checked="true">${icon('terminal', 16)} Terminal</button>
                        <button type="button" role="radio" data-kind="browser" aria-checked="false">${icon('globe', 16)} Navegador</button>
                        <button type="button" role="radio" data-kind="files" aria-checked="false">${icon('folder', 16)} Arquivos</button>
                        <button type="button" role="radio" data-kind="notes" aria-checked="false">${icon('notes', 16)} Anotações</button>
                    </div>
                    <label class="field">
                        <span class="field-label">Nome</span>
                        <input name="name" type="text" maxlength="60" autocapitalize="off" spellcheck="false">
                    </label>
                    <label class="field" data-for="terminal files">
                        <span class="field-label">Diretório inicial</span>
                        <input name="cwd" type="text" class="mono" autocapitalize="off" autocorrect="off" spellcheck="false">
                        <span class="field-help">Se o caminho não existir, o shell abre no diretório padrão do servidor.</span>
                    </label>
                    <div class="field" data-for="browser" hidden>
                        <label class="field-label" for="new-session-url">Endereço</label>
                        <input id="new-session-url" name="url" type="text" inputmode="url" class="mono"
                            autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="localhost:5173 ou site.com">
                        <div class="port-chips" aria-label="Portas abertas no servidor"></div>
                        <span class="field-help">O navegador roda no servidor: "localhost" são os projetos rodando lá.</span>
                    </div>
                    <div class="new-session-actions">
                        <button type="button" class="btn btn-ghost" data-action="back">Cancelar</button>
                        <button type="submit" class="btn btn-primary">Criar sessão</button>
                    </div>
                </form>

                <div class="recent">
                    <h3 class="section-label">Sessões recentes</h3>
                    <ul class="recent-list" role="list"></ul>
                </div>
            </div>`;
        host.appendChild(this.el);

        this.form = this.el.querySelector('form');
        // form.name would return the form's own name attribute, so keep direct refs
        this.nameInput = this.form.querySelector('input[name="name"]');
        this.cwdInput = this.form.querySelector('input[name="cwd"]');
        this.urlInput = this.form.querySelector('input[name="url"]');
        this.kind = 'terminal';
        this.form.addEventListener('submit', e => {
            e.preventDefault();
            const data = new FormData(this.form);
            this.handlers.onCreate({
                kind: this.kind,
                name: String(data.get('name') || '').trim(),
                cwd: String(data.get('cwd') || '').trim(),
                url: String(data.get('url') || '').trim(),
            });
        });
        this.el.querySelector('.kind-toggle').addEventListener('click', e => {
            const btn = e.target.closest('[data-kind]');
            if (btn) this.setKind(btn.dataset.kind);
        });
        this.el.querySelector('.app-grid').addEventListener('click', e => {
            const tile = e.target.closest('.app-tile');
            if (!tile || tile.hidden) return;
            if (tile.dataset.special === 'agent') this.handlers.onAgent(tile);
            else if (tile.dataset.special === 'vibecode') this.handlers.onVibecode();
            else this.showForm(tile.dataset.kind);
        });
        this.el.querySelectorAll('[data-action="back"]').forEach(btn => btn.addEventListener('click', () => this.showGrid()));
        this.el.querySelector('.ns-close').addEventListener('click', () => this.handlers.onCancel());
        this.el.addEventListener('keydown', e => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            if (this.view === 'form') this.showGrid();
            else if (this.closable) this.handlers.onCancel();
        });
    }

    get isOpen() {
        return !this.el.hidden;
    }

    /**
     * @param {{ defaultName: string, defaultCwd: string, recents: Array, closable?: boolean, advanced?: boolean }} opts
     */
    open({ defaultName, defaultCwd, recents, closable = true, advanced = false }) {
        this.nameInput.value = '';
        this.nameInput.placeholder = defaultName;
        this.cwdInput.value = '';
        this.cwdInput.placeholder = defaultCwd || '~  (padrão do servidor)';
        this.urlInput.value = '';
        this.closable = closable;
        this.el.querySelector('.ns-close').hidden = !closable;
        const cfg = window.appConfig || {};
        this.el.querySelectorAll('.app-grid [data-flag]').forEach(t => { t.hidden = !cfg[t.dataset.flag]; });
        const toggle = this.el.querySelector('.kind-toggle');
        toggle.querySelector('[data-kind="browser"]').hidden = !cfg.browserAvailable;
        toggle.querySelector('[data-kind="files"]').hidden = !cfg.filesAvailable;
        toggle.querySelector('[data-kind="notes"]').hidden = !cfg.notesAvailable;
        toggle.hidden = !cfg.browserAvailable && !cfg.filesAvailable && !cfg.notesAvailable;
        this.el.querySelector('.app-grid-title').textContent = cfg.siteTitle || 'O que você quer abrir?';
        this.renderRecents(recents);
        this.el.hidden = false;
        if (advanced) this.showForm('terminal');
        else this.showGrid();
    }

    close() {
        this.el.hidden = true;
    }

    showGrid() {
        this.view = 'grid';
        this.el.setAttribute('aria-labelledby', 'app-grid-title');
        this.el.querySelector('.ns-home').hidden = false;
        this.form.hidden = true;
        if (!window.matchMedia('(pointer: coarse)').matches) {
            this.el.querySelector('.app-tile:not([hidden])')?.focus({ preventScroll: true });
        }
    }

    showForm(kind) {
        this.view = 'form';
        this.el.setAttribute('aria-labelledby', 'new-session-title');
        this.el.querySelector('.ns-home').hidden = true;
        this.form.hidden = false;
        this.setKind(kind);
        // On touch devices don't pop the keyboard - the primary action is one tap away
        const target = window.matchMedia('(pointer: coarse)').matches
            ? this.form.querySelector('[type="submit"]')
            : this.nameInput;
        target.focus({ preventScroll: true });
    }

    setKind(kind) {
        this.kind = kind;
        this.el.querySelectorAll('.kind-toggle [data-kind]').forEach(b => {
            b.setAttribute('aria-checked', String(b.dataset.kind === kind));
        });
        this.el.querySelectorAll('[data-for]').forEach(f => { f.hidden = !f.dataset.for.split(' ').includes(kind); });
        const texts = {
            terminal: ['Nova sessão', 'Criar sessão', 'Se o caminho não existir, o shell abre no diretório padrão do servidor.'],
            browser: ['Nova aba de navegador', 'Abrir navegador', ''],
            files: ['Novo gerenciador de arquivos', 'Abrir arquivos', 'Vazio = pasta inicial do servidor. O Google Drive (rclone) aparece no painel lateral.'],
            notes: ['Nova aba de anotações', 'Abrir anotações', ''],
        }[kind];
        this.el.querySelector('.new-session-title').textContent = texts[0];
        this.form.querySelector('[type="submit"]').textContent = texts[1];
        const help = this.el.querySelector('[data-for~="terminal"] .field-help');
        if (help && texts[2]) help.textContent = texts[2];
        if (kind === 'browser') this.loadPorts();
    }

    /** Suggests the dev servers running on the server ("localhost:5173"). */
    async loadPorts() {
        const box = this.el.querySelector('.port-chips');
        box.textContent = '';
        try {
            const base = (window.appConfig?.basePath || '').replace(/\/+$/, '');
            const response = await fetch(`${base}/api/ports`, { credentials: 'same-origin', cache: 'no-store' });
            const ports = response.ok ? await response.json() : [];
            ports.forEach(({ port, name }) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'port-chip';
                chip.textContent = `localhost:${port}`;
                if (name) chip.title = name;
                chip.addEventListener('click', () => {
                    this.urlInput.value = `localhost:${port}`;
                    this.form.requestSubmit();
                });
                box.appendChild(chip);
            });
        } catch { /* no suggestions */ }
    }

    renderRecents(recents) {
        const list = this.el.querySelector('.recent-list');
        list.innerHTML = '';
        this.el.querySelector('.recent').hidden = recents.length === 0;
        recents.forEach((r, index) => {
            const li = document.createElement('li');
            li.className = 'recent-item';
            li.innerHTML = `
                <button type="button" class="recent-open">
                    <span class="recent-dot" aria-hidden="true"></span>
                    <span class="recent-text">
                        <span class="recent-name"></span>
                        <span class="recent-meta"><span class="recent-cwd mono"></span><span class="recent-time"></span></span>
                    </span>
                </button>
                <button type="button" class="icon-btn recent-forget">${icon('x', 14)}</button>`;
            li.querySelector('.recent-name').textContent = r.name;
            li.querySelector('.recent-cwd').textContent = r.cwd || '~';
            li.querySelector('.recent-time').textContent = relativeTime(r.closedAt);
            li.querySelector('.recent-open').setAttribute('aria-label',
                `Reabrir ${r.name} em ${r.cwd || 'diretório padrão'}, fechada ${relativeTime(r.closedAt)}`);
            li.querySelector('.recent-forget').setAttribute('aria-label', `Remover ${r.name} do histórico`);
            li.querySelector('.recent-open').addEventListener('click', () => {
                this.handlers.onCreate({ name: r.name, cwd: r.cwd, fromRecent: index });
            });
            li.querySelector('.recent-forget').addEventListener('click', () => {
                this.handlers.onForget(index);
            });
            list.appendChild(li);
        });
    }
}
