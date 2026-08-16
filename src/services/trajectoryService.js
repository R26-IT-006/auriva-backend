'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const { DialogueWord, DialogueWordProgress, DialogueWordAttempt, DialoguePhase3Attempt, ActionWordAttempt } = require('../models');
const logger = require('../utils/logger');
const { computeTier1Trajectory } = require('./tier1Scorer');

/**
 * Assembles the 13-feature payload for the trajectory prediction from the DB.
 * Covers both greetings/magic_words (dialogueService.js's own words) and
 * abilities (category3Service.js's words) — the two services store Phase 1/2
 * data in different tables, so this function branches on word.category to
 * read from the correct one. See DECISIONS.md R-32 for why abilities has no
 * Phase 1 exposure-ratio concept at all (phase1_applicable=false, -1.0
 * sentinel, not a missing value).
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

  const isAbilities = word.category === 'abilities';

  // Phase 1: exposure ratio snapshot from DialogueWordProgress.
  // Written exactly once when Phase 1 gate first passes (write-once guard, TASK-25 A1);
  // live counters (phase1_exposure_count / phase1_required_exposures) are reset by
  // recordPhase3Result() after every session and must NOT be used here.
  // Pre-migration rows stay NULL (R-24). Abilities has no Phase 1 exposure concept
  // at all — category3Service.js's own Phase 1 equivalent (recordDragToLine) never
  // writes this field, so requiring it here would make every abilities feature
  // assembly fail permanently. Use the same -1.0 sentinel the offline training
  // data already uses for abilities rows (R-32) instead of querying for a value
  // that structurally cannot exist.
  let phase1_exposure_ratio;
  if (isAbilities) {
    phase1_exposure_ratio = -1.0;
  } else {
    const progress = await DialogueWordProgress.findOne({
      where: { student_id: studentId, word_id: wordId },
      attributes: ['phase1_exposure_ratio_snapshot'],
    });
    if (!progress || progress.phase1_exposure_ratio_snapshot == null) return null;
    phase1_exposure_ratio = progress.phase1_exposure_ratio_snapshot;
  }

  // Phase 2: most recent session-1 attempt. Abilities records this in
  // ActionWordAttempt (category3Service.js's assessPhase2Speech/
  // recordPhase2NonVerbal), a separate table with phase2_-prefixed column
  // names — NOT dialogue_word_attempts, which only greetings/magic_words use.
  let speech_score, phoneme_accuracy, phoneme_error_class_raw,
    response_latency_ms_phase2, echolalia_flag, match_type;

  if (isAbilities) {
    const phase2Row = await ActionWordAttempt.findOne({
      where: { student_id: studentId, word_id: wordId, phase2_speech_score: { [Op.ne]: null } },
      attributes: [
        'phase2_speech_score',
        'phase2_phoneme_accuracy',
        'phase2_phoneme_error_class',
        'phase2_response_latency_ms',
        'phase2_echolalia_flag',
        'phase2_match_type',
      ],
      order: [['attempted_at', 'DESC']],
    });
    if (!phase2Row) return null;
    ({
      phase2_speech_score: speech_score,
      phase2_phoneme_accuracy: phoneme_accuracy,
      phase2_phoneme_error_class: phoneme_error_class_raw,
      phase2_response_latency_ms: response_latency_ms_phase2,
      phase2_echolalia_flag: echolalia_flag,
      phase2_match_type: match_type,
    } = phase2Row.get({ plain: true }));
  } else {
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
    ({
      speech_score,
      phoneme_accuracy,
      phoneme_error_class: phoneme_error_class_raw,
      response_latency_ms: response_latency_ms_phase2,
      echolalia_flag,
      match_type,
    } = phase2Row.get({ plain: true }));
  }

  // Substitute 'none' when phoneme_error_class is null — this happens when the
  // phoneme scorer finds no error (correct pronunciation). The synthetic training
  // data encodes the same case as 'none', so this keeps the feature in-distribution.
  const phoneme_error_class = phoneme_error_class_raw ?? 'none';

  // Non-verbal attempts (match_type='non_verbal', recordNonVerbalResult/
  // recordPhase2NonVerbal) never populate the verbal-only phoneme/latency
  // fields — that's expected, not a data gap. Tier 1 renormalizes around
  // whichever terms are present (see tier1Scorer.js); Tier 2 is skipped for
  // these entirely (getTrajectoryPrediction). Applies identically regardless
  // of which table Phase 2 data came from.
  const isNonVerbal = match_type === 'non_verbal';

  if (
    speech_score == null ||
    echolalia_flag == null ||
    (!isNonVerbal && (phoneme_accuracy == null || response_latency_ms_phase2 == null))
  )
    return null;

  // Phase 3: most recent session-1 attempt WHERE scenario_label IS NOT NULL.
  // Shared table for both categories — category3Service.js's recordPhase3Check
  // already writes scenario_label 'A'/'B' rows here too (no branch needed).
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
    // false for abilities (R-32: structurally N/A, not missing), true otherwise.
    phase1_applicable: !isAbilities,
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
