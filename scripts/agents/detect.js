/**
 * detect.js
 * Descobre as IAs de terminal instaladas no servidor e como ligar cada uma ao Modo UI (ACP), sem
 * lista fixa do que "deveria" existir:
 *  - qualquer adaptador ACP instalado (executável "<nome>-acp") vira um agente;
 *  - CLIs de IA conhecidas entram só se a própria ajuda (--help) mostra o modo ACP (subcomando
 *    "acp" ou opção "--acp"/"--experimental-acp"), que é o que confirma que funcionam no Modo UI;
 *  - procura no PATH do servidor e nas pastas onde instaladores de usuário põem os programas.
 * O resultado fica em cache e é refeito de tempos em tempos (instalou, aparece).
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** Pastas de programas do usuário que o PATH do servidor não tem (instaladores npm, bun, curl...). */
function searchDirs(env, home) {
    const extra = ['.local/bin', '.npm-global/bin', '.opencode/bin', '.bun/bin', '.cargo/bin', 'go/bin', '.deno/bin', 'bin']
        .map(d => path.join(home, d));
    return [...new Set([...(env.PATH || '').split(path.delimiter).filter(Boolean), ...extra])];
}

function isExecutable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

/** Caminho absoluto do comando, ou null. */
function which(command, dirs) {
    if (path.isAbsolute(command)) return isExecutable(command) ? command : null;
    for (const dir of dirs) {
        const file = path.join(dir, command);
        if (isExecutable(file)) return file;
    }
    return null;
}

/**
 * CLIs de IA que podem falar ACP: nome do executável, nome na tela e as formas de ligar o ACP a
 * testar na ajuda (a primeira que aparecer na ajuda é a usada).
 */
const CANDIDATES = [
    { bin: 'gemini', label: 'Gemini CLI', modes: [['--experimental-acp'], ['--acp']] },
    { bin: 'qwen', label: 'Qwen Code', modes: [['--acp'], ['--experimental-acp']] },
    { bin: 'goose', label: 'Goose', modes: [['acp']] },
    { bin: 'kimi', label: 'Kimi CLI', modes: [['--acp'], ['acp']] },
    { bin: 'copilot', label: 'GitHub Copilot', modes: [['--acp']] },
    { bin: 'auggie', label: 'Auggie', modes: [['--acp']] },
    { bin: 'kiro-cli', label: 'Kiro', modes: [['acp']] },
    { bin: 'vibe', label: 'Mistral Vibe', modes: [['--acp'], ['acp']] },
    { bin: 'openhands', label: 'OpenHands', modes: [['acp'], ['--acp']] },
    { bin: 'crush', label: 'Crush', modes: [['acp'], ['--acp']] },
    { bin: 'droid', label: 'Droid', modes: [['acp'], ['--acp']] },
    { bin: 'cursor-agent', label: 'Cursor Agent', modes: [['acp'], ['--acp']] },
    { bin: 'amp', label: 'Amp', modes: [['acp'], ['--acp']] },
];

/** A ajuda do programa (stdout+stderr), com tempo-limite curto. */
function helpText(file, env) {
    return new Promise(resolve => {
        execFile(file, ['--help'], { env, timeout: 6000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
            resolve(`${stdout || ''}\n${stderr || ''}`);
        });
    });
}

/** A forma de ligar o ACP que a ajuda mostra, ou null. */
function acpModeFrom(help, modes) {
    for (const args of modes) {
        const flag = args[0];
        const re = flag.startsWith('-')
            ? new RegExp(`(^|[\\s,\\[])${flag.replace(/[-]/g, '\\-')}(\\b|=|\\s|,|$)`, 'm')
            : new RegExp(`^\\s+${flag}(\\s|$)`, 'm'); // subcomando listado na ajuda
        if (re.test(help)) return args;
    }
    return null;
}

const titleCase = s => s.split(/[-_]/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/**
 * @param {object} opts
 * @param {object} opts.known - agentes já conhecidos (registry.js), para não repetir
 * @param {object} [opts.env]
 * @param {string} opts.home
 * @returns {Promise<{ found: object, paths: object }>} found: novos agentes (id -> def);
 *   paths: id -> caminho absoluto de cada comando conhecido que está instalado
 */
async function detectAgents({ known, env = process.env, home, helpImpl = helpText }) {
    const dirs = searchDirs(env, home);
    const found = {};
    const paths = {};
    const claimed = new Set();
    for (const [id, def] of Object.entries(known)) {
        if (def.terminalOnly) continue;
        const cmd = def.requires || def.command;
        const file = which(cmd, dirs);
        if (file) paths[id] = file;
        claimed.add(path.basename(def.command));
        if (def.defaultCommand) claimed.add(path.basename(def.defaultCommand));
        if (def.requires) claimed.add(def.requires);
        claimed.add(id);
    }
    // Adaptadores ACP instalados ("<nome>-acp"): ligam direto
    for (const dir of dirs) {
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const name of names) {
            if (!name.endsWith('-acp') || claimed.has(name)) continue;
            const file = path.join(dir, name);
            if (!isExecutable(file)) continue;
            const base = name.replace(/-acp$/, '').replace(/^@?[\w-]+\//, '');
            const id = base.replace(/[^\w-]/g, '').toLowerCase();
            if (!id || known[id] || found[id]) continue;
            claimed.add(name);
            found[id] = { label: titleCase(base), uiName: `${titleCase(base)} UI`, command: file, args: [], install: '', detected: true };
        }
    }
    // CLIs de IA conhecidas que mostram o modo ACP na ajuda
    await Promise.all(CANDIDATES.map(async c => {
        if (claimed.has(c.bin) || known[c.bin] || found[c.bin]) return;
        const file = which(c.bin, dirs);
        if (!file) return;
        const args = acpModeFrom(await helpImpl(file, env), c.modes);
        if (!args) return;
        found[c.bin] = { label: c.label, uiName: `${c.label} UI`, command: file, args, install: '', detected: true };
    }));
    return { found, paths };
}

module.exports = { detectAgents, searchDirs, which, acpModeFrom, CANDIDATES };
