'use strict';

const { Op } = require('sequelize');
const { normalizePopulationTag } = require('./adaptiveCalibrationService');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RECENT_WINDOW = 300;
const LOW_CONFIDENCE_THRESHOLD = 55;
const LOW_COVERAGE_THRESHOLD = 8; // mirrors MIN_SAMPLES_FOR_CALIBRATION

// Reviewed rows only grow over time (never purged, they're the layer-3
// calibration corpus), so this full-table GROUP BY gets slower on every
// queue load as the corpus grows. Same 10-min-cache convention as
// adaptiveCalibrationService, which fits on the same table for the same
// reason.
const CACHE_TTL_MS = 10 * 60 * 1000;
let reviewedCountsCache = null; // { counts, computedAt }

function getConfidenceScore(result) {
  const score = result?.recommendation_details?.adaptive_model?.confidence_score;
  return Number.isFinite(score) ? score : null;
}

/**
 * Pure scoring function, split out for unit testing: blends uncertainty
 * sampling (70%) with coverage sampling (30%). Both inputs are 0-100 scale
 * before weighting.
 */
function computeInformativeness({ confidenceScore, reviewedForPopulation }) {
  const uncertaintyComponent = confidenceScore == null ? 50 : 100 - confidenceScore;
  const coverageComponent = 100 / (1 + Math.max(0, reviewedForPopulation));
  return Math.round(uncertaintyComponent * 0.7 + coverageComponent * 0.3);
}

async function getReviewedCountsByPopulation() {
  if (reviewedCountsCache && Date.now() - reviewedCountsCache.computedAt < CACHE_TTL_MS) {
    return reviewedCountsCache.counts;
  }

  // Lazy require: avoids a require-cycle with models/index.js at module load,
  // same as adaptiveCalibrationService.
  const { PronunciationSessionResult, Student, sequelize } = require('../models');
  // Counted in SQL rather than loading every reviewed row into Node; grouping
  // on the same LOWER(TRIM(...)) normalization normalizePopulationTag applies
  // so "ASD" and " asd " land in one bucket here and in the calibration fit.
  const normalizedDisability = sequelize.fn(
    'LOWER',
    sequelize.fn('TRIM', sequelize.fn('COALESCE', sequelize.col('student.disability'), ''))
  );
  const rows = await PronunciationSessionResult.findAll({
    where: { teacher_reviewed_score: { [Op.ne]: null } },
    attributes: [
      [normalizedDisability, 'population'],
      [sequelize.fn('COUNT', sequelize.col('PronunciationSessionResult.id')), 'reviewed_count'],
    ],
    include: [{ model: Student, as: 'student', attributes: [] }],
    group: [normalizedDisability],
    raw: true,
  });

  const counts = new Map();
  for (const row of rows) {
    counts.set(normalizePopulationTag(row.population), Number(row.reviewed_count));
  }
  reviewedCountsCache = { counts, computedAt: Date.now() };
  return counts;
}

/**
 * Ranks not-yet-reviewed attempts by how much labeling them would help the
 * layer-3 calibration model, rather than just listing everything flagged
 * needs_teacher_review in recency order:
 *
 *  - uncertainty sampling: the model's own confidence_score (lower = the
 *    model itself is least sure, so a teacher label there resolves the most
 *    ambiguity).
 *  - coverage sampling: a priority boost for populations with few reviewed
 *    examples so far (Student.disability, via adaptiveCalibrationService's
 *    normalization) — this is what lets a newly arriving population, e.g.
 *    autistic students' recordings, catch the calibration up quickly
 *    instead of being drowned out by a larger existing population.
 */
async function getReviewQueue(teacherId, { limit = DEFAULT_LIMIT } = {}) {
  const { PronunciationSessionResult, Student } = require('../models');
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT));

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [candidates, reviewedCounts] = await Promise.all([
    PronunciationSessionResult.findAll({
      where: {
        teacher_id: teacherId,
        teacher_reviewed_score: null,
        created_at: { [Op.gte]: startOfToday },
      },
      // Blob column excluded: 300 candidate rows each carrying up to 8MB of
      // stored audio would otherwise stream through the DB on every queue load.
      attributes: { exclude: ['raw_audio_data'] },
      include: [{ model: Student, as: 'student', attributes: ['full_name', 'disability'] }],
      order: [['created_at', 'DESC']],
      limit: RECENT_WINDOW,
    }),
    getReviewedCountsByPopulation(),
  ]);

  return candidates
    .map((row) => row.get({ plain: true }))
    .map((row) => {
      const confidenceScore = getConfidenceScore(row);
      const populationTag = normalizePopulationTag(row.student?.disability);
      const reviewedForPopulation = reviewedCounts.get(populationTag) || 0;

      const informativenessScore = computeInformativeness({ confidenceScore, reviewedForPopulation });

      const reasons = [];
      if (confidenceScore != null && confidenceScore < LOW_CONFIDENCE_THRESHOLD) {
        reasons.push(`model confidence is low (${confidenceScore}%)`);
      }
      if (reviewedForPopulation < LOW_COVERAGE_THRESHOLD) {
        reasons.push(`only ${reviewedForPopulation} reviewed example(s) so far for "${populationTag}"`);
      }
      if (row.needs_teacher_review) {
        reasons.push('already flagged for review');
      }

      return {
        ...row,
        population_tag: populationTag,
        confidence_score: confidenceScore,
        informativeness_score: informativenessScore,
        informativeness_reasons: reasons,
        // raw_audio_data itself is excluded from the query (see above);
        // raw_audio_size stands in for presence, same convention teacherService
        // uses for the results-history endpoint.
        has_raw_audio: Boolean(row.raw_audio_size),
      };
    })
    .sort((a, b) => b.informativeness_score - a.informativeness_score)
    .slice(0, safeLimit);
}

module.exports = { getReviewQueue, computeInformativeness };
