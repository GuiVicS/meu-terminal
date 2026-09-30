/**
 * sound.js
 * Short notification chime made with Web Audio (no audio file to download). Browsers
 * only allow sound after the user touched the page once, so the context is unlocked on
 * the first interaction.
 */
let ctx = null;

function context() {
    if (!ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        ctx = new AudioCtx();
    }
    return ctx;
}

// Unlock on the first touch/click/key so later chimes can play
const unlock = () => {
    const c = context();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
};
['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, unlock, { once: true, capture: true }));

/** Two soft rising notes (~0.4s). Silently does nothing when audio isn't allowed yet. */
export function playChime() {
    const c = context();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    const now = c.currentTime;
    [[880, 0], [1318.5, 0.14]].forEach(([freq, at]) => {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + at);
        gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.32);
        osc.connect(gain).connect(c.destination);
        osc.start(now + at);
        osc.stop(now + at + 0.35);
    });
    try {
        navigator.vibrate?.([120, 60, 120]);
    } catch { /* needs a user gesture on some browsers */ }
}
