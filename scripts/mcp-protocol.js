/**
 * mcp-protocol.js
 * The protocol side of an MCP server (JSON-RPC 2.0 over the Streamable HTTP transport),
 * separate from any particular set of tools: initialize, ping, tools/list, tools/call,
 * notifications and batches. Responses are plain JSON (allowed by the transport); no
 * server-initiated messages are needed. mcp-server.js plugs in the local tools.
 */

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * @param {object} opts
 * @param {object[]} opts.tools - tool definitions returned by tools/list
 * @param {Record<string, (args: object, ctx: {req: object}) => Promise<object>|object>} opts.impl - name -> implementation
 * @param {{ name: string, version: string }} opts.serverInfo
 * @param {string} [opts.instructions]
 * @param {(name: string, args: object, outcome: { ok: boolean, ms: number, result?: object, error?: Error }, ctx: {req: object}) => void} [opts.onCall]
 * @returns {(req, res) => Promise<void>} Express handler for POST
 */
function createJsonRpcHandler({ tools, impl, serverInfo, instructions, onCall }) {
    const listed = () => (typeof tools === 'function' ? tools() : tools);

    async function handle(msg, ctx) {
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
                    serverInfo,
                    ...(instructions ? { instructions } : {}),
                });
            }
            case 'ping':
                return reply({});
            case 'tools/list':
                return reply({ tools: listed() });
            case 'tools/call': {
                const tool = typeof params.name === 'string' && Object.hasOwn(impl, params.name) ? impl[params.name] : null;
                if (!tool) return fail(-32602, `Ferramenta desconhecida: ${params.name}`);
                const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
                const startedAt = Date.now();
                try {
                    const result = await tool(args, ctx);
                    onCall?.(params.name, args, { ok: !result?.isError, ms: Date.now() - startedAt, result }, ctx);
                    return reply(result);
                } catch (e) {
                    onCall?.(params.name, args, { ok: false, ms: Date.now() - startedAt, error: e }, ctx);
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
        const ctx = { req };
        if (Array.isArray(body)) {
            const results = (await Promise.all(body.map(m => handle(m, ctx)))).filter(Boolean);
            if (!results.length) return res.status(202).end();
            return res.json(results);
        }
        const result = await handle(body, ctx);
        if (!result) return res.status(202).end(); // notification: accepted, no body
        return res.json(result);
    };
}

module.exports = { createJsonRpcHandler, SUPPORTED_VERSIONS };
