/**
 * integrations.js
 * Configurações → Skills e MCPs: instalar uma vez e valer em todos os agentes e contas
 * (scripts/integrations.js). Mostra onde cada um está ativo e o que falta; nenhum valor secreto
 * chega até aqui, só os nomes.
 */
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { api } from './remote.js';
import { esc } from './addonPanels.js';
import { askText, askConfirm } from '../ui/prompt.js';

const AGENTS = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', agy: 'Antigravity' };
const STATE = {
    ok: ['on', 'ativo'],
    missing: ['wait', 'pendente'],
    update: ['wait', 'atualizando'],
    alias: ['warn', 'com outro nome'],
    conflict: ['warn', 'diferente'],
};

/** "CHAVE=valor" por linha -> objeto. */
function parsePairs(text, separator) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        if (!line.trim()) continue;
        const at = line.indexOf(separator);
        if (at < 1) throw new Error(`Linha sem "${separator}": ${line.slice(0, at < 0 ? 24 : at)}`);
        out[line.slice(0, at).trim()] = line.slice(at + separator.length).trim();
    }
    return out;
}

export function mountIntegrationsSection(section) {
    let state = null;
    let busy = false;
    let formOpen = false;

    async function refresh() {
        try {
            state = await api('GET', '/api/integrations');
            render();
        } catch (e) {
            section.innerHTML = `<h3 class="section-label">Skills e MCPs</h3><p class="setting-help">${esc(e.message)}</p>`;
        }
    }

    async function act(fn, okMessage) {
        if (busy) return;
        busy = true;
        section.classList.add('is-busy');
        try {
            const result = await fn();
            if (result?.errors?.length) toast(`Sincronizado, com aviso: ${result.errors[0].error}`, { tone: 'error' });
            else if (okMessage) toast(okMessage);
            await refresh();
        } catch (e) {
            toast(e.message, { tone: 'error' });
        } finally {
            busy = false;
            section.classList.remove('is-busy');
        }
    }

    function targetLabel(id) {
        const t = state.targets.find(x => x.id === id);
        return t ? `${AGENTS[t.agent]} · ${t.label}` : id;
    }

    function serverRow(s) {
        const chips = state.targets.map(t => {
            const info = s.targets[t.id] || { state: s.registered ? 'missing' : null };
            const [tone, label] = info.state ? STATE[info.state] : ['', 'não tem'];
            const fix = s.registered && (info.state === 'alias' || info.state === 'conflict')
                ? `<button type="button" class="btn btn-ghost btn-sm" data-replace="${esc(s.name)}" data-target="${esc(t.id)}"
                    data-alias="${esc(info.alias || '')}">Substituir</button>` : '';
            return `<li class="ig-target"><span class="ad-dot ${tone}"></span><span class="ig-target-name">${esc(AGENTS[t.agent])} <small>${esc(t.label)}</small></span>
                <span class="ig-target-state">${esc(label)}${info.alias ? `: ${esc(info.alias)}` : ''}</span>${fix}</li>`;
        }).join('');
        return `<details class="ig-row">
            <summary><strong>${esc(s.name)}</strong><small>${esc(s.address)}</small>
                ${s.registered ? '' : '<span class="ig-badge">só em parte das ferramentas</span>'}</summary>
            ${s.secretNames?.length ? `<p class="setting-help">Credenciais guardadas: ${esc(s.secretNames.join(', '))}</p>` : ''}
            ${s.type === 'http' && !s.secretNames?.length ? '<p class="setting-help">Sem credencial salva: se ele usar login, entre em cada ferramenta e conta.</p>' : ''}
            <ul class="ig-targets">${chips}</ul>
            <div class="ig-actions">${s.registered
                ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-mcp="${esc(s.name)}">${icon('trash', 14)} Remover de todos</button>`
                : `<button type="button" class="btn btn-sm" data-adopt="${esc(s.name)}" data-from="${esc(s.from)}">Espalhar para todos</button>`}</div>
        </details>`;
    }

    function skillRow(s) {
        const mark = (on, name) => `<span class="ig-chip${on ? ' on' : ''}">${name}</span>`;
        const everywhere = s.claude && s.codex && s.opencode && s.agy;
        return `<li class="ig-skill">
            <span class="ig-skill-name" title="${esc(s.name)}">${esc(s.name)}</span>
            <span class="ig-chips">${mark(s.claude, 'Claude')}${mark(s.codex, 'Codex')}${mark(s.opencode, 'OpenCode')}${mark(s.agy, 'Antigravity')}</span>
            ${everywhere ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-spread="${esc(s.name)}">Espalhar</button>`}
            ${s.unified ? `<button type="button" class="icon-btn" data-remove-skill="${esc(s.name)}" aria-label="Remover ${esc(s.name)}" title="Remover de todos">${icon('trash', 16)}</button>` : ''}
        </li>`;
    }

    function form() {
        return `<form class="ig-form" autocomplete="off">
            <label class="field"><span class="field-label">Nome</span><input name="name" required placeholder="meu-mcp" autocapitalize="off" spellcheck="false"></label>
            <label class="field"><span class="field-label">Tipo</span><select name="type"><option value="http">Endereço (HTTP)</option><option value="stdio">Comando local</option></select></label>
            <label class="field" data-for="http"><span class="field-label">Endereço</span><input name="url" placeholder="https://…/mcp" inputmode="url" autocapitalize="off" spellcheck="false"></label>
            <label class="field" data-for="http"><span class="field-label">Cabeçalhos (opcional, um por linha)</span><textarea name="headers" rows="2" placeholder="Authorization: Bearer …" autocapitalize="off" spellcheck="false"></textarea></label>
            <label class="field" data-for="stdio" hidden><span class="field-label">Comando</span><input name="command" placeholder="npx -y pacote mcp" autocapitalize="off" spellcheck="false"></label>
            <label class="field" data-for="stdio" hidden><span class="field-label">Variáveis (opcional, uma por linha)</span><textarea name="env" rows="2" placeholder="CHAVE=valor" autocapitalize="off" spellcheck="false"></textarea></label>
            <div class="ig-actions"><button type="submit" class="btn btn-sm">Instalar em todos</button>
                <button type="button" class="btn btn-ghost btn-sm" data-form-close>Cancelar</button></div>
        </form>`;
    }

    function render() {
        const pending = state.skills.filter(s => !(s.claude && s.codex && s.opencode && s.agy));
        section.innerHTML = `
            <h3 class="section-label">Skills e MCPs</h3>
            <p class="setting-help">Instale uma vez e vale em todos os agentes e contas. Modelos usam o que o agente deles tem.</p>
            ${state.warnings.map(w => `<p class="ig-alert">${icon('triangleAlert', 15)} <span>${esc(w)}</span></p>`).join('')}
            ${state.errors.map(e => `<p class="ig-alert">${icon('triangleAlert', 15)} <span>${esc(targetLabel(e.target))}: ${esc(e.error)}</span></p>`).join('')}
            <div class="ig-head"><h4>MCPs</h4>${formOpen ? '' : `<button type="button" class="btn btn-ghost btn-sm" data-form-open>${icon('plus', 14)} Adicionar</button>`}</div>
            ${formOpen ? form() : ''}
            ${state.servers.length ? state.servers.map(serverRow).join('') : '<p class="setting-help">Nenhum MCP ainda.</p>'}
            <div class="ig-head"><h4>Skills</h4>
                <span class="ig-head-actions">
                    ${pending.length ? `<button type="button" class="btn btn-ghost btn-sm" data-spread-all>Espalhar ${pending.length}</button>` : ''}
                    <button type="button" class="btn btn-ghost btn-sm" data-install-skill>${icon('plus', 14)} Instalar</button>
                </span></div>
            ${state.skills.length ? `<ul class="ig-skills">${state.skills.map(skillRow).join('')}</ul>` : '<p class="setting-help">Nenhuma skill ainda.</p>'}
            <p class="setting-help">Não passam para os outros agentes: conectores do claude.ai e plugins do Claude. MCP com login pede entrada em cada ferramenta e conta. Skill feita para ferramentas do Claude pode não funcionar nos outros.</p>`;
    }

    section.addEventListener('change', e => {
        if (e.target.name !== 'type') return;
        section.querySelectorAll('.ig-form [data-for]').forEach(el => { el.hidden = el.dataset.for !== e.target.value; });
    });

    section.addEventListener('submit', e => {
        e.preventDefault();
        const f = new FormData(e.target);
        let spec;
        try {
            if (f.get('type') === 'http') {
                spec = { type: 'http', url: f.get('url'), headers: parsePairs(f.get('headers'), ':') };
            } else {
                const [command, ...args] = String(f.get('command')).trim().split(/\s+/);
                spec = { type: 'stdio', command, args, env: parsePairs(f.get('env'), '=') };
            }
        } catch (err) {
            toast(err.message, { tone: 'error' });
            return;
        }
        formOpen = false;
        act(() => api('POST', '/api/integrations/mcp', { name: f.get('name'), spec }), 'MCP instalado.');
    });

    section.addEventListener('click', async e => {
        const b = e.target.closest('button');
        if (!b) return;
        const d = b.dataset;
        if ('formOpen' in d) { formOpen = true; render(); section.querySelector('.ig-form input')?.focus(); return; }
        if ('formClose' in d) { formOpen = false; render(); return; }
        if (d.adopt) {
            act(() => api('POST', `/api/integrations/mcp/${encodeURIComponent(d.adopt)}/adopt`, { from: d.from }), 'Espalhado.');
        } else if (d.removeMcp) {
            if (await askConfirm({ title: 'Remover MCP', message: `Tirar "${d.removeMcp}" das ferramentas onde ele foi instalado por aqui? O que foi alterado à mão fica.`, confirm: 'Remover', danger: true })) {
                act(() => api('DELETE', `/api/integrations/mcp/${encodeURIComponent(d.removeMcp)}`), 'Removido.');
            }
        } else if (d.replace) {
            const old = d.alias ? `"${d.alias}"` : `a versão atual de "${d.replace}"`;
            if (await askConfirm({ title: 'Substituir', message: `Trocar ${old} em ${targetLabel(d.target)} pelo cadastro? Uma cópia do arquivo fica guardada.`, confirm: 'Substituir' })) {
                act(() => api('POST', `/api/integrations/mcp/${encodeURIComponent(d.replace)}/replace`, { target: d.target }), 'Substituído.');
            }
        } else if (d.spread) {
            act(() => api('POST', `/api/integrations/skills/${encodeURIComponent(d.spread)}/spread`), 'Skill espalhada.');
        } else if ('spreadAll' in d) {
            const names = state.skills.filter(s => !(s.claude && s.codex && s.opencode && s.agy)).map(s => s.name);
            if (await askConfirm({ title: 'Espalhar skills', message: `Levar ${names.length} skills para a pasta única (~/.agents/skills) e ligar em todos os agentes? Nada é apagado.`, confirm: 'Espalhar' })) {
                act(async () => {
                    for (const name of names) await api('POST', `/api/integrations/skills/${encodeURIComponent(name)}/spread`);
                }, 'Skills espalhadas.');
            }
        } else if ('installSkill' in d) {
            const from = await askText({ title: 'Instalar skill', label: 'Pasta no servidor (com SKILL.md)', placeholder: '/root/projetos/minha-skill' });
            if (from) act(() => api('POST', '/api/integrations/skills/install', { path: from }), 'Skill instalada.');
        } else if (d.removeSkill) {
            if (await askConfirm({ title: 'Remover skill', message: `Tirar "${d.removeSkill}" de todos os agentes? A pasta fica guardada em ~/.agents/.skills-removidas.`, confirm: 'Remover', danger: true })) {
                act(() => api('DELETE', `/api/integrations/skills/${encodeURIComponent(d.removeSkill)}`), 'Skill removida.');
            }
        }
    });

    section.innerHTML = '<h3 class="section-label">Skills e MCPs</h3><p class="setting-help">Carregando…</p>';
    refresh();
}
