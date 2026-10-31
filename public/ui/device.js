/**
 * device.js
 * One place to ask "which kind of device is this?", so phone behaviour (a menu about the tab on
 * screen, no keyboard hints, finger-sized rows) is not tied to the iPhone-only glass layout.
 */

/** Any touch-first device: phones and tablets. */
export const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

/**
 * A phone, in any orientation. Tablets are left out on purpose: an iPad has room for the desktop
 * menu (and the iPhone redesign must not leak into it). The shortest screen side is what tells a
 * phone from a tablet (iPhone Pro Max: 430, iPad mini: 744).
 */
export function isHandset() {
    if (!isCoarse()) return false;
    const width = window.screen?.width || 0;
    const height = window.screen?.height || 0;
    const shortest = Math.min(width, height);
    return shortest > 0 && shortest < 600;
}

/** The iPhone layout (data-iphone is set before the first paint in index.html). */
export const isIphone = () => document.documentElement.hasAttribute('data-iphone');

/** The iPhone layout only applies in portrait; in landscape it is the regular phone layout. */
export const isIphonePortrait = () => isIphone() && window.matchMedia('(orientation: portrait)').matches;
