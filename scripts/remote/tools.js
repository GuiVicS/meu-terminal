/**
 * remote/tools.js
 * The tools of the Claude bridge (/mcp/remote): what claude.ai can do on this server.
 * Phase 1: commands, files (local + rclone), notes, server info, push.
 * Phase 2: background jobs, downloads, the server's browser, a terminal tab the user can watch.
 * Phase 3: temporary download links, small uploads.
 * Every text that leaves goes through exec.mask() (the app's secrets never show up in a reply);
 * commands that risk.js flags wait for the user's OK on the phone (approvals.js).
 */
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { assessCommand } = require('./risk');
const { runProcess } = require('../process-runner');
const { FileError } = require('../file-manager');
const { execFile } = require('child_process');

const LOCAL = 'local';
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_CHARS = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 600;
const DEFAULT_UPLOAD_GB = 20;     // upload_link: por arquivo (o padrão)
const MAX_UPLOAD_GB = 100;
const MAX_PREVIEW_FRAMES = 8;

/** Roda um programa e devolve stdout (rejeita com a mensagem de erro dele). */
function run(cmd, args, { timeout = 120000, maxBuffer = 16 * 1024 * 1024, encoding = 'utf8' } = {}) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer, encoding }, (error, stdout, stderr) => {
            if (error) {
                if (error.code === 'ENOENT') return reject(new Error(`${cmd} não está instalado no servidor.`));
                return reject(new Error(String(stderr || error.message).trim().split('\n').pop().slice(0, 300)));
            }
            resolve(stdout);
        });
    });
}

/** sha256 de um arquivo em fluxo (arquivos de qualquer tamanho). */
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('data', c => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

/** Metadados de mídia (ffprobe), ou null se não for mídia / sem ffprobe. */
async function probe(file) {
    try {
        const out = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 60000 });
        const j = JSON.parse(out);
        const v = (j.streams || []).find(x => x.codec_type === 'video');
        const a = (j.streams || []).find(x => x.codec_type === 'audio');
        if (!v && !a) return null;
        return {
            duration: j.format?.duration ? Number(j.format.duration) : null,
            format: j.format?.format_name || null,
            video: v ? { codec: v.codec_name, width: v.width, height: v.height, fps: v.avg_frame_rate } : null,
            audio: a ? { codec: a.codec_name, channels: a.channels, rate: a.sample_rate } : null,
        };
    } catch {
        return null;
    }
}
const CREDENTIAL_PATH_RE = /(^|\/)(\.env(\.|$)|\.ssh\/|\.aws\/|\.git-credentials|\.netrc|\.config\/rclone\/|id_rsa|id_ed25519)/;
const TOOLS_PROBE = ['node', 'npm', 'pnpm', 'bun', 'python3', 'pip', 'pip3', 'uv', 'docker', 'git', 'gh', 'rclone', 'ffmpeg',
    'chromium', 'curl', 'wget', 'jq', 'sqlite3', 'go', 'cargo', 'java', 'claude', 'codex', 'vercel', 'yt-dlp'];

const text = t => ({ content: [{ type: 'text', text: t }] });
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true });
const json = obj => JSON.stringify(obj, null, 2);
const sizeLabel = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const clamp = (n, min, max, dflt) => Math.min(Math.max(Number.isFinite(Number(n)) && n !== null && n !== '' ? Number(n) : dflt, min), max);

/** One extra flag in each executing tool's schema. */
const APPROVAL_PROP = {
    approval_id: {
        type: 'string',
        description: 'Só ao repetir uma chamada que respondeu "aguardando aprovação": o approval_id recebido, com os MESMOS argumentos.',
    },
};
const SOURCE_PROP = {
    source: { type: 'string', description: 'Opcional: remote do rclone (ex.: "gdrive" = Google Drive). Padrão: o disco do servidor. Veja list_drives em server_info.' },
};

/**
 * @param {object} deps
 * @param {import('./exec').RemoteExec} deps.exec
 * @param {import('../file-manager').FileManager} deps.files - rooted at exec.workdir
 * @param {import('./approvals').Approvals} deps.approvals
 * @param {import('./jobs').RemoteJobs} deps.jobs
 * @param {import('./shares').Shares} deps.shares
 * @param {object|null} deps.notes - NotesStore (null = notes off)
 * @param {(id: string|null) => void} [deps.notesChanged]
 * @param {object} deps.local - the local MCP tools (createMcpTools): notify, open_url, screenshot...
 * @param {boolean} deps.browserAvailable
 * @param {import('../session-manager')} deps.sessions
 * @param {{ get: (k: string) => any, set: (k: string, v: any) => void }} deps.prefs
 * @param {string} deps.publicBase - "https://host/basepath" for links
 */
function createRemoteTools(deps) {
    const { exec, files, approvals, jobs, shares, notes, notesChanged = () => {}, local, browserAvailable, sessions, prefs, publicBase } = deps;
    const clientOf = ctx => ctx?.req?.remote?.clientId || null;
    const isLocal = source => !source || source === LOCAL;

    /** Paths: local ones relative to the work folder ("~" = home); remote ones as given. */
    const where = (source, p) => (isLocal(source) ? exec.resolvePath(p) : String(p ?? '/'));

    /**
     * Asks the user when needed. Returns null to go ahead, or the reply to send instead.
     * @param {'exec'|'write'} kind
     */
    async function guard(tool, args, summary, risks, kind, ctx) {
        if (!approvals.needed(risks, kind)) return null;
        const { approval_id: approvalId, ...rest } = args;
        const r = await approvals.check({ approvalId, tool, args: rest, summary, risks, clientId: clientOf(ctx) });
        if (r.status === 'approved') return null;
        if (r.status === 'rejected') return fail('O usuário RECUSOU esta ação no celular. Não tente de novo da mesma forma; pergunte a ele como prefere seguir.');
        if (r.status === 'expired') return fail('A aprovação expirou sem resposta. Pergunte ao usuário se ele quer que você tente de novo.');
        return text([
            `Aguardando aprovação do usuário (approval_id: ${r.id}).`,
            risks.length ? `Motivo: ${risks.join('; ')}.` : 'O usuário pediu para aprovar todo comando.',
            'Foi enviado um push para o celular dele com Aprovar/Recusar (também aparece em /admin → Ponte com o Claude).',
            `Avise o usuário e chame ${tool} de novo com os MESMOS argumentos e approval_id="${r.id}" (a chamada espera até ~40 s pela resposta).`,
        ].join('\n'));
    }

    async function writeRisks(abs, source) {
        const p = isLocal(source) ? abs : '';
        return p && CREDENTIAL_PATH_RE.test(p) ? ['grava em arquivo de credenciais'] : [];
    }

    async function ensureParent(abs) {
        const dir = path.dirname(abs);
        await fsp.mkdir(dir, { recursive: true });
        if (!exec.sameUser) {
            try { await fsp.chown(dir, exec.user.uid, exec.user.gid); } catch { /* not ours to change */ }
        }
    }

    async function chownIfNeeded(abs) {
        if (!exec.sameUser) {
            try { await fsp.chown(abs, exec.user.uid, exec.user.gid); } catch { /* ignore */ }
        }
    }

    const defs = [];
    const impl = {};
    const add = (def, fn, enabled = true) => {
        if (!enabled) return;
        defs.push(def);
        impl[def.name] = fn;
    };

    // ---------------- Phase 1 ----------------

    add({
        name: 'run_command',
        description: 'Roda um comando no servidor do usuário (Linux, rede livre, programas já instalados, disco que persiste) '
            + 'com `bash -lc` e devolve a saída, o código de saída e a duração. Use para tudo que o seu ambiente não consegue: '
            + 'npm/pip/apt, git, docker, compilar, baixar, rodar scripts. Não é interativo (nada de prompts: use -y / --yes). '
            + `Tempo padrão ${DEFAULT_TIMEOUT_SEC} s, máximo ${MAX_TIMEOUT_SEC} s: para algo mais longo use start_job. `
            + 'Saída grande vem cortada (começo + fim): redirecione para um arquivo e leia com read_file. '
            + 'Prefira um script num comando só a dezenas de chamadas pequenas.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'O comando (bash). Pode ter várias linhas, &&, pipes etc.' },
                cwd: { type: 'string', description: `Pasta onde rodar. Padrão: a pasta de trabalho (${exec.workdir}). "~" = home; relativo = a partir da pasta de trabalho.` },
                timeout_seconds: { type: 'number', description: `Padrão ${DEFAULT_TIMEOUT_SEC}, máximo ${MAX_TIMEOUT_SEC}.` },
                ...APPROVAL_PROP,
            },
            required: ['command'],
        },
    }, async (args, ctx) => {
        const command = String(args.command || '');
        if (!command.trim()) throw new Error('Comando vazio.');
        const risks = await assessCommand(command);
        const blocked = await guard('run_command', args, command, risks, 'exec', ctx);
        if (blocked) return blocked;
        const timeoutMs = clamp(args.timeout_seconds, 1, MAX_TIMEOUT_SEC, DEFAULT_TIMEOUT_SEC) * 1000;
        const r = await exec.run({ command, cwd: args.cwd, timeoutMs });
        const head = [
            r.timedOut ? `TEMPO ESGOTADO após ${timeoutMs / 1000} s (processo encerrado; use start_job para tarefas longas)` : `exit_code: ${r.exitCode}`,
            `duração: ${(r.durationMs / 1000).toFixed(1)} s`,
            `cwd: ${r.cwd}`,
        ].join(' · ');
        return {
            content: [{ type: 'text', text: `${head}\n---\n${r.output || '(sem saída)'}` }],
            isError: r.timedOut || r.exitCode !== 0,
            _meta: { 'meuterminal/exitCode': r.exitCode, 'meuterminal/outputBytes': Buffer.byteLength(r.output) },
        };
    });

    add({
        name: 'read_file',
        description: 'Lê um arquivo de texto do servidor ou de um remote do rclone (Google Drive etc.). '
            + 'Devolve as linhas numeradas; para arquivos grandes, leia por partes com start_line/max_lines.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Caminho. Local: relativo à pasta de trabalho, "~" = home, ou absoluto.' },
                start_line: { type: 'number', description: 'Primeira linha (1 = início). Padrão 1.' },
                max_lines: { type: 'number', description: 'Quantas linhas (padrão 400, máximo 2000).' },
                ...SOURCE_PROP,
            },
            required: ['path'],
        },
    }, async args => {
        const source = args.source || LOCAL;
        const target = where(source, args.path);
        const r = await files.readText(source, target);
        if (r.text === null) {
            return fail(r.reason === 'big'
                ? `Arquivo grande demais para ler inteiro (${sizeLabel(r.size)}). Use run_command com head/tail/sed/grep.`
                : `Parece binário (${sizeLabel(r.size)}). Use run_command (file, xxd...) ou share_link para baixar.`);
        }
        const lines = r.text.split('\n');
        const start = clamp(args.start_line, 1, Math.max(lines.length, 1), 1);
        const count = clamp(args.max_lines, 1, 2000, 400);
        const slice = lines.slice(start - 1, start - 1 + count);
        const width = String(start + slice.length).length;
        const body = slice.map((l, i) => `${String(start + i).padStart(width)}│${l}`).join('\n');
        const end = start + slice.length - 1;
        const more = end < lines.length ? `\n[… mais ${lines.length - end} linhas: chame de novo com start_line=${end + 1}]` : '';
        return text(exec.mask(`${target} · ${sizeLabel(r.size)} · linhas ${start}-${end} de ${lines.length}\n${body}${more}`));
    });

    add({
        name: 'write_file',
        description: 'Cria ou sobrescreve um arquivo de texto no servidor (as pastas que faltarem são criadas) ou num remote do rclone. '
            + 'append=true acrescenta no fim (só no servidor). Bom para salvar o resultado de uma pesquisa, um script, um README.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Caminho. Local: relativo à pasta de trabalho, "~" = home, ou absoluto.' },
                content: { type: 'string', description: 'Conteúdo do arquivo (texto).' },
                append: { type: 'boolean', description: 'true = acrescenta em vez de sobrescrever.' },
                ...SOURCE_PROP,
                ...APPROVAL_PROP,
            },
            required: ['path', 'content'],
        },
    }, async (args, ctx) => {
        const source = args.source || LOCAL;
        const content = typeof args.content === 'string' ? args.content : '';
        if (content.length > MAX_WRITE_CHARS) throw new Error('Conteúdo grande demais (máx. 5 MB).');
        const target = where(source, args.path);
        const blocked = await guard('write_file', args, `gravar ${target}`, await writeRisks(target, source), 'write', ctx);
        if (blocked) return blocked;
        if (isLocal(source)) {
            await ensureParent(target);
            if (args.append) await fsp.appendFile(target, content, 'utf8');
            else await fsp.writeFile(target, content, 'utf8');
            await chownIfNeeded(target);
            const st = await fsp.stat(target);
            return text(`${args.append ? 'Acrescentado em' : 'Gravado'} ${target} (${sizeLabel(st.size)}).`);
        }
        if (args.append) throw new Error('append só funciona no disco do servidor.');
        const st = await files.writeText(source, target, content, { force: true });
        return text(`Gravado ${source}:${target} (${sizeLabel(st.size)}).`);
    });

    add({
        name: 'list_dir',
        description: 'Lista uma pasta do servidor ou de um remote do rclone (Google Drive etc.): nome, tipo, tamanho, data.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Pasta. Padrão: a pasta de trabalho (local) ou a raiz (remote).' },
                ...SOURCE_PROP,
            },
        },
    }, async args => {
        const source = args.source || LOCAL;
        const r = await files.list(source, where(source, args.path ?? (isLocal(source) ? '' : '/')));
        const rows = r.entries
            .sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
            .map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.name}${e.type === 'dir' ? '/' : ''}${e.type === 'dir' ? '' : `  ${sizeLabel(e.size)}`}${e.mtime ? `  ${new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ')}` : ''}`);
        return text(`${isLocal(source) ? '' : `${source}:`}${r.path} (${r.entries.length}${r.truncated ? '+' : ''} itens)\n${rows.join('\n') || '(vazia)'}`);
    });

    add({
        name: 'search_files',
        description: 'Procura arquivos e pastas pelo NOME (contém o texto, sem diferenciar maiúsculas) dentro de uma pasta, recursivamente. '
            + 'Para procurar DENTRO dos arquivos, use run_command com grep -rn.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Parte do nome.' },
                path: { type: 'string', description: 'Pasta onde procurar. Padrão: a pasta de trabalho.' },
                ...SOURCE_PROP,
            },
            required: ['query'],
        },
    }, async args => {
        const source = args.source || LOCAL;
        const r = await files.search(source, where(source, args.path ?? (isLocal(source) ? '' : '/')), args.query);
        const rows = r.results.map(e => `${e.type === 'dir' ? 'd' : 'f'}  ${e.path}${e.type === 'dir' ? '/' : `  ${sizeLabel(e.size)}`}`);
        return text(`${r.results.length}${r.truncated ? '+ (busca incompleta)' : ''} resultado(s)\n${rows.join('\n')}`);
    });

    add({
        name: 'save_note',
        description: 'Salva uma anotação (Markdown) no app de Anotações do usuário, que ele lê no celular. '
            + 'Ideal para guardar o resultado de uma pesquisa, um resumo, uma lista. Com note_id, atualiza uma nota existente '
            + '(append=true acrescenta ao fim em vez de substituir o texto).',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Título.' },
                body: { type: 'string', description: 'Texto em Markdown.' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Etiquetas (padrão: ["claude"]).' },
                note_id: { type: 'string', description: 'Opcional: id de uma nota existente para atualizar.' },
                append: { type: 'boolean', description: 'Com note_id: acrescenta o body ao fim da nota.' },
            },
            required: ['body'],
        },
    }, async args => {
        const body = String(args.body || '');
        if (args.note_id) {
            const current = notes.get(String(args.note_id));
            if (!current) throw new Error('Nota não encontrada.');
            const patch = { body: args.append ? `${current.body.replace(/\s+$/, '')}\n\n${body}` : body };
            if (args.title) patch.title = String(args.title);
            if (Array.isArray(args.tags)) patch.tags = args.tags;
            const r = notes.update(current.id, patch);
            if (!r || r.conflict) throw new Error('Não foi possível atualizar a nota.');
            notesChanged(current.id);
            return text(`Nota atualizada: "${r.note.title}" (id ${current.id}).`);
        }
        const tags = Array.isArray(args.tags) && args.tags.length ? args.tags : ['claude'];
        const note = notes.create({ title: String(args.title || '').trim() || body.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80) || 'Nota do Claude', body, tags });
        notesChanged(note.id);
        return text(`Nota salva: "${note.title}" (id ${note.id}). Aparece na aba Anotações do app.`);
    }, !!notes);

    add({
        name: 'search_notes',
        description: 'Procura nas anotações do usuário (título, texto e etiquetas). Sem query, lista as mais recentes.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Texto a procurar.' },
                tag: { type: 'string', description: 'Só notas com esta etiqueta.' },
                limit: { type: 'number', description: 'Máximo de resultados (padrão 20).' },
            },
        },
    }, async args => {
        const list = notes.list({ q: args.query, tag: args.tag }).slice(0, clamp(args.limit, 1, 100, 20));
        if (!list.length) return text('Nenhuma nota encontrada.');
        return text(list.map(n => `- ${n.title} (id ${n.id})${n.tags?.length ? ` [${n.tags.join(', ')}]` : ''} · ${new Date(n.updatedAt).toISOString().slice(0, 10)}${n.preview ? `\n  ${String(n.preview).slice(0, 160)}` : ''}`).join('\n'));
    }, !!notes);

    add({
        name: 'read_note',
        description: 'Lê uma anotação inteira pelo id (veja search_notes).',
        inputSchema: { type: 'object', properties: { note_id: { type: 'string' } }, required: ['note_id'] },
    }, async args => {
        const n = notes.get(String(args.note_id || ''));
        if (!n) throw new Error('Nota não encontrada.');
        return text(`# ${n.title}\n${n.tags?.length ? `Etiquetas: ${n.tags.join(', ')}\n` : ''}\n${n.body}`);
    }, !!notes);

    add({
        name: 'server_info',
        description: 'O que o servidor tem: sistema, CPU, memória, GPU, disco, programas instalados, remotes do rclone (Google Drive...) '
            + 'e a pasta de trabalho. Chame no começo para saber com o que pode contar.',
        inputSchema: { type: 'object', properties: {} },
    }, async () => {
        const probe = await exec.run({
            command: [
                `df -h ${JSON.stringify(exec.workdir)} | tail -1`,
                'command -v nvidia-smi >/dev/null && nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader || echo "sem GPU NVIDIA"',
                `for t in ${TOOLS_PROBE.join(' ')}; do command -v "$t" >/dev/null 2>&1 && printf '%s ' "$t"; done; echo`,
                'cat /etc/os-release 2>/dev/null | grep ^PRETTY_NAME= | cut -d= -f2 | tr -d \'"\'',
            ].join('; echo "@@"; '),
            timeoutMs: 20000,
        });
        const [disk, gpu, tools, distro] = probe.output.split('@@').map(s => s.trim());
        const drives = await files.sources().then(s => s.sources.filter(x => x.remote).map(x => `${x.id} (${x.type})`)).catch(() => []);
        return text(json({
            sistema: `${distro || os.type()} · ${os.arch()} · kernel ${os.release()}`,
            cpu: `${os.cpus().length}× ${os.cpus()[0]?.model || '?'}`,
            memoria: `${sizeLabel(os.totalmem())} total, ${sizeLabel(os.freemem())} livre`,
            gpu,
            disco_da_pasta_de_trabalho: disk,
            programas: tools,
            remotes_rclone: drives,
            pasta_de_trabalho: exec.workdir,
            usuario: exec.sameUser ? os.userInfo().username : exec.user.name,
            navegador: browserAvailable ? 'Chromium disponível (open_url/screenshot/read_page)' : 'indisponível',
            anotacoes: notes ? 'ligadas (save_note)' : 'desligadas',
        }));
    });

    add({
        name: 'notify',
        description: 'Manda um aviso para o usuário: push com som no celular (funciona com o app fechado) e na tela do app. '
            + 'Use quando algo demorado terminar ou precisar da atenção dele.',
        inputSchema: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'Texto curto.' },
                title: { type: 'string', description: 'Título (padrão: "Claude").' },
            },
            required: ['message'],
        },
    }, args => local.notify({ message: args.message, title: args.title || 'Claude' }));

    // ---------------- Phase 2 ----------------

    add({
        name: 'start_job',
        description: 'Começa um comando demorado em segundo plano (instalações, builds, downloads de modelos, treinos) e devolve '
            + 'na hora um job_id. Acompanhe com job_status e job_output. notify=true manda push ao usuário quando terminar.',
        inputSchema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'O comando (bash -lc).' },
                cwd: { type: 'string', description: 'Pasta. Padrão: a pasta de trabalho.' },
                name: { type: 'string', description: 'Nome curto para reconhecer o job.' },
                notify: { type: 'boolean', description: 'Push no celular quando terminar.' },
                timeout_minutes: { type: 'number', description: 'Encerra depois disso (padrão 360, máximo 1440).' },
                ...APPROVAL_PROP,
            },
            required: ['command'],
        },
    }, async (args, ctx) => {
        const command = String(args.command || '');
        const risks = await assessCommand(command);
        const blocked = await guard('start_job', args, command, risks, 'exec', ctx);
        if (blocked) return blocked;
        const job = jobs.start({ command, cwd: args.cwd, name: args.name, notify: !!args.notify, timeoutMinutes: args.timeout_minutes, clientId: clientOf(ctx) });
        return text(`Job iniciado: job_id=${job.id} (pid ${job.pid}, pasta ${job.cwd}). Use job_status / job_output.`);
    });

    const jobLine = j => `${j.id}  ${j.status}${j.exitCode != null ? ` (exit ${j.exitCode})` : ''}  ${(j.durationMs / 1000).toFixed(0)} s  ${sizeLabel(j.outputBytes)}  ${j.name ? `[${j.name}] ` : ''}${j.command.slice(0, 100)}`;

    add({
        name: 'job_status',
        description: 'Situação de um job (running, ok, failed, timeout, killed, interrupted) ou, sem job_id, dos jobs recentes.',
        inputSchema: { type: 'object', properties: { job_id: { type: 'string' } } },
    }, async args => {
        if (args.job_id) {
            const j = jobs.get(args.job_id);
            if (!j) throw new Error('Job não encontrado.');
            return text(json({ ...j, command: exec.mask(j.command) }));
        }
        const list = jobs.list({ limit: 20 });
        return text(list.length ? exec.mask(list.map(jobLine).join('\n')) : 'Nenhum job ainda.');
    });

    add({
        name: 'job_output',
        description: 'Lê a saída de um job. Sem offset: o final (o que está acontecendo agora). Com offset: a partir desse byte '
            + '(use next_offset da leitura anterior para seguir lendo).',
        inputSchema: {
            type: 'object',
            properties: {
                job_id: { type: 'string' },
                offset: { type: 'number', description: 'Byte inicial (opcional).' },
                limit: { type: 'number', description: 'Bytes (padrão e máximo 49152).' },
            },
            required: ['job_id'],
        },
    }, async args => {
        const j = jobs.get(args.job_id);
        if (!j) throw new Error('Job não encontrado.');
        const out = jobs.output(j.id, { offset: args.offset, limit: args.limit });
        return text(`job ${j.id} · ${j.status}${j.exitCode != null ? ` (exit ${j.exitCode})` : ''} · bytes ${out.offset}-${out.nextOffset} de ${out.size} (next_offset=${out.nextOffset})\n---\n${out.text || '(sem saída ainda)'}`);
    });

    add({
        name: 'job_kill',
        description: 'Encerra um job (e tudo que ele abriu).',
        inputSchema: { type: 'object', properties: { job_id: { type: 'string' } }, required: ['job_id'] },
    }, async args => {
        const j = jobs.kill(args.job_id);
        return text(`Job ${j.id}: ${j.status}.`);
    });

    add({
        name: 'fetch_url',
        description: 'O servidor baixa um arquivo da internet direto para uma pasta dele (sem passar pela conversa). '
            + 'Devolve o caminho, o tamanho e o tipo. Para downloads enormes, prefira start_job com curl/wget.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'http(s)://...' },
                dest: { type: 'string', description: 'Pasta ou caminho do arquivo. Padrão: <pasta de trabalho>/downloads/ com o nome do servidor remoto.' },
                timeout_seconds: { type: 'number', description: 'Padrão 300, máximo 600.' },
            },
            required: ['url'],
        },
    }, async args => {
        let url;
        try { url = new URL(String(args.url || '')); } catch { throw new Error('URL inválida.'); }
        if (!/^https?:$/.test(url.protocol)) throw new Error('Só http e https.');
        const raw = args.dest ? exec.resolvePath(args.dest) : path.join(exec.workdir, 'downloads');
        const isDir = !args.dest || /[\\/]$/.test(String(args.dest)) || (fs.existsSync(raw) && fs.statSync(raw).isDirectory());
        const dir = isDir ? raw : path.dirname(raw);
        await fsp.mkdir(dir, { recursive: true });
        const curlArgs = ['-fsSL', '--max-time', String(clamp(args.timeout_seconds, 5, MAX_TIMEOUT_SEC, 300)),
            '-w', '%{http_code}\t%{content_type}\t%{size_download}\t%{filename_effective}',
            ...(isDir ? ['-O', '-J'] : ['-o', raw]), '--', url.toString()];
        const r = await runProcess({ command: 'curl', args: curlArgs, cwd: dir, env: exec.env(), timeoutMs: MAX_TIMEOUT_SEC * 1000 + 5000, secrets: exec.secrets, ...exec.spawnOptions() });
        if (r.exitCode !== 0) return fail(`Download falhou (curl ${r.exitCode}${r.timedOut ? ', tempo esgotado' : ''}): ${r.output.trim().slice(-500)}`);
        const [code, type, size, file] = r.output.trim().split('\t');
        const finalPath = path.resolve(dir, file || '');
        return text(json({ caminho: finalPath, http: Number(code), tipo: type || null, tamanho: sizeLabel(Number(size)) }));
    });

    if (browserAvailable) {
        add({
            name: 'open_url',
            description: 'Abre uma página no navegador (Chromium) do servidor, numa aba que o usuário também vê no app. '
                + 'Funciona com "localhost:3000" de projetos rodando no servidor. Devolve o tab_id para screenshot/read_page.',
            inputSchema: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'Endereço. "localhost:5173" ou "5173" também valem.' },
                    name: { type: 'string', description: 'Nome da aba (opcional).' },
                },
                required: ['url'],
            },
        }, args => local.open_url({ url: args.url, name: args.name || 'Claude', background: true }));
        add({
            name: 'screenshot',
            description: 'Captura a tela de uma aba do navegador do servidor e devolve a IMAGEM (para você ver como ficou).',
            inputSchema: {
                type: 'object',
                properties: {
                    tab_id: { type: 'string', description: 'Aba (padrão: a última aberta).' },
                    full_page: { type: 'boolean', description: 'true = página inteira (rolagem).' },
                },
            },
        }, args => local.screenshot(args));
        add({
            name: 'read_page',
            description: 'Texto de uma aba do navegador do servidor (título, endereço e conteúdo visível).',
            inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } } },
        }, async args => {
            const r = await local.read_page(args);
            return { ...r, content: r.content.map(c => (c.type === 'text' ? { ...c, text: exec.mask(c.text) } : c)) };
        });
        add({
            name: 'navigate',
            description: 'Muda o endereço de uma aba do navegador do servidor e espera carregar.',
            inputSchema: { type: 'object', properties: { url: { type: 'string' }, tab_id: { type: 'string' } }, required: ['url'] },
        }, args => local.navigate(args));
        add({
            name: 'close_tab',
            description: 'Fecha uma aba (do navegador ou de terminal) aberta por você.',
            inputSchema: { type: 'object', properties: { tab_id: { type: 'string' } }, required: ['tab_id'] },
        }, args => local.close_tab(args));
    }

    // Terminal the user can watch live: only when commands run as the server's own user
    // (the tabs' shells are the app's, not the dedicated user's)
    const bridgeTabs = () => new Set(prefs.get('remote_terminal_tabs') || []);
    const rememberTab = id => prefs.set('remote_terminal_tabs', [...bridgeTabs(), id].slice(-50));
    const ownTab = id => {
        if (!bridgeTabs().has(String(id || ''))) throw new Error('Esta aba não foi aberta por você (use terminal_open).');
        return String(id);
    };
    const screen = (id, lines) => {
        const s = sessions.readScreen(id, lines);
        return s ? exec.mask(s.text) : '(aba sem terminal ativo)';
    };

    add({
        name: 'terminal_open',
        description: 'Abre uma aba de terminal "Claude" no app do usuário: ele assiste ao vivo o que você digita ali. '
            + 'Use quando ele quiser acompanhar, ou para programas interativos/servidores de desenvolvimento. '
            + 'Depois: terminal_send para digitar, terminal_read para ver a tela.',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Nome da aba (padrão "Claude").' },
                cwd: { type: 'string', description: 'Pasta inicial. Padrão: a pasta de trabalho.' },
            },
        },
    }, async args => {
        const cwd = exec.resolvePath(args.cwd);
        const tab = sessions.create({ name: String(args.name || 'Claude').slice(0, 40), cwd, color: 'orange' });
        sessions.ensureRuntime(tab.id);
        rememberTab(tab.id);
        // Give the shell (and the user's prompt setup) a moment so the first terminal_send isn't typed into nothing
        await new Promise(r => setTimeout(r, 1500));
        return text(`Terminal aberto: tab_id=${tab.id} (${cwd}).\n${screen(tab.id, 10)}`);
    }, exec.sameUser);

    add({
        name: 'terminal_send',
        description: 'Digita no terminal aberto com terminal_open (Enter no fim, a não ser que enter=false) e devolve a tela '
            + 'depois de wait_ms. Para Ctrl+C mande text="\\u0003" e enter=false.',
        inputSchema: {
            type: 'object',
            properties: {
                tab_id: { type: 'string' },
                text: { type: 'string', description: 'O que digitar.' },
                enter: { type: 'boolean', description: 'Padrão true.' },
                wait_ms: { type: 'number', description: 'Espera antes de ler a tela (padrão 1500, máximo 15000).' },
                ...APPROVAL_PROP,
            },
            required: ['tab_id', 'text'],
        },
    }, async (args, ctx) => {
        const id = ownTab(args.tab_id);
        const input = String(args.text ?? '');
        const risks = await assessCommand(input);
        const blocked = await guard('terminal_send', args, input, risks, 'exec', ctx);
        if (blocked) return blocked;
        if (!sessions.runCommand(id, input + (args.enter === false ? '' : '\r'))) throw new Error('A aba foi fechada.');
        await new Promise(r => setTimeout(r, clamp(args.wait_ms, 0, 15000, 1500)));
        return text(screen(id, 60));
    }, exec.sameUser);

    add({
        name: 'terminal_read',
        description: 'Lê a tela do terminal aberto com terminal_open (últimas linhas, texto puro).',
        inputSchema: {
            type: 'object',
            properties: { tab_id: { type: 'string' }, lines: { type: 'number', description: 'Padrão 60, máximo 2000.' } },
            required: ['tab_id'],
        },
    }, async args => text(screen(ownTab(args.tab_id), args.lines)), exec.sameUser);

    // ---------------- Phase 3 ----------------

    add({
        name: 'share_link',
        description: 'Gera um link temporário para BAIXAR um arquivo do servidor (ou do Google Drive/rclone). '
            + 'Entregue o link ao usuário; expira em `minutes` (padrão 30). Use para entregar resultados grandes (zip, vídeo, PDF).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                minutes: { type: 'number', description: 'Validade (padrão 30, máximo 1440).' },
                ...SOURCE_PROP,
            },
            required: ['path'],
        },
    }, async args => {
        const source = args.source || LOCAL;
        const target = where(source, args.path);
        const info = await files.stat(source, target);
        if (info.type === 'dir') throw new Error('É uma pasta: compacte antes (run_command com zip/tar) e compartilhe o arquivo.');
        const link = shares.create({ source, path: target, minutes: args.minutes });
        return text(`${publicBase}/dl/${link.token}\n(${path.basename(target)}, ${sizeLabel(info.size)}; expira ${new Date(link.expiresAt).toISOString()})`);
    });

    add({
        name: 'upload_base64',
        description: `Envia um arquivo PEQUENO (até ${MAX_UPLOAD_BYTES / 1048576} MB) do seu ambiente para o servidor, em base64. `
            + 'Para coisas maiores, faça o servidor gerar/baixar direto (run_command, fetch_url).',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Destino no servidor (arquivo).' },
                data_base64: { type: 'string' },
                overwrite: { type: 'boolean', description: 'true = substitui se já existir.' },
                ...APPROVAL_PROP,
            },
            required: ['path', 'data_base64'],
        },
    }, async (args, ctx) => {
        const target = exec.resolvePath(args.path);
        const b64 = String(args.data_base64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
        if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new Error('data_base64 inválido.');
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > MAX_UPLOAD_BYTES) throw new Error(`Grande demais (${sizeLabel(buf.length)}; máximo ${sizeLabel(MAX_UPLOAD_BYTES)}).`);
        const digest = crypto.createHash('sha256').update(buf).digest('hex');
        const blocked = await guard('upload_base64', { path: args.path, overwrite: !!args.overwrite, sha256: digest, approval_id: args.approval_id },
            `enviar ${target}`, await writeRisks(target, LOCAL), 'write', ctx);
        if (blocked) return blocked;
        if (!args.overwrite && fs.existsSync(target)) throw new Error('O arquivo já existe (use overwrite=true).');
        await ensureParent(target);
        await fsp.writeFile(target, buf);
        await chownIfNeeded(target);
        return text(`Gravado ${target} (${sizeLabel(buf.length)}).`);
    });

    // ---------------- Troca de arquivos ----------------
    // Pastas fixas de troca: o que chega (upload_link, Drive, fetch_url) e o que sai (share_link).
    const TROCA = { entrada: path.join(exec.workdir, 'troca', 'entrada'), saida: path.join(exec.workdir, 'troca', 'saida') };
    for (const dir of Object.values(TROCA)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* sem permissão: as ferramentas avisam */ }
    }

    add({
        name: 'upload_link',
        description: 'Gera um link temporário com uma página para o USUÁRIO enviar arquivos de qualquer tamanho (vídeos, PDFs, zips) '
            + 'direto para uma pasta do servidor, sem passar pela conversa. Padrão: troca/entrada. '
            + 'Entregue o link ao usuário; depois confira o que chegou com upload_received (tamanho e sha256).',
        inputSchema: {
            type: 'object',
            properties: {
                dir: { type: 'string', description: 'Pasta de destino (padrão: troca/entrada).' },
                minutes: { type: 'number', description: 'Validade (padrão 60, máximo 1440).' },
                max_gb: { type: 'number', description: `Tamanho máximo por arquivo em GB (padrão ${DEFAULT_UPLOAD_GB}, máximo ${MAX_UPLOAD_GB}).` },
                ...APPROVAL_PROP,
            },
        },
    }, async (args, ctx) => {
        const dir = args.dir ? exec.resolvePath(args.dir) : TROCA.entrada;
        const gb = Math.min(Math.max(Number(args.max_gb) || DEFAULT_UPLOAD_GB, 0.01), MAX_UPLOAD_GB);
        const blocked = await guard('upload_link', { dir: args.dir || '', max_gb: gb, approval_id: args.approval_id },
            `receber arquivos em ${dir}`, await writeRisks(dir, LOCAL), 'write', ctx);
        if (blocked) return blocked;
        await fsp.mkdir(dir, { recursive: true });
        const link = shares.createUpload({ dir, minutes: args.minutes, maxBytes: Math.round(gb * 1073741824) });
        return text([
            `${publicBase}/up/${link.token}`,
            `(destino ${dir}; até ${gb} GB por arquivo; expira ${new Date(link.expiresAt).toISOString()})`,
            `Para conferir: upload_received com token="${link.token}".`,
        ].join('\n'));
    });

    add({
        name: 'upload_received',
        description: 'Lista o que o usuário já enviou por um upload_link: nome, caminho, tamanho e sha256 de cada arquivo.',
        inputSchema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] },
    }, async args => {
        const link = shares.get(String(args.token || ''));
        if (!link || link.kind !== 'upload') return fail('Link inválido ou expirado (os links somem quando o servidor reinicia).');
        if (!link.received.length) return text(`Nada recebido ainda. O link expira ${new Date(link.expiresAt).toISOString()}.`);
        return text(link.received.map(f => `${f.path}\t${sizeLabel(f.size)} (${f.size} bytes)\tsha256 ${f.sha256}\t${f.at}`).join('\n'));
    });

    add({
        name: 'file_info',
        description: 'Confere um arquivo do servidor sem trazê-lo para a conversa: tamanho exato, sha256, tipo e, para vídeo/áudio, '
            + 'duração, formato e resolução (ffprobe). Use para verificar toda transferência (comparar com a origem).',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }, async args => {
        const target = exec.resolvePath(args.path);
        const st = await fsp.stat(target).catch(() => null);
        if (!st) return fail(`Não existe: ${target}`);
        if (st.isDirectory()) return fail('É uma pasta. Para várias: run_command com "sha256sum pasta/*".');
        const [sha256, mime, media] = await Promise.all([
            sha256File(target),
            run('file', ['--mime-type', '-b', target]).then(s => s.trim()).catch(() => null),
            probe(target),
        ]);
        const lines = [`${target}`, `tamanho: ${sizeLabel(st.size)} (${st.size} bytes)`, `sha256: ${sha256}`];
        if (mime) lines.push(`tipo: ${mime}`);
        if (media) {
            if (media.duration != null) lines.push(`duração: ${media.duration.toFixed(2)} s`);
            if (media.format) lines.push(`formato: ${media.format}`);
            if (media.video) lines.push(`vídeo: ${media.video.codec} ${media.video.width}x${media.video.height} @ ${media.video.fps}`);
            if (media.audio) lines.push(`áudio: ${media.audio.codec}, ${media.audio.channels} canais, ${media.audio.rate} Hz`);
        }
        lines.push(`modificado: ${st.mtime.toISOString()}`);
        return text(lines.join('\n'));
    });

    add({
        name: 'media_preview',
        description: 'Mostra o conteúdo de um vídeo ou imagem grande sem trazer o arquivo: devolve alguns quadros do vídeo '
            + `(espalhados pela duração, até ${MAX_PREVIEW_FRAMES}) ou a imagem reduzida, como imagens que você vê direto. Precisa do ffmpeg no servidor.`,
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                frames: { type: 'number', description: `Quantos quadros (padrão 4, máximo ${MAX_PREVIEW_FRAMES}).` },
                width: { type: 'number', description: 'Largura de cada imagem em px (padrão 640, máximo 1280).' },
                start_seconds: { type: 'number', description: 'Só um trecho: início (padrão 0).' },
                end_seconds: { type: 'number', description: 'Só um trecho: fim (padrão a duração toda).' },
            },
            required: ['path'],
        },
    }, async args => {
        const target = exec.resolvePath(args.path);
        if (!fs.existsSync(target)) return fail(`Não existe: ${target}`);
        const width = Math.min(Math.max(Number(args.width) || 640, 64), 1280);
        const media = await probe(target);
        const isVideo = !!(media?.video && media.duration && media.duration > 0.5);
        const n = isVideo ? Math.min(Math.max(Number(args.frames) || 4, 1), MAX_PREVIEW_FRAMES) : 1;
        const from = isVideo ? Math.max(0, Number(args.start_seconds) || 0) : 0;
        const to = isVideo ? Math.min(media.duration, Number(args.end_seconds) || media.duration) : 0;
        const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mt-preview-'));
        try {
            const content = [];
            for (let i = 0; i < n; i++) {
                const t = isVideo ? from + (to - from) * (i + 0.5) / n : 0;
                const out = path.join(tmp, `q${i}.jpg`);
                await run('ffmpeg', ['-v', 'error', ...(isVideo ? ['-ss', t.toFixed(2)] : []), '-i', target, '-frames:v', '1',
                    '-vf', `scale='min(${width},iw)':-2`, '-q:v', '5', '-y', out], { timeout: 120000 });
                content.push({ type: 'text', text: isVideo ? `Quadro ${i + 1}/${n} em ${t.toFixed(1)} s` : 'Imagem reduzida' });
                content.push({ type: 'image', data: (await fsp.readFile(out)).toString('base64'), mimeType: 'image/jpeg' });
            }
            if (media) content.unshift({ type: 'text', text: `${path.basename(target)}${media.duration ? ` · ${media.duration.toFixed(1)} s` : ''}${media.video ? ` · ${media.video.width}x${media.video.height}` : ''}` });
            return { content };
        } finally {
            await fsp.rm(tmp, { recursive: true, force: true });
        }
    });

    return { tools: defs, impl };
}

/** Text for the audit row: did the tool fail, and what came out. */
function auditOutcome(result, error) {
    if (error) return { ok: false, note: error instanceof FileError || error instanceof Error ? error.message : String(error) };
    const bytes = (result?.content || []).reduce((n, c) => n + (c.type === 'text' ? Buffer.byteLength(c.text) : (c.data?.length || 0)), 0);
    const meta = result?._meta || {};
    const first = result?.content?.[0]?.type === 'text' ? result.content[0].text : '';
    return {
        ok: !result?.isError,
        exitCode: meta['meuterminal/exitCode'],
        outputBytes: meta['meuterminal/outputBytes'] ?? bytes,
        note: /^Aguardando aprovação/.test(first) ? 'aguardando aprovação' : result?.isError ? first.slice(0, 200) : undefined,
    };
}

module.exports = { createRemoteTools, auditOutcome, CREDENTIAL_PATH_RE };
