/**
 * safe-storage.js
 * Safe localStorage wrappers that handle exceptions in restricted environments
 * (e.g., Safari Private Browsing, disabled cookies, storage quota exceeded)
 */

import { DEBUG } from '../globals.js';

/**
 * Safely get item from localStorage
 * @param {string} key - Storage key
 * @returns {string|null} - Value or null if unavailable/error
 */
export function safeLocalStorageGet(key) {
    try {
        return localStorage.getItem(key);
    } catch (err) {
        if (DEBUG.CACHE_LOG) {
            console.warn('[SafeStorage] localStorage.getItem failed:', key, err);
        }
        return null;
    }
}

/**
 * Safely set item in localStorage
 * @param {string} key - Storage key
 * @param {string} value - Value to store
 * @returns {boolean} - True if successful
 */
export function safeLocalStorageSet(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        if (DEBUG.CACHE_LOG) {
            console.warn('[SafeStorage] localStorage.setItem failed:', key, err);
        }
        return false;
    }
}

/**
 * Safely remove item from localStorage
 * @param {string} key - Storage key
 * @returns {boolean} - True if successful
 */
export function safeLocalStorageRemove(key) {
    try {
        localStorage.removeItem(key);
        return true;
    } catch (err) {
        if (DEBUG.CACHE_LOG) {
            console.warn('[SafeStorage] localStorage.removeItem failed:', key, err);
        }
        return false;
    }
}
