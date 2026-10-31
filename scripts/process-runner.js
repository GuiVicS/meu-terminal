/**
 * process-runner.js
 * Runs one command to completion without a shell in between: its own process group (so a
 * timeout kills everything it forked, not just the first process), stdout+stderr captured up
 * to a size cap, and known secret values masked before anything leaves this module.
 * Used by webhook-runner.js; the environment is whatever the caller passes (build it clean).
 */
const { spawn, execFileSync } = require('child_process');
const os = require('os');

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Replaces every occurrence of each secret with dots. */
function mask(text, secrets = []) {
    let out = text;
    for (const s of secrets) {
        if (!s) continue;
        out = out.split(s).join('••••');
    }
    return out;
}

/** Kills a process started with `detached: true` and everything it forked. */
function killGroup(child) {
    // A plain child.kill() only signals the immediate process - any command it forked (sleep,
    // npm, docker...) would keep running and keep stdio open. Kill the whole tree instead.
    if (process.platform === 'win32') {
        try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F']); } catch { /* already gone */ }
        return;
    }
    try {
        process.kill(-child.pid, 'SIGKILL'); // negative pid: the whole detached process group
    } catch { /* already gone */ }
}

/**
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} opts.env - the complete environment (nothing is inherited)
 * @param {number} opts.timeoutMs
 * @param {number} [opts.maxOutputBytes]
 * @param {string[]} [opts.secrets] - values masked in the output
 * @param {(child: import('child_process').ChildProcess) => void} [opts.onSpawn] - e.g. to cancel it from outside
 * @returns {Promise<{ exitCode: number|null, output: string, truncated: boolean, timedOut: boolean, durationMs: number }>}
 */
async function runProcess({
    command, args = [], cwd = os.homedir(), env, timeoutMs,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, secrets = [], onSpawn,
}) {
    const startedAt = Date.now();
    const child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
    });
    onSpawn?.(child);

    let output = '';
    let truncated = false;
    const onData = d => {
        if (output.length >= maxOutputBytes) { truncated = true; return; }
        output += d.toString('utf8');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, timeoutMs);
    timer.unref?.();

    const exitCode = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => resolve(code));
    }).catch(e => { output += `\n[erro ao iniciar: ${e.message}]`; return null; });
    clearTimeout(timer);

    if (truncated) output += '\n[saída truncada]';
    return { exitCode, output: mask(output, secrets), truncated, timedOut, durationMs: Date.now() - startedAt };
}

module.exports = { runProcess, killGroup, mask, DEFAULT_MAX_OUTPUT_BYTES };
