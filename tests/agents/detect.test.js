const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectAgents, acpModeFrom } = require('../../scripts/agents/detect');

function exe(dir, name) {
    const f = path.join(dir, name);
    fs.writeFileSync(f, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return f;
}

test('detecção: adaptador *-acp e CLI que mostra o ACP na ajuda entram; sem ACP, não', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-detect-'));
    const bin = path.join(home, '.local', 'bin');
    fs.mkdirSync(bin, { recursive: true });
    exe(bin, 'claude-agent-acp');       // já conhecido: não repete
    exe(bin, 'gemini');                 // ajuda mostra --experimental-acp
    exe(bin, 'goose');                  // ajuda sem acp: fica de fora
    exe(bin, 'droid-acp');              // adaptador genérico
    const helps = {
        gemini: 'Options:\n  --model  modelo\n  --experimental-acp  Starts the agent in ACP mode\n',
        goose: 'Commands:\n  session  Start\n  run  Run\n',
    };
    const known = { claude: { command: 'claude-agent-acp' }, agy: { command: process.execPath, requires: 'agy' } };
    const { found, paths } = await detectAgents({ known, env: { PATH: '' }, home, helpImpl: async f => helps[path.basename(f)] || '' });
    assert.deepEqual(Object.keys(found).sort(), ['droid', 'gemini']);
    assert.deepEqual(found.gemini.args, ['--experimental-acp']);
    assert.equal(found.droid.command, path.join(bin, 'droid-acp'));
    assert.equal(paths.claude, path.join(bin, 'claude-agent-acp'));
    assert.equal(paths.agy, undefined);
    fs.rmSync(home, { recursive: true, force: true });
});

test('detecção: subcomando "acp" só conta quando listado como comando na ajuda', () => {
    assert.deepEqual(acpModeFrom('Commands:\n  acp   Run as ACP agent\n  run\n', [['acp']]), ['acp']);
    assert.equal(acpModeFrom('see https://x.dev/acp for more', [['acp']]), null);
    assert.deepEqual(acpModeFrom('  --acp  ACP mode', [['--experimental-acp'], ['--acp']]), ['--acp']);
});
