/**
 * agentLaunch.js
 * The "Deseja usar o modo Claude Code UI?" popup, shown when a coding agent is typed in a
 * terminal (see scripts/agents/launch.js). [Sim] opens the agent UI tab, [Não] keeps the terminal.
 */
import { icon } from './icons.js';
import { toast } from './toast.js';

const base = () => (window.appConfig?.basePath || '').replace(/\/+$/, '');

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export default class AgentLaunch {
    constructor() {
        this.request = null; // the question being shown
        this.queue = [];     // questions that arrived meanwhile (two terminals at once)
        this.dialog = document.createElement('dialog');
        this.dialog.className = 'dialog agent-launch-dialog';
        this.dialog.setAttribute('aria-labelledby', 'agent-launch-title');
        this.dialog.innerHTML = `
            <form method="dialog" class="agent-launch-form">
                <header class="dialog-header">
                    <h2 class="dialog-title" id="agent-launch-title"></h2>
                </header>
                <div class="dialog-body">
                    <p class="agent-launch-lead">Abre o agente numa aba com chat, ferramentas, diffs e pedidos de permissão. <b>Não</b> segue no terminal, como sempre.</p>
                    <dl class="agent-launch-info"></dl>
                    <label class="vibe-check"><input type="checkbox" name="remember"> Lembrar minha escolha para este agente</label>
                    <p class="agent-launch-timer" aria-live="off"></p>
                </div>
                <footer class="prompt-actions">
                    <button type="button" class="btn btn-ghost" data-choice="terminal">Não</button>
                    <button type="submit" class="btn btn-primary" data-choice="ui">${icon('bot', 16)} Sim</button>
                </footer>
            </form>`;
        document.body.appendChild(this.dialog);
        this.form = this.dialog.querySelector('form');
        this.dialog.querySelector('[data-choice="terminal"]').addEventListener('click', () => this.choose('terminal'));
        this.form.addEventListener('submit', e => {
            e.preventDefault();
            this.choose('ui');
        });
        // Esc = Não (the terminal keeps working as before)
        this.dialog.addEventListener('cancel', e => {
            e.preventDefault();
            this.choose('terminal');
        });
    }

    /** A new question from the server (message 'agent-launch'). */
    open(request) {
        if (this.request?.requestId === request.requestId || this.queue.some(r => r.requestId === request.requestId)) return;
        if (this.request) {
            this.queue.push(request);
            return;
        }
        this.show(request);
    }

    show(request) {
        this.request = request;
        this.dialog.querySelector('.dialog-title').textContent = `Deseja usar o modo "${request.uiName}"?`;
        const rows = [['Agente', request.label], ['Pasta', request.cwd]];
        if (request.prompt) rows.push(['Pedido', request.prompt.length > 160 ? `${request.prompt.slice(0, 160)}…` : request.prompt]);
        this.dialog.querySelector('.agent-launch-info').innerHTML = rows
            .map(([k, v]) => `<dt>${esc(k)}</dt><dd class="${k === 'Pasta' ? 'mono' : ''}">${esc(v)}</dd>`).join('');
        this.form.elements.remember.checked = false;
        this.startTimer(request.timeoutMs || 60000);
        if (!this.dialog.open) this.dialog.showModal();
        // Enter confirms "Sim"
        requestAnimationFrame(() => this.dialog.querySelector('[data-choice="ui"]').focus());
    }

    startTimer(ms) {
        clearInterval(this.timer);
        const end = Date.now() + ms;
        const label = this.dialog.querySelector('.agent-launch-timer');
        const tick = () => {
            const left = Math.max(0, Math.round((end - Date.now()) / 1000));
            label.textContent = `Sem resposta em ${left} s, segue no terminal.`;
        };
        tick();
        this.timer = setInterval(tick, 1000);
    }

    async choose(choice) {
        const request = this.request;
        if (!request) return;
        const remember = this.form.elements.remember.checked;
        this.next();
        try {
            const response = await fetch(`${base()}/api/agent-launch/answer`, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: request.requestId, choice, remember }),
            });
            // 410: answered on another device or expired; nothing to do here
            if (!response.ok && response.status !== 410) throw new Error(`Erro ${response.status}`);
            if (remember) toast(choice === 'ui' ? `${request.label} vai abrir sempre no modo UI.` : `${request.label} vai abrir sempre no terminal.`);
        } catch (e) {
            toast(`Não foi possível responder: ${e.message}`, { tone: 'error' });
        }
    }

    /** Answered elsewhere or expired (message 'agent-launch-close'). */
    closeRequest(requestId) {
        this.queue = this.queue.filter(r => r.requestId !== requestId);
        if (this.request?.requestId === requestId) this.next();
    }

    next() {
        clearInterval(this.timer);
        this.request = null;
        const following = this.queue.shift();
        if (following) this.show(following);
        else if (this.dialog.open) this.dialog.close();
    }
}
