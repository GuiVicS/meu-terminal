/**
 * acp-client.js
 * Minimal Agent Client Protocol (ACP) client: JSON-RPC 2.0 over the agent's stdin/stdout,
 * one JSON message per line. Knows nothing about sessions or the UI (see gateway.js).
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const MAX_STDERR_LINES = 50;

class AcpError extends Error {
    constructor(message, { code, data } = {}) {
        super(message);
        this.code = code;
        this.data = data;
    }
}

/**
 * Events:
 *   'notification' (method, params)   - agent -> client notifications (session/update...)
 *   'exit' ({ code, signal, stderr }) - the agent process ended
 * Agent -> client requests (session/request_permission, fs/*...) go to `onRequest`,
 * which must return the result (or a promise); throwing answers with a JSON-RPC error.
 */
class AcpClient extends EventEmitter {
    /**
     * @param {object} opts
     * @param {string} opts.command
     * @param {string[]} [opts.args]
     * @param {string} opts.cwd
     * @param {object} [opts.env]
     * @param {(method: string, params: any) => any} [opts.onRequest]
     * @param {Function} [opts.log]
     */
    constructor({ command, args = [], cwd, env = process.env, onRequest, log = () => {} }) {
        super();
        this.command = command;
        this.args = args;
        this.cwd = cwd;
        this.env = env;
        this.onRequest = onRequest || (() => { throw new AcpError('Method not supported', { code: -32601 }); });
        this.log = log;
        this.child = null;
        this.nextId = 1;
        this.pending = new Map(); // id -> { resolve, reject, timer }
        this.stderr = [];
        this.exited = false;
        this.buffer = '';
    }

    /** Spawns the agent. Rejects if the binary cannot be started. */
    start() {
        return new Promise((resolve, reject) => {
            const child = spawn(this.command, this.args, {
                cwd: this.cwd,
                env: this.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
            this.child = child;
            let started = false;
            child.once('spawn', () => {
                started = true;
                resolve();
            });
            child.once('error', (error) => {
                if (!started) reject(new AcpError(`Could not start "${this.command}": ${error.message}`));
                else this.log('ACP process error:', error.message);
            });
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this.onData(chunk));
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                for (const line of chunk.split('\n')) {
                    if (!line.trim()) continue;
                    this.stderr.push(line.trim());
                    if (this.stderr.length > MAX_STDERR_LINES) this.stderr.shift();
                }
            });
            // Writing to a dead agent must not crash the server
            child.stdin.on('error', (error) => this.log('ACP stdin error:', error.message));
            child.once('exit', (code, signal) => this.onExit(code, signal));
        });
    }

    onData(chunk) {
        this.buffer += chunk;
        let newline;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                // Some agents print banners/logs on stdout; ignore anything that is not JSON-RPC
                this.log('ACP non-JSON output ignored:', line.slice(0, 200));
                continue;
            }
            this.onMessage(message);
        }
    }

    onMessage(message) {
        const isResponse = message.id != null && !message.method;
        if (isResponse) {
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            clearTimeout(entry.timer);
            if (message.error) {
                entry.reject(new AcpError(message.error.message || 'ACP error', message.error));
            } else {
                entry.resolve(message.result);
            }
            return;
        }
        if (message.method && message.id != null) {
            this.answerRequest(message);
            return;
        }
        if (message.method) this.emit('notification', message.method, message.params);
    }

    async answerRequest(message) {
        try {
            const result = await this.onRequest(message.method, message.params);
            this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null });
        } catch (error) {
            this.write({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: error.code || -32603, message: error.message || 'Internal error' },
            });
        }
    }

    onExit(code, signal) {
        this.exited = true;
        const error = new AcpError(`Agent exited (code ${code}${signal ? `, signal ${signal}` : ''})`);
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
        this.emit('exit', { code, signal, stderr: this.stderr.slice() });
    }

    write(message) {
        if (this.exited || !this.child) return;
        this.child.stdin.write(JSON.stringify(message) + '\n');
    }

    /**
     * Sends a request and waits for the response.
     * timeoutMs = 0 waits forever (session/prompt can legitimately take very long).
     */
    request(method, params, { timeoutMs = 60000 } = {}) {
        if (this.exited) return Promise.reject(new AcpError('Agent is not running'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = timeoutMs
                ? setTimeout(() => {
                    this.pending.delete(id);
                    reject(new AcpError(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
                }, timeoutMs)
                : null;
            this.pending.set(id, { resolve, reject, timer });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
    }

    /** Stops the agent: polite SIGTERM, then SIGKILL if it does not exit. */
    kill({ graceMs = 3000 } = {}) {
        // pid is undefined when the process never started (ENOENT): no 'exit' will ever come
        if (!this.child || this.exited || this.child.pid == null) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                try { this.child.kill('SIGKILL'); } catch { /* already gone */ }
            }, graceMs);
            this.child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            try { this.child.kill('SIGTERM'); } catch { resolve(); }
        });
    }
}

module.exports = { AcpClient, AcpError };
