/**
 * textSelection.js
 * While text is selected, dragging belongs to the selection: the swipe gestures of the app ask here
 * and stay out, so moving the selection handles never pulls a list or a sheet. On iPhones the
 * selection can blink while a handle is grabbed, so it still counts for a moment after it is gone.
 */
const GRACE_MS = 800;
let lastSelectedAt = -Infinity;
let listening = false;
let selectedBefore = false;

function selectedNow() {
    const selection = window.getSelection?.();
    return !!selection && selection.rangeCount > 0 && !selection.isCollapsed;
}

/** Counts until the moment it vanished, however long it had been there. */
function remember() {
    const selected = selectedNow();
    if (selected || selectedBefore) lastSelectedAt = performance.now();
    selectedBefore = selected;
}

/** Starts watching early, so a selection is known even before the next touch. */
export function watchTextSelection() {
    if (listening) return;
    listening = true;
    document.addEventListener('selectionchange', remember);
    remember();
}

export function hasTextSelection() {
    watchTextSelection();
    remember();
    return performance.now() - lastSelectedAt < GRACE_MS;
}
