/**
 * vibeForm.js
 * "Novo projeto (vibecoding)" form. Opened from the menu (creates a terminal that runs
 * the chosen agent) or by an agent through the MCP (the agent waits for the answers and
 * keeps working in its own terminal). Either way the result is: agent terminal | live
 * preview side by side, plus an "Arquivos" tab of the project.
 */
import { icon } from './icons.js';
import { toast } from './toast.js';

const base = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');

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

function slugify(name) {
    return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'projeto';
}

export default class VibeForm {
    constructor() {
        this.kinds = null;
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
                    <p class="vibe-lead">A tela fica dividida entre o terminal do agente e a prévia do site (atualiza sozinha ao salvar), e os arquivos do projeto abrem numa aba própria.</p>
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
                            <select name="agent">
                                <option value="claude">Claude Code</option>
                                <option value="codex">Codex</option>
                                <option value="none">Nenhum (só o terminal)</option>
                            </select>
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
        this.form.addEventListener('submit', e => {
            e.preventDefault();
            this.submit();
        });
    }

    async loadKinds() {
        if (this.kinds) return this.kinds;
        try {
            const r = await fetch(`${base()}/api/vibe/kinds`, { credentials: 'same-origin', cache: 'no-store' });
            this.kinds = (await r.json()).kinds;
        } catch {
            this.kinds = [{ id: 'static', label: 'Site (HTML, CSS e JS)' }];
        }
        const box = this.dialog.querySelector('.vibe-kinds');
        box.innerHTML = this.kinds.map(k => `<label class="vibe-kind"><input type="radio" name="kind" value="${k.id}">${k.label}</label>`).join('');
        return this.kinds;
    }

    /**
     * @param {object} [opts]
     * @param {object} [opts.defaults] - name, path, kind, description
     * @param {string} [opts.requestId] - agent's form request (MCP start_vibecoding)
     */
    async open({ defaults = {}, requestId = null } = {}) {
        await this.loadKinds();
        this.requestId = requestId;
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
                toast(answers.agent === 'none' ? 'Projeto criado.' : 'Projeto criado. O agente está começando no terminal.');
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
