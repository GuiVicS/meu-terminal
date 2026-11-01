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
import { askText, askConfirm } from '../ui/prompt.js';

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
                    <span class="setting-help">Vale para terminais novos e para conversas novas do Modo UI. Dentro de uma conversa, troque no botão da rota, no topo.</span></span>
                <select data-terminal-route>
                    ${state.routes.map(r => `<option value="${esc(r.id)}" ${r.id === state.terminalRoute ? 'selected' : ''} ${routeOk(r) ? '' : 'disabled'}>${esc(r.label)}${routeOk(r) ? '' : ' (ligue o serviço)'}</option>`).join('')}
                </select>
            </label>
            <label class="setting">
                <span class="setting-text">Troca automática quando o limite do Claude acabar
                    <span class="setting-help">No Modo UI, a conversa continua pela próxima opção da lista abaixo (outra conta do Claude Code ou um modelo do OmniRoute), na mesma conversa, e a mensagem é reenviada.</span></span>
                <input type="checkbox" class="switch" data-fallback ${state.fallback?.enabled ? 'checked' : ''}>
            </label>
            <div data-claude-box><p class="setting-help">Carregando contas…</p></div>`;
    }

    const CHAIN_LABEL = (item, accounts, models) => {
        if (item.startsWith('conta:')) {
            const a = accounts.find(x => x.id === item.slice(6));
            return { icon: 'user', text: `Conta ${a ? (a.email || a.name) : `${item.slice(6) || 'principal'} (removida)`}` };
        }
        const m = models.find(x => x.id === item.slice(7));
        return { icon: 'bot', text: m ? `${m.provider} · ${m.name}` : item.slice(7) };
    };

    /** Contas do Claude Code + ordem da troca automática (carregados depois da tela). */
    async function loadClaudeBox() {
        const box = section.querySelector('[data-claude-box]');
        if (!box) return;
        const omniOn = !!state.addons.find(a => a.id === 'omniroute')?.enabled;
        const [acc, models] = await Promise.all([
            api('GET', '/api/claude-accounts').then(r => r.accounts).catch(() => []),
            omniOn ? api('POST', '/api/addons/omniroute/call', { action: 'allModels' }).catch(() => []) : Promise.resolve([]),
        ]);
        if (!section.contains(box)) return;
        const chain = state.fallback?.chain || [];
        const statusOfAcc = a => a.limitedUntil ? ['wait', 'no limite agora'] : a.loggedIn ? ['on', a.plan ? `logada · ${a.plan}` : 'logada'] : ['off', 'sem login'];
        const accRows = acc.map(a => {
            const [cls, label] = statusOfAcc(a);
            return `<li class="cc-row">
                <span class="cc-ic">${icon('user', 16)}</span>
                <span class="cc-txt"><b>${esc(a.email || a.name)}</b><small><span class="ad-dot ${cls}"></span> ${esc(a.id ? a.name : 'Principal')} · ${esc(label)}</small></span>
                ${a.loggedIn ? '' : `<button type="button" class="btn btn-sm" data-acc-login="${esc(a.id)}">Entrar</button>`}
                ${a.id ? `<button type="button" class="icon-btn" data-acc-remove="${esc(a.id)}" aria-label="Remover conta">${icon('trash', 16)}</button>` : ''}
            </li>`;
        }).join('');
        const chainRows = chain.map((item, i) => {
            const l = CHAIN_LABEL(item, acc, models);
            return `<li class="cc-row">
                <span class="cc-n">${i + 1}</span>
                <span class="cc-txt"><b>${esc(l.text)}</b></span>
                <button type="button" class="icon-btn" data-chain-up="${i}" aria-label="Subir" ${i ? '' : 'disabled'}>${icon('chevronUp', 16)}</button>
                <button type="button" class="icon-btn" data-chain-down="${i}" aria-label="Descer" ${i < chain.length - 1 ? '' : 'disabled'}>${icon('chevronDown', 16)}</button>
                <button type="button" class="icon-btn" data-chain-del="${i}" aria-label="Tirar da lista">${icon('x', 16)}</button>
            </li>`;
        }).join('');
        const options = [
            ...acc.filter(a => !chain.includes(`conta:${a.id}`)).map(a => `<option value="conta:${esc(a.id)}">Conta: ${esc(a.email || a.name)}</option>`),
            ...models.filter(m => !chain.includes(`modelo:${m.id}`)).map(m => `<option value="modelo:${esc(m.id)}">OmniRoute: ${esc(m.provider)} · ${esc(m.name)}</option>`),
        ];
        box.innerHTML = `
            <p class="setting-text cc-title">Contas do Claude Code neste servidor</p>
            <ul class="cc-list">${accRows}</ul>
            <button type="button" class="btn btn-sm cc-add" data-acc-add>${icon('plus', 15)} Adicionar conta</button>
            <p class="setting-help">O login é o do próprio Claude Code, num terminal que abre aqui. As conversas e configurações são as mesmas em todas as contas; só o login muda. Usar várias contas para driblar limites pode contrariar os termos da Anthropic: a decisão é sua.</p>
            ${state.fallback?.enabled ? `
            <p class="setting-text cc-title">Ordem da troca automática</p>
            ${chain.length ? `<ol class="cc-list">${chainRows}</ol>` : '<p class="setting-help">Lista vazia: adicione contas ou modelos abaixo. Vale a primeira opção disponível, de cima para baixo.</p>'}
            ${options.length ? `<label class="setting setting-stack"><span class="setting-text">Adicionar à lista</span>
                <select data-chain-add><option value="">Escolha…</option>${options.join('')}</select></label>`
                : `<p class="setting-help">${omniOn ? '' : 'Ligue o OmniRoute para incluir modelos de outros provedores.'}</p>`}` : ''}`;
    }

    function saveChain(chain, msg) {
        save({ fallback: { chain } }, msg);
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
        else { renderGrid(); loadClaudeBox(); }
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
        const add = e.target.closest('[data-chain-add]');
        if (add && add.value) saveChain([...(state.fallback?.chain || []), add.value], 'Adicionado à troca automática.');
    });

    section.addEventListener('click', async e => {
        const chain = [...(state.fallback?.chain || [])];
        const up = e.target.closest('[data-chain-up]');
        const down = e.target.closest('[data-chain-down]');
        const del = e.target.closest('[data-chain-del]');
        if (up || down) {
            const i = Number((up || down).dataset[up ? 'chainUp' : 'chainDown']);
            const j = up ? i - 1 : i + 1;
            [chain[i], chain[j]] = [chain[j], chain[i]];
            return saveChain(chain, 'Ordem salva.');
        }
        if (del) { chain.splice(Number(del.dataset.chainDel), 1); return saveChain(chain, 'Tirado da troca automática.'); }
        const login = e.target.closest('[data-acc-add], [data-acc-login]');
        if (login) {
            let name = '';
            if (login.matches('[data-acc-add]')) {
                name = await askText({ title: 'Nova conta do Claude Code', label: 'Nome da conta', placeholder: 'ex.: trabalho', confirm: 'Continuar' });
                if (name == null) return;
            }
            try {
                const r = await api('POST', '/api/claude-accounts', login.dataset.accLogin ? { id: login.dataset.accLogin } : { name });
                toast(`Abri a aba "${r.tab.name}": faça o login do Claude Code nela e volte aqui.`, { duration: 9000 });
            } catch (err) {
                toast(err.message, { tone: 'error' });
            }
            return;
        }
        const rm = e.target.closest('[data-acc-remove]');
        if (rm) {
            if (!await askConfirm({ title: 'Remover conta', message: `Remover a conta "${rm.dataset.accRemove}" deste servidor? Sai o login dela; as conversas ficam.`, confirm: 'Remover', danger: true })) return;
            try {
                await api('DELETE', `/api/claude-accounts/${encodeURIComponent(rm.dataset.accRemove)}`);
                toast('Conta removida.');
                await refresh();
            } catch (err) {
                toast(err.message, { tone: 'error' });
            }
            return;
        }
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
