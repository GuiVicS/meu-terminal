/**
 * integrations.js
 * Skills e MCPs instalados uma vez, valendo em todos os agentes e contas. Cada ferramenta continua
 * lendo o próprio arquivo, no formato oficial dela; aqui fica só o cadastro e quem grava nesses
 * arquivos. Entrada que não foi criada por aqui nunca é alterada sem um pedido explícito.
 *
 * MCP: cadastro em ~/.meuterminal/integracoes.json; destino = agente + conta.
 *   Claude      ~/.claude.json e <conta>/.claude.json (a conta tem o seu)
 *   Codex       ~/.codex/config.toml (as contas apontam para ele)
 *   OpenCode    ~/.config/opencode/opencode.json (config única; só os dados são por conta)
 *   Antigravity ~/.gemini/config/mcp_config.json (cada conta tem a sua pasta .gemini)
 * Skills: pasta única ~/.agents/skills, que Codex e OpenCode já leem; Claude e Antigravity recebem
 * um link por skill nas pastas deles.
 *
 * Os valores de env e cabeçalhos são segredos: nunca saem de overview() nem das mensagens de erro.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const NAME_RE = /^[A-Za-z0-9][\w-]{0,63}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYNC_EVERY_MS = 30 * 1000;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function sorted(value) {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])]));
    }
    return value;
}
const canonical = spec => JSON.stringify(sorted(spec));
const hashOf = spec => crypto.createHash('sha256').update(canonical(spec)).digest('hex').slice(0, 16);

/** Mesmo serviço, mesmo que escrito de outro jeito ou com outro nome. */
function endpointOf(spec) {
    if (spec.type === 'http') return `http:${String(spec.url).replace(/\/+$/, '').toLowerCase()}`;
    return `stdio:${spec.command} ${(spec.args || []).join(' ')}`;
}

/** O que dá para mostrar: nada de query string, argumentos ou valores. */
function publicSpec(spec) {
    const out = { type: spec.type };
    if (spec.type === 'http') {
        try {
            const u = new URL(spec.url);
            out.address = `${u.origin}${u.pathname}`;
        } catch {
            out.address = '(endereço inválido)';
        }
        out.secretNames = Object.keys(spec.headers || {});
    } else {
        out.address = path.basename(String(spec.command || ''));
        out.secretNames = Object.keys(spec.env || {});
    }
    return out;
}

/** Valida e limpa o que vem do formulário. */
function cleanSpec(input) {
    const strings = obj => Object.fromEntries(Object.entries(obj || {})
        .filter(([k, v]) => k && v !== undefined && v !== null).map(([k, v]) => [String(k), String(v)]));
    if (input?.type === 'http') {
        let url;
        try {
            url = new URL(String(input.url));
        } catch {
            throw fail('Endereço inválido.');
        }
        if (!/^https?:$/.test(url.protocol)) throw fail('O endereço precisa começar com http ou https.');
        const headers = strings(input.headers);
        return { type: 'http', url: url.href, ...(Object.keys(headers).length ? { headers } : {}) };
    }
    if (input?.type === 'stdio') {
        const command = String(input.command || '').trim();
        if (!command) throw fail('Informe o comando.');
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        const env = strings(input.env);
        for (const key of Object.keys(env)) if (!ENV_NAME_RE.test(key)) throw fail(`Nome de variável inválido: ${key}`);
        return { type: 'stdio', command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
    }
    throw fail('Tipo de MCP inválido.');
}

// ---------- formatos de cada ferramenta ----------

const nonEmpty = obj => (obj && Object.keys(obj).length ? obj : undefined);
const compact = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const FORMATS = {
    claude: {
        key: 'mcpServers',
        toSpec(v) {
            if (v.url) return compact({ type: 'http', url: v.url, headers: nonEmpty(v.headers) });
            return compact({ type: 'stdio', command: v.command, args: nonEmpty(v.args), env: nonEmpty(v.env) });
        },
        from(s) {
            return s.type === 'http' ? compact({ type: 'http', url: s.url, headers: s.headers })
                : compact({ type: 'stdio', command: s.command, args: s.args || [], env: s.env || {} });
        },
    },
    opencode: {
        key: 'mcp',
        toSpec(v) {
            if (v.type === 'remote') return compact({ type: 'http', url: v.url, headers: nonEmpty(v.headers) });
            const [command, ...args] = v.command || [];
            return compact({ type: 'stdio', command, args: nonEmpty(args), env: nonEmpty(v.environment) });
        },
        from(s) {
            return s.type === 'http' ? compact({ type: 'remote', url: s.url, enabled: true, headers: s.headers })
                : compact({ type: 'local', command: [s.command, ...(s.args || [])], enabled: true, environment: s.env });
        },
    },
    agy: {
        key: 'mcpServers',
        toSpec(v) {
            const url = v.serverUrl || v.url;
            if (url) return compact({ type: 'http', url, headers: nonEmpty(v.headers) });
            return compact({ type: 'stdio', command: v.command, args: nonEmpty(v.args), env: nonEmpty(v.env) });
        },
        from(s) {
            return s.type === 'http' ? compact({ serverUrl: s.url, headers: s.headers })
                : compact({ command: s.command, args: s.args || [], env: s.env });
        },
    },
};

/** Vazio = sem nada. JSON quebrado é erro: não se grava em cima do que não se entendeu. */
function readJson(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return {};
        throw e;
    }
    if (!raw.trim()) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw fail(`${path.basename(file)} não é um JSON válido; corrija o arquivo para sincronizar.`, 409);
    }
}

function writeAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const real = fs.existsSync(file) ? fs.realpathSync(file) : file; // mantém um link como link
    const tmp = `${real}.meuterminal-${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, real);
}

// ---------- TOML do Codex: só as seções do próprio MCP são tocadas ----------

const tomlKey = key => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

function tomlSection(name, spec) {
    const lines = [`[mcp_servers.${name}]`];
    const table = (label, values) => {
        if (!values || !Object.keys(values).length) return;
        lines.push('', `[mcp_servers.${name}.${label}]`);
        for (const [k, v] of Object.entries(values)) lines.push(`${tomlKey(k)} = ${JSON.stringify(v)}`);
    };
    if (spec.type === 'http') {
        lines.push(`url = ${JSON.stringify(spec.url)}`);
        table('http_headers', spec.headers);
    } else {
        lines.push(`command = ${JSON.stringify(spec.command)}`);
        lines.push(`args = ${JSON.stringify(spec.args || [])}`);
        table('env', spec.env);
    }
    return lines.join('\n');
}

function tomlRemove(text, name) {
    const own = new RegExp(`^\\s*\\[mcp_servers\\.(?:${name}|"${name}")(?:\\.[^\\]]*)?\\]\\s*(?:#.*)?$`);
    const out = [];
    let skipping = false;
    for (const line of text.split('\n')) {
        if (/^\s*\[/.test(line)) skipping = own.test(line);
        if (!skipping) out.push(line);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

function tomlApply(text, { set = {}, remove = [] }) {
    let next = text;
    for (const name of [...remove, ...Object.keys(set)]) next = tomlRemove(next, name);
    next = next.replace(/\s*$/, '');
    for (const [name, spec] of Object.entries(set)) next = `${next}${next ? '\n\n' : ''}${tomlSection(name, spec)}`;
    return next ? `${next}\n` : '';
}

class Integrations {
    /**
     * @param {object} opts
     * @param {string} opts.home
     * @param {object} opts.accounts - { claude, codex, opencode, agy } (scripts/*-accounts.js)
     * @param {Function} [opts.exec]
     * @param {object} [opts.env] - ambiente para rodar os CLIs
     */
    constructor({ home, accounts, exec = execFile, env = process.env, now = Date.now }) {
        this.home = home;
        this.accounts = accounts;
        this.exec = exec;
        this.env = env;
        this.now = now;
        this.file = path.join(home, '.meuterminal', 'integracoes.json');
        this.copies = path.join(home, '.meuterminal', 'integracoes-copias');
        this.agentsSkills = path.join(home, '.agents', 'skills');
        this.removedSkills = path.join(home, '.agents', '.skills-removidas');
        this.claudeSkills = path.join(home, '.claude', 'skills');
        this.queue = Promise.resolve();
        this.lastSync = 0;
    }

    /** Um por vez: duas gravações juntas perderiam entradas. */
    serial(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => {});
        return run;
    }

    load() {
        const data = readJson(this.file);
        return { servers: data.servers || {}, managed: data.managed || {} };
    }

    save(state) {
        writeAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`);
    }

    /** Cópia de segurança do arquivo de uma ferramenta, uma só por arquivo: a de antes da 1ª gravação. */
    backup(file) {
        if (!fs.existsSync(file) || !fs.statSync(file).size) return;
        fs.mkdirSync(this.copies, { recursive: true, mode: 0o700 });
        const name = file.replace(this.home, '').replace(/[^\w.-]+/g, '_').replace(/^_+/, '');
        const copy = path.join(this.copies, name);
        if (!fs.existsSync(copy)) fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(copy, 0o600);
    }

    // ---------- destinos ----------

    targets() {
        const list = [{ id: 'claude', agent: 'claude', label: 'Principal', file: path.join(this.home, '.claude.json') }];
        for (const id of this.accounts.claude?.ids() || []) {
            list.push({ id: `claude:${id}`, agent: 'claude', label: id, file: path.join(this.accounts.claude.dirOf(id), '.claude.json') });
        }
        list.push({ id: 'codex', agent: 'codex', label: 'Todas as contas', file: path.join(this.home, '.codex', 'config.toml') });
        list.push({ id: 'opencode', agent: 'opencode', label: 'Todas as contas', file: path.join(this.home, '.config', 'opencode', 'opencode.json') });
        list.push({ id: 'agy', agent: 'agy', label: 'Principal', file: path.join(this.home, '.gemini', 'config', 'mcp_config.json') });
        for (const id of this.accounts.agy?.ids() || []) {
            list.push({ id: `agy:${id}`, agent: 'agy', label: id, file: path.join(this.accounts.agy.dirOf(id), '.gemini', 'config', 'mcp_config.json') });
        }
        return list;
    }

    codexList() {
        const env = { ...this.env, HOME: this.home };
        delete env.CODEX_HOME;
        return new Promise((resolve, reject) => {
            this.exec('codex', ['mcp', 'list', '--json'], { env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
                if (err) {
                    reject(err.code === 'ENOENT' ? fail('Codex não instalado.', 404) : fail('Não deu para ler os MCPs do Codex.', 500));
                    return;
                }
                try {
                    resolve(JSON.parse(stdout));
                } catch {
                    reject(fail('Não deu para ler os MCPs do Codex.', 500));
                }
            });
        });
    }

    /** O que o destino tem hoje, no formato comum. Pode lançar (status 409 = arquivo quebrado). */
    async read(target) {
        if (target.agent === 'codex') {
            const out = {};
            for (const s of await this.codexList()) {
                const t = s.transport || {};
                out[s.name] = t.url
                    ? compact({ type: 'http', url: t.url, headers: nonEmpty(t.http_headers), bearerEnv: t.bearer_token_env_var || undefined })
                    : compact({ type: 'stdio', command: t.command, args: nonEmpty(t.args), env: nonEmpty(t.env) });
            }
            return out;
        }
        if (target.agent === 'opencode' && fs.existsSync(`${target.file}c`)) {
            throw fail('O OpenCode está usando opencode.jsonc, que tem comentários: ajuste esse arquivo à mão.', 409);
        }
        const format = FORMATS[target.agent];
        const servers = readJson(target.file)[format.key] || {};
        return Object.fromEntries(Object.entries(servers).map(([name, v]) => [name, format.toSpec(v)]));
    }

    /** Grava no destino só o que mudou. Não existe conta do Claude sem .claude.json: ainda sem login. */
    write(target, { set = {}, remove = [] }) {
        if (!Object.keys(set).length && !remove.length) return;
        this.backup(target.file);
        if (target.agent === 'codex') {
            const text = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : '';
            writeAtomic(target.file, tomlApply(text, { set, remove }));
            return;
        }
        const format = FORMATS[target.agent];
        const data = readJson(target.file); // relido agora: a ferramenta pode ter mudado o arquivo
        const servers = { ...(data[format.key] || {}) };
        for (const name of remove) delete servers[name];
        for (const [name, spec] of Object.entries(set)) servers[name] = format.from(spec);
        writeAtomic(target.file, `${JSON.stringify({ ...data, [format.key]: servers }, null, 2)}\n`);
    }

    reachable(target) {
        if (target.id.startsWith('claude:')) return fs.existsSync(target.file);
        return true;
    }

    /** Como um MCP do cadastro está num destino. */
    stateIn(name, spec, existing, managedHash) {
        const current = existing[name];
        if (current) {
            if (canonical(current) === canonical(spec)) return { state: 'ok' };
            return managedHash && managedHash === hashOf(current) ? { state: 'update' } : { state: 'conflict' };
        }
        const same = Object.keys(existing).find(other => endpointOf(existing[other]) === endpointOf(spec));
        return same ? { state: 'alias', alias: same } : { state: 'missing' };
    }

    // ---------- sincronização ----------

    /** Cadastro -> destinos, e pasta única de skills -> pastas de cada agente. */
    sync() {
        return this.serial(() => this.syncNow());
    }

    async syncNow() {
        this.lastSync = this.now();
        const state = this.load();
        const report = { changed: [], errors: [] };
        // Conta criada depois do config.toml ainda não tem o link para ele
        for (const id of this.accounts.codex?.ids() || []) this.accounts.codex.link(id);
        for (const target of this.targets()) {
            if (!this.reachable(target)) continue;
            try {
                const existing = await this.read(target);
                const mine = state.managed[target.id] || {};
                const set = {};
                const remove = [];
                for (const [name, spec] of Object.entries(state.servers)) {
                    const { state: s } = this.stateIn(name, spec, existing, mine[name]);
                    if (s === 'missing' || s === 'update') set[name] = spec;
                }
                // Tirado do cadastro: sai só se ainda for o que foi gravado aqui
                for (const name of Object.keys(mine)) {
                    if (!state.servers[name] && existing[name] && hashOf(existing[name]) === mine[name]) remove.push(name);
                    if (!state.servers[name]) delete mine[name];
                }
                this.write(target, { set, remove });
                for (const [name, spec] of Object.entries(set)) mine[name] = hashOf(spec);
                state.managed[target.id] = mine;
                if (Object.keys(set).length || remove.length) report.changed.push(target.id);
            } catch (e) {
                report.errors.push({ target: target.id, error: e.message });
            }
        }
        this.save(state);
        report.skills = this.syncSkills();
        return report;
    }

    /** Ao abrir um agente: no máximo a cada 30 s, e um erro aqui nunca impede de abrir. */
    syncSoon() {
        if (this.now() - this.lastSync < SYNC_EVERY_MS) return Promise.resolve(null);
        this.lastSync = this.now();
        return this.sync().catch(() => null);
    }

    // ---------- MCP: ações da tela ----------

    addServer(name, input) {
        if (!NAME_RE.test(String(name || ''))) throw fail('Nome inválido: use letras, números, - e _.');
        const spec = cleanSpec(input);
        return this.serial(async () => {
            const state = this.load();
            if (state.servers[name]) throw fail('Já existe um MCP com esse nome.', 409);
            state.servers[name] = spec;
            this.save(state);
            return this.syncNow();
        });
    }

    /** Leva para o cadastro um MCP que só existe numa ferramenta. O original fica como está. */
    adoptServer(name, from) {
        const target = this.targets().find(t => t.id === from);
        if (!target) throw fail('Destino inválido.');
        return this.serial(async () => {
            const spec = (await this.read(target))[name];
            if (!spec) throw fail('MCP não encontrado.', 404);
            if (spec.bearerEnv) throw fail('Este MCP guarda o token numa variável do Codex: cadastre-o a partir de outra ferramenta ou pelo formulário.');
            const state = this.load();
            if (state.servers[name]) throw fail('Já existe um MCP com esse nome.', 409);
            state.servers[name] = cleanSpec(spec);
            this.save(state);
            return this.syncNow();
        });
    }

    /** Substitui, num destino, a entrada que difere ou tem outro nome. Só por pedido na tela. */
    replaceIn(name, targetId) {
        const target = this.targets().find(t => t.id === targetId);
        if (!target) throw fail('Destino inválido.');
        return this.serial(async () => {
            const state = this.load();
            const spec = state.servers[name];
            if (!spec) throw fail('MCP não encontrado.', 404);
            const existing = await this.read(target);
            const { state: s, alias } = this.stateIn(name, spec, existing, state.managed[target.id]?.[name]);
            this.write(target, { set: { [name]: spec }, remove: s === 'alias' ? [alias] : [] });
            state.managed[target.id] = { ...state.managed[target.id], [name]: hashOf(spec) };
            this.save(state);
            return this.syncNow();
        });
    }

    removeServer(name) {
        return this.serial(async () => {
            const state = this.load();
            if (!state.servers[name]) throw fail('MCP não encontrado.', 404);
            delete state.servers[name];
            this.save(state);
            return this.syncNow();
        });
    }

    // ---------- skills ----------

    /** Pastas que recebem link. Codex e OpenCode leem ~/.agents/skills direto. */
    skillLinkDirs() {
        const dirs = [
            { agent: 'claude', dir: this.claudeSkills },
            { agent: 'agy', dir: path.join(this.home, '.gemini', 'config', 'skills') },
        ];
        for (const id of this.accounts.agy?.ids() || []) {
            dirs.push({ agent: 'agy', account: id, dir: path.join(this.accounts.agy.dirOf(id), '.gemini', 'config', 'skills') });
        }
        return dirs;
    }

    skillNames(dir) {
        let names = [];
        try {
            names = fs.readdirSync(dir);
        } catch {
            return [];
        }
        return names.filter(n => !n.startsWith('.') && fs.existsSync(path.join(dir, n, 'SKILL.md')));
    }

    /** O link de uma skill em cada pasta. O que já existe e não é link nosso fica como está. */
    linkSkill(name) {
        const source = path.join(this.agentsSkills, name);
        const skipped = [];
        for (const { dir } of this.skillLinkDirs()) {
            const link = path.join(dir, name);
            let found = null;
            try {
                found = fs.lstatSync(link);
            } catch { /* ainda não tem */ }
            if (found) {
                let same = false;
                try {
                    same = fs.realpathSync(link) === fs.realpathSync(source);
                } catch { /* link quebrado */ }
                if (!same) skipped.push(dir);
                continue;
            }
            fs.mkdirSync(dir, { recursive: true });
            fs.symlinkSync(source, link);
        }
        return skipped;
    }

    syncSkills() {
        const names = this.skillNames(this.agentsSkills);
        const skipped = [];
        for (const name of names) skipped.push(...this.linkSkill(name).map(dir => ({ name, dir })));
        // Link que ficou apontando para uma skill que saiu da pasta única
        for (const { dir } of this.skillLinkDirs()) {
            let entries = [];
            try {
                entries = fs.readdirSync(dir);
            } catch { /* sem pasta */ }
            for (const n of entries) {
                const link = path.join(dir, n);
                if (!fs.lstatSync(link).isSymbolicLink()) continue;
                const to = path.resolve(dir, fs.readlinkSync(link));
                if (to.startsWith(`${this.agentsSkills}${path.sep}`) && !fs.existsSync(to)) fs.unlinkSync(link);
            }
        }
        return { linked: names.length, skipped };
    }

    /** Leva uma skill para a pasta única e liga nas outras. A pasta original vira link, nada se perde. */
    spreadSkill(name) {
        if (!NAME_RE.test(String(name || ''))) throw fail('Nome inválido.');
        return this.serial(async () => {
            const dest = path.join(this.agentsSkills, name);
            if (!fs.existsSync(dest)) {
                const origin = this.skillLinkDirs().map(d => path.join(d.dir, name)).find(p => fs.existsSync(path.join(p, 'SKILL.md')));
                if (!origin) throw fail('Skill não encontrada.', 404);
                fs.mkdirSync(this.agentsSkills, { recursive: true });
                if (fs.lstatSync(origin).isSymbolicLink()) {
                    fs.symlinkSync(fs.realpathSync(origin), dest); // o projeto de onde ela vem segue mandando
                } else {
                    fs.renameSync(origin, dest);
                    fs.symlinkSync(dest, origin);
                }
            }
            return { skipped: this.linkSkill(name) };
        });
    }

    /** Instala de uma pasta do servidor. */
    installSkill(fromPath) {
        const from = path.resolve(String(fromPath || ''));
        if (!fs.existsSync(path.join(from, 'SKILL.md'))) throw fail('Essa pasta não tem SKILL.md.');
        const name = path.basename(from);
        if (!NAME_RE.test(name)) throw fail('Nome da pasta inválido para uma skill.');
        return this.serial(async () => {
            const dest = path.join(this.agentsSkills, name);
            if (fs.existsSync(dest)) throw fail('Já existe uma skill com esse nome.', 409);
            fs.mkdirSync(this.agentsSkills, { recursive: true });
            fs.cpSync(from, dest, { recursive: true });
            return { name, skipped: this.linkSkill(name) };
        });
    }

    /** Tira de todos: os links somem e a pasta vai para ~/.agents/.skills-removidas. */
    removeSkill(name) {
        if (!NAME_RE.test(String(name || ''))) throw fail('Nome inválido.');
        return this.serial(async () => {
            const dest = path.join(this.agentsSkills, name);
            if (!fs.existsSync(dest)) throw fail('Só skills da pasta única podem ser removidas por aqui.', 404);
            for (const { dir } of this.skillLinkDirs()) {
                const link = path.join(dir, name);
                try {
                    if (fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(dest)) fs.unlinkSync(link);
                } catch { /* não tinha */ }
            }
            fs.mkdirSync(this.removedSkills, { recursive: true });
            fs.renameSync(dest, path.join(this.removedSkills, `${name}-${this.now()}`));
            return { removed: name };
        });
    }

    // ---------- visão geral (sem nenhum segredo) ----------

    async overview() {
        const state = this.load();
        const targets = this.targets().filter(t => this.reachable(t));
        const read = new Map();
        const errors = [];
        for (const target of targets) {
            try {
                read.set(target.id, await this.read(target));
            } catch (e) {
                errors.push({ target: target.id, error: e.message });
            }
        }
        const warnings = [];
        const registered = Object.entries(state.servers).map(([name, spec]) => ({
            name,
            ...publicSpec(spec),
            registered: true,
            targets: Object.fromEntries(targets.filter(t => read.has(t.id)).map(t => [
                t.id, this.stateIn(name, spec, read.get(t.id), state.managed[t.id]?.[name]),
            ])),
        }));
        // Instalado direto numa ferramenta: oferecido para espalhar
        const known = new Set(Object.values(state.servers).map(endpointOf));
        const seen = new Map();
        for (const target of targets) {
            for (const [name, spec] of Object.entries(read.get(target.id) || {})) {
                if (spec.bearerEnv && !this.env[spec.bearerEnv]) {
                    warnings.push(`Codex, "${name}": o token aponta para uma variável que não existe (ou foi colado no lugar do nome dela), então a autenticação não deve funcionar.`);
                }
                const endpoint = endpointOf(spec);
                if (known.has(endpoint)) continue;
                if (!seen.has(endpoint)) {
                    seen.set(endpoint, { name, ...publicSpec(spec), registered: false, from: target.id, names: new Set(), targets: {} });
                }
                const row = seen.get(endpoint);
                row.names.add(name);
                row.targets[target.id] = { state: 'ok', ...(name === row.name ? {} : { alias: name }) };
                // Prefere como origem quem tem a credencial pronta
                if (!spec.bearerEnv && row.from.startsWith('codex')) { row.from = target.id; row.name = name; }
            }
        }
        const detected = [...seen.values()].map(({ names, ...row }) => row);

        const agents = new Set(this.skillNames(this.agentsSkills));
        const dirs = this.skillLinkDirs();
        const inDir = dirs.map(d => ({ ...d, names: new Set(this.skillNames(d.dir)) }));
        const all = new Set([...agents, ...inDir.flatMap(d => [...d.names])]);
        const skills = [...all].sort().map(name => {
            const claude = inDir.some(d => d.agent === 'claude' && d.names.has(name));
            const agy = inDir.filter(d => d.agent === 'agy').every(d => d.names.has(name));
            return { name, unified: agents.has(name), claude, codex: agents.has(name), opencode: agents.has(name) || claude, agy };
        });

        return {
            targets: targets.map(({ file, ...t }) => t),
            servers: [...registered, ...detected],
            skills,
            errors,
            warnings,
        };
    }
}

module.exports = { Integrations, cleanSpec, tomlApply, publicSpec };
