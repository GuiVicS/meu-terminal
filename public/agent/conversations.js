/**
 * conversations.js
 * A lista de conversas de um agente, igual em todo lugar (barra lateral, lista do celular, escolha da
 * conversa): vem do SQL do servidor, sem ligar agente nenhum.
 */
const basePath = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');
export const WORKING = new Set(['thinking', 'waiting_permission', 'starting']);

export async function fetchConversations(agent, { cwd = null } = {}) {
    const q = new URLSearchParams({ agent });
    if (cwd) q.set('cwd', cwd);
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

/**
 * Linhas para desenhar. A conversa aberta nesta aba aparece mesmo antes da primeira mensagem (é só
 * visual: não existe no banco ainda).
 */
export function conversationRows(list, active) {
    const rows = list.map(c => ({ key: c.acpSessionId, acp: c.acpSessionId, title: c.title, cwd: c.cwd, at: c.updatedAt,
        working: WORKING.has(c.status), online: !!c.status,
        current: !!active && (c.acpSessionId === active.session?.acpSessionId) }));
    if (active?.agentSessionId && !rows.some(r => r.current)) {
        rows.unshift({ key: 'atual', acp: active.session?.acpSessionId || null, title: active.session?.title || 'Nova conversa',
            cwd: active.cwd, at: null, working: WORKING.has(active.session?.status), online: false, current: true });
    }
    return rows;
}
