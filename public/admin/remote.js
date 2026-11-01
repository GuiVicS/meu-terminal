/**
 * remote.js
 * /admin → Ponte com o Claude (routes/remote.js): on/off switch, how to connect claude.ai,
 * approval mode, pending approvals, connected clients (revoke), background jobs and the audit log.
 */
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { askConfirm } from '../ui/prompt.js';
import { reauthenticate } from '../ui/reauth.js';

function basePath() {
    return (window.appConfig?.basePath || '').replace(/\/+$/, '');
}

export async function api(method, route, body, { retried = false } = {}) {
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
        // Turning the bridge on / asking for fewer approvals needs the password again (requireReauth)
        if (response.status === 401 && data?.error === 'reauth_necessario' && !retried) {
            if (await reauthenticate()) return api(method, route, body, { retried: true });
            throw new Error('Ação cancelada.');
        }
        throw new Error(data?.error || `Erro ${response.status}`);
    }
    return data;
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const when = t => (t ? dateFormat.format(new Date(t)) : '—');
const JOB_LABEL = { running: 'rodando…', ok: 'ok', failed: 'falhou', timeout: 'expirou', killed: 'encerrado', interrupted: 'interrompido', finished: 'terminou' };
const MODE_HELP = {
    dangerous: 'Pede aprovação só para comandos arriscados (rm -rf, sudo, credenciais, docker rm…).',
    always: 'Pede aprovação para todo comando que o Claude rodar.',
    never: 'Nunca pede aprovação (só registra na auditoria).',
};

export function mountRemoteSection(section) {
    let state = null;
    let auditOffset = 0;

    // Re-renders only when something visible changed, so a periodic check doesn't reset the page
    let lastKey = '';
    async function refresh({ quiet = false } = {}) {
        let next;
        try {
            next = await api('GET', '/api/remote');
        } catch (e) {
            if (!quiet) section.innerHTML = `<h3 class="section-label">Ponte com o Claude</h3><p class="setting-help">${esc(e.message)}</p>`;
            return;
        }
        const key = JSON.stringify(next);
        if (quiet && key === lastKey) return;
        lastKey = key;
        state = next;
        render();
    }

    function renderDisabled() {
        section.innerHTML = `
            <h3 class="section-label">Ponte com o Claude</h3>
            <p class="setting-help">Deixa o Claude do claude.ai (chat e app do celular) usar este servidor como extensão do
                ambiente dele: rodar comandos, instalar programas, ler e gravar arquivos, salvar anotações, abrir páginas e
                mandar push.</p>
            <p class="rm-warning">${icon('info', 15)} Desligada: ${esc(state.reason)}</p>
            <p class="setting-help">Para ligar, defina no .env (ou no painel do Coolify) e reinicie:</p>
            <pre class="rm-code">REMOTE_MCP_ENABLED=true</pre>
            <p class="setting-help">Precisa do login com email e senha (de preferência com o app autenticador).
                Veja docs/PLANO-MCP-REMOTO.md para as outras opções.</p>`;
    }

    function render() {
        if (!state.enabled) return renderDisabled();
        const pending = state.approvals.filter(a => a.status === 'pending');
        section.innerHTML = `
            <h3 class="section-label">Ponte com o Claude</h3>
            <p class="setting-help">O Claude do claude.ai usa este servidor como extensão do ambiente dele. Tudo que ele faz
                fica registrado abaixo.</p>
            ${state.twoFactor ? '' : `<p class="rm-warning">${icon('triangleAlert', 15)} Sem verificação em duas etapas: quem souber a sua senha consegue conectar um Claude. Ative o app autenticador (/guia).</p>`}
            <label class="setting">
                <span class="setting-text">Ponte ligada
                    <span class="setting-help">Desligar corta na hora todo acesso do Claude (os jobs em andamento continuam).</span></span>
                <input type="checkbox" class="switch" data-rm="on" ${state.on ? 'checked' : ''}>
            </label>
            <label class="setting setting-stack">
                <span class="setting-text">Aprovação no celular
                    <span class="setting-help" data-rm-mode-help>${esc(MODE_HELP[state.approvalMode])}</span></span>
                <select data-rm="approvalMode">
                    <option value="dangerous">Só comandos perigosos (recomendado)</option>
                    <option value="always">Sempre</option>
                    <option value="never">Nunca</option>
                </select>
            </label>

            ${pending.length ? `
            <h3 class="section-label rm-gap">Aguardando sua aprovação</h3>
            <ul class="rm-list">${pending.map(a => `
                <li class="rm-row rm-approval">
                    <code class="rm-cmd">${esc(a.summary)}</code>
                    <span class="rm-meta">${esc(a.tool)}${a.risks.length ? ` · ${esc(a.risks.join('; '))}` : ''} · ${when(a.createdAt)}</span>
                    <span class="rm-actions">
                        <button type="button" class="btn btn-primary" data-approve="${esc(a.id)}">Aprovar</button>
                        <button type="button" class="btn btn-ghost" data-reject="${esc(a.id)}">Recusar</button>
                    </span>
                </li>`).join('')}</ul>` : ''}

            <h3 class="section-label rm-gap">Como conectar</h3>
            <ol class="rm-steps">
                <li>No claude.ai: Configurações → Conectores → <b>Adicionar conector personalizado</b>.</li>
                <li>Nome: MeuTerminal. URL:
                    <span class="rm-copy"><code>${esc(state.url)}</code>
                    <button type="button" class="icon-btn" data-copy="${esc(state.url)}" aria-label="Copiar">${icon('copy', 15)}</button></span></li>
                ${state.fixedClientId
                    ? `<li>Em Configurações avançadas, Client ID <code>${esc(state.fixedClientId)}</code> e o Client Secret do .env (REMOTE_MCP_CLIENT_SECRET).${state.dcr ? ' Ou deixe em branco: o registro automático também está ligado.' : ''}</li>`
                    : '<li>Deixe Client ID e Secret em branco (registro automático).</li>'}
                <li>Clique em Conectar: abre esta página pedindo email, senha${state.twoFactor ? ' e o código do autenticador' : ''}. Depois funciona também no app do celular.</li>
            </ol>
            <p class="setting-help">Comandos rodam como <b>${esc(state.runAs)}</b>; pasta de trabalho <code>${esc(state.workdir)}</code>.
                Ferramentas: ${state.tools.map(esc).join(', ')}.</p>

            <h3 class="section-label rm-gap">Clientes conectados</h3>
            <ul class="rm-list">${state.clients.length ? state.clients.map(c => `
                <li class="rm-row">
                    <span class="rm-name">${esc(c.name)} <span class="rm-meta">${c.source === 'env' ? 'cliente fixo' : 'registrado'} · ${c.activeGrants} sessão(ões) ativa(s) · último uso ${when(c.lastUsedAt)}</span></span>
                    <button type="button" class="btn btn-ghost" data-revoke="${esc(c.id)}">Revogar</button>
                </li>`).join('') : '<li class="rm-empty">Nenhum ainda.</li>'}</ul>
            <div class="push-actions"><button type="button" class="btn btn-danger" data-revoke-all>Desconectar todos</button></div>

            <h3 class="section-label rm-gap">Jobs</h3>
            <ul class="rm-list">${state.jobs.length ? state.jobs.map(j => `
                <li class="rm-row">
                    <code class="rm-cmd">${esc(j.name ? `[${j.name}] ` : '')}${esc(j.command)}</code>
                    <span class="rm-meta">${JOB_LABEL[j.status] || esc(j.status)}${j.exitCode != null ? ` (exit ${j.exitCode})` : ''} · ${when(j.startedAt)} · ${Math.round(j.durationMs / 1000)} s</span>
                    <span class="rm-actions">
                        <button type="button" class="btn btn-ghost" data-job-out="${esc(j.id)}">Saída</button>
                        ${j.status === 'running' ? `<button type="button" class="btn btn-ghost" data-job-kill="${esc(j.id)}">Encerrar</button>` : ''}
                    </span>
                    <pre class="rm-output" data-job-pre="${esc(j.id)}" hidden></pre>
                </li>`).join('') : '<li class="rm-empty">Nenhum job.</li>'}</ul>

            <h3 class="section-label rm-gap">Auditoria</h3>
            <ul class="rm-list rm-audit" data-rm-audit></ul>
            <div class="push-actions"><button type="button" class="btn btn-ghost" data-audit-more>Mais antigos</button></div>`;

        section.querySelector('[data-rm="approvalMode"]').value = state.approvalMode;
        auditOffset = 0;
        loadAudit(false);
    }

    async function loadAudit(append) {
        const host = section.querySelector('[data-rm-audit]');
        if (!host) return;
        const rows = await api('GET', `/api/remote/audit?limit=40&offset=${auditOffset}`).catch(() => []);
        auditOffset += rows.length;
        const html = rows.map(r => `
            <li class="rm-row ${r.ok ? '' : 'rm-failed'}">
                <span class="rm-name"><b>${esc(r.tool)}</b> <span class="rm-meta">${when(r.at)} · ${r.durationMs ?? '—'} ms${r.exitCode != null ? ` · exit ${r.exitCode}` : ''}${r.note ? ` · ${esc(r.note)}` : ''}</span></span>
                <code class="rm-cmd">${esc(r.args)}</code>
            </li>`).join('');
        if (append) host.insertAdjacentHTML('beforeend', html);
        else host.innerHTML = html || '<li class="rm-empty">Nada ainda.</li>';
        section.querySelector('[data-audit-more]').hidden = rows.length < 40;
    }

    section.addEventListener('change', async e => {
        const field = e.target.dataset?.rm;
        if (!field) return;
        const value = field === 'on' ? e.target.checked : e.target.value;
        try {
            const r = await api('PUT', '/api/remote', { [field]: value });
            Object.assign(state, r);
            toast(field === 'on' ? (r.on ? 'Ponte ligada.' : 'Ponte desligada.') : 'Modo de aprovação salvo.');
        } catch (err) {
            toast(err.message, { tone: 'error' });
        }
        render();
    });

    section.addEventListener('click', async e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        try {
            if (btn.dataset.copy) {
                await navigator.clipboard.writeText(btn.dataset.copy);
                toast('Copiado.');
            } else if (btn.dataset.approve || btn.dataset.reject) {
                const id = btn.dataset.approve || btn.dataset.reject;
                await api('POST', `/api/remote/approvals/${encodeURIComponent(id)}`, { approve: !!btn.dataset.approve });
                toast(btn.dataset.approve ? 'Aprovado.' : 'Recusado.');
                refresh();
            } else if (btn.dataset.revoke) {
                if (!await askConfirm({ title: 'Revogar este cliente?', message: 'O Claude precisará conectar de novo.', confirm: 'Revogar', danger: true })) return;
                await api('POST', `/api/remote/clients/${encodeURIComponent(btn.dataset.revoke)}/revoke`);
                toast('Cliente revogado.');
                refresh();
            } else if (btn.hasAttribute('data-revoke-all')) {
                if (!await askConfirm({ title: 'Desconectar todos?', message: 'Todos os clientes saem e todos os links de download param de funcionar.', confirm: 'Desconectar', danger: true })) return;
                const r = await api('POST', '/api/remote/revoke-all');
                toast(`${r.tokens} token(s) revogado(s).`);
                refresh();
            } else if (btn.dataset.jobKill) {
                await api('POST', `/api/remote/jobs/${encodeURIComponent(btn.dataset.jobKill)}/kill`);
                refresh();
            } else if (btn.dataset.jobOut) {
                const pre = section.querySelector(`[data-job-pre="${CSS.escape(btn.dataset.jobOut)}"]`);
                if (!pre.hidden) { pre.hidden = true; return; }
                const out = await api('GET', `/api/remote/jobs/${encodeURIComponent(btn.dataset.jobOut)}/output`);
                pre.textContent = out.text || '(sem saída)';
                pre.hidden = false;
            } else if (btn.hasAttribute('data-audit-more')) {
                loadAudit(true);
            }
        } catch (err) {
            toast(err.message, { tone: 'error' });
        }
    });

    // Pending approvals and job progress show up without reloading the page
    const timer = setInterval(() => {
        if (!section.hidden && state?.enabled && !section.querySelector('pre:not([hidden])')) refresh({ quiet: true });
    }, 8000);
    window.addEventListener('beforeunload', () => clearInterval(timer));

    refresh();
    return { refresh };
}
