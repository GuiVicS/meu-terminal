/**
 * lensMirror.js
 * A lente do vidro no iPhone. O Safari não filtra o fundo vivo (backdrop-filter com url()), mas filtra
 * um elemento comum: cada peça leva uma cópia das mensagens que estão atrás dela, deformada por um
 * mapa de deslocamento só perto da borda. Só as mensagens próximas da peça são copiadas, e a cópia
 * acompanha a rolagem da conversa. Fora de uma conversa, ou com o aparelho travando
 * (data-lens-off, ui/edgeBlur.js), a peça volta ao desfoque comum.
 */
const NS = 'http://www.w3.org/2000/svg';
const MARGIN = 500; // copia um pouco além da peça, para a rolagem não refazer a cópia a cada quadro
const REFRESH_MS = 400;
const BAND = 18;

let sequence = 0;
let defs = null;

function svgDefs() {
    if (defs?.isConnected) return defs;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
}

/** Neutro no meio; perto da borda, puxa o fundo para dentro, como a beirada de uma lente. */
export function lensMap(width, height, radius) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    const image = g.createImageData(width, height);
    const r = Math.min(radius, width / 2, height / 2);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const qx = Math.abs(x - width / 2) - (width / 2 - r);
            const qy = Math.abs(y - height / 2) - (height / 2 - r);
            const ex = Math.max(qx, 0);
            const ey = Math.max(qy, 0);
            const d = Math.hypot(ex, ey);
            const edge = ex > 0 && ey > 0 ? r - d : Math.min(width / 2 - Math.abs(x - width / 2), height / 2 - Math.abs(y - height / 2));
            const t = edge >= BAND ? 0 : (1 - Math.max(edge, 0) / BAND) ** 2;
            let nx = 0;
            let ny = 0;
            if (ex > 0 && ey > 0) {
                nx = (ex / d) * Math.sign(x - width / 2);
                ny = (ey / d) * Math.sign(y - height / 2);
            } else if (qx > qy) nx = Math.sign(x - width / 2);
            else ny = Math.sign(y - height / 2);
            const i = (y * width + x) * 4;
            image.data[i] = 128 - nx * t * 127;
            image.data[i + 1] = 128 - ny * t * 127;
            image.data[i + 2] = 128;
            image.data[i + 3] = 255;
        }
    }
    g.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
}

/**
 * @param {HTMLElement} piece
 * @returns {() => void} tira a lente
 */
export function attachLens(piece) {
    const id = `lente-${++sequence}`;
    const filter = document.createElementNS(NS, 'filter');
    filter.id = id;
    for (const [k, v] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' })) filter.setAttribute(k, v);
    const map = document.createElementNS(NS, 'feImage');
    for (const [k, v] of Object.entries({ x: '0', y: '0', width: '100%', height: '100%', preserveAspectRatio: 'none', result: 'mapa' })) map.setAttribute(k, v);
    const displace = document.createElementNS(NS, 'feDisplacementMap');
    for (const [k, v] of Object.entries({ in: 'SourceGraphic', in2: 'mapa', xChannelSelector: 'R', yChannelSelector: 'G' })) displace.setAttribute(k, v);
    filter.append(map, displace);
    svgDefs().appendChild(filter);

    const layer = document.createElement('div');
    layer.className = 'lens-mirror';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.filter = `url(#${id}) blur(5px)`; // o mesmo desfoque do vidro do campo no PC
    const copy = document.createElement('div');
    copy.className = 'ag-log lens-copy';
    copy.inert = true;
    layer.appendChild(copy);
    piece.appendChild(layer);

    let log = null;
    let scrollFrom = null;
    let frame = 0;
    let refreshTimer = 0;
    let stopped = false;

    const refresh = () => {
        refreshTimer = 0;
        if (stopped || !log) return;
        const box = piece.getBoundingClientRect();
        const area = log.getBoundingClientRect();
        const low = box.top - MARGIN;
        const high = box.bottom + MARGIN;
        const span = high - low;
        // Blocos altos (a conversa inteira costuma ser um só) entram vazios, e só os filhos próximos são copiados
        const copyNear = (source, target) => {
            const origin = source.getBoundingClientRect();
            for (const child of source.children) {
                const r = child.getBoundingClientRect();
                if (r.bottom < low || r.top > high || !r.height) continue;
                const open = r.height > span && child.children.length > 0;
                const clone = child.cloneNode(!open);
                if (!open) {
                    clone.querySelectorAll('iframe, video, audio, script').forEach(n => n.remove());
                    clone.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
                }
                clone.removeAttribute('id');
                Object.assign(clone.style, {
                    position: 'absolute', top: `${r.top - origin.top}px`, left: `${r.left - origin.left}px`,
                    width: `${r.width}px`, height: `${r.height}px`, margin: '0', maxWidth: 'none',
                });
                target.appendChild(clone);
                if (open) copyNear(child, clone);
            }
        };
        const fresh = document.createDocumentFragment();
        const holder = document.createElement('div');
        fresh.appendChild(holder);
        // A origem é o início do conteúdo da conversa, não a parte à vista: desconta a rolagem
        const scrollOrigin = { getBoundingClientRect: () => ({ top: area.top - log.scrollTop, left: area.left }), children: log.children };
        copyNear(scrollOrigin, holder);
        const clones = [...holder.children];
        copy.replaceChildren(...clones);
        scrollFrom = log.scrollTop;
    };
    const refreshSoon = () => {
        if (!refreshTimer) refreshTimer = setTimeout(refresh, REFRESH_MS);
    };

    const place = () => {
        frame = 0;
        if (stopped || !log) return;
        const box = piece.getBoundingClientRect();
        const area = log.getBoundingClientRect();
        copy.style.width = `${log.clientWidth}px`;
        copy.style.transform = `translate(${area.left - box.left}px, ${area.top - box.top - log.scrollTop}px)`;
        if (scrollFrom === null || Math.abs(log.scrollTop - scrollFrom) > MARGIN / 2) refresh();
    };
    const placeSoon = () => {
        if (!frame) frame = requestAnimationFrame(place);
    };

    const changes = new MutationObserver(refreshSoon);

    /** A conversa à vista pode mudar (troca de aba): a lente segue a dela. */
    const follow = () => {
        const lite = document.documentElement.matches('[data-edge-lite], [data-lens-off]');
        const next = lite ? null : document.querySelector('.terminal-panel.active .ag-log:not(.lens-copy)');
        if (next === log) return;
        log?.removeEventListener('scroll', placeSoon);
        changes.disconnect();
        log = next;
        piece.toggleAttribute('data-lens', !!log);
        copy.replaceChildren();
        scrollFrom = null;
        if (!log) return;
        const style = getComputedStyle(log);
        Object.assign(copy.style, { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color });
        log.addEventListener('scroll', placeSoon, { passive: true });
        changes.observe(log, { childList: true, subtree: true, characterData: true });
        refresh();
        placeSoon();
    };
    const followTimer = setInterval(follow, 1000);

    const size = new ResizeObserver(() => {
        const width = Math.round(piece.offsetWidth);
        const height = Math.round(piece.offsetHeight);
        if (!width || !height) return;
        const radius = parseFloat(getComputedStyle(piece).borderTopLeftRadius) || height / 2;
        const url = lensMap(width, height, radius);
        map.setAttribute('href', url);
        map.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
        displace.setAttribute('scale', String(Math.max(16, Math.min(44, height * 0.7))));
        placeSoon();
    });
    size.observe(piece);
    follow();

    return () => {
        stopped = true;
        clearInterval(followTimer);
        clearTimeout(refreshTimer);
        cancelAnimationFrame(frame);
        size.disconnect();
        changes.disconnect();
        log?.removeEventListener('scroll', placeSoon);
        piece.removeAttribute('data-lens');
        layer.remove();
        filter.remove();
    };
}
