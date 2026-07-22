/**
 * opencv-init.js
 * Load the custom OpenCV.js build with WASM feature detection.
 * Selects the best variant (SIMD > plain WASM) based on browser capabilities.
 * Fires 'opencv-ready' event once OpenCV is fully initialized.
 *
 * Depends on: wasm-feature-detect.umd.js, opencv/loader.js (must be loaded before this script)
 */
(function () {
    function fireReady() {
        console.log('OpenCV initialized successfully');

        // Diagnostic: check key functions/classes availability
        var cv = window.cv;
        console.log('  findFundamentalMat:', typeof cv.findFundamentalMat);
        console.log('  stereoRectifyUncalibrated:', typeof cv.stereoRectifyUncalibrated);
        var hasSGBM = typeof cv.StereoSGBM_create === 'function'
            || typeof cv.StereoSGBM === 'function';
        console.log('  StereoSGBM available:', hasSGBM);
        if (hasSGBM) {
            try {
                var sgbm;
                if (typeof cv.StereoSGBM_create === 'function') {
                    sgbm = cv.StereoSGBM_create(0, 16, 3);
                } else if (typeof cv.StereoSGBM.create === 'function') {
                    sgbm = cv.StereoSGBM.create(0, 16, 3);
                } else {
                    sgbm = new cv.StereoSGBM(0, 16, 3);
                }
                console.log('  StereoSGBM.compute:', typeof sgbm.compute);
                sgbm.delete();
            } catch (e) {
                console.warn('  StereoSGBM create/compute check failed:', e.message || e);
            }
        }

        window.dispatchEvent(new Event('opencv-ready'));
    }

    // Wait for onRuntimeInitialized if cv exists but isn't fully ready
    function waitForRuntime() {
        if (window.cv && window.cv.getBuildInformation) {
            fireReady();
        } else if (window.cv && typeof window.cv.then === 'function') {
            // OpenCV.js 4.x async module pattern
            window.cv.then(function (cvInstance) {
                window.cv = cvInstance;
                fireReady();
            }).catch(function (err) {
                console.error('OpenCV WASM initialization failed:', err);
                window.dispatchEvent(new CustomEvent('opencv-error', { detail: err }));
            });
        } else if (window.cv) {
            window.cv.onRuntimeInitialized = fireReady;
        } else {
            console.error('OpenCV load callback fired but cv is not defined');
        }
    }

    if (typeof loadOpenCV !== 'function') {
        console.error('opencv/loader.js must be loaded before opencv-init.js');
        return;
    }

    var pathsConfig = {
        wasm: './opencv/wasm/opencv.js',
        simd: './opencv/simd/opencv.js'
    };

    // loadOpenCV is async, so synchronous (and asynchronous) failures both surface
    // as a rejected promise. Handle them with .catch() — a sync try/catch would let
    // async rejections become unhandled and the 'opencv-error' event would never fire.
    Promise.resolve()
        .then(function () { return loadOpenCV(pathsConfig, waitForRuntime); })
        .catch(function (err) {
            console.error('Failed to start OpenCV loading:', err);
            window.dispatchEvent(new CustomEvent('opencv-error', { detail: err }));
        });
})();
