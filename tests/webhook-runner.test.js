const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebhookRunner = require('../scripts/webhook-runner');

/** A minimal store stub: just enough for the runner to call createRun()/finishRun(). */
function fakeStore() {
    const runs = new Map();
    return {
        createRun: r => runs.set(r.id, { ...r, status: 'running' }),
        finishRun: (id, patch) => runs.set(id, { ...runs.get(id), ...patch }),
        get: id => runs.get(id),
    };
}

function webhook(script, extra = {}) {
    return { id: 'w1', slug: 'test', enabled: true, script, cwd: os.tmpdir(), timeoutSec: 10, concurrency: 'queue', ...extra };
}

test('run: a plain script succeeds and its output is captured', async () => {
    const runner = new WebhookRunner({ store: fakeStore() });
    const r = await runner.run(webhook('echo hello'), { trigger: 'test', values: {} });
    assert.equal(r.status, 'ok');
    assert.equal(r.exitCode, 0);
    assert.match(r.output, /hello/);
});

test('run: a failing script (exit 1, "pipefail -u -e") is reported as failed', async () => {
    const runner = new WebhookRunner({ store: fakeStore() });
    const r = await runner.run(webhook('exit 1'), { trigger: 'test', values: {} });
    assert.equal(r.status, 'failed');
    assert.equal(r.exitCode, 1);
});

test('run: an input value is only ever an env var - shell metacharacters in it do nothing', async () => {
    const runner = new WebhookRunner({ store: fakeStore() });
    const marker = path.join(os.tmpdir(), `wh-marker-${process.pid}-${Date.now()}`);
    const outFile = path.join(os.tmpdir(), `wh-out-${process.pid}-${Date.now()}`);
    // Every classic injection vector in one value: command substitution, backticks, chaining, quote breakout.
    const malicious = `"; touch ${marker}; echo "pwn && $(touch ${marker}) \`touch ${marker}\` | touch ${marker}`;
    const script = 'echo "$BRANCH" > "$OUT_FILE"';
    try {
        const r = await runner.run(webhook(script), {
            trigger: 'test',
            values: { BRANCH: malicious, OUT_FILE: outFile },
        });
        assert.equal(r.status, 'ok');
        // The value round-trips exactly - it was never re-parsed as shell syntax.
        assert.equal(fs.readFileSync(outFile, 'utf8').trim(), malicious);
        // None of the injected side effects happened.
        assert.equal(fs.existsSync(marker), false);
    } finally {
        fs.rmSync(outFile, { force: true });
        fs.rmSync(marker, { force: true });
    }
});

test('run: the temp script file on disk is always exactly webhook.script, regardless of input values', async () => {
    // Indirect check: if a value ever leaked into the script source, "rm -rf" below would delete the probe dir.
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-probe-'));
    const probeFile = path.join(probe, 'still-here');
    fs.writeFileSync(probeFile, 'x');
    const runner = new WebhookRunner({ store: fakeStore() });
    await runner.run(webhook('true'), { trigger: 'test', values: { X: `rm -rf ${probe}` } });
    assert.ok(fs.existsSync(probeFile));
    fs.rmSync(probe, { recursive: true, force: true });
});

test('run: secret values are masked out of the captured output', async () => {
    const runner = new WebhookRunner({ store: fakeStore() });
    const r = await runner.run(webhook('echo "token is $TOKEN"'), {
        trigger: 'test', values: { TOKEN: 'supersecreto' }, secretValues: ['supersecreto'],
    });
    assert.equal(r.status, 'ok');
    assert.doesNotMatch(r.output, /supersecreto/);
    assert.match(r.output, /••••/);
});

test('run: a script past its timeout is killed and reported as "timeout"', async () => {
    const runner = new WebhookRunner({ store: fakeStore() });
    const r = await runner.run(webhook('sleep 5', { timeoutSec: 1 }), { trigger: 'test', values: {} });
    assert.equal(r.status, 'timeout');
}, { timeout: 10000 });

test('run: concurrency "skip" rejects a second run while one is active', async () => {
    const runner = new WebhookRunner({ store: fakeStore() });
    const wh = webhook('sleep 1', { concurrency: 'skip' });
    const first = runner.run(wh, { trigger: 'test', values: {} });
    await new Promise(r => setTimeout(r, 100)); // let the first one actually start
    await assert.rejects(runner.run(wh, { trigger: 'test', values: {} }), /em andamento/);
    await first;
});

test('run: a disabled webhook refuses to run outside a "test" trigger', async () => {
    const runner = new WebhookRunner({ store: fakeStore() });
    await assert.rejects(runner.run(webhook('true', { enabled: false }), { trigger: 'http', values: {} }), /desativado/);
});
