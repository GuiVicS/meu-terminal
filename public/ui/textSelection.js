/**
 * textSelection.js
 * While text is selected, dragging belongs to the selection: the swipe gestures of the app ask here
 * and stay out, so moving the selection handles never pulls a list or a sheet. No state is kept:
 * clearing the selection brings the gestures back.
 */
export function hasTextSelection() {
    const selection = window.getSelection?.();
    return !!selection && !selection.isCollapsed && selection.toString().length > 0;
}
