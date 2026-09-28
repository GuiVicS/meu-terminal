/**
 * clipboard.js
 * "Recently copied" history kept only on this device (copied text often holds
 * passwords/tokens, so it never goes to the server).
 * Browsers can't read the OS clipboard history: entries come from copies made in
 * the app plus the current device clipboard, read when the list is opened.
 */
import StorageManager from './storage.js';

const MAX_ITEMS = 20;
const MAX_LENGTH = 10000;

export default class ClipboardHistory {
    constructor() {
        this.storage = new StorageManager('dumbterm-');
        this.items = this.storage.get('clipboard', []);
    }

    /** Adds text to the top of the history (moves it up if it was already there). */
    add(text) {
        if (typeof text !== 'string') return;
        const value = text.slice(0, MAX_LENGTH);
        if (!value.trim()) return;
        this.items = [{ text: value, at: Date.now() }, ...this.items.filter(i => i.text !== value)]
            .slice(0, MAX_ITEMS);
        this.save();
    }

    /** Removes an entry by its text (indexes shift while a list is on screen). */
    remove(text) {
        this.items = this.items.filter(i => i.text !== text);
        this.save();
    }

    clear() {
        this.items = [];
        this.save();
    }

    save() {
        this.storage.set('clipboard', this.items);
    }

    /**
     * Reads what is currently copied on the device and adds it. Needs a user gesture
     * and permission (iOS shows a system "Paste" button).
     * @returns {Promise<'ok'|'empty'|'denied'|'unsupported'>}
     */
    async captureDeviceClipboard() {
        if (!navigator.clipboard?.readText || !window.isSecureContext) return 'unsupported';
        try {
            const text = await navigator.clipboard.readText();
            if (!text) return 'empty';
            this.add(text);
            return 'ok';
        } catch {
            return 'denied';
        }
    }

    /** Copies text to the device clipboard (and records it). */
    async copy(text) {
        this.add(text);
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            return false;
        }
    }
}
