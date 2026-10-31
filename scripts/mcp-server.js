/**
 * mcp-server.js
 * MeuTerminal's own MCP server (Model Context Protocol, Streamable HTTP transport) so
 * agents running inside its terminals (Claude Code, Codex...) can drive the app: open a
 * URL in a new browser tab, look at it (screenshot/text), list tabs, notify the user.
 * Only reachable from the server itself, with a bearer token (see server.js).
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJsonRpcHandler } = require('./mcp-protocol');

const SERVER_INFO = { name: 'meuterminal', version: require('../package.json').version };

const TOOLS = [
    {
        name: 'open_url',
        description: 'Abre uma URL numa nova aba de navegador do MeuTerminal (visível para o usuário). '
            + 'Use para mostrar o resultado de um projeto rodando (ex.: "localhost:5173") ou uma página. '
            + 'Retorna o id da aba, usado por navigate/screenshot/read_page/close_tab.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Endereço. "localhost:5173", "5173" ou "site.com" também valem.' },
                name: { type: 'string', description: 'Nome da aba (opcional).' },
                background: { type: 'boolean', description: 'true = abre sem trocar a aba que o usuário está vendo.' },
                beside: {
                    type: 'boolean',
                    description: 'true = tela dividida: o seu terminal de um lado e a página do outro (como o Live Server do VS Code).',
                },
                live_folder: {
                    type: 'string',
                    description: 'Opcional: pasta a observar; a página recarrega sozinha quando um arquivo dela for salvo.',
                },
                terminal_tab_id: {
                    type: 'string',
                    description: 'Id da SUA aba de terminal: o valor da variável de ambiente MEUTERMINAL_TAB_ID (rode echo $MEUTERMINAL_TAB_ID). Usado com beside.',
                },
            },
            required: ['url'],
        },
    },
    {
        name: 'open_folder',
        description: 'Abre uma pasta para o usuário ver: por padrão no gerenciador de arquivos do MeuTerminal '
            + '(nova aba "Arquivos", com prévia, download, upload etc.); com view="terminal", numa nova aba de '
            + 'terminal já nessa pasta. Também abre pastas de remotes do rclone (ex.: Google Drive) com source. '
            + 'Use quando o usuário pedir para abrir/mostrar/ver uma pasta ou projeto.',
        inputSchema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Caminho da pasta. Local: absoluto, "~" = home, relativo = a partir da home. '
                        + 'Remote: caminho dentro dele ("/" = raiz); também aceita "gdrive:pasta/sub".',
                },
                source: { type: 'string', description: 'Opcional: nome do remote do rclone (ex.: "gdrive"). Padrão = pastas deste servidor.' },
                view: { type: 'string', enum: ['files', 'terminal'], description: 'files (padrão) = gerenciador de arquivos; terminal = shell na pasta.' },
                name: { type: 'string', description: 'Nome da aba (opcional; padrão = nome da pasta).' },
                background: { type: 'boolean', description: 'true = abre sem trocar a aba que o usuário está vendo.' },
            },
            required: ['path'],
        },
    },
    {
        name: 'list_drives',
        description: 'Lista onde dá para abrir pastas: este servidor e os remotes do rclone (Google Drive etc.), se o rclone estiver instalado.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'list_tabs',
        description: 'Lista as abas abertas no MeuTerminal (terminais e navegadores) com id, tipo, nome e endereço/diretório.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'navigate',
        description: 'Muda o endereço de uma aba de navegador e espera carregar.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                tab_id: { type: 'string', description: 'Opcional: padrão = última aba de navegador aberta.' },
            },
            required: ['url'],
        },
    },
    {
        name: 'screenshot',
        description: 'Captura a tela de uma aba de navegador (PNG) para você ver como a página está.',
        inputSchema: {
            type: 'object',
            properties: {
                tab_id: { type: 'string', description: 'Opcional: padrão = última aba de navegador aberta.' },
                full_page: { type: 'boolean', description: 'true = página inteira (rolando); padrão = só a parte visível.' },
            },
        },
    },
    {
        name: 'read_page',
        description: 'Retorna título, URL e o texto visível de uma aba de navegador.',
        inputSchema: {
            type: 'object',
            properties: { tab_id: { type: 'string', description: 'Opcional: padrão = última aba de navegador aberta.' } },
        },
    },
    {
        name: 'close_tab',
        description: 'Fecha uma aba de navegador ou de arquivos (abas de terminal não podem ser fechadas por aqui).',
        inputSchema: {
            type: 'object',
            properties: { tab_id: { type: 'string' } },
            required: ['tab_id'],
        },
    },
    {
        name: 'list_ports',
        description: 'Lista as portas abertas no servidor (projetos rodando), para abrir com open_url.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'notify',
        description: 'Avisa o usuário: mostra o aviso na tela do MeuTerminal (com som) e envia uma notificação push '
            + 'para os aparelhos dele (celular/computador), mesmo com o app fechado. Use quando terminar uma tarefa '
            + 'longa, quando precisar de uma decisão ou se algo der errado (ex.: "Build pronto", "Preciso da sua aprovação").',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Texto do aviso (até 300 caracteres).' },
                title: { type: 'string', description: 'Título da notificação (padrão: nome do projeto ou "MeuTerminal").' },
                sound: { type: 'boolean', description: 'Tocar som (padrão: true).' },
                push: { type: 'boolean', description: 'Enviar push para os aparelhos (padrão: true). false = só na tela do app.' },
            },
            required: ['message'],
        },
    },
    {
        name: 'live_preview',
        description: 'Live Server: serve uma pasta de site (index.html) só para o navegador do MeuTerminal e abre a prévia '
            + 'ao lado do seu terminal, recarregando a cada arquivo salvo. Use para sites HTML/CSS/JS sem servidor de desenvolvimento.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Pasta do site (absoluta, "~" = home, relativa = a partir da home).' },
                beside: { type: 'boolean', description: 'Tela dividida com o seu terminal (padrão: true).' },
                terminal_tab_id: { type: 'string', description: 'Valor de $MEUTERMINAL_TAB_ID (a sua aba de terminal).' },
            },
            required: ['path'],
        },
    },
    {
        name: 'split_tabs',
        description: 'Mostra duas abas lado a lado (tela dividida), por exemplo o seu terminal e uma aba de navegador. '
            + 'Com only_first=true desfaz a divisão.',
        inputSchema: {
            type: 'object',
            properties: {
                left_tab_id: { type: 'string', description: 'Aba da esquerda (padrão: a sua aba de terminal, $MEUTERMINAL_TAB_ID).' },
                right_tab_id: { type: 'string', description: 'Aba da direita.' },
                only_first: { type: 'boolean', description: 'true = desfaz a divisão e mostra só a primeira aba.' },
            },
        },
    },
    {
        name: 'start_vibecoding',
        description: 'Modo vibecoding: abre um formulário na tela do usuário (nome do projeto, tipo, o que quer construir, pasta) '
            + 'e, quando ele responde, cria a pasta e prepara o ambiente: tela dividida com o SEU terminal e uma prévia ao vivo, '
            + 'mais uma aba de Arquivos do projeto. Retorna as respostas e as instruções para você construir o projeto. '
            + 'Use quando o usuário quiser começar um projeto novo / "vibecodar". Espera até wait_seconds pela resposta; '
            + 'se voltar status "waiting", chame vibecoding_result com o request_id.',
        inputSchema: {
            type: 'object',
            properties: {
                project_name: { type: 'string', description: 'Sugestão de nome (o usuário pode mudar).' },
                description: { type: 'string', description: 'Sugestão do que construir (o usuário pode mudar).' },
                kind: { type: 'string', enum: ['static', 'vite', 'next', 'api', 'other'], description: 'Sugestão de tipo.' },
                path: { type: 'string', description: 'Sugestão de pasta (padrão ~/projetos/<nome>).' },
                terminal_tab_id: { type: 'string', description: 'Valor de $MEUTERMINAL_TAB_ID (a sua aba de terminal).' },
                wait_seconds: { type: 'number', description: 'Quanto esperar pela resposta (padrão 600, máximo 900).' },
            },
        },
    },
    {
        name: 'vibecoding_result',
        description: 'Continua esperando a resposta de um formulário do start_vibecoding que voltou com status "waiting".',
        inputSchema: {
            type: 'object',
            properties: {
                request_id: { type: 'string' },
                wait_seconds: { type: 'number', description: 'Padrão 600, máximo 900.' },
            },
            required: ['request_id'],
        },
    },
];

class ToolError extends Error {}

/**
 * @param {object} deps
 * @param {import('./session-manager')} deps.sessions
 * @param {import('./session-store')} deps.store
 * @param {import('./browser-manager').BrowserManager} deps.browsers
 * @param {Function} deps.listPorts
 * @param {Function} deps.normalizeUrl
 * @param {number} deps.port - the app's own port (hidden from list_ports)
 */
function createMcpTools({
    sessions, store, browsers, files, listPorts, normalizeUrl, port,
    live, vibe, setLiveReload, agentTerminal, notifier,
}) {
    let lastBrowserTab = null;
    const vibeRequests = new Map(); // request_id -> { promise, terminalTabId, settled }

    /** Shows two tabs side by side on every open app window. */
    function split(a, b) {
        sessions.broadcast({ type: 'split', a, b, focus: a });
    }

    /** Waits for a vibecoding form up to wait_seconds; then sets the project up. */
    async function awaitVibe(requestId, waitSeconds) {
        const entry = vibeRequests.get(requestId);
        if (!entry) throw new ToolError('request_id desconhecido (o formulário já foi respondido ou expirou).');
        const wait = Math.min(900, Math.max(5, Number(waitSeconds) || 600)) * 1000;
        const outcome = await Promise.race([
            entry.promise.then(v => ({ v }), e => ({ e })),
            new Promise(resolve => setTimeout(() => resolve(null), wait)),
        ]);
        if (!outcome) {
            return text({ status: 'waiting', request_id: requestId,
                message: 'O usuário ainda não respondeu. Chame vibecoding_result com este request_id para continuar esperando.' });
        }
        vibeRequests.delete(requestId);
        if (outcome.e) throw new ToolError(outcome.e.message);
        if (outcome.v.cancelled) return text({ status: 'cancelled', message: 'O usuário cancelou o formulário.' });
        let result;
        try {
            result = await vibe.setup(outcome.v.answers, { agentTabId: entry.terminalTabId });
        } catch (e) {
            throw new ToolError(e.message);
        }
        return text({
            status: 'ready',
            ...result,
            next_steps: `Entre na pasta (cd ${JSON.stringify(result.path)}) e construa o projeto. ${result.instructions} `
                + 'Confira com screenshot/read_page na aba de prévia (browser_tab_id) e use notify ao terminar etapas.',
        });
    }

    /** Resolves tab_id (or the last/first browser tab when omitted). */
    function browserRow(tabId) {
        const id = tabId || lastBrowserTab;
        let row = id ? store.get(id) : null;
        if (!row && !tabId) row = store.listOpen().filter(r => r.kind === 'browser').pop() || null;
        if (!row || row.status !== 'open') throw new ToolError('Aba não encontrada. Use list_tabs ou open_url.');
        if (row.kind !== 'browser') throw new ToolError('Essa aba é um terminal, não um navegador.');
        lastBrowserTab = row.id;
        return row;
    }

    const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

    return {
        async open_url({ url, name, background, beside, live_folder, terminal_tab_id }) {
            if (!browsers.available) throw new ToolError('Chromium não está instalado no servidor.');
            const target = normalizeUrl(url);
            if (!target) throw new ToolError('URL inválida.');
            const terminal = beside ? agentTerminal(terminal_tab_id) : null;
            const tab = sessions.create({ kind: 'browser', url: target, name, afterId: terminal || undefined });
            lastBrowserTab = tab.id;
            if (live_folder) {
                try {
                    await setLiveReload(tab.id, live_folder);
                } catch (e) {
                    throw new ToolError(e.message);
                }
            }
            // Tell the open app windows to show it (unless the agent asked for background)
            if (terminal) split(terminal, tab.id);
            else if (!background) sessions.broadcast({ type: 'open-tab', id: tab.id });
            // The page opens at the tab's URL; wait for it so the agent gets the real title
            let state = { url: target, title: '' };
            try {
                const page = await browsers.ensurePage(store.get(tab.id));
                await browsers.waitForLoad(page, 15000);
                state = page.state;
            } catch { /* the tab exists; the page may still be loading */ }
            return text({ tab_id: tab.id, url: state.url, title: state.title });
        },
        async open_folder({ path: folder, source, view, name, background }) {
            let raw = String(folder || '').trim();
            if (!raw || raw.length > 4096) throw new ToolError('Caminho inválido.');
            let src = source && source !== 'local' ? String(source) : 'local';
            // "gdrive:pasta" form, when it names a real rclone remote
            const prefixed = /^([^:/\\]{2,}):(.*)$/.exec(raw);
            if (src === 'local' && prefixed && files) {
                const remotes = await files.remotes();
                if (remotes.some(r => r.name === prefixed[1])) {
                    src = prefixed[1];
                    raw = prefixed[2] || '/';
                }
            }
            const wantsTerminal = view === 'terminal';
            if (!wantsTerminal && !files) throw new ToolError('O gerenciador de arquivos está desligado; use view="terminal".');
            if (wantsTerminal && src !== 'local') throw new ToolError('Pastas do rclone só abrem no gerenciador de arquivos.');

            let resolved;
            if (files) {
                let info;
                try {
                    info = await files.stat(src, raw);
                } catch (e) {
                    throw new ToolError(e.message);
                }
                if (info.type !== 'dir') throw new ToolError(`Não é uma pasta: ${info.path}`);
                resolved = info.path;
            } else {
                const home = os.homedir();
                resolved = path.resolve(home, raw.replace(/^~(?=$|[\\/])/, home));
                let stat = null;
                try { stat = fs.statSync(resolved); } catch { /* reported below */ }
                if (!stat) throw new ToolError(`Pasta não encontrada: ${resolved}`);
                if (!stat.isDirectory()) throw new ToolError(`Não é uma pasta: ${resolved}`);
            }
            const folderName = resolved.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || (src === 'local' ? resolved : src);
            const tab = wantsTerminal
                ? sessions.create({ kind: 'terminal', cwd: resolved, name: name || folderName })
                : sessions.create({ kind: 'files', url: src, cwd: resolved, name: name || folderName });
            if (!background) sessions.broadcast({ type: 'open-tab', id: tab.id });
            return text({ tab_id: tab.id, view: wantsTerminal ? 'terminal' : 'files', source: src, path: resolved, name: tab.name });
        },
        async list_drives() {
            if (!files) throw new ToolError('O gerenciador de arquivos está desligado.');
            const info = await files.sources();
            return text({
                home: info.home,
                rclone_installed: info.rclone,
                drives: info.sources.map(s => ({ source: s.id, name: s.name, type: s.type })),
            });
        },
        list_tabs() {
            return text(store.listOpen().map(r => ({
                tab_id: r.id,
                kind: r.kind || 'terminal',
                name: r.name,
                ...(r.kind === 'browser' ? { url: r.url }
                    : r.kind === 'files' ? { source: r.url || 'local', path: r.cwd || null }
                    : { cwd: r.cwd || r.start_cwd || null }),
                pinned: !!r.pinned,
            })));
        },
        async navigate({ url, tab_id }) {
            const row = browserRow(tab_id);
            return text({ tab_id: row.id, ...(await browsers.navigateTab(row, url)) });
        },
        async screenshot({ tab_id, full_page }) {
            const row = browserRow(tab_id);
            const shot = await browsers.screenshot(row, { fullPage: !!full_page });
            return {
                content: [
                    { type: 'image', data: shot.data, mimeType: 'image/png' },
                    { type: 'text', text: `${shot.title || '(sem título)'} — ${shot.url}` },
                ],
            };
        },
        async read_page({ tab_id }) {
            const row = browserRow(tab_id);
            const page = await browsers.readText(row);
            return text(`# ${page.title}\n${page.url}\n\n${page.text}`);
        },
        async close_tab({ tab_id }) {
            const row = store.get(tab_id);
            if (!row || row.status !== 'open') throw new ToolError('Aba não encontrada.');
            if (row.kind !== 'browser' && row.kind !== 'files') {
                throw new ToolError('Por segurança, abas de terminal só podem ser fechadas pelo usuário.');
            }
            if (row.kind === 'browser') await browsers.closePage(row.id);
            sessions.close(row.id);
            if (lastBrowserTab === row.id) lastBrowserTab = null;
            return text(`Aba ${row.name} fechada.`);
        },
        async list_ports() {
            return text(await listPorts([port]));
        },
        async notify({ message, title, sound, push }) {
            const msg = String(message || '').slice(0, 300);
            if (!msg) throw new ToolError('Mensagem vazia.');
            const heading = String(title || 'MeuTerminal').slice(0, 80);
            const withSound = sound !== false;
            // On screen (open windows), with a chime
            sessions.broadcast({ type: 'notify', message: msg, title: heading, sound: withSound });
            // Push to the user's devices (works with the app closed)
            let pushed = null;
            const pusher = notifier && notifier();
            if (push !== false && pusher) {
                try {
                    pushed = await pusher.send({ title: heading, body: msg, sound: withSound });
                } catch (e) {
                    pushed = { error: e.message };
                }
            }
            const screens = sessions.sockets.size ? 'na tela do app' : 'nenhum app aberto';
            if (!pushed) return text(`Aviso mostrado (${screens}).`);
            if (pushed.error) return text(`Aviso mostrado (${screens}); push falhou: ${pushed.error}`);
            if (!pushed.devices) {
                return text(`Aviso mostrado (${screens}). Nenhum aparelho com notificações ativadas: `
                    + 'o usuário ativa em Configurações → Notificações.');
            }
            return text(`Aviso mostrado (${screens}) e enviado para ${pushed.sent} de ${pushed.devices} aparelho(s).`);
        },
        async live_preview({ path: folder, beside, terminal_tab_id }) {
            if (!browsers.available) throw new ToolError('Chromium não está instalado no servidor.');
            const raw = String(folder || '').trim();
            if (!raw) throw new ToolError('Informe a pasta.');
            const home = files ? files.home : os.homedir();
            const resolved = path.resolve(home, raw.replace(/^~(?=$|[\\/])/, home));
            let url;
            try {
                url = await live.serve(resolved);
            } catch (e) {
                throw new ToolError(e.message);
            }
            const terminal = beside === false ? null : agentTerminal(terminal_tab_id);
            const tab = sessions.create({ kind: 'browser', url, name: `${path.basename(resolved)} · prévia`, afterId: terminal || undefined });
            lastBrowserTab = tab.id;
            await setLiveReload(tab.id, resolved);
            if (terminal) split(terminal, tab.id);
            else sessions.broadcast({ type: 'open-tab', id: tab.id });
            return text({ tab_id: tab.id, url, folder: resolved, live_reload: true,
                note: 'A página recarrega sozinha quando um arquivo da pasta é salvo.' });
        },
        split_tabs({ left_tab_id, right_tab_id, only_first }) {
            const left = left_tab_id && store.get(left_tab_id)?.status === 'open' ? left_tab_id : agentTerminal(null);
            if (!left) throw new ToolError('Aba da esquerda não encontrada.');
            if (only_first) {
                sessions.broadcast({ type: 'split', a: left, b: null, focus: left });
                return text('Divisão desfeita.');
            }
            const right = store.get(String(right_tab_id || ''));
            if (!right || right.status !== 'open' || right.id === left) throw new ToolError('Aba da direita não encontrada.');
            split(left, right.id);
            return text(`Tela dividida: ${store.get(left).name} | ${right.name}`);
        },
        async start_vibecoding({ project_name, description, kind, path: folder, terminal_tab_id, wait_seconds }) {
            const terminalTabId = agentTerminal(terminal_tab_id);
            const requestId = crypto.randomUUID();
            let promise;
            try {
                promise = vibe.ask({ name: project_name, description, kind, path: folder });
            } catch (e) {
                throw new ToolError(e.message);
            }
            promise.catch(() => {}); // handled in awaitVibe
            vibeRequests.set(requestId, { promise, terminalTabId });
            return awaitVibe(requestId, wait_seconds);
        },
        vibecoding_result({ request_id, wait_seconds }) {
            return awaitVibe(String(request_id || ''), wait_seconds);
        },
    };
}

/** Express handler for POST /mcp: the local tools on top of mcp-protocol.js. */
function createMcpHandler(deps) {
    return createJsonRpcHandler({
        tools: TOOLS,
        impl: createMcpTools(deps),
        serverInfo: SERVER_INFO,
        instructions: 'Ferramentas do MeuTerminal: abra páginas (open_url) para o usuário ver o '
            + 'resultado (beside=true divide a tela com o seu terminal; live_preview = Live Server de uma pasta), mostre pastas '
            + 'no gerenciador de arquivos (open_folder; list_drives mostra o Google Drive/rclone), confira com screenshot/read_page '
            + 'e avise com notify (push com som no celular). Para começar um projeto novo com o usuário, use start_vibecoding. '
            + 'A sua aba de terminal está em $MEUTERMINAL_TAB_ID: passe como terminal_tab_id.',
    });
}

/** Stable token for the MCP endpoint, created once and kept in the database. */
function mcpToken(store) {
    const row = store.db.prepare(`SELECT value FROM meta WHERE key = 'mcp_token'`).get();
    if (row) return row.value;
    const token = crypto.randomBytes(24).toString('base64url');
    store.db.prepare(`INSERT INTO meta (key, value) VALUES ('mcp_token', ?)`).run(token);
    return token;
}

module.exports = { createMcpHandler, mcpToken };
