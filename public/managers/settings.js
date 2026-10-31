/**
 * settings.js
 * User preferences (persistent state), kept apart from terminal/connection state.
 * Every setting here is actually applied somewhere - no placeholder options.
 */
import StorageManager from './storage.js';

export const DEFAULT_SETTINGS = {
    // Interface
    theme: 'dark',            // 'dark' | 'light' | 'system'
    motion: 'system',         // 'system' | 'reduced'
    // 'glass' (iPhone only) | 'glass-any' (any phone) | 'classic' (no iPhone layout)
    iphoneVisual: 'glass',
    // Terminal
    fontSize: 15,
    lineHeight: 1.2,
    cursorStyle: 'block',     // 'block' | 'bar' | 'underline'
    cursorBlink: true,
    scrollback: 5000,
    // Session
    defaultCwd: '',           // empty = server default (HOME)
    shortcutBar: 'auto',      // 'auto' (with virtual keyboard) | 'always' | 'never'
};

export default class SettingsManager {
    constructor() {
        this.storage = new StorageManager('meuterminal-');
        this.listeners = new Set();
        this.values = { ...DEFAULT_SETTINGS, ...(this.storage.get('settings') || {}) };
        this.systemDark = window.matchMedia('(prefers-color-scheme: dark)');
        // Follow OS theme changes while "system" is selected
        this.systemDark.addEventListener?.('change', () => {
            if (this.values.theme === 'system') this.applyTheme();
        });
        this.applyTheme();
        this.applyMotion();
        this.applyIphoneVisual();
        // Another tab (e.g. /admin) changed a setting: pick it up here too
        window.addEventListener('storage', e => {
            if (e.key !== this.storage._getKey('settings')) return;
            const next = { ...DEFAULT_SETTINGS, ...(this.storage.get('settings') || {}) };
            Object.keys(next).forEach(key => {
                if (next[key] === this.values[key]) return;
                this.values[key] = next[key];
                if (key === 'theme') this.applyTheme();
                if (key === 'motion') this.applyMotion();
                if (key === 'iphoneVisual') this.applyIphoneVisual();
                this.listeners.forEach(fn => fn(key, next[key]));
            });
        });
    }

    get(key) {
        return this.values[key];
    }

    /** Updates one setting, persists it and notifies subscribers. */
    set(key, value) {
        if (this.values[key] === value) return;
        this.values[key] = value;
        this.storage.set('settings', this.values);
        if (key === 'theme') this.applyTheme();
        if (key === 'motion') this.applyMotion();
        if (key === 'iphoneVisual') this.applyIphoneVisual();
        this.listeners.forEach(fn => fn(key, value));
    }

    /** @param {(key: string, value: any) => void} fn */
    onChange(fn) {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    resolvedTheme() {
        if (this.values.theme === 'system') return this.systemDark.matches ? 'dark' : 'light';
        return this.values.theme;
    }

    applyTheme() {
        const theme = this.resolvedTheme();
        document.documentElement.setAttribute('data-theme', theme);
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', theme === 'light' ? '#F7F7F5' : '#0C0D0E');
    }

    applyMotion() {
        document.documentElement.toggleAttribute('data-reduced-motion', this.values.motion === 'reduced');
    }

    /**
     * iPhone-only layout (Liquid Glass). index.html sets data-iphone before the first paint, so this
     * mostly keeps the attribute in sync when the preference is changed; it also lets anyone put
     * the same visual on another phone (Android) from Settings → Interface.
     */
    applyIphoneVisual() {
        const mode = this.values.iphoneVisual;
        const isPhone = /iPhone|iPod/.test(navigator.userAgent)
            || (mode === 'glass-any' && window.matchMedia('(pointer: coarse)').matches
                && Math.min(window.screen.width, window.screen.height) < 720);
        document.documentElement.toggleAttribute('data-iphone', mode !== 'classic' && isPhone);
    }
}
