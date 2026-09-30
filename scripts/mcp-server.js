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

const SERVER_INFO = { name: 'meuterminal', version: require('../package.json').version };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

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
            },
            required: ['url'],
        },
    },
    {
        name: 'open_folder',
        description: 'Abre uma pasta do servidor numa nova aba de terminal do MeuTerminal (o shell já começa '
            + 'nessa pasta). Use quando o usuário pedir para abrir/ir para uma pasta ou projeto.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Caminho absoluto; "~" = home. Relativo = a partir da home.' },
                name: { type: 'string', description: 'Nome da aba (opcional; padrão = nome da pasta).' },
                background: { type: 'boolean', description: 'true = abre sem trocar a aba que o usuário está vendo.' },
            },
            required: ['path'],
        },
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
        description: 'Fecha uma aba de navegador (abas de terminal não podem ser fechadas por aqui).',
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
        description: 'Mostra um aviso rápido na tela do MeuTerminal (ex.: "Build pronto").',
        inputSchema: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
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
function createMcpTools({ sessions, store, browsers, listPorts, normalizeUrl, port }) {
    let lastBrowserTab = null;

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
        async open_url({ url, name, background }) {
            if (!browsers.available) throw new ToolError('Chromium não está instalado no servidor.');
            const target = normalizeUrl(url);
            if (!target) throw new ToolError('URL inválida.');
            const tab = sessions.create({ kind: 'browser', url: target, name });
            lastBrowserTab = tab.id;
            // Tell the open app windows to show it (unless the agent asked for background)
            if (!background) sessions.broadcast({ type: 'open-tab', id: tab.id });
            // The page opens at the tab's URL; wait for it so the agent gets the real title
            let state = { url: target, title: '' };
            try {
                const page = await browsers.ensurePage(store.get(tab.id));
                await browsers.waitForLoad(page, 15000);
                state = page.state;
            } catch { /* the tab exists; the page may still be loading */ }
            return text({ tab_id: tab.id, url: state.url, title: state.title });
        },
        open_folder({ path: folder, name, background }) {
            const raw = String(folder || '').trim();
            if (!raw || raw.length > 4096) throw new ToolError('Caminho inválido.');
            const home = os.homedir();
            const resolved = path.resolve(home, raw.replace(/^~(?=$|[\\/])/, home));
            let stat = null;
            try { stat = fs.statSync(resolved); } catch { /* reported below */ }
            if (!stat) throw new ToolError(`Pasta não encontrada: ${resolved}`);
            if (!stat.isDirectory()) throw new ToolError(`Não é uma pasta: ${resolved}`);
            const tab = sessions.create({ kind: 'terminal', cwd: resolved, name: name || path.basename(resolved) || resolved });
            if (!background) sessions.broadcast({ type: 'open-tab', id: tab.id });
            return text({ tab_id: tab.id, cwd: resolved, name: tab.name });
        },
        list_tabs() {
            return text(store.listOpen().map(r => ({
                tab_id: r.id,
                kind: r.kind || 'terminal',
                name: r.name,
                ...(r.kind === 'browser' ? { url: r.url } : { cwd: r.cwd || r.start_cwd || null }),
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
            if (row.kind !== 'browser') throw new ToolError('Por segurança, abas de terminal só podem ser fechadas pelo usuário.');
            await browsers.closePage(row.id);
            sessions.close(row.id);
            if (lastBrowserTab === row.id) lastBrowserTab = null;
            return text(`Aba ${row.name} fechada.`);
        },
        async list_ports() {
            return text(await listPorts([port]));
        },
        notify({ message }) {
            const msg = String(message || '').slice(0, 300);
            if (!msg) throw new ToolError('Mensagem vazia.');
            sessions.broadcast({ type: 'notify', message: msg });
            return text('Aviso mostrado.');
        },
    };
}

/**
 * Express handler for POST /mcp (JSON-RPC 2.0). Responses are plain JSON (allowed by
 * the Streamable HTTP transport); no server-initiated messages are needed.
 */
function createMcpHandler(deps) {
    const tools = createMcpTools(deps);

    async function handle(msg) {
        const { id, method, params = {} } = msg || {};
        const isNotification = id === undefined || id === null;
        const reply = result => (isNotification ? null : { jsonrpc: '2.0', id, result });
        const fail = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

        switch (method) {
            case 'initialize': {
                const asked = params.protocolVersion;
                return reply({
                    protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions: 'Ferramentas do MeuTerminal: abra páginas (open_url) para o usuário ver o '
                        + 'resultado, abra pastas em novas abas de terminal (open_folder), confira com screenshot/read_page e avise com notify.',
                });
            }
            case 'ping':
                return reply({});
            case 'tools/list':
                return reply({ tools: TOOLS });
            case 'tools/call': {
                const tool = tools[params.name];
                if (!tool) return fail(-32602, `Ferramenta desconhecida: ${params.name}`);
                try {
                    return reply(await tool(params.arguments || {}));
                } catch (e) {
                    // Tool errors go back to the agent as a result it can read, not a protocol error
                    return reply({ content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true });
                }
            }
            default:
                if (method && method.startsWith('notifications/')) return null;
                return fail(-32601, `Método não suportado: ${method}`);
        }
    }

    return async (req, res) => {
        const body = req.body;
        if (Array.isArray(body)) {
            const results = (await Promise.all(body.map(handle))).filter(Boolean);
            if (!results.length) return res.status(202).end();
            return res.json(results);
        }
        const result = await handle(body);
        if (!result) return res.status(202).end(); // notification: accepted, no body
        return res.json(result);
    };
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
