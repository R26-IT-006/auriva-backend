'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const { DialogueWord, DialogueWordProgress, DialogueWordAttempt, DialoguePhase3Attempt } = require('../models');
const logger = require('../utils/logger');
const { computeTier1Trajectory } = require('./tier1Scorer');

/**
 * Assembles the 13-feature payload for the trajectory prediction from the DB.
 * Only ever called for greetings/magic_words words — this service has no path
 * to an abilities word — so phase1_applicable is always true (hardcoded, R-32).
 *
 * Returns null if any required value is missing/null; the caller then falls
 * through to 'typical' (= today's unmodified difficulty-ladder behavior, R-39).
 */
async function buildSession1Features(studentId, wordId) {
  // Statics: difficulty, category from DialogueWord
  const word = await DialogueWord.findByPk(wordId, {
    attributes: ['difficulty', 'category'],
  });
  if (!word || word.difficulty == null || word.category == null) return null;

  // Phase 1: exposure ratio snapshot from DialogueWordProgress.
  // Written exactly once when Phase 1 gate first passes (write-once guard, TASK-25 A1);
  // live counters (phase1_exposure_count / phase1_required_exposures) are reset by
  // recordPhase3Result() after every session and must NOT be used here.
  // Pre-migration rows stay NULL (R-24); abilities rows carry -1.0 sentinel (R-32).
  const progress = await DialogueWordProgress.findOne({
    where: { student_id: studentId, word_id: wordId },
    attributes: ['phase1_exposure_ratio_snapshot'],
  });
  if (!progress || progress.phase1_exposure_ratio_snapshot == null) return null;
  const phase1_exposure_ratio = progress.phase1_exposure_ratio_snapshot;

  // Phase 2: most recent session-1 attempt from dialogue_word_attempts
  const phase2Row = await DialogueWordAttempt.findOne({
    where: { student_id: studentId, word_id: wordId, phase: 2 },
    attributes: [
      'speech_score',
      'phoneme_accuracy',
      'phoneme_error_class',
      'response_latency_ms',
      'echolalia_flag',
      'match_type',
    ],
    order: [['attempted_at', 'DESC']],
  });
  if (!phase2Row) return null;

  const {
    speech_score,
    phoneme_accuracy,
    phoneme_error_class: phoneme_error_class_raw,
    response_latency_ms: response_latency_ms_phase2,
    echolalia_flag,
    match_type,
  } = phase2Row.get({ plain: true });

  // Substitute 'none' when phoneme_error_class is null — this happens when the
  // phoneme scorer finds no error (correct pronunciation). The synthetic training
  // data encodes the same case as 'none', so this keeps the feature in-distribution.
  const phoneme_error_class = phoneme_error_class_raw ?? 'none';

  // Non-verbal attempts (match_type='non_verbal', recordNonVerbalResult) never
  // populate the verbal-only phoneme/latency fields — that's expected, not a
  // data gap. Tier 1 renormalizes around whichever terms are present (see
  // tier1Scorer.js); Tier 2 is skipped for these entirely (getTrajectoryPrediction).
  const isNonVerbal = match_type === 'non_verbal';

  if (
    speech_score == null ||
    echolalia_flag == null ||
    (!isNonVerbal && (phoneme_accuracy == null || response_latency_ms_phase2 == null))
  )
    return null;

  // Phase 3: most recent session-1 attempt WHERE scenario_label IS NOT NULL.
  // prompt_count lives in dialogue_phase3_attempts, not dialogue_word_attempts.
  const phase3Row = await DialoguePhase3Attempt.findOne({
    where: {
      student_id: studentId,
      word_id: wordId,
      scenario_label: { [Op.ne]: null },
    },
    attributes: ['response_latency_ms', 'first_tap_correct', 'selection_change_count', 'prompt_count'],
    order: [['attempted_at', 'DESC']],
  });
  if (!phase3Row) return null;

  const {
    response_latency_ms: response_latency_ms_phase3,
    first_tap_correct,
    selection_change_count,
    prompt_count,
  } = phase3Row.get({ plain: true });

  if (
    response_latency_ms_phase3 == null ||
    first_tap_correct == null ||
    selection_change_count == null ||
    prompt_count == null
  )
    return null;

  return {
    // Phase 2
    speech_score,
    phoneme_accuracy,
    phoneme_error_class,
    response_latency_ms_phase2,
    echolalia_flag,
    prompt_count,
    match_type,
    // Phase 3
    response_latency_ms_phase3,
    first_tap_correct,
    selection_change_count,
    // Phase 1
    phase1_exposure_ratio,
    // Statics
    difficulty: word.difficulty,
    category: word.category,
    // Hardcoded — this function only runs for greetings/magic_words (R-32/R-36)
    phase1_applicable: true,
  };
}

/**
 * Predicts the learning trajectory for a student/word pair.
 * Returns 'fast', 'typical', or 'struggling'.
 *
 * Architecture: kill switch → feature assembly → Tier 2 (microservice, HTTP) →
 * confidence gate → Tier 1 (literature-grounded formula, TASK-41). Non-verbal
 * attempts skip Tier 2 entirely — the ML model has never been trained on a
 * non-verbal row (no such rows exist in the synthetic training set), so a
 * prediction from it would be extrapolating outside its training distribution.
 * They go straight to Tier 1, which is a deterministic formula, not a model,
 * and needs no training data.
 */
async function getTrajectoryPrediction(studentId, wordId) {
  // Kill switch — returns 'typical' (= today's unmodified difficulty-ladder behavior, per R-39)
  if (process.env.TRAJECTORY_ML_ENABLED !== 'true') return 'typical';

  // Assemble 13-feature payload from the DB (Phase 2, Phase 3, Phase 1 ratio, statics)
  // Field names must match tier1Scorer.js's expectations exactly
  const features = await buildSession1Features(studentId, wordId);
  // Assembly failure → today's unmodified difficulty-ladder behavior (R-39)
  if (!features) return 'typical';

  const isNonVerbal = features.match_type === 'non_verbal';
  // match_type is control-flow metadata for Tier 1, not a trained feature —
  // strip it before sending to Tier 2 so its payload stays byte-identical to
  // what the model was actually trained on.
  const { match_type: _matchType, ...tier2Features } = features;

  // Tier 2: call the microservice (skipped for non-verbal — see doc comment above)
  let tier2Result = null;
  if (!isNonVerbal) {
    try {
      const resp = await axios.post(
        `${process.env.MICROSERVICE_URL}/predict-trajectory`,
        tier2Features,
        { timeout: 2000 }
      );
      if (resp.status === 200 && resp.data.trajectory && resp.data.confidence != null) {
        tier2Result = resp.data;
      }
    } catch (err) {
      logger.warn('[trajectoryService] microservice call failed:', err.message);
    }
  }

  // Confidence gate
  const minConf = parseFloat(process.env.TRAJECTORY_MIN_CONFIDENCE ?? '0.5');
  if (tier2Result && tier2Result.confidence >= minConf) {
    return tier2Result.trajectory;
  }

  // Tier 1 fallback — literature-grounded formula (TASK-41)
  // Returns 'fast'/'typical'/'struggling' from the same feature payload; no network call
  // 'typical' from Tier 1 also means today's unmodified difficulty-ladder behavior (R-39)
  return computeTier1Trajectory(features);
}

module.exports = { getTrajectoryPrediction };
