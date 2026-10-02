/**
 * backup-runner.js
 * Runs a backup: a consistent snapshot of the SQLite database plus the configured folders,
 * archived with tar and uploaded to an rclone remote. Also checks periodically whether a
 * scheduled backup is due, based on backup_config (see backup-store.js).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // how often we check if a scheduled backup is due

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function run(bin, args, { input } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: [input !== undefined ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', d => { stderr += d; });
        child.on('error', err => {
            reject(err.code === 'ENOENT' ? new Error(`"${bin}" não está instalado no servidor.`) : err);
        });
        child.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(stderr.trim().split('\n').pop() || `${bin} saiu com código ${code}`));
        });
        if (input !== undefined) {
            child.stdin.write(input);
            child.stdin.end();
        }
    });
}

class BackupRunner {
    /**
     * @param {object} opts
     * @param {import('./backup-store')} opts.store
     * @param {import('node:sqlite').DatabaseSync} opts.db - the live database to snapshot
     * @param {string} [opts.rcloneBin]
     * @param {string} [opts.tarBin]
     * @param {(...args: any[]) => void} [opts.log]
     */
    constructor({ store, db, rcloneBin = process.env.RCLONE_PATH || 'rclone', tarBin = 'tar', log = () => {} }) {
        this.store = store;
        this.db = db;
        this.rcloneBin = rcloneBin;
        this.tarBin = tarBin;
        this.log = log;
        this.running = false;
        this.timer = null;
    }

    /** Begins the periodic "is a backup due" check. Call once at boot. */
    start() {
        this.scheduleCheck();
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = null;
    }

    scheduleCheck() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.checkDue().catch(e => this.log('Backup scheduler error:', e.message)).finally(() => this.scheduleCheck());
        }, CHECK_INTERVAL_MS);
        this.timer.unref?.();
    }

    async checkDue() {
        if (this.running) return;
        const cfg = this.store.get();
        if (!cfg.enabled || !cfg.remote) return;
        const dueAt = (cfg.lastRunAt || 0) + cfg.intervalHours * 3600 * 1000;
        if (Date.now() < dueAt) return;
        await this.run('scheduled').catch(e => this.log('Scheduled backup failed:', e.message));
    }

    /** @returns {Promise<{status: 'ok', sizeBytes: number}>} */
    async run(trigger = 'manual') {
        if (this.running) throw new Error('Um backup já está em andamento.');
        this.running = true;
        const startedAt = Date.now();
        let tmpDir;
        try {
            const cfg = this.store.get();
            if (!cfg.remote) throw new Error('Configure um remote do rclone antes de rodar o backup.');
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-backup-'));
            const dbSnapshot = path.join(tmpDir, 'meuterminal.db');
            this.snapshotDb(dbSnapshot);
            const archive = path.join(tmpDir, `backup-${timestamp()}.tar.gz`);
            const sources = [dbSnapshot, ...(cfg.paths.length ? cfg.paths : [os.homedir()])];
            await run(this.tarBin, ['-czf', archive, '--', ...sources]);
            const sizeBytes = fs.statSync(archive).size;
            await this.upload(archive, cfg);
            if (cfg.keepLast > 0) await this.prune(cfg).catch(e => this.log('Backup prune failed:', e.message));
            const finishedAt = Date.now();
            this.store.recordRun({ trigger, status: 'ok', sizeBytes, startedAt, finishedAt });
            return { status: 'ok', sizeBytes };
        } catch (e) {
            this.store.recordRun({ trigger, status: 'error', error: e.message, startedAt, finishedAt: Date.now() });
            throw e;
        } finally {
            this.running = false;
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    /** A live, consistent copy of the database (safe even while the server keeps writing to it). */
    snapshotDb(dest) {
        this.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    }

    upload(file, cfg) {
        const dest = `${cfg.remote}:${cfg.remotePath}`;
        return run(this.rcloneBin, ['copy', '--', file, dest]);
    }

    /** Deletes the oldest backups on the remote beyond keepLast (names sort chronologically). */
    async prune(cfg) {
        const dest = `${cfg.remote}:${cfg.remotePath}`;
        const out = await new Promise((resolve, reject) => {
            const child = spawn(this.rcloneBin, ['lsjson', '--', dest]);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', d => { stdout += d; });
            child.stderr.on('data', d => { stderr += d; });
            child.on('error', reject);
            child.on('close', code => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim()))));
        });
        let entries;
        try {
            entries = JSON.parse(out);
        } catch {
            return;
        }
        const backups = entries.filter(e => !e.IsDir && /^backup-.*\.tar\.gz$/.test(e.Name)).sort((a, b) => a.Name.localeCompare(b.Name));
        const excess = backups.slice(0, Math.max(0, backups.length - cfg.keepLast));
        for (const e of excess) await run(this.rcloneBin, ['deletefile', '--', `${dest}/${e.Name}`]);
    }
}

module.exports = BackupRunner;
