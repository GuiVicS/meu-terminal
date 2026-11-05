/**
 * liquidGlass.js
 * Vidro líquido (glisse) nas peças que flutuam. No PC com Chromium ele deforma o que passa atrás; no
 * iPhone o Safari não deixa filtrar o fundo vivo, então a lente vem de uma cópia da conversa
 * (lensMirror.js). Nos outros casos o vidro de sempre continua, sem baixar nada. A conversa de propósito não é marcada
 * como fundo do glisse: isso filtraria o chat inteiro a cada quadro enquanto ele rola.
 * O pacote (React + glisse) vem de public/vendor/glisse.bundle.js, carregado depois da tela abrir.
 */
import { attachLens } from './lensMirror.js';

const DESKTOP_TARGETS = '.ag-composer, .tabstrip, .topbar-actions .icon-btn, .menu';
const IPHONE_TARGETS = '.ag-composer, .session-pill, .topbar-actions .icon-btn, .ag-jump, .menu';
// Só onde a conversa passa nítida. No topo ela já vem desfocada: uma cópia ali aparece mais nítida que o entorno
const IPHONE_LENS = '.ag-composer, .ag-jump';
const mounted = new Map(); // peça -> { host, stop }

export function liquidGlassSupported() {
    const root = document.documentElement;
    const place = root.hasAttribute('data-iphone') || (root.hasAttribute('data-desktop') && /Chrom(?:e|ium)\//.test(navigator.userAgent));
    return place
        && !window.matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more)').matches;
}

let started = false;

export async function startLiquidGlass() {
    if (started || !liquidGlassSupported()) return false;
    started = true;
    const base = (window.appConfig?.basePath || '').replace(/\/+$/, '');
    let mountGlass;
    try {
        ({ mountGlass } = await import(`${base}/vendor/glisse.bundle.js`));
    } catch {
        return false; // sem o pacote, fica o vidro de sempre
    }
    document.documentElement.setAttribute('data-liquid', '');
    const iphone = document.documentElement.hasAttribute('data-iphone');
    const targets = iphone ? IPHONE_TARGETS : DESKTOP_TARGETS;

    const scan = () => {
        for (const [el, { host, stop }] of mounted) {
            if (el.isConnected && host.parentElement === el) continue;
            stop();
            host.remove();
            mounted.delete(el);
        }
        document.querySelectorAll(targets).forEach(el => {
            if (mounted.has(el)) return;
            const host = document.createElement('span');
            host.className = 'liquid-host';
            el.prepend(host);
            const stopGlass = mountGlass(host);
            const stopLens = iphone && el.matches(IPHONE_LENS) ? attachLens(el) : null;
            mounted.set(el, { host, stop: () => { stopLens?.(); stopGlass(); } });
        });
    };
    scan();

    // Abas e menus nascem depois. O texto da conversa muda o tempo todo e não interessa aqui
    let queued = false;
    new MutationObserver(records => {
        if (queued) return;
        const relevant = records.some(r => !r.target.closest?.('.ag-log, .liquid-host'));
        if (!relevant) return;
        queued = true;
        requestAnimationFrame(() => {
            queued = false;
            scan();
        });
    }).observe(document.body, { childList: true, subtree: true });
    return true;
}
