// Mede o custo de usar o app num celular simulado (CPU 4x mais lenta): abrir, trocar aba, rolar a conversa, abrir a lista.
// Uso manual, comparando duas versões alternadas na mesma máquina (o tempo absoluto varia muito com a carga):
//   BASE=http://... AUTH_EMAIL=... AUTH_PASSWORD=... AUTH_TOTP_SECRET=... PUPPETEER_PATH=... node scripts/perf/measure.js
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');
const { codeAt, currentStep, base32Decode } = require('../totp');
const BASE = process.env.BASE; const sleep = ms => new Promise(r => setTimeout(r, ms));
const VISUAL = process.env.VISUAL || 'glass';
(async () => {
    const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-gpu-rasterization'] });
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.goto(BASE + '/login', { waitUntil: 'networkidle2' });
    await p.waitForSelector('#emailForm:not([hidden])');
    await p.type('#emailForm [name=email]', process.env.AUTH_EMAIL); await p.type('#emailForm [name=password]', process.env.AUTH_PASSWORD);
    await p.click('#emailForm [type=submit]'); await p.waitForSelector('#emailForm [data-step=code]:not([hidden])');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle2' }), p.type('#emailForm [name=code]', codeAt(base32Decode(process.env.AUTH_TOTP_SECRET), currentStep()))]);
    const api = (m, u, b) => p.evaluate(async (m, u, b) => (await fetch(u, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json(), m, u, b);
    // estado: terminal, notas e uma conversa longa do agente
    let tabs = (await api('GET', '/api/sessions')).sessions;
    if (!tabs.some(t => t.kind === 'agent')) {
        await api('POST', '/api/sessions', { name: 'shell', kind: 'terminal' });
        await api('POST', '/api/sessions', { kind: 'notes' });
        const a = await api('POST', '/api/agent-sessions', { agent: 'claude', cwd: '/root' });
        await sleep(2500);
        for (let i = 0; i < 12; i++) { await api('POST', `/api/agent-sessions/${a.session.id}/prompt`, { text: `markdown ${i}` }); await sleep(1800); }
        tabs = (await api('GET', '/api/sessions')).sessions;
    }
    const agentTab = tabs.find(t => t.kind === 'agent').id;
    const termTab = tabs.find(t => t.kind === 'terminal').id;
    await p.close();

    const ph = await ctx.newPage();
    await ph.emulate(puppeteer.KnownDevices['iPhone 15 Pro']);
    await ph.evaluateOnNewDocument(v => {
        try { const k = 'meuterminal-settings'; const s = JSON.parse(localStorage.getItem(k) || '{}'); s.iphoneVisual = v; localStorage.setItem(k, JSON.stringify(s)); } catch {}
        window.__lt = 0; window.__ltn = 0;
        new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__lt += e.duration; window.__ltn++; } }).observe({ type: 'longtask', buffered: true });
    }, VISUAL);
    const cdp = await ph.createCDPSession();
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));

    const t0 = Date.now();
    await ph.goto(`${BASE}/?tab=${agentTab}`, { waitUntil: 'load' });
    await ph.waitForFunction(() => document.querySelectorAll('.ag-log .ag-msg, .ag-log > *').length > 5, { timeout: 60000 });
    const loadMs = Date.now() - t0;
    await sleep(1500);
    const m1 = await metrics();
    const visual = await ph.evaluate(() => document.documentElement.getAttribute('data-visual') || document.documentElement.className.slice(0, 80));
    const lt1 = await ph.evaluate(() => [Math.round(window.__lt), window.__ltn]);

    // troca de aba: tempo até o próximo quadro com a aba visível
    const switchTimes = [];
    for (let i = 0; i < 6; i++) {
        const id = i % 2 ? agentTab : termTab;
        const ms = await ph.evaluate(id => new Promise(res => {
            const t = performance.now();
            const ws = window.__workspace || null;
            const btn = document.querySelector(`[data-session-id="${id}"], [data-id="${id}"]`);
            if (window.mtWorkspace) window.mtWorkspace.activate(id); else if (btn) btn.click(); else history.replaceState(null, '', `?tab=${id}`);
            requestAnimationFrame(() => requestAnimationFrame(() => res(performance.now() - t)));
        }), id);
        switchTimes.push(Math.round(ms));
        await sleep(400);
    }

    // rolagem da conversa: quadros por segundo
    const scroll = await ph.evaluate(() => new Promise(res => {
        const log = document.querySelector('.ag-log');
        if (!log) return res(null);
        let frames = 0, worst = 0, last = performance.now();
        const start = last; let y = 0;
        const step = () => {
            const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++;
            y += 60; log.scrollTop = y % Math.max(1, log.scrollHeight - log.clientHeight);
            if (now - start < 3000) requestAnimationFrame(step); else res({ fps: Math.round(frames / 3), worstFrameMs: Math.round(worst) });
        };
        requestAnimationFrame(step);
    }));

    // lista lateral: quadros durante a animação de abrir
    const drawer = await ph.evaluate(() => new Promise(res => {
        const btn = document.querySelector('#convBtn');
        if (!btn) return res(null);
        let frames = 0, worst = 0, last = performance.now(); const start = last;
        const tick = () => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; frames++;
            if (now - start < 1200) requestAnimationFrame(tick); else res({ fps: Math.round(frames / 1.2), worstFrameMs: Math.round(worst) }); };
        btn.click(); requestAnimationFrame(tick);
    }));
    const m2 = await metrics();
    const lt2 = await ph.evaluate(() => [Math.round(window.__lt), window.__ltn]);
    const dom = await ph.evaluate(() => document.getElementsByTagName('*').length);
    console.log(JSON.stringify({
        visual: VISUAL, attr: visual, loadMs, longTasksAtLoad: lt1, switchMs: switchTimes, scroll, drawer, longTasksTotal: lt2, domNodes: dom,
        scriptS: +(m2.ScriptDuration).toFixed(2), styleS: +(m2.RecalcStyleDuration).toFixed(2), layoutS: +(m2.LayoutDuration).toFixed(2),
        heapMB: Math.round(m2.JSHeapUsedSize / 1e6),
    }));
    await browser.close();
})().catch(e => { console.error('ABORTOU', e.message); process.exit(1); });
