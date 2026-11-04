// Empacotado por scripts/build-glisse.js em public/vendor/glisse.bundle.js.
// O app não usa React: cada peça de vidro é uma pequena raiz React com só o componente Glass.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Glass } from 'glisse';

/**
 * Desenha o vidro dentro de `host`.
 * @param {HTMLElement} host
 * @returns {() => void} tira o vidro
 */
export function mountGlass(host) {
    const root = createRoot(host);
    root.render(createElement(Glass, { 'aria-hidden': true }));
    return () => root.unmount();
}
