/**
 * sidepanel.js
 * The agent side panel: plan/todos, subagents, files changed in the session, usage (context and
 * cost) and slash commands. Only sections with data are shown. Column on desktop, sheet on phones.
 */
import { icon } from '../ui/icons.js';
import { esc } from './markdown.js';
import { diffLines, diffStats } from './diff.js';

function shortPath(p, cwd) {
    const norm = String(p || '').replace(/\\/g, '/');
    const base = cwd ? String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') : '';
    return base && norm.startsWith(`${base}/`) ? norm.slice(base.length + 1) : norm;
}

export default class SidePanel {
    /**
     * @param {HTMLElement} el
     * @param {object} opts
     * @param {() => string} opts.cwd
     * @param {(path: string) => void} opts.onOpenFile
     * @param {(command: string) => void} opts.onCommand - insert "/command " in the composer
     * @param {(toolId: string) => void} opts.onShowTool - scroll the conversation to a tool card
     */
    constructor(el, { cwd, onOpenFile, onCommand, onShowTool }) {
        this.el = el;
        this.cwd = cwd;
        this.onOpenFile = onOpenFile;
        this.onCommand = onCommand;
        this.onShowTool = onShowTool;
        this.reset();
        this.el.addEventListener('click', e => this.onClick(e));
    }

    reset() {
        this.plan = [];
        this.subagents = new Map(); // id -> { type, description, status, async, tokens, tools }
        this.files = new Map();     // path -> { added, removed, created, toolId }
        this.usage = null;
        this.commands = [];
        this.dirty = true;
    }

    apply(event) {
        const d = event.data || {};
        switch (event.type) {
            case 'plan.update':
                this.plan = d.steps;
                break;
            case 'subagent.start':
                this.subagents.set(d.subagentId, { status: 'running', tools: 0 });
                break;
            case 'subagent.update': {
                const s = this.subagents.get(d.subagentId);
                if (s) Object.assign(s, { type: d.agentType || s.type, description: d.description || s.description, async: d.async || s.async });
                break;
            }
            case 'subagent.end': {
                const s = this.subagents.get(d.subagentId);
                if (s) Object.assign(s, { status: d.status, tokens: d.totalTokens, type: d.agentType || s.type, toolsUsed: d.toolUseCount });
                break;
            }
            case 'tool.start':
            case 'tool.update':
            case 'tool.result':
                if (d.parentToolId && this.subagents.has(d.parentToolId) && event.type === 'tool.start') this.subagents.get(d.parentToolId).tools++;
                if (d.diffs && d.diffs.length && event.type !== 'tool.update') {
                    for (const diff of d.diffs) {
                        const { added, removed } = diffStats(diffLines(diff.oldText, diff.newText));
                        const prev = this.files.get(diff.path);
                        // Same tool reported twice (start + result): count once
                        if (prev && prev.toolIds.has(d.toolId)) continue;
                        this.files.set(diff.path, {
                            added: (prev ? prev.added : 0) + added,
                            removed: (prev ? prev.removed : 0) + removed,
                            created: prev ? prev.created : diff.oldText == null,
                            toolIds: new Set([...(prev ? prev.toolIds : []), d.toolId]),
                            lastTool: d.toolId,
                        });
                    }
                }
                break;
            case 'usage.update':
                this.usage = { ...this.usage, ...d };
                break;
            case 'commands.update':
                this.commands = d.commands;
                break;
            default:
                return;
        }
        this.dirty = true;
    }

    /** Re-renders if something changed (called once per batch of events). */
    render() {
        if (!this.dirty) return;
        this.dirty = false;
        const sections = [];
        if (this.plan.length) {
            const done = this.plan.filter(s => s.status === 'completed').length;
            sections.push(`<section><h3>${icon('clipboardList', 14)} Plano <span>${done}/${this.plan.length}</span></h3><ol class="sp-plan">${this.plan.map(s => `<li class="${esc(s.status)}">${esc(s.content)}</li>`).join('')}</ol></section>`);
        }
        if (this.subagents.size) {
            sections.push(`<section><h3>${icon('bot', 14)} Subagentes <span>${this.subagents.size}</span></h3><ul class="sp-list">${[...this.subagents.entries()].map(([id, s]) => `
                <li><button type="button" data-tool="${esc(id)}">
                    <span class="sp-dot ${s.status === 'running' ? (s.async ? 'async' : 'running') : esc(s.status)}"></span>
                    <span class="sp-main">${esc(s.type || 'Subagente')}${s.description ? ` · ${esc(s.description)}` : ''}</span>
                    <span class="sp-meta">${s.async && s.status === 'running' ? '2º plano' : s.tokens ? `${s.tokens.toLocaleString('pt-BR')} tk` : `${s.tools} ferr.`}</span>
                </button></li>`).join('')}</ul></section>`);
        }
        if (this.files.size) {
            sections.push(`<section><h3>${icon('files', 14)} Arquivos alterados <span>${this.files.size}</span></h3><ul class="sp-list">${[...this.files.entries()].map(([p, f]) => `
                <li><button type="button" data-file="${esc(p)}" title="${esc(p)}">
                    <span class="sp-main mono">${esc(shortPath(p, this.cwd()))}</span>
                    <span class="sp-meta">${f.created ? '<span class="add">novo</span> ' : ''}<span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span>
                </button></li>`).join('')}</ul></section>`);
        }
        if (this.usage && (this.usage.used || this.usage.cost)) {
            const u = this.usage;
            const pct = u.used && u.size ? Math.min(100, Math.round((u.used / u.size) * 100)) : null;
            sections.push(`<section><h3>${icon('activity', 14)} Uso</h3>
                ${pct !== null ? `<div class="sp-meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="Contexto usado"><span style="width:${pct}%"></span></div>
                <p class="sp-note">Contexto: ${u.used.toLocaleString('pt-BR')} de ${u.size.toLocaleString('pt-BR')} tokens (${pct}%)</p>` : ''}
                ${u.cost && u.cost.amount ? `<p class="sp-note">Custo: ${u.cost.amount.toLocaleString('pt-BR', { style: 'currency', currency: u.cost.currency || 'USD' })}</p>` : ''}
                ${u.model ? `<p class="sp-note">Modelo: <span class="mono">${esc(u.model)}</span></p>` : ''}
            </section>`);
        }
        if (this.commands.length) {
            sections.push(`<section><h3>${icon('bolt', 14)} Comandos <span>${this.commands.length}</span></h3><ul class="sp-list sp-commands">${this.commands.map(c => `
                <li><button type="button" data-command="${esc(c.name)}" title="${esc(c.description)}">
                    <span class="sp-main mono">/${esc(c.name)}</span><span class="sp-desc">${esc(c.description)}</span>
                </button></li>`).join('')}</ul></section>`);
        }
        this.el.innerHTML = sections.length
            ? sections.join('')
            : `<p class="sp-empty">Plano, subagentes, arquivos alterados e uso aparecem aqui durante a conversa.</p>`;
    }

    get hasActivity() {
        return this.plan.length > 0 || this.subagents.size > 0 || this.files.size > 0;
    }

    onClick(e) {
        const file = e.target.closest('[data-file]');
        if (file) return this.onOpenFile(file.dataset.file);
        const command = e.target.closest('[data-command]');
        if (command) return this.onCommand(command.dataset.command);
        const tool = e.target.closest('[data-tool]');
        if (tool) return this.onShowTool(tool.dataset.tool);
        return undefined;
    }
}
