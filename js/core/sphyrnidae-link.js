/**
 * sphyrnidae-link.js
 * Custom element for generating links to the Sphyrnidae viewer
 *
 * Usage example:
 * <sphyrnidae-link src="path/to/image.jpg" alt="stereo image" mode="anaglyph"></sphyrnidae-link>
 *
 * Attributes:
 * - src: Image URL (required) - relative paths are converted to absolute URLs
 * - alt: Image alt text (optional)
 * - mode: Display mode (optional)
 *   - anaglyph, anaglyph_color: Anaglyph (color)
 *   - anaglyph_gray: Anaglyph (gray)
 *   - anaglyph_blue_yellow: Anaglyph (blue/yellow)
 *   - anaglyph_dubois: Anaglyph (Dubois)
 *   - interlace_h: Interlace (horizontal)
 *   - interlace_v: Interlace (vertical)
 *   - half_sbs: Half SBS
 *   - parallel: Parallel view
 *   - cross: Cross view
 *   - tab: Top-and-Bottom
 *   - full_tab: Full Top-and-Bottom
 *   - wiggle: Wiggle
 *   - lrl: LRL
 *   - matrix_2x2: Matrix 2x2
 * - format: Image format (optional; skips auto-detection when specified)
 *   - full_sbs: Full side-by-side
 *   - half_sbs: Half side-by-side
 *   - full_tab: Full top-and-bottom
 *   - half_tab: Half top-and-bottom
 *   - interlace_h: Horizontal line interlace
 *   - interlace_v: Vertical line interlace
 * - x: Parallax shift in pixels (optional)
 * - y: Vertical shift in pixels (optional)
 * - r: Alignment roll in degrees (optional; vertical-affine rotation)
 * - z: Alignment vertical-zoom in percent (optional; vertical-affine zoom)
 * - crop: Crop window as cropX,cropY,offsetX,offsetY (optional; normalized)
 * - viewer-url: Viewer URL (optional; default is index.html on the script origin)
 * - width: Thumbnail width (optional)
 * - height: Thumbnail height (optional)
 * - target: Link target (optional; default "_blank")
 */

(function() {
    'use strict';

    // Note: logger import is not possible in IIFE modules without import statements
    // Using console directly as this is a standalone custom element

    /**
     * Append a query string to a base URL, preserving any existing query/hash.
     * If the base already has a query, the params are appended with '&'; any
     * existing fragment is moved to the end so it stays valid.
     * @param {string} baseUrl - Viewer base URL (may contain '?' or '#')
     * @param {string} queryString - Encoded query parameters (no leading '?')
     * @returns {string} - Combined URL
     */
    function appendQueryString(baseUrl, queryString) {
        const hashIndex = baseUrl.indexOf('#');
        const hash = hashIndex >= 0 ? baseUrl.slice(hashIndex) : '';
        const base = hashIndex >= 0 ? baseUrl.slice(0, hashIndex) : baseUrl;
        const separator = base.includes('?') ? '&' : '?';
        return `${base}${separator}${queryString}${hash}`;
    }

    /**
     * Convert relative URL to absolute URL (allow only safe schemes)
     * @param {string} relativeUrl - Relative URL
     * @param {string} baseUrl - Base URL (optional; defaults to current page)
     * @returns {string} - Absolute URL
     * @throws {Error} If an unsafe scheme is detected
     */
    function toAbsoluteUrl(relativeUrl, baseUrl = null) {
        if (!relativeUrl) {
            return relativeUrl;
        }

        // Detect and reject unsafe schemes (javascript:, data:, vbscript:, etc.)
        const dangerousSchemes = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];
        const lowerUrl = relativeUrl.toLowerCase();
        for (const scheme of dangerousSchemes) {
            if (lowerUrl.startsWith(scheme)) {
                console.warn('Blocked URL with dangerous scheme:', relativeUrl);
                return '#'; // Replace unsafe URLs with a disabled link
            }
        }

        // Return as-is if already absolute (http/https only)
        if (/^https?:\/\//i.test(relativeUrl) || /^\/\//i.test(relativeUrl)) {
            // Add https for protocol-relative URLs
            if (/^\/\//i.test(relativeUrl)) {
                return 'https:' + relativeUrl;
            }
            return relativeUrl;
        }

        // Use current page URL if no base URL is provided
        const base = baseUrl || window.location.href;

        try {
            const url = new URL(relativeUrl, base);
            // Ensure generated URL has a safe scheme (http/https)
            if (!url.protocol.match(/^https?:$/i)) {
                console.warn('Generated URL has unsafe scheme:', url.href);
                return '#';
            }
            return url.href;
        } catch (e) {
            console.warn('Failed to convert to absolute URL:', relativeUrl, e);
            return '#'; // Replace with a disabled link on parse failure
        }
    }

    /**
     * Validate CSS values (allow only number + unit)
     * Prevent CSS injection (e.g., "10px;position:fixed")
     * @param {string} value - CSS value
     * @returns {string|null} - Validated CSS value (null if invalid)
     */
    function validateCssSize(value) {
        if (!value) return null;

        // Validate CSS value format: number + unit (no semicolons or spaces)
        // Examples (valid): "100", "100px", "50%"
        // Examples (malicious): "100px;position:fixed", "100 px", "100px "
        const cssValueRegex = /^(\d+(?:\.\d+)?)(px|%|em|rem|vw|vh|cm|mm|in|pt|pc)?$/;
        const match = value.trim().match(cssValueRegex);

        if (!match) {
            console.warn('Invalid CSS size value:', value);
            return null;
        }

        const number = match[1];
        const unit = match[2] || 'px'; // Default is px

        return number + unit;
    }

    /**
     * Validate viewer URL (allow only http: and https: schemes)
     * Prevent XSS attacks via javascript:, data:, vbscript:, etc.
     * @param {string} viewerUrl - Viewer URL to validate
     * @returns {string|null} - Validated URL or null if invalid
     */
    function validateViewerUrl(viewerUrl) {
        if (!viewerUrl) return null;

        const trimmedUrl = viewerUrl.trim();
        if (!trimmedUrl) return null;

        // Detect and reject unsafe schemes before URL resolution. This keeps
        // javascript:/data:/file:/blob: out while still allowing safe relative
        // viewer URLs such as "./index.html" or "/viewer/".
        const dangerousSchemes = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];
        const lowerUrl = trimmedUrl.toLowerCase();
        for (const scheme of dangerousSchemes) {
            if (lowerUrl.startsWith(scheme)) {
                console.warn('Blocked viewer URL with dangerous scheme:', viewerUrl);
                return null;
            }
        }

        // Resolve relative and protocol-relative URLs against the embedding page,
        // then allow only http(s) destinations.
        try {
            const resolvedUrl = new URL(trimmedUrl, window.location.href);
            if (resolvedUrl.protocol !== 'http:' && resolvedUrl.protocol !== 'https:') {
                console.warn('Viewer URL must resolve to http: or https: scheme:', viewerUrl);
                return null;
            }
            return resolvedUrl.href;
        } catch (e) {
            console.warn('Invalid viewer URL:', viewerUrl, e);
            return null;
        }
    }

    /**
     * Infer viewer base URL from the script URL
     * @returns {string} - Viewer base URL
     */
    function getDefaultViewerUrl() {
        if (typeof window.SphyrnidaeLinkDefaultViewerUrl === 'string') {
            const configured = validateViewerUrl(window.SphyrnidaeLinkDefaultViewerUrl);
            if (configured) return configured;
        }

        // Find the current script element
        const scripts = document.querySelectorAll('script[src*="sphyrnidae-link"]');
        if (scripts.length > 0) {
            const scriptSrc = scripts[scripts.length - 1].src;
            try {
                const scriptUrl = new URL(scriptSrc);
                // Direct use of the implementation remains supported. It lives
                // under /js/core/, so its viewer is two directories above it.
                return new URL('../../index.html', scriptUrl).href;
            } catch (e) {
                console.warn('Failed to parse script URL:', e);
            }
        }

        // Fallback: use the current page origin
        return window.location.origin + '/index.html';
    }

    /**
     * SphyrnidaeLink custom element
     */
    class SphyrnidaeLink extends HTMLElement {
        static get observedAttributes() {
            return ['src', 'alt', 'mode', 'format', 'x', 'y', 'r', 'z', 'crop', 'viewer-url', 'width', 'height', 'target'];
        }

        constructor() {
            super();
            this.attachShadow({ mode: 'open' });
        }

        connectedCallback() {
            this.render();
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue !== newValue) {
                this.render();
            }
        }

        /**
        * Generate viewer link URL
        * @returns {string} - Viewer URL
        */
        generateViewerUrl() {
            const src = this.getAttribute('src');
            if (!src) {
                return '#';
            }

            // Convert relative path to absolute URL
            const absoluteImageUrl = toAbsoluteUrl(src);

            // Viewer base URL (validate viewer-url attribute with security checks)
            let viewerBaseUrl = this.getAttribute('viewer-url');
            if (viewerBaseUrl) {
                const validatedUrl = validateViewerUrl(viewerBaseUrl);
                if (!validatedUrl) {
                    console.warn('viewer-url validation failed, falling back to default');
                    viewerBaseUrl = getDefaultViewerUrl();
                } else {
                    viewerBaseUrl = validatedUrl;
                }
            } else {
                viewerBaseUrl = getDefaultViewerUrl();
            }

            // Build URL parameters
            const params = new URLSearchParams();
            params.set('src', absoluteImageUrl);

            // Add mode if specified
            const mode = this.getAttribute('mode');
            if (mode) {
                params.set('mode', mode);
            }

            // Add format if specified
            const format = this.getAttribute('format');
            if (format) {
                params.set('format', format);
            }

            // Add shift values if specified
            const x = this.getAttribute('x');
            if (x !== null) {
                params.set('x', x);
            }
            const y = this.getAttribute('y');
            if (y !== null) {
                params.set('y', y);
            }

            // Add rotation/zoom (vertical-affine alignment) values if specified
            const r = this.getAttribute('r');
            if (r !== null) {
                params.set('r', r);
            }
            const z = this.getAttribute('z');
            if (z !== null) {
                params.set('z', z);
            }

            // Add crop window (cropX,cropY,offsetX,offsetY) if specified
            const crop = this.getAttribute('crop');
            if (crop !== null) {
                params.set('crop', crop);
            }

            return appendQueryString(viewerBaseUrl, params.toString());
        }

        /**
        * Render element
        */
        render() {
            const src = this.getAttribute('src');
            const alt = this.getAttribute('alt') || '';
            const width = this.getAttribute('width');
            const height = this.getAttribute('height');
            const target = this.getAttribute('target') || '_blank';

            // Clear existing content
            this.shadowRoot.innerHTML = '';

            if (!src) {
                // Error case: src attribute is required
                const styleEl = document.createElement('style');
                styleEl.textContent = `
                    :host {
                        display: inline-block;
                    }
                    .error {
                        color: red;
                        font-size: 12px;
                    }
                `;
                this.shadowRoot.appendChild(styleEl);

                const errorSpan = document.createElement('span');
                errorSpan.className = 'error';
                errorSpan.textContent = 'Error: src attribute is required';
                this.shadowRoot.appendChild(errorSpan);
                return;
            }

            // Convert relative path to absolute URL (for thumbnails)
            const absoluteImageUrl = toAbsoluteUrl(src);

            // toAbsoluteUrl returns the '#' sentinel when src is blocked (dangerous
            // scheme), resolves to an unsafe scheme, or fails to parse. Render the
            // error state instead of proceeding: otherwise <img src="#"> re-fetches
            // the embedding page as an image and the link becomes a live-looking
            // href that only opens the viewer to an "Invalid URL" error. (A literal
            // src="#" resolves to the page URL, not this sentinel, so this check is
            // unambiguous.)
            if (absoluteImageUrl === '#') {
                const errStyleEl = document.createElement('style');
                errStyleEl.textContent = `
                    :host {
                        display: inline-block;
                    }
                    .error {
                        color: red;
                        font-size: 12px;
                    }
                `;
                this.shadowRoot.appendChild(errStyleEl);

                const errorSpan = document.createElement('span');
                errorSpan.className = 'error';
                errorSpan.textContent = 'Error: invalid or unsafe src';
                this.shadowRoot.appendChild(errorSpan);
                return;
            }

            const viewerUrl = this.generateViewerUrl();

            // Create style element
            const styleEl = document.createElement('style');
            styleEl.textContent = `
                :host {
                    display: inline-block;
                }
                a {
                    display: inline-block;
                    text-decoration: none;
                }
                img {
                    display: block;
                    max-width: 100%;
                    height: auto;
                    border: none;
                    transition: opacity 0.2s ease;
                }
                a:hover img {
                    opacity: 0.8;
                }
                .loading {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: #f0f0f0;
                    min-width: 100px;
                    min-height: 75px;
                }
                .error-img {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: #ffe0e0;
                    color: #c00;
                    font-size: 12px;
                    padding: 10px;
                    min-width: 100px;
                    min-height: 75px;
                }
            `;
            this.shadowRoot.appendChild(styleEl);

            // Create link element
            const linkEl = document.createElement('a');
            linkEl.setAttribute('href', viewerUrl);
            linkEl.setAttribute('target', target);
            linkEl.setAttribute('rel', 'noopener noreferrer');

            // Create image element
            const imgEl = document.createElement('img');
            imgEl.setAttribute('src', absoluteImageUrl);
            imgEl.setAttribute('alt', alt);

            // Handle size attributes (strict validation to prevent CSS injection)
            if (width) {
                const validWidth = validateCssSize(width);
                if (validWidth) {
                    imgEl.style.width = validWidth;
                }
            }
            if (height) {
                const validHeight = validateCssSize(height);
                if (validHeight) {
                    imgEl.style.height = validHeight;
                }
            }

            // Handle image load error
            imgEl.addEventListener('error', () => {
                imgEl.style.display = 'none';
                errorDiv.style.display = 'flex';
            });

            // Create error fallback element
            const errorDiv = document.createElement('div');
            errorDiv.className = 'error-img';
            errorDiv.style.display = 'none';
            errorDiv.textContent = 'Image failed to load';

            // Assemble the link
            linkEl.appendChild(imgEl);
            linkEl.appendChild(errorDiv);

            // Add to shadow DOM
            this.shadowRoot.appendChild(linkEl);
        }

    }

    // Register custom element
    if (!customElements.get('sphyrnidae-link')) {
        customElements.define('sphyrnidae-link', SphyrnidaeLink);
    }

    // Expose as a global API (optional)
    window.SphyrnidaeLink = {
        /**
         * Utility to convert relative URL to absolute URL
         */
        toAbsoluteUrl: toAbsoluteUrl,

        /**
         * Utility to generate viewer URL
         * @param {string} imageUrl - Image URL
         * @param {Object} options - Options
         * @param {string} options.mode - Display mode
         * @param {string} options.format - Image format ('full_sbs', 'half_sbs', 'full_tab', 'half_tab', 'interlace_h', 'interlace_v')
         * @param {number} options.x - Parallax shift in pixels
         * @param {number} options.y - Vertical shift in pixels
         * @param {number} options.r - Alignment roll in degrees (vertical-affine)
         * @param {number} options.z - Alignment vertical-zoom in percent (vertical-affine)
         * @param {string} options.crop - Crop window "cropX,cropY,offsetX,offsetY" (normalized)
         * @param {string} options.viewerUrl - Viewer base URL
         * @returns {string} - Viewer URL
         */
        generateViewerUrl: function(imageUrl, options = {}) {
            const absoluteImageUrl = toAbsoluteUrl(imageUrl);
            // toAbsoluteUrl() returns the '#' sentinel for a dangerous or unparseable
            // URL (e.g. a javascript: scheme). Reject it here — as the element's
            // render() path already does — so callers get null instead of a
            // well-formed viewer link carrying src=%23 that fails downstream.
            if (absoluteImageUrl === '#') {
                console.warn('generateViewerUrl: invalid or unsafe image URL rejected:', imageUrl);
                return null;
            }
            const rawViewerUrl = options.viewerUrl || getDefaultViewerUrl();
            const viewerBaseUrl = validateViewerUrl(rawViewerUrl);
            if (!viewerBaseUrl) {
                console.warn('generateViewerUrl: invalid viewer URL rejected:', rawViewerUrl);
                return null;
            }

            const params = new URLSearchParams();
            params.set('src', absoluteImageUrl);

            if (options.mode) {
                params.set('mode', options.mode);
            }

            if (options.format) {
                params.set('format', options.format);
            }

            if (options.x !== undefined && options.x !== null) {
                params.set('x', options.x);
            }

            if (options.y !== undefined && options.y !== null) {
                params.set('y', options.y);
            }

            if (options.r !== undefined && options.r !== null) {
                params.set('r', options.r);
            }

            if (options.z !== undefined && options.z !== null) {
                params.set('z', options.z);
            }

            if (options.crop !== undefined && options.crop !== null) {
                params.set('crop', options.crop);
            }

            return appendQueryString(viewerBaseUrl, params.toString());
        }
    };
})();
