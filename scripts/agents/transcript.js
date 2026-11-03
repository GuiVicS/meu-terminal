/**
 * transcript.js
 * Ler conversas sem ligar o agente: o protocolo ACP só entrega o texto com o agente rodando, então
 * cada formato é lido direto de onde o agente guarda. Só leitura. Formato desconhecido: lista vazia
 * (a conversa ainda pode ser retomada; quem responde por ela é o próprio agente).
 *  - listOnDisk: as conversas abertas fora do app (terminal), para o índice no SQL.
 *  - readTranscript: o conteúdo, como os mesmos eventos do chat (não é gravado em lugar nenhum).
 */
const fs = require('fs');
const path = require('path');

const CLAUDE_KINDS = { Bash: 'bash', Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'write', NotebookEdit: 'edit', Grep: 'search', Glob: 'search', WebFetch: 'fetch', WebSearch: 'fetch', Task: 'task', Agent: 'task' };

const clean = text => String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(local-command-[\w-]+|command-[\w-]+)>[\s\S]*?<\/\1>/g, '').trim();
const jsonLines = file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

function walk(dir, depth, onFile) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth > 0) walk(p, depth - 1, onFile);
        else if (e.isFile() && e.name.endsWith('.jsonl')) onFile(p);
    }
}

function head(file, max = 65536) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(max);
        const n = fs.readSync(fd, buf, 0, max, 0);
        return buf.subarray(0, n).toString('utf8').split('\n').slice(0, -1)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } finally {
        fs.closeSync(fd);
    }
}

const firstUserText = lines => {
    for (const l of lines) {
        if (l.type !== 'user' || l.isMeta || l.isSidechain) continue;
        const c = l.message?.content;
        const text = clean(typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ') : ''));
        if (text) return text.slice(0, 80);
    }
    return null;
};

function openDb(home) {
    const { DatabaseSync } = require('node:sqlite');
    const file = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    return fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
}

/** Conversas abertas fora do app. seen: arquivo -> mtime já visto (não relê o que não mudou). */
function listOnDisk(home, seen = new Map()) {
    const out = [];
    const changed = file => {
        const mtime = fs.statSync(file).mtimeMs;
        if (seen.get(file) === mtime) return null;
        seen.set(file, mtime);
        return mtime;
    };
    // Claude Code: só a sessão interativa; "sdk-*" é o que ele dispara sozinho (subagentes, -p, plugins)
    walk(path.join(home, '.claude', 'projects'), 1, file => {
        try {
            const mtime = changed(file);
            if (mtime === null) return;
            const lines = head(file);
            const id = path.basename(file, '.jsonl');
            if (lines.find(l => l.entrypoint)?.entrypoint !== 'cli') return;
            const said = firstUserText(lines);
            if (!said) return; // só comandos do sistema: nunca houve conversa
            const named = [...lines].reverse().find(l => l.aiTitle || l.customTitle);
            out.push({ agent: 'claude', acpSessionId: id, cwd: lines.find(l => l.cwd)?.cwd || null,
                title: named?.customTitle || named?.aiTitle || said, updatedAt: mtime });
        } catch { /* arquivo sumiu ou ilegível */ }
    });
    // Codex: a interface de terminal, fora de subagente
    walk(path.join(home, '.codex', 'sessions'), 4, file => {
        try {
            const mtime = changed(file);
            if (mtime === null) return;
            const meta = head(file).find(l => l.type === 'session_meta')?.payload;
            if (meta?.originator !== 'codex-tui' || typeof meta.source !== 'string' || !meta.id) return;
            out.push({ agent: 'codex', acpSessionId: meta.id, cwd: meta.cwd || null, title: null, updatedAt: mtime });
        } catch { /* idem */ }
    });
    // OpenCode: sessões raiz (subagentes têm parent_id)
    let db = null;
    try {
        db = openDb(home);
        for (const s of db ? db.prepare('SELECT id, directory, title, time_updated FROM session WHERE parent_id IS NULL AND time_archived IS NULL').all() : []) {
            const key = `opencode:${s.id}`;
            if (seen.get(key) === s.time_updated) continue;
            seen.set(key, s.time_updated);
            out.push({ agent: 'opencode', acpSessionId: s.id, cwd: s.directory || null, title: s.title || null, updatedAt: s.time_updated });
        }
    } catch { /* outra versão do banco */ } finally {
        try { db?.close(); } catch { /* já fechado */ }
    }
    return out;
}

function pushAnswer(events, text) {
    if (!text) return;
    events.push({ type: 'message.assistant.delta', data: { text } }, { type: 'message.assistant.done', data: { stopReason: 'end_turn' } });
}

function pushTool(events, id, kind, title, failed = false) {
    events.push({ type: 'tool.start', data: { toolId: id, kind, title: String(title || kind).slice(0, 200) } },
        { type: 'tool.result', data: { toolId: id, status: failed ? 'failed' : 'completed' } });
}

function claudeEvents(home, id) {
    let file = null;
    walk(path.join(home, '.claude', 'projects'), 1, f => { if (!file && path.basename(f, '.jsonl') === id) file = f; });
    if (!file) return [];
    const events = [];
    for (const l of jsonLines(file)) {
        if (l.isSidechain || l.isMeta) continue;
        const c = l.message?.content;
        if (l.type === 'user') {
            const text = clean(typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''));
            if (text) events.push({ type: 'message.user', data: { text } });
        } else if (l.type === 'assistant' && Array.isArray(c)) {
            for (const b of c) {
                if (b.type === 'text') pushAnswer(events, b.text);
                else if (b.type === 'tool_use') {
                    const input = b.input || {};
                    pushTool(events, b.id, CLAUDE_KINDS[b.name] || 'other', input.file_path || input.command || input.pattern || input.description || b.name);
                }
            }
        }
    }
    return events;
}

function codexEvents(home, id) {
    let file = null;
    walk(path.join(home, '.codex', 'sessions'), 4, f => { if (!file && f.endsWith(`${id}.jsonl`)) file = f; });
    if (!file) return [];
    const events = [];
    for (const l of jsonLines(file)) {
        const p = l.payload;
        if (l.type !== 'response_item' || !p) continue;
        if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
            const text = (p.content || []).filter(b => typeof b.text === 'string').map(b => b.text).join('\n').trim();
            if (!text || (p.role === 'user' && /^<[\w_-]+>/.test(text))) continue; // contexto que o Codex injeta
            if (p.role === 'user') events.push({ type: 'message.user', data: { text } });
            else pushAnswer(events, text);
        } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
            pushTool(events, p.call_id || p.id, /shell|exec/.test(p.name || '') ? 'bash' : 'other', p.name);
        }
    }
    return events;
}

function openCodeEvents(home, id) {
    const db = openDb(home);
    if (!db) return [];
    try {
        const events = [];
        const parts = db.prepare('SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id');
        for (const m of db.prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id').all(id)) {
            const role = JSON.parse(m.data).role;
            for (const pr of parts.all(m.id)) {
                const p = JSON.parse(pr.data);
                if (p.type === 'text' && p.text && !p.synthetic) {
                    if (role === 'user') events.push({ type: 'message.user', data: { text: p.text } });
                    else pushAnswer(events, p.text);
                } else if (p.type === 'tool') {
                    pushTool(events, p.callID || p.id, 'other', p.state?.title || p.tool, p.state?.status === 'error');
                }
            }
        }
        return events;
    } finally {
        db.close();
    }
}

const READERS = { claude: claudeEvents, codex: codexEvents, opencode: openCodeEvents };

/** O conteúdo da conversa, como eventos do chat (os mais recentes, se for enorme). */
function readTranscript(agent, id, home, { limit = 1500 } = {}) {
    if (!READERS[agent] || typeof id !== 'string' || !/^[\w-]{4,120}$/.test(id)) return [];
    try {
        return READERS[agent](home, id).slice(-limit);
    } catch {
        return [];
    }
}

module.exports = { readTranscript, listOnDisk };
