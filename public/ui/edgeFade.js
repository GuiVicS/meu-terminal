/**
 * edgeFade.js
 * O conteúdo fica cada vez mais desfocado ao chegar no topo de uma área rolável, em vez de ser cortado.
 * Só age se ainda há conteúdo acima. O desfoque vem de camadas sobre a área (.ag-edge); a máscara do
 * CSS (.edge-fade) é a versão leve, para quem não aguenta o desfoque.
 */
const LAYERS = '<i></i><i></i><i></i><i></i>';
const EDGE_HEIGHT = 110; // a mesma rampa do topo do chat
const COVER_EXTRA = 60;

function edgeLayer(side) {
    const layer = document.createElement('div');
    layer.className = `ag-edge edge-auto edge-auto-${side}`;
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = LAYERS;
    return layer;
}

const atScroller = el => () => ({
    top: el.scrollTop > 2,
    bottom: el.scrollHeight - el.scrollTop - el.clientHeight > 2,
});

/**
 * @param {HTMLElement} el - onde a máscara é aplicada
 * @param {object} [opts]
 * @param {() => {top: boolean, bottom: boolean}} [opts.read] - o padrão lê a rolagem do próprio elemento
 * @param {EventTarget} [opts.scroller] - quem avisa da rolagem (o padrão é o próprio elemento)
 * @param {boolean} [opts.observe] - acompanhar sozinho mudanças de tamanho e de conteúdo
 * @param {boolean} [opts.overlay] - criar a camada de desfoque (a conversa tem a dela)
 * @param {HTMLElement} [opts.cover] - o desfoque vai de ponta a ponta deste elemento (o terminal tem margens)
 * @returns {{ schedule: () => void, destroy: () => void }}
 */
export function attachEdgeFade(el, { read = atScroller(el), scroller = el, observe = true, overlay = true, cover = null } = {}) {
    el.classList.add('edge-fade');
    let frame = 0;
    let topLayer = null;
    // A barra pode ser a nativa (da área ou de quem rola por ela) ou a desenhada pelo terminal
    const barWidth = () => {
        const own = el.offsetWidth - el.clientWidth;
        const outer = scroller !== el && scroller.offsetWidth ? scroller.offsetWidth - scroller.clientWidth : 0;
        const drawn = el.querySelector?.(':scope .xterm-scrollable-element > .scrollbar.vertical')?.offsetWidth || 0;
        return Math.max(own, outer, drawn);
    };
    const place = () => {
        const parent = cover || el.parentElement;
        if (!parent || !el.offsetWidth) return;
        if (!topLayer) {
            topLayer = edgeLayer('top');
            if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
            parent.append(topLayer);
        }
        const box = parent.getBoundingClientRect();
        const area = el.getBoundingClientRect();
        // Com "cover", vai de ponta a ponta da área, colado no topo dela; a barra de rolagem nunca desfoca
        const left = cover ? 0 : area.left - box.left + parent.scrollLeft;
        const top = cover ? 0 : area.top - box.top + parent.scrollTop;
        const right = area.right - box.left - barWidth();
        // Com "cover", a rampa termina logo abaixo da barra de abas: quase todas as linhas ficam legíveis
        const height = cover ? area.top - box.top + COVER_EXTRA : Math.min(EDGE_HEIGHT, el.offsetHeight / 3);
        Object.assign(topLayer.style, {
            top: `${top}px`, left: `${left}px`, width: `${Math.max(0, right - left)}px`, height: `${height}px`,
            borderRadius: cover ? '0' : getComputedStyle(el).borderTopLeftRadius, // listas com cantos arredondados
        });
    };
    const apply = () => {
        frame = 0;
        const { top, bottom } = read();
        el.toggleAttribute('data-fade-top', top);
        el.toggleAttribute('data-fade-bottom', bottom);
        if (overlay) {
            place();
            topLayer?.toggleAttribute('data-on', top);
        }
    };
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(apply);
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    const size = observe || overlay ? new ResizeObserver(schedule) : null;
    size?.observe(el);
    const content = observe ? new MutationObserver(schedule) : null;
    content?.observe(el, { childList: true, subtree: true });
    schedule();
    return {
        schedule,
        destroy() {
            cancelAnimationFrame(frame);
            scroller.removeEventListener('scroll', schedule);
            size?.disconnect();
            content?.disconnect();
            topLayer?.remove();
        },
    };
}

// Áreas roláveis que nascem e somem com as telas. O navegador embutido fica de fora
const SCROLL_AREAS = '.fm-list, .nt-list, .nt-write, .st-page, .st-index, .admin-main, .ag-viewer-body:not(.is-frame), .cp-list, .fp-list, .ag-side';

let watching = false;

export function watchScrollAreas() {
    if (watching) return; // o início do app pode rodar mais de uma vez
    watching = true;
    const attached = new WeakSet();
    let queued = false;
    const scan = () => {
        queued = false;
        document.querySelectorAll(SCROLL_AREAS).forEach(el => {
            if (attached.has(el) || el.closest('.browser-panel, .lens-mirror')) return;
            attached.add(el);
            attachEdgeFade(el);
        });
    };
    new MutationObserver(records => {
        if (queued || !records.some(r => r.addedNodes.length)) return;
        queued = true;
        requestAnimationFrame(scan);
    }).observe(document.body, { childList: true, subtree: true });
    scan();
}

/** A altura da barra de abas, para o conteúdo passar atrás dela. */
export function watchTopbarHeight() {
    const topbar = document.querySelector('.topbar');
    if (!topbar || typeof ResizeObserver === 'undefined') return;
    const apply = () => document.documentElement.style.setProperty('--ag-topbar-h', `${topbar.offsetHeight}px`);
    new ResizeObserver(apply).observe(topbar);
    apply();
}
