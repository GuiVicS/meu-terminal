const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const { runProcess, mask } = require('../scripts/process-runner');

const env = { PATH: process.env.PATH, HOME: os.homedir() };
const bash = (script, extra = {}) => runProcess({ command: 'bash', args: ['-c', script], env, timeoutMs: 10_000, ...extra });

test('runProcess: exit code, stdout and stderr together', async () => {
    const r = await bash('echo saida; echo erro >&2; exit 3');
    assert.equal(r.exitCode, 3);
    assert.match(r.output, /saida/);
    assert.match(r.output, /erro/);
    assert.equal(r.timedOut, false);
    assert.equal(typeof r.durationMs, 'number');
});

test('runProcess: only the given environment is visible', async () => {
    process.env.MT_TEST_SHOULD_NOT_LEAK = 'vazou';
    const r = await bash('echo "[${MT_TEST_SHOULD_NOT_LEAK:-}][$ONLY_THIS]"', { env: { ...env, ONLY_THIS: 'ok' } });
    delete process.env.MT_TEST_SHOULD_NOT_LEAK;
    assert.match(r.output, /\[\]\[ok\]/);
});

test('runProcess: timeout kills the whole process group', { skip: process.platform === 'win32' }, async () => {
    const started = Date.now();
    const r = await bash('sleep 30 & sleep 30; wait', { timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 5000, 'returned long before the sleeps would end');
});

test('runProcess: output is capped and marked as truncated', async () => {
    const r = await bash('head -c 200000 /dev/zero | tr "\\0" a', { maxOutputBytes: 1024 });
    assert.equal(r.truncated, true);
    assert.ok(r.output.length < 200000);
    assert.match(r.output, /\[saída truncada\]$/);
});

test('runProcess: secrets are masked; a missing command is reported, not thrown', async () => {
    const r = await bash('echo token=abc123xyz', { secrets: ['abc123xyz'] });
    assert.doesNotMatch(r.output, /abc123xyz/);
    assert.match(r.output, /token=••••/);
    const missing = await runProcess({ command: '/nao/existe', env, timeoutMs: 5000 });
    assert.equal(missing.exitCode, null);
    assert.match(missing.output, /erro ao iniciar/);
});

test('mask: every occurrence, empty secrets ignored', () => {
    assert.equal(mask('a-x-a', ['a', '']), '••••-x-••••');
});
