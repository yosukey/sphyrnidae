/**
 * bench/alignment-accuracy/estimator-sweep.mjs
 *
 * Measures estimateVerticalAffine() on correspondences whose true vertical
 * disparity field is known exactly.
 *
 * js/rendering/alignment-geometry.js fits the field
 *
 *   disp(u, v) = d * u + e * v + f
 *
 * to the per-match vertical disparity, by iteratively reweighted least squares
 * with a Huber weight, and then decides whether to adopt the fit or fall back to
 * the shift-only correction. This benchmark generates points from a field it
 * chose, hands them to the estimator, and compares what comes back. No image and
 * no feature detector are involved, so what is measured is the estimator alone;
 * end-to-end.mjs covers the same estimator reached through real images.
 *
 * Generated factors
 *   roll, zoom, offset  the true field, expressed as the roll angle and
 *                       vertical-zoom difference the application reports, plus a
 *                       constant vertical offset
 *   point count         how many correspondences the matcher supplied
 *   layout              uniform across the frame, or clustered into part of it,
 *                       which is what the estimator's spread gate examines
 *   noise               Gaussian, in normalized vertical units
 *   outlier fraction    points whose disparity does not come from the field
 *   outlier model       random disparities, or a second consistent plane, which
 *                       is what repetitive texture produces
 *   distance model      whether the descriptor distances carried alongside each
 *                       point tell the estimator's prefilter anything about
 *                       which points are outliers
 *
 * Sweeps vary one factor at a time from a base condition rather than crossing
 * every factor, so each row differs from the base in one respect.
 *
 * Outputs
 *   alignment-accuracy-estimator.csv         one row per condition
 *   alignment-accuracy-estimator-reasons.csv one row per (condition, outcome),
 *                                            counting what the estimator decided
 *   alignment-accuracy-gate.csv              adoption rate for fields that do and
 *                                            do not need the affine, as the
 *                                            adoption margin varies
 *
 * Usage
 *   node bench/alignment-accuracy/estimator-sweep.mjs [--trials=2000] [--seed=...]
 */

import { estimateVerticalAffine } from '../../js/rendering/alignment-geometry.js';
import { createRng, gaussian, randRange, percentile, median, num } from '../lib/stats.mjs';
import { writeTables } from '../lib/run-manifest.mjs';

/**
 * Grid the ground-truth residual is evaluated over. The residual field is
 * affine in u and v, so a modest grid captures it exactly up to the sampling of
 * the square.
 */
const GRID = 51;

/** Default adoption margin in alignment-geometry.js, swept in the gate table. */
const DEFAULT_RESIDUAL_MARGIN_FRAC = 0.15;

/** Margins the gate table sweeps. */
const GATE_MARGINS = [0, 0.05, 0.1, DEFAULT_RESIDUAL_MARGIN_FRAC, 0.2, 0.3, 0.5];

/**
 * Outlier fraction the outlier-model and distance-model sweeps run at.
 *
 * Chosen from the outlier-fraction sweep, which shows the estimator adopting at
 * essentially every trial up to 0.4 with its parameter error barely moving, and
 * breaking down at 0.6. Below that band neither how the outliers are
 * distributed nor whether the prefilter can see them has room to matter, and
 * both sweeps would measure the same comfortable case twice; this sits just
 * inside the edge, where they can.
 */
const OUTLIER_SWEEP_FRACTION = 0.5;

/** Condition every sweep varies one factor of. */
const BASE_CONDITION = {
    rollDeg: null,        // null means "drawn per trial from the in-range band"
    zoomPct: null,
    offsetUv: null,
    count: 200,
    layout: 'uniform',
    noiseSigmaUv: 3e-4,
    outlierFraction: 0,
    outlierModel: 'random',
    distanceModel: 'random',
};

/**
 * Parameter magnitudes the estimator accepts: |d| up to maxRollAbsD (0.18) and
 * |e| up to maxZoomAbs (0.06) in its own units. Expressed here as the roll angle
 * and zoom percentage those correspond to.
 */
const MAX_ROLL_DEG = Math.atan(0.18) * 180 / Math.PI;
const MAX_ZOOM_PCT = 6;

/**
 * Parse `--name=value` arguments.
 *
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv) {
    const out = {};
    for (const arg of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
        if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}

/**
 * Convert the reported roll and zoom into the estimator's own coefficients.
 *
 * @param {number} rollDeg
 * @param {number} zoomPct
 * @returns {{d:number, e:number}}
 */
function toCoefficients(rollDeg, zoomPct) {
    return { d: Math.tan(rollDeg * Math.PI / 180), e: zoomPct / 100 };
}

/**
 * Generate correspondences from a known field.
 *
 * @param {() => number} rng
 * @param {Object} condition
 * @param {{d:number, e:number, f:number}} field
 * @returns {Array<{u:number, v:number, t:number, dist:number}>}
 */
function generatePoints(rng, condition, field) {
    const { count, layout, noiseSigmaUv, outlierFraction, outlierModel, distanceModel } = condition;
    const points = new Array(count);

    // A clustered layout confines the points to a randomly placed sub-square,
    // which is the situation the estimator's spread gate is there to catch.
    const clusterSize = 0.25;
    const clusterU = randRange(rng, 0, 1 - clusterSize);
    const clusterV = randRange(rng, 0, 1 - clusterSize);

    // The structured outlier model puts its points on a second consistent
    // plane, the way a repetitive texture produces a self-consistent set of
    // wrong matches.
    const rogue = {
        d: randRange(rng, -0.3, 0.3),
        e: randRange(rng, -0.2, 0.2),
        f: randRange(rng, -0.08, 0.08),
    };

    for (let i = 0; i < count; i++) {
        const u = layout === 'clustered' ? clusterU + rng() * clusterSize : rng();
        const v = layout === 'clustered' ? clusterV + rng() * clusterSize : rng();
        const isOutlier = rng() < outlierFraction;
        let t;
        if (!isOutlier) {
            t = field.d * u + field.e * v + field.f + gaussian(rng, noiseSigmaUv);
        } else if (outlierModel === 'structured') {
            t = rogue.d * u + rogue.e * v + rogue.f + gaussian(rng, noiseSigmaUv);
        } else {
            t = randRange(rng, -0.2, 0.2);
        }
        // The estimator keeps the best 60% of points by descriptor distance. In
        // the informative model an outlier's distance is drawn from a worse
        // band, so that prefilter removes some of them; in the random model the
        // distance carries no information and the prefilter cannot help.
        const dist = distanceModel === 'informative'
            ? (isOutlier ? randRange(rng, 60, 120) : randRange(rng, 0, 60))
            : randRange(rng, 0, 120);
        points[i] = { u, v, t, dist };
    }
    return points;
}

/**
 * Root-mean-square of a residual field over the unit square.
 *
 * @param {number} dd - error in the u coefficient
 * @param {number} de - error in the v coefficient
 * @param {number} df - error in the constant
 * @returns {number}
 */
function residualRms(dd, de, df) {
    let sum = 0;
    for (let i = 0; i < GRID; i++) {
        const u = i / (GRID - 1);
        for (let j = 0; j < GRID; j++) {
            const v = j / (GRID - 1);
            const r = dd * u + de * v + df;
            sum += r * r;
        }
    }
    return Math.sqrt(sum / (GRID * GRID));
}

/**
 * Run one condition.
 *
 * @param {() => number} rng
 * @param {Object} condition
 * @param {number} trials
 * @param {Object} [estimatorOptions]
 * @returns {Object} aggregate for the condition, plus the outcome histogram
 */
function runCondition(rng, condition, trials, estimatorOptions = {}) {
    const errD = [];
    const errE = [];
    const errF = [];
    const errRollDeg = [];
    const errZoomPct = [];
    const relRollDeg = [];
    const relZoomPct = [];
    const residualShiftOnly = [];
    const residualApplied = [];
    const reasons = new Map();
    let adopted = 0;

    for (let trial = 0; trial < trials; trial++) {
        // A magnitude scale draws the field log-uniformly across decades, so a
        // sweep can cover the range where adoption is a marginal decision as
        // densely as the range where it is obvious.
        const scale = condition.magnitudeScale
            ? Math.pow(10, randRange(rng, condition.magnitudeScale[0], condition.magnitudeScale[1]))
            : 1;
        const sign = () => (rng() < 0.5 ? -1 : 1);
        const rollDeg = condition.rollDeg ?? (condition.magnitudeScale
            ? MAX_ROLL_DEG * scale * sign()
            : randRange(rng, -MAX_ROLL_DEG, MAX_ROLL_DEG));
        const zoomPct = condition.zoomPct ?? (condition.magnitudeScale
            ? MAX_ZOOM_PCT * scale * sign()
            : randRange(rng, -MAX_ZOOM_PCT, MAX_ZOOM_PCT));
        const offsetUv = condition.offsetUv ?? randRange(rng, -0.05, 0.05);
        const { d, e } = toCoefficients(rollDeg, zoomPct);
        const field = { d, e, f: offsetUv };

        const points = generatePoints(rng, condition, field);
        const result = estimateVerticalAffine(points, estimatorOptions);

        reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1);

        // The shift-only baseline is the best single constant: the median
        // vertical disparity, which is what the constant case of this same
        // model reduces to.
        const f0 = median(points.map((p) => p.t));
        residualShiftOnly.push(residualRms(field.d, field.e, field.f - f0));

        if (result.adopted) {
            adopted++;
            errD.push(Math.abs(result.d - field.d));
            errE.push(Math.abs(result.e - field.e));
            errF.push(Math.abs(result.f - field.f));
            errRollDeg.push(Math.abs(result.rollDeg - rollDeg));
            errZoomPct.push(Math.abs(result.zoomPct - zoomPct));
            // Relative error separates a bias proportional to the true value
            // from one independent of it; the two have different causes.
            if (Math.abs(rollDeg) > 1e-6) relRollDeg.push(Math.abs(result.rollDeg - rollDeg) / Math.abs(rollDeg));
            if (Math.abs(zoomPct) > 1e-6) relZoomPct.push(Math.abs(result.zoomPct - zoomPct) / Math.abs(zoomPct));
            residualApplied.push(residualRms(field.d - result.d, field.e - result.e, field.f - result.f));
        } else {
            // Not adopting means the application keeps the shift-only path, so
            // the applied residual is the baseline residual.
            residualApplied.push(residualShiftOnly[residualShiftOnly.length - 1]);
        }
    }

    const stat = (values, q) => (values.length ? percentile(values.slice().sort((a, b) => a - b), q) : '');

    return {
        adopted,
        trials,
        reasons,
        row: {
            trials,
            adopted,
            adoption_rate: num(adopted / trials, 6),
            err_d_median: num(stat(errD, 0.5), 9),
            err_d_p95: num(stat(errD, 0.95), 9),
            err_e_median: num(stat(errE, 0.5), 9),
            err_e_p95: num(stat(errE, 0.95), 9),
            err_f_median: num(stat(errF, 0.5), 9),
            err_f_p95: num(stat(errF, 0.95), 9),
            err_roll_deg_median: num(stat(errRollDeg, 0.5), 9),
            err_roll_deg_p95: num(stat(errRollDeg, 0.95), 9),
            err_zoom_pct_median: num(stat(errZoomPct, 0.5), 9),
            err_zoom_pct_p95: num(stat(errZoomPct, 0.95), 9),
            err_roll_relative_median: num(stat(relRollDeg, 0.5), 9),
            err_roll_relative_p95: num(stat(relRollDeg, 0.95), 9),
            err_zoom_relative_median: num(stat(relZoomPct, 0.5), 9),
            err_zoom_relative_p95: num(stat(relZoomPct, 0.95), 9),
            residual_shift_only_rms_median: num(stat(residualShiftOnly, 0.5), 9),
            residual_applied_rms_median: num(stat(residualApplied, 0.5), 9),
            residual_applied_rms_p95: num(stat(residualApplied, 0.95), 9),
        },
    };
}

/**
 * Build the list of conditions: a base condition, then one variation per level
 * of each swept factor.
 *
 * @returns {Array<{sweep:string, condition:Object}>}
 */
function buildConditions() {
    // Each sweep varies one factor from the base condition. The two that
    // describe outliers also raise the outlier fraction: the base condition has
    // none, and with none the outlier model is never consulted and the
    // descriptor distances the prefilter sorts by carry nothing to be
    // informative about, so both sweeps would measure the same thing twice.
    const sweeps = [
        ['noise', { noiseSigmaUv: [0, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2] }],
        ['point-count', { count: [30, 50, 120, 200, 500, 900] }],
        ['outlier-fraction', { outlierFraction: [0, 0.05, 0.1, 0.2, 0.4, 0.6] }],
        ['outlier-model', { outlierModel: ['random', 'structured'] }, { outlierFraction: OUTLIER_SWEEP_FRACTION }],
        ['distance-model', { distanceModel: ['random', 'informative'] }, { outlierFraction: OUTLIER_SWEEP_FRACTION }],
        ['layout', { layout: ['uniform', 'clustered'] }],
    ];

    const conditions = [{ sweep: 'base', condition: { ...BASE_CONDITION } }];
    for (const [sweep, varied, fixed = {}] of sweeps) {
        const [key, levels] = Object.entries(varied)[0];
        for (const level of levels) {
            conditions.push({ sweep, condition: { ...BASE_CONDITION, ...fixed, [key]: level } });
        }
    }

    // A magnitude sweep needs both the outlier setting and the field pinned, so
    // it sets two fields rather than one.
    const magnitudes = [
        ['zero', 0, 0],
        ['small', MAX_ROLL_DEG * 0.1, MAX_ZOOM_PCT * 0.1],
        ['mid', MAX_ROLL_DEG * 0.5, MAX_ZOOM_PCT * 0.5],
        ['large', MAX_ROLL_DEG, MAX_ZOOM_PCT],
    ];
    for (const [name, rollDeg, zoomPct] of magnitudes) {
        conditions.push({
            sweep: 'field-magnitude',
            magnitude: name,
            condition: { ...BASE_CONDITION, rollDeg, zoomPct },
        });
    }

    return conditions;
}

/**
 * Measure how the adoption gate separates fields that need the affine from
 * fields that do not, as its margin varies.
 *
 * Three classes are run at every margin:
 *   positive        roll and zoom drawn log-uniformly across three decades below
 *                   the estimator's own limits, so the sweep spends most of its
 *                   trials where adoption is a marginal decision rather than an
 *                   obvious one
 *   negative        no roll and no zoom: a pure constant, which the shift-only
 *                   correction already removes
 *   hard-negative   the same pure constant seen through the highest noise in the
 *                   noise sweep, where a fit has the most room to find structure
 *                   that is not there
 *
 * @param {() => number} rng
 * @param {number} trials - per class, per margin
 * @returns {Array<Object>}
 */
function runGateSweep(rng, trials) {
    const rows = [];
    for (const margin of GATE_MARGINS) {
        const options = { residualMarginFrac: margin };
        const positive = runCondition(
            rng,
            { ...BASE_CONDITION, rollDeg: null, zoomPct: null, magnitudeScale: [-3, 0] },
            trials,
            options,
        );
        const negative = runCondition(
            rng,
            { ...BASE_CONDITION, rollDeg: 0, zoomPct: 0 },
            trials,
            options,
        );
        const hardNegative = runCondition(
            rng,
            { ...BASE_CONDITION, rollDeg: 0, zoomPct: 0, noiseSigmaUv: 1e-2 },
            trials,
            options,
        );
        rows.push({
            residual_margin_frac: num(margin, 6),
            is_default: String(margin === DEFAULT_RESIDUAL_MARGIN_FRAC),
            positive_trials: positive.trials,
            positive_adopted: positive.adopted,
            true_positive_rate: num(positive.adopted / positive.trials, 6),
            negative_trials: negative.trials,
            negative_adopted: negative.adopted,
            false_positive_rate: num(negative.adopted / negative.trials, 6),
            hard_negative_trials: hardNegative.trials,
            hard_negative_adopted: hardNegative.adopted,
            hard_negative_rate: num(hardNegative.adopted / hardNegative.trials, 6),
            positive_residual_applied_rms_median: positive.row.residual_applied_rms_median,
            positive_residual_shift_only_rms_median: positive.row.residual_shift_only_rms_median,
            negative_residual_applied_rms_median: negative.row.residual_applied_rms_median,
            negative_residual_shift_only_rms_median: negative.row.residual_shift_only_rms_median,
            hard_negative_residual_applied_rms_median: hardNegative.row.residual_applied_rms_median,
            hard_negative_residual_shift_only_rms_median: hardNegative.row.residual_shift_only_rms_median,
        });
    }
    return rows;
}

/** Columns describing a condition, shared by the main and reasons tables. */
const CONDITION_COLUMNS = [
    'sweep', 'condition_id', 'field_magnitude', 'point_count', 'layout',
    'noise_sigma_uv', 'outlier_fraction', 'outlier_model', 'distance_model',
];

/** Columns of the per-condition table. */
const CONDITION_RESULT_COLUMNS = [
    ...CONDITION_COLUMNS,
    'trials', 'adopted', 'adoption_rate',
    'err_d_median', 'err_d_p95', 'err_e_median', 'err_e_p95', 'err_f_median', 'err_f_p95',
    'err_roll_deg_median', 'err_roll_deg_p95', 'err_zoom_pct_median', 'err_zoom_pct_p95',
    'err_roll_relative_median', 'err_roll_relative_p95',
    'err_zoom_relative_median', 'err_zoom_relative_p95',
    'residual_shift_only_rms_median', 'residual_applied_rms_median', 'residual_applied_rms_p95',
];

/** Columns of the outcome histogram. */
const REASON_COLUMNS = [...CONDITION_COLUMNS, 'outcome', 'count', 'trials'];

/** Columns of the gate table. */
const GATE_COLUMNS = [
    'residual_margin_frac', 'is_default',
    'positive_trials', 'positive_adopted', 'true_positive_rate',
    'negative_trials', 'negative_adopted', 'false_positive_rate',
    'hard_negative_trials', 'hard_negative_adopted', 'hard_negative_rate',
    'positive_residual_applied_rms_median', 'positive_residual_shift_only_rms_median',
    'negative_residual_applied_rms_median', 'negative_residual_shift_only_rms_median',
    'hard_negative_residual_applied_rms_median', 'hard_negative_residual_shift_only_rms_median',
];

const args = parseArgs(process.argv.slice(2));
const trials = Number(args.trials ?? 2000);
const seed = Number(args.seed ?? 20240917);
const rng = createRng(seed);

const conditionRows = [];
const reasonRows = [];

for (const [index, entry] of buildConditions().entries()) {
    const { sweep, condition, magnitude } = entry;
    const descriptor = {
        sweep,
        condition_id: index,
        field_magnitude: magnitude ?? (condition.rollDeg === null ? 'random' : 'fixed'),
        point_count: condition.count,
        layout: condition.layout,
        noise_sigma_uv: num(condition.noiseSigmaUv, 9),
        outlier_fraction: num(condition.outlierFraction, 6),
        outlier_model: condition.outlierModel,
        distance_model: condition.distanceModel,
    };
    const result = runCondition(rng, condition, trials);
    conditionRows.push({ ...descriptor, ...result.row });
    for (const [outcome, count] of [...result.reasons].sort((a, b) => b[1] - a[1])) {
        reasonRows.push({ ...descriptor, outcome, count, trials });
    }
    process.stderr.write(
        `  ${sweep.padEnd(17)} #${String(index).padStart(2)}: ` +
        `adopted ${(100 * result.adopted / trials).toFixed(1)}%\n`,
    );
}

process.stderr.write('  gate sweep\n');
const gateRows = runGateSweep(rng, trials);

const { csvPaths } = writeTables({
    bench: 'alignment-accuracy-estimator',
    tables: [
        { name: 'alignment-accuracy-estimator', columns: CONDITION_RESULT_COLUMNS, rows: conditionRows },
        { name: 'alignment-accuracy-estimator-reasons', columns: REASON_COLUMNS, rows: reasonRows },
        { name: 'alignment-accuracy-gate', columns: GATE_COLUMNS, rows: gateRows },
    ],
    parameters: {
        seed,
        trials_per_condition: trials,
        base_condition: BASE_CONDITION,
        gate_margins: GATE_MARGINS,
        default_residual_margin_frac: DEFAULT_RESIDUAL_MARGIN_FRAC,
        max_roll_deg: MAX_ROLL_DEG,
        max_zoom_pct: MAX_ZOOM_PCT,
        residual_grid: GRID,
    },
});

process.stderr.write(`\nwrote:\n${csvPaths.map((p) => `  ${p}`).join('\n')}\n`);
