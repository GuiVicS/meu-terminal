const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDefs, resolveInputs, normalizeScript } = require('../scripts/webhook-inputs');

test('validateDefs: normalizes a good definition and rejects bad names', () => {
    const ok = validateDefs([{ name: 'branch', label: 'Branch', type: 'text', default: 'main' }]);
    assert.equal(ok.ok, true);
    assert.equal(ok.defs[0].name, 'BRANCH'); // uppercased, so it matches the $VAR convention

    assert.equal(validateDefs([{ name: 'bad name!' }]).ok, false);
    assert.equal(validateDefs([{ name: 'A' }, { name: 'a' }]).ok, false); // duplicate once uppercased
});

test('validateDefs: select requires options; bad pattern/extract are rejected', () => {
    assert.equal(validateDefs([{ name: 'X', type: 'select' }]).ok, false);
    assert.equal(validateDefs([{ name: 'X', type: 'select', options: ['a', 'b'] }]).ok, true);
    assert.equal(validateDefs([{ name: 'X', pattern: '(unclosed' }]).ok, false);
    assert.equal(validateDefs([{ name: 'X', extract: '(unclosed' }]).ok, false);
});

test('resolveInputs: required/default, and type coercion for boolean/select/number', () => {
    const defs = validateDefs([
        { name: 'REQ', type: 'text', required: true },
        { name: 'DEF', type: 'text', default: 'oi' },
        { name: 'ON', type: 'boolean' },
        { name: 'KIND', type: 'select', options: ['a', 'b'] },
    ]).defs;

    const missing = resolveInputs(defs, { body: {} });
    assert.equal(missing.ok, false);
    assert.equal(missing.input, 'REQ');

    const r = resolveInputs(defs, { body: { req: 'x', on: '1', kind: 'b' } });
    assert.equal(r.ok, true);
    assert.equal(r.values.REQ, 'x');
    assert.equal(r.values.DEF, 'oi');
    assert.equal(r.values.ON, 'true');
    assert.equal(r.values.KIND, 'b');

    assert.equal(resolveInputs(defs, { body: { req: 'x', kind: 'z' } }).ok, false);
});

test('resolveInputs: "source" reads from body/query/header; "fixed" only comes from manual', () => {
    const defs = validateDefs([
        { name: 'A', type: 'text', source: 'body.ref' },
        { name: 'B', type: 'text', source: 'query.b' },
        { name: 'C', type: 'text', source: 'header.x-event' },
        { name: 'D', type: 'text', source: 'fixed', default: 'nope' },
    ]).defs;
    const r = resolveInputs(defs, { body: { ref: 'v1' }, query: { b: 'v2' }, headers: { 'x-event': 'v3' } });
    assert.equal(r.ok, true);
    assert.equal(r.values.A, 'v1');
    assert.equal(r.values.B, 'v2');
    assert.equal(r.values.C, 'v3');
    assert.equal(r.values.D, 'nope'); // fixed with no manual value falls back to default

    const manual = resolveInputs(defs, { manual: { A: 'm1', D: 'm4' } });
    assert.equal(manual.values.A, 'm1');
    assert.equal(manual.values.D, 'm4');
});

test('resolveInputs: extract pulls a capture group out of the raw value (e.g. GitHub\'s ref)', () => {
    const defs = validateDefs([{ name: 'BRANCH', type: 'text', source: 'body.ref', extract: '^refs/heads/(.+)$' }]).defs;
    const ok = resolveInputs(defs, { body: { ref: 'refs/heads/main' } });
    assert.equal(ok.values.BRANCH, 'main');
    const bad = resolveInputs(defs, { body: { ref: 'refs/tags/v1' } });
    assert.equal(bad.ok, false);
});

test('resolveInputs: extract/pattern still work after a storage round-trip (no _extract/_pattern on the defs, only the strings)', () => {
    // webhook-store.js only ever keeps `extract`/`pattern` (strings) in the DB - never the compiled
    // _extract/_pattern validateDefs() attaches (serializeDefs() in webhook-store.js strips them
    // before every write, on purpose - see the leak it fixed). Simulate a webhook loaded back from
    // storage: the same strip, then a JSON round-trip (storage is JSON text either way).
    const stripped = validateDefs([
        { name: 'BRANCH', type: 'text', source: 'body.ref', extract: '^refs/heads/(.+)$' },
        { name: 'X', type: 'text', pattern: '^[a-z]+$' },
    ]).defs.map(({ _pattern, _extract, ...rest }) => rest);
    const saved = JSON.parse(JSON.stringify(stripped));
    assert.equal('_extract' in saved[0], false);
    assert.equal('_pattern' in saved[1], false);

    const ok = resolveInputs(saved, { body: { ref: 'refs/heads/main', x: 'abc' } });
    assert.equal(ok.ok, true);
    assert.equal(ok.values.BRANCH, 'main');
    assert.equal(ok.values.X, 'abc');

    assert.equal(resolveInputs(saved, { body: { ref: 'refs/heads/main', x: 'ABC' } }).ok, false);
});

test('resolveInputs: a shell metacharacter value is treated as a plain string (never special)', () => {
    const defs = validateDefs([{ name: 'X', type: 'text' }]).defs;
    const malicious = 'main; rm -rf ~ && echo $(whoami) `id`';
    const r = resolveInputs(defs, { body: { x: malicious } });
    assert.equal(r.ok, true);
    assert.equal(r.values.X, malicious); // passed through untouched - it becomes an env var, never parsed as shell
});

test('resolveInputs: newlines and oversize values are rejected by the type\'s default shape', () => {
    const defs = validateDefs([{ name: 'X', type: 'text' }]).defs;
    assert.equal(resolveInputs(defs, { body: { x: 'line1\nline2' } }).ok, false);
    assert.equal(resolveInputs(defs, { body: { x: 'a'.repeat(600) } }).ok, false); // default text max is 500
});

test('resolveInputs: file type checks size and accept list, never touches the content as a string', () => {
    const defs = validateDefs([{ name: 'ANEXO', type: 'file', maxSizeMb: 1, accept: ['.pdf'] }]).defs;
    const tooBig = resolveInputs(defs, { files: { ANEXO: { path: '/tmp/x', size: 2 * 1024 * 1024, originalName: 'a.pdf' } } });
    assert.equal(tooBig.ok, false);
    const wrongType = resolveInputs(defs, { files: { ANEXO: { path: '/tmp/x', size: 10, originalName: 'a.exe' } } });
    assert.equal(wrongType.ok, false);
    const ok = resolveInputs(defs, { files: { ANEXO: { path: '/tmp/x', size: 10, originalName: 'a.pdf' } } });
    assert.equal(ok.ok, true);
    assert.equal(ok.files.ANEXO, '/tmp/x');
});

test('resolveInputs: secret-type inputs are never read from the caller (webhook-store.js\'s resolveSecrets() fills them in afterwards)', () => {
    const defs = validateDefs([{ name: 'API_KEY', type: 'secret', required: true }, { name: 'X', type: 'text' }]).defs;
    const r = resolveInputs(defs, { body: { api_key: 'attacker-supplied', x: 'ok' } });
    assert.equal(r.ok, true); // "required" is not enforced here for secrets - see resolveSecrets()
    assert.equal('API_KEY' in r.values, false);
    assert.equal(r.values.X, 'ok');
});

test('normalizeScript: converts {{VAR}} to a quoted $VAR, once, at save time', () => {
    assert.equal(normalizeScript('git checkout {{BRANCH}}'), 'git checkout "$BRANCH"');
    assert.equal(normalizeScript('echo "$ALREADY_QUOTED"'), 'echo "$ALREADY_QUOTED"'); // untouched
    assert.equal(normalizeScript('{{A}} and {{B}}'), '"$A" and "$B"');
});
