/**
 * addons.js
 * /admin → Complementos (GET/PUT /api/addons) e a mesma seção na folha de Configurações do
 * celular: os plugins do Claude Code que já vêm instalados, os serviços Headroom/OmniRoute e a
 * rota padrão do terminal. "Abrir" mostra a tela de cada complemento aqui mesmo (admin/addonPanels.js),
 * sem navegador e sem login próprio. A rota de cada conversa do Modo UI fica no menu "Nova conversa".
 */
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { api } from './remote.js';
import { PANELS, esc } from './addonPanels.js';

const ABOUT = {
    'claude-code-setup': 'Recomenda MCPs, hooks, skills e subagentes para o projeto aberto. Só lê, não altera nada. Peça "recomende automações para este projeto".',
    cartographer: 'Mapeia o código com subagentes e gera docs/CODEBASE_MAP.md. Use /cartographer; gasta tokens só quando chamado.',
    'claude-mem': 'Memória entre sessões: guarda resumos do que foi feito e traz o que importa na próxima conversa. Usa o seu plano (Haiku), sem nuvem.',
    headroom: 'Comprime o que o Claude lê (saídas de ferramentas, logs, arquivos) antes de mandar ao modelo. Rota "Economia de tokens". Usa ~300 MB de RAM ligado.',
    omniroute: 'Outros provedores e modelos (muitos gratuitos), com troca automática quando um falha. Rota "Outros modelos". Usa ~600 MB de RAM ligado.',
};

export function mountAddonsSection(section) {
    let state = null;
    let busy = false;
    let open = null; // complemento com a tela aberta

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

    const openBtn = a => (PANELS[a.id] && (a.kind === 'plugin' ? a.installed : a.enabled)
        ? `<span class="rm-actions"><button type="button" class="btn btn-ghost" data-open="${esc(a.id)}">Abrir ${icon('chevronRight', 15)}</button></span>` : '');

    function pluginRow(a) {
        const status = a.installed === null ? 'status desconhecido' : a.installed ? 'instalado' : (a.seeded ? 'removido por você' : 'instalando…');
        return `
            <li class="rm-row ad-row">
                <span class="rm-name">${esc(a.label)} <span class="rm-meta">plugin · ${status}</span>
                    <span class="setting-help">${esc(ABOUT[a.id] || '')}</span></span>
                ${openBtn(a)}
            </li>`;
    }

    function serviceRow(a) {
        const status = a.enabled ? (a.running ? 'ligado' : (a.lastError ? `com erro: ${a.lastError}` : 'iniciando…')) : 'desligado';
        return `
            <li class="rm-row ad-row">
                <label class="setting ad-switch">
                    <span class="setting-text">${esc(a.label)} <span class="rm-meta">serviço · ${esc(status)}</span>
                        <span class="setting-help">${esc(ABOUT[a.id] || '')}</span></span>
                    <input type="checkbox" class="switch" data-service="${esc(a.id)}" ${a.enabled ? 'checked' : ''}>
                </label>
                ${openBtn(a)}
                ${a.log?.length && a.lastError ? `<details class="ad-log"><summary>Log</summary><pre class="rm-output">${esc(a.log.join('\n'))}</pre></details>` : ''}
            </li>`;
    }

    function renderList() {
        const plugins = state.addons.filter(a => a.kind === 'plugin');
        const services = state.addons.filter(a => a.kind === 'service');
        const routeOk = r => !r.service || services.find(s => s.id === r.service)?.enabled;
        section.innerHTML = `
            <h3 class="section-label">Complementos</h3>
            <p class="setting-help">Já vêm no MeuTerminal e valem no terminal e no Modo UI. Cada função fica num complemento só:
                memória no Claude Mem, mapa do código no Cartographer, economia de tokens no Headroom.</p>
            <ul class="rm-list">${plugins.map(pluginRow).join('')}</ul>

            <h3 class="section-label rm-gap">Serviços</h3>
            <p class="setting-help">Desligados por padrão; só funcionam dentro deste servidor.</p>
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

    function renderPanel() {
        const a = state.addons.find(x => x.id === open);
        section.innerHTML = `
            <button type="button" class="ad-back" data-back>${icon('chevronLeft', 18)} Complementos</button>
            <h3 class="section-label ad-panel-title">${esc(a?.label || open)}</h3>
            <div class="ad-panel"></div>`;
        PANELS[open](section.querySelector('.ad-panel'), {
            call: (action, args = {}) => api('POST', `/api/addons/${encodeURIComponent(open)}/call`, { action, ...args }),
            load: () => api('GET', `/api/addons/${encodeURIComponent(open)}/panel`),
            toast,
        });
    }

    function render() {
        if (!state) return;
        if (!state.enabled) {
            section.innerHTML = '<h3 class="section-label">Complementos</h3><p class="setting-help">Indisponível no modo demo.</p>';
            return;
        }
        if (open) renderPanel();
        else renderList();
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
        const opener = e.target.closest('[data-open]');
        if (opener) {
            open = opener.dataset.open;
            render();
            section.scrollIntoView?.({ block: 'start' });
            return;
        }
        if (e.target.closest('[data-back]')) {
            open = null;
            refresh();
        }
    });

    refresh();
    return { refresh };
}
