/**
 * webhook-runner.js
 * Executes a webhook's script: a temp file (0700) run with
 * `bash --noprofile --norc -euo pipefail <file>` via spawn, no shell in between, in a clean
 * environment. Inputs arrive only as env vars (scripts/webhook-inputs.js already validated and
 * typed them) - nothing from a request is ever interpolated into the command or the script text.
 * One queue per webhook (per `concurrency`), a timeout that kills the whole process group, and
 * masked output capped in size before it's handed to the store.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_SEC = 300;

function mask(text, secrets) {
    let out = text;
    for (const s of secrets) {
        if (!s) continue;
        out = out.split(s).join('••••');
    }
    return out;
}

class WebhookRunner {
    /** @param {object} opts
     *  @param {import('./webhook-store')} opts.store
     *  @param {(...a:any[]) => void} [opts.log] */
    constructor({ store, log = () => {} }) {
        this.store = store;
        this.log = log;
        this.chains = new Map();   // webhookId -> promise chain tail (concurrency: 'queue')
        this.active = new Map();   // webhookId -> { runId, child } (the one currently running, if any)
    }

    isRunning(webhookId) {
        return this.active.has(webhookId);
    }

    /**
     * @param {object} webhook - a row from webhook-store.js
     * @param {{ trigger: 'http'|'manual'|'test', sourceIp?: string, tokenId?: string,
     *   values: Record<string,string>, secretValues?: string[], files?: Record<string,string>,
     *   payloadFile?: string }} ctx
     */
    async run(webhook, ctx) {
        if (!webhook.enabled && ctx.trigger !== 'test') throw new Error('Webhook desativado.');
        const concurrency = webhook.concurrency || 'queue';
        if (this.active.has(webhook.id)) {
            if (concurrency === 'skip') throw new Error('Já existe uma execução em andamento.');
            if (concurrency === 'cancel') this.cancelActive(webhook.id);
        }
        const prev = this.chains.get(webhook.id) || Promise.resolve();
        const next = prev.catch(() => {}).then(() => this.execute(webhook, ctx));
        this.chains.set(webhook.id, next);
        return next;
    }

    cancelActive(webhookId) {
        const entry = this.active.get(webhookId);
        if (!entry) return false;
        this.killGroup(entry.child);
        return true;
    }

    killGroup(child) {
        // A plain child.kill() only signals the immediate bash process - any command it forked (sleep,
        // npm, docker...) would keep running and keep stdio open. Kill the whole tree instead.
        if (process.platform === 'win32') {
            try { require('child_process').execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* already gone */ }
            return;
        }
        try {
            process.kill(-child.pid, 'SIGKILL'); // negative pid: the whole detached process group
        } catch { /* already gone */ }
    }

    async execute(webhook, ctx) {
        const runId = crypto.randomUUID();
        const startedAt = Date.now();
        this.store.createRun({
            id: runId, webhookId: webhook.id, trigger: ctx.trigger, sourceIp: ctx.sourceIp || null,
            tokenId: ctx.tokenId || null, values: ctx.values, startedAt,
        });

        let tmpDir;
        try {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-webhook-'));
            const scriptFile = path.join(tmpDir, 'script.sh');
            fs.writeFileSync(scriptFile, webhook.script, { mode: 0o700 });

            const env = {
                PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                HOME: process.env.HOME || os.homedir(),
                LANG: process.env.LANG || 'C.UTF-8',
                MT_WEBHOOK_ID: webhook.id,
                MT_RUN_ID: runId,
                MT_TRIGGER: ctx.trigger === 'manual' || ctx.trigger === 'test' ? 'manual' : 'http',
                ...ctx.values,
                ...(ctx.files || {}),
            };
            if (ctx.payloadFile) env.MT_PAYLOAD_FILE = ctx.payloadFile;

            const child = spawn('bash', ['--noprofile', '--norc', '-euo', 'pipefail', scriptFile], {
                cwd: webhook.cwd && fs.existsSync(webhook.cwd) ? webhook.cwd : os.homedir(),
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: process.platform !== 'win32',
            });
            this.active.set(webhook.id, { runId, child });

            let output = '';
            let truncated = false;
            const onData = d => {
                if (output.length >= MAX_OUTPUT_BYTES) { truncated = true; return; }
                output += d.toString('utf8');
            };
            child.stdout.on('data', onData);
            child.stderr.on('data', onData);

            const timeoutMs = (webhook.timeoutSec || DEFAULT_TIMEOUT_SEC) * 1000;
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; this.killGroup(child); }, timeoutMs);
            timer.unref?.();

            const exitCode = await new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('close', code => resolve(code));
            }).catch(e => { output += `\n[erro ao iniciar: ${e.message}]`; return null; });
            clearTimeout(timer);
            this.active.delete(webhook.id);

            if (truncated) output += '\n[saída truncada]';
            const masked = mask(output, ctx.secretValues || []);
            const status = timedOut ? 'timeout' : exitCode === 0 ? 'ok' : 'failed';
            const finishedAt = Date.now();
            this.store.finishRun(runId, { status, exitCode: exitCode ?? null, output: masked, finishedAt });
            this.log(`webhook ${webhook.slug} run ${runId}: ${status} in ${finishedAt - startedAt}ms`);
            return { runId, status, exitCode, output: masked };
        } catch (e) {
            this.active.delete(webhook.id);
            this.store.finishRun(runId, { status: 'failed', exitCode: null, output: e.message, finishedAt: Date.now() });
            throw e;
        } finally {
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}

module.exports = WebhookRunner;
