/**
 * icons.js
 * Inline stroke icons (Tabler-style, same family already used by the app).
 * Kept as path strings so every icon shares one stroke width and size.
 */

const PATHS = {
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18"/><path d="M6 6l12 12"/>',
    search: '<circle cx="10" cy="10" r="7"/><path d="M21 21l-6-6"/>',
    maximize: '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M4 16v2a2 2 0 0 0 2 2h2"/>'
        + '<path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M16 20h2a2 2 0 0 0 2-2v-2"/>',
    minimize: '<path d="M15 19v-2a2 2 0 0 1 2-2h2"/><path d="M15 5v2a2 2 0 0 0 2 2h2"/>'
        + '<path d="M5 15h2a2 2 0 0 1 2 2v2"/><path d="M5 9h2a2 2 0 0 0 2-2V5"/>',
    focus: '<path d="M4 6h16"/><path d="M4 18h16"/><rect x="6" y="9" width="12" height="6" rx="1"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/>'
        + '<path d="M4.9 4.9l1.4 1.4"/><path d="M17.7 17.7l1.4 1.4"/><path d="M2 12h2"/>'
        + '<path d="M20 12h2"/><path d="M4.9 19.1l1.4-1.4"/><path d="M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M12 3a7.5 7.5 0 0 0 8.3 12.4A9 9 0 1 1 12 3z"/>',
    settings: '<path d="M10.3 4.3c.4-1.8 3-1.8 3.4 0a1.7 1.7 0 0 0 2.6 1.1c1.5-.9 3.3.8 2.4 2.4'
        + 'a1.7 1.7 0 0 0 1 2.5c1.8.4 1.8 3 0 3.4a1.7 1.7 0 0 0-1 2.6c.9 1.5-.9 3.3-2.4 2.4a1.7 1.7 0 0 0-2.6 1'
        + 'c-.4 1.8-3 1.8-3.4 0a1.7 1.7 0 0 0-2.6-1c-1.5.9-3.3-.9-2.4-2.4a1.7 1.7 0 0 0-1-2.6'
        + 'c-1.8-.4-1.8-3 0-3.4a1.7 1.7 0 0 0 1-2.5c-.9-1.6.9-3.3 2.4-2.4 1 .6 2.3.1 2.6-1.1z"/>'
        + '<circle cx="12" cy="12" r="3"/>',
    more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    logout: '<path d="M10 8V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-2"/>'
        + '<path d="M15 12H3l3-3"/><path d="M6 15l-3-3"/>',
    terminal: '<path d="M5 7l5 5-5 5"/><path d="M12 19h7"/>',
    pin: '<path d="M15 4.5l-4 4-4 1.5-1.5 1.5 7 7 1.5-1.5 1.5-4 4-4"/><path d="M9 15l-4.5 4.5"/>'
        + '<path d="M14.5 4 20 9.5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    edit: '<path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16v4"/><path d="M13.5 6.5l4 4"/>',
    history: '<path d="M12 8v4l2 2"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/>',
    keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h0"/><path d="M10 10h0"/>'
        + '<path d="M14 10h0"/><path d="M18 10h0"/><path d="M6 14h0"/><path d="M18 14h0"/><path d="M10 14h4"/>',
    folder: '<path d="M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2"/>',
    chevronRight: '<path d="M9 6l6 6-6 6"/>',
    chevronLeft: '<path d="M15 6l-6 6 6 6"/>',
    closeOthers: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 10l4 4m0-4l-4 4"/>',
    arrowRightBar: '<path d="M14 12H4"/><path d="M10 8l4 4-4 4"/><path d="M20 4v16"/>',
    restore: '<path d="M9 14l-4-4 4-4"/><path d="M5 10h11a4 4 0 1 1 0 8h-1"/>',
    gitBranch: '<circle cx="7" cy="18" r="2"/><circle cx="7" cy="6" r="2"/><circle cx="17" cy="6" r="2"/>'
        + '<path d="M7 8v8"/><path d="M9 18h2a6 6 0 0 0 6-6V8"/>',
    list: '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M5 6h0"/>'
        + '<path d="M5 12h0"/><path d="M5 18h0"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/>'
        + '<path d="M12 18v3"/><path d="M8 21h8"/>',
};

/**
 * Returns the SVG markup for an icon. Icons are decorative (aria-hidden):
 * the button that contains them must carry the accessible label.
 * @param {string} name - Icon key
 * @param {number} size - Pixel size
 */
export function icon(name, size = 16) {
    return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" `
        + `stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" `
        + `aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
}
