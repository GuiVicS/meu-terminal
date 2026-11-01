/**
 * agentPicker.js
 * Ao escolher um agente no menu "Agente": em vez de abrir sempre uma conversa nova, mostra as
 * conversas dele (as abertas agora e as anteriores desta pasta) com "Nova conversa" no topo.
 */
import { icon } from './icons.js';
import { openSheet } from './sheet.js';

const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
// O mesmo balão da lista lateral (conversationDrawer.js)
const BUBBLE = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7.5 19.2 4 20.5l1.1-3.4A8 8 0 1 1 7.5 19.2Z"/></svg>`;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const WORKING = new Set(['thinking', 'waiting_permission', 'starting']);

async function get(route) {
    const r = await fetch(`${basePath()}/api/${route}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
    return data;
}

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
export function openAgentPicker({ agent, folder, source, onNew, onResume, onOpen }) {
    const isPhone = document.documentElement.hasAttribute('data-iphone');
    const sheet = openSheet({ title: agent.label, className: 'agent-picker', source, page: isPhone });
    let open = [];
    let past = null; // null = carregando
    let query = '';

    sheet.body.innerHTML = `
        <button type="button" class="ap-new" data-ap="new">${icon('plus', 18)}<span>Nova conversa</span></button>
        <div class="ap-search"><input type="search" placeholder="Buscar conversas" aria-label="Buscar conversas" autocomplete="off" spellcheck="false"></div>
        <div class="ap-list"></div>`;
    const list = sheet.body.querySelector('.ap-list');
    const input = sheet.body.querySelector('input');

    const row = ({ key, title, sub, working, online }) => `
        <li><button type="button" class="ap-row" data-key="${esc(key)}">
            <span class="cv-row-icon">${working ? '<span class="cv-spin" aria-label="trabalhando"></span>' : BUBBLE}</span>
            <span class="ap-txt"><b>${esc(title || 'Sem título')}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
            ${online ? '<span class="cv-online" aria-label="aberta"></span>' : ''}
        </button></li>`;

    function render() {
        const q = query.trim().toLowerCase();
        const match = t => !q || String(t || '').toLowerCase().includes(q);
        const openAcp = new Set(open.map(o => o.acpSessionId).filter(Boolean));
        const known = new Set((past || []).map(h => h.sessionId));
        // Parada e fora do histórico (nunca recebeu mensagem, ou foi apagada): não dá para retomar
        const opens = open.filter(o => match(o.title) && (o.status !== 'stopped' || (o.acpSessionId && (past === null || known.has(o.acpSessionId)))));
        const pasts = (past || []).filter(h => !openAcp.has(h.sessionId) && match(h.title));
        let html = '';
        if (opens.length) {
            html += `<h3 class="cv-section">Abertas agora</h3><ul class="cv-ul">${opens.map(o => row({
                key: `open:${o.id}`, title: o.title || 'Nova conversa', sub: o.cwd,
                working: WORKING.has(o.status), online: o.status !== 'stopped',
            })).join('')}</ul>`;
        }
        html += `<h3 class="cv-section">Anteriores em ${esc(folder)}</h3>`;
        if (past === null) html += `<p class="cv-note"><span class="cv-spin"></span> Carregando conversas…</p>`;
        else if (!pasts.length) html += `<p class="cv-note">${q ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa anterior nesta pasta.'}</p>`;
        else html += `<ul class="cv-ul">${pasts.map(h => row({ key: `past:${h.sessionId}`, title: h.title, sub: when(h.updatedAt) })).join('')}</ul>`;
        list.innerHTML = html;
    }

    sheet.body.addEventListener('click', e => {
        if (e.target.closest('[data-ap="new"]')) { sheet.close(); onNew(); return; }
        const btn = e.target.closest('.ap-row');
        if (!btn) return;
        const [kind, id] = [btn.dataset.key.slice(0, btn.dataset.key.indexOf(':')), btn.dataset.key.slice(btn.dataset.key.indexOf(':') + 1)];
        sheet.close();
        if (kind === 'open') onOpen(open.find(o => o.id === id));
        else onResume(id, (past || []).find(h => h.sessionId === id)?.title || null);
    });
    input.addEventListener('input', () => { query = input.value; render(); });

    render();
    get(`agent-sessions?agent=${encodeURIComponent(agent.id)}`)
        .then(r => { open = (r.sessions || []).filter(s => s.status !== 'closed'); render(); })
        .catch(() => {});
    get(`agent-history?agent=${encodeURIComponent(agent.id)}&cwd=${encodeURIComponent(folder)}`)
        .then(r => { past = r.sessions || []; render(); })
        .catch(() => { past = []; render(); }); // sem histórico: só não mostra anteriores
    return sheet;
}
