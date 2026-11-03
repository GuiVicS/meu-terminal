/**
 * agent-store.js
 * SQLite persistence for agent UI sessions: session metadata, the ordered event log
 * (monotonic seq per session, used for replay after reconnecting) and permission decisions.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SESSION_COLUMNS = ['title', 'status', 'mode', 'model', 'acp_session_id', 'capabilities',
    'updated_at', 'closed_at', 'last_seq', 'route', 'route_model', 'account', 'pending', 'from_disk'];

function parseJson(text, fallback) {
    if (text == null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

class AgentStore {
    /** @param {string} file - database file (shared with session-store.js is fine: WAL mode) */
    constructor(file) {
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS agent_sessions (
                id              TEXT PRIMARY KEY,       -- our UUID (stable across agent restarts)
                agent           TEXT NOT NULL,          -- registry id: claude | opencode | codex...
                cwd             TEXT NOT NULL,
                title           TEXT,
                status          TEXT NOT NULL,          -- see events.js STATES, plus 'closed'
                mode            TEXT,
                model           TEXT,
                acp_session_id  TEXT,                   -- the agent's own id (for resume/load)
                capabilities    TEXT,                   -- JSON
                last_seq        INTEGER NOT NULL DEFAULT 0,
                created_at      INTEGER NOT NULL,
                updated_at      INTEGER NOT NULL,
                closed_at       INTEGER
            );
            CREATE TABLE IF NOT EXISTS agent_events (
                session_id  TEXT NOT NULL,
                seq         INTEGER NOT NULL,
                type        TEXT NOT NULL,
                at          INTEGER NOT NULL,
                data        TEXT NOT NULL,              -- JSON
                PRIMARY KEY (session_id, seq)
            );
            CREATE TABLE IF NOT EXISTS agent_permissions (
                id           TEXT PRIMARY KEY,
                session_id   TEXT NOT NULL,
                request      TEXT NOT NULL,             -- JSON (permission.request data)
                status       TEXT NOT NULL,             -- pending | answered | expired
                outcome      TEXT,                      -- selected | cancelled
                option_id    TEXT,
                answered_by  TEXT,                      -- who approved (audit)
                created_at   INTEGER NOT NULL,
                answered_at  INTEGER
            );
            CREATE INDEX IF NOT EXISTS agent_permissions_pending ON agent_permissions(session_id, status);
        `);
        // route: por onde o agente fala com o modelo (scripts/addon-services.js ROUTES); null = direto
        const columns = new Set(this.db.prepare('PRAGMA table_info(agent_sessions)').all().map(c => c.name));
        if (!columns.has('route')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN route TEXT');
        // route_model: modelo fixado na rota (troca automática ao acabar o limite do Claude)
        if (!columns.has('route_model')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN route_model TEXT');
        // account: conta extra do Claude Code (scripts/claude-accounts.js); null = a principal
        if (!columns.has('account')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN account TEXT');
        // Conversas que a pessoa iniciou, ligadas à sessão do agente. O histórico do agente também traz
        // o que ele mesmo dispara (subagentes, "claude -p", plugins), sem marca que separe: a lista
        // lateral mostra só o que está aqui. session_id: a sessão do MeuTerminal (null = terminal).
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_conversations (
                agent          TEXT NOT NULL,
                acp_session_id TEXT NOT NULL,
                session_id     TEXT,
                cwd            TEXT,
                title          TEXT,
                origin         TEXT NOT NULL DEFAULT 'ui',
                created_at     INTEGER NOT NULL,
                updated_at     INTEGER NOT NULL,
                PRIMARY KEY (agent, acp_session_id)
            );
            INSERT OR IGNORE INTO agent_conversations (agent, acp_session_id, session_id, cwd, title, origin, created_at, updated_at)
                SELECT agent, acp_session_id, id, cwd, title, 'ui', created_at, updated_at
                FROM agent_sessions WHERE acp_session_id IS NOT NULL;
        `);
        // pending: modo e opções escolhidos antes de o agente subir (aplicados ao subir)
        if (!columns.has('pending')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN pending TEXT');
        if (!columns.has('from_disk')) this.db.exec('ALTER TABLE agent_sessions ADD COLUMN from_disk INTEGER');
        // Cópia para ver as conversas de fora do app; stamp diz de que versão do original ela é
        this.db.exec(`CREATE TABLE IF NOT EXISTS agent_transcripts (
            agent TEXT NOT NULL, acp_session_id TEXT NOT NULL, stamp REAL, events TEXT NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY (agent, acp_session_id))`);
        const conv = new Set(this.db.prepare('PRAGMA table_info(agent_conversations)').all().map(c => c.name));
        // custom_title: nome dado pela pessoa (o agente não troca); archived_at: fora da lista principal;
        // unread: o agente terminou ou pediu algo e a pessoa ainda não viu
        if (!conv.has('custom_title')) {
            this.db.exec(`
                ALTER TABLE agent_conversations ADD COLUMN custom_title TEXT;
                ALTER TABLE agent_conversations ADD COLUMN archived_at INTEGER;
                ALTER TABLE agent_conversations ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;
            `);
        }
        if (!conv.has('has_messages')) {
            // has_messages: já houve mensagem (conversa aberta e nunca usada não entra na lista)
            // deleted_at: apagada pela pessoa (o índice do disco não traz de volta)
            this.db.exec(`
                ALTER TABLE agent_conversations ADD COLUMN has_messages INTEGER NOT NULL DEFAULT 0;
                ALTER TABLE agent_conversations ADD COLUMN deleted_at INTEGER;
                CREATE INDEX IF NOT EXISTS agent_conversations_list ON agent_conversations (agent, deleted_at, has_messages, updated_at);
                UPDATE agent_conversations SET has_messages = 1 WHERE EXISTS (
                    SELECT 1 FROM agent_events e JOIN agent_sessions s ON e.session_id = s.id
                    WHERE s.acp_session_id = agent_conversations.acp_session_id AND s.agent = agent_conversations.agent AND e.type = 'message.user');
                UPDATE agent_conversations SET title = (
                    SELECT substr(json_extract(e.data, '$.text'), 1, 80) FROM agent_events e JOIN agent_sessions s ON e.session_id = s.id
                    WHERE s.acp_session_id = agent_conversations.acp_session_id AND s.agent = agent_conversations.agent AND e.type = 'message.user'
                    ORDER BY e.seq LIMIT 1) WHERE title IS NULL;
            `);
        }
    }

    // ---------- conversas iniciadas pela pessoa ----------

    saveConversation({ agent, acpSessionId, sessionId = null, cwd = null, title = null, origin = 'ui' }) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO agent_conversations (agent, acp_session_id, session_id, cwd, title, origin, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (agent, acp_session_id) DO UPDATE SET
                session_id = COALESCE(excluded.session_id, session_id), title = COALESCE(excluded.title, title), updated_at = excluded.updated_at`)
            .run(agent, acpSessionId, sessionId, cwd, title, origin, now, now);
    }

    getConversation(agent, acpSessionId) {
        return this.db.prepare('SELECT * FROM agent_conversations WHERE agent = ? AND acp_session_id = ?').get(agent, acpSessionId) || null;
    }

    /** Pastas usadas por último, da mais recente para a mais antiga. */
    recentFolders({ agent = '', limit = 30 } = {}) {
        return this.db.prepare(`SELECT cwd, MAX(updated_at) AS at FROM agent_conversations
            WHERE deleted_at IS NULL AND has_messages = 1 AND cwd IS NOT NULL AND cwd <> '' AND (? = '' OR agent = ?)
            GROUP BY cwd ORDER BY at DESC LIMIT ?`).all(agent, agent, limit).map(r => r.cwd);
    }

    getTranscript(agent, acpSessionId) {
        const row = this.db.prepare('SELECT stamp, events FROM agent_transcripts WHERE agent = ? AND acp_session_id = ?').get(agent, acpSessionId);
        return row ? { stamp: row.stamp, events: parseJson(row.events, []) } : null;
    }

    saveTranscript(agent, acpSessionId, stamp, events) {
        this.db.prepare(`INSERT INTO agent_transcripts (agent, acp_session_id, stamp, events, updated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (agent, acp_session_id) DO UPDATE SET stamp = excluded.stamp, events = excluded.events, updated_at = excluded.updated_at`)
            .run(agent, acpSessionId, stamp, JSON.stringify(events), Date.now());
    }

    /** Conversas da lista que podem ter conteúdo fora do app. */
    conversationsToArchive() {
        return this.db.prepare('SELECT agent, acp_session_id FROM agent_conversations WHERE has_messages = 1 AND deleted_at IS NULL').all();
    }

    /** Apagada: some da lista e o índice do disco não a traz de volta. */
    deleteConversation(agent, acpSessionId) {
        this.db.prepare('DELETE FROM agent_transcripts WHERE agent = ? AND acp_session_id = ?').run(agent, acpSessionId);
        this.db.prepare(`INSERT INTO agent_conversations (agent, acp_session_id, origin, created_at, updated_at, deleted_at)
            VALUES (?, ?, 'ui', ?, ?, ?) ON CONFLICT (agent, acp_session_id) DO UPDATE SET deleted_at = excluded.deleted_at`)
            .run(agent, acpSessionId, Date.now(), Date.now(), Date.now());
    }

    /** Houve mensagem: entra na lista e sobe para o topo. O título inicial é a primeira mensagem. */
    touchConversation(agent, acpSessionId, firstText = null) {
        // Mandar mensagem numa conversa arquivada a traz de volta
        this.db.prepare(`UPDATE agent_conversations SET has_messages = 1, updated_at = ?, archived_at = NULL, unread = 0,
            title = COALESCE(title, ?) WHERE agent = ? AND acp_session_id = ?`)
            .run(Date.now(), firstText ? String(firstText).slice(0, 80) : null, agent, acpSessionId);
    }

    /** O agente terminou ou pediu permissão: fica não lida até a pessoa olhar. */
    markUnread(agent, acpSessionId) {
        this.db.prepare('UPDATE agent_conversations SET unread = 1, updated_at = ? WHERE agent = ? AND acp_session_id = ?').run(Date.now(), agent, acpSessionId);
    }

    /** Veio do disco (aberta fora do app): só acrescenta; nunca revive uma apagada. */
    indexConversation({ agent, acpSessionId, cwd = null, title = null, updatedAt = Date.now() }) {
        this.db.prepare(`INSERT INTO agent_conversations (agent, acp_session_id, cwd, title, origin, has_messages, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'terminal', 1, ?, ?)
            ON CONFLICT (agent, acp_session_id) DO UPDATE SET has_messages = 1, title = COALESCE(title, excluded.title),
                updated_at = MAX(updated_at, excluded.updated_at) WHERE deleted_at IS NULL`)
            .run(agent, acpSessionId, cwd, title, updatedAt, updatedAt);
    }

    /** A lista lateral: uma consulta só, sem depender de agente nem de pasta (a pasta é filtro opcional). */
    listConversations({ agent, cwd = null, archived = false, limit = 300 }) {
        const where = `agent = ? AND deleted_at IS NULL AND has_messages = 1 AND archived_at IS ${archived ? 'NOT NULL' : 'NULL'}`;
        const rows = cwd
            ? this.db.prepare(`SELECT * FROM agent_conversations WHERE ${where} AND cwd = ? ORDER BY updated_at DESC LIMIT ?`).all(agent, cwd, limit)
            : this.db.prepare(`SELECT * FROM agent_conversations WHERE ${where} ORDER BY updated_at DESC LIMIT ?`).all(agent, limit);
        return rows.map(r => ({ ...r, title: r.custom_title || r.title }));
    }

    /** Nome, arquivar, lida/não lida. Conversa conhecida só de nome (índice) também vale. */
    updateConversation(agent, acpSessionId, { title, archived, unread }) {
        const set = [];
        const values = [];
        if (title !== undefined) { set.push('custom_title = ?'); values.push(title); }
        if (archived !== undefined) { set.push('archived_at = ?'); values.push(archived ? Date.now() : null); }
        if (unread !== undefined) { set.push('unread = ?'); values.push(unread ? 1 : 0); }
        if (!set.length) return;
        this.db.prepare(`UPDATE agent_conversations SET ${set.join(', ')} WHERE agent = ? AND acp_session_id = ?`).run(...values, agent, acpSessionId);
    }

    /** Sessões do app ligadas a uma conversa. */
    sessionIdsForConversation(agent, acpSessionId) {
        return this.db.prepare('SELECT id FROM agent_sessions WHERE agent = ? AND acp_session_id = ?').all(agent, acpSessionId).map(r => r.id);
    }

    /** A sessão do app ligada a uma conversa do agente (a mais recente). */
    sessionForConversation(agent, acpSessionId) {
        const row = this.db.prepare('SELECT id FROM agent_sessions WHERE agent = ? AND acp_session_id = ? ORDER BY updated_at DESC LIMIT 1').get(agent, acpSessionId);
        return row ? this.getSession(row.id) : null;
    }

    /** Já há mensagens guardadas nesta sessão? (senão, o conteúdo vem do arquivo do agente) */
    hasUserMessages(sessionId) {
        return !!this.db.prepare("SELECT 1 FROM agent_events WHERE session_id = ? AND type = 'message.user' LIMIT 1").get(sessionId);
    }

    /** Conversas registradas sem mensagem conhecida (índice confere se têm arquivo no agente). */
    conversationsWithoutMessages() {
        return this.db.prepare('SELECT agent, acp_session_id FROM agent_conversations WHERE has_messages = 0 AND deleted_at IS NULL').all();
    }

    /** O que o agente ofereceu da última vez: o seletor funciona antes de ele subir. */
    lastCapabilities(agent) {
        const row = this.db.prepare("SELECT capabilities FROM agent_sessions WHERE agent = ? AND capabilities IS NOT NULL AND capabilities != '{}' ORDER BY updated_at DESC LIMIT 1").get(agent);
        return row ? parseJson(row.capabilities, {}) : {};
    }

    // ---------- sessions ----------

    insertSession({ id, agent, cwd, title = null, status = 'starting', mode = null, model = null, route = null }) {
        const now = Date.now();
        this.db.prepare(`INSERT INTO agent_sessions (id, agent, cwd, title, status, mode, model, route, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, agent, cwd, title, status, mode, model, route, now, now);
        return this.getSession(id);
    }

    getSession(id) {
        const row = this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id);
        return row ? { ...row, capabilities: parseJson(row.capabilities, {}) } : null;
    }

    listSessions({ includeClosed = false, limit = 50 } = {}) {
        const rows = includeClosed
            ? this.db.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC LIMIT ?').all(limit)
            : this.db.prepare(`SELECT * FROM agent_sessions WHERE status != 'closed' ORDER BY updated_at DESC LIMIT ?`).all(limit);
        return rows.map(row => ({ ...row, capabilities: parseJson(row.capabilities, {}) }));
    }

    /** Updates whitelisted columns only. */
    updateSession(id, fields) {
        const keys = Object.keys(fields).filter(k => SESSION_COLUMNS.includes(k));
        if (!keys.length) return this.getSession(id);
        const values = keys.map(k => (k === 'capabilities' || (k === 'pending' && fields[k]) ? JSON.stringify(fields[k]) : fields[k]));
        if (!keys.includes('updated_at')) {
            keys.push('updated_at');
            values.push(Date.now());
        }
        this.db.prepare(`UPDATE agent_sessions SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`)
            .run(...values, id);
        return this.getSession(id);
    }

    // ---------- events ----------

    /**
     * Appends an event and returns the full envelope. seq comes from agent_sessions.last_seq
     * inside a transaction, so it stays gap-free and monotonic even across server restarts.
     */
    appendEvent(sessionId, type, data) {
        const at = Date.now();
        let seq;
        this.transaction(() => {
            this.db.prepare('UPDATE agent_sessions SET last_seq = last_seq + 1, updated_at = ? WHERE id = ?').run(at, sessionId);
            const row = this.db.prepare('SELECT last_seq FROM agent_sessions WHERE id = ?').get(sessionId);
            if (!row) throw new Error(`Unknown agent session ${sessionId}`);
            seq = row.last_seq;
            this.db.prepare('INSERT INTO agent_events (session_id, seq, type, at, data) VALUES (?, ?, ?, ?, ?)')
                .run(sessionId, seq, type, at, JSON.stringify(data));
        });
        return { sessionId, seq, type, at, data };
    }

    /** Events after `sinceSeq` (exclusive), oldest first. */
    eventsSince(sessionId, sinceSeq = 0, limit = 5000) {
        return this.db.prepare(`SELECT seq, type, at, data FROM agent_events
            WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?`).all(sessionId, sinceSeq, limit)
            .map(row => ({ sessionId, seq: row.seq, type: row.type, at: row.at, data: parseJson(row.data, {}) }));
    }

    /** seq de cada mensagem do usuário, em ordem: é o que divide a conversa em turnos. */
    turnStarts(sessionId) {
        return this.db.prepare("SELECT seq FROM agent_events WHERE session_id = ? AND type = 'message.user' ORDER BY seq").all(sessionId).map(r => r.seq);
    }

    /** Eventos de `from` (inclusive; null = início) até `to` (exclusive; null = fim). */
    eventsRange(sessionId, from = null, to = null) {
        return this.db.prepare(`SELECT seq, type, at, data FROM agent_events
            WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq`).all(sessionId, from ?? 0, to ?? Number.MAX_SAFE_INTEGER)
            .map(row => ({ sessionId, seq: row.seq, type: row.type, at: row.at, data: parseJson(row.data, {}) }));
    }

    /** O último evento de cada tipo que não aparece na conversa, antes de `before`: o estado da tela. */
    latestState(sessionId, before = null) {
        return this.db.prepare(`SELECT MAX(seq) AS seq, type, at, data FROM agent_events
            WHERE session_id = ? AND seq < ? AND type NOT LIKE 'message.%' AND type NOT LIKE 'tool.%' AND type NOT LIKE 'thought.%'
              AND type NOT LIKE 'plan.%' AND type NOT LIKE 'permission.%' AND type NOT LIKE 'subagent.%'
              AND type NOT IN ('notice', 'error', 'raw', 'session.end')
            GROUP BY type ORDER BY seq`).all(sessionId, before ?? Number.MAX_SAFE_INTEGER)
            .map(row => ({ sessionId, seq: row.seq, type: row.type, at: row.at, data: parseJson(row.data, {}) }));
    }

    /** Só os eventos que o painel lateral usa, já sem as ferramentas que não contam para ele. */
    sideEvents(sessionId) {
        return this.db.prepare(`SELECT seq, type, data FROM agent_events WHERE session_id = ? AND (
                type IN ('plan.update', 'commands.update', 'usage.update') OR type LIKE 'subagent.%'
                OR (type IN ('tool.start', 'tool.result') AND (json_type(data, '$.diffs') = 'array' OR json_extract(data, '$.parentToolId') IS NOT NULL))
            ) ORDER BY seq`).all(sessionId)
            .map(row => ({ seq: row.seq, type: row.type, data: parseJson(row.data, {}) }));
    }

    lastSeq(sessionId) {
        return this.db.prepare('SELECT MAX(seq) AS seq FROM agent_events WHERE session_id = ?').get(sessionId)?.seq || 0;
    }

    // ---------- permissions ----------

    insertPermission({ id, sessionId, request }) {
        this.db.prepare(`INSERT INTO agent_permissions (id, session_id, request, status, created_at)
            VALUES (?, ?, ?, 'pending', ?)`).run(id, sessionId, JSON.stringify(request), Date.now());
    }

    /** Marks a pending permission as answered. Returns false if it was not pending anymore. */
    answerPermission(id, { outcome, optionId = null, answeredBy = null }) {
        const result = this.db.prepare(`UPDATE agent_permissions SET status = 'answered', outcome = ?, option_id = ?,
            answered_by = ?, answered_at = ? WHERE id = ? AND status = 'pending'`)
            .run(outcome, optionId, answeredBy, Date.now(), id);
        return result.changes > 0;
    }

    pendingPermissions(sessionId) {
        return this.db.prepare(`SELECT id, request, created_at FROM agent_permissions
            WHERE session_id = ? AND status = 'pending' ORDER BY created_at`).all(sessionId)
            .map(row => ({ id: row.id, request: parseJson(row.request, {}), createdAt: row.created_at }));
    }

    /** Pending permissions of a session whose agent died can never be answered. */
    expirePermissions(sessionId) {
        this.db.prepare(`UPDATE agent_permissions SET status = 'expired', answered_at = ?
            WHERE session_id = ? AND status = 'pending'`).run(Date.now(), sessionId);
    }

    /**
     * After a server restart no agent process survives: sessions that were running are
     * marked stopped (they can be resumed) and their pending permissions expire.
     */
    recoverAfterRestart() {
        const now = Date.now();
        this.transaction(() => {
            this.db.prepare(`UPDATE agent_permissions SET status = 'expired', answered_at = ? WHERE status = 'pending'`).run(now);
            this.db.prepare(`UPDATE agent_sessions SET status = 'stopped', updated_at = ?
                WHERE status NOT IN ('closed', 'stopped')`).run(now);
        });
    }

    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            fn();
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    close() {
        this.db.close();
    }
}

module.exports = AgentStore;
