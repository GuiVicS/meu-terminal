/**
 * toast.js
 * Small, non-blocking notifications for errors and confirmations.
 * Uses one aria-live region so screen readers announce them without stealing focus.
 */

let region;

function ensureRegion() {
    if (region) return region;
    region = document.createElement('div');
    region.className = 'toast-region';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.appendChild(region);
    return region;
}

/**
 * @param {string} message
 * @param {{ tone?: 'info'|'error', action?: { label: string, run: () => void }, duration?: number }} opts
 */
export function toast(message, { tone = 'info', action = null, duration = 4000 } = {}) {
    const el = document.createElement('div');
    el.className = `toast toast-${tone}`;
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);

    const close = () => {
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 150);
    };

    if (action) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toast-action';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
            action.run();
            close();
        });
        el.appendChild(btn);
    }

    ensureRegion().appendChild(el);
    setTimeout(close, duration);
}
