/**
 * agentPicker.js
 * Ao escolher um agente no menu "Agente": em vez de abrir sempre uma conversa nova, mostra as
 * conversas dele (as abertas agora e as anteriores desta pasta) com "Nova conversa" no topo.
 */
import { icon } from './icons.js';
import { agentIconName } from './agent-logos.js';
import { fetchConversations, WORKING } from '../agent/conversations.js';
import { openSheet } from './sheet.js';

// O mesmo balão da lista lateral (conversationDrawer.js)
const BUBBLE = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7.5 19.2 4 20.5l1.1-3.4A8 8 0 1 1 7.5 19.2Z"/></svg>`;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days <= 0) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return 'ontem';
    if (days < 7) return d.toLocaleDateString('pt-BR', { weekday: 'short' });
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

/**
 * @param {object} opts
 * @param {{id: string, label: string}} opts.agent
 * @param {string} opts.folder
 * @param {HTMLElement} [opts.source]
 * @param {() => void} opts.onNew
 * @param {(acpSessionId: string, title: string|null) => void} opts.onResume - conversa anterior
 * @param {(session: object) => void} opts.onOpen - conversa aberta agora
 */
export function openAgentPicker({ agent, source, onNew, onResume }) {
    const isPhone = document.documentElement.hasAttribute('data-iphone');
    const sheet = openSheet({ title: agent.label, className: 'agent-picker', source, page: isPhone });
    // Logo do agente no título
    sheet.sheet.querySelector('h3')?.insertAdjacentHTML('afterbegin', `<span class="ap-title-logo">${icon(agentIconName(agent.id), 20)}</span>`);
    let list = null; // null = carregando
    let query = '';

    sheet.body.innerHTML = `
        <button type="button" class="ap-new" data-ap="new">${icon('plus', 18)}<span>Nova conversa</span></button>
        <div class="ap-search"><input type="search" placeholder="Buscar conversas" aria-label="Buscar conversas" autocomplete="off" spellcheck="false"></div>
        <div class="ap-list"></div>`;
    const listEl = sheet.body.querySelector('.ap-list');
    const input = sheet.body.querySelector('input');

    const row = ({ key, title, sub, working, online }) => `
        <li><button type="button" class="ap-row" data-key="${esc(key)}">
            <span class="cv-row-icon">${working ? '<span class="cv-spin" aria-label="trabalhando"></span>' : BUBBLE}</span>
            <span class="ap-txt"><b>${esc(title || 'Sem título')}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
            ${online ? '<span class="cv-online" aria-label="aberta"></span>' : ''}
        </button></li>`;

    function render() {
        const q = query.trim().toLowerCase();
        const rows = (list || []).filter(c => !q || `${c.title || ''} ${c.cwd || ''}`.toLowerCase().includes(q));
        const live = rows.filter(c => c.status);
        const past = rows.filter(c => !c.status);
        const line = c => row({ key: c.acpSessionId, title: c.title, sub: [when(c.updatedAt), c.cwd].filter(Boolean).join(' · '), working: WORKING.has(c.status), online: !!c.status });
        let html = '';
        if (live.length) html += `<h3 class="cv-section">Agente ligado</h3><ul class="cv-ul">${live.map(line).join('')}</ul>`;
        html += '<h3 class="cv-section">Conversas</h3>';
        if (list === null) html += '<p class="cv-note"><span class="cv-spin"></span> Carregando conversas…</p>';
        else if (!past.length) html += `<p class="cv-note">${q ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa ainda.'}</p>`;
        else html += `<ul class="cv-ul">${past.map(line).join('')}</ul>`;
        listEl.innerHTML = html;
    }

    sheet.body.addEventListener('click', e => {
        if (e.target.closest('[data-ap="new"]')) { sheet.close(); onNew(); return; }
        const btn = e.target.closest('.ap-row');
        if (!btn) return;
        const c = (list || []).find(x => x.acpSessionId === btn.dataset.key);
        sheet.close();
        if (c) onResume(c.acpSessionId, c.title || null, c.cwd || null);
    });
    input.addEventListener('input', () => { query = input.value; render(); });

    render();
    fetchConversations(agent.id).then(l => { list = l; render(); }).catch(() => { list = []; render(); });
    return sheet;
}
