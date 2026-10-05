/**
 * vercel-deploy.js
 * "Publicar" in vibecoding: runs the Vercel CLI (installed in the Docker image) inside the
 * project's folder, non-interactively, and returns the production deployment URL. Needs
 * VERCEL_TOKEN (a token from vercel.com/account/tokens) - without one, publish() explains
 * what's missing instead of failing with a raw CLI error.
 */
const { spawn } = require('child_process');

// Deliberately not using "bash -c" + string interpolation (unlike webhook-runner.js, which runs a
// trusted script file) - the argv array form here needs no shell at all, so the token can never
// be parsed as shell syntax.

/** The last https:// URL in the CLI's output - with --prod --yes, that's the deployment URL. */
function extractUrl(output) {
    const matches = String(output || '').match(/https:\/\/\S+/g) || [];
    if (!matches.length) return null;
    return matches[matches.length - 1].replace(/[).,]+$/, '');
}

/** The last non-empty line - usually the actual error message from a failed deploy. */
function lastLine(output) {
    const lines = String(output || '').trim().split('\n').map(l => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
}

class VercelDeploy {
    /**
     * @param {object} [opts]
     * @param {string} [opts.token] - VERCEL_TOKEN; publish() rejects immediately without one
     * @param {string} [opts.command] - the CLI binary (overridable for tests)
     * @param {number} [opts.timeoutMs] - a stuck deploy is killed and reported as failed
     * @param {Function} [opts.spawnImpl] - child_process.spawn, injectable for tests
     */
    constructor({ token = process.env.VERCEL_TOKEN, command = 'vercel', timeoutMs = 5 * 60 * 1000, spawnImpl = spawn } = {}) {
        this.token = token || '';
        this.command = command;
        this.timeoutMs = timeoutMs;
        this.spawnImpl = spawnImpl;
    }

    get configured() {
        return !!this.token;
    }

    /** Deploys `folder` to production; resolves with the deployment URL. */
    deploy(folder) {
        if (!this.configured) {
            return Promise.reject(new Error('Defina VERCEL_TOKEN no servidor para publicar (gere um em vercel.com/account/tokens).'));
        }
        return new Promise((resolve, reject) => {
            const child = this.spawnImpl(this.command, ['deploy', '--prod', '--yes', `--token=${this.token}`], { cwd: folder, env: process.env });
            let out = '';
            let err = '';
            let settled = false;
            const finish = (fn, arg) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(arg);
            };
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                finish(reject, new Error('Publicação demorou demais (mais de 5 minutos) e foi cancelada.'));
            }, this.timeoutMs);
            child.stdout.on('data', d => { out += d; });
            child.stderr.on('data', d => { err += d; });
            child.on('error', e => {
                finish(reject, e.code === 'ENOENT' ? new Error('Vercel CLI não instalado no servidor (npm install -g vercel).') : e);
            });
            child.on('close', code => {
                if (code === 0) {
                    const url = extractUrl(out) || extractUrl(err);
                    if (url) return finish(resolve, url);
                    return finish(reject, new Error('O Vercel terminou sem erro, mas não encontrei a URL publicada na saída.'));
                }
                finish(reject, new Error(lastLine(err) || lastLine(out) || `O Vercel CLI saiu com código ${code}.`));
            });
        });
    }
}

module.exports = { VercelDeploy, extractUrl, lastLine };
