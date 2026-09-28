/**
 * statusBar.js
 * Discreet bottom bar with facts about the active session: connection, directory,
 * shell, encoding, git branch, foreground process and the time. Never guesses:
 * anything the server can't tell us is simply not shown.
 */
import { icon } from './icons.js';

const STATE_LABELS = {
    connecting: 'Conectando…',
    connected: 'Conectado',
    reconnecting: 'Reconectando…',
    disconnected: 'Desconectado',
    exited: 'Encerrado',
    error: 'Erro',
};

export default class StatusBar {
    /**
     * @param {HTMLElement} el
     * @param {{ onSessions: (anchor: Element) => void }} handlers
     */
    constructor(el, { onSessions }) {
        this.el = el;
        el.innerHTML = `
            <div class="status-group status-left">
                <span class="status-item status-conn" data-state="connecting">
                    <span class="status-dot" aria-hidden="true"></span>
                    <span class="status-conn-label">Conectando…</span>
                </span>
                <span class="status-item status-cwd" hidden>${icon('folder', 14)}<span class="mono"></span></span>
                <span class="status-item status-shell" hidden>${icon('chevronRight', 13)}<span></span></span>
                <span class="status-item status-enc">UTF-8</span>
            </div>
            <div class="status-group status-right">
                <span class="status-item status-process" hidden>${icon('activity', 14)}<span></span></span>
                <span class="status-chip status-branch" hidden>${icon('gitBranch', 14)}<span></span></span>
                <span class="status-item status-size mono" aria-label="Tamanho do terminal"></span>
                <span class="status-item status-clock">${icon('clock', 14)}<time></time></span>
                <button type="button" class="icon-btn status-sessions" aria-label="Lista de sessões">
                    ${icon('list', 18)}</button>
            </div>`;
        this.q = sel => el.querySelector(sel);
        this.q('.status-sessions').addEventListener('click', e => onSessions(e.currentTarget));
        this.tickClock();
    }

    tickClock() {
        const time = this.q('.status-clock time');
        const now = new Date();
        time.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        time.dateTime = now.toISOString();
        // Re-run right after the next minute boundary
        setTimeout(() => this.tickClock(), 60000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
    }

    setText(sel, text) {
        const item = this.q(sel);
        item.hidden = !text;
        const span = item.querySelector('span:last-child');
        if (span.textContent !== text) span.textContent = text || '';
    }

    /** Renders the active session (or nothing if there is none). */
    render(session) {
        if (!session) return;
        const conn = this.q('.status-conn');
        conn.dataset.state = session.state;
        this.q('.status-conn-label').textContent = STATE_LABELS[session.state] || session.state;
        this.setText('.status-cwd', session.displayCwd() || session.title || '');
        this.setText('.status-shell', session.shell || '');
        this.setText('.status-branch', session.branch || '');
        this.setText('.status-process', session.process || '');
        const t = session.terminal;
        // Terminal: columns×rows. Browser tab: page size in CSS pixels.
        this.q('.status-size').textContent = t ? `${t.cols}×${t.rows}` : (session.sizeLabel || '');
    }
}
