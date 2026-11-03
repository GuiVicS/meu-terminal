const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startedInTerminal } = require('../../scripts/agents/history-files');

test('terminal: só a sessão interativa conta; sdk, subagente e arquivo ausente não', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-hist-'));
    const dir = path.join(home, '.claude', 'projects', '-root');
    fs.mkdirSync(dir, { recursive: true });
    const write = (id, line) => fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify(line)}\n`);
    write('aaaaaaa1', { entrypoint: 'cli' });
    write('aaaaaaa2', { entrypoint: 'sdk-ts' });
    assert.equal(startedInTerminal('claude', 'aaaaaaa1', home), true);
    assert.equal(startedInTerminal('claude', 'aaaaaaa2', home), false);
    assert.equal(startedInTerminal('claude', 'naoexiste', home), false);
    assert.equal(startedInTerminal('claude', '../../x', home), false);
    assert.equal(startedInTerminal('opencode', 'aaaaaaa1', home), false);
    const cdir = path.join(home, '.codex', 'sessions', '2026');
    fs.mkdirSync(cdir, { recursive: true });
    const cw = (id, payload) => fs.writeFileSync(path.join(cdir, `rollout-x-${id}.jsonl`), `${JSON.stringify({ payload })}\n`);
    cw('ccccccc1', { originator: 'codex-tui', source: 'cli' });
    cw('ccccccc2', { originator: 'codex-tui', source: { subagent: 'review' } });
    cw('ccccccc3', { originator: 'codex_exec', source: 'exec' });
    assert.equal(startedInTerminal('codex', 'ccccccc1', home), true);
    assert.equal(startedInTerminal('codex', 'ccccccc2', home), false);
    assert.equal(startedInTerminal('codex', 'ccccccc3', home), false);
});
