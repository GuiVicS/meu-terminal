/**
 * remote/audit.js
 * One row per tool call made through the Claude bridge: when, which client, which tool, the
 * arguments (cut short, secrets masked, file contents replaced by their size), the outcome
 * and how long it took. Shown in /admin → Ponte com o Claude.
 */
const MAX_ARGS_CHARS = 2000;
const KEEP_ROWS = 5000;
// Arguments that carry content, not intent: logged as their size only
const BULKY_ARGS = new Set(['content', 'data_base64', 'body', 'text']);

class RemoteAudit {
    /** @param {{ db: import('node:sqlite').DatabaseSync, mask?: (s: string) => string, now?: () => number }} opts */
    constructor({ db, mask = s => s, now = Date.now }) {
        this.db = db;
        this.mask = mask;
        this.now = now;
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS remote_audit (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                at INTEGER NOT NULL,
                client_id TEXT,
                tool TEXT NOT NULL,
                args TEXT,
                ok INTEGER NOT NULL,
                exit_code INTEGER,
                duration_ms INTEGER,
                output_bytes INTEGER,
                note TEXT
            );
        `);
        this.inserts = 0;
    }

    summarizeArgs(args) {
        const out = {};
        for (const [k, v] of Object.entries(args || {})) {
            if (BULKY_ARGS.has(k) && typeof v === 'string' && v.length > 200) out[k] = `<${v.length} caracteres>`;
            else out[k] = v;
        }
        const json = this.mask(JSON.stringify(out));
        return json.length > MAX_ARGS_CHARS ? `${json.slice(0, MAX_ARGS_CHARS)}…` : json;
    }

    /**
     * @param {{clientId?: string, tool: string, args?: object, ok: boolean, exitCode?: number|null,
     *   durationMs?: number, outputBytes?: number, note?: string}} entry
     */
    record(entry) {
        this.db.prepare(`INSERT INTO remote_audit (at, client_id, tool, args, ok, exit_code, duration_ms, output_bytes, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            this.now(), entry.clientId || null, entry.tool, this.summarizeArgs(entry.args), entry.ok ? 1 : 0,
            Number.isInteger(entry.exitCode) ? entry.exitCode : null, entry.durationMs ?? null,
            entry.outputBytes ?? null, entry.note ? String(entry.note).slice(0, 300) : null,
        );
        if (++this.inserts % 200 === 0) {
            this.db.prepare('DELETE FROM remote_audit WHERE id <= (SELECT MAX(id) FROM remote_audit) - ?').run(KEEP_ROWS);
        }
    }

    list({ limit = 50, offset = 0, tool } = {}) {
        const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
        const off = Math.max(Number(offset) || 0, 0);
        const rows = tool
            ? this.db.prepare('SELECT * FROM remote_audit WHERE tool = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(String(tool), lim, off)
            : this.db.prepare('SELECT * FROM remote_audit ORDER BY id DESC LIMIT ? OFFSET ?').all(lim, off);
        return rows.map(r => ({
            id: r.id, at: r.at, clientId: r.client_id, tool: r.tool, args: r.args, ok: !!r.ok,
            exitCode: r.exit_code, durationMs: r.duration_ms, outputBytes: r.output_bytes, note: r.note,
        }));
    }
}

module.exports = { RemoteAudit };
