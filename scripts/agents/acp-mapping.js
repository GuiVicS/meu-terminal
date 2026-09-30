/**
 * acp-mapping.js
 * Translates ACP `session/update` notifications and permission requests into the
 * normalized events of events.js. Anything unknown becomes a `raw` event (never dropped).
 */

const DEFAULT_MAX_TEXT = 64 * 1024; // per tool output / diff side; the UI offers "ver mais" via the raw log

/** Claude Code tool names (from _meta.claudeCode.toolName) -> card kind. */
const CLAUDE_TOOL_KINDS = {
    Bash: 'bash', PowerShell: 'bash', BashOutput: 'bash', KillShell: 'bash',
    Read: 'read', NotebookRead: 'read',
    Write: 'write',
    Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
    Grep: 'search', Glob: 'search', LS: 'search',
    WebFetch: 'fetch', WebSearch: 'fetch',
    Task: 'task', Agent: 'task',
};

/** ACP ToolKind -> card kind. */
const ACP_TOOL_KINDS = {
    execute: 'bash', read: 'read', edit: 'edit', delete: 'edit', move: 'edit',
    search: 'search', fetch: 'fetch', think: 'think', switch_mode: 'other', other: 'other',
};

function truncate(text, max) {
    if (typeof text !== 'string') return { text: '', truncated: false };
    if (text.length <= max) return { text, truncated: false };
    return { text: text.slice(0, max), truncated: true };
}

function toolNameOf(update) {
    return (update._meta && update._meta.claudeCode && update._meta.claudeCode.toolName) || update.name || null;
}

function toolKind(update) {
    const name = toolNameOf(update);
    if (name && name.startsWith('mcp__')) return 'mcp';
    if (name && CLAUDE_TOOL_KINDS[name]) return CLAUDE_TOOL_KINDS[name];
    return ACP_TOOL_KINDS[update.kind] || 'other';
}

/** Text of an ACP ContentBlock (text, resource link, embedded resource...). */
function blockText(block) {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text') return block.text || '';
    if (block.type === 'resource_link') return block.uri || block.name || '';
    if (block.type === 'resource' && block.resource) return block.resource.text || block.resource.uri || '';
    return '';
}

class AcpMapper {
    /** @param {{ maxText?: number }} [opts] */
    constructor({ maxText = DEFAULT_MAX_TEXT } = {}) {
        this.maxText = maxText;
        this.tools = new Map(); // toolCallId -> { kind, title, name }
    }

    /**
     * Tool call content -> { output, diffs, terminals, truncated }.
     * ACP content items: { type: 'content', content: ContentBlock } | { type: 'diff', path, oldText, newText }
     * | { type: 'terminal', terminalId }.
     */
    toolContent(content, rawOutput) {
        const texts = [];
        const diffs = [];
        const terminals = [];
        let truncated = false;
        for (const item of Array.isArray(content) ? content : []) {
            if (item.type === 'content') texts.push(blockText(item.content));
            else if (item.type === 'diff') {
                const oldText = truncate(item.oldText ?? '', this.maxText);
                const newText = truncate(item.newText ?? '', this.maxText);
                truncated = truncated || oldText.truncated || newText.truncated;
                diffs.push({ path: item.path, oldText: item.oldText == null ? null : oldText.text, newText: newText.text });
            } else if (item.type === 'terminal') terminals.push(item.terminalId);
        }
        // Some agents (Claude) only report output in rawOutput
        if (!texts.length && rawOutput != null) {
            texts.push(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2));
        }
        const output = truncate(texts.filter(Boolean).join('\n'), this.maxText);
        return { output: output.text, diffs, terminals, truncated: truncated || output.truncated };
    }

    toolDetails(update) {
        const details = {};
        if (update.title) details.title = update.title;
        if (update.rawInput && Object.keys(update.rawInput).length) details.input = update.rawInput;
        if (Array.isArray(update.locations) && update.locations.length) {
            details.locations = update.locations.map(l => ({ path: l.path, line: l.line ?? null }));
        }
        if (update.content || update.rawOutput != null) {
            Object.assign(details, this.toolContent(update.content, update.rawOutput));
        }
        return details;
    }

    /**
     * One ACP session/update -> list of { type, data } (usually one).
     * @param {object} update - params.update of a session/update notification
     */
    mapUpdate(update) {
        if (!update || typeof update !== 'object') return [{ type: 'raw', data: { source: 'acp', payload: update } }];
        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                return [{ type: 'message.assistant.delta', data: { text: blockText(update.content), messageId: update.messageId || null } }];
            case 'agent_thought_chunk':
                return [{ type: 'thought.delta', data: { text: blockText(update.content), messageId: update.messageId || null } }];
            case 'user_message_chunk':
                return [{ type: 'message.user', data: { text: blockText(update.content), replayed: true } }];
            case 'tool_call':
                return this.mapToolCall(update);
            case 'tool_call_update':
                return this.mapToolUpdate(update);
            case 'plan':
                return [{
                    type: 'plan.update',
                    data: {
                        steps: (update.entries || []).map(e => ({
                            content: e.content, status: e.status || 'pending', priority: e.priority || null,
                        })),
                    },
                }];
            case 'available_commands_update':
                return [{
                    type: 'commands.update',
                    data: {
                        commands: (update.availableCommands || []).map(c => ({
                            name: c.name, description: c.description || '', hint: (c.input && c.input.hint) || null,
                        })),
                    },
                }];
            case 'current_mode_update':
                return [{ type: 'mode.update', data: { modeId: update.currentModeId } }];
            case 'usage_update':
                return [{
                    type: 'usage.update',
                    data: {
                        used: update.used ?? null,
                        size: update.size ?? null,
                        cost: update.cost || null,
                        model: (update._meta && update._meta['_claude/model']) || null,
                    },
                }];
            default:
                return [{ type: 'raw', data: { source: 'acp', payload: update } }];
        }
    }

    mapToolCall(update) {
        const kind = toolKind(update);
        const title = update.title || toolNameOf(update) || 'Ferramenta';
        this.tools.set(update.toolCallId, { kind, title, name: toolNameOf(update) });
        const events = [{
            type: 'tool.start',
            // title last: toolDetails may carry the raw ACP title, the fallback wins when it is empty
            data: { toolId: update.toolCallId, kind, name: toolNameOf(update), ...this.toolDetails(update), title },
        }];
        // Some agents send a tool call that is already finished
        if (update.status === 'completed' || update.status === 'failed') events.push(this.toolResult(update));
        return events;
    }

    mapToolUpdate(update) {
        const events = [];
        // An update for a tool we never saw: synthesize the start so the UI has a card for it
        if (!this.tools.has(update.toolCallId)) {
            events.push(...this.mapToolCall({ ...update, status: undefined }));
        }
        if (update.status === 'completed' || update.status === 'failed') {
            events.push(this.toolResult(update));
        } else {
            events.push({
                type: 'tool.update',
                data: { toolId: update.toolCallId, status: update.status || null, ...this.toolDetails(update) },
            });
        }
        return events;
    }

    toolResult(update) {
        return {
            type: 'tool.result',
            data: { toolId: update.toolCallId, ...this.toolDetails(update), status: update.status },
        };
    }

    /**
     * session/request_permission params -> permission.request data (without permissionId,
     * which the gateway assigns). Options keep the agent's ids so the answer maps back.
     */
    mapPermission(params) {
        const toolCall = params.toolCall || {};
        const known = this.tools.get(toolCall.toolCallId);
        return {
            toolId: toolCall.toolCallId || null,
            title: toolCall.title || (known && known.title) || 'Permissão',
            kind: toolCall.kind ? toolKind(toolCall) : (known ? known.kind : 'other'),
            ...this.toolDetails({ ...toolCall, title: undefined }),
            options: (params.options || []).map(o => ({ id: o.optionId, name: o.name, kind: o.kind })),
        };
    }
}

module.exports = { AcpMapper, toolKind, blockText, truncate };
