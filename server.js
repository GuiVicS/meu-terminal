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
const { generatePWAManifest } = require("./scripts/pwa-manifest-generator");
const { originValidationMiddleware, getCorsOptions, validateOrigin } = require('./scripts/cors');
const { TotpVerifier } = require('./scripts/totp');
const SessionStore = require('./scripts/session-store');
const SessionManager = require('./scripts/session-manager');
const CommandStore = require('./scripts/command-store');
const { BrowserManager, listPorts, normalizeUrl } = require('./scripts/browser-manager');
const { createMcpHandler, mcpToken } = require('./scripts/mcp-server');

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
const CACHE_NAME = `DUMBTERM_CACHE_V${APP_VERSION}`;
// SQLite file with the sessions (tabs). Mount its folder as a volume to keep it across deploys.
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'meuterminal.db');
const SHELL = process.env.SHELL || (os.platform() === 'win32' ? 'powershell.exe' : 'bash');
const HOME_DIR = DEMO_MODE ? '/home/demo' : (process.env.HOME || os.homedir());

generatePWAManifest(SITE_TITLE);

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

// Log which protection is enabled
if (isEmailAuth) {
    debugLog('Email/password login is enabled for:', AUTH_EMAIL, totp ? '(with 2FA)' : '');
} else if (isPinRequired) {
    debugLog('PIN protection is enabled, PIN length:', PIN.length);
} else {
    debugLog('Authentication is disabled');
}

// ---- Email login tokens ----
// The cookie never contains the password: it holds an expiry and an HMAC signature.
// The key is derived from the credentials (and the 2FA secret), so changing the
// password or turning 2FA on/off in .env logs everyone out; a restart does not.
const TOKEN_KEY = crypto.createHash('sha256')
    .update(`meu-terminal-auth\0${AUTH_EMAIL}\0${AUTH_PASSWORD}\0${totp ? TOTP_SECRET : ''}`)
    .digest();

function signToken(expiresAt) {
    return crypto.createHmac('sha256', TOKEN_KEY).update(`${AUTH_EMAIL}|${expiresAt}`).digest('base64url');
}

function createAuthToken() {
    const expiresAt = Date.now() + MAX_SESSION_AGE;
    return `${expiresAt}.${signToken(expiresAt)}`;
}

function verifyAuthToken(token) {
    if (!isEmailAuth || !token || typeof token !== 'string') return false;
    const [expiresAt, signature] = token.split('.');
    if (!expiresAt || !signature || !/^\d+$/.test(expiresAt)) return false;
    if (Number(expiresAt) < Date.now()) return false;
    return safeEqual(signature, signToken(expiresAt));
}

// Constant-time comparison for strings of any length (hashes first)
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** True if the request/handshake carries valid credentials for the active auth mode. */
function hasValidAuthCookie(cookies) {
    if (AUTH_MODE === 'email') return verifyAuthToken(cookies[AUTH_COOKIE]);
    if (AUTH_MODE === 'pin') return verifyPin(PIN, cookies[`${projectName}_PIN`]);
    return true;
}

// Brute force protection
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_TIME = (process.env.LOCKOUT_TIME || 15) * 60 * 1000; // default 15 minutes in milliseconds
const MAX_SESSION_AGE = (process.env.MAX_SESSION_AGE || 24) * 60 * 60 * 1000; // default 24 hours

function resetAttempts(ip) {
    debugLog('Resetting login attempts for IP:', ip);
    loginAttempts.delete(ip);
}

function isLockedOut(ip) {
    const attempts = loginAttempts.get(ip);
    if (!attempts) return false;
    
    if (attempts.count >= MAX_ATTEMPTS) {
        const timeElapsed = Date.now() - attempts.lastAttempt;
        if (timeElapsed < LOCKOUT_TIME) {
            debugLog('IP is locked out:', ip, 'Time remaining:', Math.ceil((LOCKOUT_TIME - timeElapsed) / 1000 / 60), 'minutes');
            return true;
        }
        resetAttempts(ip);
    }
    return false;
}

function recordAttempt(ip) {
    const attempts = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
    attempts.count += 1;
    attempts.lastAttempt = Date.now();
    loginAttempts.set(ip, attempts);
    debugLog('Login attempt recorded for IP:', ip, 'Count:', attempts.count);
}

// Security middleware
app.set('trust proxy', 1);
app.use(cors(getCorsOptions(BASE_URL)));
app.use(express.json());
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

const requirePin = (req, res, next) => {
    if (!PIN || !isValidPin(PIN)) {
        return next();
    }

    const authCookie = req.cookies[COOKIE_NAME];
    if (!authCookie || !secureCompare(authCookie, PIN)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// Constant-time PIN comparison to prevent timing attacks
const verifyPin = (storedPin, providedPin) => {
    if (!storedPin || !providedPin) return false;
    if (storedPin.length !== providedPin.length) return false;
    
    try {
        return crypto.timingSafeEqual(
            Buffer.from(storedPin),
            Buffer.from(providedPin)
        );
    } catch {
        return false;
    }
}

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

// Global middleware for origin validation and authentication
app.use(BASE_PATH, (req, res, next) => {
    // List of paths that should be publicly accessible
    const publicPaths = [
        '/login',
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
        // The browser fetches the worker script on its own to check for updates; if that
        // hits the login redirect the update fails silently and the PWA stays on old code.
        '/service-worker.js',
        // Agents' MCP endpoint: has its own check (local only + bearer token)
        '/mcp',
    ];

    // Check if the current path matches any of the public paths
    if (publicPaths.some(path => req.path.startsWith(path))) {
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
        version: APP_VERSION,
        cacheName: CACHE_NAME
    }

    res.type('application/javascript').send(`
        window.appConfig = ${JSON.stringify(appConfig)};
    `);
});

// Serve static files for public assets
app.use(BASE_PATH + '/', express.static(path.join(PUBLIC_DIR)));
app.get(BASE_PATH + "/manifest.json", (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, "manifest.json"));
});
app.get(BASE_PATH + "/asset-manifest.json", (req, res) => {
    res.sendFile(path.join(ASSETS_DIR, "asset-manifest.json"));
});
// Serve font files
app.use('/fonts', express.static(path.join(PUBLIC_DIR, 'fonts')));
app.use('/node_modules/@xterm/', express.static(
    path.join(__dirname, 'node_modules/@xterm/')
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
    if (isLockedOut(ip)) {
        const attempts = loginAttempts.get(ip);
        const timeLeft = Math.ceil((LOCKOUT_TIME - (Date.now() - attempts.lastAttempt)) / 1000 / 60);
        return res.status(429).json({
            error: `Muitas tentativas. Tente novamente em ${timeLeft} minuto(s).`
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
                recordAttempt(ip);
                const left = Math.max(0, MAX_ATTEMPTS - loginAttempts.get(ip).count);
                return res.status(401).json({ needCode: true, error: 'Código inválido ou já usado.', attemptsLeft: left });
            }
        }
        if (emailOk && passwordOk) {
            debugLog('Email login successful');
            resetAttempts(ip);
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
        recordAttempt(ip);
        const attemptsLeft = Math.max(0, MAX_ATTEMPTS - loginAttempts.get(ip).count);
        res.status(401).json({ error: 'Email ou senha incorretos.', attemptsLeft });
    }, crypto.randomInt(50, 150));
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
    if (isLockedOut(ip)) {
        const attempts = loginAttempts.get(ip);
        const timeLeft = Math.ceil((LOCKOUT_TIME - (Date.now() - attempts.lastAttempt)) / 1000 / 60);
        debugLog('PIN verification blocked - IP is locked out:', ip);
        return res.status(429).json({ 
            error: `Too many attempts. Please try again in ${timeLeft} minutes.`
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
        resetAttempts(ip);
        
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
        recordAttempt(ip);
        
        const attempts = loginAttempts.get(ip);
        const attemptsLeft = MAX_ATTEMPTS - attempts.count;
        
        // Add artificial delay before sending error response
        setTimeout(() => {
            res.status(401).json({ 
                error: 'Invalid PIN',
                attemptsLeft: Math.max(0, attemptsLeft)
            });
        }, crypto.randomInt(50, 150));
    }
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

app.get(BASE_PATH + '/api/sessions', (req, res) => {
    res.json(sessions.list());
});

app.post(BASE_PATH + '/api/sessions', (req, res) => {
    const { name, cwd, color, afterId, reopenId, kind, url } = req.body || {};
    if (kind === 'browser' && !browsers.available) {
        return res.status(503).json({ error: 'Chromium não está instalado no servidor.' });
    }
    // "localhost:5173" -> "http://localhost:5173" (same rules as the address bar)
    const pageUrl = kind === 'browser' && url ? normalizeUrl(url) : url;
    res.status(201).json(sessions.create({ name, cwd, color, afterId, reopenId, kind, url: pageUrl }));
});

// Ports listening on the server ("localhost:5173 detectado" in the new tab page)
app.get(BASE_PATH + '/api/ports', async (req, res) => {
    res.json(await listPorts([Number(PORT)]));
});

// ---------- MCP server for agents running inside the terminals ----------
// Every shell gets MEUTERMINAL_MCP_URL / MEUTERMINAL_MCP_TOKEN (see spawnShell).
const MCP_TOKEN = mcpToken(sessionStore);
const MCP_URL = `http://127.0.0.1:${PORT}${BASE_PATH}/mcp`;
const mcpHandler = createMcpHandler({
    sessions, store: sessionStore, browsers, listPorts, normalizeUrl, port: Number(PORT),
});

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

// Declared before "/:id" so "order" isn't taken for an id
app.put(BASE_PATH + '/api/sessions/order', (req, res) => {
    sessions.setOrder((req.body || {}).ids);
    res.json({ success: true });
});

app.patch(BASE_PATH + '/api/sessions/:id', (req, res) => {
    const updated = sessions.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Session not found' });
    res.json(updated);
});

// Closing a tab: the only action that kills its shell (or closes its browser page)
app.delete(BASE_PATH + '/api/sessions/:id', (req, res) => {
    const row = sessionStore.get(req.params.id);
    if (row && row.kind === 'browser') browsers.closePage(row.id);
    if (!sessions.close(req.params.id)) return res.status(404).json({ error: 'Session not found' });
    res.json({ success: true });
});

// Removes a closed session from "recent"
app.delete(BASE_PATH + '/api/recent/:id', (req, res) => {
    sessions.forget(req.params.id);
    res.json({ success: true });
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
const wss = new WebSocketServer({ 
    server,
    verifyClient: (info, callback) => {
        debugLog('Verifying WebSocket connection from:', info.req.headers.origin);
        
        const origin = info.req.headers.origin;
        const isOriginValid = validateOrigin(origin);
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
function spawnShell({ cwd, cols = 80, rows = 24 }) {
    return ptyModule.spawn(SHELL, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: DEMO_MODE ? '/home/demo' : cwd,
        env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: 'en_US.UTF-8',
            // Force buffer flushing for better alternate buffer handling
            STDBUF: 'L',
            // Ensure proper handling of alternate buffer in applications
            TERM_PROGRAM: 'xterm-256color',
            // Agents in this shell can call MeuTerminal's MCP (open_url, screenshot...)
            MEUTERMINAL_MCP_URL: MCP_URL,
            MEUTERMINAL_MCP_TOKEN: MCP_TOKEN
        }
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
    wss.close();
    process.exit(0);
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
    for (const [ip, attempts] of loginAttempts.entries()) {
        if (now - attempts.lastAttempt >= LOCKOUT_TIME) {
            loginAttempts.delete(ip);
        }
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
});