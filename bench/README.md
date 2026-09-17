# bench

Measurement scripts for Sphyrnidae, and the results they produce.

Each benchmark drives the application's own modules rather than a copy of them.
Where a module cannot run outside a browser, the benchmark reproduces the call
sequence and says so in its file header; where a module is pure, it is imported
directly.

Nothing here is part of the application. The release workflow deletes this
directory from the tree before uploading, so it is never served from the
deployed site.

## Requirements

- Node.js 22 or newer. `node --test`, `node:zlib` and `process.report` are used
  without polyfills.
- No npm dependencies, except for `network-egress`, which needs Playwright and
  keeps it in its own `package.json` so the application and the other
  benchmarks stay dependency-free.
- `alignment-latency` and `alignment-accuracy` load the OpenCV.js builds from
  `opencv/`, which are already in the repository.
- `alignment-accuracy/end-to-end.mjs` needs a third-party corpus, downloaded by
  its own script. `network-egress` needs local copies of the CDN assets the
  application loads, also downloaded by its own script. Both land in
  `bench/datasets/`, which `.gitignore` excludes.

## Running the benchmarks

From the repository root:

```sh
node bench/alignment-latency/run.mjs
node bench/alignment-accuracy/estimator-sweep.mjs
node bench/alignment-accuracy/fetch-datasets.mjs      # once, ~160 MB
node bench/alignment-accuracy/end-to-end.mjs
node bench/params-roundtrip/run.mjs

cd bench/network-egress && npm install && node run.mjs
```

Every script accepts `--help`-less flags documented in its file header; the
defaults are what the committed results were produced with. Reducing a sample
count or a sweep axis is what the flags are for when checking that a script
still runs.

## The benchmarks

### alignment-latency

**What it measures.** Wall-clock time for the feature pipeline that
`js/rendering/alignment.js` runs when the user presses Auto-align: colour
conversion, feature detection and description on each eye, brute-force
descriptor matching with cross checking, and the two estimators that consume the
result.

**Factors.** The OpenCV.js build (`opencv/wasm`, plain WebAssembly, against
`opencv/simd`, WebAssembly with fixed-width SIMD); the algorithm (ORB, AKAZE,
SIFT); the side-by-side frame size; and the frame's texture content, which sets
how many keypoints the detector returns and therefore how much work the matcher
does. Two sweeps are run: one varies frame size at fixed content, the other
varies content at fixed frame size.

**Outputs.** `alignment-latency.csv` has one row per sweep, build and condition,
with the median, quartiles and range of the whole pipeline and the median of
each stage. `module_load_ms` is the time to read, compile and instantiate the
WebAssembly module, kept separate from the steady-state timings.
`alignment-latency-equivalence.csv` has one row per condition and compares what
the two builds computed for it: keypoint geometry, descriptor bytes and the
match list, each as an equality verdict and as a count of differing elements
out of the total.

**Conditions.** Each build runs in its own process, because both install the
same Emscripten runtime and a process that loaded one cannot load the other.
The frames come from `bench/lib/stereo-scene.mjs` at the sweep's size, so no
resampling happens before the pipeline. Timings are from Node's V8.

### alignment-accuracy

Two scripts, measuring the same estimators at different scopes.

#### estimator-sweep.mjs

**What it measures.** `estimateVerticalAffine()` on correspondences generated
from a vertical disparity field the benchmark chose, so the recovered field can
be compared with the true one. No image and no feature detector are involved.

**Factors.** The field's magnitude; the number of correspondences; whether they
are spread across the frame or clustered into part of it; Gaussian noise; the
fraction of correspondences that are outliers and whether those outliers are
random or lie on a second consistent plane; and whether the descriptor distances
carried alongside each point tell the estimator's prefilter anything about which
are outliers. Sweeps vary one factor at a time from a base condition.

**Outputs.** `alignment-accuracy-estimator.csv` has one row per condition, with
the adoption rate, the error in each recovered parameter in absolute and
relative terms, and the residual of the resulting correction over the frame
against the shift-only baseline.
`alignment-accuracy-estimator-reasons.csv` counts what the estimator decided,
by its own reason string, for each condition.
`alignment-accuracy-gate.csv` varies the adoption margin and reports, at each
value, the adoption rate for three classes: fields that the affine describes,
pure constants, and pure constants seen through the highest noise in the noise
sweep.

**Conditions.** Everything is drawn from a seeded generator recorded in the
manifest. The residual is evaluated over a uniform grid of the unit square. The
shift-only baseline is the median vertical disparity, which is what the constant
case of the same model reduces to.

#### end-to-end.mjs

**What it measures.** The same estimators reached through real photographs and
the real detector. The corpus is the half-resolution MiddEval3 training set:
rectified stereo pairs, each with a floating-point ground-truth disparity map
and a mask of the pixels visible in both views. A known vertical misalignment is
applied to the right eye, the frame is downscaled the way the application
downscales it, and the result goes through the same detector, matcher and
estimators. Because the disparity map gives the true correspondence of nearly
every pixel, the vertical disparity each pixel carries, and what remains of it
after a correction, is known over the whole frame rather than at the feature
matches alone.

`--corpus=synthetic` substitutes scenes from `bench/lib/stereo-scene.mjs`, which
is also what runs when the corpus has not been downloaded. Those scenes are
stacks of fronto-parallel planes, so their disparity and their visibility mask
are exact by construction rather than measured, but they carry none of what a
photograph carries beyond texture: no slanted surfaces, no specular highlights,
no lens or sensor behaviour. The corpus the committed results came from is named
in the manifest.

**Factors.** The scene; the applied misalignment, which ranges from none through
a pure vertical shift to combined roll and vertical zoom, and finally a
perspective warp that the fitted family cannot represent; and the algorithm.

**Outputs.** `alignment-accuracy-end-to-end.csv` has one row per scene,
condition and algorithm. It records what the estimator decided and recovered,
and the residual vertical disparity in pixels and in normalized units for four
cases: uncorrected, after the shift-only correction, after the correction the
application would actually apply, and after the least-squares best fit of the
same three-parameter field to the true correspondences.
`alignment-accuracy-depth.csv` records how much each of three corrections
changes the scene's horizontal disparity, alongside the spread of that disparity
in the scene itself. The three are the matrix `estimateVerticalAffine` returned,
the affine `cv.estimateAffine2D` fits from the right eye's matched keypoints to
the left eye's, and the projective transform `cv.findHomography` fits from the
same matches.

**Conditions.** The misalignment is applied as a function of right-image
coordinates, which is how a camera rig's roll and vertical-scale error act. The
frame is resampled to the analysis size with `cv.resize` and `INTER_AREA`; the
application reaches that size through a canvas `drawImage` instead, which there
is no equivalent of outside a browser. Measurements are taken over pixels the
mask marks as visible in both views and whose ground-truth disparity is finite,
sampled at the stride recorded in the manifest. A single global horizontal shift
moves a scene towards or away from the viewer without altering relative depth,
so it is removed before the horizontal-disparity spread is reported.

### params-roundtrip

**What it measures.** How much of a view state survives being written to a link
and read back. `js/core/export-params.js` writes the `?src=` viewer link and the
URL-list line; `js/url-params.js` parses them, and
`js/loaders/loader-external.js` rebuilds the state from what it parsed. The
benchmark drives that circle with generated states.

**Factors.** The link format, viewer or list; the image size the pixel-valued
parameters are written against; and the population, either states inside the
limits the parsers enforce or states deliberately outside them.

**Outputs.** `params-roundtrip.csv` has one row per link format, population,
parameter and image size, with the median, 99th percentile and maximum error.
For the in-range population it also carries the error the serialization format
admits, derived from how each parameter is written, and whether the measured
maximum stayed within it. `params-roundtrip-invariants.csv` has one row per
invariant checked, with the number of violations. `params-roundtrip-fuzz.csv`
has one row per parser, counting what malformed input produced: exceptions,
rejections, acceptances, and acceptances outside the range the parser documents.

**Conditions.** The state is reduced to the quantities the shader consumes
before being compared. The vertical value is compared as `shiftY` minus
`alignTransform[7]`, because the exporter folds both into a single `y` and
`splitVerticalShift` may divide it differently on the way back; how often it
does is one of the invariant rows. Generated states have the shape the
application produces: the alignment matrix is either the identity or a roll and
zoom matrix with a folded vertical constant.

### network-egress

**What it measures.** Every network request the application makes while a
workflow runs in a real browser, and what remains in the browser's storage
afterwards. Requests from the page, its workers and its Service Worker are all
captured before they leave.

**Factors.** The scenario — a stereo image opened from disk and taken through
the whole workflow, or the same image requested through `?src=` from a
third-party host — and the browser engine.

**Outputs.** `network-egress.csv` has one row per engine and scenario, with how
many workflow steps completed, how many requests were made and how they
classify, the total bytes sent in request bodies, and what was found in storage.
`network-egress-requests.csv` groups the requests by classification, method,
resource type and whether the Service Worker issued them.
`network-egress-export-parity.csv` compares the clipboard line the running
application produced with the line `js/core/export-params.js` produces from the
state the page reported. `network-egress-detail.json` carries every individual
request, the per-step outcomes and the full storage audit.

**Conditions.** The application is served locally with the response headers from
the repository's `_headers` file, so the page runs under the deployed
Content-Security-Policy. Requests for the CDN assets listed in
`CDN_PRECACHE_URLS` in `sw.js` are answered from a local mirror whose bytes are
checked against the integrity hashes the application declares, in index.html, in
its import map and in `js/ui/ui-export.js`; the requests themselves are recorded
before being answered. The `?src=` host is a reserved `.invalid` hostname
answered inside the browser context, so the request is recorded as issued and
nothing leaves the machine. The test image carries a random marker in an
uncompressed PNG text chunk, and the storage audit searches every Cache Storage
entry and every Web Storage value for it. Engines that Playwright cannot launch
in the environment are skipped, and the manifest records which ran.

## Measurement protocol

- Every generated input comes from a seeded linear congruential generator, the
  one the committed tests in `tests/` use. `Math.random` is not called.
- Timing benchmarks discard warm-up runs, then measure until a repetition count
  or a per-condition time budget is reached, whichever comes first. The
  repetitions actually taken are recorded in the `runs` column.
- Timings are summarized by median and inter-quartile range rather than mean and
  standard deviation.
- Where two OpenCV builds are compared, each runs in its own process.
- Absolute timings depend on the machine, so they are only comparable within one
  result file, whose manifest records the machine they came from.

## Result files

`bench/results/` holds one CSV per table and one `<benchmark>.manifest.json` per
benchmark run. The manifest records:

- the benchmark name and when it ran;
- the commit the checkout was at, and whether anything outside `bench/results/`
  differed from it;
- `source_digest`, a hash of the code the run measured: every file under
  `bench/`, `js/` and `sw.js`, excluding results, downloaded corpora and
  installed dependencies. It identifies that code without reference to any
  commit, which is what `commit` cannot do when results are committed alongside
  the code they measure — the commit holding them is the one being written, and
  cannot be named from inside itself. Recompute it from any checkout with:

  ```sh
  node -e "import('./bench/lib/run-manifest.mjs').then(m => console.log(m.sourceDigest().digest))"
  ```

  A digest that matches the one in a result file means that file came from the
  code in that checkout, whichever way the two were committed;
- the Node and V8 versions, the operating system, the CPU model and count, and
  the total memory;
- the parameters the run used: seeds, repetition counts, sweep axes, corpus
  identifiers;
- the tables written, with their columns and row counts.

Column names are the measured quantity. Durations end in `_ms`, byte counts in
`_bytes`, pixel quantities in `_px`, and normalized quantities in `_uv`, which
is the per-eye coordinate space the shader works in: `u` across one eye's width,
`v` up the frame, both in `[0, 1]`.

## Recording the measurement environment

The manifest captures what can be read from the process. Anything else that
affects a timing result is worth writing down alongside the results:

- whether the machine was on mains power, and whether it had been idle long
  enough to be at a steady temperature;
- what else was running;
- for `network-egress`, the browser versions, which the manifest records under
  `engines_run`;
- for `alignment-accuracy/end-to-end.mjs`, the corpus revision, which its
  `fetch-datasets.mjs` pins by checksum.
