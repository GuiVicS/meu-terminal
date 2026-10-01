/**
 * diff.js
 * Line diff for the agent's file edits (old text -> new text), rendered as unified hunks with
 * a few context lines. New files show every line as added. Large inputs fall back to a summary.
 */
import { esc } from './markdown.js';

const CONTEXT = 3;
const MAX_CELLS = 4_000_000; // LCS table limit (lines_a * lines_b); beyond it, show the new text

/** Longest-common-subsequence line diff -> [{ op: ' ' | '-' | '+', text }] */
export function diffLines(oldText, newText) {
    const a = oldText ? oldText.replace(/\r\n?/g, '\n').split('\n') : [];
    const b = (newText ?? '').replace(/\r\n?/g, '\n').split('\n');
    // Trim the common prefix/suffix first: edits usually touch a small region
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const ops = a.slice(0, start).map(text => ({ op: ' ', text }));

    if (midA.length * midB.length > MAX_CELLS) {
        ops.push(...midA.map(text => ({ op: '-', text })), ...midB.map(text => ({ op: '+', text })));
    } else {
        // lcs[i][j] = LCS length of midA[i..] and midB[j..]
        const n = midA.length;
        const m = midB.length;
        const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && midA[i] === midB[j]) {
                ops.push({ op: ' ', text: midA[i++] });
                j++;
            } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
                // removals first, like a unified diff (-old then +new)
                ops.push({ op: '-', text: midA[i++] });
            } else {
                ops.push({ op: '+', text: midB[j++] });
            }
        }
    }
    ops.push(...a.slice(endA).map(text => ({ op: ' ', text })));
    return ops;
}

/** { added, removed } line counts, for the card summary ("+12 −3"). */
export function diffStats(ops) {
    let added = 0;
    let removed = 0;
    for (const o of ops) {
        if (o.op === '+') added++;
        else if (o.op === '-') removed++;
    }
    return { added, removed };
}

/**
 * Renders the diff as HTML: changed lines with CONTEXT lines around them, gaps collapsed.
 * @param {{ path: string, oldText: string|null, newText: string }} diff
 */
export function renderDiff(diff) {
    const ops = diffLines(diff.oldText, diff.newText);
    const keep = new Uint8Array(ops.length);
    ops.forEach((o, idx) => {
        if (o.op === ' ') return;
        for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) keep[k] = 1;
    });
    const rows = [];
    let oldLine = 1;
    let newLine = 1;
    let skipped = 0;
    ops.forEach((o, idx) => {
        const show = keep[idx] || diff.oldText == null; // new file: show it all
        if (!show) {
            skipped++;
        } else {
            if (skipped) rows.push(`<tr class="gap"><td colspan="3">⋯ ${skipped} linhas iguais</td></tr>`);
            skipped = 0;
            const cls = o.op === '+' ? 'add' : o.op === '-' ? 'del' : 'ctx';
            const num = o.op === '+' ? newLine : oldLine;
            rows.push(`<tr class="${cls}"><td class="ln">${num}</td><td class="sign">${o.op === ' ' ? '' : o.op === '-' ? '−' : '+'}</td><td class="txt">${esc(o.text) || ' '}</td></tr>`);
        }
        if (o.op !== '+') oldLine++;
        if (o.op !== '-') newLine++;
    });
    if (skipped) rows.push(`<tr class="gap"><td colspan="3">⋯ ${skipped} linhas iguais</td></tr>`);
    const { added, removed } = diffStats(ops);
    return {
        html: `<div class="diff"><table>${rows.join('')}</table></div>`,
        added,
        removed,
    };
}
