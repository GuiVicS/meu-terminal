/**
 * routes/remote.js
 * The Claude bridge (docs/PLANO-MCP-REMOTO.md): an MCP endpoint for claude.ai at /mcp/remote,
 * separate from the local /mcp, plus the OAuth server claude.ai's custom connectors require,
 * temporary download links and the /admin API ("Ponte com o Claude").
 *
 * Off unless REMOTE_MCP_ENABLED=true, and only with email + password login (the consent page asks
 * for them, and for the 2FA code when it's on). With it off, only GET /api/remote is mounted, so
 * the admin page can explain how to turn it on.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createJsonRpcHandler } = require('../scripts/mcp-protocol');
const { FileManager } = require('../scripts/file-manager');
const { AttemptLimiter } = require('../scripts/auth');
const { RemoteOAuth, OAuthError } = require('../scripts/remote/oauth');
const { RemoteAudit } = require('../scripts/remote/audit');
const { Approvals, MODES } = require('../scripts/remote/approvals');
const { RemoteExec } = require('../scripts/remote/exec');
const { RemoteJobs } = require('../scripts/remote/jobs');
const { Shares } = require('../scripts/remote/shares');
const { createRemoteTools, auditOutcome } = require('../scripts/remote/tools');

/** Paths (relative to BASE_PATH) that skip the app login while the bridge is on: each has its own check. */
const REMOTE_PUBLIC_PATHS = [
    '/.well-known/',
    '/oauth/authorize',
    '/oauth/authorize/approve', // POST from the consent page: checks email + password (+2FA) itself
    '/oauth-authorize.js',
    '/oauth/token',
    '/oauth/register',
    '/oauth/revoke',
    '/mcp/remote',
    '/dl/',
    '/up/', // upload_link: a página e o envio usam o token do link, não o login
];
/** Called by claude.ai's servers (or the MCP Inspector in a browser): no cookies, own credentials. */
const REMOTE_CROSS_ORIGIN_PATHS = ['/oauth/token', '/oauth/register', '/oauth/revoke', '/mcp/remote'];

const CALLS_PER_MINUTE = 120;
const MCP_INSTRUCTIONS = workdir => [
    'Este conector é o SERVIDOR do usuário (MeuTerminal): Linux com internet livre, os programas que ele instalou e disco que persiste entre conversas.',
    'Use-o como extensão do seu ambiente: o que você não consegue fazer aí (instalar pacotes, baixar arquivos/modelos, rodar Docker, guardar coisas) faça aqui.',
    `Pasta de trabalho: ${workdir} (caminhos relativos partem dela).`,
    'Comece com server_info se precisar saber o que há instalado.',
    'Resultados de pesquisa e resumos: salve com save_note (aparece no app de Anotações do celular) ou write_file.',
    'Tarefas longas: start_job + job_status/job_output, com notify=true para avisar o usuário no fim.',
    'Para ver um site rodando aqui: open_url + screenshot.',
    'Arquivos: nunca passe arquivo grande pela conversa. Pastas de troca: troca/entrada e troca/saida. O usuário manda arquivos de qualquer tamanho por upload_link (confira com upload_received); entregue resultados com share_link; confira toda transferência com file_info (tamanho e sha256); para ver vídeo ou imagem grande use media_preview (quadros), não o arquivo.',
    'Comandos arriscados pedem aprovação no celular do usuário: se a resposta for "aguardando aprovação", avise-o e repita a chamada com o approval_id.',
    'Prefira um script num comando só a muitas chamadas pequenas; saídas longas: redirecione para arquivo e leia com read_file.',
].join('\n');

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Página do upload_link: escolher arquivos e mandar, com progresso e o sha256 de cada um. */
function uploadPage({ maxBytes, expiresAt }) {
    const gb = Math.round(maxBytes / 1073741824 * 10) / 10;
    const until = new Date(expiresAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Enviar arquivos · MeuTerminal</title>
<style>
:root{color-scheme:dark}body{margin:0;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#121212;color:#F2F0E3;display:flex;justify-content:center}
main{width:100%;max-width:520px;padding:28px 18px}h1{font-size:26px;margin:0 0 6px;letter-spacing:-.02em}p{color:#9a9a9a;margin:0 0 18px}
label{display:flex;align-items:center;justify-content:center;gap:10px;height:120px;border:2px dashed #A855F7;border-radius:20px;color:#C084FC;font-weight:600;cursor:pointer}
input{display:none}ul{list-style:none;padding:0;margin:18px 0 0;display:grid;gap:10px}
li{padding:12px 14px;border-radius:14px;background:#1F1F1F;font-size:14px;word-break:break-all}
.bar{height:6px;border-radius:3px;background:#333;margin-top:8px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#A855F7}
.ok{color:#5CEB91}.err{color:#F87171}small{display:block;color:#8a8a8a;margin-top:4px;font-family:ui-monospace,monospace;font-size:11.5px}
</style></head><body><main>
<h1>Enviar arquivos</h1>
<p>Vão direto para o servidor. Até ${esc(gb)} GB por arquivo; o link vale até ${esc(until)}.</p>
<label>+ Escolher arquivos<input type="file" multiple></label>
<ul></ul>
<script>
const input=document.querySelector('input'),list=document.querySelector('ul');
const fmt=n=>n<1048576?(n/1024).toFixed(0)+' KB':n<1073741824?(n/1048576).toFixed(1)+' MB':(n/1073741824).toFixed(2)+' GB';
input.addEventListener('change',async()=>{for(const f of input.files){await send(f)}input.value=''});
function send(f){return new Promise(done=>{const li=document.createElement('li');li.innerHTML='<b></b> · '+fmt(f.size)+'<div class="bar"><i></i></div><small></small>';
li.querySelector('b').textContent=f.name;list.prepend(li);const bar=li.querySelector('i'),note=li.querySelector('small');
const x=new XMLHttpRequest();x.open('PUT',location.pathname+'?name='+encodeURIComponent(f.name));
x.setRequestHeader('Content-Type','application/octet-stream');x.upload.onprogress=e=>{if(e.lengthComputable)bar.style.width=(e.loaded/e.total*100)+'%'};
x.onload=()=>{let r={};try{r=JSON.parse(x.responseText)}catch{}if(x.status<300){bar.style.width='100%';note.className='ok';note.textContent='Enviado como '+r.name+' · sha256 '+r.sha256}else{note.className='err';note.textContent=r.error||('Erro '+x.status)}done()};
x.onerror=()=>{note.className='err';note.textContent='Falha na conexão.';done()};x.send(f)})}
</script></main></body></html>`;
}

/**
 * @param {import('express').Express} app
 * @param {object} ctx
 * @param {boolean} ctx.enabled - REMOTE_MCP_ENABLED=true and email login on
 * @param {string} ctx.disabledReason - shown in /admin when not enabled
 * @param {string} ctx.basePath
 * @param {string} ctx.baseUrl
 * @param {import('node:sqlite').DatabaseSync} ctx.db
 * @param {string} ctx.fingerprint - of the login credentials (tokens die when it changes)
 * @param {(c: {email: string, password: string, code?: string}) => {ok?: boolean, needCode?: boolean, error?: string}} ctx.verifyCredentials
 * @param {boolean} ctx.twoFactor
 * @param {(req, res) => boolean} ctx.requireReauth
 * @param {number} ctx.lockoutMs
 * @param {object} ctx.sessions
 * @param {object|null} ctx.notes
 * @param {(id: string|null) => void} ctx.notesChanged
 * @param {() => import('../scripts/push').PushNotifier} ctx.notifier
 * @param {object} ctx.localTools - createMcpTools() of the local MCP
 * @param {boolean} ctx.browserAvailable
 * @param {{get: Function, set: Function}} ctx.prefs
 * @param {string} ctx.dataDir
 * @param {string} ctx.publicDir
 * @param {string} ctx.version
 * @param {NodeJS.ProcessEnv} ctx.env
 * @param {Function} ctx.log
 */
function registerRemote(app, ctx) {
    const BP = ctx.basePath;

    if (!ctx.enabled) {
        app.get(`${BP}/api/remote`, (req, res) => res.json({ enabled: false, reason: ctx.disabledReason }));
        return null;
    }

    const env = ctx.env;
    const origin = new URL(ctx.baseUrl).origin;
    const publicBase = `${origin}${BP}`;
    const getSwitch = () => ctx.prefs.get('remote_switch') !== 'off';
    const getMode = () => {
        const saved = ctx.prefs.get('remote_approval');
        if (MODES.includes(saved)) return saved;
        return MODES.includes(env.REMOTE_MCP_APPROVAL) ? env.REMOTE_MCP_APPROVAL : 'dangerous';
    };

    const exec = new RemoteExec({ runAs: env.REMOTE_MCP_RUN_AS || 'root', workdir: env.REMOTE_MCP_WORKDIR });
    const files = new FileManager({ home: exec.workdir, log: ctx.log });
    const oauth = new RemoteOAuth({
        db: ctx.db,
        issuer: publicBase,
        fingerprint: ctx.fingerprint,
        envClient: env.REMOTE_MCP_CLIENT_ID ? { id: env.REMOTE_MCP_CLIENT_ID.trim(), secret: (env.REMOTE_MCP_CLIENT_SECRET || '').trim() } : null,
        dcr: env.REMOTE_MCP_DCR !== 'false',
        extraRedirectUris: String(env.REMOTE_MCP_REDIRECT_URIS || '').split(',').map(s => s.trim()),
    });
    if (env.REMOTE_MCP_CLIENT_ID && !env.REMOTE_MCP_CLIENT_SECRET) {
        console.warn('REMOTE_MCP_CLIENT_ID sem REMOTE_MCP_CLIENT_SECRET: o cliente fixo foi ignorado.');
    }
    const audit = new RemoteAudit({ db: ctx.db, mask: s => exec.mask(s) });
    const shares = new Shares();

    const push = async msg => {
        const n = ctx.notifier();
        if (!n) return null;
        return n.send(msg).catch(e => ctx.log('Push failed:', e.message));
    };
    const approvals = new Approvals({
        getMode,
        notify: req => {
            const what = req.summary.length > 140 ? `${req.summary.slice(0, 140)}…` : req.summary;
            const why = req.risks.length ? ` (${req.risks.join('; ')})` : '';
            ctx.sessions.broadcast({ type: 'notify', title: 'Claude pede aprovação', message: `${what}${why} · Configurações → Ponte com o Claude`, sound: true });
            return push({
                title: 'Claude pede aprovação', body: `${what}${why}`, url: `${BP}/admin#ponte`, tag: `approval-${req.id}`,
                approvalId: req.id, always: true,
                actions: [{ action: 'approve', title: 'Aprovar' }, { action: 'reject', title: 'Recusar' }],
            });
        },
    });
    const jobs = new RemoteJobs({
        db: ctx.db,
        dir: path.join(ctx.dataDir, 'remote-jobs'),
        exec,
        log: ctx.log,
        onFinish: job => {
            if (!job.notify) return;
            const label = job.name || job.command.slice(0, 60);
            const status = { ok: 'terminou', failed: `falhou (exit ${job.exitCode})`, timeout: 'estourou o tempo', killed: 'foi encerrado' }[job.status] || job.status;
            push({ title: 'Job do Claude', body: `${label}: ${status}`, url: `${BP}/admin#ponte` });
        },
    });

    const { tools, impl } = createRemoteTools({
        exec, files, approvals, jobs, shares, notes: ctx.notes, notesChanged: ctx.notesChanged,
        local: ctx.localTools, browserAvailable: ctx.browserAvailable, sessions: ctx.sessions, prefs: ctx.prefs, publicBase,
    });
    const handler = createJsonRpcHandler({
        tools, impl,
        serverInfo: { name: 'meuterminal-ponte', version: ctx.version },
        instructions: MCP_INSTRUCTIONS(exec.workdir),
        onCall: (tool, args, outcome, callCtx) => {
            try {
                const o = auditOutcome(outcome.result, outcome.error);
                const outside = typeof args.path === 'string' && (!args.source || args.source === 'local')
                    && !exec.insideWorkdir(exec.resolvePath(args.path)) ? 'fora da pasta de trabalho' : '';
                audit.record({
                    clientId: callCtx?.req?.remote?.clientId, tool, args, ok: o.ok, exitCode: o.exitCode,
                    durationMs: outcome.ms, outputBytes: o.outputBytes, note: [o.note, outside].filter(Boolean).join(' · '),
                });
            } catch (e) {
                ctx.log('remote audit failed:', e.message);
            }
        },
    });

    // ---------- OAuth metadata (RFC 8414 / RFC 9728) ----------

    const metaHeaders = res => res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    const asMeta = (req, res) => metaHeaders(res).json(oauth.authorizationServerMetadata());
    const prMeta = (req, res) => metaHeaders(res).json(oauth.protectedResourceMetadata());
    // Well-known URLs live at the host root; with a BASE_PATH the path goes after them
    // (RFC 8414 §3), and the variants under BASE_PATH are served too for lenient clients.
    for (const prefix of new Set(['', BP])) {
        app.get(`${prefix}/.well-known/oauth-authorization-server`, asMeta);
        app.get(`${prefix}/.well-known/oauth-protected-resource`, prMeta);
    }
    if (BP) app.get(`/.well-known/oauth-authorization-server${BP}`, asMeta);
    app.get(`/.well-known/oauth-protected-resource${BP}/mcp/remote`, prMeta);
    if (BP) app.get(`${BP}/.well-known/oauth-protected-resource${BP}/mcp/remote`, prMeta);

    // ---------- Authorization (consent page) ----------

    const oauthLimiter = new AttemptLimiter({ max: 5, lockoutMs: ctx.lockoutMs });
    const clientLimiter = new AttemptLimiter({ max: 20, lockoutMs: ctx.lockoutMs });
    const dcrLimiter = new AttemptLimiter({ max: 10, lockoutMs: 60 * 60 * 1000 });
    const sweeper = setInterval(() => { oauthLimiter.sweep(); clientLimiter.sweep(); dcrLimiter.sweep(); oauth.sweepCodes(); }, 60 * 1000);
    sweeper.unref?.();

    const consentTemplate = fs.readFileSync(path.join(ctx.publicDir, 'oauth-authorize.html'), 'utf8');
    const page = (res, status, vars) => {
        let html = consentTemplate.replace('<!--BASE-->', `<base href="${esc(BP)}/">`);
        for (const [k, v] of Object.entries(vars)) html = html.split(`{{${k}}}`).join(esc(v));
        res.status(status).set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }).type('html').send(html);
    };
    const errorPage = (res, message) => page(res, 400, {
        MODE: 'error', CLIENT: '', REDIRECT_HOST: '', TWO_FACTOR: ctx.twoFactor ? '1' : '', ERROR: message,
    });

    app.get(`${BP}/oauth/authorize`, (req, res) => {
        if (!getSwitch()) return errorPage(res, 'A ponte com o Claude está desligada. Ligue em Configurações → Ponte com o Claude e tente de novo.');
        let request;
        try {
            request = oauth.validateAuthorizeRequest(req.query);
        } catch (e) {
            if (e instanceof OAuthError && e.redirectUri) {
                const url = new URL(e.redirectUri);
                url.searchParams.set('error', e.code);
                url.searchParams.set('error_description', e.message);
                if (e.state !== undefined) url.searchParams.set('state', e.state);
                return res.redirect(url.toString());
            }
            return errorPage(res, e.message);
        }
        page(res, 200, {
            MODE: 'consent', CLIENT: request.client.name, REDIRECT_HOST: new URL(request.redirectUri).host,
            TWO_FACTOR: ctx.twoFactor ? '1' : '', ERROR: '',
        });
    });

    app.post(`${BP}/oauth/authorize/approve`, (req, res) => {
        res.set('Cache-Control', 'no-store');
        const body = req.body || {};
        let request;
        try {
            if (!getSwitch()) throw new Error('A ponte está desligada.');
            request = oauth.validateAuthorizeRequest(body.query || {});
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
        if (body.decision === 'deny') return res.json({ redirect: oauth.denyUrl(request) });

        const ip = req.ip;
        if (oauthLimiter.isLockedOut(ip)) {
            return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${oauthLimiter.minutesLeft(ip)} minuto(s).` });
        }
        const result = ctx.verifyCredentials({ email: body.email, password: body.password, code: body.code });
        setTimeout(() => {
            if (result.needCode && !result.error) return res.status(401).json({ needCode: true });
            if (!result.ok) {
                oauthLimiter.record(ip);
                return res.status(401).json({ error: result.error || 'Não autorizado.', needCode: !!result.needCode, attemptsLeft: oauthLimiter.attemptsLeft(ip) });
            }
            oauthLimiter.reset(ip);
            ctx.log(`Claude bridge: access granted to client ${request.client.id}`);
            push({ title: 'Ponte com o Claude', body: `Acesso concedido a "${request.client.name}". Não foi você? Revogue em Configurações.`, url: `${BP}/admin#ponte` });
            res.json({ redirect: oauth.issueCode(request) });
        }, crypto.randomInt(50, 150));
    });

    // ---------- Token, registration, revocation ----------

    /** client_id/secret from HTTP Basic (client_secret_basic) or the form (client_secret_post / public). */
    function clientCredentials(req) {
        const header = req.get('authorization') || '';
        if (header.startsWith('Basic ')) {
            const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
            const i = decoded.indexOf(':');
            if (i > 0) {
                return { clientId: decodeURIComponent(decoded.slice(0, i)), clientSecret: decodeURIComponent(decoded.slice(i + 1)) };
            }
        }
        const b = req.body || {};
        return { clientId: b.client_id, clientSecret: b.client_secret };
    }

    const oauthError = (res, e) => {
        if (!(e instanceof OAuthError)) {
            ctx.log('OAuth error:', e);
            e = new OAuthError('server_error', 'Erro interno.', 500);
        }
        if (e.status === 401) res.set('WWW-Authenticate', 'Basic realm="meuterminal"');
        return res.status(e.status).json(e.toJSON());
    };

    app.post(`${BP}/oauth/token`, (req, res) => {
        res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Access-Control-Allow-Origin': '*' });
        const ip = req.ip;
        if (clientLimiter.isLockedOut(ip)) return res.status(429).json({ error: 'slow_down', error_description: 'Muitas tentativas.' });
        try {
            if (!getSwitch()) throw new OAuthError('access_denied', 'A ponte está desligada.', 403);
            const client = oauth.authenticateClient(clientCredentials(req));
            res.json(oauth.exchange(client, req.body || {}));
        } catch (e) {
            if (e instanceof OAuthError && (e.code === 'invalid_client' || e.code === 'invalid_grant')) clientLimiter.record(ip);
            oauthError(res, e);
        }
    });

    app.post(`${BP}/oauth/register`, (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        const ip = req.ip;
        if (dcrLimiter.isLockedOut(ip)) return res.status(429).json({ error: 'invalid_request', error_description: 'Registros demais. Tente mais tarde.' });
        dcrLimiter.record(ip);
        try {
            if (!getSwitch()) throw new OAuthError('access_denied', 'A ponte está desligada.', 403);
            const client = oauth.registerClient(req.body || {});
            ctx.log(`Claude bridge: client registered ${client.client_id} (${client.client_name})`);
            res.status(201).json(client);
        } catch (e) {
            oauthError(res, e);
        }
    });

    app.post(`${BP}/oauth/revoke`, (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
        try {
            const client = oauth.authenticateClient(clientCredentials(req));
            oauth.revokeToken(client, (req.body || {}).token);
            res.status(200).end();
        } catch (e) {
            oauthError(res, e);
        }
    });

    // ---------- The MCP endpoint ----------

    const calls = new Map(); // clientId -> timestamps of tools/call in the last minute
    function rateLimited(clientId, body) {
        const n = (Array.isArray(body) ? body : [body]).filter(m => m && m.method === 'tools/call').length;
        if (!n) return false;
        const now = Date.now();
        const recent = (calls.get(clientId) || []).filter(t => now - t < 60000);
        if (recent.length + n > CALLS_PER_MINUTE) {
            calls.set(clientId, recent);
            return true;
        }
        for (let i = 0; i < n; i++) recent.push(now);
        calls.set(clientId, recent);
        return false;
    }

    const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource${BP}/mcp/remote`;
    function remoteAuth(req, res, next) {
        res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id' });
        const unauthorized = description => res.status(401)
            .set('WWW-Authenticate', `Bearer resource_metadata="${resourceMetadataUrl}"${description ? `, error="invalid_token", error_description="${description}"` : ''}`)
            .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
        const header = req.get('authorization') || '';
        const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
        if (!token) return unauthorized('');
        const grant = oauth.verifyAccessToken(token);
        if (!grant) return unauthorized('Token inválido ou expirado');
        if (!getSwitch()) {
            return res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32002, message: 'A ponte com o MeuTerminal está desligada pelo usuário.' } });
        }
        if (rateLimited(grant.clientId, req.body)) {
            return res.status(429).json({ jsonrpc: '2.0', id: null, error: { code: -32003, message: `Mais de ${CALLS_PER_MINUTE} chamadas por minuto. Espere um pouco ou junte os passos num script.` } });
        }
        req.remote = grant;
        next();
    }

    app.post(`${BP}/mcp/remote`, remoteAuth, (req, res) => {
        handler(req, res).catch(e => {
            console.error('Remote MCP error:', e);
            res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } });
        });
    });
    // Unauthenticated GETs get the 401 + resource metadata pointer (how clients discover OAuth);
    // with a token there's still no server-initiated stream: POST only.
    app.get(`${BP}/mcp/remote`, remoteAuth, (req, res) => res.status(405).set('Allow', 'POST').end());
    app.all(`${BP}/mcp/remote`, (req, res) => res.status(405).set('Allow', 'POST').end());

    // ---------- Temporary download links (share_link) ----------

    app.get(`${BP}/dl/:token`, async (req, res) => {
        const link = getSwitch() ? shares.get(req.params.token) : null;
        if (!link || link.kind === 'upload') return res.status(404).type('text').send('Link inválido ou expirado.');
        res.set('Referrer-Policy', 'no-referrer');
        try {
            await files.send(req, res, link.source, link.path, { download: true });
        } catch (e) {
            if (!res.headersSent) res.status(e.status || 500).type('text').send(e.message);
        }
    });

    // ---------- Temporary upload links (upload_link) ----------
    // Página simples para o usuário mandar arquivos de qualquer tamanho direto para uma pasta do
    // servidor; cada arquivo vai num PUT em fluxo (sem passar pela memória nem pela conversa).

    const uploadLink = token => {
        const link = getSwitch() ? shares.get(token) : null;
        return link && link.kind === 'upload' ? link : null;
    };

    app.get(`${BP}/up/:token`, (req, res) => {
        const link = uploadLink(req.params.token);
        if (!link) return res.status(404).type('text').send('Link inválido ou expirado.');
        res.set({ 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
        res.type('html').send(uploadPage({ maxBytes: link.maxBytes, expiresAt: link.expiresAt }));
    });

    app.put(`${BP}/up/:token`, async (req, res) => {
        const link = uploadLink(req.params.token);
        if (!link) return res.status(404).json({ error: 'Link inválido ou expirado.' });
        const declared = Number(req.headers['content-length'] || 0);
        if (declared > link.maxBytes) return res.status(413).json({ error: `Grande demais (máximo ${Math.round(link.maxBytes / 1073741824 * 10) / 10} GB).` });
        // espaço livre: nunca encher o disco (mínimo 2 GB sobrando)
        try {
            const st = await fs.promises.statfs(link.dir);
            if (st.bavail * st.bsize - declared < 2 * 1073741824) return res.status(507).json({ error: 'Pouco espaço livre no servidor.' });
        } catch { /* sem statfs: segue */ }
        const raw = String(req.query.name || 'arquivo').normalize('NFC');
        const safe = path.basename(raw).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').replace(/^\.+/, '_').slice(0, 200) || 'arquivo';
        await fs.promises.mkdir(link.dir, { recursive: true });
        // nunca sobrescreve: "nome (2).ext"
        let name = safe;
        for (let i = 2; fs.existsSync(path.join(link.dir, name)); i++) {
            const ext = path.extname(safe);
            name = `${path.basename(safe, ext)} (${i})${ext}`;
        }
        const dest = path.join(link.dir, name);
        const partial = `${dest}.parcial`;
        const hash = crypto.createHash('sha256');
        let size = 0;
        let tooBig = false;
        const out = fs.createWriteStream(partial, { flags: 'wx' });
        req.on('data', chunk => {
            size += chunk.length;
            if (size > link.maxBytes && !tooBig) { tooBig = true; req.unpipe(out); out.destroy(); req.destroy(); return; }
            hash.update(chunk);
        });
        req.pipe(out);
        const done = await new Promise(resolve => {
            out.on('finish', () => resolve(true));
            out.on('error', () => resolve(false));
            out.on('close', () => resolve(!tooBig && out.writableFinished));
            req.on('aborted', () => resolve(false));
        });
        if (!done || tooBig) {
            await fs.promises.rm(partial, { force: true });
            if (!res.headersSent) res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'Grande demais.' : 'O envio foi interrompido.' });
            return;
        }
        await fs.promises.rename(partial, dest);
        if (!exec.sameUser) { try { await fs.promises.chown(dest, exec.user.uid, exec.user.gid); } catch { /* ignore */ } }
        const entry = { name, path: dest, size, sha256: hash.digest('hex'), at: new Date().toISOString() };
        link.received.push(entry);
        try {
            await fs.promises.appendFile(path.join(link.dir, 'manifest.txt'), `${entry.at}\t${entry.size}\t${entry.sha256}\t${entry.name}\n`);
        } catch { /* manifest é extra */ }
        ctx.log?.(`Ponte: recebido por upload_link ${dest} (${size} bytes)`);
        res.json({ name, size, sha256: entry.sha256 });
    });

    // ---------- /admin API (behind the normal login) ----------

    app.get(`${BP}/api/remote`, (req, res) => {
        res.json({
            enabled: true,
            on: getSwitch(),
            approvalMode: getMode(),
            url: `${publicBase}/mcp/remote`,
            fixedClientId: oauth.envClient ? oauth.envClient.id : null,
            dcr: oauth.dcr,
            twoFactor: ctx.twoFactor,
            runAs: exec.sameUser ? os.userInfo().username : exec.user.name,
            workdir: exec.workdir,
            clients: oauth.listClients(),
            approvals: approvals.list(),
            jobs: jobs.list({ limit: 15 }).map(j => ({ ...j, command: exec.mask(j.command) })),
            tools: tools.map(t => t.name),
        });
    });

    app.put(`${BP}/api/remote`, (req, res) => {
        const { on, approvalMode } = req.body || {};
        // Turning it on, or asking for fewer approvals, is the sensitive direction: step-up first
        const loosening = (on === true && !getSwitch())
            || (MODES.includes(approvalMode) && MODES.indexOf(approvalMode) > MODES.indexOf(getMode()));
        if (loosening && !ctx.requireReauth(req, res)) return;
        if (typeof on === 'boolean') {
            ctx.prefs.set('remote_switch', on ? 'on' : 'off');
            if (!on) shares.revokeAll();
        }
        if (approvalMode !== undefined) {
            if (!MODES.includes(approvalMode)) return res.status(400).json({ error: 'Modo inválido.' });
            ctx.prefs.set('remote_approval', approvalMode);
        }
        res.json({ on: getSwitch(), approvalMode: getMode() });
    });

    app.post(`${BP}/api/remote/clients/:id/revoke`, (req, res) => {
        res.json(oauth.revokeClient(req.params.id));
    });
    app.post(`${BP}/api/remote/revoke-all`, (req, res) => {
        shares.revokeAll();
        res.json({ tokens: oauth.revokeAll() });
    });

    app.post(`${BP}/api/remote/approvals/:id`, (req, res) => {
        const decided = approvals.decide(req.params.id, (req.body || {}).approve === true);
        if (!decided) return res.status(404).json({ error: 'Aprovação não encontrada ou já respondida.' });
        res.json({ status: decided.status });
    });

    app.get(`${BP}/api/remote/audit`, (req, res) => {
        res.json(audit.list({ limit: req.query.limit, offset: req.query.offset, tool: req.query.tool }));
    });

    app.get(`${BP}/api/remote/jobs/:id/output`, (req, res) => {
        try {
            res.json(jobs.output(req.params.id, {}));
        } catch (e) {
            res.status(404).json({ error: e.message });
        }
    });
    app.post(`${BP}/api/remote/jobs/:id/kill`, (req, res) => {
        try {
            res.json(jobs.kill(req.params.id));
        } catch (e) {
            res.status(404).json({ error: e.message });
        }
    });

    console.log(`Ponte com o Claude ligada: ${publicBase}/mcp/remote (comandos como ${exec.sameUser ? 'o usuário do servidor' : exec.user.name}, pasta ${exec.workdir})`);
    return { oauth, approvals, jobs, audit, shares, exec };
}

module.exports = { registerRemote, REMOTE_PUBLIC_PATHS, REMOTE_CROSS_ORIGIN_PATHS };
