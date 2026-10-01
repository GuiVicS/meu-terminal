/**
 * index.js
 * App shell: wires the workspace (tabs + terminals) to the header, status bar,
 * mobile shortcut bar, fullscreen/focus mode, menus and the service worker.
 */
import TerminalManager from './managers/terminal.js';
import ServiceWorkerManager from './managers/serviceWorker.js';
import SettingsManager from './managers/settings.js';
import StorageManager from './managers/storage.js';
import CommandsManager from './managers/commands.js';
import ClipboardHistory from './managers/clipboard.js';
import { openPopover } from './ui/listPopover.js';
import { relativeTime } from './ui/newSession.js';
import ViewportManager from './ui/viewport.js';
import StatusBar from './ui/statusBar.js';
import ShortcutBar from './ui/shortcutBar.js';
import { createSettingsDialog, createShortcutsDialog } from './ui/dialogs.js';
import { showMenu } from './ui/contextMenu.js';
import { icon } from './ui/icons.js';
import VibeForm from './ui/vibeForm.js';
import AgentLaunch from './ui/agentLaunch.js';
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
    const uiStorage = new StorageManager('meuterminal-');

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

    // ---------- quick commands & clipboard ----------
    let workspace;
    let settingsDialog;
    const commands = new CommandsManager();
    commands.load().catch(e => console.warn('Could not load quick commands:', e));
    const clipboard = new ClipboardHistory();

    /** Types a quick command into the active terminal (Enter only if it's set to run). */
    const runCommand = item => {
        const session = workspace?.active;
        if (!session) return;
        // Multi-line commands: each line is a line of shell input
        const text = item.command.replace(/\r?\n/g, '\r');
        session.sendInput(item.run ? text + '\r' : text);
    };

    const openCommands = async anchor => {
        try {
            await commands.load(); // may have been edited on another device
        } catch { /* show the cached list */ }
        openPopover({
            title: 'Comandos rápidos',
            anchor,
            empty: 'Nenhum comando ainda. Cadastre em Configurações.',
            items: commands.items.map(item => ({
                primary: item.label,
                secondary: item.command.split('\n')[0],
                badge: item.run ? 'Enter' : '',
                onSelect: () => runCommand(item),
            })),
            actions: [{ label: 'Gerenciar comandos', onClick: () => settingsDialog.open() }],
        });
    };

    const pasteText = text => {
        const session = workspace?.active;
        if (!session || !text) return;
        // Browser tab: typed into the page. Terminal: xterm's paste() applies paste rules.
        if (session.kind !== 'terminal') session.sendText(text);
        else session.terminal.paste(text);
    };

    /** Pastes what is currently copied on the device. */
    const pasteFromDevice = async () => {
        const status = await clipboard.captureDeviceClipboard();
        if (status === 'ok') pasteText(clipboard.items[0].text);
        else if (status === 'empty') toast('A área de transferência está vazia.');
        else if (status === 'denied') toast('Permita o acesso à área de transferência para colar.', { tone: 'error' });
        else toast('Colar por botão exige HTTPS. Use colar do teclado ou segure o botão para o histórico.', {
            tone: 'error', duration: 6000,
        });
    };

    const openClipboardHistory = anchor => {
        openPopover({
            title: 'Copiados recentemente',
            note: 'Fica só neste aparelho. Toque para colar.',
            anchor,
            empty: 'Nada copiado ainda. O que você copiar no terminal ou colar pelo botão aparece aqui.',
            items: clipboard.items.map(entry => {
                const lines = entry.text.split('\n').length;
                const firstLine = entry.text.split('\n')[0];
                return {
                    primary: firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine,
                    secondary: relativeTime(entry.at),
                    badge: lines > 1 ? `${lines} linhas` : '',
                    onSelect: () => pasteText(entry.text),
                    onRemove: () => clipboard.remove(entry.text),
                    removeLabel: 'Remover do histórico',
                };
            }),
            actions: [
                { label: 'Colar do aparelho', onClick: pasteFromDevice },
                { label: 'Limpar histórico', tone: 'danger', onClick: () => clipboard.clear() },
            ],
        });
    };

    // Everything copied inside the app goes to the history
    document.addEventListener('copy', () => {
        const term = workspace?.active?.terminal;
        const text = term?.hasSelection() ? term.getSelection() : String(window.getSelection() || '');
        clipboard.add(text);
    });

    // ---------- mobile shortcut bar ----------
    const shortcutBar = new ShortcutBar(document.getElementById('shortcutBar'), {
        getSession: () => workspace?.active,
        onAction: (name, button) => {
            if (name === 'commands') openCommands(button);
            else if (name === 'paste') pasteFromDevice();
            else if (name === 'clipboard-history') openClipboardHistory(button);
        },
    });
    let terminalFocused = false;
    let blurTimer;
    const updateShortcutBar = () => {
        const mode = settings.get('shortcutBar');
        // File tabs have their own buttons: the terminal keys bar isn't useful there
        const visible = workspace?.active?.kind !== 'files' && (mode === 'always'
            || (mode === 'auto' && viewport.keyboardOpen && terminalFocused));
        shortcutBar.setVisible(visible);
    };
    viewport.onKeyboardChange(updateShortcutBar);

    // ---------- status bar ----------
    const statusBar = new StatusBar(document.getElementById('statusBar'), {
        onSessions: anchor => workspace.openSessionList(anchor),
    });
    const renderActive = session => {
        statusBar.render(session);
        if (typeof updateShortcutBar === 'function') updateShortcutBar();
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
    settingsDialog = createSettingsDialog(settings, () => workspace?.active, commands);
    const vibeForm = new VibeForm();
    const agentLaunch = new AgentLaunch();

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
            // Two-finger tap on the terminal (when the program doesn't use the mouse)
            onTerminalMenu: (session, x, y) => {
                const term = session.terminal;
                // Popups anchor to a visible button: the bar's paste key, or the ⋮ menu
                const anchor = () => {
                    const key = document.querySelector('#shortcutBar:not([hidden]) [data-key="clip"]');
                    return key || menuBtn;
                };
                showMenu([
                    { label: 'Colar', icon: 'clipboard', run: pasteFromDevice },
                    { label: 'Copiar tudo', icon: 'copy', run: async () => {
                        term.selectAll();
                        const text = term.getSelection();
                        term.clearSelection();
                        const ok = await clipboard.copy(text);
                        toast(ok ? 'Conteúdo do terminal copiado.' : 'Salvo em "Copiados recentemente".');
                    } },
                    'separator',
                    { label: 'Comandos rápidos', icon: 'bolt', run: () => openCommands(anchor()) },
                    { label: 'Copiados recentemente', icon: 'history', run: () => openClipboardHistory(anchor()) },
                ], { x, y, label: 'Terminal' });
            },
            // Vibecoding form requested by an agent (MCP start_vibecoding), or answered elsewhere
            onVibeForm: m => {
                if (m.type === 'vibe-form') vibeForm.open({ defaults: m.defaults, requestId: m.requestId });
                else vibeForm.closeRequest(m.requestId);
            },
            // "Deseja usar o modo Claude Code UI?" (an agent was typed in a terminal)
            onAgentLaunch: m => {
                if (m.type === 'agent-launch') agentLaunch.open(m);
                else agentLaunch.closeRequest(m.requestId);
            },
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

    document.getElementById('newTabBtn').innerHTML = icon('plus', 18);
    document.getElementById('newTabBtn').addEventListener('click', () => workspace.openNewSessionPage());

    // ---------- overflow menu ----------
    const logout = () => {
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
            { label: 'Nova aba de navegador', icon: 'globe', hint: `${k.mod}+B`, run: () => workspace.createBrowser() },
            ...(config.filesAvailable ? [{ label: 'Gerenciador de arquivos', icon: 'folder', hint: `${k.mod}+E`,
                run: () => workspace.createFiles() }] : []),
            { label: 'Nova sessão com opções…', icon: 'terminal', run: () => workspace.openNewSessionPage() },
            { label: 'Nova conversa com agente', icon: 'bot', run: () => workspace.openAgentMenu(menuBtn) },
            { label: 'Novo projeto (vibecoding)', icon: 'zap', run: () => vibeForm.open() },
            ...(workspace.activeId ? [workspace.split && workspace.visiblePair()
                ? { label: 'Desfazer divisão da tela', icon: 'panelLeft', run: () => workspace.clearSplit({ keep: workspace.activeId }) }
                : { label: 'Dividir tela…', icon: 'panelLeft', run: () => workspace.openSplitMenu(workspace.activeId, { anchor: menuBtn }) }] : []),
            { label: 'Reabrir sessão fechada', icon: 'restore', disabled: workspace.recents.length === 0,
                run: () => workspace.restoreLastClosed() },
            'separator',
            { label: 'Buscar no terminal', icon: 'search', hint: `${c}+F`, run: () => workspace.run('search') },
            { label: 'Comandos rápidos', icon: 'bolt', run: () => openCommands(menuBtn) },
            { label: 'Copiados recentemente', icon: 'clipboard', run: () => openClipboardHistory(menuBtn) },
            { label: 'Modo foco', icon: 'focus', checked: focusMode, run: () => setFocusMode(!focusMode) },
            { label: dark ? 'Tema claro' : 'Tema escuro', icon: dark ? 'sun' : 'moon',
                run: () => settings.set('theme', dark ? 'light' : 'dark') },
            'separator',
            { label: 'Configurações', icon: 'settings', hint: `${c}+,`, run: () => settingsDialog.open() },
            { label: 'Guia do app', icon: 'info', run: () => window.open(joinPath('guia'), '_blank', 'noopener') },
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
