/**
 * conversationDrawer.js
 * Modo UI no celular: a lista lateral de conversas, como nos apps do Claude e do ChatGPT.
 * - Abre arrastando da esquerda para a direita no chat (ou pelo ☰ numa bolinha no topo) e
 *   empurra o app para a direita: o chat fica visível na faixa restante, escurecido e com o
 *   canto arredondado; tocar nele ou arrastar de volta fecha.
 * - Segue o dedo 1:1; ao soltar, a velocidade (projetada como no iOS) decide abrir ou fechar, e
 *   a mola parte da posição e da velocidade atuais, então pode ser pega de novo no meio.
 * - Topo: nome do agente + busca. "Fixadas" e "Recentes" (as conversas do agente nesta pasta,
 *   incluindo as começadas no terminal). "Ver tudo". Rodapé: iniciais + "Nova conversa".
 * Só no layout de celular (data-iphone, retrato) e só quando a aba ativa é de agente.
 */
import { icon } from './icons.js';
import { esc } from '../agent/markdown.js';
import { showMenu } from './contextMenu.js';
import { toast } from './toast.js';

const root = document.documentElement;
const RECENT_LIMIT = 15;
const LONG_PRESS_MS = 500;
const SLOP = 10;              // px antes de decidir se o gesto é horizontal
const DECELERATION = 0.998;   // projeção de momento (apple-design §6)

// Ícones de traço próprios: o ☰ de traços decrescentes e o balão, como no app do Claude
export const MENU_ICON = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h11"/><path d="M4 17h6"/></svg>`;
const BUBBLE_ICON = `<svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7.5 19.2 4 20.5l1.1-3.4A8 8 0 1 1 7.5 19.2Z"/></svg>`;

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches || root.hasAttribute('data-reduced-motion');
const project = v => (v / 1000) * DECELERATION / (1 - DECELERATION); // v em px/s → px a mais

function basePath() {
    return (window.appConfig?.basePath || '').replace(/\/+$/, '');
}
async function pinsApi(method, pins) {
    const r = await fetch(`${basePath()}/api/agent-pins`, {
        method, credentials: 'same-origin', cache: 'no-store',
        headers: pins ? { 'Content-Type': 'application/json' } : undefined,
        body: pins ? JSON.stringify({ pins }) : undefined,
    });
    if (!r.ok) throw new Error(`Erro ${r.status}`);
    return (await r.json()).pins || [];
}

/** Mola criticamente amortecida ~0.8 (resposta 0.3 s), passo a passo, partindo da velocidade atual. */
function springTo(from, to, velocity, onFrame, onDone) {
    const response = 0.3, damping = 0.8;
    const k = (2 * Math.PI / response) ** 2;
    const c = 4 * Math.PI * damping / response;
    let x = from, v = velocity, last = performance.now(), raf = 0;
    const step = now => {
        const dt = Math.min(0.032, (now - last) / 1000);
        last = now;
        const a = -k * (x - to) - c * v;
        v += a * dt;
        x += v * dt;
        if (Math.abs(x - to) < 0.001 && Math.abs(v) < 0.01) {
            onFrame(to);
            onDone?.();
            return;
        }
        onFrame(x);
        raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
}

export default class ConversationDrawer {
    /**
     * @param {object} opts
     * @param {HTMLElement} opts.app - #app, empurrado para a direita
     * @param {() => any} opts.getAgent - a AgentSession ativa (ou null se a aba não é de agente)
     * @param {() => any[]} opts.getOpenAgents - todas as AgentSession abertas (para não duplicar abas)
     * @param {(id: string) => void} opts.activate - mostra uma aba aberta
     * @param {() => void} opts.openSettings
     */
    constructor({ app, getAgent, getOpenAgents, activate, openSettings }) {
        this.app = app;
        this.getAgent = getAgent;
        this.getOpenAgents = getOpenAgents;
        this.activate = activate;
        this.openSettings = openSettings;
        this.p = 0;            // 0 = fechada, 1 = aberta
        this.stop = null;      // cancela a mola em andamento
        this.showAll = false;
        this.query = '';
        this.pins = [];
        this.history = null;   // null = carregando
        this.historyError = null;

        this.el = document.createElement('aside');
        this.el.className = 'cv-drawer';
        this.el.setAttribute('aria-label', 'Conversas');
        this.el.inert = true;
        this.el.innerHTML = `
            <header class="cv-head">
                <h2 class="cv-title"></h2>
                <button type="button" class="cv-circle" data-cv="search" aria-label="Buscar conversas">${icon('search', 20)}</button>
            </header>
            <div class="cv-search" hidden>
                <input type="search" placeholder="Buscar conversas" autocomplete="off" spellcheck="false" aria-label="Buscar conversas">
            </div>
            <nav class="cv-list" aria-label="Conversas"></nav>
            <footer class="cv-foot">
                <button type="button" class="cv-avatar" data-cv="settings" aria-label="Configurações"></button>
                <button type="button" class="cv-new" data-cv="new">${icon('plus', 18)}<span>Nova conversa</span></button>
            </footer>`;
        document.body.appendChild(this.el);
        this.dim = document.createElement('div');
        this.dim.className = 'cv-dim';
        this.dim.hidden = true;
        app.appendChild(this.dim);
        this.list = this.el.querySelector('.cv-list');
        this.searchBox = this.el.querySelector('.cv-search');
        this.searchInput = this.searchBox.querySelector('input');
        const initials = window.appConfig?.userInitials;
        this.el.querySelector('.cv-avatar').innerHTML = initials ? esc(initials) : icon('settings', 20);

        this.bindUi();
        this.bindGesture();
    }

    get width() {
        return this.el.getBoundingClientRect().width || Math.min(window.innerWidth * 0.78, 360);
    }

    get isOpen() {
        return this.p > 0.5;
    }

    /** Só no layout de celular em retrato e com uma aba de agente ativa. */
    available() {
        return root.hasAttribute('data-iphone') && matchMedia('(orientation: portrait)').matches && !!this.getAgent();
    }

    // ---------- posição ----------

    setP(p) {
        this.p = Math.max(0, Math.min(1, p));
        const x = this.p * this.width;
        if (this.p > 0) {
            this.app.classList.add('cv-pushed');
            this.app.style.transform = `translate3d(${x}px, 0, 0)`;
            this.app.style.setProperty('--cv-p', this.p.toFixed(3));
            this.dim.hidden = false;
            this.el.style.setProperty('--cv-p', this.p.toFixed(3));
        } else {
            this.app.classList.remove('cv-pushed');
            this.app.style.transform = '';
            this.app.style.removeProperty('--cv-p');
            this.dim.hidden = true;
        }
        this.el.inert = this.p < 0.5;
    }

    animateTo(target, velocity = 0) {
        this.stop?.();
        if (reducedMotion()) {
            // Sem deslize: cross-fade curto (apple-design §14)
            this.el.classList.add('cv-fade');
            this.setP(target);
            setTimeout(() => this.el.classList.remove('cv-fade'), 200);
            return;
        }
        // velocidade em px/s → em "p por segundo"
        this.stop = springTo(this.p, target, velocity / this.width, p => this.setP(p), () => { this.stop = null; });
    }

    open() {
        if (!this.available()) return;
        this.render();
        this.load();
        this.animateTo(1);
    }

    close() {
        this.searchInput.blur();
        this.animateTo(0);
    }

    toggle() {
        if (this.isOpen) this.close();
        else this.open();
    }

    /** A aba ativa deixou de ser de agente (ou o celular girou): fecha sem animar. */
    sync() {
        if (this.p > 0 && !this.available()) {
            this.stop?.();
            this.setP(0);
        }
    }

    // ---------- dados ----------

    async load() {
        const agent = this.getAgent();
        if (!agent) return;
        this.historyError = null;
        if (!agent.historyCache) this.history = null;
        this.render();
        const [history, pins] = await Promise.allSettled([agent.fetchHistory(), pinsApi('GET')]);
        if (this.getAgent() !== agent) return;
        if (pins.status === 'fulfilled') this.pins = pins.value;
        if (history.status === 'fulfilled') this.history = history.value;
        else { this.history = []; this.historyError = history.reason?.message || 'indisponível'; }
        this.render();
    }

    async togglePin(id) {
        const next = this.pins.includes(id) ? this.pins.filter(p => p !== id) : [id, ...this.pins];
        const before = this.pins;
        this.pins = next;
        this.render();
        try {
            this.pins = await pinsApi('PUT', next);
        } catch (e) {
            this.pins = before;
            toast(`Não foi possível salvar: ${e.message}`, { tone: 'error' });
        }
        this.render();
    }

    // ---------- desenho ----------

    render() {
        const agent = this.getAgent();
        this.el.querySelector('.cv-title').textContent = agent?.session?.agentLabel || 'Conversas';
        if (!agent) { this.list.innerHTML = ''; return; }
        const current = agent.session?.acpSessionId || null;
        const q = this.query.trim().toLowerCase();
        const all = this.history || [];
        // A conversa atual sempre aparece, mesmo nova (ainda fora do histórico do agente)
        const known = new Set(all.map(h => h.sessionId));
        const rows = current && !known.has(current)
            ? [{ sessionId: current, title: agent.session?.title || 'Nova conversa', updatedAt: null }, ...all] : all;
        const match = h => !q || (h.title || '').toLowerCase().includes(q);
        const pinned = rows.filter(h => this.pins.includes(h.sessionId) && match(h));
        const recent = rows.filter(h => !this.pins.includes(h.sessionId) && match(h));
        const limit = this.showAll || q ? recent.length : RECENT_LIMIT;

        const row = h => `
            <li><button type="button" class="cv-row${h.sessionId === current ? ' is-current' : ''}" data-id="${esc(h.sessionId)}"
                ${h.sessionId === current ? 'aria-current="true"' : ''}>
                ${BUBBLE_ICON}<span class="cv-row-title">${esc(h.title || 'Sem título')}</span>
            </button></li>`;
        let html = '';
        if (pinned.length) html += `<h3 class="cv-section">Fixadas</h3><ul class="cv-ul">${pinned.map(row).join('')}</ul>`;
        html += `<h3 class="cv-section">Recentes</h3>`;
        if (this.history === null) {
            html += '<p class="cv-note">Carregando conversas…</p>';
        } else if (!agent.hasHistory) {
            html += '<p class="cv-note">Este agente não lista conversas anteriores.</p>';
        } else if (!recent.length) {
            html += `<p class="cv-note">${q ? 'Nenhuma conversa encontrada.' : 'Nenhuma conversa anterior nesta pasta.'}</p>`;
        } else {
            html += `<ul class="cv-ul">${recent.slice(0, limit).map(row).join('')}</ul>`;
            if (recent.length > limit) html += `<button type="button" class="cv-more" data-cv="all">Ver tudo ${icon('chevronRight', 16)}</button>`;
        }
        if (this.historyError) html += `<p class="cv-note">Histórico indisponível: ${esc(this.historyError)}</p>`;
        this.list.innerHTML = html;
    }

    pick(id) {
        const agent = this.getAgent();
        if (!agent) return;
        this.close();
        if (id === agent.session?.acpSessionId) return;
        // Já aberta em outra aba: mostra essa aba em vez de abrir outra igual
        const open = this.getOpenAgents().find(a => a.session?.acpSessionId === id);
        if (open) return this.activate(open.id);
        const h = (this.history || []).find(x => x.sessionId === id);
        agent.startConversation({ resumeAcpSessionId: id, title: h?.title || null });
    }

    bindUi() {
        let pressTimer = null;
        let pressed = null;
        this.list.addEventListener('pointerdown', e => {
            const btn = e.target.closest('.cv-row');
            if (!btn) return;
            pressed = btn;
            clearTimeout(pressTimer);
            pressTimer = setTimeout(() => {
                pressed = null;
                const id = btn.dataset.id;
                const pinnedNow = this.pins.includes(id);
                showMenu([{ label: pinnedNow ? 'Desafixar' : 'Fixar', icon: 'pin', run: () => this.togglePin(id) }],
                    { anchor: btn, label: 'Conversa' });
            }, LONG_PRESS_MS);
        });
        const cancelPress = () => clearTimeout(pressTimer);
        this.list.addEventListener('pointerup', cancelPress);
        this.list.addEventListener('pointercancel', () => { cancelPress(); pressed = null; });
        this.list.addEventListener('pointermove', e => { if (Math.abs(e.movementY) > 2) { cancelPress(); } });
        this.list.addEventListener('contextmenu', e => e.preventDefault());
        this.el.addEventListener('click', e => {
            const btn = e.target.closest('.cv-row, [data-cv]');
            if (!btn) return;
            if (btn.classList.contains('cv-row')) {
                if (pressed !== btn) return; // virou toque longo (menu)
                pressed = null;
                this.pick(btn.dataset.id);
                return;
            }
            const act = btn.dataset.cv;
            if (act === 'new') { this.close(); this.getAgent()?.startConversation({}); }
            else if (act === 'settings') { this.close(); this.openSettings(btn); }
            else if (act === 'all') { this.showAll = true; this.render(); }
            else if (act === 'search') {
                this.searchBox.hidden = !this.searchBox.hidden;
                if (!this.searchBox.hidden) this.searchInput.focus();
                else { this.query = ''; this.searchInput.value = ''; this.render(); }
            }
        });
        this.searchInput.addEventListener('input', () => { this.query = this.searchInput.value; this.render(); });
        this.dim.addEventListener('click', () => this.close());
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && this.isOpen && !document.querySelector('.menu')) { e.preventDefault(); this.close(); }
        });
        window.addEventListener('resize', () => this.sync());
    }

    // ---------- gesto ----------

    /**
     * Arrastar da esquerda para a direita no chat abre; com a lista aberta, arrastar para a
     * esquerda (na lista ou no chat) fecha. Não rouba gestos de quem rola na horizontal (código,
     * tabelas) nem de campos de texto.
     */
    bindGesture() {
        let g = null; // { x, y, p0, decided, horizontal, samples }
        const ignore = t => !!t.closest?.('input, textarea, select, [contenteditable="true"], .menu, .ag-sheet, dialog')
            || (() => { // um bloco rolado na horizontal fica com o gesto
                for (let el = t; el && el !== document.body; el = el.parentElement) {
                    if (el.scrollWidth > el.clientWidth + 2 && el.scrollLeft > 0 && getComputedStyle(el).overflowX !== 'visible') return true;
                }
                return false;
            })();

        const start = e => {
            if (e.pointerType === 'mouse' || !this.available() || g) return;
            const inDrawer = this.el.contains(e.target);
            const inChat = this.app.contains(e.target) && !!e.target.closest?.('.ag-panel, .cv-dim, .agent-panel, [data-kind="agent"], .ag-main');
            if (!inDrawer && !inChat && !(this.p > 0 && this.app.contains(e.target))) return;
            if (!inDrawer && this.p === 0 && ignore(e.target)) return;
            this.stop?.();
            g = { x: e.clientX, y: e.clientY, p0: this.p, decided: false, horizontal: false, samples: [[e.clientX, e.timeStamp]], id: e.pointerId };
        };
        const move = e => {
            if (!g || e.pointerId !== g.id) return;
            const dx = e.clientX - g.x;
            const dy = e.clientY - g.y;
            if (!g.decided) {
                if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
                g.decided = true;
                // horizontal, e no sentido que muda algo (abrir se fechada, fechar se aberta)
                g.horizontal = Math.abs(dx) > Math.abs(dy) * 1.2 && (g.p0 > 0 ? true : dx > 0);
                if (!g.horizontal) { g = null; return; }
                this.render();
                if (g.p0 === 0) this.load();
                this.el.classList.add('cv-dragging');
            }
            if (!g.horizontal) return;
            e.preventDefault();
            g.samples.push([e.clientX, e.timeStamp]);
            if (g.samples.length > 6) g.samples.shift();
            let p = g.p0 + dx / this.width;
            // Resistência elástica além do aberto (apple-design §9)
            if (p > 1) p = 1 + (p - 1) * 0.15;
            this.setP(Math.min(p, 1.06));
        };
        const end = e => {
            if (!g || e.pointerId !== g.id) return;
            const done = g;
            g = null;
            this.el.classList.remove('cv-dragging');
            if (!done.horizontal) return;
            const [a, b] = [done.samples[0], done.samples[done.samples.length - 1]];
            const v = b[1] > a[1] ? ((b[0] - a[0]) / (b[1] - a[1])) * 1000 : 0; // px/s
            const projected = this.p * this.width + project(v);
            const target = e.type === 'pointercancel' ? done.p0 : (projected > this.width / 2 ? 1 : 0);
            if (target === 1) this.render();
            this.animateTo(target, v);
        };
        document.addEventListener('pointerdown', start, { capture: true });
        document.addEventListener('pointermove', move, { capture: true, passive: false });
        document.addEventListener('pointerup', end, { capture: true });
        document.addEventListener('pointercancel', end, { capture: true });
    }
}
