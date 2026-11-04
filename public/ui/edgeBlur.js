/**
 * edgeBlur.js
 * O desfoque das pontas da conversa pesa em aparelho sem aceleração de vídeo. Mede a fluidez enquanto
 * ele está à vista: se travar duas vezes, fica a versão leve (película e esmaecimento, sem desfoque).
 */
const SAMPLE_MS = 1000;
const MIN_FPS = 15;
const STRIKES = 2;
const SAMPLES = 3;
const RETRY_MS = 3000;

let started = false;

const visible = () => document.visibilityState === 'visible'
    && !!document.querySelector('.agent-panel.active:not(.ag-is-empty) .ag-edge');

export function watchEdgeBlur() {
    if (started || !document.documentElement.hasAttribute('data-desktop')) return;
    started = true;
    let strikes = 0;
    let done = 0;
    let measuring = false;

    const measure = () => {
        if (measuring || strikes >= STRIKES) return;
        if (!visible()) {
            if (done < SAMPLES) setTimeout(measure, RETRY_MS);
            return;
        }
        measuring = true;
        let frames = 0;
        let running = true;
        const tick = () => {
            frames++;
            if (running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        // Por relógio: se o desenho travou, nenhum quadro chega para avisar
        setTimeout(() => {
            running = false;
            measuring = false;
            if (document.visibilityState !== 'visible') { // quadros param em segundo plano: não conta
                setTimeout(measure, RETRY_MS);
                return;
            }
            done++;
            if (frames < MIN_FPS * (SAMPLE_MS / 1000)) strikes++;
            if (strikes >= STRIKES) document.documentElement.setAttribute('data-edge-lite', '');
            else if (done < SAMPLES) setTimeout(measure, RETRY_MS / 2);
        }, SAMPLE_MS);
    };

    setTimeout(measure, RETRY_MS / 2);
    // Rolar é o pior caso: mede também na primeira rolagem da conversa
    document.addEventListener('scroll', e => {
        if (!e.target.classList?.contains('ag-log')) return;
        done = Math.min(done, SAMPLES - 1);
        measure();
    }, { capture: true, passive: true, once: false });
}
