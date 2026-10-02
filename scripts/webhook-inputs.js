/**
 * webhook-inputs.js
 * Declares and validates the inputs a webhook accepts (see docs/PLANO-WEBHOOKS.md, section 3.3).
 * resolveInputs() is the only place that turns caller-supplied data (HTTP body/query/headers, or
 * a manual run's form) into the env vars the script receives - every value passes through a
 * type's pattern before it's trusted. This is the second half of "no shell injection" (the first
 * half, scripts/webhook-runner.js, never interpolates - it only sets env vars).
 */
const NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const TYPES = ['text', 'number', 'boolean', 'select', 'path', 'textarea', 'secret', 'file'];

// Conservative defaults per type; `pattern` on the input can only narrow these, never widen them,
// since the input's pattern is checked in addition to (not instead of) the type's own shape.
const DEFAULT_PATTERN = {
    text: /^[^\0\n\r]{0,500}$/,
    number: /^-?\d+(\.\d+)?$/,
    path: /^[^\0\n\r]{1,500}$/,
    textarea: /^[^\0]{0,5000}$/,
    secret: /^[^\0]{0,1000}$/,
};
const DEFAULT_MAX_LENGTH = { text: 500, path: 500, textarea: 5000, secret: 1000, select: 200 };

/** A webhook's `inputs` definitions, as validated on save (webhook-store.js calls this). */
function validateDefs(defs) {
    if (!Array.isArray(defs)) return { ok: false, error: 'inputs deve ser uma lista.' };
    const seen = new Set();
    const clean = [];
    for (const raw of defs) {
        if (!raw || typeof raw !== 'object') return { ok: false, error: 'Input inválido.' };
        const name = String(raw.name || '').toUpperCase();
        if (!NAME_RE.test(name)) return { ok: false, error: `Nome de input inválido: "${raw.name}". Use A-Z, 0-9, _.` };
        if (seen.has(name)) return { ok: false, error: `Input duplicado: ${name}.` };
        seen.add(name);
        const type = TYPES.includes(raw.type) ? raw.type : 'text';
        if (type === 'select' && !(Array.isArray(raw.options) && raw.options.length)) {
            return { ok: false, error: `Input ${name}: type "select" precisa de "options".` };
        }
        let pattern = null;
        if (raw.pattern) {
            try {
                pattern = new RegExp(raw.pattern);
            } catch {
                return { ok: false, error: `Input ${name}: pattern inválido.` };
            }
        }
        let extract = null;
        if (raw.extract) {
            try {
                extract = new RegExp(raw.extract);
            } catch {
                return { ok: false, error: `Input ${name}: extract inválido.` };
            }
        }
        clean.push({
            name,
            label: String(raw.label || name).slice(0, 80),
            type,
            required: !!raw.required,
            default: raw.default !== undefined ? String(raw.default) : undefined,
            options: type === 'select' ? raw.options.map(String).slice(0, 50) : undefined,
            pattern: raw.pattern ? String(raw.pattern) : undefined,
            maxLength: Number.isFinite(raw.maxLength) ? Math.min(Math.max(1, raw.maxLength), 20000) : undefined,
            source: ['body', 'query', 'header', 'fixed'].includes(raw.source?.split?.('.')?.[0]) || raw.source === 'fixed'
                ? String(raw.source) : 'body.' + name.toLowerCase(),
            extract: raw.extract ? String(raw.extract) : undefined,
            maxSizeMb: type === 'file' ? Math.min(Math.max(1, Number(raw.maxSizeMb) || 20), 200) : undefined,
            accept: type === 'file' && Array.isArray(raw.accept) ? raw.accept.map(String).slice(0, 20) : undefined,
            _pattern: pattern,
            _extract: extract,
        });
    }
    return { ok: true, defs: clean };
}

/** Reads a dotted source like "body.ref" / "query.branch" / "header.x-event" out of the request parts. */
function readSource(source, { body, query, headers }) {
    const [kind, ...rest] = String(source).split('.');
    const key = rest.join('.');
    if (kind === 'body') return body?.[key];
    if (kind === 'query') return query?.[key];
    if (kind === 'header') return headers?.[key.toLowerCase()];
    return undefined;
}

/**
 * Resolves and validates every input for one run.
 * @param {Array} defs - from validateDefs().defs
 * @param {{ body?, query?, headers?, manual?: object, files?: Record<string,{path:string,size:number}> }} ctx
 *   `manual` (an object of name -> value) is used for a manual run from /admin instead of source-based
 *   resolution; `files` carries uploaded files for type "file" (by input name).
 * @returns {{ ok: true, values: Record<string,string>, files: Record<string,string> } | { ok: false, error: string, input: string }}
 */
function resolveInputs(defs, ctx) {
    const values = {};
    const files = {};
    for (const def of defs) {
        if (def.type === 'file') {
            const file = ctx.files?.[def.name];
            if (!file) {
                if (def.required) return { ok: false, error: 'Arquivo obrigatório.', input: def.name };
                continue;
            }
            const maxBytes = (def.maxSizeMb || 20) * 1024 * 1024;
            if (file.size > maxBytes) return { ok: false, error: `Arquivo maior que ${def.maxSizeMb} MB.`, input: def.name };
            if (def.accept?.length && !acceptMatches(def.accept, file)) {
                return { ok: false, error: 'Tipo de arquivo não permitido.', input: def.name };
            }
            files[def.name] = file.path;
            continue;
        }

        let raw = def.source === 'fixed' || ctx.manual
            ? ctx.manual?.[def.name]
            : readSource(def.source, ctx);
        if (raw === undefined || raw === null || raw === '') raw = def.default;
        if (raw === undefined) {
            if (def.required) return { ok: false, error: 'Obrigatório.', input: def.name };
            continue;
        }
        raw = String(raw);

        if (def._extract) {
            const m = def._extract.exec(raw);
            if (!m) return { ok: false, error: 'Não combina com o padrão esperado.', input: def.name };
            raw = m[1] !== undefined ? m[1] : m[0];
        }

        if (def.type === 'boolean') {
            if (!/^(true|false|1|0)$/i.test(raw)) return { ok: false, error: 'Valor booleano inválido.', input: def.name };
            values[def.name] = /^(true|1)$/i.test(raw) ? 'true' : 'false';
            continue;
        }
        if (def.type === 'select') {
            if (!def.options.includes(raw)) return { ok: false, error: 'Valor fora das opções.', input: def.name };
            values[def.name] = raw;
            continue;
        }
        if (def.maxLength && raw.length > def.maxLength) return { ok: false, error: 'Muito longo.', input: def.name };
        const shapeOk = DEFAULT_PATTERN[def.type] ? DEFAULT_PATTERN[def.type].test(raw) : true;
        if (!shapeOk) return { ok: false, error: 'Formato inválido.', input: def.name };
        if (def._pattern && !def._pattern.test(raw)) return { ok: false, error: 'Formato inválido.', input: def.name };
        values[def.name] = raw;
    }
    return { ok: true, values, files };
}

function acceptMatches(accept, file) {
    const name = (file.originalName || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    return accept.some(rule => {
        const r = rule.toLowerCase();
        if (r.startsWith('.')) return name.endsWith(r);
        if (r.endsWith('/*')) return mime.startsWith(r.slice(0, -1));
        return mime === r;
    });
}

/**
 * Converts `{{NAME}}` placeholders in a script to `"$NAME"` (quoted), once, when the script is
 * saved - never at run time. This is what lets the editor accept the friendlier {{...}} syntax
 * while the actual execution only ever sees shell variable references.
 */
function normalizeScript(script) {
    return String(script ?? '').replace(/\{\{\s*([A-Z_][A-Z0-9_]*)\s*\}\}/g, '"$$$1"');
}

module.exports = { validateDefs, resolveInputs, normalizeScript, NAME_RE, TYPES };
