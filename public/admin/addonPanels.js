/**
 * addonPanels.js
 * As telas dos complementos dentro de Configurações → Complementos (admin/addons.js "Abrir"):
 * o servidor fala com cada serviço (scripts/addon-bridges.js), então não há painel no navegador
 * nem login próprio. Cada tela recebe { load, call, toast }.
 */
import { icon } from '../ui/icons.js';
import { askConfirm } from '../ui/prompt.js';

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => new Intl.NumberFormat('pt-BR').format(Math.round(n || 0));
const usd = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'USD', maximumFractionDigits: n && n < 1 ? 4 : 2 }).format(n || 0);
const pct = n => `${(Math.round((n || 0) * 10) / 10).toString().replace('.', ',')}%`;
const when = t => {
    if (!t) return '';
    const d = new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t);
    return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
};
const stats = items => `<div class="ad-stats">${items.map(([label, value]) => `
    <div class="ad-stat"><span class="ad-stat-value">${esc(value)}</span><span class="ad-stat-label">${esc(label)}</span></div>`).join('')}</div>`;
const loading = el => { el.innerHTML = '<p class="setting-help">Carregando…</p>'; };
const failed = (el, e) => { el.innerHTML = `<p class="rm-warning">${icon('info', 15)} ${esc(e.message)}</p>`; };

// ---------- OmniRoute ----------

const STATUS = { ok: ['ok', 'funcionando'], success: ['ok', 'funcionando'], error: ['err', 'com erro'], unknown: ['', 'não testado'] };

function omniroute(el, { load, call, toast }) {
    let data = null;
    let catalog = null;
    let picked = null; // provedor escolhido para adicionar
    let query = '';
    let models = null; // { id: connId, list }

    async function refresh() {
        try {
            data = await load();
            render();
        } catch (e) {
            failed(el, e);
        }
    }

    function render() {
        const u = data.usage;
        const hasCodex = data.connections.some(c => c.provider === 'codex');
        el.innerHTML = `
            ${stats([['requisições', num(u.requests)], ['tokens', num(u.tokens)], ['custo', usd(u.cost)], ['sucesso', pct(u.successPct)]])}

            <h3 class="section-label rm-gap">Modelo da rota "Outros modelos"</h3>
            <p class="setting-help">${data.model ? `Usando <code>${esc(data.model)}</code>.` : 'Nenhum fixo: escolha pelo /model do Claude Code (os modelos dos provedores abaixo aparecem lá).'}
                ${data.model ? '<button type="button" class="btn btn-ghost btn-sm" data-act="clear-model">Usar o /model</button>' : ''}</p>

            <h3 class="section-label rm-gap">Provedores conectados</h3>
            ${data.codexLogin && !hasCodex ? `
                <div class="ad-callout">
                    <span>Você já está logado no Codex neste servidor. Conecte essa conta para usar os modelos GPT/Codex no Claude Code.
                        <small>Usar a assinatura do ChatGPT por um gateway pode ir contra os termos da OpenAI; uma chave de API não tem esse risco.</small></span>
                    <button type="button" class="btn btn-primary btn-sm" data-act="codex">Usar minha conta do Codex</button>
                </div>` : ''}
            <ul class="rm-list">${data.connections.length ? data.connections.map(c => {
                const [cls, label] = STATUS[c.status] || ['', c.status];
                return `
                <li class="rm-row ad-row">
                    <span class="rm-name">${esc(c.name)} <span class="ad-badge ${cls}">${esc(label)}</span>
                        <span class="rm-meta">${esc(c.provider)}${c.error ? ` · ${esc(c.error)}` : ''}</span></span>
                    <span class="rm-actions">
                        <button type="button" class="btn btn-ghost btn-sm" data-act="test" data-id="${esc(c.id)}">Testar</button>
                        <button type="button" class="btn btn-ghost btn-sm" data-act="models" data-id="${esc(c.id)}">Modelos</button>
                        <button type="button" class="btn btn-ghost btn-sm" data-act="remove" data-id="${esc(c.id)}" data-name="${esc(c.name)}">Remover</button>
                    </span>
                    ${models && models.id === c.id ? `
                    <div class="ad-models">
                        ${models.list === null ? '<p class="setting-help">Carregando modelos…</p>' : models.list.length ? `
                        <label class="setting setting-stack"><span class="setting-text">Fixar um modelo na rota</span>
                            <select data-model>${['<option value="">—</option>', ...models.list.map(m => `<option value="${esc(m.id)}" ${m.id === data.model ? 'selected' : ''}>${esc(m.name)} (${esc(m.id)})</option>`)].join('')}</select>
                        </label>` : '<p class="setting-help">Nenhum modelo listado.</p>'}
                    </div>` : ''}
                </li>`;
            }).join('') : '<li class="rm-empty">Nenhum ainda. Adicione um abaixo.</li>'}</ul>

            <h3 class="section-label rm-gap">Adicionar provedor</h3>
            ${picked ? `
                <div class="ad-add">
                    <p class="setting-help"><b>${esc(picked.name)}</b>${picked.free ? ' <span class="ad-badge ok">grátis</span>' : ''}
                        ${picked.freeNote || picked.note ? `<br>${esc(picked.freeNote || picked.note)}` : ''}
                        ${picked.website ? `<br><a href="${esc(picked.website)}" target="_blank" rel="noopener">Pegar a chave em ${esc(picked.website.replace(/^https?:\/\//, ''))}</a>` : ''}</p>
                    ${picked.noKey ? '<p class="setting-help">Este funciona sem chave.</p>' : `
                    <input type="password" class="mono" data-key placeholder="Chave de API do ${esc(picked.name)}" autocomplete="off" spellcheck="false">`}
                    <div class="push-actions">
                        <button type="button" class="btn btn-primary" data-act="add">Adicionar</button>
                        <button type="button" class="btn btn-ghost" data-act="cancel-add">Cancelar</button>
                    </div>
                </div>` : `
                <input type="search" class="ad-search" data-search placeholder="Buscar entre os provedores (ex.: Groq, OpenRouter, Gemini)" value="${esc(query)}" autocomplete="off">
                <ul class="rm-list ad-catalog">${catalogRows()}</ul>`}`;
    }

    function catalogRows() {
        if (!catalog) return '<li class="rm-empty">Carregando a lista de provedores…</li>';
        const q = query.trim().toLowerCase();
        const noKey = catalog.noKey.map(p => ({ ...p, noKey: true, free: true }));
        const all = [...noKey, ...catalog.providers];
        const found = (q ? all.filter(p => p.name.toLowerCase().includes(q) || p.id.includes(q)) : all.filter(p => p.free)).slice(0, q ? 40 : 12);
        if (!found.length) return '<li class="rm-empty">Nenhum provedor encontrado.</li>';
        return (q ? '' : '<li class="rm-empty">Grátis para começar (busque para ver todos):</li>') + found.map(p => `
            <li><button type="button" class="ad-pick" data-pick="${esc(p.id)}" data-nokey="${p.noKey ? 1 : ''}">
                <span>${esc(p.name)}${p.free ? ' <span class="ad-badge ok">grátis</span>' : ''}${p.noKey ? ' <span class="ad-badge">sem chave</span>' : ''}</span>
                ${icon('chevronRight', 16)}</button></li>`).join('');
    }

    el.addEventListener('input', e => {
        if (!e.target.matches('[data-search]')) return;
        query = e.target.value;
        el.querySelector('.ad-catalog').innerHTML = catalogRows();
    });

    el.addEventListener('change', async e => {
        if (!e.target.matches('[data-model]')) return;
        try {
            data.model = (await call('setModel', { model: e.target.value })).model;
            toast(data.model ? `Rota usando ${data.model}.` : 'Modelo livre (/model).');
            render();
        } catch (err) { toast(err.message, { tone: 'error' }); }
    });

    el.addEventListener('click', async e => {
        const pick = e.target.closest('[data-pick]');
        if (pick) {
            const list = pick.dataset.nokey ? catalog.noKey.map(p => ({ ...p, noKey: true })) : catalog.providers;
            picked = list.find(p => p.id === pick.dataset.pick);
            render();
            el.querySelector('[data-key]')?.focus();
            return;
        }
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        btn.disabled = true;
        try {
            if (act === 'cancel-add') { picked = null; render(); }
            else if (act === 'add') {
                const apiKey = el.querySelector('[data-key]')?.value.trim() || '';
                if (!picked.noKey && !apiKey) { toast('Cole a chave de API.', { tone: 'error' }); return; }
                await call('addProvider', { provider: picked.id, name: picked.name, apiKey });
                toast(`${picked.name} adicionado.`);
                picked = null;
                await refresh();
            } else if (act === 'test') {
                const r = await call('testProvider', { id: btn.dataset.id });
                toast(r.valid ? 'Funcionando.' : `Erro: ${r.error || r.diagnosis?.message || 'falhou'}`, { tone: r.valid ? undefined : 'error', duration: 6000 });
                await refresh();
            } else if (act === 'remove') {
                if (!await askConfirm({ title: 'Remover provedor', message: `Remover ${btn.dataset.name}?`, confirm: 'Remover', danger: true })) return;
                await call('removeProvider', { id: btn.dataset.id });
                toast('Removido.');
                await refresh();
            } else if (act === 'models') {
                models = models?.id === btn.dataset.id ? null : { id: btn.dataset.id, list: null };
                render();
                if (models) { models.list = await call('models', { id: btn.dataset.id }); render(); }
            } else if (act === 'clear-model') {
                data.model = (await call('setModel', { model: '' })).model;
                render();
            } else if (act === 'codex') {
                await call('importCodex');
                toast('Conta do Codex conectada.');
                await refresh();
            }
        } catch (err) {
            toast(err.message, { tone: 'error', duration: 6000 });
        } finally {
            if (btn.isConnected) btn.disabled = false;
        }
    });

    loading(el);
    refresh();
    call('catalog').then(c => { catalog = c; const list = el.querySelector('.ad-catalog'); if (list) list.innerHTML = catalogRows(); })
        .catch(e => { catalog = { providers: [], noKey: [] }; toast(`Lista de provedores indisponível: ${e.message}`, { tone: 'error' }); });
}

// ---------- Claude Mem ----------

function claudeMem(el, { load, call, toast }) {
    let info = null;
    let project = '';
    let items = [];
    let hasMore = false;
    let searching = '';

    async function refresh() {
        try {
            info = await load();
            await loadItems(true);
        } catch (e) {
            failed(el, e);
        }
    }

    async function loadItems(reset) {
        const r = await call('observations', { project, offset: reset ? 0 : items.length, limit: 20 });
        items = reset ? r.items : [...items, ...r.items];
        hasMore = r.hasMore;
        render();
    }

    function render() {
        const s = info.stats;
        el.innerHTML = `
            ${stats([['memórias', num(s.observations)], ['sessões', num(s.sessions)], ['resumos', num(s.summaries)], ['banco', `${Math.max(1, Math.round(s.sizeBytes / 1024))} KB`]])}
            <form class="ad-searchrow" data-searchform>
                <input type="search" class="ad-search" data-q placeholder="Buscar nas memórias" value="${esc(searching)}" autocomplete="off">
                ${info.projects.length ? `<select data-project><option value="">Todos os projetos</option>${info.projects.map(p => `<option ${p === project ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>` : ''}
            </form>
            <div class="ad-results"></div>
            <ul class="rm-list">${items.length ? items.map(o => `
                <li class="rm-row ad-row">
                    <span class="rm-name">${esc(o.title || 'Memória')} ${o.type ? `<span class="ad-badge">${esc(o.type)}</span>` : ''}
                        <span class="rm-meta">${esc([o.project, when(o.at)].filter(Boolean).join(' · '))}</span>
                        ${o.text ? `<span class="setting-help ad-clamp">${esc(typeof o.text === 'string' ? o.text : JSON.stringify(o.text))}</span>` : ''}</span>
                    <span class="rm-actions"><button type="button" class="btn btn-ghost btn-sm" data-del="${esc(o.id)}">Apagar</button></span>
                </li>`).join('') : '<li class="rm-empty">Nenhuma memória ainda. Elas aparecem depois das conversas com o Claude Code.</li>'}</ul>
            ${hasMore ? '<div class="push-actions"><button type="button" class="btn btn-ghost" data-more>Carregar mais</button></div>' : ''}`;
    }

    el.addEventListener('submit', async e => {
        e.preventDefault();
        searching = el.querySelector('[data-q]').value.trim();
        const box = el.querySelector('.ad-results');
        if (!searching) { box.innerHTML = ''; return; }
        box.innerHTML = '<p class="setting-help">Buscando…</p>';
        try {
            const r = await call('search', { query: searching });
            box.innerHTML = `<pre class="rm-output">${esc(r.text || 'Nada encontrado.')}</pre>`;
        } catch (err) { failed(box, err); }
    });
    el.addEventListener('change', e => {
        if (!e.target.matches('[data-project]')) return;
        project = e.target.value;
        loadItems(true).catch(err => toast(err.message, { tone: 'error' }));
    });
    el.addEventListener('click', async e => {
        if (e.target.closest('[data-more]')) return loadItems(false).catch(err => toast(err.message, { tone: 'error' }));
        const del = e.target.closest('[data-del]');
        if (!del) return;
        if (!await askConfirm({ title: 'Apagar memória', message: 'Apagar esta memória?', confirm: 'Apagar', danger: true })) return;
        try {
            await call('deleteObservation', { id: del.dataset.del });
            items = items.filter(o => String(o.id) !== del.dataset.del);
            info.stats.observations = Math.max(0, info.stats.observations - 1);
            render();
        } catch (err) { toast(err.message, { tone: 'error' }); }
    });

    loading(el);
    refresh();
}

// ---------- Headroom ----------

function headroom(el, { load }) {
    loading(el);
    load().then(s => {
        el.innerHTML = `
            ${stats([['tokens economizados', num(s.tokensSaved)], ['compressão média', pct(s.avgPct)], ['melhor compressão', pct(s.bestPct)],
                ['economia', usd(s.savedUsd)], ['requisições', num(s.requests)], ['comprimidas', num(s.compressed)]])}
            <p class="setting-help">${s.requests ? `De ${num(s.tokensBefore)} tokens lidos, ${num(s.tokensSaved)} não foram enviados ao modelo${s.model ? ` (${esc(s.model)})` : ''}.`
                : 'Ainda sem uso. Abra uma conversa pela rota "Economia de tokens" (menu Nova conversa) ou escolha essa rota para o terminal.'}
                Os números zeram quando o serviço reinicia.</p>`;
    }).catch(e => failed(el, e));
}

export const PANELS = { omniroute, 'claude-mem': claudeMem, headroom };
