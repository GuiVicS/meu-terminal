/**
 * commands.js
 * Client for the quick commands saved on the server (/api/commands).
 * Keeps a cached list and notifies the UI when it changes.
 */

function joinPath(path) {
    const basePath = window.appConfig?.basePath || '';
    const cleanPath = path.replace(/^\/+/, '');
    const cleanBase = basePath.replace(/\/+$/, '');
    return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
}

async function request(method, path, body) {
    const response = await fetch(joinPath(`api/${path}`), {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

export default class CommandsManager {
    constructor() {
        /** @type {Array<{id: string, label: string, command: string, run: boolean}>} */
        this.items = [];
        this.listeners = new Set();
    }

    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    emit() {
        this.listeners.forEach(fn => fn(this.items));
    }

    /** Reloads from the server (other devices may have edited the list). */
    async load() {
        this.items = await request('GET', 'commands');
        this.emit();
        return this.items;
    }

    async add({ label, command, run }) {
        const created = await request('POST', 'commands', { label, command, run });
        this.items.push(created);
        this.emit();
        return created;
    }

    async update(id, fields) {
        const updated = await request('PATCH', `commands/${encodeURIComponent(id)}`, fields);
        this.items = this.items.map(item => (item.id === id ? updated : item));
        this.emit();
        return updated;
    }

    async remove(id) {
        await request('DELETE', `commands/${encodeURIComponent(id)}`);
        this.items = this.items.filter(item => item.id !== id);
        this.emit();
    }
}
