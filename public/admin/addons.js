/**
 * addons.js
 * Configurações → Complementos (GET/PUT /api/addons), no /admin e na folha de Configurações do
 * celular. Os complementos aparecem como uma grade de apps; tocar num abre a página dele aqui
 * mesmo: descrição, ligar/desligar (serviços) e a tela própria (admin/addonPanels.js), sem
 * navegador e sem login próprio. Embaixo da grade, a rota padrão do Claude Code no terminal.
 */
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { api } from './remote.js';
import { PANELS, esc } from './addonPanels.js';

// Complementos com painel completo (o do próprio serviço, desenhado pelo navegador do servidor)
const FULL_PANEL = new Set(['omniroute', 'claude-mem', 'headroom']);

const APPS = {
    'claude-code-setup': {
        icon: 'lightbulb', color: 'yellow',
        about: 'Recomenda MCPs, hooks, skills e subagentes para o projeto aberto. Só lê, não altera nada.',
        howto: ['No Claude Code (terminal ou Modo UI), peça: "recomende automações para este projeto".'],
    },
    cartographer: {
        icon: 'gitBranch', color: 'green',
        about: 'Mapeia o código com subagentes e gera docs/CODEBASE_MAP.md, para o Claude entender o projeto sem reler tudo.',
        howto: ['Rode /cartographer no Claude Code dentro da pasta do projeto.', 'Gasta tokens só quando chamado; numa segunda vez, só reanalisa o que mudou.'],
    },
    'claude-mem': {
        icon: 'clipboardList', color: 'purple',
        about: 'Memória entre sessões: guarda resumos do que foi feito e traz o que importa na próxima conversa. Usa o seu plano (Haiku), sem nuvem.',
        howto: ['Funciona sozinho. No Claude Code: /claude-mem:mem-search para buscar.'],
    },
    headroom: {
        icon: 'minimize', color: 'cyan',
        about: 'Comprime o que o Claude lê (saídas de ferramentas, logs, arquivos) antes de mandar ao modelo. Rota "Economia de tokens". ~300 MB de RAM ligado.',
    },
    omniroute: {
        icon: 'swap', color: 'blue',
        about: 'Outros provedores e modelos (muitos gratuitos), com troca automática quando um falha. Rota "Outros modelos". ~600 MB de RAM ligado.',
    },
};

function statusOf(a) {
    if (a.kind === 'plugin') {
        if (a.installed === null) return ['', 'desconhecido'];
        return a.installed ? ['on', 'instalado'] : ['', a.seeded ? 'removido' : 'instalando…'];
    }
    if (!a.enabled) return ['', 'desligado'];
    if (a.running) return ['on', 'ligado'];
    return a.lastError ? ['err', 'com erro'] : ['wait', 'iniciando…'];
}

export function mountAddonsSection(section) {
    let state = null;
    let busy = false;
    let open = null; // app aberto

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

    function renderGrid() {
        const services = state.addons.filter(a => a.kind === 'service');
        const routeOk = r => !r.service || services.find(s => s.id === r.service)?.enabled;
        const omniOn = !!services.find(x => x.id === 'omniroute')?.enabled;
        section.innerHTML = `
            <h3 class="section-label">Complementos</h3>
            <p class="setting-help">Já vêm no MeuTerminal e valem no terminal e no Modo UI. Toque num para abrir.</p>
            <div class="ad-grid" role="list">${state.addons.map(a => {
                const app = APPS[a.id] || { icon: 'grid', color: 'blue' };
                const [cls, label] = statusOf(a);
                return `
                <button type="button" class="ad-app" role="listitem" data-open="${esc(a.id)}" style="--tc: var(--c-${app.color})">
                    <span class="ad-app-icon">${icon(app.icon, 26)}<span class="ad-dot ${cls}" aria-hidden="true"></span></span>
                    <span class="ad-app-name">${esc(a.label)}</span>
                    <span class="ad-app-status">${esc(label)}</span>
                </button>`;
            }).join('')}</div>

            <h3 class="section-label rm-gap">Claude Code</h3>
            <label class="setting setting-stack">
                <span class="setting-text">Rota padrão
                    <span class="setting-help">Vale para terminais novos e para conversas novas do Modo UI. Dentro de uma conversa, troque em ⋮ → Rota.</span></span>
                <select data-terminal-route>
                    ${state.routes.map(r => `<option value="${esc(r.id)}" ${r.id === state.terminalRoute ? 'selected' : ''} ${routeOk(r) ? '' : 'disabled'}>${esc(r.label)}${routeOk(r) ? '' : ' (ligue o serviço)'}</option>`).join('')}
                </select>
            </label>
            <label class="setting">
                <span class="setting-text">Troca automática quando o limite do Claude acabar
                    <span class="setting-help">No Modo UI, a conversa continua pelo OmniRoute com o modelo escolhido e a mensagem é reenviada. A sua assinatura do Claude não passa pelo OmniRoute.</span></span>
                <input type="checkbox" class="switch" data-fallback ${state.fallback?.enabled ? 'checked' : ''}>
            </label>
            ${state.fallback?.enabled ? `
            <label class="setting setting-stack">
                <span class="setting-text">Continuar com
                    <span class="setting-help">${omniOn ? 'Modelos dos provedores conectados no OmniRoute.' : 'Ligue o OmniRoute e conecte um provedor para escolher.'}</span></span>
                <select data-fallback-model ${omniOn ? '' : 'disabled'}>
                    <option value="">${state.fallback.model ? esc(state.fallback.model) : 'Escolha um modelo…'}</option>
                </select>
            </label>` : ''}            </label>`;
    }

    /** Preenche o seletor do modelo da troca automática com os modelos do OmniRoute. */
    async function loadFallbackModels() {
        const select = section.querySelector('[data-fallback-model]');
        if (!select || select.disabled) return;
        try {
            const models = await api('POST', '/api/addons/omniroute/call', { action: 'allModels' });
            if (!section.contains(select)) return;
            const cur = state.fallback?.model || '';
            select.innerHTML = `<option value="">${models.length ? 'Escolha um modelo…' : 'Nenhum modelo: conecte um provedor no OmniRoute'}</option>`
                + models.map(m => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.provider)} · ${esc(m.name)}</option>`).join('');
            if (cur && !models.some(m => m.id === cur)) select.insertAdjacentHTML('beforeend', `<option value="${esc(cur)}" selected>${esc(cur)}</option>`);
        } catch { /* o seletor fica com o modelo atual */ }
    }

    function renderApp() {
        const a = state.addons.find(x => x.id === open);
        if (!a) { open = null; return renderGrid(); }
        const app = APPS[a.id] || {};
        const [cls, label] = statusOf(a);
        const ready = a.kind === 'plugin' ? a.installed : a.enabled;
        section.innerHTML = `
            <button type="button" class="ad-back" data-back>${icon('chevronLeft', 18)} Complementos</button>
            <header class="ad-hero" style="--tc: var(--c-${app.color || 'blue'})">
                <span class="ad-app-icon">${icon(app.icon || 'grid', 30)}</span>
                <span class="ad-hero-text">
                    <span class="ad-hero-name">${esc(a.label)}</span>
                    <span class="ad-hero-status"><span class="ad-dot ${cls}"></span>${esc(a.kind === 'plugin' ? `plugin · ${label}` : label)}</span>
                </span>
                ${a.kind === 'service' ? `<input type="checkbox" class="switch" data-service="${esc(a.id)}" ${a.enabled ? 'checked' : ''} aria-label="Ligar ${esc(a.label)}">` : ''}
            </header>
            <p class="setting-help ad-about">${esc(app.about || '')}</p>
            ${app.howto ? `<ul class="ad-howto">${app.howto.map(h => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
            ${a.lastError && a.log?.length ? `<details class="ad-log"><summary>Log</summary><pre class="rm-output">${esc(a.log.join('\n'))}</pre></details>` : ''}
            ${FULL_PANEL.has(a.id) && ready ? `
            <div class="ad-full">
                <button type="button" class="btn btn-ghost ad-full-toggle" data-full>${icon('maximize', 16)} Abrir painel completo</button>
                <p class="setting-help">O painel inteiro do ${esc(a.label)}, com todas as opções, aqui mesmo: sem navegador e sem outro login.</p>
                <div class="ad-full-view" hidden></div>
            </div>` : ''}
            ${PANELS[a.id] ? (ready ? '<div class="ad-panel"></div>'
                : `<p class="ad-off">${a.kind === 'service' ? `Ligue o ${esc(a.label)} para ver a tela dele.` : 'O plugin não está instalado.'}</p>`) : ''}`;
        const panel = section.querySelector('.ad-panel');
        if (panel) {
            PANELS[a.id](panel, {
                call: (action, args = {}) => api('POST', `/api/addons/${encodeURIComponent(a.id)}/call`, { action, ...args }),
                load: () => api('GET', `/api/addons/${encodeURIComponent(a.id)}/panel`),
                toast,
            });
        }
    }

    // ---------- painel completo ----------
    let full = null; // BrowserSession embutido
    function closeFull() {
        full?.dispose();
        full = null;
    }
    async function toggleFull() {
        const box = section.querySelector('.ad-full-view');
        const btn = section.querySelector('[data-full]');
        if (!box) return;
        if (full) {
            closeFull();
            box.hidden = true;
            box.innerHTML = '';
            btn.innerHTML = `${icon('maximize', 16)} Abrir painel completo`;
            return;
        }
        const { default: BrowserSession } = await import('../managers/browserSession.js');
        const noop = () => {};
        box.hidden = false;
        btn.innerHTML = `${icon('minimize', 16)} Fechar painel completo`;
        full = new BrowserSession({
            row: { id: `addon-panel-${open}`, name: open, url: '' },
            panel: open,
            settings: null,
            hooks: {
                onAuthRequired: () => { window.location.href = `${(window.appConfig?.basePath || '').replace(/\/+$/, '')}/login`; },
                onFocusChange: noop, onInfo: noop, onRemoved: noop, onServerMessage: noop,
                onStateChange: noop, onWorkspaceChanged: noop, suggestFolder: () => '~',
            },
        });
        full.mount(box);
        full.setActive(true);
        full.connect();
        box.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }

    function render() {
        if (!state) return;
        closeFull();
        if (!state.enabled) {
            section.innerHTML = '<h3 class="section-label">Complementos</h3><p class="setting-help">Indisponível no modo demo.</p>';
            return;
        }
        if (open) renderApp();
        else { renderGrid(); loadFallbackModels(); }
    }

    section.addEventListener('change', e => {
        const sw = e.target.closest('[data-service]');
        if (sw) {
            const label = state.addons.find(a => a.id === sw.dataset.service)?.label;
            save({ services: { [sw.dataset.service]: { enabled: sw.checked } } }, sw.checked ? `${label} ligado.` : `${label} desligado.`);
            return;
        }
        const route = e.target.closest('[data-terminal-route]');
        if (route) { save({ terminalRoute: route.value }, 'Rota padrão salva. Vale para terminais e conversas novos.'); return; }
        const fb = e.target.closest('[data-fallback]');
        if (fb) { save({ fallback: { enabled: fb.checked } }, fb.checked ? 'Troca automática ligada.' : 'Troca automática desligada.'); return; }
        const fbModel = e.target.closest('[data-fallback-model]');
        if (fbModel && fbModel.value) save({ fallback: { model: fbModel.value } }, `Troca automática vai usar ${fbModel.value}.`);
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
            closeFull();
            open = null;
            refresh();
            return;
        }
        if (e.target.closest('[data-full]')) toggleFull();
    });

    refresh();
    return { refresh };
}
