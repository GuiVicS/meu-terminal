/**
 * accountRow.js
 * A conta do Claude Code no pé da lista de conversas, como no app do Claude: ícone, nome da conta e o
 * ícone de troca, que abre o menu de contas da conversa. Só aparece em conversas do Claude Code.
 */
import { icon } from './icons.js';

const CACHE_MS = 60000;
let cache = null;

/** A lista custa um "claude auth status" por conta: uma busca por minuto basta para mostrar o nome. */
export function fetchAccounts({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.list;
    const list = fetch(`${(window.appConfig?.basePath || '').replace(/\/+$/, '')}/api/claude-accounts`, { credentials: 'same-origin' })
        .then(r => (r.ok ? r.json() : { accounts: [] }))
        .then(r => r.accounts || [])
        .catch(() => []);
    cache = { at: Date.now(), list };
    return list;
}

/**
 * @param {() => any} getAgent - a AgentSession ativa (ou null)
 * @param {string} [className]
 * @returns {{ el: HTMLButtonElement, sync: () => Promise<void> }}
 */
export function createAccountRow(getAgent, className = '') {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `acct-row ${className}`.trim();
    el.hidden = true;
    el.setAttribute('aria-label', 'Trocar de conta');
    el.innerHTML = `${icon('user', 18)}<span class="acct-name"></span><span class="acct-swap">${icon('swap', 16)}</span>`;
    const name = el.querySelector('.acct-name');

    const sync = async () => {
        const agent = getAgent();
        if (agent?.agentId !== 'claude') {
            el.hidden = true;
            return;
        }
        const accounts = await fetchAccounts();
        const now = getAgent();
        if (now?.agentId !== 'claude' || !accounts.length) {
            el.hidden = true;
            return;
        }
        const current = accounts.find(a => a.id === (now.session?.account || '')) || accounts[0];
        name.textContent = current.name;
        el.title = current.email ? `${current.name} · ${current.email}` : current.name;
        el.hidden = false;
    };
    el.addEventListener('click', () => {
        getAgent()?.openAccountMenu(el, () => sync());
    });
    void sync();
    return { el, sync };
}
