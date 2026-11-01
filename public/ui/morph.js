/**
 * morph.js
 * iOS 26 presentation: a sheet grows out of the control that opened it (the session pill, the
 * composer's model button, ⋮) and shrinks back into it when closed, on a spring. Done as a FLIP
 * with the Web Animations API: the sheet starts with the source's box and springs to its own,
 * while its content fades in a little later (the glass morphs first, then the content appears).
 * Phone layout only; with reduced motion, or no source on screen, the sheets keep their plain
 * slide-up (the .open class in styles.css).
 */

const root = document.documentElement;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches || root.hasAttribute('data-reduced-motion');
const token = (name, fallback) => getComputedStyle(root).getPropertyValue(name).trim() || fallback;
const ms = (name, fallback) => parseFloat(token(name, '')) || fallback;

/** Can this sheet morph from `source` right now? */
export function canMorph(source) {
    if (!source || !source.isConnected || !root.hasAttribute('data-iphone') || reducedMotion()) return false;
    if (typeof Element.prototype.animate !== 'function') return false;
    const r = source.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}

/** The transform that puts `target` exactly over `source` (center to center, size to size). */
function flip(source, target) {
    const s = source.getBoundingClientRect();
    const t = target.getBoundingClientRect();
    if (!t.width || !t.height) return null;
    const dx = s.left + s.width / 2 - (t.left + t.width / 2);
    const dy = s.top + s.height / 2 - (t.top + t.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${s.width / t.width}, ${s.height / t.height})`;
}

/**
 * Opens `sheet` out of `source`. Call after the sheet is laid out in its final place (with its
 * slide-up transform disabled - the backdrop gets the "morph" class for that).
 * @param {HTMLElement} sheet
 * @param {HTMLElement} source
 * @param {HTMLElement} [content] - what fades in once the glass has grown
 */
export function morphIn(sheet, source, content) {
    const from = flip(source, sheet);
    if (!from) return;
    const duration = ms('--spring-smooth-dur', 450);
    sheet.animate([
        { transform: from, opacity: 0.5 },
        { transform: 'none', opacity: 1 },
    ], { duration, easing: token('--spring-smooth', 'cubic-bezier(0.2, 0.9, 0.25, 1)') });
    content?.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: duration * 0.55, delay: duration * 0.3, easing: 'ease-out', fill: 'backwards',
    });
}

/**
 * Closes `sheet` back into `source`.
 * @returns {Promise<void>} resolves when the sheet is gone (remove/hide it then)
 */
export function morphOut(sheet, source, content) {
    const to = flip(source, sheet);
    if (!to) return Promise.resolve();
    content?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: 'ease-in', fill: 'forwards' });
    const anim = sheet.animate([
        { transform: 'none', opacity: 1 },
        { transform: to, opacity: 0 },
    ], { duration: 280, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards' });
    return anim.finished.then(() => {}, () => {});
}

/**
 * Shows a sheet backdrop (`.ag-sheet-backdrop`, already in the DOM and not hidden): morphing out
 * of `source` when possible, else the usual slide-up.
 */
export function present(backdrop, source, content) {
    const sheet = backdrop.querySelector('.ag-sheet');
    const morph = canMorph(source);
    backdrop.classList.toggle('morph', morph);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        backdrop.classList.add('open');
        if (morph) morphIn(sheet, source, content);
    }));
}

/**
 * Hides a sheet backdrop: back into `source` when possible, else the usual slide-down.
 * @param {() => void} done - remove or hide the backdrop
 */
export function dismiss(backdrop, source, done, content) {
    const sheet = backdrop.querySelector('.ag-sheet');
    backdrop.classList.remove('open');
    if (backdrop.classList.contains('morph') && canMorph(source)) {
        morphOut(sheet, source, content).then(() => {
            backdrop.classList.remove('morph');
            sheet.getAnimations().forEach(a => a.cancel());
            done();
        });
        return;
    }
    backdrop.classList.remove('morph');
    setTimeout(done, 300);
}
