/**
 * settingsSheet.js
 * Configurações inside the app on phones (docs/ANALISE-UX.md, R2): a sheet with the list of
 * sections, like iOS Settings; tapping one shows it, "‹ Configurações" goes back. It mounts the
 * very same sections as /admin and the desktop popup (mountSettingsSections), so nothing is
 * duplicated - but the user never leaves the app (going to /admin reloads every tab).
 * Backup and Webhooks stay on the full /admin page, linked at the bottom. Complementos and Ponte
 * com o Claude use the same modules as /admin, mounted the first time they are opened.
 */
import { icon } from './icons.js';
import { openSheet } from './sheet.js';
import { mountSettingsSections } from './dialogs.js';

const SECTIONS = [
    { slug: 'comandos', label: 'Comandos rápidos', icon: 'bolt', color: 'yellow' },
    { slug: 'terminal', label: 'Terminal', icon: 'terminal', color: 'green' },
    { slug: 'interface', label: 'Interface', icon: 'monitor', color: 'blue' },
    { slug: 'sessoes', label: 'Sessão', icon: 'history', color: 'cyan' },
    { slug: 'aparelhos', label: 'Aparelhos', icon: 'smartphone', color: 'orange' },
    { slug: 'notificacoes', label: 'Notificações', icon: 'bell', color: 'pink' },
    { slug: 'agentes', label: 'Agentes', icon: 'bot', color: 'purple' },
    // Same modules as /admin, loaded on first open (they talk to the server)
    { slug: 'complementos', label: 'Complementos', icon: 'grid', color: 'cyan', mount: async el => (await import('../admin/addons.js')).mountAddonsSection(el) },
    { slug: 'ponte', label: 'Ponte com o Claude', icon: 'link', color: 'orange', mount: async el => (await import('../admin/remote.js')).mountRemoteSection(el) },
];

let current = null;

/**
 * @param {object} opts
 * @param {import('../managers/settings.js').default} opts.settings
 * @param {() => any} opts.getSession
 * @param {import('../managers/commands.js').default} opts.commands
 * @param {string} [opts.section] - open straight at this section (e.g. 'comandos')
 * @param {HTMLElement} [opts.source] - the button that opened it (the sheet grows out of it)
 */
export function openSettingsSheet({ settings, getSession, commands, section, source }) {
    current?.close();
    const basePath = (window.appConfig?.basePath || '').replace(/\/+$/, '');
    let sections = null;
    const sheet = openSheet({
        title: 'Configurações',
        className: 'settings-sheet',
        source,
        onClose: () => {
            sections?.stopPair();
            if (current?.sheet === sheet.sheet) current = null;
        },
    });
    current = sheet;

    sheet.body.innerHTML = `
        <nav class="st-index" aria-label="Seções">
            <ul class="st-list">
                ${SECTIONS.map(s => `
                    <li><button type="button" class="st-row" data-slug="${s.slug}" style="--c: var(--c-${s.color})">
                        <span class="st-icon" aria-hidden="true">${icon(s.icon, 18)}</span>
                        <span class="st-label">${s.label}</span>
                        <span class="st-chevron" aria-hidden="true">${icon('chevronRight', 18)}</span>
                    </button></li>`).join('')}
            </ul>
            <ul class="st-list">
                <li><a class="st-row" href="${basePath}/admin#backup" style="--c: var(--c-blue)">
                    <span class="st-icon" aria-hidden="true">${icon('cloudUpload', 18)}</span>
                    <span class="st-label">Backup e webhooks<small>Abre o painel completo</small></span>
                    <span class="st-chevron" aria-hidden="true">${icon('externalLink', 16)}</span>
                </a></li>
            </ul>
        </nav>
        <div class="st-page" hidden></div>`;
    const index = sheet.body.querySelector('.st-index');
    const page = sheet.body.querySelector('.st-page');
    sections = mountSettingsSections(page, { settings, getSession, commands });
    sections.refresh();

    const showIndex = () => {
        page.hidden = true;
        index.hidden = false;
        sheet.setHead('Configurações');
        sheet.sheet.scrollTop = 0;
    };
    const showSection = slug => {
        const meta = SECTIONS.find(s => s.slug === slug);
        if (!meta) return showIndex();
        if (meta.mount && !page.querySelector(`[data-page="${slug}"]`)) {
            const el = document.createElement('section');
            el.className = 'settings-section rm-section';
            el.dataset.page = slug;
            page.appendChild(el);
            meta.mount(el).catch(e => { el.textContent = e.message; });
        }
        page.querySelectorAll('[data-page]').forEach(el => { el.hidden = el.dataset.page !== slug; });
        index.hidden = true;
        page.hidden = false;
        sheet.setHead(meta.label, { label: 'Configurações', run: showIndex });
        sheet.sheet.scrollTop = 0;
    };
    index.addEventListener('click', e => {
        const row = e.target.closest('button.st-row');
        if (row) showSection(row.dataset.slug);
    });
    if (section) showSection(section);
    return sheet;
}
