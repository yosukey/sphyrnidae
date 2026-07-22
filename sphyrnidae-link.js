/**
 * Public entry point for the <sphyrnidae-link> custom element.
 *
 * Keep this root-level file stable: it is the URL documented for embedding from
 * third-party pages. The implementation lives in js/core with the application.
 */
(function () {
    const current = document.currentScript;
    // document.currentScript is null when this entry point is loaded as a module or
    // injected via eval/dynamic insertion. Before the last-resort page-relative URL,
    // fall back to locating our own <script> by src (mirrors js/core/sphyrnidae-link.js)
    // so the implementation script and default viewer URL resolve against THIS file's
    // origin rather than the embedding page's (which would 404 on a third-party site).
    let sourceUrl = current?.src;
    if (!sourceUrl) {
        const byQuery = document.querySelector('script[src*="sphyrnidae-link"]');
        sourceUrl = byQuery?.src || new URL('./sphyrnidae-link.js', window.location.href).href;
    }
    window.SphyrnidaeLinkDefaultViewerUrl = new URL('./index.html', sourceUrl).href;

    const implementation = document.createElement('script');
    implementation.src = new URL('./js/core/sphyrnidae-link.js', sourceUrl).href;
    implementation.async = false;
    document.head.appendChild(implementation);
})();
