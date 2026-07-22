async function loadOpenCV(paths, onloadCallback) {
    let OPENCV_URL = "";
    let asmPath = "";
    let wasmPath = "";
    let simdPath = "";
    let threadsPath = "";
    let threadsSimdPath = "";

    if(!(paths instanceof Object)) {
        throw new Error("The first input should be a object that points the path to the OpenCV.js");
    }

    if ("asm" in paths) {
        asmPath = paths["asm"];
    }

    if ("wasm" in paths) {
        wasmPath = paths["wasm"];
    }

    if ("threads" in paths) {
        threadsPath = paths["threads"];
    }

    if ("simd" in paths) {
        simdPath = paths["simd"];
    }

    if ("threadsSimd" in paths) {
        threadsSimdPath = paths["threadsSimd"];
    }

    let wasmSupported = !(typeof WebAssembly === 'undefined');
    if (!wasmSupported && OPENCV_URL === "" && asmPath != "") {
        OPENCV_URL = asmPath;
        console.log("The OpenCV.js for Asm.js is loaded now");
    } else if (!wasmSupported && asmPath == ""){
        throw new Error("The browser supports the Asm.js only, but the path of OpenCV.js for Asm.js is empty");
    }

    // Feature-detect SIMD/threads. If wasmFeatureDetect is unavailable, degrade to
    // the plain wasm build (treat advanced features as unsupported) instead of throwing.
    let simdSupported = false;
    let threadsSupported = false;
    if (wasmSupported) {
        if (typeof wasmFeatureDetect !== 'undefined' && wasmFeatureDetect) {
            try {
                simdSupported = await wasmFeatureDetect.simd();
                threadsSupported = await wasmFeatureDetect.threads();
            } catch (err) {
                // Detection itself threw/rejected (e.g. WebAssembly.validate blocked
                // by CSP, or an exotic engine). Degrade to the plain wasm build
                // rather than rejecting the whole load — the same fallback as when
                // the detector is entirely absent. A usable ./opencv/wasm build is
                // precached, so auto-alignment still works.
                simdSupported = false;
                threadsSupported = false;
                console.warn('wasmFeatureDetect failed; using the plain wasm build:', err);
            }
        } else {
            console.warn('wasmFeatureDetect is unavailable; using the plain wasm build');
        }
    }

    if (simdSupported && threadsSupported && threadsSimdPath != "") {
        OPENCV_URL = threadsSimdPath;
        console.log("The OpenCV.js with simd and threads optimization is loaded now");
    } else if (simdSupported && simdPath != "") {
        if (threadsSupported && threadsSimdPath === "") {
            console.log("The browser supports simd and threads, but the path of OpenCV.js with simd and threads optimization is empty");
        }
        OPENCV_URL = simdPath;
        console.log("The OpenCV.js with simd optimization is loaded now.");
    } else if (threadsSupported && threadsPath != "") {
        if (simdSupported && threadsSimdPath === "") {
            console.log("The browser supports simd and threads, but the path of OpenCV.js with simd and threads optimization is empty");
        }
        OPENCV_URL = threadsPath;
        console.log("The OpenCV.js with threads optimization is loaded now");
    } else if (wasmSupported && wasmPath != "") {
        if(simdSupported && threadsSupported) {
            console.log("The browser supports simd and threads, but the path of OpenCV.js with simd and threads optimization is empty");
        }

        if (simdSupported) {
            console.log("The browser supports simd optimization, but the path of OpenCV.js with simd optimization is empty");
        }

        if (threadsSupported) {
            console.log("The browser supports threads optimization, but the path of OpenCV.js with threads optimization is empty");
        }

        OPENCV_URL = wasmPath;
        console.log("The OpenCV.js for wasm is loaded now");
    } else if (wasmSupported) {
        console.log("The browser supports wasm, but the path of OpenCV.js for wasm is empty");

        if (asmPath != "") {
            OPENCV_URL = asmPath;
            console.log("The OpenCV.js for Asm.js is loaded as fallback.");
        }
    }

    if (OPENCV_URL === "") {
        throw new Error("No available OpenCV.js, please check your paths");
    }

    // Timeout guard: prevent indefinite hang on slow/broken networks
    const OPENCV_LOAD_TIMEOUT_MS = 30000;
    let settled = false;   // guard against double-dispatch of the timeout/error path
    let successDispatched = false;  // guard against firing the success callback twice
    let fellBack = false;  // only retry the plain-wasm fallback once
    const loadTimeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.error(`OpenCV.js load timeout after ${OPENCV_LOAD_TIMEOUT_MS}ms`);
        window.dispatchEvent(new CustomEvent('opencvLoadError', {
            detail: { error: 'timeout', url: OPENCV_URL }
        }));
    }, OPENCV_LOAD_TIMEOUT_MS);

    // Inject the OpenCV.js <script>. On a load error for an optimized build
    // (e.g. SIMD), retry once with the plain-wasm variant before giving up.
    function injectOpenCVScript(url) {
        const resolvedUrl = new URL(url, location.href).href;

        const handleLoad = () => {
            // Fire success even if the timeout already elapsed (settled === true):
            // a late load must still be able to flip the app back to Ready, which
            // is exactly the recovery main.js documents. Guard only against firing
            // success twice via a dedicated flag rather than the shared `settled`.
            if (successDispatched) return;
            successDispatched = true;
            settled = true;   // suppress any later timeout/error dispatch
            clearTimeout(loadTimeout);
            onloadCallback();
        };
        const handleError = () => {
            // A load already succeeded (possibly late); ignore a stray error.
            if (successDispatched) return;
            console.error('Failed to load opencv.js from:', url);
            // Single-retry fallback to the precached plain-wasm build.
            if (!fellBack && wasmSupported && wasmPath !== "" && url !== wasmPath) {
                fellBack = true;
                OPENCV_URL = wasmPath;
                console.warn('Retrying OpenCV.js load with the plain wasm build:', wasmPath);
                injectOpenCVScript(wasmPath);
                return;
            }
            if (settled) return;
            settled = true;
            clearTimeout(loadTimeout);
            window.dispatchEvent(new CustomEvent('opencvLoadError', {
                detail: { error: 'network', url: url }
            }));
        };

        // Prevent double-insertion: if this loader already injected a script for the
        // same resolved URL, do not add a duplicate (re-executing OpenCV re-runs the
        // wasm init). Settle from the existing element instead — invoke the success
        // callback if it already finished, or attach the listeners so a still-in-flight
        // load continues to settle. The previous guard compared only the first <script>
        // element's src and, on a match, inserted nothing and wired up no listeners, so
        // the load could only ever resolve via the 30s timeout (a spurious error even
        // when OpenCV was actually ready).
        const existing = Array.from(document.getElementsByTagName('script'))
            .find(s => s.src === resolvedUrl && s.dataset.opencvLoader === 'true');
        if (existing) {
            if (existing.dataset.opencvLoaded === 'true') {
                handleLoad();
            } else {
                existing.addEventListener('load', handleLoad);
                existing.addEventListener('error', handleError);
            }
            return;
        }

        const script = document.createElement('script');
        script.setAttribute('async', '');
        script.setAttribute('type', 'text/javascript');
        script.dataset.opencvLoader = 'true';
        script.addEventListener('load', () => {
            script.dataset.opencvLoaded = 'true';
            handleLoad();
        });
        script.addEventListener('error', handleError);
        script.src = url;

        // Insert before the first <script> (classic anchor idiom); fall back to
        // appending when there is none to dereference.
        const node = document.getElementsByTagName('script')[0];
        if (node && node.parentNode) {
            node.parentNode.insertBefore(script, node);
        } else {
            (document.head || document.documentElement).appendChild(script);
        }
    }

    injectOpenCVScript(OPENCV_URL);
}