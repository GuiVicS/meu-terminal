/**
 * addons.js
 * Complementos que já vêm no MeuTerminal: plugins do Claude Code instalados uma única vez no
 * escopo do usuário (~/.claude), então valem no terminal e no Modo UI (claude-agent-acp lê as
 * mesmas configurações e plugins do usuário).
 *
 * - Cada complemento é instalado só na primeira vez ("semeado"). Se o usuário desinstalar ou
 *   desligar depois, ele não volta sozinho: o estado fica em <data>/addons.json.
 * - Configurações padrão só preenchem chaves que ainda não existem; o que o usuário mudou fica.
 * - Roda em segundo plano depois que o servidor sobe; falha de rede só gera log e tenta de novo
 *   no próximo início.
 * - MT_ADDONS=off desliga tudo; MT_ADDONS=claude-mem,cartographer escolhe quais.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ADDONS = [
    {
        id: 'claude-code-setup',
        label: 'Claude Code Setup',
        plugin: 'claude-code-setup',
        marketplace: 'claude-plugins-official',
        source: 'anthropics/claude-plugins-official',
    },
    {
        id: 'cartographer',
        label: 'Cartographer',
        plugin: 'cartographer',
        marketplace: 'cartographer-marketplace',
        source: 'kingbootoshi/cartographer',
    },
    {
        id: 'claude-mem',
        label: 'Claude Mem',
        plugin: 'claude-mem',
        marketplace: 'thedotmack',
        source: 'thedotmack/claude-mem',
        // Usa o plano do próprio usuário (sem teste grátis nem login no cmem.ai), resumos com
        // Haiku, sem sincronização na nuvem, trabalhador só em 127.0.0.1.
        settingsFile: '.claude-mem/settings.json',
        settings: {
            CLAUDE_MEM_PROVIDER: 'claude',
            CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
            CLAUDE_MEM_MODEL: 'haiku',
            CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
            CLAUDE_MEM_WORKER_PORT: '37700',
            CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
        },
        env: { CLAUDE_MEM_ONLINE_OPTIN: 'false' },
        // Os hooks chamam o comando "claude-mem", que o plugin só cria no início da primeira
        // sessão (e os outros hooks dessa sessão já precisam dele): cria agora.
        postInstall: ['scripts/ensure-launcher.cjs'],
    },
];

const pluginId = a => `${a.plugin}@${a.marketplace}`;

/** Which add-ons MT_ADDONS selects (default: all). */
function selectedAddons(value = process.env.MT_ADDONS) {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === 'on' || v === 'all' || v === 'true') return ADDONS;
    if (['off', 'none', 'false', '0'].includes(v)) return [];
    const ids = new Set(v.split(',').map(s => s.trim()));
    return ADDONS.filter(a => ids.has(a.id));
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/**
 * Adds default keys that are missing; never overwrites a key the user already has.
 * @returns {string[]} keys that were added
 */
function mergeDefaults(file, defaults) {
    const current = readJson(file, {});
    const added = Object.keys(defaults).filter(k => !(k in current));
    if (added.length) writeJson(file, { ...current, ...Object.fromEntries(added.map(k => [k, defaults[k]])) });
    return added;
}

/** Runs `node <script>` (post-install steps); resolves like runClaude. */
function runNode(script, { env, cwd, timeoutMs = 180000 } = {}) {
    return new Promise(resolve => {
        execFile(process.execPath, [script], { env, cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : '')) });
        });
    });
}

/** Runs `claude <args>`; resolves { code, stdout, stderr } (never rejects). */
function runClaude(args, { env, timeoutMs = 180000, claudeBin = 'claude' } = {}) {
    return new Promise(resolve => {
        execFile(claudeBin, args, { env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
            resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : '')) });
        });
    });
}

function parseJsonOut(text) {
    try { return JSON.parse(text); } catch { /* fall through */ }
    const last = String(text).trim().split('\n').pop();
    try { return JSON.parse(last); } catch { return null; }
}

class Addons {
    /**
     * @param {object} opts
     * @param {string} opts.stateFile - <data>/addons.json
     * @param {string} [opts.home] - where ~/.claude and ~/.claude-mem live
     * @param {Function} [opts.run] - runClaude replacement (tests)
     * @param {object[]} [opts.addons]
     * @param {Function} [opts.log]
     */
    constructor({ stateFile, home = os.homedir(), run = runClaude, runScript = runNode, addons = selectedAddons(), env = process.env, log = () => {} }) {
        this.stateFile = stateFile;
        this.home = home;
        this.run = run;
        this.runScript = runScript;
        this.addons = addons;
        this.env = env;
        this.log = log;
        this.running = null;
    }

    state() {
        return readJson(this.stateFile, { seeded: {} });
    }

    /** @returns {Promise<object[]|null>} [{ id, installPath, enabled, version }] or null if the CLI failed */
    async pluginList() {
        const r = await this.run(['plugin', 'list', '--json'], { env: this.childEnv() });
        const list = r.code === 0 ? parseJsonOut(r.stdout) : null;
        return Array.isArray(list) ? list.filter(p => p && p.id) : null;
    }

    async installedPlugins() {
        const list = await this.pluginList();
        return list && list.map(p => p.id);
    }

    childEnv(extra = {}) {
        return { ...this.env, HOME: this.home, CI: '1', ...extra };
    }

    /** Installs every add-on not seeded yet. Safe to call again; concurrent calls share one run. */
    bootstrap() {
        if (!this.running) this.running = this.doBootstrap().finally(() => { this.running = null; });
        return this.running;
    }

    async doBootstrap() {
        const state = this.state();
        state.seeded = state.seeded || {};
        const results = [];
        const pending = this.addons.filter(a => !state.seeded[a.id]);
        if (!pending.length) return results;

        const installed = await this.installedPlugins();
        if (installed === null) {
            this.log('Complementos: "claude plugin list" falhou; tento de novo no próximo início');
            return results;
        }
        for (const addon of pending) {
            const id = pluginId(addon);
            let outcome;
            if (installed.includes(id)) {
                outcome = 'já instalado';
            } else {
                const r = await this.run(['plugin', 'install', addon.plugin, '--marketplace', addon.source, '--scope', 'user', '--json'],
                    { env: this.childEnv(addon.env) });
                if (r.code !== 0) {
                    const why = (parseJsonOut(r.stdout)?.error || r.stderr || r.stdout).toString().trim().split('\n').pop().slice(0, 300);
                    this.log(`Complementos: falha ao instalar ${addon.label}: ${why}`);
                    results.push({ id: addon.id, ok: false, error: why });
                    continue;
                }
                outcome = 'instalado';
            }
            if (addon.postInstall) {
                const info = (await this.pluginList() || []).find(p => p.id === id);
                for (const rel of addon.postInstall) {
                    if (!info?.installPath) { this.log(`Complementos: ${addon.label}: pasta do plugin não encontrada`); break; }
                    const r = await this.runScript(path.join(info.installPath, rel),
                        { env: this.childEnv({ ...addon.env, CLAUDE_PLUGIN_ROOT: info.installPath }), cwd: this.home });
                    if (r.code !== 0) this.log(`Complementos: ${addon.label}: ${rel} falhou (o plugin tenta de novo ao abrir uma sessão): ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
                }
            }
            if (addon.settingsFile) {
                const added = mergeDefaults(path.join(this.home, addon.settingsFile), addon.settings);
                if (added.length) outcome += `; padrões: ${added.join(', ')}`;
            }
            state.seeded[addon.id] = { plugin: id, at: new Date().toISOString() };
            writeJson(this.stateFile, state);
            this.log(`Complementos: ${addon.label} ${outcome}`);
            results.push({ id: addon.id, ok: true, outcome });
        }
        return results;
    }

    /** For the settings page: each add-on, whether it was seeded and whether it's installed now. */
    async status() {
        const seeded = this.state().seeded || {};
        const installed = await this.installedPlugins();
        return ADDONS.map(a => ({
            id: a.id,
            label: a.label,
            plugin: pluginId(a),
            selected: this.addons.includes(a),
            seeded: !!seeded[a.id],
            installed: installed ? installed.includes(pluginId(a)) : null,
        }));
    }
}

module.exports = { Addons, ADDONS, selectedAddons, mergeDefaults, runClaude, runNode };
