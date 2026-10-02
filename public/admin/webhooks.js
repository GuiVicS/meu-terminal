/**
 * webhooks.js
 * /admin webhooks section (Phase 3 of docs/PLANO-WEBHOOKS.md): list, create from a preset or
 * blank, edit (general/action/inputs/execution/access tabs), run manually with a live-ish
 * result, and history. No public route yet (phases 4-5) - "Executar agora" here is the only way
 * to trigger a webhook right now.
 */
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { askConfirm } from '../ui/prompt.js';
import { reauthenticate } from '../ui/reauth.js';

function basePath() {
    return (window.appConfig?.basePath || '').replace(/\/+$/, '');
}

async function api(method, route, body, { retried = false } = {}) {
    const response = await fetch(`${basePath()}${route}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.redirected && /\/login$/.test(new URL(response.url).pathname)) {
        window.location.href = `${basePath()}/login`;
        throw new Error('Sua sessão expirou.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
        // Some actions (create a webhook, edit its script, issue a token) ask for the
        // password/PIN again even in an already logged-in session - see requireReauth() in
        // server.js. Prompt once and retry the exact same request; give up on a second 401.
        if (response.status === 401 && data?.error === 'reauth_necessario' && !retried) {
            const ok = await reauthenticate();
            if (ok) return api(method, route, body, { retried: true });
            throw new Error('Ação cancelada.');
        }
        const err = new Error(data?.error || `Erro ${response.status}`);
        err.input = data?.input;
        throw err;
    }
    return data;
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const STATUS_LABEL = { ok: 'ok', failed: 'falhou', timeout: 'expirou', running: 'rodando…' };
const TYPE_LABEL = { text: 'Texto', number: 'Número', boolean: 'Sim/não', select: 'Lista', path: 'Caminho', textarea: 'Texto longo', secret: 'Segredo', file: 'Arquivo' };

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mountWebhooksSection(section) {
    let list = [];
    let presets = [];
    let current = null; // the webhook object being edited, or null = list view
    let tab = 'geral';

    section.innerHTML = `
        <div class="wh-list-view">
            <div class="wh-head">
                <h3 class="section-label" style="margin:0">Webhooks</h3>
                <button type="button" class="btn btn-primary btn-sm" data-wh="new">${icon('plus', 15)} Novo webhook</button>
            </div>
            <p class="setting-help">Scripts que rodam no servidor. Por enquanto só rodam manualmente (botão Executar) -
                a URL pública para chamar de fora vem numa fase seguinte.</p>
            <ul class="wh-rows" data-wh-rows></ul>
        </div>
        <div class="wh-editor-view" hidden>
            <button type="button" class="ns-back" data-wh="back">${icon('arrowLeft', 16)} Webhooks</button>
            <div class="wh-tabs" role="tablist"></div>
            <div class="wh-panels"></div>
        </div>
        <div class="wh-presets" hidden>
            <button type="button" class="ns-back" data-wh="back">${icon('arrowLeft', 16)} Webhooks</button>
            <h3 class="section-label">Começar de um modelo</h3>
            <ul class="wh-preset-list" data-wh-presets></ul>
        </div>`;

    const el = {
        listView: section.querySelector('.wh-list-view'),
        editorView: section.querySelector('.wh-editor-view'),
        presetsView: section.querySelector('.wh-presets'),
        rows: section.querySelector('[data-wh-rows]'),
        tabs: section.querySelector('.wh-tabs'),
        panels: section.querySelector('.wh-panels'),
        presetList: section.querySelector('[data-wh-presets]'),
    };

    function showView(name) {
        el.listView.hidden = name !== 'list';
        el.editorView.hidden = name !== 'editor';
        el.presetsView.hidden = name !== 'presets';
    }

    // ---------- list ----------

    function renderList() {
        if (!list.length) {
            el.rows.innerHTML = '<li class="nt-none">Nenhum webhook ainda.</li>';
            return;
        }
        el.rows.innerHTML = list.map(w => `
            <li class="wh-row">
                <button type="button" class="wh-row-main" data-wh="open" data-id="${esc(w.id)}">
                    <span class="wh-row-title">${w.enabled ? '' : `<span class="wh-off">off</span>`}${esc(w.name)}</span>
                    <span class="wh-row-meta mono">/${esc(w.slug)}</span>
                </button>
                <button type="button" class="btn btn-ghost btn-sm" data-wh="run" data-id="${esc(w.id)}">${icon('bolt', 14)} Executar</button>
                <button type="button" class="icon-btn" data-wh="dup" data-id="${esc(w.id)}" aria-label="Duplicar" title="Duplicar">${icon('copy', 16)}</button>
                <button type="button" class="icon-btn" data-wh="del" data-id="${esc(w.id)}" aria-label="Excluir" title="Excluir">${icon('trash', 16)}</button>
            </li>`).join('');
    }

    async function refreshList() {
        try {
            list = await api('GET', '/api/webhooks');
            renderList();
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    }

    function renderPresets() {
        el.presetList.innerHTML = presets.map(p => `
            <li><button type="button" class="wh-preset" data-wh="pick-preset" data-key="${esc(p.key)}">
                <b>${esc(p.label)}</b><small>${esc(p.description)}</small>
            </button></li>`).join('');
    }

    // ---------- editor ----------

    const TABS = [
        { key: 'geral', label: 'Geral' },
        { key: 'acao', label: 'Ação' },
        { key: 'inputs', label: 'Inputs' },
        { key: 'execucao', label: 'Execução' },
        { key: 'acesso', label: 'Acesso' },
        { key: 'testar', label: 'Testar' },
        { key: 'historico', label: 'Histórico' },
    ];

    function renderTabs() {
        el.tabs.innerHTML = TABS.map(t => `<button type="button" role="tab" data-wh-tab="${t.key}" aria-selected="${t.key === tab}">${t.label}</button>`).join('');
    }

    async function openEditor(id) {
        try {
            current = await api('GET', `/api/webhooks/${encodeURIComponent(id)}`);
        } catch (e) {
            toast(e.message, { tone: 'error' });
            return;
        }
        tab = 'geral';
        renderTabs();
        renderPanel();
        showView('editor');
    }

    async function saveField(patch) {
        try {
            current = await api('PUT', `/api/webhooks/${encodeURIComponent(current.id)}`, patch);
            renderList(); // name/enabled might show in the list too, if we go back
        } catch (e) {
            toast(`Não foi possível salvar: ${e.message}`, { tone: 'error' });
        }
    }

    function panelGeral() {
        return `
            <label class="setting setting-stack">
                <span class="setting-text">Nome</span>
                <input type="text" class="mono" data-wf="name" value="${esc(current.name)}">
            </label>
            <label class="setting setting-stack">
                <span class="setting-text">Slug (URL)
                    <span class="setting-help">Letras minúsculas, números e hífen.</span></span>
                <input type="text" class="mono" data-wf="slug" value="${esc(current.slug)}">
            </label>
            <label class="setting setting-stack">
                <span class="setting-text">Descrição</span>
                <textarea rows="2" data-wf="description">${esc(current.description)}</textarea>
            </label>
            <label class="setting">
                <span class="setting-text">Ativo</span>
                <input type="checkbox" class="switch" data-wf="enabled" ${current.enabled ? 'checked' : ''}>
            </label>`;
    }

    function panelAcao() {
        return `
            <label class="setting setting-stack">
                <span class="setting-text">Script (bash)
                    <span class="setting-help">Use <code class="mono">"$NOME"</code> ou <code class="mono">{{NOME}}</code> para os inputs abaixo - nunca são colados no texto, só chegam como variável de ambiente.</span></span>
                <textarea rows="10" class="mono" data-wf="script" spellcheck="false">${esc(current.script)}</textarea>
            </label>
            <label class="setting setting-stack">
                <span class="setting-text">Pasta (cwd)</span>
                <input type="text" class="mono" data-wf="cwd" value="${esc(current.cwd || '')}" placeholder="~">
            </label>
            <label class="setting">
                <span class="setting-text">Tempo limite (segundos)</span>
                <input type="number" min="5" max="3600" data-wf="timeoutSec" value="${current.timeoutSec}" style="width:90px">
            </label>`;
    }

    function panelInputs() {
        const rows = current.inputs.map((inp, i) => `
            <li class="wh-input-row">
                <div class="wh-input-grid">
                    <input type="text" class="mono" data-wi="name" data-i="${i}" value="${esc(inp.name)}" placeholder="NOME">
                    <input type="text" data-wi="label" data-i="${i}" value="${esc(inp.label)}" placeholder="Rótulo">
                    <select data-wi="type" data-i="${i}">
                        ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${inp.type === v ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                    <select data-wi="source" data-i="${i}">
                        <option value="fixed" ${inp.source === 'fixed' ? 'selected' : ''}>Fixo (definido aqui)</option>
                        <option value="body.${esc(inp.name.toLowerCase())}" ${inp.source?.startsWith('body.') ? 'selected' : ''}>Do corpo (body)</option>
                        <option value="query.${esc(inp.name.toLowerCase())}" ${inp.source?.startsWith('query.') ? 'selected' : ''}>Da URL (query)</option>
                    </select>
                    <label class="wh-input-check"><input type="checkbox" data-wi="required" data-i="${i}" ${inp.required ? 'checked' : ''}> obrigatório</label>
                    <button type="button" class="icon-btn" data-wh="rm-input" data-i="${i}" aria-label="Remover input">${icon('trash', 15)}</button>
                </div>
                <input type="text" class="mono" data-wi="default" data-i="${i}" value="${esc(inp.default || '')}" placeholder="valor padrão">
                ${inp.type === 'select' ? `<input type="text" data-wi="options" data-i="${i}" value="${esc((inp.options || []).join(', '))}" placeholder="opções separadas por vírgula">` : ''}
            </li>`).join('');
        return `
            <ul class="wh-input-list">${rows || '<li class="nt-none">Nenhum input ainda.</li>'}</ul>
            <button type="button" class="btn btn-ghost btn-sm" data-wh="add-input">${icon('plus', 14)} Adicionar input</button>`;
    }

    function panelExecucao() {
        return `
            <label class="setting">
                <span class="setting-text">Concorrência
                    <span class="setting-help">O que fazer se chamarem de novo enquanto já está rodando</span></span>
                <select data-wf="concurrency">
                    <option value="queue" ${current.concurrency === 'queue' ? 'selected' : ''}>Esperar na fila</option>
                    <option value="skip" ${current.concurrency === 'skip' ? 'selected' : ''}>Ignorar</option>
                    <option value="cancel" ${current.concurrency === 'cancel' ? 'selected' : ''}>Cancelar a anterior</option>
                </select>
            </label>
            <label class="setting">
                <span class="setting-text">Limite de disparos (por minuto)</span>
                <input type="number" min="1" max="120" data-wf="ratePerMin" value="${current.ratePerMin}" style="width:80px">
            </label>`;
    }

    function panelAcesso() {
        return `
            <h3 class="section-label" style="margin-top:0">Tokens</h3>
            <p class="setting-help">Vale só quando a rota pública existir (próxima fase). Pode gerar desde já.</p>
            <ul class="wh-token-list" data-wh-tokens><li class="nt-none">Carregando…</li></ul>
            <div class="push-actions"><button type="button" class="btn btn-ghost btn-sm" data-wh="new-token">${icon('plus', 14)} Criar token</button></div>
            <h3 class="section-label">Assinatura HMAC (opcional)</h3>
            <p class="setting-help">Para GitHub/Stripe - exige <code class="mono">WEBHOOK_SECRET_KEY</code> no .env do servidor.</p>
            <div class="wh-hmac-row">
                <input type="password" class="mono" data-wh-hmac placeholder="segredo HMAC">
                <button type="button" class="btn btn-ghost btn-sm" data-wh="set-hmac">Salvar</button>
            </div>`;
    }

    function panelTestar() {
        const fields = current.inputs.filter(i => i.type !== 'file').map(inp => {
            if (inp.type === 'boolean') return `<label class="setting"><span class="setting-text">${esc(inp.label)}</span><input type="checkbox" class="switch" data-wt="${esc(inp.name)}"></label>`;
            if (inp.type === 'select') return `<label class="setting setting-stack"><span class="setting-text">${esc(inp.label)}</span><select data-wt="${esc(inp.name)}">${(inp.options || []).map(o => `<option>${esc(o)}</option>`).join('')}</select></label>`;
            if (inp.type === 'textarea' || inp.type === 'secret') return `<label class="setting setting-stack"><span class="setting-text">${esc(inp.label)}</span><textarea rows="2" data-wt="${esc(inp.name)}">${esc(inp.default || '')}</textarea></label>`;
            return `<label class="setting setting-stack"><span class="setting-text">${esc(inp.label)}</span><input type="text" class="mono" data-wt="${esc(inp.name)}" value="${esc(inp.default || '')}"></label>`;
        }).join('');
        const fileNote = current.inputs.some(i => i.type === 'file') ? '<p class="setting-help">Inputs do tipo arquivo só funcionam pela rota pública (próxima fase) - ignorados aqui.</p>' : '';
        return `
            ${fields || '<p class="setting-help">Este webhook não tem inputs.</p>'}
            ${fileNote}
            <div class="push-actions"><button type="button" class="btn btn-primary" data-wh="run-test">${icon('bolt', 15)} Executar agora</button></div>
            <pre class="wh-output" data-wh-output hidden></pre>`;
    }

    function panelHistorico() {
        return '<ul class="backup-history" data-wh-history><li class="backup-history-empty">Carregando…</li></ul>';
    }

    const PANELS = { geral: panelGeral, acao: panelAcao, inputs: panelInputs, execucao: panelExecucao, acesso: panelAcesso, testar: panelTestar, historico: panelHistorico };

    function renderPanel() {
        el.panels.innerHTML = PANELS[tab]();
        if (tab === 'acesso') void loadTokens();
        if (tab === 'historico') void loadHistory();
    }

    async function loadTokens() {
        const box = el.panels.querySelector('[data-wh-tokens]');
        try {
            const tokens = await api('GET', `/api/webhooks/${encodeURIComponent(current.id)}/tokens`);
            box.innerHTML = tokens.length ? tokens.map(t => `
                <li class="wh-row"><span class="wh-row-main"><b>${esc(t.name)}</b> <span class="mono">${esc(t.prefix)}…</span></span>
                    <button type="button" class="icon-btn" data-wh="revoke-token" data-token="${esc(t.id)}" aria-label="Revogar">${icon('trash', 15)}</button></li>`).join('')
                : '<li class="nt-none">Nenhum token ainda.</li>';
        } catch (e) {
            box.innerHTML = `<li class="nt-none">${esc(e.message)}</li>`;
        }
    }

    async function loadHistory() {
        const box = el.panels.querySelector('[data-wh-history]');
        try {
            const runs = await api('GET', `/api/webhooks/${encodeURIComponent(current.id)}/runs`);
            box.innerHTML = runs.length ? runs.map(r => `
                <li class="backup-history-row ${r.status === 'ok' ? 'ok' : 'error'}">
                    <span>${dateFormat.format(new Date(r.startedAt))}</span>
                    <span>${r.trigger === 'manual' ? 'manual' : r.trigger}</span>
                    <span>${STATUS_LABEL[r.status] || r.status}</span>
                </li>`).join('') : '<li class="backup-history-empty">Nenhuma execução ainda.</li>';
        } catch {
            box.innerHTML = '<li class="backup-history-empty">—</li>';
        }
    }

    // ---------- events ----------

    section.addEventListener('click', async e => {
        const btn = e.target.closest('[data-wh]');
        if (!btn) return;
        const action = btn.dataset.wh;
        const id = btn.dataset.id;

        if (action === 'new') { presets = await api('GET', '/api/webhooks/presets').catch(() => []); renderPresets(); showView('presets'); return; }
        if (action === 'back') { current = null; showView('list'); void refreshList(); return; }
        if (action === 'open') return openEditor(id);
        if (action === 'pick-preset') {
            try {
                const created = await api('POST', '/api/webhooks', { preset: btn.dataset.key });
                toast('Webhook criado.');
                await openEditor(created.id);
            } catch (e) { toast(e.message, { tone: 'error' }); }
            return;
        }
        if (action === 'run') {
            btn.disabled = true;
            try {
                const r = await api('POST', `/api/webhooks/${encodeURIComponent(id)}/run`, { values: {} });
                toast(r.status === 'ok' ? 'Executado com sucesso.' : `Terminou com status: ${STATUS_LABEL[r.status] || r.status}`, { tone: r.status === 'ok' ? 'info' : 'error' });
            } catch (e) { toast(e.message, { tone: 'error' }); } finally { btn.disabled = false; }
            return;
        }
        if (action === 'dup') {
            try { await api('POST', `/api/webhooks/${encodeURIComponent(id)}/duplicate`); toast('Duplicado.'); void refreshList(); } catch (e) { toast(e.message, { tone: 'error' }); }
            return;
        }
        if (action === 'del') {
            const ok = await askConfirm({ title: 'Excluir webhook?', message: 'Não dá pra desfazer.', confirm: 'Excluir', danger: true });
            if (!ok) return;
            try { await api('DELETE', `/api/webhooks/${encodeURIComponent(id)}`); toast('Excluído.'); void refreshList(); } catch (e) { toast(e.message, { tone: 'error' }); }
            return;
        }
        if (action === 'add-input') {
            current.inputs.push({ name: `INPUT${current.inputs.length + 1}`, label: '', type: 'text', required: false, source: 'fixed' });
            await saveField({ inputs: current.inputs });
            renderPanel();
            return;
        }
        if (action === 'rm-input') {
            current.inputs.splice(Number(btn.dataset.i), 1);
            await saveField({ inputs: current.inputs });
            renderPanel();
            return;
        }
        if (action === 'new-token') {
            const name = prompt('Nome do token (ex.: "GitHub"):');
            if (!name) return;
            try {
                const t = await api('POST', `/api/webhooks/${encodeURIComponent(current.id)}/tokens`, { name });
                await navigator.clipboard?.writeText(t.token).catch(() => {});
                toast(`Token criado e copiado: ${t.token} (não aparece de novo)`, { duration: 10000 });
                void loadTokens();
            } catch (e) { toast(e.message, { tone: 'error' }); }
            return;
        }
        if (action === 'revoke-token') {
            try { await api('DELETE', `/api/webhooks/${encodeURIComponent(current.id)}/tokens/${encodeURIComponent(btn.dataset.token)}`); void loadTokens(); } catch (e) { toast(e.message, { tone: 'error' }); }
            return;
        }
        if (action === 'set-hmac') {
            const input = el.panels.querySelector('[data-wh-hmac]');
            try { await api('PUT', `/api/webhooks/${encodeURIComponent(current.id)}/hmac`, { secret: input.value }); toast('Segredo HMAC salvo.'); input.value = ''; } catch (e) { toast(e.message, { tone: 'error' }); }
            return;
        }
        if (action === 'run-test') {
            const values = {};
            el.panels.querySelectorAll('[data-wt]').forEach(f => { values[f.dataset.wt] = f.type === 'checkbox' ? f.checked : f.value; });
            const out = el.panels.querySelector('[data-wh-output]');
            out.hidden = false;
            out.textContent = 'Rodando…';
            try {
                const r = await api('POST', `/api/webhooks/${encodeURIComponent(current.id)}/run`, { values });
                out.textContent = `[${STATUS_LABEL[r.status] || r.status}]\n\n${r.output || '(sem saída)'}`;
            } catch (e) {
                out.textContent = `Erro: ${e.message}${e.input ? ` (input: ${e.input})` : ''}`;
            }
            return;
        }
    });

    el.tabs.addEventListener('click', e => {
        const btn = e.target.closest('[data-wh-tab]');
        if (!btn) return;
        tab = btn.dataset.whTab;
        renderTabs();
        renderPanel();
    });

    let saveTimer = null;
    section.addEventListener('input', e => {
        const field = e.target.closest('[data-wf]');
        if (field) {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                const key = field.dataset.wf;
                const value = field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value;
                saveField({ [key]: value });
            }, 500);
            return;
        }
        const inputField = e.target.closest('[data-wi]');
        if (inputField) {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(() => {
                const i = Number(inputField.dataset.i);
                const key = inputField.dataset.wi;
                let value = inputField.type === 'checkbox' ? inputField.checked : inputField.value;
                if (key === 'options') value = value.split(',').map(s => s.trim()).filter(Boolean);
                if (key === 'name') value = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
                current.inputs[i] = { ...current.inputs[i], [key]: value };
                saveField({ inputs: current.inputs });
            }, 500);
        }
    });
    section.addEventListener('change', e => {
        if (e.target.closest('[data-wf]') && e.target.type === 'checkbox') {
            const key = e.target.dataset.wf;
            saveField({ [key]: e.target.checked });
        }
    });

    showView('list');
    void refreshList();

    return { refresh: refreshList };
}
