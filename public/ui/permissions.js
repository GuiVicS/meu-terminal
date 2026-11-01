/**
 * permissions.js
 * Permissões do aparelho para o app funcionar 100%: notificações, colar (área de transferência),
 * microfone (ditado), armazenamento que o sistema não apaga, tela ligada e feedback tátil.
 * "Permitir tudo" pede cada uma dentro do mesmo toque (os navegadores só perguntam assim).
 * Aparece uma vez quando o app é aberto instalado (tela inicial) e fica em Configurações →
 * Permissões. Nada é pedido sem o toque do usuário.
 */
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { haptic, hapticsSupported } from './haptics.js';
import { enablePush } from '../managers/push.js';

const SEEN_KEY = 'meuterminal-permissoes-vistas';
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

async function query(name) {
    try {
        return (await navigator.permissions.query({ name })).state; // granted | denied | prompt
    } catch {
        return null; // o navegador não informa
    }
}

/** Cada permissão: como saber o estado e como pedir. */
const ITEMS = [
    {
        id: 'notificacoes', icon: 'bell', title: 'Notificações',
        help: 'Avisos quando o agente termina, pede permissão ou um comando acaba.',
        supported: () => 'Notification' in window,
        state: async () => (typeof Notification === 'undefined' ? null : Notification.permission === 'default' ? 'prompt' : Notification.permission),
        // Pede a permissão e já registra o aparelho para os avisos (managers/push.js)
        request: async () => { await enablePush(); },
        note: () => (isIOS() && !standalone() ? 'No iPhone, só funciona com o app adicionado à Tela de Início.' : ''),
    },
    {
        id: 'colar', icon: 'clipboard', title: 'Colar (área de transferência)',
        help: 'Colar no terminal e no chat pelo botão de colar, sem passar por menus.',
        supported: () => !!navigator.clipboard?.readText && window.isSecureContext,
        state: async () => query('clipboard-read'),
        request: async () => { await navigator.clipboard.readText().catch(() => {}); },
        note: () => (isIOS() ? 'O iPhone confirma com o balão "Colar" a cada vez: é do sistema, não dá para liberar de vez.' : ''),
    },
    {
        id: 'microfone', icon: 'mic', title: 'Microfone',
        help: 'Ditado por voz no chat dos agentes e no terminal.',
        supported: () => !!navigator.mediaDevices?.getUserMedia,
        state: async () => query('microphone'),
        request: async () => {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(t => t.stop()); // só a permissão: não grava nada
        },
    },
    {
        id: 'armazenamento', icon: 'hardDrive', title: 'Guardar dados no aparelho',
        help: 'O sistema não apaga o cache do app (abre mais rápido e funciona sem internet).',
        supported: () => !!navigator.storage?.persist,
        state: async () => ((await navigator.storage.persisted?.()) ? 'granted' : 'prompt'),
        request: async () => { await navigator.storage.persist(); },
    },
    {
        id: 'tela', icon: 'sun', title: 'Manter a tela ligada',
        help: 'A tela não apaga enquanto um agente ou comando está rodando com o app aberto.',
        supported: () => 'wakeLock' in navigator,
        state: async () => (localStorage.getItem('meuterminal-wakelock') === '1' ? 'granted' : 'prompt'),
        request: async () => {
            const lock = await navigator.wakeLock.request('screen');
            await lock.release();
            localStorage.setItem('meuterminal-wakelock', '1');
        },
    },
    {
        id: 'tatil', icon: 'smartphone', title: 'Feedback tátil',
        help: 'Vibração leve ao tocar em botões, abrir menus e enviar mensagens.',
        supported: hapticsSupported,
        state: async () => (JSON.parse(localStorage.getItem('meuterminal-settings') || '{}').haptics === false ? 'prompt' : 'granted'),
        request: async () => {
            const s = JSON.parse(localStorage.getItem('meuterminal-settings') || '{}');
            s.haptics = true;
            localStorage.setItem('meuterminal-settings', JSON.stringify(s));
            haptic('success');
        },
        note: () => (isIOS() ? 'No iPhone precisa do iOS 18 ou mais novo.' : ''),
    },
];

const LABEL = { granted: ['on', 'Permitido'], denied: ['err', 'Bloqueado'], prompt: ['', 'Não pedido'] };

/** Mantém a tela ligada enquanto algum agente trabalha (se liberado em Permissões). */
let wakeLock = null;
const busyIds = new Set();
export async function keepScreenOn(id, busy) {
    if (busy) busyIds.add(id); else busyIds.delete(id);
    const on = busyIds.size > 0;
    if (!('wakeLock' in navigator) || localStorage.getItem('meuterminal-wakelock') !== '1') return;
    try {
        if (on && !wakeLock && document.visibilityState === 'visible') {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
        } else if (!on && wakeLock) {
            await wakeLock.release();
            wakeLock = null;
        }
    } catch { /* o sistema recusou (bateria fraca, aba escondida) */ }
}

/** Monta a lista de permissões num elemento (Configurações e a tela de boas-vindas). */
export function mountPermissions(el, { onDone } = {}) {
    const items = ITEMS.filter(i => i.supported());
    el.innerHTML = `
        <p class="setting-help">Para o MeuTerminal funcionar 100% no aparelho. Nada é pedido sem o seu toque.</p>
        <button type="button" class="pm-all" data-pm-all>${icon('check', 18)}<span>Permitir tudo</span></button>
        <ul class="pm-list">${items.map(i => `
            <li class="pm-row" data-pm="${i.id}">
                <span class="pm-ic">${icon(i.icon, 18)}</span>
                <span class="pm-txt"><b>${i.title}</b><small>${i.help}</small>${i.note?.() ? `<small class="pm-note">${i.note()}</small>` : ''}</span>
                <span class="pm-state"></span>
                <button type="button" class="btn btn-sm" data-pm-ask="${i.id}">Permitir</button>
            </li>`).join('')}</ul>
        <p class="setting-help pm-blocked" hidden>Bloqueado? Libere nos ajustes do navegador para este site (no iPhone: Ajustes → Safari → Avançado / ou toque em "aA" na barra de endereço).</p>`;

    async function refresh() {
        let anyBlocked = false;
        for (const i of items) {
            const row = el.querySelector(`[data-pm="${i.id}"]`);
            const st = (await i.state().catch(() => null)) || 'prompt';
            const [cls, label] = LABEL[st] || LABEL.prompt;
            // Ainda não pedido: só o botão "Permitir" (o texto ao lado espremia a descrição)
            row.querySelector('.pm-state').innerHTML = st === 'prompt' ? '' : `<span class="ad-dot ${cls}"></span> ${label}`;
            row.querySelector('[data-pm-ask]').hidden = st === 'granted';
            if (st === 'denied') anyBlocked = true;
        }
        el.querySelector('.pm-blocked').hidden = !anyBlocked;
    }

    async function ask(item) {
        try { await item.request(); } catch { /* recusou ou o sistema não deixou */ }
    }

    el.addEventListener('click', async e => {
        const one = e.target.closest('[data-pm-ask]');
        if (one) {
            haptic('light');
            await ask(items.find(i => i.id === one.dataset.pmAsk));
            await refresh();
            return;
        }
        if (e.target.closest('[data-pm-all]')) {
            haptic('medium');
            // Todas no mesmo toque, em sequência (os navegadores só perguntam dentro de um toque)
            for (const i of items) {
                if (((await i.state().catch(() => null)) || 'prompt') === 'granted') continue;
                await ask(i);
            }
            await refresh();
            localStorage.setItem(SEEN_KEY, '1');
            onDone?.();
        }
    });
    refresh();
}

/** Primeira abertura do app instalado: oferece as permissões uma vez. */
export function offerPermissionsOnce() {
    if (localStorage.getItem(SEEN_KEY) || !standalone()) return;
    localStorage.setItem(SEEN_KEY, '1');
    const sheet = openSheet({ title: 'Deixe o app funcionar 100%', className: 'pm-sheet' });
    mountPermissions(sheet.body, { onDone: () => setTimeout(() => sheet.close(), 900) });
}
