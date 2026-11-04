const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/agent/conversations.js');
const row = (extra = {}) => ({ acpSessionId: 'acp-1', title: 'Conversa', cwd: '/root', updatedAt: 1, sessionId: 'sess-1', ...extra });

test('a aba aberta que ainda não sabe o id da conversa não duplica a linha', async () => {
    const { conversationRows } = await load();
    const rows = conversationRows([row()], { agentSessionId: 'sess-1', session: { acpSessionId: null, title: 'Conversa' } });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].current, true);
    assert.strictEqual(rows[0].acp, 'acp-1');
});

test('o id da conversa continua valendo sem sessão ligada', async () => {
    const { conversationRows } = await load();
    const rows = conversationRows([row({ sessionId: null })], { agentSessionId: 'sess-9', session: { acpSessionId: 'acp-1' } });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].current, true);
});

test('conversa nova ainda fora do banco aparece no topo', async () => {
    const { conversationRows } = await load();
    const rows = conversationRows([row({ sessionId: 'outra' })], { agentSessionId: 'sess-1', session: { acpSessionId: null } });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].key, 'atual');
    assert.strictEqual(rows[1].current, false);
});

test('sem aba ativa, nada fica marcado como atual', async () => {
    const { conversationRows } = await load();
    const rows = conversationRows([row()], null);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].current, false);
});
