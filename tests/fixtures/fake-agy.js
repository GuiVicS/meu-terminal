/**
 * fake-agy.js
 * Stand-in for `agy --input-format stream-json --output-format stream-json -p=`: prints `init`,
 * then for each NDJSON user line runs a scripted turn (a tool, some text, `result`).
 * `models` prints the model list like `agy models`.
 */
const readline = require('readline');

if (process.argv[2] === 'models') {
    process.stdout.write('Fetching available models...\nfake-fast\tFake Fast\nfake-pro\tFake Pro\n');
    process.exit(0);
}
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const conversation = arg('--conversation') || 'conv-1';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), tools: [], permission_mode: arg('--mode') || 'default' } });
let step = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    const text = msg.message.content;
    const tool = { name: 'view_file', parameters: { AbsolutePath: '/tmp/a.txt' } };
    out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step++, state: 'ACTIVE', step_type: 'tool', tool_name: 'view_file', tool_info: tool } });
    out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step - 1, state: 'DONE', step_type: 'tool', tool_name: 'view_file', tool_info: { ...tool, output: '1 line' } } });
    out({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step++, state: 'ACTIVE', step_type: 'agent_response', text_delta: `eco: ${text} [${arg('--model') || 'default'}/${arg('--mode') || 'default'}]` } });
    out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: 'ok', usage: { total_tokens: 42 } } });
});
