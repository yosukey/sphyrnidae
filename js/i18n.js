/**
* i18n.js - i18next initialization
*/

// i18next initialization and DOM update function

import { safeLocalStorageGet, safeLocalStorageSet, safeLocalStorageRemove } from './utils/safe-storage.js';

/**
 * Sanitize a translation string for safe innerHTML insertion.
 * Escapes all HTML entities first, then re-enables only safe inline tags (<br>).
 * This prevents XSS via compromised translation files while preserving
 * the intended formatting.
 * @param {string} html - Raw translation string
 * @returns {string} Sanitized HTML string
 */
function sanitizeTranslationHtml(html) {
    // Step 1: Escape all HTML to prevent injection
    const escaped = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    // Step 2: Re-enable only safe self-closing tags: <br>, <br/>, <br />
    return escaped.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
}

const SUPPORTED_LANGUAGES = new Set(['ja', 'en']);
const DEFAULT_LANGUAGE = 'ja';

function normalizeLanguage(lang) {
    if (typeof lang !== 'string') return null;
    const normalized = lang.trim().toLowerCase();
    return SUPPORTED_LANGUAGES.has(normalized) ? normalized : null;
}

// Store the language change handler for cleanup
let languageChangeHandler = null;

// Fallback translation function (used before i18next is initialized)
// This will be accessible via window.StereoView.i18n.t and window.t (getter)
// Note: window.t getter is defined at the end of this file, after namespace creation

// Set up event listeners for language selection buttons
function setupLanguageButtonListeners() {
    // Find all language option buttons with data-language attribute
    const languageButtons = document.querySelectorAll('.language-option-card[data-language]');

    languageButtons.forEach(button => {
        const lang = button.getAttribute('data-language');
        if (lang) {
            button.addEventListener('click', () => {
                selectLanguage(lang);
            });
        }
    });
}

async function initI18n() {
    try {
        // Language selection priority:
        // 1. localStorage (user selection) → highest priority
        // 2. Browser language setting → auto-select on first visit
        // 3. Default 'ja' (Japanese) → fallback

        const storedLanguage = safeLocalStorageGet('language');
        let selectedLanguage = normalizeLanguage(storedLanguage);

        if (storedLanguage && !selectedLanguage) {
            console.warn('[i18n] Unsupported stored language ignored:', storedLanguage);
            safeLocalStorageRemove('language');
        }

        if (!selectedLanguage) {
            // If no supported language setting is stored, use browser language.
            // Guard against navigator.language being undefined (seen in some embedded
            // WebViews / kiosk browsers): a bare .substring() would throw and the outer
            // catch would drop ALL of i18n to raw-key passthrough, even though the
            // locale files are fetchable. Fall back to the default language instead.
            const browserLang = normalizeLanguage((navigator.language || '').substring(0, 2));
            selectedLanguage = browserLang || DEFAULT_LANGUAGE;
        }

        // Load translation data. Use allSettled (not Promise.all) so one locale
        // failing to load or validate does not tear down i18n for the other: as long
        // as at least one locale is usable the UI stays translated, with i18next's
        // fallbackLng covering any gaps. Only a total failure falls through to the
        // catch below, which keeps the key-passthrough window.t set before init.
        const requiredKeys = ['menu', 'messages', 'displayModes'];
        const localeSpecs = [
            { lng: 'ja', url: './locales/ja.json' },
            { lng: 'en', url: './locales/en.json' }
        ];

        const settled = await Promise.allSettled(localeSpecs.map(async (spec) => {
            const r = await fetch(spec.url);
            if (!r.ok) throw new Error(`Failed to fetch ${spec.lng}.json: ${r.status}`);
            const data = await r.json();
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error(`Invalid ${spec.lng}.json: must be a non-array object`);
            }
            for (const key of requiredKeys) {
                if (!(key in data)) {
                    throw new Error(`Invalid ${spec.lng}.json: missing required top-level key "${key}"`);
                }
            }
            return { lng: spec.lng, data };
        }));

        const resources = {};
        settled.forEach((result, i) => {
            if (result.status === 'fulfilled') {
                resources[result.value.lng] = { translation: result.value.data };
            } else {
                console.error(`[i18n] Failed to load ${localeSpecs[i].lng} locale:`, result.reason);
            }
        });

        const availableLangs = Object.keys(resources);
        if (availableLangs.length === 0) {
            throw new Error('No locale files could be loaded');
        }

        // If the selected language did not load, fall back to an available one so the
        // UI shows real translations rather than raw keys. Keep the interpolation
        // fallback pointed at a locale that actually loaded.
        if (!resources[selectedLanguage]) {
            selectedLanguage = resources.en ? 'en' : availableLangs[0];
        }
        const fallbackLng = resources.en ? 'en' : availableLangs[0];

        // Initialize i18next
        if (typeof i18next === 'undefined') {
            throw new Error('i18next library not loaded. Check CDN availability.');
        }
        await i18next.init({
            lng: selectedLanguage,
            fallbackLng: fallbackLng,
            resources: resources,
            interpolation: {
                // Do NOT HTML-escape interpolated values. Every consumer inserts
                // translations via safe DOM APIs (textContent / placeholder / title /
                // value); the only innerHTML sink (data-i18n-html) runs through
                // sanitizeTranslationHtml() and passes no interpolation. With
                // escapeValue:true, values like a filename "M&M's <3.jpg" were shown
                // double-escaped (e.g. "M&amp;M&#39;s &lt;3.jpg") in toasts/messages.
                escapeValue: false,
                // Enable {{variable}} interpolation
                prefix: '{{',
                suffix: '}}'
            },
            keySeparator: '.',
            nsSeparator: false
        });

        // After initialization, window.t will be accessed via getter to window.StereoView.i18n.t
        // No direct assignment needed here

        // Initial DOM update
        updateContent();

        // Set up event listeners for language selection buttons
        setupLanguageButtonListeners();

        // Event listener for language changes
        languageChangeHandler = () => {
            updateContent();
        };
        i18next.on('languageChanged', languageChangeHandler);

        // Return success status
        return { success: true };
    } catch (error) {
        console.error('i18n initialization failed:', error);
        // Keep the fallback function already set
        // (use window.t set before initialization - returns keys as-is)

        // Return failure status with error information
        return { success: false, error: error.message };
    }
}

// Function to update DOM elements with translations
function updateContent() {
    // Guard: updateContent() is exposed globally (window.updateI18nContent) and called
    // from modules (vr.js, loader-ui-progress.js) that may run before init completes,
    // or when the i18next CDN script failed to load entirely. Calling i18next.t() /
    // i18next.language then throws a ReferenceError (i18next undefined) or returns
    // undefined, which would overwrite every data-i18n element with the literal string
    // "undefined". Bail out and leave the HTML's built-in default text in place.
    // Mirrors the availability check in t().
    if (typeof i18next === 'undefined' || !i18next.isInitialized || typeof i18next.t !== 'function') {
        return;
    }

    // Update all elements with data-i18n attributes
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const i18nAttr = element.getAttribute('data-i18n');

        // Check for [attribute]key format
        const match = i18nAttr.match(/^\[(.+?)\](.+)$/);

        if (match) {
            // Apply translation to attribute
            const attrName = match[1];
            const key = match[2];
            const translation = i18next.t(key);
            element.setAttribute(attrName, translation);
        } else {
            // Apply translation to normal text content
            const key = i18nAttr;
            const translation = i18next.t(key);

            // If input placeholder (kept for compatibility)
            if (element.tagName === 'INPUT' && element.hasAttribute('placeholder')) {
                element.placeholder = translation;
            } else if (element.tagName === 'OPTION') {
                // Option element text
                element.textContent = translation;
            } else {
                // Normal text content
                // Skip elements with data-i18n-skip (dynamically updated elements)
                if (!element.hasAttribute('data-i18n-skip')) {
                    // Use innerHTML for elements with data-i18n-html attribute
                    // (allows <br> tags in translations; all other HTML is escaped)
                    if (element.hasAttribute('data-i18n-html')) {
                        element.innerHTML = sanitizeTranslationHtml(translation);
                    } else {
                        element.textContent = translation;
                    }
                }
            }
        }
    });

    // Update elements with data-i18n-title (title attribute translation)
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
        const key = element.getAttribute('data-i18n-title');
        const translation = i18next.t(key);
        element.setAttribute('title', translation);
    });

    // Update the HTML lang attribute
    document.documentElement.lang = i18next.language;

    // Notify modules that render dynamic text which updateContent() cannot handle
    // on its own — e.g. labels carrying a runtime suffix and marked data-i18n-skip
    // (the OpenCV "Ready (SIMD)" status) — so they can re-render in the new language.
    try {
        window.dispatchEvent(new CustomEvent('app-language-changed', {
            detail: { lang: i18next.language }
        }));
    } catch (err) {
        // CustomEvent unavailable in some very old environments; non-fatal.
        console.warn('[i18n] Could not dispatch app-language-changed:', err && err.message);
    }
}

// Function to change the language
function changeLanguage(lang) {
    const normalizedLang = normalizeLanguage(lang);
    if (!normalizedLang) {
        console.warn('[i18n] Unsupported language ignored:', lang);
        return false;
    }

    safeLocalStorageSet('language', normalizedLang);
    // Only change language if i18next is initialized
    if (typeof i18next !== 'undefined' && i18next.changeLanguage) {
        i18next.changeLanguage(normalizedLang);
    }
    return true;
}

// Select a language and automatically return to the main menu
function selectLanguage(lang) {
    if (!changeLanguage(lang)) {
        return false;
    }
    // Execute the menu navigation function if available (set in ui.js)
    if (window.navigateToMainMenu) {
        window.navigateToMainMenu();
    }
    return true;
}

// Export t function (used when generating text dynamically in JavaScript)
function t(key, options) {
    // Fallback handling when i18next is not initialized.
    // The i18next CDN bundle defines `i18next.t` at parse time, but `i18next.init()`
    // only resolves after the async locale fetches. In that window `i18next.t` is
    // truthy yet calling it logs "init not called" and returns undefined, breaking
    // the documented key/defaultValue passthrough. Gate on `isInitialized` (set true
    // by i18next only after init completes) so early callers get the fallback below.
    if (typeof i18next === 'undefined' || !i18next.isInitialized || !i18next.t) {
        // Prefer an explicit English defaultValue when i18next has not finished
        // loading (i18next honors this option natively once ready). This lets early
        // UI rendered before init — notably the update banner, which main.js starts
        // before awaiting i18n — show real text instead of the raw key. Falls back
        // to the key when no defaultValue was supplied. Matches i18next semantics.
        const base = (options && typeof options.defaultValue === 'string')
            ? options.defaultValue
            : key;
        // Same handling as the pre-init fallback function
        if (options && typeof options === 'object') {
            // Simple template substitution ({{key}} format).
            // Use a single pass with a regex + function replacer so that:
            // - option keys containing regex metacharacters cannot produce invalid
            //   RegExp or match unintended placeholders
            // - option values containing `$&`, `$1`, etc. are inserted literally
            //   (String.prototype.replace would otherwise interpret them as backrefs)
            let result = base;
            // Protect against prototype-pollution payloads by iterating own keys only.
            const ownOptions = Object.create(null);
            for (const [k, v] of Object.entries(options)) {
                ownOptions[k] = v;
            }
            result = result.replace(/\{\{([^{}]+)\}\}/g, (match, name) => {
                if (Object.prototype.hasOwnProperty.call(ownOptions, name)) {
                    return String(ownOptions[name]);
                }
                return match;
            });
            return result;
        }
        return base;
    }
    return i18next.t(key, options);
}

// Initialize i18next on DOMContentLoaded
// Expose initI18n() Promise globally so other code can await initialization
// Namespace initialization
if (!window.StereoView) {
    window.StereoView = {};
}

// Store initialization status globally for other code to check
window.StereoView.i18nStatus = { initialized: false, success: false };

if (document.readyState === 'loading') {
    window.StereoView.i18nReadyPromise = new Promise((resolve) => {
        document.addEventListener('DOMContentLoaded', () => {
            initI18n().then((result) => {
                Object.assign(window.StereoView.i18nStatus, { initialized: true, success: result.success });
                if (!result.success) {
                    console.warn('[i18n] Running with fallback mode (translation keys will be displayed)');
                }
                resolve(result);
            });
        });
    });
} else {
    window.StereoView.i18nReadyPromise = initI18n().then((result) => {
        Object.assign(window.StereoView.i18nStatus, { initialized: true, success: result.success });
        if (!result.success) {
            console.warn('[i18n] Running with fallback mode (translation keys will be displayed)');
        }
        return result;
    });
}

// Export functions globally (via namespace)
// Cleanup function to remove event listeners
function cleanupI18n() {
    if (languageChangeHandler && typeof i18next?.off === 'function') {
        i18next.off('languageChanged', languageChangeHandler);
        languageChangeHandler = null;
    }
}

window.StereoView.i18n = {
    changeLanguage,
    selectLanguage,
    t,
    updateContent,
    cleanup: cleanupI18n,
    i18nReadyPromise: window.StereoView.i18nReadyPromise,
    i18nStatus: window.StereoView.i18nStatus
};

// Expose as direct globals (e.g. window.t) in addition to the namespace, via getters
// Only define if not already defined to prevent duplicate definition errors
if (!Object.getOwnPropertyDescriptor(window, 't')) {
    try {
        Object.defineProperty(window, 't', {
            get: () => window.StereoView.i18n.t,
            configurable: true
        });
    } catch (err) {
        console.warn('[i18n] Could not define window.t:', err.message);
    }
}

if (!Object.getOwnPropertyDescriptor(window, 'changeLanguage')) {
    try {
        Object.defineProperty(window, 'changeLanguage', {
            get: () => window.StereoView.i18n.changeLanguage,
            configurable: true
        });
    } catch (err) {
        console.warn('[i18n] Could not define window.changeLanguage:', err.message);
    }
}

if (!Object.getOwnPropertyDescriptor(window, 'selectLanguage')) {
    try {
        Object.defineProperty(window, 'selectLanguage', {
            get: () => window.StereoView.i18n.selectLanguage,
            configurable: true
        });
    } catch (err) {
        console.warn('[i18n] Could not define window.selectLanguage:', err.message);
    }
}

if (!Object.getOwnPropertyDescriptor(window, 'updateI18nContent')) {
    try {
        Object.defineProperty(window, 'updateI18nContent', {
            get: () => window.StereoView.i18n.updateContent,
            configurable: true
        });
    } catch (err) {
        console.warn('[i18n] Could not define window.updateI18nContent:', err.message);
    }
}

if (!Object.getOwnPropertyDescriptor(window, 'i18nReadyPromise')) {
    try {
        Object.defineProperty(window, 'i18nReadyPromise', {
            get: () => window.StereoView.i18n.i18nReadyPromise,
            configurable: true
        });
    } catch (err) {
        console.warn('[i18n] Could not define window.i18nReadyPromise:', err.message);
    }
}
