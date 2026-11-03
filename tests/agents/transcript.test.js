const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { readTranscript, listOnDisk } = require('../../scripts/agents/transcript');

const lines = arr => `${arr.map(x => JSON.stringify(x)).join('\n')}\n`;

function fixture() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-tr-'));
    const pj = path.join(home, '.claude', 'projects', '-root');
    fs.mkdirSync(pj, { recursive: true });
    fs.writeFileSync(path.join(pj, 'clau-cli.jsonl'), lines([
        { type: 'user', entrypoint: 'cli', cwd: '/root', message: { content: 'Oi <system-reminder>segredo</system-reminder>' } },
        { type: 'user', isMeta: true, message: { content: 'meta' } },
        { type: 'user', isSidechain: true, message: { content: 'subagente' } },
        { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 'Olá' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a' }] } },
        { type: 'ai-title', aiTitle: 'Título bom' },
    ]));
    fs.writeFileSync(path.join(pj, 'clau-sdk.jsonl'), lines([{ type: 'user', entrypoint: 'sdk-ts', cwd: '/root', message: { content: 'automático' } }]));
    const cx = path.join(home, '.codex', 'sessions', '2026', '11');
    fs.mkdirSync(cx, { recursive: true });
    fs.writeFileSync(path.join(cx, 'rollout-x-code-1.jsonl'), lines([
        { type: 'session_meta', payload: { id: 'code-1', originator: 'codex-tui', source: 'cli', cwd: '/root' } },
        { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'regras' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: '<environment_context>x</environment_context>' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ text: 'faz isso' }] } },
        { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'shell' } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ text: 'feito' }] } },
    ]));
    fs.writeFileSync(path.join(cx, 'rollout-x-code-2.jsonl'), lines([{ type: 'session_meta', payload: { id: 'code-2', originator: 'codex-tui', source: { subagent: 'r' } } }]));
    const od = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(od, { recursive: true });
    const db = new DatabaseSync(path.join(od, 'opencode.db'));
    db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_updated INT, time_archived INT);
        CREATE TABLE message (id TEXT, session_id TEXT, time_created INT, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, time_created INT, data TEXT);`);
    db.exec(`INSERT INTO session VALUES ('oc-1', NULL, '/root', 'Conversa OC', 5, NULL), ('oc-2', 'oc-1', '/root', 'filho', 5, NULL);`);
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'oc-1', 1, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m2', 'oc-1', 2, JSON.stringify({ role: 'assistant' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p1', 'm1', 1, JSON.stringify({ type: 'text', text: 'pergunta' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p2', 'm2', 2, JSON.stringify({ type: 'tool', callID: 'k1', tool: 'bash', state: { status: 'completed', title: 'ls' } }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?)').run('p3', 'm2', 3, JSON.stringify({ type: 'text', text: 'resposta' }));
    db.close();
    return home;
}
const text = ev => ev.filter(e => /message\.(user|assistant\.delta)/.test(e.type)).map(e => e.data.text);

test('lê cada agente sem ligar nada: Claude, Codex e OpenCode', () => {
    const home = fixture();
    const c = readTranscript('claude', 'clau-cli', home);
    assert.deepEqual(text(c), ['Oi', 'Olá']); // sem subagente, meta e lembretes internos
    assert.ok(c.some(e => e.type === 'tool.start' && e.data.kind === 'bash' && e.data.title === 'ls'));
    assert.deepEqual(text(readTranscript('codex', 'code-1', home)), ['faz isso', 'feito']);
    const o = readTranscript('opencode', 'oc-1', home);
    assert.deepEqual(text(o), ['pergunta', 'resposta']);
    assert.ok(o.some(e => e.type === 'tool.result' && e.data.status === 'completed'));
    fs.rmSync(home, { recursive: true, force: true });
});

test('desconhecido ou inválido: vazio, sem erro', () => {
    const home = fixture();
    assert.deepEqual(readTranscript('agy', 'qualquer', home), []);
    assert.deepEqual(readTranscript('claude', 'nao-existe', home), []);
    assert.deepEqual(readTranscript('claude', '../../etc/passwd', home), []);
    fs.rmSync(home, { recursive: true, force: true });
});

test('índice do disco: só o que a pessoa abriu; subagente e automático ficam de fora; não relê o que não mudou', () => {
    const home = fixture();
    const seen = new Map();
    const found = listOnDisk(home, seen);
    assert.deepEqual(found.map(f => `${f.agent}:${f.acpSessionId}`).sort(), ['claude:clau-cli', 'codex:code-1', 'opencode:oc-1']);
    assert.equal(found.find(f => f.agent === 'claude').title, 'Título bom');
    assert.equal(found.find(f => f.agent === 'opencode').title, 'Conversa OC');
    assert.deepEqual(listOnDisk(home, seen), []);
    fs.rmSync(home, { recursive: true, force: true });
});

test('versão do original: muda com o arquivo; sem fonte, null', () => {
    const { transcriptStamp } = require('../../scripts/agents/transcript');
    const home = fixture();
    const a = transcriptStamp('claude', 'clau-cli', home);
    assert.equal(typeof a, 'number');
    fs.utimesSync(path.join(home, '.claude', 'projects', '-root', 'clau-cli.jsonl'), new Date(), new Date(Date.now() + 5000));
    assert.notEqual(transcriptStamp('claude', 'clau-cli', home), a);
    assert.equal(typeof transcriptStamp('codex', 'code-1', home), 'number');
    assert.equal(transcriptStamp('opencode', 'oc-1', home), 5);
    assert.equal(transcriptStamp('claude', 'nao-existe', home), null);
    assert.equal(transcriptStamp('agy', 'x-1234', home), null);
    fs.rmSync(home, { recursive: true, force: true });
});
