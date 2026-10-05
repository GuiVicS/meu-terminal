/**
 * vibeForm.js
 * "Novo projeto (vibecoding)" form. Opened from the menu (starts the agent UI for the chosen
 * agent) or by an agent through the MCP (the agent waits for the answers and keeps working in
 * its own terminal - it's already mid-conversation there). Either way the result is: agent UI |
 * live preview side by side, plus an "Arquivos" tab of the project.
 *
 * Also lists previous projects (menu flow only - an MCP request already knows its own project):
 * opening one reuses its preview/files tabs and the chosen agent's own conversation if it has
 * one already, same split as a new project. This list + the agent switcher on an open project's
 * tab (agentSession.js) are specific to vibecoding - a plain agent conversation has no project to
 * switch within.
 */
import { icon } from './icons.js';
import { toast } from './toast.js';
import { relativeTime } from './newSession.js';

const base = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function post(route, body) {
    const response = await fetch(`${base()}/api/${route}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
    return data;
}

async function get(route) {
    const response = await fetch(`${base()}/api/${route}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Erro ${response.status}`);
    return data;
}

function slugify(name) {
    return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'projeto';
}

export default class VibeForm {
    constructor() {
        this.kinds = null;
        this.agents = []; // [{id, label, installed}]
        this.previous = []; // previous projects, loaded fresh each time the dialog opens
        this.requestId = null; // set when an agent asked for the form
        this.dialog = document.createElement('dialog');
        this.dialog.className = 'dialog vibe-dialog';
        this.dialog.setAttribute('aria-labelledby', 'vibe-title');
        this.dialog.innerHTML = `
            <form class="vibe-form" autocomplete="off" novalidate>
                <header class="dialog-header">
                    <h2 class="dialog-title" id="vibe-title">Novo projeto · vibecoding</h2>
                    <button type="button" class="icon-btn" data-cancel aria-label="Fechar">${icon('x')}</button>
                </header>
                <div class="dialog-body">
                    <p class="vibe-from-agent" hidden>${icon('bot', 15)} O agente do terminal pediu este formulário: ele começa o projeto assim que você confirmar.</p>
                    <section class="vibe-previous" hidden>
                        <span class="field-label">Projetos anteriores</span>
                        <ul class="vibe-previous-list"></ul>
                    </section>
                    <div class="vibe-divider" hidden><span>ou comece um novo</span></div>
                    <p class="vibe-lead">A tela fica dividida entre o agente e a prévia do site (atualiza sozinha ao salvar), e os arquivos do projeto abrem numa aba própria.</p>
                    <label class="field">
                        <span class="field-label">Nome do projeto</span>
                        <input name="name" type="text" maxlength="80" required placeholder="Ex.: Loja da Ana" enterkeyhint="next">
                    </label>
                    <div class="field">
                        <span class="field-label">Tipo</span>
                        <div class="vibe-kinds" role="radiogroup" aria-label="Tipo de projeto"></div>
                    </div>
                    <label class="field">
                        <span class="field-label">O que você quer construir?</span>
                        <textarea name="description" maxlength="4000" rows="4"
                            placeholder="Ex.: uma landing page para uma loja de roupas, com vitrine de produtos, depoimentos e botão de WhatsApp."></textarea>
                    </label>
                    <div class="vibe-row">
                        <label class="field">
                            <span class="field-label">Pasta</span>
                            <input name="path" type="text" class="mono" autocapitalize="off" autocorrect="off" spellcheck="false">
                        </label>
                        <label class="field" data-agent-field>
                            <span class="field-label">Agente</span>
                            <select name="agent"></select>
                        </label>
                    </div>
                    <label class="vibe-check"><input type="checkbox" name="git" checked> Iniciar um repositório git</label>
                    <p class="prompt-error" role="alert"></p>
                </div>
                <footer class="prompt-actions">
                    <button type="button" class="btn btn-ghost" data-cancel>Cancelar</button>
                    <button type="submit" class="btn btn-primary">Começar</button>
                </footer>
            </form>`;
        document.body.appendChild(this.dialog);
        this.form = this.dialog.querySelector('form');
        this.error = this.dialog.querySelector('.prompt-error');
        const nameInput = this.form.elements.name;
        const pathInput = this.form.elements.path;

        // The folder follows the name until the user edits it
        nameInput.addEventListener('input', () => {
            if (!pathInput.dataset.edited) pathInput.value = `~/projetos/${slugify(nameInput.value)}`;
        });
        pathInput.addEventListener('input', () => { pathInput.dataset.edited = '1'; });
        this.dialog.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => this.cancel()));
        this.dialog.addEventListener('cancel', e => {
            e.preventDefault();
            this.cancel();
        });
        this.dialog.querySelector('.vibe-previous-list').addEventListener('click', e => {
            const btn = e.target.closest('[data-open]');
            if (btn) void this.openPrevious(btn.dataset.open);
        });
        this.form.addEventListener('submit', e => {
            e.preventDefault();
            this.submit();
        });
    }

    async loadKinds() {
        if (this.kinds) return this.kinds;
        try {
            const r = await get('vibe/kinds');
            this.kinds = r.kinds;
            this.agents = Array.isArray(r.agents) ? r.agents : [];
        } catch {
            this.kinds = [{ id: 'static', label: 'Site (HTML, CSS e JS)' }];
            this.agents = [{ id: 'claude', label: 'Claude Code', installed: true }];
        }
        this.dialog.querySelector('.vibe-kinds').innerHTML = this.kinds
            .map(k => `<label class="vibe-kind"><input type="radio" name="kind" value="${k.id}">${k.label}</label>`).join('');
        this.dialog.querySelector('select[name="agent"]').innerHTML = this.agents
            .map(a => `<option value="${a.id}"${a.installed ? '' : ' disabled'}>${esc(a.label)}${a.installed ? '' : ' (não instalado)'}</option>`)
            .join('') + '<option value="none">Nenhum (só o terminal)</option>';
        return this.kinds;
    }

    agentLabel(id) {
        return this.agents.find(a => a.id === id)?.label || id;
    }

    async loadPrevious() {
        try {
            const { projects } = await get('vibe/projects');
            this.previous = projects || [];
        } catch {
            this.previous = [];
        }
        const section = this.dialog.querySelector('.vibe-previous');
        const divider = this.dialog.querySelector('.vibe-divider');
        const show = !this.requestId && this.previous.length > 0;
        section.hidden = !show;
        divider.hidden = !show;
        if (!show) return;
        section.querySelector('.vibe-previous-list').innerHTML = this.previous.map(p => `
            <li class="vibe-prev-item">
                <button type="button" class="vibe-prev-open" data-open="${esc(p.id)}">
                    <span class="vibe-prev-name">${esc(p.name)}</span>
                    <span class="vibe-prev-meta">${esc(p.kind_label)}${p.last_agent ? ` · ${esc(this.agentLabel(p.last_agent))}` : ''} · ${esc(relativeTime(p.updated_at))}</span>
                    <span class="vibe-prev-path mono">${esc(p.folder)}</span>
                </button>
            </li>`).join('');
    }

    async openPrevious(id) {
        const project = this.previous.find(p => p.id === id);
        const buttons = this.dialog.querySelectorAll('.vibe-prev-open');
        buttons.forEach(b => { b.disabled = true; });
        try {
            await post(`vibe/${encodeURIComponent(id)}/open`, {});
            toast(project ? `Reabrindo "${project.name}".` : 'Reabrindo projeto.');
            this.dialog.close();
        } catch (e) {
            this.error.textContent = e.message;
            buttons.forEach(b => { b.disabled = false; });
        }
    }

    /**
     * @param {object} [opts]
     * @param {object} [opts.defaults] - name, path, kind, description
     * @param {string} [opts.requestId] - agent's form request (MCP start_vibecoding)
     */
    async open({ defaults = {}, requestId = null } = {}) {
        this.requestId = requestId;
        await this.loadKinds();
        await this.loadPrevious();
        const f = this.form.elements;
        this.form.reset();
        delete f.path.dataset.edited;
        f.name.value = defaults.name || '';
        f.description.value = defaults.description || '';
        f.path.value = defaults.path || (defaults.name ? `~/projetos/${slugify(defaults.name)}` : '~/projetos/');
        if (defaults.path) f.path.dataset.edited = '1';
        const kind = this.kinds.some(k => k.id === defaults.kind) ? defaults.kind : 'static';
        this.form.querySelector(`input[name="kind"][value="${kind}"]`).checked = true;
        f.git.checked = defaults.git !== false;
        this.dialog.querySelector('.vibe-from-agent').hidden = !requestId;
        this.dialog.querySelector('[data-agent-field]').hidden = !!requestId;
        this.error.textContent = '';
        if (!this.dialog.open) this.dialog.showModal();
        requestAnimationFrame(() => (f.name.value ? f.description : f.name).focus());
    }

    /** Another device answered (or the request expired): close here too. */
    closeRequest(requestId) {
        if (this.dialog.open && this.requestId === requestId) {
            this.requestId = null;
            this.dialog.close();
        }
    }

    answers() {
        const f = this.form.elements;
        return {
            name: f.name.value.trim(),
            path: f.path.value.trim(),
            kind: this.form.querySelector('input[name="kind"]:checked')?.value || 'static',
            description: f.description.value.trim(),
            agent: f.agent.value,
            git: f.git.checked,
        };
    }

    async submit() {
        const answers = this.answers();
        if (!answers.name) {
            this.error.textContent = 'Dê um nome ao projeto.';
            this.form.elements.name.focus();
            return;
        }
        const button = this.form.querySelector('[type="submit"]');
        button.disabled = true;
        this.error.textContent = '';
        try {
            if (this.requestId) {
                await post('vibe/answer', { requestId: this.requestId, answers });
                toast('Pronto! O agente vai começar o projeto.');
            } else {
                await post('vibe', answers);
                toast(answers.agent === 'none' ? 'Projeto criado.' : 'Projeto criado. O agente está começando.');
            }
            this.requestId = null;
            this.dialog.close();
        } catch (e) {
            this.error.textContent = e.message;
        } finally {
            button.disabled = false;
        }
    }

    async cancel() {
        const requestId = this.requestId;
        this.requestId = null;
        this.dialog.close();
        if (requestId) await post('vibe/answer', { requestId, cancelled: true }).catch(() => {});
    }
}
