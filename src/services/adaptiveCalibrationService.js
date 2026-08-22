'use strict';

const { Op } = require('sequelize');
const logger = require('../utils/logger');

// Below this many labeled examples a fitted line is noise, not signal — stay
// at identity rather than let a handful of teacher corrections skew scores.
const MIN_SAMPLES_FOR_CALIBRATION = 8;

// Sanity bounds on the fitted slope. With few, noisy points OLS can produce a
// negative or wildly steep slope that would invert or explode scores; such a
// fit is treated as not fitted rather than applied. A real teacher-vs-model
// recalibration should always be a mild monotone adjustment.
const MIN_CALIBRATION_SLOPE = 0.25;
const MAX_CALIBRATION_SLOPE = 4;

// Teacher reviews trickle in slowly compared to scoring requests; recomputing
// per-request would hammer the DB for no benefit, so a fit is reused for a
// while before it's refreshed from the latest reviewed rows.
const CACHE_TTL_MS = 10 * 60 * 1000;

const calibrationCache = new Map();

function normalizePopulationTag(disability) {
  const trimmed = String(disability || '').trim().toLowerCase();
  return trimmed || 'unspecified';
}

function getAdaptiveScore(result) {
  const score = result?.recommendation_details?.adaptive_model?.adaptive_score;
  return Number.isFinite(score) ? score : null;
}

/**
 * Ordinary least squares fit of teacher_reviewed_score on adaptive_score.
 * Falls back to identity (slope 1, intercept 0, fitted: false) whenever
 * there isn't enough variance or enough points to trust a fitted line —
 * callers must check `fitted` before treating a calibration as real.
 */
function fitCalibrationFromPairs(pairs, { minSamples = MIN_SAMPLES_FOR_CALIBRATION } = {}) {
  if (pairs.length < minSamples) {
    return { slope: 1, intercept: 0, sample_size: pairs.length, fitted: false };
  }

  const n = pairs.length;
  const meanX = pairs.reduce((total, [x]) => total + x, 0) / n;
  const meanY = pairs.reduce((total, [, y]) => total + y, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  for (const [x, y] of pairs) {
    covariance += (x - meanX) * (y - meanY);
    varianceX += (x - meanX) ** 2;
  }

  if (varianceX < 1e-6) {
    return { slope: 1, intercept: 0, sample_size: n, fitted: false };
  }

  const slope = covariance / varianceX;
  const intercept = meanY - slope * meanX;

  if (slope < MIN_CALIBRATION_SLOPE || slope > MAX_CALIBRATION_SLOPE) {
    return {
      slope: 1,
      intercept: 0,
      sample_size: n,
      fitted: false,
      rejected_slope: Number(slope.toFixed(4)),
    };
  }

  return { slope, intercept, sample_size: n, fitted: true };
}

function applyCalibration(score, calibration) {
  if (!calibration || !calibration.fitted || !Number.isFinite(score)) return score;
  const adjusted = calibration.slope * score + calibration.intercept;
  return Math.max(0, Math.min(100, Math.round(adjusted)));
}

async function getReviewedPairs({ PronunciationSessionResult }, where) {
  const rows = await PronunciationSessionResult.findAll({
    where: {
      teacher_reviewed_score: { [Op.ne]: null },
      ...where,
    },
    attributes: ['recommendation_details', 'teacher_reviewed_score'],
    raw: true,
  });

  return rows
    .map((row) => {
      const adaptiveScore = getAdaptiveScore(row);
      return adaptiveScore == null ? null : [adaptiveScore, row.teacher_reviewed_score];
    })
    .filter(Boolean);
}

/**
 * Fits a population-specific recalibration curve when enough teacher-reviewed
 * examples exist for that population (Student.disability, matched verbatim);
 * falls back to a global curve across every population, then to identity.
 * Kept as separate populations rather than one pooled model because atypical
 * timing/articulation in some populations (e.g. ASD) isn't a scoring error to
 * average away — see the timing-observation note in
 * pronunciationAnalysisService.buildPhonemeBoundaryAlignment.
 *
 * Known limitation (document in any writeup): reviewed attempts are not a
 * random sample. The review queue deliberately surfaces low-confidence
 * attempts (uncertainty sampling), so this OLS fit is estimated mostly from
 * the region where the model is least sure and extrapolated elsewhere. This
 * is one reason the calibration stays evidence-only until validated on more
 * labeled data.
 */
async function computeCalibrationUncached(populationTag) {
  const tag = normalizePopulationTag(populationTag);
  // Lazy require: avoids a require-cycle with models/index.js at module load.
  const { PronunciationSessionResult, Student, sequelize } = require('../models');

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
      const populationPairs = await getReviewedPairs(
        { PronunciationSessionResult },
        { student_id: { [Op.in]: studentIds } }
      );
      const populationFit = fitCalibrationFromPairs(populationPairs);
      if (populationFit.fitted) {
        return { ...populationFit, population_tag: tag, source: 'population' };
      }
    }
  }

  const globalPairs = await getReviewedPairs({ PronunciationSessionResult }, {});
  const globalFit = fitCalibrationFromPairs(globalPairs);
  return {
    ...globalFit,
    population_tag: tag,
    source: globalFit.fitted ? 'global' : 'identity',
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
    calibration = { slope: 1, intercept: 0, sample_size: 0, fitted: false, population_tag: tag, source: 'identity' };
  }

  calibrationCache.set(tag, { calibration, computedAt: Date.now() });
  return calibration;
}

module.exports = {
  MIN_SAMPLES_FOR_CALIBRATION,
  normalizePopulationTag,
  getAdaptiveScore,
  fitCalibrationFromPairs,
  applyCalibration,
  computeCalibration,
};
