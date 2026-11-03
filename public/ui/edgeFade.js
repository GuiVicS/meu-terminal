/**
 * edgeFade.js
 * O conteúdo some suavemente nas bordas de uma área rolável, em vez de ser cortado. A borda só esmaece
 * se ainda há conteúdo além dela: no fim da conversa ou na linha do prompt, nada fica apagado. O efeito
 * em si é uma máscara no CSS (.edge-fade); aqui só se liga e desliga cada borda, quando muda.
 */

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
 * @returns {{ schedule: () => void, destroy: () => void }}
 */
export function attachEdgeFade(el, { read = atScroller(el), scroller = el, observe = true } = {}) {
    el.classList.add('edge-fade');
    let frame = 0;
    const apply = () => {
        frame = 0;
        const { top, bottom } = read();
        el.toggleAttribute('data-fade-top', top);
        el.toggleAttribute('data-fade-bottom', bottom);
    };
    const schedule = () => {
        if (!frame) frame = requestAnimationFrame(apply);
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    const size = observe ? new ResizeObserver(schedule) : null;
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
        },
    };
}
