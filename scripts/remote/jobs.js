/**
 * remote/jobs.js
 * Long-running commands from the Claude bridge (installs, builds, model downloads) that must not
 * hold the conversation: started in the background, output appended to a log file, status in
 * SQLite. Claude polls job_status / job_output; with notify, the phone gets a push at the end.
 * Same process-group kill as the webhooks; jobs left running by a restart are marked as such.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { killGroup } = require('../process-runner');

const DEFAULT_MAX_RUNNING = 4;
const DEFAULT_TIMEOUT_MIN = 6 * 60;
const MAX_READ_BYTES = 48 * 1024;
const KEEP_JOBS = 200;

function alive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

class RemoteJobs {
    /**
     * @param {object} opts
     * @param {import('node:sqlite').DatabaseSync} opts.db
     * @param {string} opts.dir - where the logs go
     * @param {import('./exec').RemoteExec} opts.exec
     * @param {(job: object) => void} [opts.onFinish]
     * @param {number} [opts.maxRunning]
     */
    constructor({ db, dir, exec, onFinish = () => {}, maxRunning = DEFAULT_MAX_RUNNING, log = () => {} }) {
        this.db = db;
        this.dir = dir;
        this.exec = exec;
        this.onFinish = onFinish;
        this.maxRunning = maxRunning;
        this.log = log;
        this.children = new Map(); // id -> ChildProcess (only jobs started by this process)
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS remote_jobs (
                id TEXT PRIMARY KEY,
                client_id TEXT,
                name TEXT,
                command TEXT NOT NULL,
                cwd TEXT NOT NULL,
                status TEXT NOT NULL,
                exit_code INTEGER,
                pid INTEGER,
                notify INTEGER NOT NULL DEFAULT 0,
                started_at INTEGER NOT NULL,
                finished_at INTEGER
            );
        `);
        this.recoverAfterRestart();
    }

    /** Jobs marked running from a previous server process: still alive (orphan) or gone. */
    recoverAfterRestart() {
        const rows = this.db.prepare(`SELECT * FROM remote_jobs WHERE status = 'running'`).all();
        for (const r of rows) {
            if (!alive(r.pid)) {
                this.db.prepare(`UPDATE remote_jobs SET status = 'interrupted', finished_at = ? WHERE id = ?`).run(Date.now(), r.id);
            }
        }
        if (rows.length) {
            this.orphanTimer = setInterval(() => this.checkOrphans(), 15000);
            this.orphanTimer.unref?.();
        }
    }

    checkOrphans() {
        const rows = this.db.prepare(`SELECT * FROM remote_jobs WHERE status = 'running'`).all().filter(r => !this.children.has(r.id));
        for (const r of rows) {
            if (!alive(r.pid)) {
                this.db.prepare(`UPDATE remote_jobs SET status = 'finished', finished_at = ? WHERE id = ?`).run(Date.now(), r.id);
            }
        }
        if (!rows.length) clearInterval(this.orphanTimer);
    }

    logFile(id) {
        return path.join(this.dir, `${id}.log`);
    }

    running() {
        return this.db.prepare(`SELECT COUNT(*) AS n FROM remote_jobs WHERE status = 'running'`).get().n;
    }

    /**
     * @param {{command: string, cwd?: string, name?: string, clientId?: string, notify?: boolean, timeoutMinutes?: number}} opts
     */
    start({ command, cwd, name, clientId, notify = false, timeoutMinutes }) {
        if (!command || typeof command !== 'string') throw new Error('Comando vazio.');
        if (this.running() >= this.maxRunning) throw new Error(`Já há ${this.maxRunning} jobs rodando. Espere um terminar ou use job_kill.`);
        const dir = this.exec.resolvePath(cwd);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Pasta não existe: ${dir}`);

        const id = crypto.randomBytes(6).toString('hex');
        const file = this.logFile(id);
        const fd = fs.openSync(file, 'a', 0o600);
        let child;
        try {
            child = spawn('bash', ['-lc', command], {
                cwd: dir, env: this.exec.env({ MT_JOB_ID: id }), stdio: ['ignore', fd, fd],
                detached: true, ...this.exec.spawnOptions(),
            });
        } finally {
            fs.closeSync(fd);
        }
        const startedAt = Date.now();
        this.db.prepare(`INSERT INTO remote_jobs (id, client_id, name, command, cwd, status, pid, notify, started_at)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`).run(id, clientId || null, String(name || '').slice(0, 80) || null,
            command.slice(0, 4000), dir, child.pid || null, notify ? 1 : 0, startedAt);
        this.children.set(id, child);

        const minutes = Math.min(Math.max(Number(timeoutMinutes) || DEFAULT_TIMEOUT_MIN, 1), 24 * 60);
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killGroup(child); }, minutes * 60 * 1000);
        timer.unref?.();

        let finished = false;
        const finish = (code, errorMessage) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            this.children.delete(id);
            if (errorMessage) fs.appendFileSync(file, `\n[erro ao iniciar: ${errorMessage}]\n`);
            const killed = this.db.prepare('SELECT status FROM remote_jobs WHERE id = ?').get(id)?.status === 'killed';
            const status = killed ? 'killed' : timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed';
            this.db.prepare('UPDATE remote_jobs SET status = ?, exit_code = ?, finished_at = ? WHERE id = ?')
                .run(status, Number.isInteger(code) ? code : null, Date.now(), id);
            this.log(`remote job ${id}: ${status}`);
            this.prune();
            try { this.onFinish(this.get(id)); } catch { /* push is best-effort */ }
        };
        child.on('error', e => finish(null, e.message));
        child.on('close', code => finish(code));
        child.unref();
        return this.get(id);
    }

    get(id) {
        const r = this.db.prepare('SELECT * FROM remote_jobs WHERE id = ?').get(String(id || ''));
        if (!r) return null;
        let size = 0;
        try { size = fs.statSync(this.logFile(r.id)).size; } catch { /* no output yet */ }
        return {
            id: r.id, name: r.name, command: r.command, cwd: r.cwd, status: r.status, exitCode: r.exit_code,
            pid: r.pid, notify: !!r.notify, clientId: r.client_id, startedAt: r.started_at, finishedAt: r.finished_at,
            durationMs: (r.finished_at || Date.now()) - r.started_at, outputBytes: size,
        };
    }

    list({ limit = 20 } = {}) {
        return this.db.prepare('SELECT id FROM remote_jobs ORDER BY started_at DESC LIMIT ?')
            .all(Math.min(Number(limit) || 20, 100)).map(r => this.get(r.id));
    }

    /**
     * A slice of the log. Without offset: the last `limit` bytes (what's happening now).
     * @returns {{text: string, offset: number, nextOffset: number, size: number}}
     */
    output(id, { offset, limit = MAX_READ_BYTES } = {}) {
        const job = this.get(id);
        if (!job) throw new Error('Job não encontrado.');
        const size = job.outputBytes;
        const len = Math.min(Math.max(Number(limit) || MAX_READ_BYTES, 1), MAX_READ_BYTES);
        const start = offset === undefined || offset === null ? Math.max(0, size - len) : Math.min(Math.max(Number(offset) || 0, 0), size);
        const count = Math.min(len, size - start);
        let text = '';
        if (count > 0) {
            const buf = Buffer.alloc(count);
            const fd = fs.openSync(this.logFile(id), 'r');
            try { fs.readSync(fd, buf, 0, count, start); } finally { fs.closeSync(fd); }
            text = this.exec.mask(buf.toString('utf8'));
        }
        return { text, offset: start, nextOffset: start + count, size };
    }

    kill(id) {
        const job = this.get(id);
        if (!job) throw new Error('Job não encontrado.');
        if (job.status !== 'running') return job;
        this.db.prepare(`UPDATE remote_jobs SET status = 'killed' WHERE id = ?`).run(job.id);
        const child = this.children.get(job.id);
        if (child) killGroup(child);
        else if (job.pid) {
            try { process.kill(-job.pid, 'SIGKILL'); } catch { /* gone */ }
            this.db.prepare('UPDATE remote_jobs SET finished_at = ? WHERE id = ?').run(Date.now(), job.id);
        }
        return this.get(job.id);
    }

    prune() {
        const old = this.db.prepare(`SELECT id FROM remote_jobs WHERE status != 'running' ORDER BY started_at DESC LIMIT -1 OFFSET ?`).all(KEEP_JOBS);
        for (const { id } of old) {
            fs.rmSync(this.logFile(id), { force: true });
            this.db.prepare('DELETE FROM remote_jobs WHERE id = ?').run(id);
        }
    }
}

module.exports = { RemoteJobs };
