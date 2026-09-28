/**
 * index.js
 * App shell: wires the workspace (tabs + terminals) to the header, status bar,
 * mobile shortcut bar, fullscreen/focus mode, menus and the service worker.
 */
import TerminalManager from './managers/terminal.js';
import ServiceWorkerManager from './managers/serviceWorker.js';
import SettingsManager from './managers/settings.js';
import StorageManager from './managers/storage.js';
import ViewportManager from './ui/viewport.js';
import StatusBar from './ui/statusBar.js';
import ShortcutBar from './ui/shortcutBar.js';
import { createSettingsDialog, createShortcutsDialog } from './ui/dialogs.js';
import { showMenu } from './ui/contextMenu.js';
import { icon } from './ui/icons.js';
import { toast } from './ui/toast.js';

const STATE_LABELS = {
    connecting: 'Conectando',
    connected: 'Conectado',
    reconnecting: 'Reconectando',
    disconnected: 'Desconectado',
    exited: 'Encerrado',
    error: 'Erro',
};

function joinPath(path) {
    const basePath = window.appConfig?.basePath || '';
    const cleanPath = path.replace(/^\/+/, '');
    const cleanBase = basePath.replace(/\/+$/, '');
    return cleanBase ? `${cleanBase}/${cleanPath}` : cleanPath;
}

/** xterm measures glyphs once at startup, so the terminal font must be ready first. */
async function waitForFonts() {
    try {
        await Promise.all([
            document.fonts.load('400 15px "JetBrains Mono"'),
            document.fonts.load('700 15px "JetBrains Mono"'),
            document.fonts.load('400 15px "FiraCode Nerd Font"'),
        ]);
    } catch (e) {
        console.warn('Font loading error:', e);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    const config = window.appConfig || {};
    const isMacOS = /Macintosh|Mac OS X/i.test(navigator.userAgent);
    const root = document.documentElement;
    const uiStorage = new StorageManager('dumbterm-');

    const settings = new SettingsManager();
    const viewport = new ViewportManager();

    // ---------- static header content ----------
    const siteTitle = config.siteTitle || 'MeuTerminal';
    document.getElementById('pageTitle').textContent = siteTitle;
    document.getElementById('siteTitle').textContent = siteTitle;
    if (config.isDemoMode) document.getElementById('demo-banner').hidden = false;

    const fullscreenBtn = document.getElementById('fullscreenBtn');
    const menuBtn = document.getElementById('menuBtn');
    const brandConn = document.getElementById('brandConn');
    menuBtn.innerHTML = icon('more', 18);

    await waitForFonts();

    // ---------- mobile shortcut bar ----------
    let workspace;
    const shortcutBar = new ShortcutBar(document.getElementById('shortcutBar'), {
        getSession: () => workspace?.active,
    });
    let terminalFocused = false;
    let blurTimer;
    const updateShortcutBar = () => {
        const mode = settings.get('shortcutBar');
        const visible = mode === 'always'
            || (mode === 'auto' && viewport.keyboardOpen && terminalFocused);
        shortcutBar.setVisible(visible);
    };
    viewport.onKeyboardChange(updateShortcutBar);

    // ---------- status bar ----------
    const statusBar = new StatusBar(document.getElementById('statusBar'), {
        onSessions: anchor => workspace.openSessionList(anchor),
    });
    const renderActive = session => {
        statusBar.render(session);
        brandConn.dataset.state = session.state;
        brandConn.setAttribute('aria-label', STATE_LABELS[session.state] || session.state);
    };

    // ---------- fullscreen & focus mode ----------
    // Two concepts: "focus mode" hides chrome inside the page; "fullscreen" also uses
    // the Fullscreen API when the browser has it (iPhone Safari doesn't -> focus mode only).
    let focusMode = !!uiStorage.get('ui', {}).focusMode;
    const canFullscreen = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement;

    const syncExpanded = () => {
        const native = !!fullscreenElement();
        const expanded = native || focusMode;
        root.toggleAttribute('data-expanded', expanded);
        fullscreenBtn.innerHTML = icon(expanded ? 'minimize' : 'maximize', 18);
        fullscreenBtn.setAttribute('aria-pressed', String(expanded));
        fullscreenBtn.setAttribute('aria-label', expanded ? 'Sair da tela cheia' : 'Tela cheia');
        fullscreenBtn.title = expanded ? 'Sair da tela cheia' : 'Tela cheia';
    };

    const setFocusMode = on => {
        focusMode = on;
        uiStorage.set('ui', { ...uiStorage.get('ui', {}), focusMode: on });
        syncExpanded();
    };

    const toggleFullscreen = async () => {
        if (fullscreenElement()) {
            await (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            return;
        }
        if (focusMode) {
            setFocusMode(false);
            return;
        }
        if (canFullscreen) {
            try {
                const el = document.documentElement;
                await (el.requestFullscreen || el.webkitRequestFullscreen).call(el, { navigationUI: 'hide' });
                return;
            } catch (e) {
                console.warn('Fullscreen request failed, using focus mode:', e);
            }
        }
        setFocusMode(true);
    };

    // ESC exits native fullscreen through the browser; this keeps the UI in sync
    document.addEventListener('fullscreenchange', syncExpanded);
    document.addEventListener('webkitfullscreenchange', syncExpanded);
    fullscreenBtn.addEventListener('click', toggleFullscreen);
    syncExpanded();

    // ---------- dialogs ----------
    const settingsDialog = createSettingsDialog(settings, () => workspace?.active);

    // ---------- workspace ----------
    workspace = new TerminalManager({
        isMacOS,
        settings,
        tabList: document.getElementById('tabList'),
        workspace: document.getElementById('workspace'),
        events: {
            onActiveChange: renderActive,
            onSessionChange: renderActive,
            onFocusChange: focused => {
                clearTimeout(blurTimer);
                if (focused) {
                    terminalFocused = true;
                    updateShortcutBar();
                } else {
                    // Brief delay: focus may bounce while the keyboard animates
                    blurTimer = setTimeout(() => {
                        terminalFocused = false;
                        updateShortcutBar();
                    }, 150);
                }
            },
            transformInput: data => shortcutBar.transform(data),
            onAction: action => {
                if (action === 'fullscreen') toggleFullscreen();
                else if (action === 'settings') settingsDialog.open();
            },
        },
    });

    const shortcutsDialog = createShortcutsDialog(workspace.shortcutList());

    settings.onChange(key => {
        if (key === 'shortcutBar') updateShortcutBar();
    });
    updateShortcutBar();

    document.getElementById('newTabBtn').addEventListener('click', () => workspace.openNewSessionPage());

    // ---------- overflow menu ----------
    const logout = () => {
        workspace.saveNow();
        fetch(joinPath('logout'), { method: 'POST', credentials: 'same-origin' })
            .then(response => response.json())
            .then(data => {
                if (data.success) window.location.href = joinPath('login');
            })
            .catch(error => {
                console.error('Logout failed:', error);
                toast('Não foi possível sair. Tente novamente.', { tone: 'error' });
            });
    };

    menuBtn.addEventListener('click', () => {
        const k = workspace.shortcutLabels();
        const c = isMacOS ? '⌘' : 'Ctrl';
        const dark = settings.resolvedTheme() === 'dark';
        const items = [
            { label: 'Nova sessão', icon: 'plus', hint: k.newTab, run: () => workspace.create() },
            { label: 'Nova sessão com opções…', icon: 'terminal', run: () => workspace.openNewSessionPage() },
            { label: 'Reabrir sessão fechada', icon: 'restore', disabled: workspace.recents.length === 0,
                run: () => workspace.restoreLastClosed() },
            'separator',
            { label: 'Buscar no terminal', icon: 'search', hint: `${c}+F`, run: () => workspace.search.open() },
            { label: 'Modo foco', icon: 'focus', checked: focusMode, run: () => setFocusMode(!focusMode) },
            { label: dark ? 'Tema claro' : 'Tema escuro', icon: dark ? 'sun' : 'moon',
                run: () => settings.set('theme', dark ? 'light' : 'dark') },
            'separator',
            { label: 'Configurações', icon: 'settings', hint: `${c}+,`, run: () => settingsDialog.open() },
        ];
        if (!window.matchMedia('(pointer: coarse)').matches) {
            items.push({ label: 'Atalhos de teclado', icon: 'keyboard', run: () => shortcutsDialog.open() });
        }
        if (config.isPinRequired) {
            items.push('separator', { label: 'Sair', icon: 'logout', danger: true, run: logout });
        }
        showMenu(items, { anchor: menuBtn, label: 'Mais ações' });
    });

    // ---------- service worker (silent updates) ----------
    const serviceWorkerManager = new ServiceWorkerManager();
    serviceWorkerManager.initialize(() => {});
});
