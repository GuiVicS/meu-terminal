require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const http = require('http');
const os = require('os');
const fs = require('fs');
const { generatePWAManifest, generateNotesManifest } = require("./scripts/pwa-manifest-generator");
const { originValidationMiddleware, getCorsOptions, validateOrigin } = require('./scripts/cors');
const { TotpVerifier } = require('./scripts/totp');
const { safeEqual, verifyPin, createTokenSigner, AttemptLimiter, isSameOrigin: isSameOriginWith, isPublicPath } = require('./scripts/auth');
const { childEnv } = require('./scripts/child-env');
const SessionStore = require('./scripts/session-store');
const SessionManager = require('./scripts/session-manager');
const CommandStore = require('./scripts/command-store');
const NotesStore = require('./scripts/notes-store');
const NotesAttachments = require('./scripts/notes-attachments');
const BackupStore = require('./scripts/backup-store');
const BackupRunner = require('./scripts/backup-runner');
const WebhookStore = require('./scripts/webhook-store');
const WebhookRunner = require('./scripts/webhook-runner');
const webhookPresets = require('./scripts/webhook-presets');
const { resolveInputs } = require('./scripts/webhook-inputs');
const { verifyHmacSignature } = require('./scripts/webhook-crypto');
const { BrowserManager, listPorts, normalizeUrl } = require('./scripts/browser-manager');
const { createMcpHandler, createMcpTools, mcpToken } = require('./scripts/mcp-server');
const { registerRemote, REMOTE_PUBLIC_PATHS, REMOTE_CROSS_ORIGIN_PATHS } = require('./routes/remote');
const { FileManager, FileError } = require('./scripts/file-manager');
const { LiveServers } = require('./scripts/live-server');
const { Vibe } = require('./scripts/vibe');
const VibeStore = require('./scripts/vibe-store');
const { VercelDeploy } = require('./scripts/vercel-deploy');
const { PushNotifier } = require('./scripts/push');
const QRCode = require('qrcode');
const AgentStore = require('./scripts/agents/agent-store');
const { AgentGateway, GatewayError } = require('./scripts/agents/gateway');
const { AgentLauncher } = require('./scripts/agents/launch');
const { writeShims, writeRcFile } = require('./scripts/agents/shims');
const { execFile } = require('child_process');
const { Addons, SERVICES } = require('./scripts/addons');
const { deleteConversation, canDelete: canDeleteConversation } = require('./scripts/agents/history-files');
const { detectAgents, searchDirs } = require('./scripts/agents/detect');
const { ServiceManager, ROUTES, DEFAULT_ROUTE, RouteError, routeEnv, normalizeRoute } = require('./scripts/addon-services');
const { OmniRouteBridge, ClaudeMemBridge, HeadroomBridge, BridgeError } = require('./scripts/addon-bridges');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'TRUE';
const NODE_ENV = process.env.NODE_ENV || 'production';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DEMO_MODE = process.env.DEMO_MODE === 'true';
const SITE_TITLE = DEMO_MODE ? `${process.env.SITE_TITLE || 'MeuTerminal'} (DEMO)` : (process.env.SITE_TITLE || 'MeuTerminal');
const APP_VERSION = require('./package.json').version;
const PUBLIC_DIR = path.join(__dirname, 'public');
// node-pty is a native module: only load it when a real shell is needed, so demo mode
// runs on machines without a C++ toolchain
const ptyModule = DEMO_MODE ? require('./scripts/demo/terminal') : require('node-pty');
const ASSETS_DIR = path.join(PUBLIC_DIR, 'assets');
const CACHE_NAME = `MEUTERMINAL_CACHE_V${APP_VERSION}`;
// SQLite file with the sessions (tabs). Mount its folder as a volume to keep it across deploys.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'meuterminal.db');
// Agent UI: "claude", "codex", "opencode" shims put first on the shells' PATH (bash only)
const AGENT_UI_ENABLED = !DEMO_MODE && process.platform !== 'win32' && process.env.AGENT_UI !== 'off';
const AGENT_SHIM_DIR = path.join(path.dirname(DB_PATH), 'agent-bin');
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const HOME_DIR = DEMO_MODE ? '/home/demo' : (process.env.HOME || os.homedir());

generatePWAManifest(SITE_TITLE);
generateNotesManifest(SITE_TITLE);

function debugLog(...args) {
    if (DEBUG) {
        console.log('[DEBUG]', ...args);
    }
}

// Base URL configuration
const BASE_PATH = (() => {
    if (!BASE_URL) {
        debugLog('No BASE_URL set, using empty base path');
        return '';
    }
    try {
        const url = new URL(BASE_URL);
        const path = url.pathname.replace(/\/$/, ''); // Remove trailing slash
        debugLog('Base URL Configuration:', {
            originalUrl: BASE_URL,
            extractedPath: path,
            protocol: url.protocol,
            hostname: url.hostname
        });
        return path;
    } catch {
        // If BASE_URL is just a path (e.g. /app)
        const path = BASE_URL.replace(/\/$/, '');
        debugLog('Using direct path as BASE_URL:', path);
        return path;
    }
})();

// Get the project name from package.json to use for the PIN environment variable
const projectName = require('./package.json').name.toUpperCase().replace(/-/g, '_');

// Email + password login (preferred). When both are set they replace the PIN.
const AUTH_EMAIL = (process.env.AUTH_EMAIL || '').trim().toLowerCase();
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';
const isEmailAuth = AUTH_EMAIL !== '' && AUTH_PASSWORD !== '';
const AUTH_COOKIE = `${projectName}_AUTH`;

// Optional two-factor login (TOTP authenticator app). Only active with email login.
// An invalid secret stops the server instead of silently turning 2FA off.
const TOTP_SECRET = (process.env.AUTH_TOTP_SECRET || '').trim();
const totp = isEmailAuth && TOTP_SECRET ? new TotpVerifier(TOTP_SECRET) : null;
if (TOTP_SECRET && !isEmailAuth) {
    console.warn('AUTH_TOTP_SECRET ignorado: a verificação em duas etapas exige AUTH_EMAIL e AUTH_PASSWORD.');
}

// Legacy PIN login, only used when email login is not configured
const PIN = isEmailAuth ? '' : process.env[`${projectName}_PIN`];
const isPinRequired = !!(PIN && PIN.trim() !== '');
const AUTH_MODE = isEmailAuth ? 'email' : (isPinRequired ? 'pin' : 'none');
const isAuthRequired = AUTH_MODE !== 'none';

// No login at all is only allowed on purpose: a terminal open to anyone who finds the address
// is root on the machine. Demo mode has nothing to protect.
if (!isAuthRequired && !DEMO_MODE && process.env.ALLOW_NO_LOGIN !== 'true') {
    console.error('Nenhum login configurado. Defina AUTH_EMAIL e AUTH_PASSWORD (recomendado) ou '
        + `${projectName}_PIN. Para rodar sem login de propósito (ex.: só na sua máquina), use ALLOW_NO_LOGIN=true.`);
    process.exit(1);
}

// Claude bridge (routes/remote.js, docs/PLANO-MCP-REMOTO.md): claude.ai drives this server through
// /mcp/remote. Off by default, and only with email + password (its consent page asks for them).
const REMOTE_MCP_REQUESTED = process.env.REMOTE_MCP_ENABLED === 'true';
const REMOTE_MCP_ENABLED = REMOTE_MCP_REQUESTED && AUTH_MODE === 'email' && !DEMO_MODE;
const REMOTE_MCP_DISABLED_REASON = !REMOTE_MCP_REQUESTED ? 'REMOTE_MCP_ENABLED não está como true.'
    : DEMO_MODE ? 'Indisponível no modo demonstração.'
    : 'A ponte exige login com email e senha (AUTH_EMAIL e AUTH_PASSWORD); com PIN ou sem login ela não liga.';
if (REMOTE_MCP_REQUESTED && !REMOTE_MCP_ENABLED) console.warn(`Ponte com o Claude não ligada: ${REMOTE_MCP_DISABLED_REASON}`);

// Log which protection is enabled
if (isEmailAuth) {
    debugLog('Email/password login is enabled for:', AUTH_EMAIL, totp ? '(with 2FA)' : '');
} else if (isPinRequired) {
    debugLog('PIN protection is enabled, PIN length:', PIN.length);
} else {
    debugLog('Authentication is disabled');
}

// ---- Email login tokens (scripts/auth.js) ----
// Signed expiry, never the password; changing the password or 2FA in .env logs everyone out.
const tokens = createTokenSigner({ email: AUTH_EMAIL, password: AUTH_PASSWORD, totpSecret: totp ? TOTP_SECRET : '' });
const MAX_SESSION_AGE = (process.env.MAX_SESSION_AGE || 24) * 60 * 60 * 1000; // default 24 hours

function createAuthToken() {
    return tokens.create(MAX_SESSION_AGE);
}

function verifyAuthToken(token) {
    return isEmailAuth && tokens.verify(token);
}

/** True if the request/handshake carries valid credentials for the active auth mode. */
function hasValidAuthCookie(cookies) {
    if (AUTH_MODE === 'email') return verifyAuthToken(cookies[AUTH_COOKIE]);
    if (AUTH_MODE === 'pin') return verifyPin(PIN, cookies[`${projectName}_PIN`]);
    return true;
}

// Brute force protection
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = (process.env.LOCKOUT_TIME || 15) * 60 * 1000; // default 15 minutes in milliseconds
const loginLimiter = new AttemptLimiter({ max: MAX_ATTEMPTS, lockoutMs: LOCKOUT_TIME });

// ---- Step-up re-authentication ----
// A handful of actions (creating a webhook, editing its script, issuing a token - see
// docs/PLANO-WEBHOOKS.md section 3.6.2) ask for the password/PIN again even from an already
// logged-in session, so a device left unlocked isn't enough to do them. POST /api/reauth (below,
// next to /verify-pin) checks the credential for whichever AUTH_MODE is active and stamps
// req.session.reauthAt; requireReauth() here is what the sensitive routes check.
const REAUTH_MAX_AGE = 5 * 60 * 1000; // how long a step-up check is good for
function hasRecentReauth(req) {
    return !isAuthRequired || (!!req.session.reauthAt && Date.now() - req.session.reauthAt < REAUTH_MAX_AGE);
}
function requireReauth(req, res) {
    if (hasRecentReauth(req)) return true;
    res.status(401).json({ error: 'reauth_necessario' });
    return false;
}

// Security middleware
app.set('trust proxy', 1);
app.use(cors(getCorsOptions(BASE_URL)));
// File editor saves text through JSON (5 MB); agent prompts carry base64 images (up to 40 MB)
const jsonSmall = express.json({ limit: '5mb' });
const jsonAgentPrompt = express.json({ limit: '40mb' });
// Public webhook triggers (section 3.6.6 of the plan): capped at 64 KB, and the exact raw bytes
// are kept on req.rawBody - needed to verify an HMAC signature (phase 5), which is computed over
// the body as sent, not a re-serialization of the parsed JSON.
const captureRawBody = (req, res, buf) => { req.rawBody = buf; };
const jsonWebhook = express.json({ limit: '64kb', verify: captureRawBody });
const urlencodedWebhook = express.urlencoded({ extended: false, limit: '64kb', verify: captureRawBody });
const HOOK_PATH_RE = /\/hooks\/[^/]+$/;
// OAuth endpoints of the Claude bridge: clients send application/x-www-form-urlencoded (RFC 6749)
const OAUTH_FORM_RE = /\/oauth\/(token|revoke|register)$/;
const urlencodedOAuth = express.urlencoded({ extended: false, limit: '16kb' });
app.use((req, res, next) => {
    if (req.method === 'POST' && OAUTH_FORM_RE.test(req.path) && String(req.headers['content-type'] || '').includes('urlencoded')) {
        return urlencodedOAuth(req, res, next);
    }
    if (/\/api\/agent-sessions\/[^/]+\/prompt$/.test(req.path)) return jsonAgentPrompt(req, res, next);
    if (req.method === 'POST' && HOOK_PATH_RE.test(req.path)) {
        const parser = String(req.headers['content-type'] || '').includes('urlencoded') ? urlencodedWebhook : jsonWebhook;
        return parser(req, res, err => {
            if (!err) return next();
            res.status(400).json({ error: 'corpo_invalido' });
        });
    }
    return jsonSmall(req, res, next);
});
app.use(cookieParser());

// Session configuration with secure settings
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
        httpOnly: true,
        sameSite: 'strict',
        maxAge: MAX_SESSION_AGE
    }
}));

// Authentication middleware
const authMiddleware = (req, res, next) => {
    debugLog('Auth check for path:', req.path, 'Method:', req.method);
    
    // No login configured: bypass authentication completely
    if (!isAuthRequired) {
        debugLog('Auth bypassed - No login configured');
        req.session.authenticated = true; // Set session as authenticated
        return next();
    }

    // First check if user is authenticated via session
    if (req.session.authenticated) {
        debugLog('Auth successful - Valid session found');
        return next();
    }

    // If not authenticated via session, check the auth cookie (token or PIN)
    if (hasValidAuthCookie(req.cookies)) {
        debugLog('Auth successful - Valid auth cookie found, restoring session');
        req.session.authenticated = true;
        return next();
    }

    // No valid session or PIN cookie found
    debugLog('Auth failed - No valid session or PIN cookie, redirecting to login');
    return res.redirect(BASE_PATH + '/login');
};

// ---------- Cross-site protection (CSRF / cross-site WebSocket) ----------
// Independent of ALLOWED_ORIGINS (often "*"): anything that changes state, and every
// WebSocket, must come from this app's own pages. Browsers always send Origin on those
// requests; calls without it (curl, agents on the server) are not browser attacks.
// Needed because "same-site" is wider than "same-origin": other apps under the same
// domain (e.g. *.easypanel.host, other subdomains) would otherwise get the login cookie.
const EXTRA_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim())
    .filter(o => o && o !== '*').map(o => { try { return new URL(o).origin; } catch { return null; } }).filter(Boolean));
const isSameOrigin = req => isSameOriginWith(req, EXTRA_ORIGINS);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Global middleware for origin validation and authentication
app.use(BASE_PATH, (req, res, next) => {
    // /mcp and /api/agent-launch: server-local + token (and /mcp refuses any Origin)
    const remoteCrossOrigin = REMOTE_MCP_ENABLED && REMOTE_CROSS_ORIGIN_PATHS.includes(req.path); // own credentials, no cookies
    if (!SAFE_METHODS.has(req.method) && req.path !== '/mcp' && req.path !== '/api/agent-launch' && !req.path.startsWith('/hooks/')
        && !remoteCrossOrigin && !isSameOrigin(req)) {
        console.warn('Blocked cross-site request:', req.method, req.path, 'from', req.headers.origin);
        return res.status(403).json({ error: 'Origem não permitida.' });
    }

    // Paths that skip the login: exact match, or prefix only for entries ending in "/"
    const publicPaths = [
        '/login',
        '/login/pair', // the phone redeeming a QR code (rate-limited like the login)
        '/auth-mode',
        '/login.js',
        '/pin-length',
        '/verify-pin',
        '/config.js',
        '/assets/',
        '/fonts/',
        '/styles.css',
        '/manifest.json',
        '/asset-manifest.json',
        '/notas/manifest.json',
        // The browser fetches the worker script on its own to check for updates; if that
        // hits the login redirect the update fails silently and the PWA stays on old code.
        '/service-worker.js',
        // Agents' MCP endpoint: has its own check (local only + bearer token)
        '/mcp',
        // Public webhook triggers: own check (bearer token or HMAC signature), not the app login
        '/hooks/',
        // Claude bridge (only while on): OAuth endpoints, /mcp/remote (OAuth token), /dl/ links
        ...(REMOTE_MCP_ENABLED ? REMOTE_PUBLIC_PATHS : []),
    ];

    // Check if the current path matches any of the public paths
    if (isPublicPath(req.path, publicPaths)) {
        return next();
    }
    // Agent shims (terminal "usar o modo UI?"): own check like /mcp (local + bearer token).
    // Exact match only: /api/agent-launch/answer comes from the app and needs the login.
    if (req.path === '/api/agent-launch') {
        return next();
    }

    // For all other paths, apply both origin validation and auth middleware
    originValidationMiddleware(req, res, () => {
        authMiddleware(req, res, next);
    });
});

// Routes start here...
app.get(BASE_PATH + '/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Step-by-step guide: turning on the authenticator app (2FA)
app.get(BASE_PATH + '/guia', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'guia.html'));
});

// Admin page (settings as a full page instead of the popup; opens in its own tab).
// Not in publicPaths, so it goes through the same login as everything else.
app.get(BASE_PATH + '/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin', 'index.html'));
});

// Standalone notes-only app: its own page, its own installable PWA (manifest.json below, own icon),
// same login and the exact same notes as the main app's Anotações tab - just without the rest of
// MeuTerminal around it. Behind the normal login, like /admin; the page itself checks
// notesAvailable (via config.js) and explains when it's off, same as every other optional feature.
// Registered here (before express.static below) because public/notas/ is a real directory - static
// would otherwise 301-redirect /notas to /notas/ on its own before this ever ran.
app.get(BASE_PATH + '/notas', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'notas', 'index.html'));
});
app.get(BASE_PATH + '/notas/manifest.json', (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, 'notes-manifest.json'), { headers: { 'Cache-Control': 'no-cache' } });
});

// Serve config.js for frontend
app.get(BASE_PATH + '/config.js', (req, res) => {
    debugLog('Serving config.js with basePath:', BASE_PATH);
    const appConfig = {
        basePath: BASE_PATH,
        debug: DEBUG,
        siteTitle: SITE_TITLE,
        isPinRequired: isAuthRequired, // kept name: "a login is required" (shows logout)
        authMode: AUTH_MODE,
        isDemoMode: DEMO_MODE,
        browserAvailable: browsers.available, // Chromium installed: browser tabs enabled
        filesAvailable: FILES_ENABLED, // file manager tabs
        notesAvailable: NOTES_ENABLED, // notes tabs
        webhooksAvailable: WEBHOOKS_ENABLED, // /admin/webhooks
        hljsVersion: HLJS_VERSION, // syntax highlighting in the agent chat (vendor/hljs/<version>/)
        version: APP_VERSION,
        cacheName: CACHE_NAME,
        // Bolinha do rodapé da lista de conversas: só para quem já entrou
        userInitials: AUTH_EMAIL && (req.session?.authenticated || hasValidAuthCookie(req.cookies))
            ? AUTH_EMAIL.split('@')[0].replace(/[^a-z]/g, '').slice(0, 2).toUpperCase() : null,
    }

    // Never cached by proxies/CDNs (Cloudflare): it says which version and features are on
    res.set('Cache-Control', 'no-store');
    res.type('application/javascript').send(`
        window.appConfig = ${JSON.stringify(appConfig)};
    `);
});

// App code (html/js/css/json) must be revalidated on every load, or a CDN in front of the
// app keeps serving the previous version after a deploy. Fonts and images can be cached.
const revalidateAppCode = res => {
    if (/\.(html|js|mjs|css|json|webmanifest)$/i.test(res.req.path)) res.set('Cache-Control', 'no-cache');
};

// Serve static files for public assets
app.use(BASE_PATH + '/', express.static(path.join(PUBLIC_DIR), { setHeaders: revalidateAppCode }));
app.get(BASE_PATH + "/manifest.json", (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, "manifest.json"), { headers: { "Cache-Control": "no-cache" } });
});
app.get(BASE_PATH + "/asset-manifest.json", (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, "asset-manifest.json"), { headers: { "Cache-Control": "no-cache" } });
});
// Serve font files
app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts')));
app.use('/node_modules/@xterm/', express.static(
    path.join(__dirname, 'node_modules/@xterm/')
));
// Syntax highlighting for code in the agent chat (ES modules, loaded on demand per language).
// The version is in the URL, so the files can be cached for good.
const HLJS_VERSION = require('@highlightjs/cdn-assets/package.json').version;
app.use(`${BASE_PATH}/vendor/hljs/${HLJS_VERSION}/`, express.static(
    path.join(__dirname, 'node_modules/@highlightjs/cdn-assets/es/'),
    { immutable: true, maxAge: '365d' },
));

// Routes
app.get(BASE_PATH + '/login', (req, res) => {
    // No login configured
    if (!isAuthRequired) {
        return res.redirect(BASE_PATH + '/');
    }

    // Already authenticated (session or valid cookie)
    if (req.session.authenticated || hasValidAuthCookie(req.cookies)) {
        return res.redirect(BASE_PATH + '/');
    }

    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Tells the login page which form to show
app.get(BASE_PATH + '/auth-mode', (req, res) => {
    res.json({ mode: AUTH_MODE, twoFactor: !!totp });
});

// Email + password login
app.post(BASE_PATH + '/login', (req, res) => {
    if (AUTH_MODE !== 'email') {
        return res.status(404).json({ error: 'Email login is not enabled' });
    }

    const ip = req.ip;
    if (loginLimiter.isLockedOut(ip)) {
        return res.status(429).json({
            error: `Muitas tentativas. Tente novamente em ${loginLimiter.minutesLeft(ip)} minuto(s).`
        });
    }

    const { email, password, code } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ error: 'Informe email e senha.' });
    }

    // Always compare both fields (no early exit) so timing doesn't reveal which one was wrong
    const emailOk = safeEqual(email.trim().toLowerCase(), AUTH_EMAIL);
    const passwordOk = safeEqual(password, AUTH_PASSWORD);

    setTimeout(() => {
        if (emailOk && passwordOk && totp) {
            // Second step: the authenticator code. Asking for it isn't a failed attempt;
            // a wrong code is (counts toward the lockout like a wrong password).
            if (typeof code !== 'string' || !code.trim()) {
                return res.status(401).json({ needCode: true });
            }
            if (!totp.verify(code)) {
                debugLog('2FA code rejected');
                loginLimiter.record(ip);
                const left = loginLimiter.attemptsLeft(ip);
                return res.status(401).json({ needCode: true, error: 'Código inválido ou já usado.', attemptsLeft: left });
            }
        }
        if (emailOk && passwordOk) {
            debugLog('Email login successful');
            loginLimiter.reset(ip);
            req.session.authenticated = true;
            res.cookie(AUTH_COOKIE, createAuthToken(), {
                httpOnly: true,
                secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
                sameSite: 'strict',
                maxAge: MAX_SESSION_AGE
            });
            return res.json({ success: true, redirect: BASE_PATH + '/' });
        }

        debugLog('Email login failed');
        loginLimiter.record(ip);
        const attemptsLeft = loginLimiter.attemptsLeft(ip);
        res.status(401).json({ error: 'Email ou senha incorretos.', attemptsLeft });
    }, crypto.randomInt(50, 150));
});

// ---------- Pairing another device by QR code ----------
// A logged-in device shows a QR code; the phone scans it and is logged in without typing
// the password. Codes are random, single-use and expire in 2 minutes. 2FA isn't asked
// again: the device that created the code already passed it.
const PAIR_TTL_MS = 2 * 60 * 1000;
const pairCodes = new Map(); // code -> expiresAt

function cookieOptions(req) {
    return {
        httpOnly: true,
        secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
        sameSite: 'strict',
        maxAge: MAX_SESSION_AGE,
    };
}

/** Logs this browser in (same cookie as a password login). */
function grantLogin(req, res) {
    req.session.authenticated = true;
    if (AUTH_MODE === 'email') res.cookie(AUTH_COOKIE, createAuthToken(), cookieOptions(req));
    else if (PIN) res.cookie(`${projectName}_PIN`, PIN, cookieOptions(req));
}

app.post(BASE_PATH + '/api/pair', async (req, res) => {
    if (!isAuthRequired) return res.status(400).json({ error: 'Sem login configurado: o app já abre direto.' });
    const now = Date.now();
    pairCodes.forEach((expiresAt, code) => { if (expiresAt < now) pairCodes.delete(code); });
    if (pairCodes.size > 20) return res.status(429).json({ error: 'Códigos demais ativos. Espere 2 minutos.' });
    const code = crypto.randomBytes(24).toString('base64url');
    pairCodes.set(code, now + PAIR_TTL_MS);
    // The address this device is using (the phone must reach the same one)
    const base = (req.headers.origin && isSameOrigin(req) ? req.headers.origin : BASE_URL).replace(/\/+$/, '');
    const url = `${base}${BASE_PATH}/login?pair=${code}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.json({ url, svg, expiresIn: PAIR_TTL_MS / 1000 });
});

// The phone that scanned the QR code redeems it (public route, rate-limited like the login)
app.post(BASE_PATH + '/login/pair', (req, res) => {
    const ip = req.ip;
    if (loginLimiter.isLockedOut(ip)) return res.status(429).json({ error: 'Muitas tentativas. Tente mais tarde.' });
    const code = String((req.body || {}).code || '');
    const expiresAt = pairCodes.get(code);
    if (!expiresAt || expiresAt < Date.now()) {
        loginLimiter.record(ip);
        return res.status(401).json({ error: 'Código inválido ou expirado. Gere um novo QR code.' });
    }
    pairCodes.delete(code); // single use
    loginLimiter.reset(ip);
    grantLogin(req, res);
    debugLog('Device paired by QR code');
    res.json({ success: true, redirect: BASE_PATH + '/' });
});

app.get(BASE_PATH + '/pin-length', (req, res) => {
    // If no PIN is set, return 0 length
    if (!PIN || PIN.trim() === '') {
        return res.json({ length: 0 });
    }
    res.json({ length: PIN.length });
});

app.post(BASE_PATH + '/verify-pin', (req, res) => {
    debugLog('PIN verification attempt from IP:', req.ip);

    // Email login replaces the PIN: this route must never authenticate in that mode
    if (AUTH_MODE === 'email') {
        return res.status(404).json({ error: 'PIN login is not enabled' });
    }

    // If no PIN is set, authentication is successful
    if (!PIN || PIN.trim() === '') {
        debugLog('PIN verification bypassed - No PIN configured');
        req.session.authenticated = true;
        return res.status(200).json({ success: true });
    }

    const ip = req.ip;
    
    // Check if IP is locked out
    if (loginLimiter.isLockedOut(ip)) {
        debugLog('PIN verification blocked - IP is locked out:', ip);
        return res.status(429).json({ 
            error: `Too many attempts. Please try again in ${loginLimiter.minutesLeft(ip)} minutes.`
        });
    }

    const { pin } = req.body;
    
    if (!pin || typeof pin !== 'string') {
        debugLog('PIN verification failed - Invalid PIN format');
        return res.status(400).json({ error: 'Invalid PIN format' });
    }

    // Verify PIN first
    const isPinValid = verifyPin(PIN, pin);
    
    if (isPinValid) {
        debugLog('PIN verification successful');
        // Reset attempts on successful login
        loginLimiter.reset(ip);
        
        // Set authentication in session immediately
        req.session.authenticated = true;
        
        // Set secure cookie
        res.cookie(`${projectName}_PIN`, pin, {
            httpOnly: true,
            secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
            sameSite: 'strict',
            maxAge: MAX_SESSION_AGE
        });
        
        // Add artificial delay before sending response
        setTimeout(() => {
            // Redirect to main page on success
            res.redirect(BASE_PATH + '/');
        }, crypto.randomInt(50, 150));
    } else {
        debugLog('PIN verification failed - Invalid PIN');
        // Record failed attempt
        loginLimiter.record(ip);
        
        const attemptsLeft = loginLimiter.attemptsLeft(ip);
        
        // Add artificial delay before sending error response
        setTimeout(() => {
            res.status(401).json({ 
                error: 'Invalid PIN',
                attemptsLeft: Math.max(0, attemptsLeft)
            });
        }, crypto.randomInt(50, 150));
    }
});

// Step-up check: same credential as the normal login (password+2FA code, or PIN), but only
// stamps req.session.reauthAt instead of logging in - the session was already authenticated to
// even reach this route. Shares the login's brute-force counters (same risk, same protection).
app.post(BASE_PATH + '/api/reauth', (req, res) => {
    if (!isAuthRequired) return res.json({ success: true });
    const ip = req.ip;
    if (loginLimiter.isLockedOut(ip)) {
        return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${loginLimiter.minutesLeft(ip)} minuto(s).` });
    }

    if (AUTH_MODE === 'email') {
        const { password, code } = req.body || {};
        if (typeof password !== 'string') return res.status(400).json({ error: 'Informe a senha.' });
        const passwordOk = safeEqual(password, AUTH_PASSWORD);
        if (passwordOk && totp) {
            if (typeof code !== 'string' || !code.trim()) return res.status(401).json({ needCode: true });
            if (!totp.verify(code)) {
                loginLimiter.record(ip);
                return res.status(401).json({ needCode: true, error: 'Código inválido ou já usado.' });
            }
        }
        if (!passwordOk) {
            loginLimiter.record(ip);
            return res.status(401).json({ error: 'Senha incorreta.' });
        }
    } else if (AUTH_MODE === 'pin') {
        const { pin } = req.body || {};
        if (typeof pin !== 'string' || !verifyPin(PIN, pin)) {
            loginLimiter.record(ip);
            return res.status(401).json({ error: 'PIN incorreto.' });
        }
    }

    loginLimiter.reset(ip);
    req.session.reauthAt = Date.now();
    res.json({ success: true });
});

app.get(BASE_PATH + '/api/require-pin', (req, res) => {
    // No login configured
    if (!isAuthRequired) {
        return res.json({ success: true, required: false, mode: AUTH_MODE });
    }

    // Valid auth cookie (token or PIN, depending on the mode)?
    return res.json({ success: hasValidAuthCookie(req.cookies), required: true, mode: AUTH_MODE });
});

// ---------- Terminal sessions (tabs) stored on the server ----------
// All /api routes sit behind the global auth + origin middleware above.
const sessionStore = new SessionStore(DB_PATH);
const sessions = new SessionManager({
    store: sessionStore,
    spawnShell,
    shellInfo,
    getProcessInfo,
    defaultCwd: HOME_DIR,
    log: debugLog,
});

// Browser tabs: pages of one headless Chromium on this server (images streamed to the tab)
const browsers = new BrowserManager({
    // Cookies/logins of the pages live next to the database (same volume)
    profileDir: path.join(path.dirname(DB_PATH), 'chromium-profile'),
    onUrlChange: (id, url) => {
        sessionStore.update(id, { url });
        sessions.changed(); // other devices update the tab's subtitle
    },
    hiddenPorts: [Number(PORT)],
    log: (...args) => console.log('[navegador]', ...args),
});

// File manager tabs: this server's folders + rclone remotes (Google Drive...) when installed.
// Off in the public demo (it would expose the host); DEMO_FILES=true turns it on for tests.
const FILES_ENABLED = !DEMO_MODE || process.env.DEMO_FILES === 'true';
const NOTES_ENABLED = process.env.NOTES_ENABLED !== 'false'; // notes tabs (on by default)
// Webhooks that run a script on the server: off by default (see docs/PLANO-WEBHOOKS.md). The
// public /hooks/:slug route doesn't exist yet (phases 4-5) - this only gates /admin/webhooks
// and its API, same as every other optional feature here.
const WEBHOOKS_ENABLED = process.env.WEBHOOKS_ENABLED === 'true';
// FILES_HOME: the folder the file manager opens at (default: the shell's home)
const files = new FileManager({ home: process.env.FILES_HOME || (DEMO_MODE ? os.homedir() : HOME_DIR), log: debugLog });

// ---------- Live preview (like VS Code's Live Server) ----------
// Project folders served on 127.0.0.1 for the server's Chromium; browser tabs with a
// watched folder (stored in the row's cwd) reload when a file is saved.
const live = new LiveServers({ store: sessionStore, log: debugLog });
browsers.extraHiddenPorts = () => live.ports;
const liveWatches = new Map(); // browser tab id -> unwatch()

async function setLiveReload(id, folder) {
    const row = sessionStore.get(id);
    if (!row || row.kind !== 'browser') return null;
    liveWatches.get(id)?.();
    liveWatches.delete(id);
    let resolved = null;
    if (folder) {
        resolved = path.resolve(files.home, String(folder).replace(/^~(?=$|[\\/])/, files.home));
        const st = await fs.promises.stat(resolved).catch(() => null);
        if (!st || !st.isDirectory()) throw new Error(`Pasta não encontrada: ${resolved}`);
        liveWatches.set(id, live.watch(resolved, file => browsers.reloadTab(id, file).catch(() => {})));
    }
    sessionStore.update(id, { cwd: resolved });
    browsers.setLive(id, resolved);
    return resolved;
}
browsers.onLive = (id, folder) => setLiveReload(id, folder).catch(e => debugLog('Live reload:', e.message));

// After a restart: live servers of saved preview tabs come back, and so do their watchers
(async () => {
    for (const row of sessionStore.listOpen().filter(r => r.kind === 'browser')) {
        const port = /^http:\/\/127\.0\.0\.1:(\d+)\//.exec(row.url || '')?.[1];
        const folder = port && live.folderForPort(port);
        if (folder) await live.serve(folder).catch(e => debugLog('Live server restore:', e.message));
        if (row.cwd) await setLiveReload(row.id, row.cwd).catch(() => {});
    }
})();

/** The terminal tab an agent runs in: given id, else the last terminal the user focused. */
let lastFocusedTerminal = null;
function agentTerminal(tabId) {
    const valid = id => {
        const row = id && sessionStore.get(id);
        return row && row.status === 'open' && (!row.kind || row.kind === 'terminal') ? row.id : null;
    };
    return valid(tabId) || valid(lastFocusedTerminal)
        || sessionStore.listOpen().find(r => !r.kind || r.kind === 'terminal')?.id || null;
}

app.get(BASE_PATH + '/api/sessions', (req, res) => {
    res.json(sessions.list());
});

app.post(BASE_PATH + '/api/sessions', (req, res) => {
    const { name, cwd, color, afterId, reopenId, kind, url } = req.body || {};
    if (kind === 'browser' && !browsers.available) {
        return res.status(503).json({ error: 'Chromium não está instalado no servidor.' });
    }
    if (kind === 'files' && !FILES_ENABLED) {
        return res.status(503).json({ error: 'Gerenciador de arquivos desligado.' });
    }
    if (kind === 'notes' && !NOTES_ENABLED) {
        return res.status(503).json({ error: 'Anotações desligadas.' });
    }
    // "localhost:5173" -> "http://localhost:5173" (same rules as the address bar)
    const pageUrl = kind === 'browser' && url ? normalizeUrl(url) : url;
    res.status(201).json(sessions.create({ name, cwd, color, afterId, reopenId, kind, url: pageUrl }));
});

// Ports listening on the server ("localhost:5173 detectado" in the new tab page)
app.get(BASE_PATH + '/api/ports', async (req, res) => {
    res.json(await listPorts([Number(PORT), ...live.ports]));
});

// ---------- MCP server for agents running inside the terminals ----------
// Every shell gets MEUTERMINAL_MCP_URL / MEUTERMINAL_MCP_TOKEN (see spawnShell).
const MCP_TOKEN = mcpToken(sessionStore);
const MCP_URL = `http://127.0.0.1:${PORT}${BASE_PATH}/mcp`;

// Agent UI gateway and vibecoding both need MCP_URL/MCP_TOKEN above, and the MCP handler just
// below needs vibe - all three have to sit in this exact order.
const AGENT_MEDIA_DIR = path.join(path.dirname(DB_PATH), 'agent-media');
// Complementos: plugins do Claude Code que já vêm instalados (scripts/addons.js) e os serviços
// Headroom/OmniRoute com as rotas do Claude Code (scripts/addon-services.js)
const addons = new Addons({
    stateFile: path.join(path.dirname(DB_PATH), 'addons.json'),
    home: HOME_DIR,
    env: childEnv(),
    log: (...a) => console.log(...a),
});
const addonServices = new ServiceManager({ defs: SERVICES, home: HOME_DIR, env: childEnv(), secrets: id => addons.serviceSecrets(id), log: (...a) => console.log(...a) });

/** Env da rota para um agente; liga o serviço se precisar. Só o Claude Code fala o protocolo da Anthropic. */
async function agentRouteEnv({ agent, route, routeModel = null }) {
    route = normalizeRoute(route);
    if (agent !== 'claude' || route === DEFAULT_ROUTE) return {};
    const prefs = addons.prefs();
    const service = ROUTES[route].service;
    if (!prefs.services[service]?.enabled) {
        throw new RouteError(`Ligue o ${SERVICES[service].label} em Configurações → Complementos para usar "${ROUTES[route].label}".`);
    }
    if (service === 'omniroute') await ensureOmniKey();
    const env = routeEnv(route, addons.prefs(), SERVICES, { model: routeModel }); // valida a chave antes de ligar o serviço
    await addonServices.ensure(service);
    return env;
}

/** Rota padrão do terminal, valendo só se o serviço dela estiver ligado. */
function terminalRoute() {
    const prefs = addons.prefs();
    const route = normalizeRoute(prefs.terminalRoute);
    return route !== DEFAULT_ROUTE && prefs.services[ROUTES[route].service]?.enabled ? route : DEFAULT_ROUTE;
}

/** Env da rota padrão do terminal (síncrono: os serviços ligados já estão rodando). */
function terminalRouteEnv() {
    try { return routeEnv(terminalRoute(), addons.prefs(), SERVICES); } catch { return {}; }
}

/**
 * Troca automática: o limite do Claude acabou numa conversa do Modo UI. Se estiver ligada
 * (Configurações → Complementos), a conversa passa para o OmniRoute com o modelo escolhido, é
 * retomada e a mensagem que falhou é reenviada. A assinatura do Claude nunca passa pelo OmniRoute.
 */
/**
 * Modelos do OmniRoute no seletor do Claude Code no Modo UI (Codex, GPT, Gemini... conectados lá):
 * escolher um passa a conversa para a rota "Outros modelos" com aquele modelo. Cache curto, para
 * não consultar o OmniRoute a cada conversa aberta.
 */
let omniModelsCache = { at: 0, list: [] };
async function extraAgentModels({ agent }) {
    if (agent !== 'claude' || !addons.prefs().services.omniroute?.enabled) return [];
    if (Date.now() - omniModelsCache.at > 60000) {
        const models = await bridges.omniroute.allModels();
        omniModelsCache = { at: Date.now(), list: models };
    }
    return omniModelsCache.list.map(m => ({
        value: `omniroute:${m.id}`, name: m.name || m.id, model: m.id, route: 'omniroute',
        group: `OmniRoute${m.provider ? ` · ${m.provider}` : ''}`,
    }));
}

async function usageLimitFallback({ sessionId, row, text, images }) {
    const prefs = addons.prefs();
    if (!prefs.fallback.enabled || row.agent !== 'claude' || normalizeRoute(row.route) === 'omniroute') return;
    if (!prefs.services.omniroute?.enabled) {
        agentGateway.emitEvent(sessionId, 'notice', { text: 'O limite do Claude acabou. A troca automática está ligada, mas o OmniRoute está desligado (Configurações → Complementos).' });
        return;
    }
    const model = prefs.fallback.model || prefs.services.omniroute?.model || null;
    if (!model) {
        agentGateway.emitEvent(sessionId, 'notice', { text: 'O limite do Claude acabou. Escolha o modelo da troca automática em Configurações → Complementos.' });
        return;
    }
    agentGateway.emitEvent(sessionId, 'notice', { text: `O limite do Claude acabou: continuando pelo OmniRoute com ${model}…` });
    await agentGateway.setRoute(sessionId, 'omniroute', model);
    if (text && text.trim() || (images && images.length)) await agentGateway.prompt(sessionId, text, { images });
}

const agentGateway = new AgentGateway({
    store: new AgentStore(DB_PATH),
    // Images/files produced by agents (or attached to prompts), next to the database (same volume)
    mediaDir: AGENT_MEDIA_DIR,
    // Agents never get the popup themselves (their shells are not TTYs anyway)
    // (without the app's own secrets - scripts/child-env.js)
    env: childEnv({ MT_NO_INTERCEPT: '1', MEUTERMINAL_MCP_URL: MCP_URL, MEUTERMINAL_MCP_TOKEN: MCP_TOKEN }),
    // Agents in the UI can use MeuTerminal's own tools (open_url, screenshot, notify...)
    mcpServers: [{ type: 'http', name: 'meuterminal', url: MCP_URL, headers: [{ name: 'Authorization', value: `Bearer ${MCP_TOKEN}` }] }],
    routeEnv: agentRouteEnv,
    onUsageLimit: usageLimitFallback,
    extraModels: extraAgentModels,
    log: debugLog,
});
// Os agentes acham os programas instalados nas pastas do usuário (~/.local/bin, ~/.opencode/bin...)
agentGateway.env.PATH = searchDirs(agentGateway.env, HOME_DIR).join(path.delimiter);

/**
 * IAs de terminal instaladas (scripts/agents/detect.js): as que falam ACP entram no Modo UI
 * sozinhas. Refeito no máximo a cada 20 s, quando o menu de agentes é aberto.
 */
const BUILTIN_AGENTS = new Set(Object.keys(agentGateway.agents));
let agentScan = { at: 0, running: null };
function refreshAgents() {
    if (Date.now() - agentScan.at < 20000) return Promise.resolve();
    agentScan.running ||= detectAgents({ known: Object.fromEntries([...BUILTIN_AGENTS].map(id => [id, agentGateway.agents[id]])), env: agentGateway.env, home: HOME_DIR })
        .then(({ found }) => {
            // Some quem foi desinstalado (e não tem conversa aberta); entra quem apareceu
            for (const id of Object.keys(agentGateway.agents)) {
                if (!BUILTIN_AGENTS.has(id) && !found[id]) delete agentGateway.agents[id];
            }
            Object.assign(agentGateway.agents, found);
            agentScan.at = Date.now();
        })
        .catch(e => debugLog(`detectAgents: ${e.message}`))
        .finally(() => { agentScan.running = null; });
    return agentScan.running;
}
refreshAgents();
const agentLauncher = new AgentLauncher({
    gateway: agentGateway,
    sessions,
    prefs: { get: key => sessionStore.getMeta(key), set: (key, value) => sessionStore.setMeta(key, value) },
    commandExists,
    // Conversa aberta pelo terminal: a mesma rota do terminal
    defaultRoute: agent => (agent === 'claude' && terminalRoute() !== DEFAULT_ROUTE ? terminalRoute() : null),
    log: debugLog,
});
// Vibecoding: project form -> agent UI tab | live preview (split) + files tab, always the agent
// UI (never a typed shell command).
const vibe = new Vibe({
    sessions, store: sessionStore, live, setLiveReload, home: files.home,
    gateway: agentGateway, commandExists, vibeStore: new VibeStore(sessionStore.db),
    deployer: new VercelDeploy({ token: process.env.VERCEL_TOKEN }), log: debugLog,
});

const mcpDeps = {
    sessions, store: sessionStore, browsers, files: FILES_ENABLED ? files : null,
    listPorts: exclude => listPorts([...exclude, ...live.ports]), normalizeUrl, port: Number(PORT),
    live, vibe, setLiveReload, agentTerminal, notifier: () => notifier,
};
const mcpHandler = createMcpHandler(mcpDeps);

/**
 * Agents run on this machine: only loopback connections with the token are accepted.
 * Requests carrying an Origin come from a web page (DNS rebinding etc.) and are refused.
 */
function mcpAuth(req, res, next) {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!local || req.get('origin') || !safeEqual(token, MCP_TOKEN)) {
        return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
    }
    next();
}

app.post(BASE_PATH + '/mcp', mcpAuth, (req, res) => {
    mcpHandler(req, res).catch(e => {
        console.error('MCP error:', e);
        res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } });
    });
});
// No server-initiated stream (GET) or session teardown (DELETE): POST only
app.all(BASE_PATH + '/mcp', (req, res) => res.status(405).set('Allow', 'POST').end());

// Settings screen: how to register the MCP in an agent (behind the normal login)
app.get(BASE_PATH + '/api/mcp-info', (req, res) => {
    res.json({
        url: MCP_URL,
        token: MCP_TOKEN,
        claude: 'claude mcp add --transport http --scope user meuterminal "$MEUTERMINAL_MCP_URL" '
            + '--header "Authorization: Bearer $MEUTERMINAL_MCP_TOKEN"',
    });
});

// ---------- Agent UI (scripts/agents/) ----------

/** Is `command` an executable on the server's PATH (or an absolute path)? */
function commandExists(command) {
    if (!command) return false;
    const candidates = path.isAbsolute(command)
        ? [command]
        : searchDirs(process.env, HOME_DIR).map(dir => path.join(dir, command));
    return candidates.some(file => {
        try {
            fs.accessSync(file, fs.constants.X_OK);
            return fs.statSync(file).isFile();
        } catch {
            return false;
        }
    });
}

let agentRcFile = null; // bash --rcfile for MeuTerminal shells (scripts/agents/shims.js)
// The agent UI runs code on this server: it needs a login (AUTH_EMAIL/AUTH_PASSWORD or PIN)
if (AGENT_UI_ENABLED && isAuthRequired) {
    try {
        writeShims(AGENT_SHIM_DIR, agentGateway.listAgents().filter(a => !a.terminalOnly).map(a => a.id));
        // bash reads ~/.bashrc, which may put another folder before the shims: fix PATH after it
        if (path.basename(SHELL) === 'bash') agentRcFile = writeRcFile(AGENT_SHIM_DIR);
    } catch (e) {
        console.error('Could not write agent shims:', e.message);
    }
}

// Without a login anyone reaching the app could run agents: refuse (shims fall back to the terminal)
app.use(BASE_PATH + '/api', (req, res, next) => {
    if (isAuthRequired || !/^\/agent/.test(req.path) || req.path === '/agents') return next();
    res.status(403).json({ error: 'O modo UI de agentes precisa de login: defina AUTH_EMAIL e AUTH_PASSWORD.' });
});

/** Runs an agent route: GatewayError -> its status; anything else -> 500. */
function agentRoute(handler) {
    return async (req, res) => {
        try {
            await handler(req, res);
        } catch (e) {
            const status = e instanceof GatewayError ? e.status : 500;
            if (status >= 500) console.error('Agent route error:', e);
            res.status(status).json({ error: e.message });
        }
    };
}

// The shim in a terminal asks "open this agent in the UI?" (loopback + token, like the MCP).
// The request stays open until someone answers the popup (or it times out -> terminal).
app.post(BASE_PATH + '/api/agent-launch', mcpAuth, agentRoute(async (req, res) => {
    const { agent, cwd, tabId, prompt } = req.body || {};
    res.json(await agentLauncher.launch({
        agent: String(agent || ''),
        cwd: typeof cwd === 'string' ? cwd : '',
        tabId: typeof tabId === 'string' ? tabId : null,
        prompt: typeof prompt === 'string' && prompt.trim() ? prompt.slice(0, 20000) : null,
    }));
}));

// Popup answered in a window ([Sim] / [Não], optionally "lembrar minha escolha")
app.post(BASE_PATH + '/api/agent-launch/answer', (req, res) => {
    const { requestId, choice, remember } = req.body || {};
    if (!agentLauncher.answer(String(requestId || ''), { choice, remember: !!remember })) {
        return res.status(410).json({ error: 'Essa pergunta já foi respondida ou expirou.' });
    }
    res.json({ success: true });
});

app.get(BASE_PATH + '/api/agent-prefs', (req, res) => res.json(agentLauncher.getPrefs()));
app.put(BASE_PATH + '/api/agent-prefs', (req, res) => res.json(agentLauncher.setPrefs(req.body || {})));

// Complementos: status, ligar/desligar serviços, chave/modelo do OmniRoute e rota do terminal
app.get(BASE_PATH + '/api/addons', async (req, res) => {
    const prefs = addons.prefs();
    res.json({
        enabled: !DEMO_MODE,
        routes: Object.entries(ROUTES).map(([id, r]) => ({ id, label: r.label, service: r.service })),
        terminalRoute: normalizeRoute(prefs.terminalRoute),
        fallback: prefs.fallback,
        addons: await addons.status({ services: addonServices }),
    });
});
app.put(BASE_PATH + '/api/addons', async (req, res) => {
    if (DEMO_MODE) return res.status(403).json({ error: 'Indisponível no modo demo.' });
    const body = req.body || {};
    if (body.terminalRoute !== undefined && !ROUTES[body.terminalRoute]) return res.status(400).json({ error: 'Rota desconhecida.' });
    const prefs = addons.setPrefs(body);
    try {
        await addonServices.apply(prefs);
        await ensureOmniKey();
    } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
    }
    res.json({ terminalRoute: normalizeRoute(addons.prefs().terminalRoute), fallback: addons.prefs().fallback, addons: await addons.status({ services: addonServices }) });
});

// Telas dos complementos dentro das Configurações (scripts/addon-bridges.js): o servidor fala com
// cada serviço em 127.0.0.1; o usuário não abre painel no navegador nem faz outro login.
const bridges = {
    omniroute: new OmniRouteBridge({ port: SERVICES.omniroute.port, password: () => addons.serviceSecrets('omniroute').INITIAL_PASSWORD, home: HOME_DIR }),
    'claude-mem': new ClaudeMemBridge(),
    headroom: new HeadroomBridge({ port: SERVICES.headroom.port }),
};

/** Com o OmniRoute ligado e sem chave salva, cria a chave da rota "Outros modelos". */
async function ensureOmniKey() {
    const omni = addons.prefs().services.omniroute || {};
    if (!omni.enabled || omni.apiKey) return;
    const key = await bridges.omniroute.createKey();
    addons.setPrefs({ services: { omniroute: { apiKey: key } } });
}

/** O trabalhador do Claude Mem sobe com as sessões do Claude; para a tela, sobe agora se precisar. */
let memStarting = null;
function startClaudeMem() {
    memStarting ||= new Promise(resolve => {
        execFile('claude-mem', ['start'], { cwd: HOME_DIR, env: childEnv({ HOME: HOME_DIR }), timeout: 90000 }, () => resolve());
    }).finally(() => { memStarting = null; });
    return memStarting;
}

async function bridgeFor(id) {
    const bridge = bridges[id];
    if (!bridge) throw new BridgeError('Complemento sem tela.', 404);
    if (SERVICES[id]) {
        if (!addons.prefs().services[id]?.enabled) throw new BridgeError(`Ligue o ${SERVICES[id].label} para usar a tela dele.`, 409);
        await addonServices.ensure(id);
        if (id === 'omniroute') await ensureOmniKey();
    }
    return bridge;
}

async function withMem(fn) {
    try {
        return await fn();
    } catch (e) {
        if (e.status !== 503) throw e;
        await startClaudeMem();
        if (!await bridges['claude-mem'].waitReady(60000)) throw new BridgeError('O Claude Mem não respondeu depois de iniciar. Tente de novo em instantes.', 503);
        return fn();
    }
}

app.get(BASE_PATH + '/api/addons/:id/panel', async (req, res) => {
    if (DEMO_MODE) return res.status(403).json({ error: 'Indisponível no modo demo.' });
    try {
        const bridge = await bridgeFor(req.params.id);
        const data = req.params.id === 'claude-mem' ? await withMem(() => bridge.panel()) : await bridge.panel();
        if (req.params.id === 'omniroute') {
            data.model = addons.prefs().services.omniroute?.model || null;
            data.codexLogin = OmniRouteBridge.hasCodexLogin(HOME_DIR);
        }
        res.json(data);
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// Painel completo de cada complemento: endereço local e como entrar sem login
const ADDON_PANELS = {
    omniroute: {
        url: `http://localhost:${SERVICES.omniroute.port}/dashboard`,
        prepare: async () => browsers.setCookie({ url: `http://localhost:${SERVICES.omniroute.port}`, name: 'auth_token', value: await bridges.omniroute.sessionToken() }),
    },
    'claude-mem': { url: 'http://localhost:37700/viewer', prepare: () => withMem(() => bridges['claude-mem'].panel()) },
    headroom: { url: `http://localhost:${SERVICES.headroom.port}/dashboard` },
};

async function attachAddonPanel(ws, id, params) {
    const def = ADDON_PANELS[id];
    if (!def) throw new BridgeError('Complemento sem painel completo.', 404);
    if (!browsers.available) throw new BridgeError('O navegador interno não está instalado no servidor.', 503);
    await bridgeFor(id); // ligado? sobe o serviço se preciso
    await def.prepare?.();
    browsers.attach(ws, { id: `addon-panel-${id}`, url: def.url, cwd: null }, {
        width: params.get('width'), height: params.get('height'), dpr: params.get('dpr'),
        mobile: params.get('mobile') === '1', quality: params.get('quality'), visible: params.get('visible') !== '0',
    });
}

// Só as ações que as telas usam (nada de repassar rotas arbitrárias)
const BRIDGE_ACTIONS = {
    omniroute: {
        catalog: b => b.catalog(),
        addProvider: (b, a) => b.addProvider(a),
        removeProvider: (b, a) => b.removeProvider(String(a.id || '')),
        testProvider: (b, a) => b.testProvider(String(a.id || '')),
        models: (b, a) => b.models(String(a.id || '')),
        allModels: b => b.allModels(),
        importCodex: b => b.importCodex(HOME_DIR),
        setModel: (b, a) => {
            const model = typeof a.model === 'string' ? a.model : '';
            addons.setPrefs({ services: { omniroute: { model } } });
            return { model: addons.prefs().services.omniroute?.model || null };
        },
    },
    'claude-mem': {
        observations: (b, a) => withMem(() => b.observations(a)),
        search: (b, a) => withMem(() => b.search(a.query)),
        deleteObservation: (b, a) => withMem(() => b.deleteObservation(String(a.id || ''))),
    },
};
app.post(BASE_PATH + '/api/addons/:id/call', async (req, res) => {
    if (DEMO_MODE) return res.status(403).json({ error: 'Indisponível no modo demo.' });
    const { action, ...args } = req.body || {};
    const fn = BRIDGE_ACTIONS[req.params.id]?.[action];
    if (!fn) return res.status(404).json({ error: 'Ação desconhecida.' });
    try {
        res.json(await fn(await bridgeFor(req.params.id), args) ?? { ok: true });
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
});

// Conversas fixadas na lista lateral do Modo UI (ids de sessão do agente), iguais em todo aparelho
const MAX_PINS = 50;
const readPins = () => { try { const v = JSON.parse(sessionStore.getMeta('agent-pins') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
app.get(BASE_PATH + '/api/agent-pins', (req, res) => res.json({ pins: readPins() }));
app.put(BASE_PATH + '/api/agent-pins', (req, res) => {
    const pins = Array.isArray(req.body?.pins) ? req.body.pins : null;
    if (!pins) return res.status(400).json({ error: 'pins deve ser uma lista.' });
    const clean = [...new Set(pins.filter(p => typeof p === 'string' && /^[\w.:-]{1,120}$/.test(p)))].slice(0, MAX_PINS);
    sessionStore.setMeta('agent-pins', JSON.stringify(clean));
    res.json({ pins: clean });
});

app.get(BASE_PATH + '/api/agents', async (req, res) => {
    await refreshAgents();
    res.json({
        enabled: AGENT_UI_ENABLED && isAuthRequired,
        needsLogin: !isAuthRequired,
        agents: agentGateway.listAgents().map(a => ({
            ...a,
            installed: !a.terminalOnly && commandExists(agentGateway.agents[a.id].requires || agentGateway.agents[a.id].command),
            detected: !!agentGateway.agents[a.id].detected,
        })),
        // Rotas do Claude Code para trocar dentro da conversa: Direto + as dos complementos ligados
        claudeRoutes: Object.entries(ROUTES)
            .filter(([id, r]) => !r.service || addons.prefs().services[r.service]?.enabled)
            .map(([id, r]) => ({ id, label: r.label })),
    });
});

// Images/files an agent produced (or the user attached): /api/agent-media/<session>/<file>
app.get(BASE_PATH + '/api/agent-media/:session/:file', (req, res) => {
    const { session, file } = req.params;
    if (!/^[\w-]{1,80}$/.test(session) || !/^[a-f0-9]{16}\.[a-z0-9]{1,8}$/.test(file)) return res.status(404).end();
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', 'sandbox'); // an SVG/HTML from an agent never runs as the app
    res.set('Cache-Control', 'private, max-age=31536000, immutable'); // name = content hash
    if (req.query.download === '1') res.attachment(file);
    res.sendFile(path.join(AGENT_MEDIA_DIR, session, file), err => {
        if (err && !res.headersSent) res.status(404).end();
    });
});
// New agent conversation in its own tab ("Nova conversa"), or an old one resumed ("Conversas")
app.post(BASE_PATH + '/api/agent-sessions', agentRoute(async (req, res) => {
    const { agent, cwd, resumeAcpSessionId, title, afterId, route, intoTab } = req.body || {};
    if (typeof cwd !== 'string' || !cwd.trim()) return res.status(400).json({ error: 'Pasta inválida.' });
    const folder = path.resolve(HOME_DIR, cwd.replace(/^~(?=$|[\\/])/, HOME_DIR));
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return res.status(400).json({ error: 'Pasta não encontrada.' });
    const session = await agentGateway.startSession({
        agent: String(agent || ''),
        cwd: folder,
        title: typeof title === 'string' ? title.slice(0, 120) : null,
        resumeAcpSessionId: typeof resumeAcpSessionId === 'string' ? resumeAcpSessionId : null,
        // Sem rota pedida: a rota padrão do Claude Code (Configurações → Complementos)
        route: ROUTES[route] ? (route !== DEFAULT_ROUTE ? route : null)
            : (String(agent) === 'claude' && terminalRoute() !== DEFAULT_ROUTE ? terminalRoute() : null),
    });
    const def = agentGateway.agents[session.agent];
    // Lista lateral: a conversa nova abre na aba do mesmo agente, em vez de uma aba a mais
    const host = typeof intoTab === 'string' ? sessionStore.get(intoTab) : null;
    const hostSession = host && host.kind === 'agent' && host.status === 'open' ? agentGateway.get(host.url) : null;
    const tab = hostSession && hostSession.agent === session.agent
        ? sessions.update(host.id, { agentSession: session.id })
        : sessions.create({ kind: 'agent', url: session.id, cwd: folder, name: def.uiName, afterId: typeof afterId === 'string' ? afterId : undefined });
    res.status(201).json({ tab, session });
}));

// Conversas abertas de um agente (lista lateral): estado de cada uma (online / trabalhando)
app.get(BASE_PATH + '/api/agent-sessions', agentRoute(async (req, res) => {
    const agent = String(req.query.agent || '');
    res.json({
        sessions: agentGateway.list().filter(s => !agent || s.agent === agent).map(s => ({
            id: s.id, agent: s.agent, title: s.title, cwd: s.cwd, status: s.status, route: s.route || null,
            acpSessionId: s.acpSessionId || null, updatedAt: s.updatedAt,
        })),
        canDelete: canDeleteConversation(agent),
    });
}));

// Apagar uma conversa do histórico do agente (vai para a lixeira); fecha se estiver aberta
app.delete(BASE_PATH + '/api/agent-history/:agent/:acpId', agentRoute(async (req, res) => {
    const { agent, acpId } = req.params;
    for (const s of agentGateway.list().filter(x => x.agent === agent && x.acpSessionId === acpId)) {
        await agentGateway.closeSession(s.id).catch(() => {});
    }
    try {
        res.json(deleteConversation(agent, acpId, HOME_DIR));
    } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
    }
}));

app.get(BASE_PATH + '/api/agent-sessions/:id', agentRoute(async (req, res) => {
    const session = agentGateway.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
    res.json(session);
}));

app.get(BASE_PATH + '/api/agent-sessions/:id/history', agentRoute(async (req, res) => {
    const session = agentGateway.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Sessão não encontrada.' });
    res.json({ sessions: await agentGateway.listHistory({ agent: session.agent, cwd: session.cwd }) });
}));

// The turn runs in the background: its progress arrives as events on the tab's socket
app.post(BASE_PATH + '/api/agent-sessions/:id/prompt', agentRoute(async (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '');
    // Pasted/attached images (base64); the body of this route may have up to 40 MB
    const images = Array.isArray(body.images) ? body.images.slice(0, 5).map(i => ({ mimeType: String(i && i.mimeType), data: String(i && i.data) })) : [];
    agentGateway.requireRuntime(req.params.id);
    if (!text.trim() && !images.length) return res.status(400).json({ error: 'Mensagem vazia.' });
    // Agent busy: the message waits in the session queue (sent when the turn ends)
    const result = agentGateway.enqueue(req.params.id, text, { images });
    res.status(202).json({ success: true, ...result });
}));

app.delete(BASE_PATH + '/api/agent-sessions/:id/queue/:item', agentRoute(async (req, res) => {
    res.json({ removed: agentGateway.dequeue(req.params.id, req.params.item) });
}));

app.post(BASE_PATH + '/api/agent-sessions/:id/cancel', agentRoute(async (req, res) => {
    agentGateway.cancel(req.params.id);
    res.json({ success: true });
}));

// Troca a rota da conversa (Direto / Economia / Outros modelos), retomando a mesma conversa
app.post(BASE_PATH + '/api/agent-sessions/:id/route', agentRoute(async (req, res) => {
    const route = String((req.body || {}).route || '');
    if (!ROUTES[route]) return res.status(400).json({ error: 'Rota desconhecida.' });
    res.json(await agentGateway.setRoute(req.params.id, route));
}));

app.post(BASE_PATH + '/api/agent-sessions/:id/mode', agentRoute(async (req, res) => {
    await agentGateway.setMode(req.params.id, String((req.body || {}).modeId || ''));
    res.json(agentGateway.get(req.params.id));
}));

app.post(BASE_PATH + '/api/agent-sessions/:id/config', agentRoute(async (req, res) => {
    const { configId, value } = req.body || {};
    await agentGateway.setConfigOption(req.params.id, String(configId || ''), value);
    res.json(agentGateway.get(req.params.id));
}));

app.post(BASE_PATH + '/api/agent-sessions/:id/permission', agentRoute(async (req, res) => {
    const { permissionId, optionId } = req.body || {};
    const ok = agentGateway.respondPermission(req.params.id, String(permissionId || ''), {
        optionId: optionId ? String(optionId) : null,
        answeredBy: req.ip || null,
    });
    if (!ok) return res.status(410).json({ error: 'Essa permissão já foi respondida.' });
    res.json({ success: true });
}));

app.post(BASE_PATH + '/api/agent-sessions/:id/resume', agentRoute(async (req, res) => {
    res.json(await agentGateway.resumeSession(req.params.id));
}));

/**
 * Agent tab socket: replays the session's events after ?since=<seq>, then streams new ones.
 * Actions (prompt, permission...) go through the REST routes above.
 */
function attachAgentTab(ws, row, since) {
    sessions.sockets.add(ws);
    const send = message => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };
    const onEvent = event => {
        if (event.sessionId === row.url) send({ type: 'agent-event', event });
    };
    agentGateway.on('event', onEvent);
    ws.on('close', () => {
        sessions.sockets.delete(ws);
        agentGateway.off('event', onEvent);
    });
    const session = agentGateway.get(row.url);
    if (!session) {
        send({ type: 'agent-missing' });
        return;
    }
    send({ type: 'agent-session', session });
    for (const event of agentGateway.events(row.url, since)) send({ type: 'agent-event', event });
    send({ type: 'ready' });
}

// Declared before "/:id" so "order" isn't taken for an id
app.put(BASE_PATH + '/api/sessions/order', (req, res) => {
    sessions.setOrder((req.body || {}).ids);
    res.json({ success: true });
});

app.patch(BASE_PATH + '/api/sessions/:id', (req, res) => {
    const body = req.body || {};
    if (body.agentSession !== undefined) {
        // Só outra conversa do MESMO agente, e que exista
        const tab = sessionStore.get(req.params.id);
        const from = tab && tab.kind === 'agent' ? agentGateway.get(tab.url) : null;
        const to = agentGateway.get(String(body.agentSession));
        if (!tab || tab.kind !== 'agent' || !to || to.status === 'closed' || (from && from.agent !== to.agent)) {
            return res.status(400).json({ error: 'Conversa inválida para esta aba.' });
        }
    }
    const updated = sessions.update(req.params.id, body);
    if (!updated) return res.status(404).json({ error: 'Session not found' });
    res.json(updated);
});

// Closing a tab: the only action that kills its shell (or closes its browser page)
app.delete(BASE_PATH + '/api/sessions/:id', (req, res) => {
    const row = sessionStore.get(req.params.id);
    if (row && row.kind === 'browser') {
        browsers.closePage(row.id);
        liveWatches.get(row.id)?.();
        liveWatches.delete(row.id);
    }
    if (row && row.kind === 'agent' && row.url) {
        agentGateway.stopAgent(row.url).catch(e => debugLog('Stopping agent:', e.message));
    }
    if (!sessions.close(req.params.id)) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
});

// Removes a closed session from "recent"
app.delete(BASE_PATH + '/api/recent/:id', (req, res) => {
    sessions.forget(req.params.id);
    res.json({ success: true });
});

// ---------- Files (the "Arquivos" tabs) ----------
const one = value => (Array.isArray(value) ? value[0] : value);
const many = value => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** Wraps a files route: disabled check + errors as { error } with the right status. */
function filesRoute(handler) {
    return async (req, res) => {
        if (!FILES_ENABLED) return res.status(404).json({ error: 'Gerenciador de arquivos desligado.' });
        try {
            await handler(req, res);
        } catch (e) {
            const status = e instanceof FileError ? e.status : 500;
            if (status >= 500) console.error('Files error:', e);
            if (!res.headersSent) res.status(status).json({ error: e.message || 'Erro' });
            else res.destroy();
        }
    };
}

app.get(BASE_PATH + '/api/files/sources', filesRoute(async (req, res) => {
    res.json(await files.sources());
}));

app.get(BASE_PATH + '/api/files/list', filesRoute(async (req, res) => {
    res.json(await files.list(one(req.query.source), one(req.query.path)));
}));

app.get(BASE_PATH + '/api/files/stat', filesRoute(async (req, res) => {
    res.json(await files.stat(one(req.query.source), one(req.query.path)));
}));

app.get(BASE_PATH + '/api/files/size', filesRoute(async (req, res) => {
    res.json(await files.folderSize(one(req.query.source), one(req.query.path)));
}));

app.get(BASE_PATH + '/api/files/search', filesRoute(async (req, res) => {
    res.json(await files.search(one(req.query.source), one(req.query.path), one(req.query.q)));
}));

// Raw file (preview, <img>/<video> sources, download with ?download=1)
app.get(BASE_PATH + '/api/files/raw', filesRoute(async (req, res) => {
    await files.send(req, res, one(req.query.source), one(req.query.path), { download: one(req.query.download) === '1' });
}));

// Folder or several items as .tar.gz (?path=<folder>&names=a&names=b)
app.get(BASE_PATH + '/api/files/archive', filesRoute(async (req, res) => {
    await files.sendArchive(res, one(req.query.source), one(req.query.path), many(req.query.names));
}));

app.get(BASE_PATH + '/api/files/text', filesRoute(async (req, res) => {
    res.json(await files.readText(one(req.query.source), one(req.query.path)));
}));

app.put(BASE_PATH + '/api/files/text', filesRoute(async (req, res) => {
    const { source, path: filePath, text, expectMtime, force } = req.body || {};
    res.json(await files.writeText(source, filePath, text, { expectMtime, force: !!force }));
}));

// Upload: the request body is the file itself (no multipart), streamed to disk/rclone
app.post(BASE_PATH + '/api/files/upload', filesRoute(async (req, res) => {
    const result = await files.upload(req, one(req.query.source), one(req.query.path), one(req.query.name), {
        overwrite: one(req.query.overwrite) === '1',
    });
    res.status(201).json(result);
}));

app.post(BASE_PATH + '/api/files/op', filesRoute(async (req, res) => {
    const b = req.body || {};
    switch (b.op) {
        case 'mkdir': return res.json(await files.mkdir(b.source, b.path, b.name));
        case 'touch': return res.json(await files.touch(b.source, b.path, b.name));
        case 'rename': return res.json(await files.rename(b.source, b.path, b.name));
        case 'delete': return res.json(await files.remove(b.source, many(b.paths)));
        case 'copy':
        case 'move':
            return res.json(await files.transfer(many(b.items), b.dest || {}, { move: b.op === 'move' }));
        default:
            return res.status(400).json({ error: 'Operação desconhecida.' });
    }
}));

// Favorite folders (sidebar), shared by every device
app.get(BASE_PATH + '/api/files/favorites', filesRoute(async (req, res) => {
    const row = sessionStore.db.prepare(`SELECT value FROM meta WHERE key = 'files_favorites'`).get();
    let list = [];
    try {
        list = row ? JSON.parse(row.value) : [];
    } catch { /* reset */ }
    res.json(Array.isArray(list) ? list : []);
}));

app.put(BASE_PATH + '/api/files/favorites', filesRoute(async (req, res) => {
    const list = (Array.isArray(req.body) ? req.body : []).slice(0, 100)
        .filter(f => f && typeof f.path === 'string' && f.path.length <= 4096)
        .map(f => ({
            source: typeof f.source === 'string' ? f.source.slice(0, 200) : 'local',
            path: f.path,
            name: typeof f.name === 'string' ? f.name.slice(0, 100) : '',
        }));
    sessionStore.db.prepare(`INSERT INTO meta (key, value) VALUES ('files_favorites', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(list));
    res.json(list);
}));

// ---------- Vibecoding (project form -> split agent UI | preview + files tab) ----------
app.get(BASE_PATH + '/api/vibe/kinds', (req, res) => {
    res.json({ kinds: vibe.kinds(), agents: vibe.agentOptions(), defaults: vibe.defaults(), vercelConfigured: vibe.deployer.configured });
});

// "Abrir projeto anterior": every vibecoding project created so far, newest first
app.get(BASE_PATH + '/api/vibe/projects', (req, res) => {
    res.json({ projects: vibe.list() });
});

// Is this tab part of a vibecoding project, and which agents have a section there already?
// Backs the agent switcher - specific to vibecoding, not shown for a plain agent conversation.
app.get(BASE_PATH + '/api/vibe/tab/:tabId', (req, res) => {
    // null = aba de agente comum (não é projeto): 200, para não sujar o console a cada aba
    res.json(vibe.projectForTab(req.params.tabId) || null);
});

// Started from the app menu: a new terminal runs the agent chosen in the form
app.post(BASE_PATH + '/api/vibe', async (req, res) => {
    try {
        res.status(201).json(await vibe.setup(req.body || {}));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Reopen a previous project, or switch which agent's UI tab is shown for an open one
app.post(BASE_PATH + '/api/vibe/:id/open', async (req, res) => {
    try {
        res.json(await vibe.openProject(req.params.id, { agent: (req.body || {}).agent || null }));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// "Publicar": deploys the project to Vercel (production). Can take a few minutes.
app.post(BASE_PATH + '/api/vibe/:id/publish', async (req, res) => {
    try {
        res.json(await vibe.publish(req.params.id));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// The form an agent asked for (MCP start_vibecoding) was answered or cancelled
app.post(BASE_PATH + '/api/vibe/answer', (req, res) => {
    const { requestId, cancelled, answers } = req.body || {};
    if (!cancelled) {
        try {
            vibe.clean(answers || {});
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    }
    if (!vibe.answer(String(requestId || ''), cancelled ? { cancelled: true } : { answers })) {
        return res.status(404).json({ error: 'Este formulário já foi respondido ou expirou.' });
    }
    res.json({ success: true });
});

// Which terminal the user is looking at (agents without MEUTERMINAL_TAB_ID open things beside it)
app.post(BASE_PATH + '/api/focus', (req, res) => {
    const row = sessionStore.get(String((req.body || {}).id || ''));
    if (row && row.status === 'open' && (!row.kind || row.kind === 'terminal')) lastFocusedTerminal = row.id;
    res.json({ success: true });
});

// ---------- Push notifications (with sound) ----------
const notifier = new PushNotifier({
    store: sessionStore,
    // VAPID contact: the app's HTTPS address (push services only accept https: or mailto:)
    subject: /^https:\/\//.test(BASE_URL) ? BASE_URL : 'mailto:noreply@meuterminal.app',
    log: (...args) => console.warn('[push]', ...args),
});

// Push (phone/desktop, even with the app closed): an agent is waiting for a permission.
agentGateway.on('event', (event) => {
    if (event.type !== 'permission.request') return;
    const session = agentGateway.get(event.sessionId);
    // Tapping the push opens this conversation's tab, not just the app (public/index.js reads ?tab=)
    const tab = sessionStore.listOpen().find(r => r.kind === 'agent' && r.url === event.sessionId);
    notifier.send({
        title: `${session ? session.agentLabel : 'Agente'} aguardando permissão`,
        body: event.data.title || 'Aprovar ação',
        tag: `agent-permission-${event.sessionId}`,
        url: tab ? `${BASE_PATH}/?tab=${encodeURIComponent(tab.id)}` : `${BASE_PATH}/`,
    }).catch(e => debugLog('Push (agent permission):', e.message));
});

app.get(BASE_PATH + '/api/push', (req, res) => {
    res.json({ publicKey: notifier.publicKey, devices: notifier.subscriptions().length });
});

app.post(BASE_PATH + '/api/push/subscribe', (req, res) => {
    try {
        const devices = notifier.subscribe((req.body || {}).subscription, req.get('user-agent'));
        res.json({ success: true, devices });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.post(BASE_PATH + '/api/push/unsubscribe', (req, res) => {
    notifier.unsubscribe(String((req.body || {}).endpoint || ''));
    res.json({ success: true, devices: notifier.subscriptions().length });
});

app.post(BASE_PATH + '/api/push/test', async (req, res) => {
    const result = await notifier.send({ title: 'MeuTerminal', body: 'Notificações funcionando neste aparelho.', url: BASE_PATH + '/' });
    res.json(result);
});

// ---------- Quick commands (managed in Settings, used from the shortcut bar) ----------
const commands = new CommandStore(sessionStore.db);

app.get(BASE_PATH + '/api/commands', (req, res) => {
    res.json(commands.list());
});

app.post(BASE_PATH + '/api/commands', (req, res) => {
    const created = commands.create(req.body || {});
    if (!created) return res.status(400).json({ error: 'Informe o comando.' });
    res.status(201).json(created);
});

app.patch(BASE_PATH + '/api/commands/:id', (req, res) => {
    const updated = commands.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Command not found or empty' });
    res.json(updated);
});

app.delete(BASE_PATH + '/api/commands/:id', (req, res) => {
    if (!commands.remove(req.params.id)) return res.status(404).json({ error: 'Command not found' });
    res.json({ success: true });
});

// ---------- Backup (periodic snapshot of the database + configured folders, sent via rclone) ----------
const backupStore = new BackupStore(sessionStore.db);
const backupRunner = new BackupRunner({ store: backupStore, db: sessionStore.db, log: debugLog });
backupRunner.start();

app.get(BASE_PATH + '/api/backup', (req, res) => {
    res.json({ ...backupStore.get(), running: backupRunner.running });
});

app.put(BASE_PATH + '/api/backup', (req, res) => {
    res.json(backupStore.update(req.body || {}));
});

app.post(BASE_PATH + '/api/backup/run', async (req, res) => {
    try {
        res.json(await backupRunner.run('manual'));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get(BASE_PATH + '/api/backup/history', (req, res) => {
    res.json(backupStore.history(Number(req.query.limit) || 20));
});

// ---------- Notes (the notes tab; every device reads and writes the same notes) ----------
const NOTES_DIR = NotesStore.resolveNotesDir({ dbPath: DB_PATH, home: os.homedir() });
const notes = new NotesStore(NOTES_DIR);
const notesFiles = new NotesAttachments(NOTES_DIR);
// One-time import from the old SQLite-backed notes (pre file-storage): see migrateFromSqlite()'s
// own comment for why this is safe to call on every boot.
const notesMigrated = NotesStore.migrateFromSqlite(sessionStore.db, notes);
if (notesMigrated) debugLog(`Migradas ${notesMigrated} anotações do SQLite antigo para arquivos .md em ${NOTES_DIR}`);

const notesRoute = handler => (req, res) => {
    if (!NOTES_ENABLED) return res.status(404).json({ error: 'Anotações desligadas.' });
    return handler(req, res);
};
// Tell the other devices (their notes tabs listen on the workspace socket) that something changed.
const notesChanged = id => sessions.broadcast({ type: 'notes', id });

app.get(BASE_PATH + '/api/notes', notesRoute((req, res) => {
    const trash = req.query.trash === '1';
    res.json({
        notes: notes.list({ q: req.query.q, tag: req.query.tag, trash }),
        tags: notes.tags(),
        trashCount: notes.trashCount(),
    });
}));

app.post(BASE_PATH + '/api/notes', notesRoute((req, res) => {
    const created = notes.create(req.body || {});
    notesChanged(created.id);
    res.status(201).json(created);
}));

// Must come before /api/notes/:id so "trash" is not read as an id
app.delete(BASE_PATH + '/api/notes/trash', notesRoute((req, res) => {
    const ids = notes.list({ trash: true }).map(n => n.id);
    const removed = notes.emptyTrash();
    ids.forEach(id => notesFiles.removeAll(id));
    if (removed) notesChanged(null);
    res.json({ success: true, removed });
}));

// Upload: the request body is the file itself (no multipart), streamed to disk - same convention as /api/files/upload
app.post(BASE_PATH + '/api/notes/:id/attachments', notesRoute(async (req, res) => {
    if (!notes.get(req.params.id)) return res.status(404).json({ error: 'Anotação não encontrada.' });
    try {
        const { name } = await notesFiles.save(req, req.params.id, String(one(req.query.name) || 'arquivo'));
        res.status(201).json({ name, url: `${BASE_PATH}/api/notes/${encodeURIComponent(req.params.id)}/attachments/${encodeURIComponent(name)}` });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
}));

// Raw attachment (an <img src>, a download link...)
app.get(BASE_PATH + '/api/notes/:id/attachments/:name', notesRoute((req, res) => {
    const file = notesFiles.resolve(req.params.id, req.params.name);
    if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' });
    res.setHeader('Content-Type', notesFiles.mimeFor(req.params.name));
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
}));

app.get(BASE_PATH + '/api/notes/:id', notesRoute((req, res) => {
    const note = notes.get(req.params.id);
    if (!note) return res.status(404).json({ error: 'Anotação não encontrada.' });
    res.json(note);
}));

app.patch(BASE_PATH + '/api/notes/:id', notesRoute((req, res) => {
    const { baseUpdatedAt, ...patch } = req.body || {};
    const base = Number.isFinite(baseUpdatedAt) ? baseUpdatedAt : undefined;
    const result = notes.update(req.params.id, patch, base);
    if (!result) return res.status(404).json({ error: 'Anotação não encontrada.' });
    if (result.conflict) {
        return res.status(409).json({ error: 'Esta anotação foi alterada em outro aparelho.', note: result.note });
    }
    notesChanged(req.params.id);
    res.json(result.note);
}));

app.post(BASE_PATH + '/api/notes/:id/restore', notesRoute((req, res) => {
    if (!notes.restore(req.params.id)) return res.status(404).json({ error: 'Anotação não está na lixeira.' });
    notesChanged(req.params.id);
    res.json(notes.get(req.params.id));
}));

// Live note -> trash; note already in the trash -> deleted for good
app.delete(BASE_PATH + '/api/notes/:id', notesRoute((req, res) => {
    const id = req.params.id;
    if (!notes.trash(id)) {
        if (!notes.purge(id)) return res.status(404).json({ error: 'Anotação não encontrada.' });
        notesFiles.removeAll(id);
    }
    notesChanged(id);
    res.json({ success: true });
}));

// ---------- Webhooks (internal CRUD + manual run; the public /hooks/:slug route is phase 4-5) ----------
const webhooks = new WebhookStore(sessionStore.db);
const webhookRunner = new WebhookRunner({ store: webhooks, log: debugLog });

const webhooksRoute = handler => (req, res) => {
    if (!WEBHOOKS_ENABLED) return res.status(404).json({ error: 'Webhooks desligados.' });
    return handler(req, res);
};

app.get(BASE_PATH + '/api/webhooks/presets', webhooksRoute((req, res) => {
    res.json(webhookPresets.list());
}));

app.get(BASE_PATH + '/api/webhooks', webhooksRoute((req, res) => {
    res.json(webhooks.list());
}));

app.post(BASE_PATH + '/api/webhooks', webhooksRoute((req, res) => {
    if (!requireReauth(req, res)) return;
    let body = req.body || {};
    if (body.preset) {
        const p = webhookPresets.get(body.preset);
        if (p) body = { name: p.label, script: p.script, inputs: p.inputs, ...body };
    }
    const r = webhooks.create(body);
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.status(201).json(r.webhook);
}));

app.get(BASE_PATH + '/api/webhooks/:id', webhooksRoute((req, res) => {
    const wh = webhooks.get(req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook não encontrado.' });
    res.json(wh);
}));

app.put(BASE_PATH + '/api/webhooks/:id', webhooksRoute((req, res) => {
    // Only editing the script/inputs needs the step-up check (section 3.6.2) - toggling
    // enabled, renaming, changing the timeout etc. doesn't touch what the webhook runs.
    const touchesScript = req.body?.script !== undefined || req.body?.inputs !== undefined;
    if (touchesScript && !requireReauth(req, res)) return;
    const r = webhooks.update(req.params.id, req.body || {});
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json(r.webhook);
}));

app.delete(BASE_PATH + '/api/webhooks/:id', webhooksRoute((req, res) => {
    if (!webhooks.remove(req.params.id)) return res.status(404).json({ error: 'Webhook não encontrado.' });
    res.json({ success: true });
}));

app.post(BASE_PATH + '/api/webhooks/:id/duplicate', webhooksRoute((req, res) => {
    const r = webhooks.duplicate(req.params.id);
    if (!r) return res.status(404).json({ error: 'Webhook não encontrado.' });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.status(201).json(r.webhook);
}));

app.post(BASE_PATH + '/api/webhooks/:id/preview', webhooksRoute((req, res) => {
    const wh = webhooks.get(req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook não encontrado.' });
    const result = resolveInputs(wh.inputs, { manual: req.body?.values || {} });
    if (!result.ok) return res.status(400).json({ error: result.error, input: result.input });
    const secretResult = webhooks.resolveSecrets(wh.id, wh.inputs, result.values);
    if (!secretResult.ok) return res.status(400).json({ error: secretResult.error, input: secretResult.input });
    res.json({ script: wh.script, cwd: wh.cwd, env: { ...result.values, MT_WEBHOOK_ID: wh.id, MT_TRIGGER: 'manual' } });
}));

app.post(BASE_PATH + '/api/webhooks/:id/run', webhooksRoute(async (req, res) => {
    const wh = webhooks.get(req.params.id);
    if (!wh) return res.status(404).json({ error: 'Webhook não encontrado.' });
    const result = resolveInputs(wh.inputs, { manual: req.body?.values || {} });
    if (!result.ok) return res.status(400).json({ error: result.error, input: result.input });
    const secretResult = webhooks.resolveSecrets(wh.id, wh.inputs, result.values);
    if (!secretResult.ok) return res.status(400).json({ error: secretResult.error, input: secretResult.input });
    const secretValues = wh.inputs.filter(i => i.type === 'secret').map(i => result.values[i.name]).filter(Boolean);
    try {
        res.json(await webhookRunner.run(wh, { trigger: 'manual', values: result.values, secretValues }));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
}));

app.get(BASE_PATH + '/api/webhooks/:id/runs', webhooksRoute((req, res) => {
    res.json(webhooks.runs(req.params.id, Number(req.query.limit) || 20));
}));

app.get(BASE_PATH + '/api/webhooks/:id/runs/:run', webhooksRoute((req, res) => {
    const run = webhooks.getRun(req.params.id, req.params.run);
    if (!run) return res.status(404).json({ error: 'Execução não encontrada.' });
    res.json(run);
}));

app.post(BASE_PATH + '/api/webhooks/:id/runs/:run/cancel', webhooksRoute((req, res) => {
    res.json({ success: webhookRunner.cancelActive(req.params.id) });
}));

app.get(BASE_PATH + '/api/webhooks/:id/tokens', webhooksRoute((req, res) => {
    if (!requireReauth(req, res)) return;
    if (!webhooks.get(req.params.id)) return res.status(404).json({ error: 'Webhook não encontrado.' });
    res.json(webhooks.listTokens(req.params.id));
}));

app.post(BASE_PATH + '/api/webhooks/:id/tokens', webhooksRoute((req, res) => {
    if (!requireReauth(req, res)) return;
    if (!webhooks.get(req.params.id)) return res.status(404).json({ error: 'Webhook não encontrado.' });
    res.status(201).json(webhooks.createToken(req.params.id, req.body?.name));
}));

app.delete(BASE_PATH + '/api/webhooks/:id/tokens/:tokenId', webhooksRoute((req, res) => {
    if (!webhooks.revokeToken(req.params.id, req.params.tokenId)) return res.status(404).json({ error: 'Token não encontrado.' });
    res.json({ success: true });
}));

app.put(BASE_PATH + '/api/webhooks/:id/hmac', webhooksRoute((req, res) => {
    if (!requireReauth(req, res)) return;
    if (!webhooks.get(req.params.id)) return res.status(404).json({ error: 'Webhook não encontrado.' });
    try {
        webhooks.setHmacSecret(req.params.id, req.body?.secret ? String(req.body.secret).slice(0, 500) : null);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
}));

app.put(BASE_PATH + '/api/webhooks/:id/secrets/:name', webhooksRoute((req, res) => {
    if (!requireReauth(req, res)) return;
    if (!webhooks.get(req.params.id)) return res.status(404).json({ error: 'Webhook não encontrado.' });
    if (!/^[A-Z_][A-Z0-9_]*$/.test(req.params.name)) return res.status(400).json({ error: 'Nome de input inválido.' });
    try {
        webhooks.setSecretInput(req.params.id, req.params.name, String(req.body?.value ?? '').slice(0, 1000));
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
}));

app.get(BASE_PATH + '/api/webhooks/:id/versions', webhooksRoute((req, res) => {
    res.json(webhooks.versions(req.params.id));
}));

// ---------- Webhooks: public trigger route (phases 4-5) ----------
// Bearer token (default) or HMAC signature (opt-in per webhook, section 3.5). Everything here
// answers the same generic 404 for "wrong token" and "webhook doesn't exist" (section 3.7), so a
// failed call can't be used to discover which slugs are registered.
// Separate counters from the login (same shape: 5 failures -> locked for LOCKOUT_TIME)
const webhookLimiter = new AttemptLimiter({ max: 5, lockoutMs: LOCKOUT_TIME });

// HMAC mode replay protection (section 3.5): an X-Request-Id/Idempotency-Key seen in the last
// 24h is treated as a repeat and ignored (still answered 202, so retries by the sender are safe).
const webhookSeenRequestIds = new Map(); // id -> firstSeenAt
const REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Per-webhook rate limit (ratePerMin). Checked and recorded synchronously here, in memory - not
// via webhook_runs/recentRunCount(), because a run is only written to that table once its turn in
// webhookRunner's queue comes up (webhookRunner.enqueue() defers the actual store.createRun() call
// to a microtask), so two requests arriving close together could both read the same stale count
// before either one's run had landed. A plain timestamp array has no such lag.
const webhookRunWindows = new Map(); // webhookId -> timestamps (ms) of triggers in the last 60s
function checkAndRecordRate(webhookId, limit) {
    const windowStart = Date.now() - 60000;
    const arr = (webhookRunWindows.get(webhookId) || []).filter(t => t > windowStart);
    if (arr.length >= limit) {
        webhookRunWindows.set(webhookId, arr);
        return false;
    }
    arr.push(Date.now());
    webhookRunWindows.set(webhookId, arr);
    return true;
}

function tailLines(text, n = 20) {
    return String(text || '').split('\n').slice(-n).join('\n');
}

app.post(BASE_PATH + '/hooks/:slug', async (req, res) => {
    if (!WEBHOOKS_ENABLED) return res.status(404).json({ error: 'nao_encontrado' });
    const ip = req.ip;
    if (webhookLimiter.isLockedOut(ip)) return res.status(429).json({ error: 'limite' });

    const fail = () => { webhookLimiter.record(ip); return res.status(404).json({ error: 'nao_encontrado' }); };

    const wh = webhooks.getBySlug(String(req.params.slug || '').toLowerCase());
    if (!wh || !wh.enabled) return fail();

    if (wh.allowedIps?.length && !wh.allowedIps.includes(ip)) return fail();

    let tokenId = null;
    if (wh.authMode === 'hmac') {
        const secret = webhooks.getHmacSecret(wh.id);
        const sigHeader = req.get('X-Hub-Signature-256') || req.get('X-Signature-256');
        if (!secret || !req.rawBody || !verifyHmacSignature(req.rawBody, sigHeader, secret)) return fail();
        const requestId = req.get('X-Request-Id') || req.get('Idempotency-Key');
        if (requestId) {
            const now = Date.now();
            const seenAt = webhookSeenRequestIds.get(requestId);
            if (seenAt && now - seenAt < REPLAY_WINDOW_MS) return res.status(202).json({ run_id: null, status: 'duplicado' });
            webhookSeenRequestIds.set(requestId, now);
        }
    } else {
        const m = /^Bearer\s+(\S+)$/.exec(req.get('Authorization') || '');
        if (!m) return fail();
        const found = webhooks.findByToken(wh.slug, m[1]);
        if (!found) return fail();
        tokenId = found.tokenId;
    }
    webhookLimiter.reset(ip);

    if (!checkAndRecordRate(wh.id, wh.ratePerMin || 6)) return res.status(429).json({ error: 'limite' });

    const result = resolveInputs(wh.inputs, { body: req.body || {}, query: req.query, headers: req.headers });
    if (!result.ok) return res.status(400).json({ error: 'input_invalido', input: result.input });
    const secretResult = webhooks.resolveSecrets(wh.id, wh.inputs, result.values);
    if (!secretResult.ok) return res.status(500).json({ error: 'webhook_mal_configurado' });
    const secretValues = wh.inputs.filter(i => i.type === 'secret').map(i => result.values[i.name]).filter(Boolean);

    let queued;
    try {
        queued = webhookRunner.enqueue(wh, { trigger: 'http', sourceIp: ip, tokenId, values: result.values, secretValues });
    } catch (e) {
        return res.status(429).json({ error: 'limite' });
    }

    const waitSec = Math.min(Math.max(0, Number(req.query.wait) || 0), 30);
    if (waitSec > 0) {
        const timeout = new Promise(resolve => setTimeout(() => resolve(null), waitSec * 1000));
        const finished = await Promise.race([queued.done, timeout]).catch(() => null);
        if (finished) {
            return res.json({ run_id: queued.runId, status: finished.status, exit_code: finished.exitCode, output: tailLines(finished.output) });
        }
    }
    res.status(202).json({ run_id: queued.runId, status: 'queued' });
});

// Logout endpoint
app.post(BASE_PATH + '/logout', (req, res) => {
    debugLog('Logout request received');
    
    const cookieOptions = {
        httpOnly: true,
        secure: req.secure || (BASE_URL.startsWith('https') && NODE_ENV === 'production'),
        sameSite: 'strict',
        path: BASE_PATH || '/',  // Match the path used when setting cookies
        expires: new Date(0),    // Immediately expire the cookie
        maxAge: 0               // Belt and suspenders - also set maxAge to 0
    };
    
    // Clear all auth cookies with consistent options
    res.clearCookie(`${projectName}_PIN`, cookieOptions);
    res.clearCookie(AUTH_COOKIE, cookieOptions);
    res.clearCookie('connect.sid', cookieOptions);
    
    // Destroy the session and wait for it to be destroyed before sending response
    req.session.destroy((err) => {
        if (err) {
            debugLog('Error destroying session:', err);
            return res.status(500).json({ success: false, error: 'Failed to logout properly' });
        }
        debugLog('Session and cookies cleared successfully');
        res.json({ success: true });
    });
});

// WebSocket server configuration
// ---------- Claude bridge (routes/remote.js) ----------

/** Email + password (+ 2FA) check for the bridge's consent page: same rules as POST /login. */
function verifyLoginCredentials({ email, password, code }) {
    if (AUTH_MODE !== 'email') return { error: 'Login por email desligado.' };
    const emailOk = typeof email === 'string' && safeEqual(email.trim().toLowerCase(), AUTH_EMAIL);
    const passwordOk = typeof password === 'string' && safeEqual(password, AUTH_PASSWORD);
    if (!emailOk || !passwordOk) return { error: 'Email ou senha incorretos.' };
    if (totp) {
        if (typeof code !== 'string' || !code.trim()) return { needCode: true };
        if (!totp.verify(code)) return { needCode: true, error: 'Código inválido ou já usado.' };
    }
    return { ok: true };
}

registerRemote(app, {
    enabled: REMOTE_MCP_ENABLED,
    disabledReason: REMOTE_MCP_DISABLED_REASON,
    basePath: BASE_PATH,
    baseUrl: BASE_URL,
    db: sessionStore.db,
    fingerprint: tokens.fingerprint,
    verifyCredentials: verifyLoginCredentials,
    twoFactor: !!totp,
    requireReauth,
    lockoutMs: LOCKOUT_TIME,
    sessions,
    notes: NOTES_ENABLED ? notes : null,
    notesChanged,
    notifier: () => notifier,
    localTools: REMOTE_MCP_ENABLED ? createMcpTools(mcpDeps) : null,
    browserAvailable: browsers.available,
    prefs: {
        get: key => { const v = sessionStore.getMeta(key); try { return JSON.parse(v); } catch { return v; } },
        set: (key, value) => sessionStore.setMeta(key, JSON.stringify(value)),
    },
    dataDir: path.dirname(DB_PATH),
    publicDir: PUBLIC_DIR,
    version: APP_VERSION,
    env: process.env,
    log: debugLog,
});

const wss = new WebSocketServer({ 
    server,
    verifyClient: (info, callback) => {
        debugLog('Verifying WebSocket connection from:', info.req.headers.origin);
        
        const origin = info.req.headers.origin;
        // Same origin as the app (cross-site WebSocket hijacking) and the configured list
        const isOriginValid = isSameOrigin(info.req) && validateOrigin(origin);
        if (isOriginValid) callback(true); // allow the connection
        else {
            console.warn("Blocked connection from origin:", {origin});
            callback(false, 403, 'Forbidden'); // reject the connection
        }
    }
});

// WebSocket connection handling
wss.on('connection', (ws, req) => {
    debugLog('New WebSocket connection attempt');
    
    // Keep track of connection status
    ws.isAlive = true;
    
    // Setup ping/pong heartbeat
    ws.on('pong', () => {
        ws.isAlive = true;
        debugLog('Received pong from client');
    });

    // Handle connection errors
    ws.on('error', (error) => {
        debugLog('WebSocket error:', error);
        ws.terminate();
    });

    // Optional starting directory requested by the client (?cwd=...)
    const requestedCwd = getRequestedCwd(req);

    // ?session=<id>: attach to a persistent server-side session (current client).
    // Without it: legacy one-shot terminal, kept for pages still cached by old versions.
    const connect = () => {
        const params = new URL(req.url, 'http://localhost').searchParams;
        const sessionId = params.get('session');
        const row = sessionId ? sessionStore.get(sessionId) : null;
        const panel = params.get('panel');
        if (panel) {
            // Painel completo de um complemento (Configurações → Complementos): o Chromium do
            // servidor abre o painel do serviço local já com a sessão feita; não vira aba.
            attachAddonPanel(ws, panel, params).catch(e => {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'status', message: e.message }));
                ws.close(1011, 'Painel indisponível');
            });
            return;
        }
        if (row && row.status === 'open' && row.kind === 'browser') {
            debugLog('Attaching to browser tab', sessionId);
            // Also receives "tab list changed" notices, like terminal tabs
            sessions.sockets.add(ws);
            ws.on('close', () => sessions.sockets.delete(ws));
            browsers.attach(ws, row, {
                width: params.get('width'),
                height: params.get('height'),
                dpr: params.get('dpr'),
                mobile: params.get('mobile') === '1',
                quality: params.get('quality'),
                visible: params.get('visible') !== '0',
            });
        } else if (row && row.status === 'open' && row.kind === 'agent') {
            attachAgentTab(ws, row, Math.max(0, Number(params.get('since')) || 0));
        } else if (row && row.status === 'open' && (row.kind === 'files' || row.kind === 'notes')) {
            // File and notes tabs use HTTP; the socket only carries notices (MCP open-tab, notes changed...)
            sessions.sockets.add(ws);
            ws.on('close', () => sessions.sockets.delete(ws));
            ws.send(JSON.stringify({ type: 'ready' }));
        } else if (sessionId) {
            debugLog('Attaching to session', sessionId);
            sessions.attach(ws, sessionId, { cols: params.get('cols'), rows: params.get('rows') });
        } else {
            createTerminal(ws, requestedCwd);
        }
    };

    // No login configured: allow the connection
    if (!isAuthRequired) {
        debugLog('No login required, connecting');
        connect();
        return;
    }

    if (!req.headers.cookie) {
        debugLog('No cookies found, closing connection');
        ws.close(1008, 'Authentication required'); // Use 1008 for policy violation
        return;
    }

    // Parse the cookies (split on the first "=" only: values may contain "=")
    const parsedCookies = {};
    req.headers.cookie.split(';').forEach(cookie => {
        const index = cookie.indexOf('=');
        if (index === -1) return;
        const name = cookie.slice(0, index).trim();
        try {
            parsedCookies[name] = decodeURIComponent(cookie.slice(index + 1).trim());
        } catch {
            parsedCookies[name] = cookie.slice(index + 1).trim();
        }
    });

    // Check the auth cookie for the active mode (signed token or PIN)
    if (!hasValidAuthCookie(parsedCookies)) {
        debugLog('Invalid auth cookie, closing connection');
        ws.close(1008, 'Authentication required'); // Use 1008 for policy violation
        return;
    }

    debugLog('Authentication successful, connecting');
    connect();
});

/** Spawns a shell process (real PTY, or the simulated one in demo mode). */
function spawnShell({ id, cwd, cols = 80, rows = 24 }) {
    return ptyModule.spawn(SHELL, agentRcFile && !DEMO_MODE ? ['--rcfile', agentRcFile] : [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: DEMO_MODE ? '/home/demo' : cwd,
        // The app's own secrets (login, webhook key...) never reach the shell: scripts/child-env.js
        env: childEnv({
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: 'en_US.UTF-8',
            // Force buffer flushing for better alternate buffer handling
            STDBUF: 'L',
            // Ensure proper handling of alternate buffer in applications
            TERM_PROGRAM: 'xterm-256color',
            // Rota padrão do terminal (Configurações → Complementos): Headroom ou OmniRoute
            ...terminalRouteEnv(),
            // Agents in this shell can call MeuTerminal's MCP (open_url, screenshot...)
            MEUTERMINAL_MCP_URL: MCP_URL,
            MEUTERMINAL_MCP_TOKEN: MCP_TOKEN,
            // Which tab this shell is (agents pass it to the MCP to open things beside it)
            ...(id ? { MEUTERMINAL_TAB_ID: id } : {}),
            // Agent UI: shims first on PATH + where they ask "usar o modo UI?" (scripts/agents/)
            ...(AGENT_UI_ENABLED ? {
                PATH: `${AGENT_SHIM_DIR}${path.delimiter}${process.env.PATH || ''}`,
                MEUTERMINAL_API_URL: `http://127.0.0.1:${PORT}${BASE_PATH}/api`,
            } : {})
        })
    });
}

/** Static facts about a shell, shown in the status bar. */
function shellInfo(pty, cwd) {
    return {
        shell: DEMO_MODE ? 'demo' : path.basename(SHELL).replace(/\.exe$/i, ''),
        pid: pty.pid,
        cwd: DEMO_MODE ? '/home/demo' : cwd,
        home: HOME_DIR,
        platform: DEMO_MODE ? 'demo' : os.platform()
    };
}

/**
 * Reads the optional ?cwd= query parameter from the WebSocket upgrade request.
 * The client is already authenticated and gets a full shell, so this grants no
 * extra access - it only saves the user a `cd`. Invalid paths fall back to HOME.
 */
function getRequestedCwd(req) {
    try {
        const url = new URL(req.url, 'http://localhost');
        const cwd = url.searchParams.get('cwd');
        if (!cwd || cwd.length > 4096) return null;
        const resolved = path.resolve(cwd.replace(/^~(?=$|\/)/, os.homedir()));
        return fs.statSync(resolved).isDirectory() ? resolved : null;
    } catch {
        return null;
    }
}

/**
 * Best-effort lookup of the shell's current directory and foreground process.
 * Only possible on Linux (via /proc) - elsewhere returns nulls so the UI can
 * simply hide the information instead of showing something wrong.
 */
function getProcessInfo(term) {
    if (DEMO_MODE) {
        return { cwd: term.currentDirectory || null, process: null };
    }
    if (os.platform() !== 'linux') {
        return { cwd: null, process: null };
    }
    const info = { cwd: null, process: null };
    try {
        info.cwd = fs.readlinkSync(`/proc/${term.pid}/cwd`);
    } catch { /* process may have exited */ }
    try {
        // Field 8 of /proc/<pid>/stat is the foreground process group of the tty.
        // The command name can contain spaces, so split after the last ')'.
        const stat = fs.readFileSync(`/proc/${term.pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const tpgid = parseInt(fields[5], 10);
        if (tpgid > 0 && tpgid !== term.pid) {
            info.process = fs.readFileSync(`/proc/${tpgid}/comm`, 'utf8').trim();
        }
    } catch { /* not critical */ }
    info.branch = info.cwd ? getGitBranch(info.cwd) : null;
    return info;
}

/**
 * Finds the git branch for a directory by reading .git/HEAD walking up the tree.
 * Plain file reads - no git binary needed, cheap enough to run after each command.
 */
function getGitBranch(dir) {
    let current = dir;
    for (let i = 0; i < 40; i++) {
        const gitPath = path.join(current, '.git');
        try {
            let gitDir = gitPath;
            if (fs.statSync(gitPath).isFile()) {
                // worktrees/submodules: ".git" is a file pointing at the real git dir
                const match = fs.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m);
                if (!match) return null;
                gitDir = path.resolve(current, match[1].trim());
            }
            const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
            const ref = head.match(/^ref: refs\/heads\/(.+)$/);
            return ref ? ref[1] : head.slice(0, 7); // detached HEAD -> short sha
        } catch { /* no .git here, keep walking up */ }
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
    return null;
}

// Heartbeat check interval with more frequent checks
const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            debugLog('Terminating inactive WebSocket connection');
            return ws.terminate();
        }
        ws.isAlive = false;
        try {
            ws.ping();
        } catch (err) {
            debugLog('Error sending ping:', err);
            ws.terminate();
        }
    });
}, 15000); // Check every 15 seconds

// Graceful shutdown: save every session's screen so tabs come back after a deploy
function shutdown() {
    clearInterval(heartbeatInterval);
    try {
        sessions.persistAll();
    } catch (e) {
        console.error('Failed to save sessions on shutdown:', e);
    }
    browsers.shutdown();
    live.shutdown();
    addonServices.shutdown();
    wss.close();
    // Give agent processes a moment to exit cleanly (they are resumable after the restart)
    Promise.race([agentGateway.shutdown(), new Promise(resolve => setTimeout(resolve, 2000))])
        .finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Legacy one-shot terminal (no ?session=): killed when its socket closes, as before
function createTerminal(ws, requestedCwd = null) {
    const cwd = DEMO_MODE ? '/home/demo' : (requestedCwd || HOME_DIR);
    const term = spawnShell({ cwd });

    debugLog(`Terminal created with PID: ${term.pid}${DEMO_MODE ? ' (Demo Mode)' : ''}`);

    // Tell the client which shell it got (shown in the status bar)
    ws.send(JSON.stringify({ type: 'info', ...shellInfo(term, cwd) }));

    // Handle incoming data from client
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            switch(message.type) {
                case 'input':
                    term.write(message.data);
                    break;
                case 'resize':
                    term.resize(message.cols, message.rows);
                    break;
                case 'process-info':
                    ws.send(JSON.stringify({ type: 'process-info', ...getProcessInfo(term) }));
                    break;
            }
        } catch (error) {
            debugLog('Error processing WebSocket message:', error);
        }
    });

    // Handle terminal data with control sequence filtering
    term.on('data', (data) => {
        if (ws.readyState === ws.OPEN) {
            // Raw send without any filtering - let the client handle buffer switches
            ws.send(JSON.stringify({ 
                type: 'output',
                data: data
            }));
        }
    });

    // Clean up on close
    ws.on('close', () => {
        debugLog('WebSocket closed, killing terminal process:', term.pid);
        term.kill();
    });

    // Handle terminal exit
    term.on('exit', (code) => {
        debugLog('Terminal process exited with code:', code);
        if (ws.readyState === ws.OPEN) {
            ws.close();
        }
    });
}

// Cleanup old lockouts periodically
setInterval(() => {
    const now = Date.now();
    loginLimiter.sweep();
    webhookLimiter.sweep();
    for (const [id, seenAt] of webhookSeenRequestIds.entries()) {
        if (now - seenAt >= REPLAY_WINDOW_MS) {
            webhookSeenRequestIds.delete(id);
        }
    }
    for (const [webhookId, timestamps] of webhookRunWindows.entries()) {
        const fresh = timestamps.filter(t => now - t < 60000);
        if (fresh.length) webhookRunWindows.set(webhookId, fresh);
        else webhookRunWindows.delete(webhookId);
    }
}, 60000); // Clean up every minute

// Update server.listen to use the http server
server.listen(PORT, () => {
    debugLog('Server Configuration:', {
        port: PORT,
        basePath: BASE_PATH,
        authMode: AUTH_MODE,
        nodeEnv: NODE_ENV,
        debug: DEBUG,
        demoMode: DEMO_MODE,
        version: APP_VERSION,
        cacheName: CACHE_NAME
    });
    console.log(`Server running on: ${BASE_URL}`);
    // Em segundo plano: a primeira instalação baixa os plugins e não deve atrasar o app
    if (!DEMO_MODE) {
        addons.bootstrap().catch(e => console.error('Complementos:', e.message));
        addonServices.apply(addons.prefs()).catch(e => console.error('Complementos:', e.message));
    }
});