const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { VercelDeploy, extractUrl, lastLine } = require('../scripts/vercel-deploy');

/** A fake child_process.spawn(): records what it was called with and scripts its own events. */
function fakeChild(script) {
    const calls = [];
    const spawnImpl = (command, args, opts) => {
        calls.push({ command, args, opts });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = (...a) => { child.killed = a; };
        setImmediate(() => script(child));
        return child;
    };
    return { spawnImpl, calls };
}

test('extractUrl: picks the last https URL, trimming trailing punctuation', () => {
    assert.equal(extractUrl('Deploying...\nhttps://my-app.vercel.app\n'), 'https://my-app.vercel.app');
    assert.equal(extractUrl('see https://a.vercel.app, then https://b.vercel.app.'), 'https://b.vercel.app');
    assert.equal(extractUrl('no links here'), null);
});

test('lastLine: the last non-empty trimmed line', () => {
    assert.equal(lastLine('  \nError: build failed\n\n'), 'Error: build failed');
    assert.equal(lastLine(''), '');
});

test('configured: false with no token, true with one', () => {
    assert.equal(new VercelDeploy({ token: '' }).configured, false);
    assert.equal(new VercelDeploy({ token: 'abc' }).configured, true);
});

test('deploy: rejects immediately, never spawning, when no token is configured', async () => {
    const { spawnImpl, calls } = fakeChild(() => {});
    const deployer = new VercelDeploy({ token: '', spawnImpl });
    await assert.rejects(deployer.deploy('/tmp/project'), /VERCEL_TOKEN/);
    assert.equal(calls.length, 0);
});

test('deploy: resolves with the deployment URL on exit 0, run with the right args/cwd', async () => {
    const { spawnImpl, calls } = fakeChild(child => {
        child.stdout.emit('data', 'Building...\n');
        child.stdout.emit('data', 'https://my-project-abc.vercel.app\n');
        child.emit('close', 0);
    });
    const deployer = new VercelDeploy({ token: 'tok_123', spawnImpl });
    const url = await deployer.deploy('/srv/projetos/loja');
    assert.equal(url, 'https://my-project-abc.vercel.app');
    assert.equal(calls[0].command, 'vercel');
    assert.deepEqual(calls[0].args, ['deploy', '--prod', '--yes', '--token=tok_123']);
    assert.equal(calls[0].opts.cwd, '/srv/projetos/loja');
});

test('deploy: a non-zero exit rejects with the CLI\'s own last error line', async () => {
    const { spawnImpl } = fakeChild(child => {
        child.stderr.emit('data', 'Error: Missing project configuration\n');
        child.emit('close', 1);
    });
    const deployer = new VercelDeploy({ token: 'tok', spawnImpl });
    await assert.rejects(deployer.deploy('/tmp/x'), /Missing project configuration/);
});

test('deploy: exit 0 with no URL in the output is still a rejection, not a silent success', async () => {
    const { spawnImpl } = fakeChild(child => {
        child.stdout.emit('data', 'done, but forgot to print a link\n');
        child.emit('close', 0);
    });
    const deployer = new VercelDeploy({ token: 'tok', spawnImpl });
    await assert.rejects(deployer.deploy('/tmp/x'), /não encontrei a URL/);
});

test('deploy: the CLI missing entirely (ENOENT) gets a clear install hint, not a raw error', async () => {
    const { spawnImpl } = fakeChild(child => {
        const err = new Error('spawn vercel ENOENT');
        err.code = 'ENOENT';
        child.emit('error', err);
    });
    const deployer = new VercelDeploy({ token: 'tok', spawnImpl });
    await assert.rejects(deployer.deploy('/tmp/x'), /não instalado/);
});

test('deploy: a stuck process is killed and reported once its timeout passes', async () => {
    const { spawnImpl } = fakeChild(() => {}); // never closes
    const deployer = new VercelDeploy({ token: 'tok', timeoutMs: 20, spawnImpl });
    await assert.rejects(deployer.deploy('/tmp/x'), /demorou demais/);
});
