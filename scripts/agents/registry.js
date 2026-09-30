/**
 * registry.js
 * Which coding agents the agent UI knows about and how to start each one over ACP.
 * Agents with terminalOnly have no usable structured mode and stay in the plain terminal.
 */

/**
 * command/args: how to start the agent speaking ACP on stdio.
 * uiName: name shown in the "usar modo ...?" popup.
 * install: hint shown when the command is missing.
 */
const AGENTS = {
    claude: {
        label: 'Claude Code',
        uiName: 'Claude Code UI',
        command: 'claude-agent-acp',
        args: [],
        install: 'npm install -g @agentclientprotocol/claude-agent-acp',
    },
    opencode: {
        label: 'OpenCode',
        uiName: 'OpenCode UI',
        command: 'opencode',
        args: ['acp'],
        install: 'npm install -g opencode-ai',
    },
    codex: {
        label: 'Codex',
        uiName: 'Codex UI',
        command: 'codex-acp',
        args: [],
        install: 'npm install -g @agentclientprotocol/codex-acp (e faça login com "codex login")',
    },
    // agy has no ACP mode and its headless mode cannot ask for permissions (Phase 0 findings)
    agy: {
        label: 'agy',
        uiName: 'agy UI',
        terminalOnly: true,
    },
};

/**
 * Merges optional overrides, e.g. from env MT_AGENT_CLAUDE_COMMAND="/opt/bin/claude-agent-acp".
 * @param {object} [env]
 */
function loadAgents(env = process.env) {
    const agents = {};
    for (const [id, def] of Object.entries(AGENTS)) {
        const key = `MT_AGENT_${id.toUpperCase()}_COMMAND`;
        agents[id] = env[key] ? { ...def, command: env[key], args: [] } : { ...def };
    }
    return agents;
}

module.exports = { AGENTS, loadAgents };
