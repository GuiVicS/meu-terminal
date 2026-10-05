/**
 * notas.js
 * Entry point for /notas: a standalone, installable version of just the Anotações tab - its own
 * PWA (own manifest/icon, see scripts/pwa-manifest-generator.js), but the exact same NotesSession
 * used inside MeuTerminal, pointed at the same /api/notes data. No tab bar, no other session
 * kinds - this page's only job is to find (or create) the one "notes" tab and mount it full-screen.
 */
import NotesSession from '../managers/notesSession.js';
import SettingsManager from '../managers/settings.js';
import ViewportManager from '../ui/viewport.js';
import ServiceWorkerManager from '../managers/serviceWorker.js';
import { toast } from '../ui/toast.js';

function basePath() {
    return (window.appConfig?.basePath || '').replace(/\/+$/, '');
}

async function api(method, route, body) {
    const response = await fetch(`${basePath()}/api/${route}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.redirected && /\/login$/.test(new URL(response.url).pathname)) {
        window.location.href = `${basePath()}/login`;
        throw new Error('Sua sessão expirou.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Erro ${response.status}`);
    return data;
}

/** The notes tab is shared/global (same as opening it from the main app) - reuse one if it's
 *  already open anywhere, instead of spawning a new tab every time this page loads. */
async function findOrCreateNotesSession() {
    const { sessions } = await api('GET', 'sessions');
    const existing = sessions.find(s => s.kind === 'notes');
    if (existing) return existing;
    return api('POST', 'sessions', { kind: 'notes', name: 'Anotações' });
}

function showDisabledMessage() {
    const host = document.getElementById('notesHost');
    host.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;padding:24px;text-align:center;color:var(--text-3);';
    host.textContent = 'Anotações estão desligadas neste servidor.';
}

async function main() {
    if (window.appConfig?.notesAvailable === false) {
        showDisabledMessage();
        return;
    }

    const settings = new SettingsManager();
    new ViewportManager();
    new ServiceWorkerManager().initialize(() => {});

    let row;
    try {
        row = await findOrCreateNotesSession();
    } catch (e) {
        document.getElementById('notesHost').textContent = '';
        toast(e.message || 'Não foi possível abrir as anotações.', { tone: 'error' });
        return;
    }

    const hooks = {
        onStateChange: () => {},
        onInfo: () => {},
        onWorkspaceChanged: () => {},
        onServerMessage: () => {},
        onAuthRequired: () => { window.location.href = `${basePath()}/login`; },
        // The tab was closed from the main app while this page was open: nothing left to show here.
        onRemoved: () => { window.location.reload(); },
    };
    const notes = new NotesSession({ row, settings, hooks });
    notes.mount(document.getElementById('notesHost'));
    notes.setActive(true);
    notes.focus();
}

main();
