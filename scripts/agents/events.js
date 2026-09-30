/**
 * events.js
 * Normalized agent event model: the single contract between agent adapters and the UI.
 * Every agent (Claude, OpenCode, Codex...) is translated into these events; nothing is dropped.
 */

/**
 * Event envelope stored and sent to clients:
 *   { sessionId, seq, type, at, data }
 * seq is monotonic per session (1, 2, 3...) so a client can reconnect with ?since=seq.
 *
 * Required data fields per type. Extra fields are allowed (adapters may add details),
 * but these must always be present so the UI can render the event.
 */
const EVENT_FIELDS = {
    'session.start': ['agent', 'cwd', 'capabilities'],
    'session.end': ['reason'],
    'status': ['state'],
    'message.user': ['text'],
    'message.assistant.delta': ['text'],
    'message.assistant.done': ['stopReason'],
    'thought.delta': ['text'],
    'tool.start': ['toolId', 'kind', 'title'],
    'tool.update': ['toolId'],
    'tool.result': ['toolId', 'status'],
    'permission.request': ['permissionId', 'toolId', 'title', 'options'],
    'permission.response': ['permissionId', 'outcome'],
    'plan.update': ['steps'],
    'todo.update': ['items'],
    'subagent.start': ['subagentId'],
    'subagent.update': ['subagentId'],   // type/description/prompt as they arrive
    'subagent.event': ['subagentId', 'event'],
    'subagent.end': ['subagentId'],
    'usage.update': [],
    'mode.update': ['modeId'],
    // Model, mode, reasoning effort... as the agent exposes them (selects in the composer bar)
    'config.update': ['options'],
    // Title/updatedAt reported by the agent itself
    'session.info': [],
    'commands.update': ['commands'],
    'error': ['message'],
    // Anything an adapter cannot map. The UI shows it as a generic card: nothing disappears.
    'raw': ['source', 'payload'],
};

const EVENT_TYPES = Object.keys(EVENT_FIELDS);

/** What the agent is doing right now (drives the session badge in the UI). */
const STATES = ['starting', 'idle', 'thinking', 'waiting_permission', 'error', 'stopped'];

/** Tool card families. Anything unknown is 'other' (rendered as a generic tool card). */
const TOOL_KINDS = ['bash', 'read', 'edit', 'write', 'search', 'fetch', 'mcp', 'task', 'think', 'other'];

const TOOL_STATUSES = ['completed', 'failed', 'cancelled'];

/** Capabilities an adapter can declare; the UI only shows panels for active ones. */
const CAPABILITIES = ['modes', 'plan', 'todos', 'subagents', 'slashCommands', 'mcp', 'images',
    'resume', 'history', 'config', 'usage', 'permissions', 'cancel'];

/**
 * Checks an event envelope. Returns a list of problems (empty = valid).
 * Used by the gateway in development/tests and by the adapter contract tests.
 */
function validateEvent(event) {
    const problems = [];
    if (!event || typeof event !== 'object') return ['event is not an object'];
    if (typeof event.sessionId !== 'string' || !event.sessionId) problems.push('missing sessionId');
    if (!Number.isInteger(event.seq) || event.seq < 1) problems.push('seq must be a positive integer');
    if (!Number.isFinite(event.at)) problems.push('missing at (timestamp)');
    if (!EVENT_FIELDS[event.type]) {
        problems.push(`unknown type "${event.type}"`);
        return problems;
    }
    const data = event.data;
    if (!data || typeof data !== 'object') {
        problems.push(`${event.type}: data must be an object`);
        return problems;
    }
    for (const field of EVENT_FIELDS[event.type]) {
        if (data[field] === undefined) problems.push(`${event.type}: missing data.${field}`);
    }
    if (event.type === 'status' && !STATES.includes(data.state)) {
        problems.push(`status: unknown state "${data.state}"`);
    }
    if (event.type === 'tool.start' && !TOOL_KINDS.includes(data.kind)) {
        problems.push(`tool.start: unknown kind "${data.kind}"`);
    }
    if (event.type === 'tool.result' && !TOOL_STATUSES.includes(data.status)) {
        problems.push(`tool.result: unknown status "${data.status}"`);
    }
    if (event.type === 'permission.request' && (!Array.isArray(data.options) || !data.options.length)) {
        problems.push('permission.request: options must be a non-empty array');
    }
    return problems;
}

module.exports = { EVENT_FIELDS, EVENT_TYPES, STATES, TOOL_KINDS, TOOL_STATUSES, CAPABILITIES, validateEvent };
