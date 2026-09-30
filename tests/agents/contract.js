/**
 * contract.js
 * Shared checks for the agent event contract: every adapter, fake or real, must produce a
 * valid, gap-free event sequence for a scripted conversation. Used by the *.test.js files.
 */
const assert = require('node:assert/strict');
const { validateEvent } = require('../../scripts/agents/events');

/** Asserts every event is valid and seq goes 1, 2, 3... without gaps. */
function assertValidSequence(events) {
    assert.ok(events.length > 0, 'no events');
    events.forEach((event, i) => {
        assert.deepEqual(validateEvent(event), [], `event #${i} (${event.type}) is invalid`);
        assert.equal(event.seq, events[0].seq + i, `seq gap at event #${i}`);
    });
}

/** Asserts the shape of one finished turn: user message ... done ... back to idle. */
function assertTurn(events) {
    const types = events.map(e => e.type);
    const user = types.indexOf('message.user');
    const done = types.indexOf('message.assistant.done');
    assert.ok(user >= 0, 'turn has no message.user');
    assert.ok(done > user, 'turn has no message.assistant.done after the user message');
    const last = events.filter(e => e.type === 'status').pop();
    assert.equal(last && last.data.state, 'idle', 'session did not go back to idle');
    // Every tool that finished must have started first
    const started = new Set();
    for (const e of events) {
        if (e.type === 'tool.start') started.add(e.data.toolId);
        if (e.type === 'tool.result') assert.ok(started.has(e.data.toolId), `tool.result before tool.start (${e.data.toolId})`);
    }
}

/** Resolves with the first event matching `predicate` (or rejects after timeoutMs). */
function waitForEvent(gateway, predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            gateway.off('event', listener);
            reject(new Error('timed out waiting for event'));
        }, timeoutMs);
        const listener = (event) => {
            if (!predicate(event)) return;
            clearTimeout(timer);
            gateway.off('event', listener);
            resolve(event);
        };
        gateway.on('event', listener);
    });
}

module.exports = { assertValidSequence, assertTurn, waitForEvent };
