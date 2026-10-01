/**
 * launch-client.js
 * Run by the agent shims (~/.meuterminal/bin/claude...) inside MeuTerminal shells. Asks the
 * server whether to open the agent in the agent UI. Exit 0 = UI took over; anything else = terminal.
 */

// Only a bare interactive start is offered to the UI: `claude` or `claude "a prompt"`.
// Subcommands and flags (claude -p, codex exec, opencode run...) always stay in the terminal.
const SUBCOMMANDS = {
    claude: ['mcp', 'config', 'update', 'doctor', 'install', 'setup-token', 'plugin', 'plugins', 'migrate-installer', 'agents', 'help'],
    codex: ['exec', 'e', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug',
        'apply', 'a', 'resume', 'proto', 'cloud', 'help', 'features'],
    opencode: ['run', 'serve', 'auth', 'acp', 'agent', 'upgrade', 'uninstall', 'models', 'stats', 'export', 'import',
        'github', 'mcp', 'web', 'debug', 'attach', 'pr', 'session', 'help'],
    agy: ['agent', 'agents', 'changelog', 'help', 'install', 'mcp', 'mic-serve', 'models', 'plugin', 'plugins', 'remote-control', 'update'],
};

const TERMINAL = 3; // exit code: run the real binary

/**
 * @returns {{ intercept: false } | { intercept: true, prompt: string|null }}
 */
function classify(agent, args) {
    if (!SUBCOMMANDS[agent]) return { intercept: false };
    if (args.length === 0) return { intercept: true, prompt: null };
    if (args.length === 1 && !args[0].startsWith('-') && !SUBCOMMANDS[agent].includes(args[0])) {
        return { intercept: true, prompt: args[0] };
    }
    return { intercept: false };
}

async function main(argv, env) {
    const [agent, ...args] = argv;
    const decision = classify(agent, args);
    if (!decision.intercept) return TERMINAL;
    const url = env.MEUTERMINAL_API_URL;
    const token = env.MEUTERMINAL_MCP_TOKEN;
    if (!url || !token) return TERMINAL;

    // The server waits for the popup answer (up to ~60 s); a bit more here for the network
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90 * 1000);
    try {
        const response = await fetch(`${url.replace(/\/+$/, '')}/agent-launch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ agent, cwd: process.cwd(), tabId: env.MEUTERMINAL_TAB_ID || null, prompt: decision.prompt }),
            signal: controller.signal,
        });
        if (!response.ok) return TERMINAL;
        const result = await response.json();
        if (result.message) process.stderr.write(`\x1b[2m${result.message}\x1b[0m\n`);
        return result.action === 'ui' ? 0 : TERMINAL;
    } catch {
        return TERMINAL; // server unreachable, timeout...: never block the user's agent
    } finally {
        clearTimeout(timer);
    }
}

if (require.main === module) {
    main(process.argv.slice(2), process.env).then(code => process.exit(code), () => process.exit(TERMINAL));
}

module.exports = { classify, main, SUBCOMMANDS, TERMINAL };
