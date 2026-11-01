/**
 * registry.js
 * Which coding agents the agent UI knows about and how to start each one over ACP.
 * Agents with terminalOnly have no usable structured mode and stay in the plain terminal.
 */
const path = require('path');

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
    // agy has no ACP mode: agy-acp.js adapts its stream-json headless mode (no permission prompts there)
    agy: {
        label: 'agy',
        uiName: 'agy UI',
        command: process.execPath,
        args: [path.join(__dirname, 'agy-acp.js')],
        requires: 'agy',
        install: 'instale o Antigravity CLI (agy) e faça login',
    },
};

/**
 * Merges optional overrides from the environment, e.g.
 *   MT_AGENT_CLAUDE_COMMAND=/opt/bin/claude-agent-acp
 *   MT_AGENT_CLAUDE_ARGS='["--flag"]'   (JSON array; with a custom command it replaces the args)
 * @param {object} [env]
 */
function loadAgents(env = process.env) {
    const agents = {};
    for (const [id, def] of Object.entries(AGENTS)) {
        const command = env[`MT_AGENT_${id.toUpperCase()}_COMMAND`];
        let args = null;
        try {
            const parsed = JSON.parse(env[`MT_AGENT_${id.toUpperCase()}_ARGS`] || 'null');
            if (Array.isArray(parsed)) args = parsed.map(String);
        } catch { /* invalid JSON: ignored */ }
        // defaultCommand: o adaptador de sempre continua "deste agente" mesmo com o comando trocado
        // (a detecção não o mostra como um agente a mais)
        agents[id] = { ...def, defaultCommand: def.command };
        if (command) Object.assign(agents[id], { command, args: args || [] });
        else if (args) agents[id].args = args;
    }
    return agents;
}

module.exports = { AGENTS, loadAgents };
