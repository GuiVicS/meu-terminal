/**
 * liquidGlass.js
 * Vidro líquido (glisse) nas peças que flutuam, só no PC com Chromium: é o único navegador que
 * deforma o que passa atrás do vidro, então nos outros o vidro de sempre continua, sem baixar nada.
 * O pacote (React + glisse) vem de public/vendor/glisse.bundle.js, carregado depois da tela abrir.
 */
const TARGETS = '.ag-composer, .tabstrip, .topbar-actions .icon-btn, .menu';
const mounted = new Map(); // peça -> { host, stop }

export function liquidGlassSupported() {
    return document.documentElement.hasAttribute('data-desktop')
        && /Chrom(?:e|ium)\//.test(navigator.userAgent)
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

    const scan = () => {
        for (const [el, { host, stop }] of mounted) {
            if (el.isConnected && host.parentElement === el) continue;
            stop();
            host.remove();
            mounted.delete(el);
        }
        document.querySelectorAll(TARGETS).forEach(el => {
            if (mounted.has(el)) return;
            const host = document.createElement('span');
            host.className = 'liquid-host';
            el.prepend(host);
            mounted.set(el, { host, stop: mountGlass(host) });
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
