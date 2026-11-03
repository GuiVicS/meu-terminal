/**
 * conversations.js
 * A lista de conversas de um agente, igual em todo lugar (barra lateral, lista do celular, escolha da
 * conversa): vem do SQL do servidor, sem ligar agente nenhum.
 */
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
export const WORKING = new Set(['thinking', 'waiting_permission', 'starting']);

export async function fetchConversations(agent, { cwd = null, archived = false } = {}) {
    const q = new URLSearchParams({ agent });
    if (cwd) q.set('cwd', cwd);
    if (archived) q.set('archived', '1');
    const r = await fetch(`${basePath()}/api/conversations?${q}`, { credentials: 'same-origin', cache: 'no-store' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
    return data.conversations || [];
}

export async function deleteConversation(agent, acpSessionId) {
    const r = await fetch(`${basePath()}/api/agent-history/${encodeURIComponent(agent)}/${encodeURIComponent(acpSessionId)}`,
        { method: 'DELETE', credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
}

async function send(method, route, body) {
    const r = await fetch(`${basePath()}/api/${route}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Erro ${r.status}`);
    return data;
}

/** Mudar nome, arquivar, marcar como lida/não lida. */
export const updateConversation = (agent, acp, fields) => send('PATCH', `conversations/${encodeURIComponent(agent)}/${encodeURIComponent(acp)}`, fields);
export const stopAgent = sessionId => send('POST', `agent-sessions/${encodeURIComponent(sessionId)}/stop`);

/**
 * Linhas para desenhar. A conversa aberta nesta aba aparece mesmo antes da primeira mensagem (é só
 * visual: não existe no banco ainda).
 */
export function conversationRows(list, active) {
    const rows = list.map(c => ({ key: c.acpSessionId, acp: c.acpSessionId, title: c.title, cwd: c.cwd, at: c.updatedAt,
        working: WORKING.has(c.status), online: !!c.status, sessionId: c.sessionId || null,
        unread: !!c.unread, waiting: c.status === 'waiting_permission', archived: !!c.archived,
        current: !!active && (c.acpSessionId === active.session?.acpSessionId) }));
    if (active?.agentSessionId && !rows.some(r => r.current)) {
        rows.unshift({ key: 'atual', acp: active.session?.acpSessionId || null, title: active.session?.title || 'Nova conversa',
            cwd: active.cwd, at: null, working: WORKING.has(active.session?.status), online: false, current: true });
    }
    return rows;
}
