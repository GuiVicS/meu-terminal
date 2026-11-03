/**
 * conversationMenu.js
 * O menu de uma conversa, igual na barra lateral do desktop e na lista do celular.
 */
import { askText, askConfirm } from '../ui/prompt.js';
import { toast } from '../ui/toast.js';
import { updateConversation, deleteConversation, stopAgent } from './conversations.js';

/**
 * @param {object} o
 * @param {string} o.agent
 * @param {object} o.row - linha de conversationRows
 * @param {string[]} o.pins
 * @param {(acp: string) => any} o.togglePin
 * @param {(opts: object) => any} o.openTab
 * @param {() => any} o.refresh - recarrega a lista
 * @param {() => any} o.afterDeleteCurrent - apagou a conversa aberta
 * @param {(acp: string) => void} [o.keepUnread] - marcada na conversa aberta: não limpar sozinho
 */
export function conversationMenuItems({ agent, row: r, pins, togglePin, openTab, refresh, afterDeleteCurrent, keepUnread }) {
    if (!r.acp) return [];
    const change = fields => updateConversation(agent, r.acp, fields).then(refresh).catch(e => toast(e.message, { tone: 'error' }));
    const folder = r.cwd || undefined;
    return [
        r.unread
            ? { label: 'Marcar como lida', icon: 'eye', key: 'u', run: () => change({ unread: false }) }
            : { label: 'Marcar como não lida', icon: 'eyeOff', key: 'u', run: () => { keepUnread?.(r.acp); return change({ unread: true }); } },
        'separator',
        { label: pins.includes(r.acp) ? 'Desafixar' : 'Fixar', icon: 'pin', key: 'p', run: () => togglePin(r.acp) },
        { label: 'Mudar o nome', icon: 'edit', key: 'r', run: async () => {
            const title = await askText({ title: 'Mudar o nome', label: 'Nome da conversa', value: r.title || '', confirm: 'Salvar' });
            if (title != null && title.trim()) await change({ title: title.trim() });
        } },
        { label: 'Abrir terminal nesta pasta', icon: 'terminal', run: () => openTab({ cwd: folder }) },
        { label: 'Abrir nos Arquivos', icon: 'folder', run: () => openTab({ kind: 'files', url: 'local', cwd: folder }) },
        ...(r.online && r.sessionId ? [{ label: 'Desligar o agente', icon: 'power', run: () => stopAgent(r.sessionId).then(refresh).catch(e => toast(e.message, { tone: 'error' })) }] : []),
        'separator',
        r.archived
            ? { label: 'Desarquivar', icon: 'archive', key: 'a', run: () => change({ archived: false }) }
            : { label: 'Arquivar', icon: 'archive', key: 'a', run: () => change({ archived: true }) },
        { label: 'Apagar', icon: 'trash', key: 'd', danger: true, run: async () => {
            const ok = await askConfirm({ title: 'Apagar conversa', message: `Apagar "${r.title || 'Sem título'}"? Ela sai da lista.`, confirm: 'Apagar', danger: true });
            if (!ok) return;
            try {
                await deleteConversation(agent, r.acp);
                toast('Conversa apagada.');
                if (r.current) await afterDeleteCurrent?.();
                await refresh();
            } catch (e) {
                toast(e.message, { tone: 'error', duration: 6000 });
            }
        } },
    ];
}
