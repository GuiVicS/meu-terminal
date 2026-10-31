/**
 * remote/approvals.js
 * Asking the user before the bridge runs something. A request is bound to exactly what will run
 * (a hash of tool + arguments), so approving one command can't be reused for another, and an
 * approval is good for a single run. The phone gets a push with Aprovar/Recusar; /admin lists
 * the pending ones too. Kept in memory: a restart just means asking again.
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MODES = ['always', 'dangerous', 'never'];
const REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 20;

class Approvals extends EventEmitter {
    /**
     * @param {object} opts
     * @param {() => string} opts.getMode - 'always' | 'dangerous' | 'never'
     * @param {(req: object) => Promise<any>|void} [opts.notify] - sends the push
     * @param {() => number} [opts.now]
     */
    constructor({ getMode, notify = () => {}, now = Date.now }) {
        super();
        this.setMaxListeners(100);
        this.getMode = getMode;
        this.notify = notify;
        this.now = now;
        this.requests = new Map(); // id -> request
    }

    static fingerprint(tool, args) {
        return crypto.createHash('sha256').update(`${tool}\0${JSON.stringify(args)}`).digest('base64url');
    }

    /**
     * Does this action need a yes from the user under the current mode?
     * 'always' asks for everything that runs something (and for risky writes); 'dangerous' only
     * for what risk.js flags; 'never' never asks.
     * @param {string[]} risks
     * @param {'exec'|'write'} kind
     */
    needed(risks, kind = 'exec') {
        const mode = this.getMode();
        if (mode === 'never') return false;
        if (mode === 'always' && kind === 'exec') return true;
        return risks.length > 0;
    }

    sweep() {
        const now = this.now();
        for (const [id, r] of this.requests) {
            if (r.expiresAt < now) {
                if (r.status === 'pending') {
                    r.status = 'expired';
                    this.emit(`decided:${id}`, r);
                }
                if (r.expiresAt < now - REQUEST_TTL_MS) this.requests.delete(id);
            }
        }
    }

    /**
     * Gets permission for one action. Reuses `approvalId` when the caller is retrying the same
     * action; otherwise creates a request and pushes it to the phone. Waits up to `waitMs`.
     * @returns {Promise<{status: 'approved'|'rejected'|'pending'|'expired', id: string}>}
     */
    async check({ approvalId, tool, args, summary, risks, clientId, waitMs = 40000 }) {
        this.sweep();
        const fp = Approvals.fingerprint(tool, args);
        let req = approvalId ? this.requests.get(String(approvalId)) : null;
        if (req && req.fingerprint !== fp) req = null; // an id for something else: ask again
        if (req && (req.status === 'used' || req.status === 'expired')) req = null;
        if (!req) {
            const pending = [...this.requests.values()].filter(r => r.status === 'pending');
            if (pending.length >= MAX_PENDING) throw new Error('Aprovações pendentes demais. Responda ou espere expirarem.');
            req = {
                id: crypto.randomBytes(9).toString('base64url'), fingerprint: fp, tool, summary: String(summary).slice(0, 500),
                risks, clientId, status: 'pending', createdAt: this.now(), expiresAt: this.now() + REQUEST_TTL_MS,
            };
            this.requests.set(req.id, req);
            try { await this.notify(req); } catch { /* the admin page still lists it */ }
        }
        if (req.status === 'pending' && waitMs > 0) await this.waitFor(req.id, waitMs);
        if (req.status === 'approved') {
            req.status = 'used'; // single use
            return { status: 'approved', id: req.id };
        }
        return { status: req.status, id: req.id };
    }

    waitFor(id, ms) {
        return new Promise(resolve => {
            const done = () => { clearTimeout(timer); this.off(`decided:${id}`, done); resolve(); };
            const timer = setTimeout(done, ms);
            timer.unref?.();
            this.on(`decided:${id}`, done);
        });
    }

    /** From /admin or the push action. */
    decide(id, approve) {
        this.sweep();
        const req = this.requests.get(String(id));
        if (!req || req.status !== 'pending') return null;
        req.status = approve ? 'approved' : 'rejected';
        req.decidedAt = this.now();
        this.emit(`decided:${req.id}`, req);
        return req;
    }

    list() {
        this.sweep();
        return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt).map(r => ({
            id: r.id, tool: r.tool, summary: r.summary, risks: r.risks, clientId: r.clientId,
            status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt,
        }));
    }
}

module.exports = { Approvals, MODES };
