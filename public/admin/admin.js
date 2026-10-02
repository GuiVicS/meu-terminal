/**
 * admin.js
 * Entry point for /admin: settings as a full page (sidebar nav, one section at a time) instead
 * of the popup. Reuses the exact same section markup/logic as the popup via
 * mountSettingsSections() in ui/dialogs.js - this file only owns the page shell, the nav/router
 * and the one section the popup doesn't have (Backup).
 */
import SettingsManager from '../managers/settings.js';
import CommandsManager from '../managers/commands.js';
import { mountSettingsSections } from '../ui/dialogs.js';
import { mountWebhooksSection } from './webhooks.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';

const NAV = [
    { slug: 'comandos', label: 'Comandos rápidos', icon: 'bolt' },
    { slug: 'terminal', label: 'Terminal', icon: 'terminal' },
    { slug: 'interface', label: 'Interface', icon: 'monitor' },
    { slug: 'sessoes', label: 'Sessão', icon: 'history' },
    { slug: 'backup', label: 'Backup', icon: 'cloudUpload' },
    { slug: 'webhooks', label: 'Webhooks', icon: 'webhook', flag: 'webhooksAvailable' },
    { slug: 'aparelhos', label: 'Aparelhos', icon: 'smartphone' },
    { slug: 'notificacoes', label: 'Notificações', icon: 'bell' },
    { slug: 'agentes', label: 'Agentes', icon: 'bot' },
];

function basePath() {
    return (window.appConfig?.basePath || '').replace(/\/+$/, '');
}

async function api(method, route, body) {
    const response = await fetch(`${basePath()}${route}`, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (response.redirected && /\/login$/.test(new URL(response.url).pathname)) {
        window.location.href = `${basePath()}/login`;
        throw new Error('Sua sessão expirou.');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Erro ${response.status}`);
    return data;
}

// ---------- Backup section (not in the popup: /admin-only) ----------

const dateFormat = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const sizeFormat = bytes => {
    if (!bytes && bytes !== 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
};

function mountBackupSection(section) {
    section.innerHTML = `
        <h3 class="section-label">Backup</h3>
        <p class="setting-help">Faz um snapshot do banco de dados e das pastas escolhidas, de tempos em tempos,
            e envia para um remote do rclone (o mesmo usado em Arquivos → Nuvem).</p>
        <label class="setting">
            <span class="setting-text">Backup automático</span>
            <input type="checkbox" class="switch" data-bk="enabled">
        </label>
        <label class="setting setting-stack">
            <span class="setting-text">Remote do rclone
                <span class="setting-help">Nome cadastrado no rclone (ex.: "gdrive"). Precisa já existir no servidor.</span></span>
            <input type="text" class="mono" data-bk="remote" list="backup-remotes" placeholder="gdrive" autocapitalize="off" autocorrect="off" spellcheck="false">
            <datalist id="backup-remotes"></datalist>
        </label>
        <label class="setting setting-stack">
            <span class="setting-text">Pasta no remote</span>
            <input type="text" class="mono" data-bk="remotePath" placeholder="meuterminal-backup" autocapitalize="off" autocorrect="off" spellcheck="false">
        </label>
        <label class="setting">
            <span class="setting-text">A cada</span>
            <select data-bk="intervalHours" data-type="number">
                <option value="6">6 horas</option>
                <option value="12">12 horas</option>
                <option value="24">24 horas</option>
                <option value="168">7 dias</option>
            </select>
        </label>
        <label class="setting">
            <span class="setting-text">Manter os últimos
                <span class="setting-help">Backups mais antigos que isso são apagados do remote</span></span>
            <input type="number" min="0" max="365" step="1" data-bk="keepLast" data-type="number" style="width:80px">
        </label>
        <label class="setting setting-stack">
            <span class="setting-text">Pastas incluídas
                <span class="setting-help">Uma por linha. Vazio = a home do servidor inteira.</span></span>
            <textarea class="mono" rows="3" data-bk="paths" placeholder="~/projetos" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>
        </label>
        <p class="backup-status" data-bk-status>Carregando…</p>
        <div class="push-actions">
            <button type="button" class="btn btn-primary" data-bk-run>Fazer backup agora</button>
        </div>
        <h3 class="section-label" style="margin-top:28px">Histórico</h3>
        <ul class="backup-history" data-bk-history></ul>`;

    const el = {
        enabled: section.querySelector('[data-bk="enabled"]'),
        remote: section.querySelector('[data-bk="remote"]'),
        remotes: section.querySelector('#backup-remotes'),
        remotePath: section.querySelector('[data-bk="remotePath"]'),
        interval: section.querySelector('[data-bk="intervalHours"]'),
        keepLast: section.querySelector('[data-bk="keepLast"]'),
        paths: section.querySelector('[data-bk="paths"]'),
        status: section.querySelector('[data-bk-status]'),
        run: section.querySelector('[data-bk-run]'),
        history: section.querySelector('[data-bk-history]'),
    };

    const renderStatus = cfg => {
        if (cfg.running) {
            el.status.textContent = 'Fazendo backup agora…';
            return;
        }
        const parts = [];
        parts.push(cfg.lastRunAt
            ? `Último: ${dateFormat.format(new Date(cfg.lastRunAt))} · ${cfg.lastStatus === 'ok' ? `ok, ${sizeFormat(cfg.lastSizeBytes)}` : `falhou (${cfg.lastError || 'erro'})`}`
            : 'Nunca rodou.');
        if (cfg.enabled && cfg.remote) {
            const nextAt = (cfg.lastRunAt || 0) + cfg.intervalHours * 3600 * 1000;
            parts.push(`Próximo: ${dateFormat.format(new Date(Math.max(nextAt, Date.now())))}`);
        } else if (cfg.enabled && !cfg.remote) {
            parts.push('Configure um remote para ativar.');
        }
        el.status.textContent = parts.join(' · ');
    };

    const fillForm = cfg => {
        el.enabled.checked = cfg.enabled;
        el.remote.value = cfg.remote;
        el.remotePath.value = cfg.remotePath;
        el.interval.value = String(cfg.intervalHours);
        el.keepLast.value = String(cfg.keepLast);
        el.paths.value = cfg.paths.join('\n');
        renderStatus(cfg);
        el.run.disabled = !!cfg.running;
    };

    const renderHistory = runs => {
        if (!runs.length) {
            el.history.innerHTML = '<li class="backup-history-empty">Nenhum backup ainda.</li>';
            return;
        }
        el.history.innerHTML = runs.map(r => `
            <li class="backup-history-row ${r.status}">
                <span>${dateFormat.format(new Date(r.startedAt))}</span>
                <span>${r.trigger === 'manual' ? 'manual' : 'automático'}</span>
                <span>${r.status === 'ok' ? sizeFormat(r.sizeBytes) : (r.error || 'erro')}</span>
            </li>`).join('');
    };

    let saveTimer = null;
    const save = patch => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try {
                fillForm(await api('PUT', '/api/backup', patch));
            } catch (e) {
                toast(`Não foi possível salvar: ${e.message}`, { tone: 'error' });
            }
        }, 400);
    };

    el.enabled.addEventListener('change', () => save({ enabled: el.enabled.checked }));
    el.remote.addEventListener('change', () => save({ remote: el.remote.value.trim() }));
    el.remotePath.addEventListener('change', () => save({ remotePath: el.remotePath.value.trim() }));
    el.interval.addEventListener('change', () => save({ intervalHours: Number(el.interval.value) }));
    el.keepLast.addEventListener('change', () => save({ keepLast: Number(el.keepLast.value) }));
    el.paths.addEventListener('change', () => save({ paths: el.paths.value.split('\n').map(p => p.trim()).filter(Boolean) }));

    el.run.addEventListener('click', async () => {
        el.run.disabled = true;
        el.status.textContent = 'Fazendo backup agora…';
        try {
            await api('POST', '/api/backup/run');
            toast('Backup concluído.');
        } catch (e) {
            toast(`Backup falhou: ${e.message}`, { tone: 'error', duration: 6000 });
        } finally {
            refresh();
        }
    });

    async function refresh() {
        const [cfg, history] = await Promise.all([
            api('GET', '/api/backup').catch(() => null),
            api('GET', '/api/backup/history').catch(() => []),
        ]);
        if (cfg) fillForm(cfg);
        renderHistory(history || []);
    }

    // Best-effort: suggest rclone remotes already configured for Arquivos → Nuvem
    api('GET', '/api/files/sources').then(data => {
        el.remotes.innerHTML = (data.sources || []).filter(s => s.remote)
            .map(s => `<option value="${s.id}">`).join('');
    }).catch(() => {});

    return { refresh };
}

// ---------- Page shell: nav + router ----------

function visibleNav() {
    return NAV.filter(n => !n.flag || window.appConfig?.[n.flag]);
}

function buildNav(host) {
    host.innerHTML = visibleNav().map(n => `
        <li><a href="#${n.slug}" data-slug="${n.slug}">${icon(n.icon, 17)}<span>${n.label}</span></a></li>`).join('');
}

function currentSlug() {
    const slug = location.hash.replace('#', '');
    const visible = visibleNav();
    return visible.some(n => n.slug === slug) ? slug : visible[0].slug;
}

function applyRoute(navToggle, nav) {
    const slug = currentSlug();
    document.querySelectorAll('#adminNavList a').forEach(a => a.classList.toggle('active', a.dataset.slug === slug));
    document.querySelectorAll('.admin-page [data-page]').forEach(el => { el.hidden = el.dataset.page !== slug; });
    nav.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
}

async function main() {
    document.title = `Configurações — ${window.appConfig?.siteTitle || 'MeuTerminal'}`;
    const settings = new SettingsManager();
    const commands = new CommandsManager();

    const nav = document.getElementById('adminNav');
    const navList = document.getElementById('adminNavList');
    const navToggle = document.getElementById('adminNavToggle');
    const page = document.getElementById('adminPage');

    buildNav(navList);

    // mountSettingsSections() owns page.innerHTML (it builds every popup section), so the one
    // section /admin has that the popup doesn't - Backup - is appended only after that call.
    const sections = mountSettingsSections(page, { settings, getSession: () => null, commands });
    page.insertAdjacentHTML('beforeend', '<section class="settings-section" data-page="backup"></section>');
    const backup = mountBackupSection(page.querySelector('[data-page="backup"]'));

    sections.refresh();
    backup.refresh();

    if (window.appConfig?.webhooksAvailable) {
        page.insertAdjacentHTML('beforeend', '<section class="settings-section wh-section" data-page="webhooks"></section>');
        mountWebhooksSection(page.querySelector('[data-page="webhooks"]'));
    }

    navList.addEventListener('click', e => {
        const a = e.target.closest('a[data-slug]');
        if (!a) return;
        e.preventDefault();
        location.hash = a.dataset.slug;
    });
    navToggle.innerHTML = icon('list', 18);
    navToggle.hidden = false;
    navToggle.addEventListener('click', () => {
        const open = nav.classList.toggle('open');
        navToggle.setAttribute('aria-expanded', String(open));
    });

    window.addEventListener('hashchange', () => applyRoute(navToggle, nav));
    window.addEventListener('beforeunload', sections.stopPair);
    applyRoute(navToggle, nav);
}

main();
