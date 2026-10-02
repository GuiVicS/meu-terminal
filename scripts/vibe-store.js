/**
 * vibe-store.js
 * Vibecoding projects: one row per project (name, folder, kind, description) plus which agent
 * tab has been opened for it, one per agent used - so "trocar agente" keeps each agent's own
 * conversation instead of replacing it - and the shared preview/files tabs. This is what backs
 * "Abrir projeto anterior" and the agent switcher, both specific to vibecoding (see vibe.js).
 * Shares the SQLite connection opened by SessionStore.
 */
const crypto = require('crypto');

const MAX_NAME = 80;
const MAX_DESC = 4000;

class VibeStore {
    /** @param {import('node:sqlite').DatabaseSync} db */
    constructor(db) {
        this.db = db;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS vibe_projects (
                id             TEXT PRIMARY KEY,
                name           TEXT NOT NULL,
                folder         TEXT NOT NULL UNIQUE,
                kind           TEXT NOT NULL,
                description    TEXT NOT NULL DEFAULT '',
                git            INTEGER NOT NULL DEFAULT 1,
                browser_tab_id TEXT,
                files_tab_id   TEXT,
                agents_json    TEXT NOT NULL DEFAULT '{}', -- { "<agent>": { tabId, kind, lastUsedAt } }
                created_at     INTEGER NOT NULL,
                updated_at     INTEGER NOT NULL
            );
        `);
    }

    row(r) {
        if (!r) return null;
        let agents = {};
        try {
            const parsed = JSON.parse(r.agents_json);
            if (parsed && typeof parsed === 'object') agents = parsed;
        } catch { /* corrupt row: treat as no agent tabs yet */ }
        return {
            id: r.id, name: r.name, folder: r.folder, kind: r.kind, description: r.description,
            git: !!r.git, browserTabId: r.browser_tab_id || null, filesTabId: r.files_tab_id || null,
            agents, createdAt: r.created_at, updatedAt: r.updated_at,
        };
    }

    list() {
        return this.db.prepare('SELECT * FROM vibe_projects ORDER BY updated_at DESC').all().map(r => this.row(r));
    }

    get(id) {
        return this.row(this.db.prepare('SELECT * FROM vibe_projects WHERE id = ?').get(id));
    }

    byFolder(folder) {
        return this.row(this.db.prepare('SELECT * FROM vibe_projects WHERE folder = ?').get(folder));
    }

    /** The project a tab belongs to (its agent tab, preview or files tab), or null. */
    byTab(tabId) {
        if (!tabId) return null;
        for (const p of this.list()) {
            if (p.browserTabId === tabId || p.filesTabId === tabId) return p;
            if (Object.values(p.agents).some(a => a.tabId === tabId)) return p;
        }
        return null;
    }

    create({ name, folder, kind, description, git }) {
        const id = crypto.randomUUID();
        const now = Date.now();
        this.db.prepare(`INSERT INTO vibe_projects (id, name, folder, kind, description, git, agents_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`)
            .run(id, String(name).slice(0, MAX_NAME), folder, kind, String(description || '').slice(0, MAX_DESC), git ? 1 : 0, now, now);
        return this.get(id);
    }

    /** Remembers which tab hosts `agent`'s conversation for this project. */
    setAgentTab(id, agent, { tabId, kind }) {
        const p = this.get(id);
        if (!p) return null;
        p.agents[agent] = { tabId, kind, lastUsedAt: Date.now() };
        this.db.prepare('UPDATE vibe_projects SET agents_json = ?, updated_at = ? WHERE id = ?')
            .run(JSON.stringify(p.agents), Date.now(), id);
        return this.get(id);
    }

    setTabs(id, { browserTabId, filesTabId } = {}) {
        const p = this.get(id);
        if (!p) return null;
        this.db.prepare('UPDATE vibe_projects SET browser_tab_id = COALESCE(?, browser_tab_id), files_tab_id = COALESCE(?, files_tab_id), updated_at = ? WHERE id = ?')
            .run(browserTabId || null, filesTabId || null, Date.now(), id);
        return this.get(id);
    }

    /** The agent most recently used for this project, or null if none yet. */
    lastAgent(id) {
        const p = this.get(id);
        if (!p) return null;
        const entries = Object.entries(p.agents);
        if (!entries.length) return null;
        entries.sort((a, b) => (b[1].lastUsedAt || 0) - (a[1].lastUsedAt || 0));
        return entries[0][0];
    }

    remove(id) {
        this.db.prepare('DELETE FROM vibe_projects WHERE id = ?').run(id);
    }
}

module.exports = VibeStore;
