/**
 * addons.js
 * /admin → Complementos (GET/PUT /api/addons): os plugins do Claude Code que já vêm instalados e
 * os serviços Headroom/OmniRoute com a rota padrão do terminal. A rota de cada conversa do Modo
 * UI é escolhida no menu "Nova conversa".
 */
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { api } from './remote.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ABOUT = {
    'claude-code-setup': 'Recomenda MCPs, hooks, skills e subagentes para o projeto aberto. Só lê, não altera nada. Peça "recomende automações para este projeto".',
    cartographer: 'Mapeia o código com subagentes e gera docs/CODEBASE_MAP.md. Use /cartographer; gasta tokens só quando chamado.',
    'claude-mem': 'Memória entre sessões: guarda resumos do que foi feito e traz o que importa na próxima conversa. Usa o seu plano (Haiku), sem nuvem.',
    headroom: 'Comprime o que o Claude lê (saídas de ferramentas, logs, arquivos) antes de mandar ao modelo. Rota "Economia de tokens". Usa ~300 MB de RAM ligado.',
    omniroute: 'Gateway para outros provedores e modelos (muitos gratuitos), com troca automática quando um falha. Rota "Outros modelos". Usa ~600 MB de RAM ligado.',
};

/** Opens (or reuses) a browser tab of the app on a local panel. */
async function openPanel(url, name) {
    const base = (window.appConfig?.basePath || '').replace(/\/+$/, '');
    const list = await api('GET', '/api/sessions');
    let tab = (list.sessions || []).find(s => s.kind === 'browser' && String(s.url || '').startsWith(url));
    if (!tab) tab = await api('POST', '/api/sessions', { kind: 'browser', url, name });
    window.location.href = `${base}/?tab=${encodeURIComponent(tab.id)}`;
}

export function mountAddonsSection(section) {
    let state = null;
    let busy = false;

    async function refresh() {
        try {
            state = await api('GET', '/api/addons');
        } catch (e) {
            section.innerHTML = `<h3 class="section-label">Complementos</h3><p class="setting-help">${esc(e.message)}</p>`;
            return;
        }
        render();
    }

    async function save(patch, okMessage) {
        if (busy) return;
        busy = true;
        section.classList.add('is-busy');
        try {
            state = { ...state, ...(await api('PUT', '/api/addons', patch)) };
            if (okMessage) toast(okMessage);
        } catch (e) {
            toast(e.message, { tone: 'error', duration: 6000 });
            await refresh();
        } finally {
            busy = false;
            section.classList.remove('is-busy');
            render();
        }
    }

    function pluginRow(a) {
        const status = a.installed === null ? 'status desconhecido' : a.installed ? 'instalado' : (a.seeded ? 'removido por você' : 'instalando…');
        return `
            <li class="rm-row ad-row">
                <span class="rm-name">${esc(a.label)} <span class="rm-meta">plugin · ${status}</span>
                    <span class="setting-help">${esc(ABOUT[a.id] || '')}</span></span>
                ${a.panel && a.installed ? `<span class="rm-actions"><button type="button" class="btn btn-ghost" data-panel="${esc(a.panel)}" data-name="${esc(a.label)}">${icon('externalLink', 15)} Abrir painel</button></span>` : ''}
            </li>`;
    }

    function serviceRow(a) {
        const status = a.enabled ? (a.running ? 'ligado' : (a.lastError ? `com erro: ${a.lastError}` : 'iniciando…')) : 'desligado';
        const omni = a.id === 'omniroute';
        return `
            <li class="rm-row ad-row">
                <label class="setting ad-switch">
                    <span class="setting-text">${esc(a.label)} <span class="rm-meta">serviço · 127.0.0.1:${a.port} · ${esc(status)}</span>
                        <span class="setting-help">${esc(ABOUT[a.id] || '')}</span></span>
                    <input type="checkbox" class="switch" data-service="${esc(a.id)}" ${a.enabled ? 'checked' : ''}>
                </label>
                ${omni && a.panelPassword ? `
                <p class="setting-help">Senha do painel: <span class="rm-copy"><code>${esc(a.panelPassword)}</code>
                    <button type="button" class="icon-btn" data-copy="${esc(a.panelPassword)}" aria-label="Copiar senha">${icon('copy', 15)}</button></span></p>` : ''}
                ${omni ? `
                <div class="ad-omni">
                    <label class="setting setting-stack">
                        <span class="setting-text">Chave do OmniRoute
                            <span class="setting-help">Abra o painel, cadastre os provedores e crie uma chave em Endpoints. ${a.hasApiKey ? 'Uma chave já está salva.' : 'Nenhuma chave salva.'}</span></span>
                        <input type="password" class="mono" data-omni="apiKey" placeholder="${a.hasApiKey ? '•••••••• (deixe em branco para manter)' : 'oma_live_…'}" autocomplete="off" spellcheck="false">
                    </label>
                    <label class="setting setting-stack">
                        <span class="setting-text">Modelo (opcional)
                            <span class="setting-help">Ex.: glm/glm-5.2. Em branco, escolha pelo /model do Claude Code.</span></span>
                        <input type="text" class="mono" data-omni="model" value="${esc(a.model || '')}" autocomplete="off" spellcheck="false">
                    </label>
                    <div class="push-actions">
                        <button type="button" class="btn btn-primary" data-omni-save>Salvar</button>
                        ${a.hasApiKey ? '<button type="button" class="btn btn-ghost" data-omni-clear>Apagar chave</button>' : ''}
                    </div>
                </div>` : ''}
                ${a.enabled && a.panel ? `<span class="rm-actions"><button type="button" class="btn btn-ghost" data-panel="${esc(a.panel)}" data-name="${esc(a.label)}">${icon('externalLink', 15)} Abrir painel</button></span>` : ''}
                ${a.log?.length ? `<details class="ad-log"><summary>Log</summary><pre class="rm-output">${esc(a.log.join('\n'))}</pre></details>` : ''}
            </li>`;
    }

    function render() {
        if (!state) return;
        if (!state.enabled) {
            section.innerHTML = '<h3 class="section-label">Complementos</h3><p class="setting-help">Indisponível no modo demo.</p>';
            return;
        }
        const plugins = state.addons.filter(a => a.kind === 'plugin');
        const services = state.addons.filter(a => a.kind === 'service');
        const routeOk = r => !r.service || services.find(s => s.id === r.service)?.enabled;
        section.innerHTML = `
            <h3 class="section-label">Complementos</h3>
            <p class="setting-help">Já vêm no MeuTerminal e valem no terminal e no Modo UI. Cada função fica num complemento só:
                memória no Claude Mem, mapa do código no Cartographer, economia de tokens no Headroom.</p>
            <ul class="rm-list">${plugins.map(pluginRow).join('')}</ul>

            <h3 class="section-label rm-gap">Serviços</h3>
            <p class="setting-help">Desligados por padrão; só escutam neste servidor (127.0.0.1).</p>
            <ul class="rm-list">${services.map(serviceRow).join('')}</ul>

            <h3 class="section-label rm-gap">Rota do Claude Code</h3>
            <label class="setting setting-stack">
                <span class="setting-text">Terminal
                    <span class="setting-help">Vale para terminais novos e para o Modo UI aberto a partir deles. No menu "Nova conversa" você escolhe a rota de cada conversa.</span></span>
                <select data-terminal-route>
                    ${state.routes.map(r => `<option value="${esc(r.id)}" ${r.id === state.terminalRoute ? 'selected' : ''} ${routeOk(r) ? '' : 'disabled'}>${esc(r.label)}${routeOk(r) ? '' : ' (ligue o serviço)'}</option>`).join('')}
                </select>
            </label>`;
    }

    section.addEventListener('change', e => {
        const sw = e.target.closest('[data-service]');
        if (sw) {
            const label = state.addons.find(a => a.id === sw.dataset.service)?.label;
            save({ services: { [sw.dataset.service]: { enabled: sw.checked } } }, sw.checked ? `${label} ligado.` : `${label} desligado.`);
            return;
        }
        const route = e.target.closest('[data-terminal-route]');
        if (route) save({ terminalRoute: route.value }, 'Rota salva. Vale para terminais novos.');
    });

    section.addEventListener('click', e => {
        const panel = e.target.closest('[data-panel]');
        if (panel) {
            openPanel(panel.dataset.panel, panel.dataset.name).catch(err => toast(err.message, { tone: 'error' }));
            return;
        }
        const copy = e.target.closest('[data-copy]');
        if (copy) {
            navigator.clipboard?.writeText(copy.dataset.copy).then(() => toast('Copiado.'), () => toast('Não foi possível copiar.', { tone: 'error' }));
            return;
        }
        if (e.target.closest('[data-omni-save]')) {
            const apiKey = section.querySelector('[data-omni="apiKey"]').value.trim();
            const model = section.querySelector('[data-omni="model"]').value.trim();
            save({ services: { omniroute: { ...(apiKey ? { apiKey } : {}), model } } }, 'OmniRoute salvo.');
            return;
        }
        if (e.target.closest('[data-omni-clear]')) save({ services: { omniroute: { apiKey: '' } } }, 'Chave apagada.');
    });

    refresh();
    return { refresh };
}
