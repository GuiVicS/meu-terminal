/**
 * accountRow.js
 * A conta do agente selecionado, no pé da lista de conversas: ícone, nome da conta e o ícone de troca,
 * que abre o menu de contas dele. Mostra sempre o login do agente certo, não o de outro.
 */
import { icon } from './icons.js';
import { showMenu } from './contextMenu.js';
import { toast } from './toast.js';
import { askText } from './prompt.js';

const CACHE_MS = 60000;
const cache = new Map(); // agente -> { at, data }
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');

async function request(method, route, body) {
    const r = await fetch(`${basePath()}/api/${route}`, {
        method, credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) throw new Error(data?.error || `Erro ${r.status}`);
    return data;
}

/** A lista consulta o login de cada conta: uma busca por minuto basta para mostrar o nome. */
export function fetchAccounts(agent, { fresh = false } = {}) {
    const hit = cache.get(agent);
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    const data = request('GET', `agent-accounts?${new URLSearchParams({ agent })}`)
        .catch(() => ({ accounts: [], shared: false, default: '' }));
    cache.set(agent, { at: Date.now(), data });
    return data;
}

/** O nome que aparece: o da conta extra; a principal mostra quem está logado nela. */
const nameOf = a => (a.id ? a.name : a.email || a.name);

/**
 * @param {object} o
 * @param {Element} o.anchor
 * @param {string} o.agent - id do agente
 * @param {any} [o.session] - conversa aberta deste agente (AgentSession), se houver
 * @param {(tabId: string) => void} [o.showTab]
 * @param {() => void} [o.onDone]
 */
export async function openAccountMenu({ anchor, agent, session = null, showTab, onDone }) {
    const { accounts, shared, default: def } = await fetchAccounts(agent, { fresh: true });
    const current = session ? (session.session?.account || '') : def;
    const login = async body => {
        try {
            const r = await request('POST', 'agent-accounts', { agent, ...body });
            toast(`Abri a aba "${r.tab.name}": faça o login nela e volte aqui.`, { duration: 9000 });
            cache.delete(agent);
            showTab?.(r.tab.id);
        } catch (e) {
            toast(e.message, { tone: 'error' });
        }
    };
    const choose = async a => {
        await request('PUT', 'agent-accounts/default', { agent, id: a.id }).catch(() => {});
        cache.delete(agent);
        if (session) {
            // Sem conversar ainda, ou conta que divide as conversas: é a mesma. Senão, abre uma nova nela
            if (shared || !session.hasConversation) await session.useAccount(a, { fresh: !shared });
            else await session.startConversation({ account: a.id });
        } else {
            toast(`Próximas conversas na conta ${nameOf(a)}.`);
        }
        onDone?.();
    };
    showMenu([
        ...accounts.map(a => {
            const active = a.id === current;
            return {
                label: nameOf(a) + (a.id && a.email ? ` · ${a.email}` : ''),
                icon: active && a.loggedIn ? 'check' : 'user',
                hint: a.loggedIn ? (a.limitedUntil ? 'no limite' : '') : 'entrar',
                disabled: active && a.loggedIn,
                run: () => (a.loggedIn ? choose(a) : login({ id: a.id })),
            };
        }),
        'separator',
        {
            label: 'Adicionar conta', icon: 'plus',
            run: async () => {
                const name = await askText({ title: 'Nova conta', label: 'Nome da conta', placeholder: 'ex.: trabalho', confirm: 'Continuar' });
                if (name != null) await login({ name });
            },
        },
    ], { anchor, label: 'Trocar de conta' });
}

/**
 * @param {object} o
 * @param {() => string|null} o.getAgentId - o agente selecionado
 * @param {() => any} o.getSession - a conversa aberta (AgentSession) ou null
 * @param {(tabId: string) => void} [o.showTab]
 * @param {string} [o.className]
 * @returns {{ el: HTMLButtonElement, sync: () => Promise<void> }}
 */
export function createAccountRow({ getAgentId, getSession, showTab, className = '' }) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `acct-row ${className}`.trim();
    el.hidden = true;
    el.setAttribute('aria-label', 'Trocar de conta');
    el.innerHTML = `${icon('user', 18)}<span class="acct-name"></span><span class="acct-swap">${icon('swap', 16)}</span>`;
    const name = el.querySelector('.acct-name');
    const sessionOf = agent => {
        const s = getSession();
        return s?.agentId === agent ? s : null;
    };

    const sync = async () => {
        const agent = getAgentId();
        if (!agent) {
            el.hidden = true;
            return;
        }
        const { accounts, default: def } = await fetchAccounts(agent);
        if (getAgentId() !== agent) return; // trocou de agente enquanto buscava
        if (!accounts.length) {
            el.hidden = true;
            return;
        }
        const session = sessionOf(agent);
        const id = session ? (session.session?.account || '') : def;
        const current = accounts.find(a => a.id === id) || accounts[0];
        name.textContent = current.loggedIn ? nameOf(current) : 'Entrar na conta';
        el.title = current.email ? `${nameOf(current)} · ${current.email}` : nameOf(current);
        el.dataset.agent = agent;
        el.hidden = false;
    };
    el.addEventListener('click', () => {
        const agent = getAgentId();
        if (agent) void openAccountMenu({ anchor: el, agent, session: sessionOf(agent), showTab, onDone: sync });
    });
    void sync();
    return { el, sync };
}
