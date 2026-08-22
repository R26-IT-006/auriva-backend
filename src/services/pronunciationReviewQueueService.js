'use strict';

const { Op } = require('sequelize');
const { normalizePopulationTag } = require('./adaptiveCalibrationService');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const RECENT_WINDOW = 300;
const LOW_CONFIDENCE_THRESHOLD = 55;
const LOW_COVERAGE_THRESHOLD = 8; // mirrors MIN_SAMPLES_FOR_CALIBRATION

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
  // Lazy require: avoids a require-cycle with models/index.js at module load,
  // same as adaptiveCalibrationService.
  const { PronunciationSessionResult, Student } = require('../models');
  const rows = await PronunciationSessionResult.findAll({
    where: { teacher_reviewed_score: { [Op.ne]: null } },
    attributes: ['id'],
    include: [{ model: Student, as: 'student', attributes: ['disability'] }],
    raw: true,
  });

  const counts = new Map();
  for (const row of rows) {
    const tag = normalizePopulationTag(row['student.disability']);
    counts.set(tag, (counts.get(tag) || 0) + 1);
  }
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

  const [candidates, reviewedCounts] = await Promise.all([
    PronunciationSessionResult.findAll({
      where: { teacher_id: teacherId, teacher_reviewed_score: null },
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

      delete row.raw_audio_data;
      return {
        ...row,
        population_tag: populationTag,
        confidence_score: confidenceScore,
        informativeness_score: informativenessScore,
        informativeness_reasons: reasons,
      };
    })
    .sort((a, b) => b.informativeness_score - a.informativeness_score)
    .slice(0, safeLimit);
}

module.exports = { getReviewQueue, computeInformativeness };
