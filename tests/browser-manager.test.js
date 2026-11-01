const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { clearForeignProfileLock, PipeCdp } = require('../scripts/browser-manager');

function profileWithLock(target) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-profile-'));
    if (target) {
        fs.symlinkSync(target, path.join(dir, 'SingletonLock'));
        fs.symlinkSync('12345', path.join(dir, 'SingletonCookie'));
        fs.symlinkSync('/tmp/nao-existe/SingletonSocket', path.join(dir, 'SingletonSocket'));
    }
    return dir;
}
const has = (dir, name) => { try { fs.lstatSync(path.join(dir, name)); return true; } catch { return false; } };

test('profile lock: removes a lock left by another hostname (recreated container)', () => {
    const dir = profileWithLock('e18414e00dcb-14019');
    assert.strictEqual(clearForeignProfileLock(dir, 'cd5a82a01ca8'), true);
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) assert.strictEqual(has(dir, name), false, name);
});

test('profile lock: keeps a lock from this hostname (Chromium checks the PID itself)', () => {
    const dir = profileWithLock('cd5a82a01ca8-899');
    assert.strictEqual(clearForeignProfileLock(dir, 'cd5a82a01ca8'), false);
    assert.strictEqual(has(dir, 'SingletonLock'), true);
});

test('profile lock: handles hostnames with dashes and a missing lock', () => {
    const dir = profileWithLock('meu-servidor-42');
    assert.strictEqual(clearForeignProfileLock(dir, 'meu-servidor'), false);
    assert.strictEqual(clearForeignProfileLock(profileWithLock(null), 'x'), false);
});

test('PipeCdp: a pipe error (Chromium exited) does not crash the server', async () => {
    const proc = new EventEmitter();
    proc.stdio = [null, null, null, new PassThrough(), new PassThrough()];
    const logs = [];
    const cdp = new PipeCdp(proc, (...a) => logs.push(a.join(' ')));
    const pending = cdp.send('Browser.getVersion');
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    proc.stdio[3].emit('error', err); // would throw "Unhandled 'error' event" without a listener
    proc.stdio[4].emit('error', err);
    proc.emit('exit', 21, null);
    await assert.rejects(pending, /Chromium encerrou/);
    assert.strictEqual(logs.length, 2);
});
