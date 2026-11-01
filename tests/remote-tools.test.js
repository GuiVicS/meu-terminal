const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { RemoteExec } = require('../scripts/remote/exec');
const { RemoteJobs } = require('../scripts/remote/jobs');
const { Approvals } = require('../scripts/remote/approvals');
const { Shares } = require('../scripts/remote/shares');
const { RemoteAudit } = require('../scripts/remote/audit');
const { createRemoteTools, auditOutcome } = require('../scripts/remote/tools');
const { FileManager } = require('../scripts/file-manager');
const NotesStore = require('../scripts/notes-store');
const { createJsonRpcHandler } = require('../scripts/mcp-protocol');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-remote-'));
process.env.AUTH_PASSWORD = 'senha-super-secreta-123';
const exec = new RemoteExec({ workdir: path.join(tmp, 'work') });
delete process.env.AUTH_PASSWORD;

let mode = 'dangerous';
const approvals = new Approvals({ getMode: () => mode });
const db = new DatabaseSync(':memory:');
const finished = [];
const jobs = new RemoteJobs({ db, dir: path.join(tmp, 'jobs'), exec, onFinish: j => finished.push(j) });
const notes = new NotesStore(path.join(tmp, 'notes'));
const notesChangedIds = [];
const shares = new Shares();
const prefs = new Map();
const { tools, impl } = createRemoteTools({
    exec, files: new FileManager({ home: exec.workdir }), approvals, jobs, shares, notes,
    notesChanged: id => notesChangedIds.push(id),
    local: { notify: async a => ({ content: [{ type: 'text', text: `notificado: ${a.message}` }] }) },
    browserAvailable: false, sessions: {}, prefs: { get: k => prefs.get(k), set: (k, v) => prefs.set(k, v) },
    publicBase: 'https://t.exemplo.com',
});
const ctx = { req: { remote: { clientId: 'c1' } } };
const call = (name, args = {}) => impl[name](args, ctx);
const out = r => r.content.map(c => c.text).join('\n');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('tool list: every tool has a schema; terminal tools only when running as the server user', () => {
    for (const t of tools) {
        assert.equal(t.inputSchema.type, 'object', t.name);
        assert.ok(t.description.length > 20, t.name);
    }
    const names = tools.map(t => t.name);
    for (const n of ['run_command', 'read_file', 'write_file', 'list_dir', 'search_files', 'save_note', 'search_notes', 'read_note',
        'server_info', 'notify', 'start_job', 'job_status', 'job_output', 'job_kill', 'fetch_url', 'terminal_open', 'share_link', 'upload_base64']) {
        assert.ok(names.includes(n), n);
    }
    assert.ok(!names.includes('screenshot'), 'no browser tools without Chromium');
});

test('run_command: output, exit code, default cwd = work folder', async () => {
    const r = await call('run_command', { command: 'pwd; echo oi; exit 3' });
    assert.equal(r.isError, true);
    assert.match(out(r), /exit_code: 3/);
    assert.match(out(r), new RegExp(exec.workdir));
    assert.equal(r._meta['meuterminal/exitCode'], 3);
    const ok = await call('run_command', { command: 'echo pronto' });
    assert.equal(ok.isError, false);
});

test('run_command: app secrets are neither in the environment nor in the output', async () => {
    process.env.AUTH_PASSWORD = 'senha-super-secreta-123';
    const r = await call('run_command', { command: 'env | grep -c AUTH_PASSWORD; echo "x=senha-super-secreta-123"' });
    delete process.env.AUTH_PASSWORD;
    assert.match(out(r), /^0$/m, 'not inherited');
    assert.doesNotMatch(out(r), /senha-super-secreta-123/, 'masked even when printed');
});

test('run_command: timeout', async () => {
    const r = await call('run_command', { command: 'sleep 5', timeout_seconds: 1 });
    assert.match(out(r), /TEMPO ESGOTADO/);
});

test('run_command: long output keeps the start and the end', async () => {
    const r = await call('run_command', { command: 'echo INICIO; head -c 200000 /dev/zero | tr "\\0" a; echo; echo FIM' });
    assert.match(out(r), /INICIO/);
    assert.match(out(r), /FIM/);
    assert.match(out(r), /omitidos/);
});

test('run_command: dangerous command waits for approval, then runs once approved', async () => {
    const marker = path.join(exec.workdir, 'apagar');
    fs.mkdirSync(marker);
    const args = { command: `rm -rf ${marker}` };
    const origCheck = approvals.check.bind(approvals);
    approvals.check = o => origCheck({ ...o, waitMs: 0 });
    try {
        const first = await call('run_command', args);
        assert.match(out(first), /Aguardando aprovação/);
        assert.ok(fs.existsSync(marker), 'nothing ran yet');
        const id = /approval_id: (\S+)\)/.exec(out(first))[1];
        approvals.decide(id, true);
        const second = await call('run_command', { ...args, approval_id: id });
        assert.match(out(second), /exit_code: 0/);
        assert.ok(!fs.existsSync(marker));
        mode = 'never';
        fs.mkdirSync(marker);
        assert.match(out(await call('run_command', args)), /exit_code: 0/);
    } finally {
        approvals.check = origCheck;
        mode = 'dangerous';
    }
});

test('files: write (creating folders), append, read with line numbers, list, search', async () => {
    await call('write_file', { path: 'pesquisa/resultado.md', content: 'linha 1\nlinha 2\n' });
    await call('write_file', { path: 'pesquisa/resultado.md', content: 'linha 3\n', append: true });
    const r = await call('read_file', { path: 'pesquisa/resultado.md', start_line: 2, max_lines: 2 });
    assert.match(out(r), /2│linha 2\n3│linha 3/);
    assert.match(out(await call('list_dir', { path: 'pesquisa' })), /resultado\.md/);
    assert.match(out(await call('search_files', { query: 'RESULT' })), /resultado\.md/);
    assert.equal(fs.readFileSync(path.join(exec.workdir, 'pesquisa/resultado.md'), 'utf8'), 'linha 1\nlinha 2\nlinha 3\n');
});

test('write_file to a credentials path needs approval', async () => {
    const origCheck = approvals.check.bind(approvals);
    approvals.check = o => origCheck({ ...o, waitMs: 0 });
    try {
        const r = await call('write_file', { path: 'proj/.env', content: 'A=1' });
        assert.match(out(r), /Aguardando aprovação/);
        assert.ok(!fs.existsSync(path.join(exec.workdir, 'proj/.env')));
    } finally {
        approvals.check = origCheck;
    }
});

test('notes: save, append, search, read', async () => {
    const saved = out(await call('save_note', { title: 'Pesquisa GPUs', body: '# GPUs\n- RTX' }));
    const id = /id ([0-9a-f-]+)\)/.exec(saved)[1];
    assert.deepEqual(notes.get(id).tags, ['claude']);
    await call('save_note', { note_id: id, body: '- A100', append: true });
    assert.match(notes.get(id).body, /RTX\s+- A100/);
    assert.match(out(await call('search_notes', { query: 'gpus' })), new RegExp(id));
    assert.match(out(await call('read_note', { note_id: id })), /# Pesquisa GPUs/);
    assert.deepEqual(notesChangedIds, [id, id]);
});

test('jobs: start, status, output with offsets, notify on finish, kill', async () => {
    const started = out(await call('start_job', { command: 'echo um; sleep 0.2; echo dois', name: 'teste', notify: true }));
    const id = /job_id=(\w+)/.exec(started)[1];
    for (let i = 0; i < 50 && jobs.get(id).status === 'running'; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(jobs.get(id).status, 'ok');
    assert.equal(finished.at(-1).id, id);
    assert.match(out(await call('job_output', { job_id: id })), /um\ndois/);
    const part = jobs.output(id, { offset: 0, limit: 3 });
    assert.equal(part.text, 'um\n');
    assert.equal(part.nextOffset, 3);

    const long = /job_id=(\w+)/.exec(out(await call('start_job', { command: 'sleep 30' })))[1];
    await call('job_kill', { job_id: long });
    for (let i = 0; i < 50 && jobs.get(long).finishedAt == null; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(jobs.get(long).status, 'killed');
    assert.match(out(await call('job_status', {})), new RegExp(long));
});

test('upload_base64 + share_link', async () => {
    const data = Buffer.from('conteúdo binário?').toString('base64');
    assert.match(out(await call('upload_base64', { path: 'up/a.bin', data_base64: data })), /Gravado/);
    await assert.rejects(call('upload_base64', { path: 'up/a.bin', data_base64: data }), /já existe/);
    const link = out(await call('share_link', { path: 'up/a.bin', minutes: 5 }));
    const token = /\/dl\/([\w-]+)/.exec(link)[1];
    assert.equal(shares.get(token).path, path.join(exec.workdir, 'up/a.bin'));
    await assert.rejects(call('share_link', { path: 'up' }), /pasta/);
    await assert.rejects(call('upload_base64', { path: 'x', data_base64: Buffer.alloc(3 * 1024 * 1024).toString('base64') }), /Grande demais/);
});

test('fetch_url refuses non-http schemes', async () => {
    await assert.rejects(call('fetch_url', { url: 'file:///etc/passwd' }), /http/);
});

test('through the protocol: audit row with exit code, approval note and masked args', async () => {
    const audit = new RemoteAudit({ db, mask: s => s.replace('segredo', '••••') });
    const handler = createJsonRpcHandler({
        tools, impl, serverInfo: { name: 't', version: '1' },
        onCall: (tool, args, o, c) => { const a = auditOutcome(o.result, o.error); audit.record({ clientId: c.req.remote.clientId, tool, args, ...a, durationMs: o.ms }); },
    });
    let body;
    const res = { status() { return this; }, json(b) { body = b; return this; }, end() { return this; } };
    await handler({ body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'run_command', arguments: { command: 'echo segredo; exit 2' } } }, remote: { clientId: 'c1' } }, res);
    assert.equal(body.result.isError, true);
    const row = audit.list({ limit: 1 })[0];
    assert.equal(row.tool, 'run_command');
    assert.equal(row.exitCode, 2);
    assert.equal(row.clientId, 'c1');
    assert.match(row.args, /••••/);
});

// ---------- troca de arquivos ----------

test('troca: as pastas troca/entrada e troca/saida existem na pasta de trabalho', () => {
    assert.ok(fs.statSync(path.join(exec.workdir, 'troca', 'entrada')).isDirectory());
    assert.ok(fs.statSync(path.join(exec.workdir, 'troca', 'saida')).isDirectory());
});

test('upload_link: gera /up/<token> para troca/entrada; upload_received lista o que chegou', async () => {
    const r = out(await call('upload_link', { minutes: 5, max_gb: 1 }));
    const token = r.match(/\/up\/([\w-]+)/)[1];
    assert.match(r, /troca\/entrada/);
    const link = shares.get(token);
    assert.equal(link.kind, 'upload');
    assert.equal(link.maxBytes, 1073741824);
    assert.match(out(await call('upload_received', { token })), /Nada recebido ainda/);
    link.received.push({ name: 'a.mp4', path: '/x/a.mp4', size: 10, sha256: 'ab'.repeat(32), at: 'agora' });
    assert.match(out(await call('upload_received', { token })), /a\.mp4.*10 bytes.*sha256 abab/);
    // um link de envio não serve como link de download
    assert.equal((await call('upload_received', { token: 'nao-existe' })).isError, true);
});

test('file_info: tamanho exato e sha256 sem trazer o arquivo', async () => {
    const f = path.join(exec.workdir, 'troca', 'saida', 'oi.txt');
    fs.writeFileSync(f, 'oi\n');
    const r = out(await call('file_info', { path: f }));
    assert.match(r, /3 bytes/);
    const expected = require('crypto').createHash('sha256').update('oi\n').digest('hex');
    assert.ok(r.includes(`sha256: ${expected}`), r);
    assert.equal((await call('file_info', { path: path.join(exec.workdir, 'nao-existe') })).isError, true);
});

test('tool list: as ferramentas de troca de arquivos estão lá', () => {
    const names = tools.map(t => t.name);
    for (const n of ['upload_link', 'upload_received', 'file_info', 'media_preview']) assert.ok(names.includes(n), n);
});
