'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const { DialogueWord, DialogueWordProgress, DialogueWordAttempt, DialoguePhase3Attempt, ActionWordAttempt } = require('../models');
const logger = require('../utils/logger');
const { computeTier1Trajectory, explainTier1 } = require('./tier1Scorer');

// TASK-43 — categories the trajectory work covers. Days of the Week is
// permanently out of scope (HARD RULE 4) and must never reach a report.
const IN_SCOPE_CATEGORIES = ['greetings', 'magic_words', 'abilities'];

// SHAP is materially slower than prediction, so the explanation call gets its
// own, longer budget. It is deliberately separate from the 2 s prediction
// timeout: the prediction must stay fast because gameplay waits on it, whereas
// the explanation is only ever read by a teacher on a report screen.
const EXPLAIN_TIMEOUT_MS = 8000;

/**
 * Per-row notes on the epistemic status of an explanation. Named constants so
 * the reason a row looks the way it does is stated in one place. The DEC-07
 * Tier 2 reliability caveat is NOT here — that is display copy and lives as a
 * named constant on the screen that renders it.
 */
const EXPLANATION_NOTES = {
  DISABLED:
    'Trajectory prediction is switched off. "typical" is the system default here, not a prediction about this child.',
  NO_FEATURES:
    'Not enough recorded session data for this word yet, so no trajectory was predicted. "typical" is the system default here, not a prediction about this child.',
  TIER1_NON_VERBAL:
    'Explained by the Tier 1 formula: this was a non-verbal (image-selection) attempt, which the Tier 2 model has never been trained on.',
  TIER1_MODEL_UNAVAILABLE:
    'Explained by the Tier 1 formula: the Tier 2 model could not be reached.',
  TIER1_LOW_CONFIDENCE:
    'Explained by the Tier 1 formula: the Tier 2 model was below the confidence threshold for this word.',
  TIER2_EXPLANATION_UNAVAILABLE:
    'The Tier 2 model produced this trajectory, but its explanation could not be generated. The trajectory itself is unaffected.',
};

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
  // Default 0.60 (2026-08-19): tuned against the uncalibrated raw-model probabilities
  // the current artifact produces. .env overrides this — it is the authoritative value.
  const minConf = parseFloat(process.env.TRAJECTORY_MIN_CONFIDENCE ?? '0.60');
  if (tier2Result && tier2Result.confidence >= minConf) {
    return tier2Result.trajectory;
  }

  // Tier 1 fallback — literature-grounded formula (TASK-41)
  // Returns 'fast'/'typical'/'struggling' from the same feature payload; no network call
  // 'typical' from Tier 1 also means today's unmodified difficulty-ladder behavior (R-39)
  return computeTier1Trajectory(features);
}

/**
 * TASK-43 — the same trajectory getTrajectoryPrediction() would return, plus
 * why. Read-and-explain only: this function reproduces that function's control
 * flow (kill switch → feature assembly → Tier 2 → confidence gate → Tier 1)
 * and adds an explanation on top. It never changes what is predicted.
 *
 * Returns { trajectory, tier, confidence, explanation, caveat } where tier is
 * 'tier1' | 'tier2' | 'disabled'.
 */
async function getTrajectoryExplanation(studentId, wordId) {
  // Kill switch — 'typical' here is today's unmodified difficulty-ladder
  // behavior (R-39), i.e. a constant, not a finding about this child.
  if (process.env.TRAJECTORY_ML_ENABLED !== 'true') {
    return {
      trajectory:  'typical',
      tier:        'disabled',
      confidence:  null,
      explanation: null,
      caveat:      EXPLANATION_NOTES.DISABLED,
    };
  }

  const features = await buildSession1Features(studentId, wordId);
  // Assembly failure → today's unmodified difficulty-ladder behavior (R-39)
  if (!features) {
    return {
      trajectory:  'typical',
      tier:        'disabled',
      confidence:  null,
      explanation: null,
      caveat:      EXPLANATION_NOTES.NO_FEATURES,
    };
  }

  const isNonVerbal = features.match_type === 'non_verbal';
  // Same strip as getTrajectoryPrediction — match_type is control-flow metadata
  // for Tier 1, not a trained feature.
  const { match_type: _matchType, ...tier2Features } = features;

  // Tier 2 prediction, on the same 2 s budget as getTrajectoryPrediction.
  // Prediction and explanation are separate calls on purpose: the trajectory
  // must be decided by the prediction alone, so that a failing explanation
  // cannot change it (AC8).
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

  const minConf = parseFloat(process.env.TRAJECTORY_MIN_CONFIDENCE ?? '0.60');

  if (tier2Result && tier2Result.confidence >= minConf) {
    // Trajectory and tier are decided at this point. Everything below is
    // additive — if the explanation call fails, the row degrades to
    // `explanation: null` and never to a different tier.
    let explanation = null;
    let caveat = null;
    try {
      const resp = await axios.post(
        `${process.env.MICROSERVICE_URL}/explain-trajectory`,
        tier2Features,
        { timeout: EXPLAIN_TIMEOUT_MS }
      );
      if (resp.status === 200 && Array.isArray(resp.data?.attributions)) {
        explanation = resp.data;
      } else {
        caveat = EXPLANATION_NOTES.TIER2_EXPLANATION_UNAVAILABLE;
      }
    } catch (err) {
      logger.warn('[trajectoryService] explanation call failed:', err.message);
      caveat = EXPLANATION_NOTES.TIER2_EXPLANATION_UNAVAILABLE;
    }

    return {
      trajectory: tier2Result.trajectory,
      tier:       'tier2',
      confidence: tier2Result.confidence,
      explanation,
      caveat,
    };
  }

  // Tier 1 fallback — the exact weighted-term decomposition, no network call.
  let tier1Caveat = EXPLANATION_NOTES.TIER1_MODEL_UNAVAILABLE;
  if (isNonVerbal) tier1Caveat = EXPLANATION_NOTES.TIER1_NON_VERBAL;
  else if (tier2Result) tier1Caveat = EXPLANATION_NOTES.TIER1_LOW_CONFIDENCE;

  return {
    trajectory:  computeTier1Trajectory(features),
    tier:        'tier1',
    confidence:  null,
    explanation: explainTier1(features),
    caveat:      tier1Caveat,
  };
}

/**
 * TASK-43 — one trajectory report per student, in a single call.
 *
 * The house report pattern (teacherApi.getConceptReport) fetches a whole report
 * per student in one request, and SHAP is slow enough that N per-word round
 * trips from the screen would be visibly bad — hence a batch endpoint.
 *
 * Covers every word in the three in-scope categories (HARD RULE 4 — Days of the
 * Week can never appear). Words with no recorded session data come back as
 * tier 'disabled' with a note saying so; they cost no microservice call.
 *
 * Partial failure is normal and degrades per row: one word failing to explain
 * returns that word with `explanation: null` and its caveat, and never fails
 * the report.
 */
async function getTrajectoryReport(studentId) {
  const words = await DialogueWord.findAll({
    where: { category: { [Op.in]: IN_SCOPE_CATEGORIES } },
    attributes: ['id', 'word', 'category', 'difficulty', 'teaching_order'],
    order: [
      ['category', 'ASC'],
      ['teaching_order', 'ASC'],
    ],
  });

  const rows = [];
  for (const w of words) {
    const word = w.get({ plain: true });
    let result;
    try {
      result = await getTrajectoryExplanation(studentId, word.id);
    } catch (err) {
      // A row that throws must not take the report down with it.
      logger.warn(
        `[trajectoryService] trajectory report row failed for word ${word.id}:`,
        err.message
      );
      result = {
        trajectory:  'typical',
        tier:        'disabled',
        confidence:  null,
        explanation: null,
        caveat:      EXPLANATION_NOTES.NO_FEATURES,
      };
    }
    rows.push({
      word_id:        word.id,
      word:           word.word,
      category:       word.category,
      difficulty:     word.difficulty,
      teaching_order: word.teaching_order,
      ...result,
    });
  }

  // Overview totals. Trajectory counts deliberately exclude 'disabled' rows —
  // their 'typical' is a system default, and counting it as a finding is
  // exactly the misreading this report exists to prevent.
  const predicted = rows.filter((r) => r.tier !== 'disabled');
  const totals = {
    words_total:      rows.length,
    words_predicted:  predicted.length,
    fast:             predicted.filter((r) => r.trajectory === 'fast').length,
    typical:          predicted.filter((r) => r.trajectory === 'typical').length,
    struggling:       predicted.filter((r) => r.trajectory === 'struggling').length,
    tier1:            rows.filter((r) => r.tier === 'tier1').length,
    tier2:            rows.filter((r) => r.tier === 'tier2').length,
    disabled:         rows.filter((r) => r.tier === 'disabled').length,
    explained:        rows.filter((r) => r.explanation != null).length,
  };

  return { totals, words: rows };
}

module.exports = { getTrajectoryPrediction, getTrajectoryExplanation, getTrajectoryReport };
