/**
 * push.js
 * Web Push notifications (phone/desktop notifications with sound, even with the app
 * closed). Each device subscribes from Settings; agents send them through the MCP
 * `notify` tool. VAPID keys are created once and kept in the database.
 */
const webpush = require('web-push');

const MAX_SUBSCRIPTIONS = 50;

class PushNotifier {
    /**
     * @param {object} opts
     * @param {import('./session-store')} opts.store
     * @param {string} opts.subject - "https://your.domain" or "mailto:..."
     * @param {Function} [opts.log]
     */
    constructor({ store, subject, log = () => {} }) {
        this.store = store;
        this.log = log;
        const keys = this.meta('vapid_keys') || (() => {
            const created = webpush.generateVAPIDKeys();
            this.setMeta('vapid_keys', created);
            return created;
        })();
        this.publicKey = keys.publicKey;
        webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
    }

    meta(key) {
        const row = this.store.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
        if (!row) return null;
        try {
            return JSON.parse(row.value);
        } catch {
            return null;
        }
    }

    setMeta(key, value) {
        this.store.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
    }

    subscriptions() {
        const list = this.meta('push_subscriptions');
        return Array.isArray(list) ? list : [];
    }

    /** Saves a device's subscription (same endpoint = same device, replaced). */
    subscribe(subscription, device = '') {
        if (!subscription || typeof subscription.endpoint !== 'string' || !/^https:\/\//.test(subscription.endpoint)
            || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
            throw new Error('Inscrição inválida.');
        }
        const list = this.subscriptions().filter(s => s.endpoint !== subscription.endpoint);
        list.push({
            endpoint: subscription.endpoint,
            keys: { p256dh: String(subscription.keys.p256dh), auth: String(subscription.keys.auth) },
            device: String(device || '').slice(0, 120),
            at: Date.now(),
        });
        this.setMeta('push_subscriptions', list.slice(-MAX_SUBSCRIPTIONS));
        return list.length;
    }

    unsubscribe(endpoint) {
        const list = this.subscriptions();
        const next = list.filter(s => s.endpoint !== endpoint);
        this.setMeta('push_subscriptions', next);
        return list.length !== next.length;
    }

    /**
     * Sends a notification to every subscribed device. Dead subscriptions (uninstalled
     * app, revoked permission) are removed. Returns { sent, failed, devices }.
     */
    /**
     * @param {object} msg
     * @param {{action: string, title: string}[]} [msg.actions] - notification buttons (Android/desktop)
     * @param {string} [msg.approvalId] - the Claude bridge approval the buttons answer (service-worker.js)
     * @param {boolean} [msg.always] - show it even when the app is open on screen
     */
    async send({ title = 'MeuTerminal', body = '', sound = true, url = '/', tag, actions, approvalId, always } = {}) {
        const list = this.subscriptions();
        if (!list.length) return { sent: 0, failed: 0, devices: 0 };
        const payload = JSON.stringify({
            title: String(title).slice(0, 80),
            body: String(body).slice(0, 300),
            sound: sound !== false,
            url,
            tag: tag || `mt-${Date.now()}`,
            ...(Array.isArray(actions) ? { actions: actions.slice(0, 2) } : {}),
            ...(approvalId ? { approvalId } : {}),
            ...(always ? { always: true } : {}),
        });
        let sent = 0;
        let failed = 0;
        const dead = new Set();
        await Promise.all(list.map(async s => {
            try {
                await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, {
                    TTL: 60 * 60,
                    urgency: 'high',
                });
                sent++;
            } catch (e) {
                failed++;
                if (e.statusCode === 404 || e.statusCode === 410) dead.add(s.endpoint);
                else this.log('Push failed:', e.statusCode || '', e.body || e.message);
            }
        }));
        if (dead.size) this.setMeta('push_subscriptions', this.subscriptions().filter(s => !dead.has(s.endpoint)));
        return { sent, failed, devices: list.length - dead.size };
    }
}

module.exports = { PushNotifier };
