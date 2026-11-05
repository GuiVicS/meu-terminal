/**
 * edgeBlur.js
 * Lente e desfoque pesam em aparelho mais fraco. Mede a fluidez enquanto eles estão à vista e, se
 * travar, reduz por etapas, sempre avisando: primeiro tira a lente, que é o mais pesado; se ainda
 * travar, tira o desfoque (fica a película e o esmaecimento).
 */
import { toast } from './toast.js';

const SAMPLE_MS = 1000;
const MIN_FPS = 15;
const STRIKES = 2;
const SAMPLES = 3;
const RETRY_MS = 3000;
const FIRST_SAMPLE_MS = 4000; // a abertura da conversa ocupa o aparelho, e isso não é o efeito pesando

const root = document.documentElement;
let started = false;

const visible = () => document.visibilityState === 'visible'
    && !!document.querySelector('.agent-panel.active:not(.ag-is-empty) .ag-edge-top, .edge-auto[data-on]');

export function watchEdgeBlur() {
    if (started) return;
    started = true;
    let strikes = 0;
    let done = 0;
    let measuring = false;

    /** @returns {boolean} ainda há o que reduzir */
    const reduce = () => {
        strikes = 0;
        done = 0;
        if (document.querySelector('[data-lens]')) {
            root.setAttribute('data-lens-off', '');
            toast('A lente do vidro foi desligada para manter o app fluido.');
            return true;
        }
        root.setAttribute('data-edge-lite', '');
        toast('O desfoque foi reduzido para manter o app fluido.');
        return false;
    };

    const measure = () => {
        if (measuring || root.hasAttribute('data-edge-lite')) return;
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
            if (strikes >= STRIKES) {
                if (reduce()) setTimeout(measure, RETRY_MS);
            } else if (done < SAMPLES) setTimeout(measure, RETRY_MS / 2);
        }, SAMPLE_MS);
    };

    setTimeout(measure, FIRST_SAMPLE_MS);
    // Rolar é o pior caso: mede também na primeira rolagem da conversa
    document.addEventListener('scroll', e => {
        if (!e.target.classList?.contains('ag-log')) return;
        done = Math.min(done, SAMPLES - 1);
        measure();
    }, { capture: true, passive: true });
}
