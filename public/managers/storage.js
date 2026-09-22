/**
 * StorageManager - A class to abstract localStorage operations
 * Provides a generic interface for storing and retrieving data
 */
export default class StorageManager {
    /**
     * Constructor for StorageManager
     * @param {string} prefix - Optional prefix for all storage keys
     */
    constructor(prefix = 'dumbterm-') {
        this.prefix = prefix;
        this.isAvailable = this._checkAvailability();
    }

    /**
     * Check if localStorage is available
     * @returns {boolean} True if localStorage is available
     */
    _checkAvailability() {
        try {
            const testKey = '__storage_test__';
            localStorage.setItem(testKey, testKey);
            localStorage.removeItem(testKey);
            return true;
        } catch (e) {
            console.warn('localStorage is not available:', e);
            return false;
        }
    }

    /**
     * Generate a prefixed key
     * @param {string} key - The key to prefix
     * @returns {string} The prefixed key
     */
    _getKey(key) {
        return `${this.prefix}${key}`;
    }

    /**
     * Set a value in storage
     * @param {string} key - The key to store under
     * @param {any} value - The value to store (will be JSON serialized)
     * @returns {boolean} True if storage was successful
     */
    set(key, value) {
        if (!this.isAvailable) return false;
        
        try {
            const serialized = JSON.stringify(value);
            localStorage.setItem(this._getKey(key), serialized);
            return true;
        } catch (e) {
            console.error('Failed to save to localStorage:', e);
            return false;
        }
    }

    /**
     * Get a value from storage
     * @param {string} key - The key to retrieve
     * @param {any} defaultValue - Default value if key doesn't exist
     * @returns {any} The retrieved value (JSON parsed) or defaultValue
     */
    get(key, defaultValue = null) {
        if (!this.isAvailable) return defaultValue;
        
        try {
            const value = localStorage.getItem(this._getKey(key));
            if (value === null) return defaultValue;
            return JSON.parse(value);
        } catch (e) {
            console.error('Failed to get from localStorage:', e);
            return defaultValue;
        }
    }

    /**
     * Remove a key from storage
     * @param {string} key - The key to remove
     * @returns {boolean} True if removal was successful
     */
    remove(key) {
        if (!this.isAvailable) return false;
        
        try {
            localStorage.removeItem(this._getKey(key));
            return true;
        } catch (e) {
            console.error('Failed to remove from localStorage:', e);
            return false;
        }
    }

    /**
     * Clear all items with this prefix
     * @returns {boolean} True if clearing was successful
     */
    clear() {
        if (!this.isAvailable) return false;
        
        try {
            Object.keys(localStorage)
                .filter(key => key.startsWith(this.prefix))
                .forEach(key => localStorage.removeItem(key));
            return true;
        } catch (e) {
            console.error('Failed to clear localStorage:', e);
            return false;
        }
    }

    /**
     * Get all keys with this prefix
     * @returns {string[]} Array of keys (without prefix)
     */
    keys() {
        if (!this.isAvailable) return [];
        
        try {
            return Object.keys(localStorage)
                .filter(key => key.startsWith(this.prefix))
                .map(key => key.slice(this.prefix.length));
        } catch (e) {
            console.error('Failed to get keys from localStorage:', e);
            return [];
        }
    }

    /**
     * Check if a key exists
     * @param {string} key - The key to check
     * @returns {boolean} True if the key exists
     */
    has(key) {
        if (!this.isAvailable) return false;
        return localStorage.getItem(this._getKey(key)) !== null;
    }
}