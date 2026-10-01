/**
 * conversation.js
 * Renders an agent session's normalized events as a chat: messages (Markdown), reasoning,
 * tool cards per kind (shell, read, diff, search, fetch, MCP, subagent), permissions, raw events.
 * Updates the DOM incrementally; streaming text is re-rendered at most once per frame.
 */
import { icon } from '../ui/icons.js';
import { renderMarkdown, esc } from './markdown.js';
import { renderDiff } from './diff.js';
import { assessRisk, maskSecrets } from './risk.js';

const TOOL_META = {
    bash: { icon: 'terminal', verb: 'Terminal' },
    read: { icon: 'fileText', verb: 'Leu' },
    edit: { icon: 'edit', verb: 'Editou' },
    write: { icon: 'filePlus', verb: 'Criou' },
    search: { icon: 'search', verb: 'Buscou' },
    fetch: { icon: 'globe', verb: 'Web' },
    mcp: { icon: 'bolt', verb: 'MCP' },
    task: { icon: 'bot', verb: 'Subagente' },
    think: { icon: 'info', verb: 'Pensou' },
    other: { icon: 'bolt', verb: 'Ferramenta' },
};
const OUTPUT_PREVIEW = 4000; // characters shown before "ver tudo"

const coarse = () => window.matchMedia('(pointer: coarse)').matches;

function shortPath(p, cwd) {
    if (!p) return '';
    const norm = String(p).replace(/\\/g, '/');
    const base = cwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    return base && norm.startsWith(`${base}/`) ? norm.slice(base.length + 1) : norm;
}

function mcpName(name) {
    // mcp__server__tool -> server · tool
    const parts = String(name || '').split('__');
    return parts.length >= 3 ? `${parts[1]} · ${parts.slice(2).join('__')}` : name;
}

export default class Conversation {
    /**
     * @param {HTMLElement} log - scroll container
     * @param {object} opts
     * @param {() => string} opts.cwd - the session folder (paths are shown relative to it)
     * @param {(permissionId: string, optionId: string|null) => void} opts.onPermission
     * @param {(path: string) => void} [opts.onOpenFile]
     */
    constructor(log, { cwd, onPermission, onOpenFile }) {
        this.log = log;
        this.cwd = cwd;
        this.onPermission = onPermission;
        this.onOpenFile = onOpenFile;
        this.tools = new Map();       // toolId -> { el, data, parentToolId }
        this.message = null;          // { el, text } assistant message being streamed
        this.thought = null;          // { el, text } reasoning block being streamed
        this.plan = null;             // plan card element (updated in place)
        this.turn = null;             // container of the current turn
        this.pendingRender = new Set();
        this.frame = 0;
        this.log.addEventListener('click', e => this.onClick(e));
    }

    // ---------- scrolling ----------

    nearBottom() {
        return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 120;
    }

    /** Runs a DOM change and keeps the view pinned to the bottom if it was there. */
    keepBottom(fn) {
        const stick = this.nearBottom();
        const result = fn();
        if (stick) this.log.scrollTop = this.log.scrollHeight;
        return result;
    }

    // ---------- structure ----------

    ensureTurn() {
        if (!this.turn) {
            this.turn = document.createElement('section');
            this.turn.className = 'ag-turn';
            this.log.appendChild(this.turn);
        }
        return this.turn;
    }

    add(html, className, parent = null) {
        const el = document.createElement('div');
        el.className = className;
        el.innerHTML = html;
        this.keepBottom(() => (parent || this.ensureTurn()).appendChild(el));
        return el;
    }

    note(text, tone = '') {
        return this.add(esc(text), `ag-note ${tone}`);
    }

    endStreams() {
        if (this.message) this.renderNow(this.message);
        this.message = null;
        this.thought = null;
    }

    // ---------- streaming text ----------

    /** Coalesces Markdown re-renders to one per animation frame. */
    schedule(block) {
        this.pendingRender.add(block);
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            const blocks = [...this.pendingRender];
            this.pendingRender.clear();
            this.keepBottom(() => blocks.forEach(b => this.renderNow(b)));
        });
    }

    renderNow(block) {
        this.pendingRender.delete(block);
        if (block.kind === 'thought') block.body.textContent = block.text;
        else block.el.innerHTML = renderMarkdown(block.text);
    }

    // ---------- events ----------

    apply(event) {
        const d = event.data || {};
        switch (event.type) {
            case 'session.start':
                this.note(d.resumed ? 'Conversa retomada.' : `Sessão iniciada em ${d.cwd}`);
                break;
            case 'message.user':
                this.endStreams();
                this.turn = null; // each user message starts a new turn
                this.add(`${d.images && d.images.length ? `<div class="ag-attach">${icon('fileImage', 14)} ${d.images.length} imagem(ns)</div>` : ''}${esc(d.text)}`,
                    'ag-user');
                break;
            case 'message.assistant.delta':
                this.thought = null;
                if (!this.message) {
                    const el = this.add('', 'ag-assistant md');
                    this.message = { kind: 'message', el, text: '' };
                }
                this.message.text += d.text;
                this.schedule(this.message);
                break;
            case 'message.assistant.done':
                this.endStreams();
                if (d.stopReason === 'cancelled') this.note('Interrompido.');
                else if (d.stopReason && d.stopReason !== 'end_turn') this.note(`Turno encerrado: ${d.stopReason}`);
                break;
            case 'thought.delta':
                if (!this.thought) {
                    this.message = null;
                    const el = this.add(`<details><summary>${icon('info', 13)} Raciocínio</summary><div class="ag-thought-body"></div></details>`, 'ag-thought');
                    this.thought = { kind: 'thought', el, body: el.querySelector('.ag-thought-body'), text: '' };
                }
                this.thought.text += d.text;
                this.schedule(this.thought);
                break;
            case 'tool.start':
            case 'tool.update':
            case 'tool.result':
                if (event.type === 'tool.start') this.endStreams();
                this.renderTool(event.type, d);
                break;
            case 'subagent.start':
            case 'subagent.update':
            case 'subagent.end':
                this.renderSubagent(event.type, d);
                break;
            case 'permission.request':
                this.endStreams();
                this.renderPermission(d);
                break;
            case 'permission.response':
                this.resolvePermission(d);
                break;
            case 'plan.update':
                this.renderPlan(d.steps);
                break;
            case 'error':
                this.endStreams();
                this.add(`${icon('x', 14)} ${esc(d.message)}${d.detail ? `<pre>${esc(d.detail)}</pre>` : ''}`, 'ag-note error');
                break;
            case 'session.end':
                this.note('Sessão encerrada.');
                break;
            case 'raw':
                // Nothing disappears: anything the adapter could not map is listed here, collapsed
                this.add(`<details><summary>${icon('info', 13)} Evento bruto · ${esc(d.source)}</summary><pre>${esc(JSON.stringify(d.payload, null, 2))}</pre></details>`, 'ag-raw');
                break;
            default:
                break; // status, usage, config, commands, mode: shown by the bar/panel
        }
    }

    // ---------- tools ----------

    toolParent(parentToolId) {
        const parent = parentToolId && this.tools.get(parentToolId);
        return parent ? parent.el.querySelector('.ag-sub-children') : null;
    }

    renderTool(type, d) {
        let tool = this.tools.get(d.toolId);
        if (!tool) {
            const kind = d.kind || 'other';
            const meta = TOOL_META[kind] || TOOL_META.other;
            const el = document.createElement('details');
            el.className = `ag-tool kind-${kind}`;
            el.dataset.toolId = d.toolId;
            el.innerHTML = `<summary>
                    <span class="ag-tool-icon">${icon(meta.icon, 15)}</span>
                    <span class="ag-tool-verb">${esc(meta.verb)}</span>
                    <span class="ag-tool-title"></span>
                    <span class="ag-tool-stats"></span>
                    <span class="ag-tool-state" aria-label="Rodando">${icon('loader', 14)}</span>
                </summary>
                <div class="ag-tool-body"></div>
                ${kind === 'task' ? '<div class="ag-sub-children"></div>' : ''}`;
            tool = { el, data: { kind }, parentToolId: d.parentToolId || null };
            this.tools.set(d.toolId, tool);
            const parent = this.toolParent(d.parentToolId);
            this.keepBottom(() => (parent || this.ensureTurn()).appendChild(el));
            // Subagents stay open (their tools stream inside); edits open on wide screens
            if (kind === 'task' || (!coarse() && (kind === 'edit' || kind === 'write'))) el.open = true;
        }
        // Merge: later updates may carry only some fields
        Object.entries(d).forEach(([k, v]) => {
            if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length && tool.data[k]?.length)) tool.data[k] = v;
        });
        if (type === 'tool.result') tool.data.status = d.status;
        else if (d.status === 'in_progress' || type === 'tool.start') tool.data.status = tool.data.status || 'running';
        this.keepBottom(() => this.paintTool(tool));
    }

    paintTool(tool) {
        const d = tool.data;
        const el = tool.el;
        el.querySelector('.ag-tool-title').textContent = maskSecrets(this.toolTitle(d));
        const state = el.querySelector('.ag-tool-state');
        const status = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' ? d.status : 'running';
        el.dataset.status = status;
        state.innerHTML = status === 'running' ? icon('loader', 14) : status === 'completed' ? icon('check', 14) : icon('x', 14);
        state.setAttribute('aria-label', status === 'running' ? 'Rodando' : status === 'completed' ? 'Concluído' : 'Falhou');

        const body = el.querySelector('.ag-tool-body');
        const parts = [];
        let stats = '';
        if (d.kind === 'bash' && d.input && d.input.command) {
            parts.push(`<div class="ag-cmd"><span>$</span> ${esc(maskSecrets(d.input.command))}</div>`);
        } else if (d.kind === 'mcp' || d.kind === 'other' || d.kind === 'fetch') {
            if (d.input && Object.keys(d.input).length) parts.push(`<pre class="ag-input">${esc(maskSecrets(JSON.stringify(d.input, null, 2)))}</pre>`);
        } else if (d.kind === 'task') {
            const input = d.input || {};
            if (input.prompt) parts.push(`<div class="ag-sub-prompt">${esc(input.prompt)}</div>`);
        }
        if (d.diffs && d.diffs.length) {
            let added = 0;
            let removed = 0;
            for (const diff of d.diffs) {
                const rendered = renderDiff(diff);
                added += rendered.added;
                removed += rendered.removed;
                parts.push(`<div class="ag-diff-file"><button type="button" class="ag-link" data-open-file="${esc(diff.path)}">${esc(shortPath(diff.path, this.cwd()))}</button>${diff.oldText == null ? '<span class="ag-badge">novo</span>' : ''}</div>${rendered.html}`);
            }
            stats = `<span class="add">+${added}</span> <span class="del">−${removed}</span>`;
        }
        if (d.output && !(d.kind === 'task' && d.status !== 'completed' && d.status !== 'failed')) {
            const long = d.output.length > OUTPUT_PREVIEW;
            const text = maskSecrets(long ? d.output.slice(0, OUTPUT_PREVIEW) : d.output);
            parts.push(`<pre class="ag-output${d.kind === 'task' ? ' md' : ''}">${esc(text)}</pre>`);
            if (long) parts.push(`<button type="button" class="ag-link" data-show-all="${esc(d.toolId)}">Ver tudo (${d.output.length.toLocaleString('pt-BR')} caracteres)</button>`);
            if (d.truncated) parts.push('<div class="ag-muted">Saída cortada pelo servidor (muito longa).</div>');
        }
        el.querySelector('.ag-tool-stats').innerHTML = stats;
        body.innerHTML = parts.join('');
        body.hidden = !parts.length;
    }

    toolTitle(d) {
        const input = d.input || {};
        const where = input.file_path || input.path || input.notebook_path || (d.locations && d.locations[0] && d.locations[0].path);
        switch (d.kind) {
            case 'bash': return input.description || input.command || d.title || '';
            case 'read':
            case 'edit':
            case 'write': return where ? shortPath(where, this.cwd()) : (d.title || '');
            case 'search': return input.pattern || input.query || d.title || '';
            case 'fetch': return input.url || input.query || d.title || '';
            case 'mcp': return mcpName(d.name || d.title);
            case 'task': return d.agentType ? `${d.agentType}${d.description ? ` · ${d.description}` : ''}` : (input.description || d.title || '');
            default: return d.title || d.name || '';
        }
    }

    renderSubagent(type, d) {
        const tool = this.tools.get(d.subagentId);
        if (!tool) return;
        if (d.agentType) tool.data.agentType = d.agentType;
        if (d.description) tool.data.description = d.description;
        if (d.prompt) tool.data.input = { ...(tool.data.input || {}), prompt: d.prompt };
        if (d.async) {
            tool.data.async = true;
            tool.el.classList.add('async');
            tool.el.querySelector('.ag-tool-verb').textContent = 'Subagente (2º plano)';
        }
        if (type === 'subagent.end') {
            const bits = [d.totalTokens && `${d.totalTokens.toLocaleString('pt-BR')} tokens`,
                d.toolUseCount != null && `${d.toolUseCount} ferramentas`,
                d.durationMs && `${Math.round(d.durationMs / 1000)} s`].filter(Boolean);
            if (bits.length) tool.el.querySelector('.ag-tool-stats').textContent = bits.join(' · ');
            // A finished subagent collapses to its summary line
            tool.el.open = false;
        }
        this.paintTool(tool);
    }

    // ---------- permissions ----------

    renderPermission(d) {
        const risks = assessRisk(d, this.cwd());
        const input = d.input || {};
        const detail = input.command
            ? `<div class="ag-cmd"><span>$</span> ${esc(maskSecrets(input.command))}</div>`
            : d.diffs && d.diffs.length ? d.diffs.map(x => renderDiff(x).html).join('') : '';
        const el = this.add(`
            <div class="ag-perm-head">${icon('shield', 16)} <span>${esc(d.title)}</span></div>
            ${risks.length ? `<div class="ag-risk" role="alert">${icon('info', 14)} Atenção: ${risks.map(esc).join('; ')}</div>` : ''}
            ${detail ? `<div class="ag-perm-detail">${detail}</div>` : ''}
            <div class="ag-perm-actions">${d.options.map(o => `<button type="button" class="btn ${o.kind === 'allow_once' ? 'btn-primary' : o.kind.startsWith('reject') ? 'btn-ghost' : ''}" data-perm="${esc(d.permissionId)}" data-option="${esc(o.id)}">${esc(o.name)}</button>`).join('')}</div>`,
        `ag-perm${risks.length ? ' risky' : ''}`);
        el.dataset.permissionId = d.permissionId;
        return el;
    }

    resolvePermission(d) {
        const card = this.log.querySelector(`.ag-perm[data-permission-id="${CSS.escape(d.permissionId)}"]`);
        if (!card) return;
        card.classList.add('answered');
        const chosen = card.querySelector(`[data-option="${CSS.escape(d.optionId || '')}"]`);
        card.querySelector('.ag-perm-actions').innerHTML = d.outcome === 'selected'
            ? `<span class="ag-muted">${icon('check', 14)} ${esc(chosen ? chosen.textContent : d.optionId)}</span>`
            : '<span class="ag-muted">Cancelado</span>';
    }

    // ---------- plan ----------

    renderPlan(steps) {
        const html = `<div class="ag-plan-head">${icon('clipboardList', 14)} Plano</div>`
            + `<ol>${steps.map(s => `<li class="${esc(s.status)}"><span>${s.status === 'completed' ? icon('check', 13) : s.status === 'in_progress' ? icon('loader', 13) : icon('square', 13)}</span>${esc(s.content)}</li>`).join('')}</ol>`;
        if (this.plan && this.plan.isConnected) {
            this.plan.innerHTML = html;
        } else {
            this.plan = this.add(html, 'ag-plan');
        }
    }

    // ---------- clicks ----------

    onClick(e) {
        const perm = e.target.closest('[data-perm]');
        if (perm) {
            perm.closest('.ag-perm-actions').querySelectorAll('button').forEach(b => { b.disabled = true; });
            this.onPermission(perm.dataset.perm, perm.dataset.option);
            return;
        }
        const all = e.target.closest('[data-show-all]');
        if (all) {
            const tool = this.tools.get(all.dataset.showAll);
            if (tool) all.previousElementSibling.textContent = maskSecrets(tool.data.output);
            all.remove();
            return;
        }
        const file = e.target.closest('[data-open-file]');
        if (file && this.onOpenFile) this.onOpenFile(file.dataset.openFile);
    }

    /** Fresh start (reconnect with a full replay). */
    clear() {
        cancelAnimationFrame(this.frame);
        this.frame = 0;
        this.pendingRender.clear();
        this.log.innerHTML = '';
        this.tools.clear();
        this.message = null;
        this.thought = null;
        this.plan = null;
        this.turn = null;
    }
}
