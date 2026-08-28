'use strict';

const { Op } = require('sequelize');
const logger = require('../utils/logger');

// Below this many labeled examples a fitted curve is noise, not signal — stay
// at identity rather than let a handful of teacher corrections skew scores.
// Raised from 8 once cross-validation was added: 8 points cannot be split into
// folds that say anything trustworthy about held-out error.
const MIN_SAMPLES_FOR_CALIBRATION = 24;

// Sanity bounds on the fitted linear slope. With few, noisy points OLS can
// produce a negative or wildly steep slope that would invert or explode
// scores; such a fit is treated as not fitted rather than applied. A real
// teacher-vs-model recalibration should always be a mild monotone adjustment.
const MIN_CALIBRATION_SLOPE = 0.25;
const MAX_CALIBRATION_SLOPE = 4;

// A calibration must earn its place: cross-validated mean absolute error has
// to beat leaving the score alone by at least this many points. Without this
// gate "fitted" only ever meant "enough points and a plausible slope", which
// says nothing about whether applying the curve actually helps.
const MIN_MAE_IMPROVEMENT = 1;

// An isotonic fit that collapses into fewer blocks than this carries no usable
// monotone signal — in the limit it is a single block, i.e. "predict the mean
// for every input", which would erase the model's output entirely. Reducing
// error on such a fit is a symptom of no relationship, not of a good one.
const MIN_ISOTONIC_BLOCKS = 3;

// Isotonic has to beat the straight line by this margin to be preferred; a
// line is easier to reason about and to explain in a writeup, so ties go to it.
const ISOTONIC_PREFERENCE_MARGIN = 0.5;

const CV_FOLDS = 5;

// Teacher reviews trickle in slowly compared to scoring requests; recomputing
// per-request would hammer the DB for no benefit, so a fit is reused for a
// while before it's refreshed from the latest reviewed rows. Submitting a
// review invalidates the affected population explicitly
// (see invalidateCalibrationCache), so the TTL is only a backstop.
const CACHE_TTL_MS = 10 * 60 * 1000;

const calibrationCache = new Map();

function normalizePopulationTag(disability) {
  const trimmed = String(disability || '').trim().toLowerCase();
  return trimmed || 'unspecified';
}

const IDENTITY = Object.freeze({ slope: 1, intercept: 0, model: 'identity' });

function identityFit(sampleSize, extra = {}) {
  return { ...IDENTITY, sample_size: sampleSize, fitted: false, ...extra };
}

/**
 * Reads the model's adaptive_score for a result row. Prefers the top-level
 * column and falls back to the recommendation_details JSONB, which is where
 * the value lived before it was promoted to a column — rows scored before
 * that promotion are still usable calibration evidence.
 */
function getAdaptiveScore(result) {
  const column = result?.adaptive_score;
  if (Number.isFinite(column)) return column;
  const nested = result?.recommendation_details?.adaptive_model?.adaptive_score;
  return Number.isFinite(nested) ? nested : null;
}

function getOverallScore(result) {
  const score = result?.overall_score;
  return Number.isFinite(score) ? score : null;
}

// ---------------------------------------------------------------------------
// Candidate models
// ---------------------------------------------------------------------------

/** Ordinary least squares. Returns null when the fit is unusable. */
function fitLinear(pairs) {
  const n = pairs.length;
  if (n < 2) return null;

  const meanX = pairs.reduce((total, [x]) => total + x, 0) / n;
  const meanY = pairs.reduce((total, [, y]) => total + y, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  for (const [x, y] of pairs) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
  }
  if (varianceX < 1e-6) return null;

  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;
  if (slope < MIN_CALIBRATION_SLOPE || slope > MAX_CALIBRATION_SLOPE) {
    return { model: 'linear', slope, intercept, rejected: true };
  }
  return { model: 'linear', slope, intercept };
}

/**
 * Isotonic regression by pool-adjacent-violators. Chosen as the second
 * candidate because it fixes two specific weaknesses of the straight line here:
 *
 *  - it is monotone by construction, so it can never invert scores, and
 *  - it extrapolates flat rather than linearly. That matters because the
 *    reviewed corpus is not a random sample (the review queue does uncertainty
 *    sampling), so the fit is estimated mostly in the mid-confidence region;
 *    a line would happily extrapolate that local slope out to 0 and 100, while
 *    a step function just holds the nearest observed level.
 */
function fitIsotonic(pairs) {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const blocks = [];

  for (const [x, y] of sorted) {
    blocks.push({ sumX: x, sumY: y, count: 1, mean: y });
    while (blocks.length > 1 && blocks[blocks.length - 2].mean > blocks[blocks.length - 1].mean) {
      const right = blocks.pop();
      const left = blocks.pop();
      const merged = {
        sumX: left.sumX + right.sumX,
        sumY: left.sumY + right.sumY,
        count: left.count + right.count,
      };
      merged.mean = merged.sumY / merged.count;
      blocks.push(merged);
    }
  }

  if (blocks.length < MIN_ISOTONIC_BLOCKS) {
    return { model: 'isotonic', knots: [], blocks: blocks.length, rejected: true };
  }

  // One knot per block, anchored at the block's mean x. Duplicate x values can
  // land two blocks on the same anchor; keep the later one so knots stay
  // strictly increasing and interpolation never divides by zero.
  const knots = [];
  for (const block of blocks) {
    const x = block.sumX / block.count;
    if (knots.length && x <= knots[knots.length - 1][0]) {
      knots[knots.length - 1] = [x, block.mean];
    } else {
      knots.push([x, block.mean]);
    }
  }

  if (knots.length < MIN_ISOTONIC_BLOCKS) {
    return { model: 'isotonic', knots, blocks: knots.length, rejected: true };
  }
  return { model: 'isotonic', knots, blocks: knots.length };
}

function predict(fit, score) {
  if (!fit || !Number.isFinite(score)) return score;

  if (fit.model === 'isotonic') {
    const knots = fit.knots || [];
    if (!knots.length) return score;
    if (score <= knots[0][0]) return knots[0][1];
    const last = knots[knots.length - 1];
    if (score >= last[0]) return last[1];
    for (let i = 1; i < knots.length; i += 1) {
      const [x0, y0] = knots[i - 1];
      const [x1, y1] = knots[i];
      if (score <= x1) {
        return y0 + ((score - x0) / (x1 - x0)) * (y1 - y0);
      }
    }
    return last[1];
  }

  const slope = Number.isFinite(fit.slope) ? fit.slope : 1;
  const intercept = Number.isFinite(fit.intercept) ? fit.intercept : 0;
  return slope * score + intercept;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function meanAbsoluteError(errors) {
  if (!errors.length) return null;
  return errors.reduce((total, value) => total + Math.abs(value), 0) / errors.length;
}

/**
 * k-fold cross-validated MAE for one candidate model, alongside the MAE of
 * doing nothing. Folds are assigned by sorting on x and dealing round-robin,
 * which stratifies across the score range — with a corpus this small, a random
 * split can easily hand one fold every low score and make the result luck.
 */
function crossValidate(pairs, fitFn, folds = CV_FOLDS) {
  const usableFolds = Math.max(2, Math.min(folds, Math.floor(pairs.length / 4)));
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const modelErrors = [];
  const identityErrors = [];

  for (let fold = 0; fold < usableFolds; fold += 1) {
    const train = [];
    const test = [];
    sorted.forEach((pair, index) => {
      (index % usableFolds === fold ? test : train).push(pair);
    });
    if (!test.length || train.length < 2) continue;

    const fit = fitFn(train);
    // A candidate that cannot be fitted (or is rejected outright) on a fold
    // scores as no better than identity for that fold rather than being
    // silently skipped, which would flatter an unstable model.
    for (const [x, y] of test) {
      identityErrors.push(x - y);
      modelErrors.push(!fit || fit.rejected ? x - y : predict(fit, x) - y);
    }
  }

  const maeCalibrated = meanAbsoluteError(modelErrors);
  const maeIdentity = meanAbsoluteError(identityErrors);
  if (maeCalibrated == null || maeIdentity == null) return null;

  return {
    folds: usableFolds,
    mae_identity: Number(maeIdentity.toFixed(3)),
    mae_calibrated: Number(maeCalibrated.toFixed(3)),
    mae_improvement: Number((maeIdentity - maeCalibrated).toFixed(3)),
  };
}

/**
 * Fits a recalibration curve from [model_score, teacher_reviewed_score] pairs.
 *
 * Two candidates are fitted (straight line, isotonic step) and both are
 * cross-validated against simply leaving the score alone. A calibration is
 * only marked `fitted` when its held-out error actually beats identity by
 * MIN_MAE_IMPROVEMENT — enough points and a plausible slope is not evidence
 * that applying the curve helps anyone. Callers must check `fitted`.
 */
function fitCalibrationFromPairs(pairs, { minSamples = MIN_SAMPLES_FOR_CALIBRATION } = {}) {
  if (pairs.length < minSamples) {
    return identityFit(pairs.length, {
      validation: { rejected_reason: `only ${pairs.length} labeled example(s), need ${minSamples}` },
    });
  }

  const linear = fitLinear(pairs);
  const isotonic = fitIsotonic(pairs);

  if (!linear) {
    return identityFit(pairs.length, {
      validation: { rejected_reason: 'no variance in the model score to fit against' },
    });
  }

  const linearCv = linear.rejected ? null : crossValidate(pairs, fitLinear);
  const isotonicCv = isotonic.rejected ? null : crossValidate(pairs, fitIsotonic);
  const candidates = {
    linear: linear.rejected
      ? { rejected: true, reason: 'slope outside sane bounds', slope: Number(linear.slope.toFixed(4)) }
      : { ...linearCv, slope: Number(linear.slope.toFixed(4)), intercept: Number(linear.intercept.toFixed(4)) },
    isotonic: isotonic.rejected
      ? { rejected: true, reason: `collapsed to ${isotonic.blocks} block(s), no monotone signal` }
      : { ...isotonicCv, blocks: isotonic.blocks },
  };
  // Surfaced for the same diagnostic reason it always was: a pathological
  // slope is worth seeing in the evidence blob, not just silently dropped.
  const rejectedSlope = linear.rejected ? Number(linear.slope.toFixed(4)) : undefined;

  const linearImprovement = linearCv ? linearCv.mae_improvement : -Infinity;
  const isotonicImprovement = isotonicCv ? isotonicCv.mae_improvement : -Infinity;
  const useIsotonic = isotonicImprovement > linearImprovement + ISOTONIC_PREFERENCE_MARGIN;
  const winner = useIsotonic ? isotonic : linear;
  const winnerCv = useIsotonic ? isotonicCv : linearCv;
  const improvement = useIsotonic ? isotonicImprovement : linearImprovement;

  if (!winnerCv || improvement < MIN_MAE_IMPROVEMENT) {
    return identityFit(pairs.length, {
      ...(rejectedSlope === undefined ? {} : { rejected_slope: rejectedSlope }),
      validation: {
        ...(winnerCv || {}),
        candidates,
        rejected_reason: winnerCv
          ? `cross-validated error improves by only ${improvement.toFixed(2)} point(s), need ${MIN_MAE_IMPROVEMENT}`
          : 'neither candidate model could be fitted',
      },
    });
  }

  return {
    // slope/intercept stay on every calibration so consumers that only know
    // about the linear form keep working; they are identity for an isotonic
    // fit, whose real parameters are the knots.
    slope: winner.model === 'linear' ? winner.slope : 1,
    intercept: winner.model === 'linear' ? winner.intercept : 0,
    model: winner.model,
    ...(winner.model === 'isotonic' ? { knots: winner.knots } : {}),
    sample_size: pairs.length,
    fitted: true,
    validation: { ...winnerCv, candidates },
  };
}

function applyCalibration(score, calibration) {
  if (!calibration || !calibration.fitted || !Number.isFinite(score)) return score;
  return Math.max(0, Math.min(100, Math.round(predict(calibration, score))));
}

// ---------------------------------------------------------------------------
// Corpus loading and population fits
// ---------------------------------------------------------------------------

async function getReviewedRows({ PronunciationSessionResult }, where) {
  return PronunciationSessionResult.findAll({
    where: {
      teacher_reviewed_score: { [Op.ne]: null },
      ...where,
    },
    attributes: [
      'adaptive_score',
      'overall_score',
      'recommendation_details',
      'teacher_reviewed_score',
    ],
    raw: true,
  });
}

function toPairs(rows, readScore) {
  return rows
    .map((row) => {
      const score = readScore(row);
      return score == null ? null : [score, row.teacher_reviewed_score];
    })
    .filter(Boolean);
}

/**
 * Fits a population-specific recalibration curve when enough teacher-reviewed
 * examples exist for that population (Student.disability, matched verbatim).
 *
 * Populations are kept separate rather than pooled because atypical
 * timing/articulation in some populations (e.g. ASD) isn't a scoring error to
 * average away — see the timing-observation note in
 * pronunciationAnalysisService.buildPhonemeBoundaryAlignment. The pooled
 * global curve is therefore only a fallback for a population with too little
 * data to say anything at all. A population that HAS enough data and whose fit
 * fails validation falls back to identity, not to the pooled curve: "we
 * checked, and calibrating this population does not help" is a finding, and
 * pooling it away would hide exactly the population difference this layer
 * exists to capture.
 *
 * Known limitation (document in any writeup): reviewed attempts are not a
 * random sample. The review queue deliberately surfaces low-confidence
 * attempts (uncertainty sampling), so a fit is estimated mostly from the
 * region where the model is least sure. Cross-validation inherits that bias —
 * it measures held-out error on the same skewed distribution — so passing
 * validation is necessary but not sufficient to activate this layer. A
 * random-audit review stream is the outstanding fix.
 *
 * Both candidate targets are fitted: adaptive_score (what this layer has
 * always calibrated) and overall_score (what the teacher is actually shown).
 * Which one this layer should adjust when activated is still open, so both are
 * reported as evidence and the decision is left to the data.
 */
async function computeCalibrationUncached(populationTag) {
  const tag = normalizePopulationTag(populationTag);
  // Lazy require: avoids a require-cycle with models/index.js at module load.
  const { PronunciationSessionResult, Student, sequelize } = require('../models');

  const buildResult = (rows, source) => {
    const primary = fitCalibrationFromPairs(toPairs(rows, getAdaptiveScore));
    const alternate = fitCalibrationFromPairs(toPairs(rows, getOverallScore));
    return {
      ...primary,
      population_tag: tag,
      source: primary.fitted ? source : 'identity',
      calibration_target: 'adaptive_score',
      // Evidence only — never applied. Reports what calibrating the score the
      // teacher actually sees would look like on the same corpus.
      alternate_target: { calibration_target: 'overall_score', ...alternate },
    };
  };

  if (populationTag) {
    // Matched on the same LOWER(TRIM(...)) normalization as the tag itself:
    // disability is free text, so "ASD", "asd" and " ASD " are one population
    // here exactly as they are in the review queue's coverage counts.
    const studentRows = await Student.findAll({
      where: sequelize.where(
        sequelize.fn('LOWER', sequelize.fn('TRIM', sequelize.col('disability'))),
        tag
      ),
      attributes: ['sid'],
      raw: true,
    });
    const studentIds = studentRows.map((row) => row.sid);

    if (studentIds.length) {
      const populationRows = await getReviewedRows(
        { PronunciationSessionResult },
        { student_id: { [Op.in]: studentIds } }
      );
      const populationPairs = toPairs(populationRows, getAdaptiveScore);

      if (populationPairs.length >= MIN_SAMPLES_FOR_CALIBRATION) {
        // Enough data to judge this population on its own terms — whatever the
        // verdict, it stands. No pooled fallback from here.
        return buildResult(populationRows, 'population');
      }
    }
  }

  const globalRows = await getReviewedRows({ PronunciationSessionResult }, {});
  return {
    ...buildResult(globalRows, 'global'),
    pooled: true,
    pooled_reason: `fewer than ${MIN_SAMPLES_FOR_CALIBRATION} reviewed example(s) for "${tag}"`,
  };
}

// A calibration lookup must never fail the scoring request it's attached to
// — same rule the GOP and DTW layers follow. Any DB/query error falls back
// to identity, exactly as if too few reviewed examples existed yet.
async function computeCalibration(populationTag) {
  const tag = normalizePopulationTag(populationTag);
  const cached = calibrationCache.get(tag);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.calibration;
  }

  let calibration;
  try {
    calibration = await computeCalibrationUncached(populationTag);
  } catch (error) {
    logger.warn(`Adaptive calibration lookup failed, using identity: ${error.message}`);
    calibration = { ...identityFit(0), population_tag: tag, source: 'identity' };
  }

  calibrationCache.set(tag, { calibration, computedAt: Date.now() });
  return calibration;
}

/**
 * Compact form for storing on a result row. A full calibration carries the
 * per-candidate validation breakdown and, for an isotonic fit, one knot per
 * block — that grows with the labeled corpus and would be copied into every
 * scored row's recommendation_details JSONB forever. The decision-relevant
 * fields are kept; the full fit is reproducible on demand from
 * scripts/layer3Report.js.
 */
function summarizeCalibration(calibration) {
  if (!calibration) return null;
  const { knots, validation, alternate_target: alternate, ...rest } = calibration;

  return {
    ...rest,
    ...(knots ? { knot_count: knots.length } : {}),
    ...(validation
      ? {
        validation: {
          folds: validation.folds,
          mae_identity: validation.mae_identity,
          mae_calibrated: validation.mae_calibrated,
          mae_improvement: validation.mae_improvement,
          ...(validation.rejected_reason ? { rejected_reason: validation.rejected_reason } : {}),
        },
      }
      : {}),
    ...(alternate
      ? {
        alternate_target: {
          calibration_target: alternate.calibration_target,
          fitted: alternate.fitted,
          model: alternate.model,
          sample_size: alternate.sample_size,
          mae_improvement: alternate.validation?.mae_improvement ?? null,
        },
      }
      : {}),
  };
}

/**
 * Drops cached fits so the next scoring request refits against a corpus that
 * now includes a just-submitted review. Without this a new label took up to
 * CACHE_TTL_MS to have any effect, which made the calibration confusing to
 * verify by hand: review an attempt, score another, see no change.
 *
 * A pooled global fit is built from every population, so any new review can
 * change it — clearing the whole cache is both correct and cheap here (one
 * entry per distinct disability string).
 */
function invalidateCalibrationCache() {
  calibrationCache.clear();
}

module.exports = {
  MIN_SAMPLES_FOR_CALIBRATION,
  MIN_MAE_IMPROVEMENT,
  normalizePopulationTag,
  getAdaptiveScore,
  getOverallScore,
  fitCalibrationFromPairs,
  fitLinear,
  fitIsotonic,
  predict,
  crossValidate,
  applyCalibration,
  computeCalibration,
  summarizeCalibration,
  invalidateCalibrationCache,
};
