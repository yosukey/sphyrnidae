/**
 * bench/lib/stats.mjs
 *
 * Deterministic pseudo-randomness and order statistics shared by every
 * benchmark in this directory.
 *
 * Randomness: benchmarks must reproduce exactly from a seed, so Math.random is
 * never used here (the same rule the committed tests in tests/ follow), and a
 * seed quoted in a result file reproduces the same inputs on any machine and any
 * Node version.
 *
 * The generator is mulberry32: its whole state is 32 bits and every operation on
 * it is an exact 32-bit one. The textbook
 * `s = (s * 1103515245 + 12345) & 0x7fffffff` that the committed tests use
 * cannot be used here. Its product reaches 2.4e18, past the 9.0e15 up to which a
 * double still holds integers exactly, so the low bits are rounded away before
 * the mask and the sequence closes into a cycle of 10466 values — the same 10466
 * for every seed tried. A benchmark drawing hundreds of thousands of values
 * would be drawing that one short cycle over and over.
 *
 * Order statistics: timing distributions are right-skewed (a slow sample can be
 * arbitrarily slow; a fast one is bounded below), so the summaries here are
 * median and inter-quartile range rather than mean and standard deviation.
 * percentile() interpolates linearly between the two neighbouring ranks, which
 * matches the convention used by percentileSorted() in the application code.
 *
 * Pure functions only; no I/O.
 */

/**
 * Create a seeded pseudo-random generator returning values in [0, 1).
 *
 * mulberry32. Math.imul keeps each multiply an exact 32-bit operation, and the
 * counter advances by an odd increment, so the state visits all 2^32 values
 * before repeating whatever the seed.
 *
 * @param {number} seed - any integer; only its low 32 bits are used
 * @returns {() => number}
 */
export function createRng(seed) {
    let s = (seed >>> 0) || 1;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Draw one zero-mean Gaussian sample by the Box-Muller transform.
 *
 * @param {() => number} rng
 * @param {number} sigma - standard deviation
 * @returns {number}
 */
export function gaussian(rng, sigma) {
    const u1 = Math.max(1e-12, rng());
    const u2 = rng();
    return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Draw an integer in [lo, hi].
 *
 * @param {() => number} rng
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function randInt(rng, lo, hi) {
    return lo + Math.floor(rng() * (hi - lo + 1));
}

/**
 * Draw a real in [lo, hi).
 *
 * @param {() => number} rng
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function randRange(rng, lo, hi) {
    return lo + rng() * (hi - lo);
}

/**
 * Linear-interpolated percentile of an ascending-sorted array.
 *
 * @param {number[]} sorted - ascending, finite values
 * @param {number} q - in [0, 1]
 * @returns {number}
 */
export function percentile(sorted, q) {
    const n = sorted.length;
    if (!n) return 0;
    const qq = Math.max(0, Math.min(1, q));
    const idx = (n - 1) * qq;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const t = idx - lo;
    return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/**
 * Median of an unsorted array (the input is copied, not reordered).
 *
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
    if (!values.length) return 0;
    return percentile(values.slice().sort((a, b) => a - b), 0.5);
}

/**
 * Mean of an unsorted array.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function mean(values) {
    if (!values.length) return 0;
    let s = 0;
    for (const v of values) s += v;
    return s / values.length;
}

/**
 * Six-number summary plus the inter-quartile range. The input is copied.
 *
 * @param {number[]} values
 * @returns {{n:number, min:number, p25:number, median:number, p75:number, max:number, iqr:number}}
 */
export function summarize(values) {
    const n = values.length;
    if (!n) return { n: 0, min: 0, p25: 0, median: 0, p75: 0, max: 0, iqr: 0 };
    const s = values.slice().sort((a, b) => a - b);
    const p25 = percentile(s, 0.25);
    const p75 = percentile(s, 0.75);
    return {
        n,
        min: s[0],
        p25,
        median: percentile(s, 0.5),
        p75,
        max: s[n - 1],
        iqr: p75 - p25,
    };
}

/**
 * Largest absolute value in an array; 0 for an empty array.
 *
 * @param {number[]} values
 * @returns {number}
 */
export function maxAbs(values) {
    let m = 0;
    for (const v of values) {
        const a = Math.abs(v);
        if (a > m) m = a;
    }
    return m;
}

/**
 * Round to a fixed number of significant-looking decimals for CSV output,
 * keeping full precision for values that need it. Returns a string so the CSV
 * writer never re-formats a number.
 *
 * @param {number} v
 * @param {number} [decimals=6]
 * @returns {string}
 */
export function num(v, decimals = 6) {
    if (!Number.isFinite(v)) return String(v);
    if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential(3);
    return String(Number(v.toFixed(decimals)));
}

/**
 * Render rows as CSV. Values are emitted verbatim except that a field
 * containing a comma, quote or newline is quoted and its quotes doubled.
 *
 * @param {string[]} columns - column names, in output order
 * @param {Array<Object>} rows - one object per row, keyed by column name
 * @returns {string} CSV text, newline-terminated
 */
export function formatCsv(columns, rows) {
    const esc = (v) => {
        const s = v === undefined || v === null ? '' : String(v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [columns.join(',')];
    for (const row of rows) {
        lines.push(columns.map((c) => esc(row[c])).join(','));
    }
    return lines.join('\n') + '\n';
}
