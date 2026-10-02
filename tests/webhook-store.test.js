const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const WebhookStore = require('../scripts/webhook-store');

process.env.WEBHOOK_SECRET_KEY = process.env.WEBHOOK_SECRET_KEY || 'test-secret-key-not-for-prod';

const make = () => new WebhookStore(new DatabaseSync(':memory:'));

test('create: slugifies the name, normalizes the script, and never leaks internal input fields', () => {
    const s = make();
    const r = s.create({
        name: 'Minha Ação!', script: 'echo {{BRANCH}}',
        inputs: [{ name: 'branch', label: 'Branch', type: 'text', pattern: '^[a-z]+$' }],
    });
    assert.equal(r.ok, true);
    assert.match(r.webhook.slug, /^[a-z0-9-]+$/);
    assert.equal(r.webhook.script, 'echo "$BRANCH"'); // {{VAR}} normalized at save time
    assert.equal(r.webhook.inputs[0].name, 'BRANCH');
    assert.equal('_pattern' in r.webhook.inputs[0], false);
    assert.equal('_extract' in r.webhook.inputs[0], false);
});

test('create: rejects a duplicate slug and invalid input defs', () => {
    const s = make();
    s.create({ name: 'A', slug: 'dup' });
    const clash = s.create({ name: 'B', slug: 'dup' });
    assert.equal(clash.ok, false);
    const badInput = s.create({ name: 'Webhook C', inputs: [{ name: 'bad name' }] });
    assert.equal(badInput.ok, false);
    assert.match(badInput.error, /nome de input/i);
});

test('update: bumps the version only when script/inputs actually change', () => {
    const s = make();
    const { webhook } = s.create({ name: 'Webhook A', script: 'echo 1' });
    assert.deepEqual(s.versions(webhook.id).map(v => v.version), [1]);

    s.update(webhook.id, { description: 'nova descrição' }); // no script/inputs change
    assert.deepEqual(s.versions(webhook.id).map(v => v.version), [1]);

    s.update(webhook.id, { script: 'echo 2' });
    assert.deepEqual(s.versions(webhook.id).map(v => v.version), [2, 1]);
});

test('duplicate: copies fields with a free slug and no tokens', () => {
    const s = make();
    const { webhook } = s.create({ name: 'Original', slug: 'original', script: 'echo hi' });
    s.createToken(webhook.id, 'token 1');
    const r = s.duplicate(webhook.id);
    assert.equal(r.ok, true);
    assert.notEqual(r.webhook.id, webhook.id);
    assert.equal(r.webhook.slug, 'original-copia');
    assert.equal(r.webhook.script, 'echo hi');
    assert.deepEqual(s.listTokens(r.webhook.id), []);
});

test('tokens: created once (shown in full), stored hashed, found by slug + bearer, revocable', () => {
    const s = make();
    const { webhook } = s.create({ name: 'Webhook A', slug: 'webhook-a' });
    const { token } = s.createToken(webhook.id, 'ci');

    const found = s.findByToken('webhook-a', token);
    assert.equal(found.webhook.id, webhook.id);
    assert.equal(s.findByToken('webhook-a', 'mtwh_wrong-token-value-xxxxxxxxxxxxxxxxxxxxxxxx'), null);
    assert.equal(s.findByToken('no-such-slug', token), null);

    const [row] = s.listTokens(webhook.id);
    assert.ok(row.lastUsedAt); // bumped by findByToken above
    assert.equal(s.revokeToken(webhook.id, row.id), true);
    assert.equal(s.findByToken('webhook-a', token), null, 'a revoked token must stop working');
});

test('secrets: an input\'s "fixed" secret value round-trips encrypted, decrypted only via getSecretInput', () => {
    const s = make();
    const { webhook } = s.create({ name: 'Webhook A' });
    s.setSecretInput(webhook.id, 'API_KEY', 'sk-abc123');
    assert.equal(s.getSecretInput(webhook.id, 'API_KEY'), 'sk-abc123');
    assert.equal(s.getSecretInput(webhook.id, 'NOPE'), undefined);
});

test('runs: createRun masks "secret" input values, finishRun records the result, history is newest first', () => {
    const s = make();
    const { webhook } = s.create({
        name: 'Webhook A', inputs: [{ name: 'TOKEN', type: 'secret' }, { name: 'BRANCH', type: 'text' }],
    });
    s.createRun({ id: 'r1', webhookId: webhook.id, trigger: 'manual', values: { TOKEN: 'shh', BRANCH: 'main' }, startedAt: 1 });
    s.finishRun('r1', { status: 'ok', exitCode: 0, output: 'done', finishedAt: 2 });

    const [run] = s.runs(webhook.id);
    assert.equal(run.inputs.TOKEN, '••••');
    assert.equal(run.inputs.BRANCH, 'main');
    assert.equal(run.status, 'ok');
    assert.equal(s.getRun(webhook.id, 'r1').output, 'done');
});
