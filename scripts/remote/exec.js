/**
 * remote/exec.js
 * Where and how the bridge's commands run: `bash -lc <command>` (a login shell, so the user's
 * PATH/npm/pip setup applies), the app's secrets left out of the environment, and either as the
 * server's own user (REMOTE_MCP_RUN_AS=root, the default: same programs as the terminal) or as a
 * dedicated user with its own home (REMOTE_MCP_RUN_AS=<name>).
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { childEnv, appSecretValues } = require('../child-env');
const { runProcess, mask } = require('../process-runner');

const OUTPUT_CAP = 48 * 1024;

/** passwd entry of a user name: { uid, gid, home, shell } (throws if it doesn't exist). */
function lookupUser(name) {
    const line = execFileSync('getent', ['passwd', name], { encoding: 'utf8' }).trim();
    const [, , uid, gid, , home] = line.split(':');
    return { name, uid: Number(uid), gid: Number(gid), home };
}

class RemoteExec {
    /**
     * @param {object} opts
     * @param {string} [opts.runAs] - 'root' / '' = the server's user; otherwise a system user name
     * @param {string} [opts.workdir] - default folder ("~/claude")
     */
    constructor({ runAs = '', workdir = '' } = {}) {
        this.user = runAs && runAs !== 'root' && runAs !== os.userInfo().username ? lookupUser(runAs) : null;
        this.home = this.user ? this.user.home : os.homedir();
        const wd = workdir || '~/claude';
        this.workdir = path.resolve(this.home, wd.replace(/^~(?=$|\/)/, this.home));
        fs.mkdirSync(this.workdir, { recursive: true });
        if (this.user) fs.chownSync(this.workdir, this.user.uid, this.user.gid);
        this.secrets = appSecretValues();
    }

    get sameUser() {
        return !this.user;
    }

    /** "~" = the run-as user's home; relative = from the work folder. */
    resolvePath(p) {
        const raw = String(p ?? '').trim();
        if (!raw) return this.workdir;
        if (raw.length > 4096 || raw.includes('\0')) throw new Error('Caminho inválido.');
        return path.resolve(this.workdir, raw.replace(/^~(?=$|\/)/, this.home));
    }

    insideWorkdir(abs) {
        return abs === this.workdir || abs.startsWith(this.workdir + path.sep);
    }

    env(extra = {}) {
        const base = childEnv({ MEUTERMINAL_BRIDGE: '1', ...extra });
        if (this.user) {
            Object.assign(base, { HOME: this.user.home, USER: this.user.name, LOGNAME: this.user.name });
            delete base.NPM_CONFIG_PREFIX; // root's npm prefix isn't writable by another user
        }
        return base;
    }

    spawnOptions() {
        return this.user ? { uid: this.user.uid, gid: this.user.gid } : {};
    }

    mask(text) {
        return mask(String(text ?? ''), this.secrets);
    }

    /** Runs a command to completion. */
    async run({ command, cwd, timeoutMs }) {
        const dir = this.resolvePath(cwd);
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Pasta não existe: ${dir}`);
        const r = await runProcess({
            command: 'bash', args: ['-lc', String(command)], cwd: dir, env: this.env(),
            timeoutMs, maxOutputBytes: OUTPUT_CAP, headTail: true, secrets: this.secrets, ...this.spawnOptions(),
        });
        return { ...r, cwd: dir };
    }
}

module.exports = { RemoteExec, lookupUser };
