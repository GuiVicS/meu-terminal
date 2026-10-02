const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const BackupStore = require('../scripts/backup-store');

const make = () => new BackupStore(new DatabaseSync(':memory:'));

test('get: default config is disabled with sane defaults', () => {
    const s = make();
    const cfg = s.get();
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.remote, '');
    assert.equal(cfg.remotePath, 'meuterminal-backup');
    assert.equal(cfg.intervalHours, 24);
    assert.equal(cfg.keepLast, 7);
    assert.deepEqual(cfg.paths, []);
    assert.equal(cfg.lastRunAt, null);
});

test('update: patches only given fields, trims the remote path and clamps numbers', () => {
    const s = make();
    const cfg = s.update({ enabled: true, remote: 'gdrive', remotePath: '/pasta/sub/', paths: ['~/projetos', '~/projetos', '  '] });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.remote, 'gdrive');
    assert.equal(cfg.remotePath, 'pasta/sub');
    assert.deepEqual(cfg.paths, ['~/projetos']);
    assert.equal(cfg.intervalHours, 24); // untouched

    const clamped = s.update({ intervalHours: 0, keepLast: 10000 });
    assert.equal(clamped.intervalHours, 1);
    assert.equal(clamped.keepLast, 365);
    assert.equal(clamped.remote, 'gdrive'); // still untouched by this call
});

test('recordRun: updates the config "last" fields and appends to history, newest first', () => {
    const s = make();
    s.recordRun({ trigger: 'manual', status: 'ok', sizeBytes: 1000, startedAt: 1, finishedAt: 2 });
    s.recordRun({ trigger: 'scheduled', status: 'error', error: 'sem remote', startedAt: 3, finishedAt: 4 });

    const cfg = s.get();
    assert.equal(cfg.lastRunAt, 4);
    assert.equal(cfg.lastStatus, 'error');
    assert.equal(cfg.lastError, 'sem remote');

    const history = s.history();
    assert.equal(history.length, 2);
    assert.deepEqual(history.map(r => r.trigger), ['scheduled', 'manual']);
    assert.equal(history[0].error, 'sem remote');
    assert.equal(history[1].sizeBytes, 1000);
});

test('recordRun: history is capped at 50 entries', () => {
    const s = make();
    for (let i = 0; i < 55; i++) s.recordRun({ trigger: 'manual', status: 'ok', sizeBytes: i, startedAt: i, finishedAt: i });
    assert.equal(s.history(50).length, 50);
    // the 50 kept are the most recent (highest started_at)
    assert.equal(s.history(1)[0].sizeBytes, 54);
});
