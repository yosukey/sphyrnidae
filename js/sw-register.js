if ('serviceWorker' in navigator) {
    window.addEventListener('load', async () => {
        try {
            // Capture whether a controller already exists BEFORE registering.
            // On the very first visit the freshly installed SW activates and calls
            // clients.claim(), which fires 'controllerchange' even though no update
            // happened. Reloading on that initial claim is unnecessary and costly
            // (re-downloads OpenCV/WASM). We only want to reload when an EXISTING
            // controller is replaced by a new one (a genuine update).
            let hadController = !!navigator.serviceWorker.controller;

            // updateViaCache: 'none' forces BOTH sw.js and the scripts it
            // importScripts()'s (notably version-config.js) to be fetched
            // bypassing the HTTP cache during every update check. Releases only
            // change version-config.js — sw.js's own bytes stay identical — so
            // under the default 'imports' mode a stale cached version-config.js
            // could hide a new version and delay/miss update detection.
            const registration = await navigator.serviceWorker.register('./sw.js', {
                updateViaCache: 'none'
            });
            console.log('ServiceWorker registration successful:', registration.scope);

            // Capture whether an ACTIVE worker already existed at load, independent of
            // whether this page is controlled. A hard/Shift reload leaves the page
            // uncontrolled (controller === null) for its whole lifetime even though the
            // SW is registered and active, so hadController alone cannot tell a genuine
            // first install (no worker at all) from an uncontrolled-but-established tab.
            // On a true first install the SW is still installing when register() resolves
            // (it is downloading the precache), so registration.active is reliably null here.
            const hadActiveWorkerAtLoad = !!registration.active;

            // Dispatch the "update available" event so the UI can show the banner.
            const notifyUpdateAvailable = () => {
                console.log('[SW] New version available! Dispatching update event.');
                window.dispatchEvent(new CustomEvent('sw-update-available', {
                    detail: { registration: registration }
                }));
            };

            // Watch a worker to the end of its install and surface it as an update
            // once it is 'installed' AND a controller already exists (an existing
            // controller means this is a genuine update replacing the running SW,
            // not the very first install — which must not show an update banner).
            // A genuine update (not the first install) is signalled by an EXISTING
            // active SW. Normally that is navigator.serviceWorker.controller, but after
            // a hard reload (Shift+Reload) the page is uncontrolled (controller === null)
            // for its whole lifetime even though registration.active is set — so a real
            // update during that session would never surface. Accept registration.active
            // too. On the very first install, registration.active is still null at the
            // 'installed'/waiting moment, so this does not wrongly show a banner then.
            const hasExistingActiveWorker = () =>
                !!(navigator.serviceWorker.controller || registration.active);

            const trackInstallingWorker = (worker) => {
                worker.addEventListener('statechange', () => {
                    console.log('[SW] New worker state:', worker.state);
                    if (worker.state === 'installed' && hasExistingActiveWorker()) {
                        notifyUpdateAvailable();
                    }
                });
            };

            // A new worker may already be waiting from a previous visit (it finished
            // installing but the page was closed before activation). In that case
            // 'updatefound' will NOT fire again, so surface the waiting worker now.
            if (registration.waiting && hasExistingActiveWorker()) {
                console.log('[SW] A waiting service worker is already present.');
                notifyUpdateAvailable();
            } else if (registration.installing) {
                // A new worker may already be part-way through installing when this
                // page loads (a deploy landed and install began, then the user
                // reloaded before it finished). 'updatefound' fired for it BEFORE
                // this listener was attached and will not fire again, and it is not
                // yet 'waiting', so both checks above miss it. Without this, the
                // update banner never appears for the rest of the session (the
                // periodic update() calls are no-ops against the identical bytes).
                console.log('[SW] A service worker is already installing; watching for completion.');
                trackInstallingWorker(registration.installing);
            }

            // Update detection: when a new Service Worker is found
            registration.addEventListener('updatefound', () => {
                const newWorker = registration.installing;
                if (!newWorker) {
                    console.warn('[SW] updatefound fired but registration.installing is null');
                    return;
                }
                console.log('[SW] New service worker found, installing...');
                trackInstallingWorker(newWorker);
            });

            // When the controller changes (new SW becomes active), reload to use new version
            // Guard against multiple reloads within the same page load AND across page loads
            // using sessionStorage to prevent infinite reload loops if SW repeatedly activates.
            let reloading = false;
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (reloading) return;

                // Skip only the benign initial claim on a true first install: no controller
                // AND no active worker existed at load, so this controllerchange is the
                // freshly-installed SW claiming us for the first time, not a newer SW
                // replacing it. A page that HAD an active worker at load — whether normally
                // controlled or uncontrolled after a hard reload — must reload on any
                // controllerchange: the new controller is a genuine update whose activate
                // handler has already deleted the old caches, so continuing to run the old
                // shell would serve mixed-version assets. Without the active-worker check, an
                // uncontrolled tab updated from ANOTHER tab would mistake the real activation
                // for the initial claim and never reload, stranding it on the old shell.
                if (!hadController && !hadActiveWorkerAtLoad) {
                    hadController = true;
                    console.log('[SW] Initial controller acquired (first install); not reloading.');
                    return;
                }

                try {
                    const swReloadKey = 'sw-controller-reloaded';
                    const lastReload = sessionStorage.getItem(swReloadKey);
                    if (lastReload && (Date.now() - Number(lastReload)) < 10000) {
                        console.warn('[SW] Controller changed again within 10s, skipping reload to prevent loop.');
                        return;
                    }
                    reloading = true;
                    sessionStorage.setItem(swReloadKey, String(Date.now()));
                } catch (storageErr) {
                    // sessionStorage may throw in private browsing mode
                    console.warn('[SW] sessionStorage unavailable:', storageErr);
                    reloading = true;
                }
                console.log('[SW] Controller changed, new service worker activated. Reloading...');
                window.location.reload();
            });

            // Periodically check for updates (every hour). registration.update()
            // rejects while offline (network fetch fails); swallow it so it does not
            // surface as an unhandled promise rejection every hour.
            setInterval(() => {
                console.log('[SW] Checking for updates...');
                registration.update().catch((err) => {
                    console.debug('[SW] Update check failed (likely offline):', err?.message || err);
                });
            }, 60 * 60 * 1000);

            // Initial update check (after 5 seconds)
            setTimeout(() => {
                console.log('[SW] Initial update check...');
                registration.update().catch((err) => {
                    console.debug('[SW] Initial update check failed (likely offline):', err?.message || err);
                });
            }, 5000);

        } catch (err) {
            console.error('ServiceWorker registration failed:', err);
        }
    });
}
