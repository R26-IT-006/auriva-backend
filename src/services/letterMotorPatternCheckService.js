'use strict';

/**
 * letterMotorPatternCheckService.js
 *
 * Writing Check — the dedicated, teacher-initiated route for the frozen
 * letter_motor_cluster_v1 model.
 *
 * ── Why this route exists ──────────────────────────────────────────────────
 * The model was fitted on 7 participants x 20 reference letters captured under
 * the COLLECTION protocol, where attempt 3 renders a faded ghost guide
 * (guideOpacity 0.26 — handwritingSupportLevels.js's collection-low override).
 * Normal practice renders NO guide at attempt 3, so the child writes from
 * memory. Live data: mean DTW 14.58 under collection vs 29.48 under normal
 * practice — roughly double, within the same students. Those are different
 * tasks, and the reference-range guard was correctly refusing to score the
 * second one.
 *
 * A Writing Check re-runs the training protocol exactly, so the model receives
 * the distribution it was fitted on. NOTHING about the model changes: same
 * frozen scaler, same cluster centres, same feature order, same guard, same
 * Pattern A/B mapping.
 *
 * ── Hard isolation guarantees ──────────────────────────────────────────────
 * This module never writes LetterProgress, never touches mastered_at or
 * blocked_attempts, never calls a threshold/Motor-Score/adaptive service, and
 * never influences sequencing or word unlock. Its evidence rows are ordinary
 * LetterAttempt rows with collection_mode = true, which every normal-learning
 * query in this codebase already excludes (see
 * tests/writingCheckIsolation.test.js for the enumerated proof).
 *
 * ── What it never does ─────────────────────────────────────────────────────
 *   - never evaluates fewer than the exact 20 required pairs;
 *   - never substitutes a letter;
 *   - never borrows a capture from another collection session or another check;
 *   - never fabricates a pattern when the guard rejects the observation;
 *   - never fabricates a result when the ML service is unreachable.
 */

const { Op } = require('sequelize');
const {
  LetterAttempt, LetterMotorPatternCheck, LetterMotorStateHistory, LetterMotorStateEvaluation,
} = require('../models');
const { LETTER_MOTOR_REFERENCE_LETTERS, lookupKey } = require('../config/letterMotorReferenceLetters');
const { predictLetterMotorState } = require('./mlServiceClient');
const logger = require('../utils/logger');

// The check-status vocabulary lives HERE, not destructured off the model at
// module load: this service is imported by handwritingController, and many
// controller test suites mock ../src/models with only the handful of models
// they need. Reading a property off a possibly-absent model at import time
// would break every one of those suites before a single test ran.
//
//   in_progress       — capture under way
//   completed         — all 20 required pairs captured, not yet evaluated
//   evaluated         — the model produced a result (assigned OR
//                       outside_reference_range; both are real outcomes)
//   evaluation_failed — ML service unreachable. Retryable; nothing persisted.
const STATUS = Object.freeze({
  IN_PROGRESS:       'in_progress',
  COMPLETED:         'completed',
  EVALUATED:         'evaluated',
  EVALUATION_FAILED: 'evaluation_failed',
});

// The milestone-column sentinel for a Writing Check row. Legacy 14/17/20 rows
// keep their own codes and their own (partial) uniqueness; this value plus a
// non-null pattern_check_id is what distinguishes the dedicated route in the
// two shared result tables.
const WRITING_CHECK_MILESTONE = 'WRITING_CHECK';

// Exactly the 20 pairs the model was trained on — read from the single
// authoritative list, never restated here.
const REQUIRED_PAIRS = LETTER_MOTOR_REFERENCE_LETTERS.map(p => ({ ...p }));
const REQUIRED_COUNT = REQUIRED_PAIRS.length; // 20

function isPositiveInteger(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function average(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Is this attempt row usable as Writing Check evidence?
 *
 * Deliberately NOT validateEvidenceEligibility() — that rule governs the
 * NORMAL-PRACTICE mastery-evidence path and requires collection_mode === false
 * and support_level === 'low'. A Writing Check reproduces the TRAINING
 * condition instead, which is the exact inverse on collection_mode and which
 * carried no support_level at all (all 140 training rows have it NULL).
 * Neither rule is changed; they simply describe different capture regimes.
 */
function isUsableCheckCapture(row) {
  if (!row) return false;
  if (row.attempt_number !== 3) return false;
  if (row.collection_mode !== true) return false;
  if (row.capture_status !== 'complete') return false;
  const nf = row.normalized_features ?? {};
  return isFiniteNumber(nf.smoothness_score)
    && isFiniteNumber(nf.dtw_distance) && nf.dtw_distance >= 0
    && isFiniteNumber(nf.speed_cv) && nf.speed_cv >= 0;
}

/**
 * Every usable attempt-3 capture belonging to ONE check, keyed by pair.
 * Scoped to the check's own collection_session_id, so a capture from another
 * session — or another Writing Check — can never be counted.
 */
async function loadCaptures(check) {
  const rows = await LetterAttempt.findAll({
    where: {
      student_id: check.student_id,
      collection_session_id: check.collection_session_id,
      attempt_number: 3,
      collection_mode: true,
    },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });

  // A repeated capture of the same pair within one check keeps the NEWEST —
  // the child re-did that letter. Never two rows for one pair in the mean.
  const byPair = new Map();
  for (const row of rows) {
    if (!isUsableCheckCapture(row)) continue;
    byPair.set(lookupKey(row.letter, row.case_type), row);
  }
  return byPair;
}

/** Required pairs still missing a usable capture, in protocol order. */
function missingPairs(byPair) {
  return REQUIRED_PAIRS.filter(p => !byPair.has(lookupKey(p.letter, p.caseType)));
}

/**
 * Starts a Writing Check, or returns the student's existing unfinished one.
 *
 * Resume is the default: a check that stopped at 8/20 is returned as-is so the
 * child continues at the next incomplete pair. A NEW check is created only when
 * no unfinished check exists, so a new check can never accidentally resume a
 * completed one.
 */
async function startOrResumePatternCheck({ studentId, collectionSessionId }) {
  if (!isPositiveInteger(studentId) || !collectionSessionId) {
    return { status: 'invalid_input', check: null };
  }
  try {
    const existing = await LetterMotorPatternCheck.findOne({
      where: { student_id: studentId, status: STATUS.IN_PROGRESS },
      order: [['started_at', 'DESC'], ['id', 'DESC']],
    });
    if (existing) {
      const byPair = await loadCaptures(existing);
      return { status: 'resumed', check: existing, remaining: missingPairs(byPair) };
    }

    const check = await LetterMotorPatternCheck.create({
      student_id: studentId,
      collection_session_id: collectionSessionId,
      status: STATUS.IN_PROGRESS,
      started_at: new Date(),
      letters_captured: 0,
    });
    return { status: 'started', check, remaining: REQUIRED_PAIRS.map(p => ({ ...p })) };
  } catch (err) {
    logger.error('Writing Check start/resume failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', check: null };
  }
}

/**
 * Live progress for one check — which pairs remain, in protocol order.
 * Recomputed from letter_attempts every time; letters_captured on the row is
 * only a cached convenience and is refreshed here.
 */
async function getPatternCheckProgress({ checkId }) {
  if (!isPositiveInteger(checkId)) return { status: 'invalid_input', check: null };
  try {
    const check = await LetterMotorPatternCheck.findByPk(checkId);
    if (!check) return { status: 'not_found', check: null };

    const byPair = await loadCaptures(check);
    const remaining = missingPairs(byPair);
    const captured = REQUIRED_COUNT - remaining.length;

    if (check.letters_captured !== captured) {
      await check.update({ letters_captured: captured, updated_at: new Date() });
    }
    return {
      status: 'found', check,
      capturedCount: captured, requiredCount: REQUIRED_COUNT,
      remaining, complete: remaining.length === 0,
    };
  } catch (err) {
    logger.error('Writing Check progress read failed', { checkId, errorMessage: err.message });
    return { status: 'read_failed', check: null };
  }
}

/**
 * Completes and evaluates a Writing Check.
 *
 * Evaluation runs ONLY with all 20 required pairs captured. An incomplete check
 * returns an honest `incomplete` status and the model is never called — 19/20 is
 * not evaluated, and a missing pair is never filled from history.
 *
 * Idempotent: an already-evaluated check returns its stored result without
 * re-calling the model.
 *
 * @returns {Promise<{status: string, ...}>} statuses: invalid_input, not_found,
 *   already_evaluated, incomplete, ml_service_unavailable, assigned,
 *   outside_reference_range, save_failed, read_failed
 */
async function completeAndEvaluatePatternCheck({ checkId }) {
  if (!isPositiveInteger(checkId)) return { status: 'invalid_input' };

  let check;
  try {
    check = await LetterMotorPatternCheck.findByPk(checkId);
  } catch (err) {
    logger.error('Writing Check read failed', { checkId, errorMessage: err.message });
    return { status: 'read_failed' };
  }
  if (!check) return { status: 'not_found' };

  // Idempotency — never re-score a check that already has a result.
  if (check.status === STATUS.EVALUATED) {
    const evaluation = await LetterMotorStateEvaluation.findOne({
      where: { pattern_check_id: check.id },
    }).catch(() => null);
    return { status: 'already_evaluated', check, evaluation };
  }

  const byPair = await loadCaptures(check);
  const missing = missingPairs(byPair);
  if (missing.length > 0) {
    await check.update({
      letters_captured: REQUIRED_COUNT - missing.length, updated_at: new Date(),
    }).catch(() => {});
    return {
      status: 'incomplete', check,
      capturedCount: REQUIRED_COUNT - missing.length, requiredCount: REQUIRED_COUNT,
      missing,
    };
  }

  // ── The exact aggregate the frozen model expects ────────────────────────
  // Arithmetic mean over exactly the 20 required pairs' attempt-3 captures,
  // in the model's own feature order. No motor_score, best_score, threshold,
  // accuracy or support_level is read — the model requires none of them.
  const rows = REQUIRED_PAIRS.map(p => byPair.get(lookupKey(p.letter, p.caseType)));
  const smoothnessScore = average(rows.map(r => r.normalized_features.smoothness_score));
  const dtwDistance     = average(rows.map(r => r.normalized_features.dtw_distance));
  const speedCv         = average(rows.map(r => r.normalized_features.speed_cv));

  // Provenance trio, taken from the captures themselves.
  const first = rows[0];
  const featureVersion       = first.feature_version ?? 'v1';
  const templateVersion      = first.template_version ?? 'v1';
  const normalizationVersion = first.normalization_version ?? 'dtw_norm_v1';

  // The check's own completion instant — a real recorded event, not Date.now()
  // standing in for one: the newest capture in this check IS when the child
  // finished writing.
  const observedAt = rows
    .map(r => (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)))
    .reduce((a, b) => (b > a ? b : a));

  let prediction;
  try {
    prediction = await predictLetterMotorState({ smoothnessScore, dtwDistance, speedCv });
  } catch (mlErr) {
    logger.error('Writing Check: ML service call failed', { checkId, errorMessage: mlErr.message });
    // Nothing persisted as a result — the check stays retryable.
    await check.update({ status: STATUS.EVALUATION_FAILED, updated_at: new Date() }).catch(() => {});
    return { status: 'ml_service_unavailable', check };
  }

  const outside = prediction.status === 'outside_reference_range';
  const ood = prediction.ood ?? null;

  try {
    const evaluation = await LetterMotorStateEvaluation.create({
      student_id: check.student_id,
      pattern_check_id: check.id,
      milestone: WRITING_CHECK_MILESTONE,
      coverage_n: REQUIRED_COUNT,
      evidence_row_count: rows.length,
      observed_at: observedAt,
      evaluation_status: outside ? 'outside_reference_range' : 'assigned',
      inside_reference_range: !outside,
      smoothness_score: smoothnessScore,
      dtw_distance: dtwDistance,
      speed_cv: speedCv,
      ood_reason: ood?.reason ?? null,
      ood_triggered_by: ood?.triggered_by ?? null,
      ood_outside_features: ood?.outside_features ?? null,
      ood_detail: ood,
      model_version: prediction.model_version,
      feature_version: featureVersion,
      template_version: templateVersion,
      normalization_version: normalizationVersion,
    });

    // A pattern row is written ONLY when the guard admitted the observation.
    // On rejection there is no cluster, no state code, no row — nothing is
    // fabricated.
    let history = null;
    if (!outside) {
      history = await LetterMotorStateHistory.create({
        student_id: check.student_id,
        pattern_check_id: check.id,
        milestone: WRITING_CHECK_MILESTONE,
        coverage_n: REQUIRED_COUNT,
        completed_category: { source: 'writing_check' },
        observed_at: observedAt,
        smoothness_score: smoothnessScore,
        dtw_distance: dtwDistance,
        speed_cv: speedCv,
        cluster_id: prediction.cluster_id,
        state_code: prediction.state_code,
        display_name: prediction.display_name,
        nearest_distance: prediction.nearest_distance,
        second_nearest_distance: prediction.second_nearest_distance,
        separation_margin: prediction.separation_margin,
        model_version: prediction.model_version,
        feature_version: featureVersion,
        template_version: templateVersion,
        normalization_version: normalizationVersion,
      });
    }

    await check.update({
      status: STATUS.EVALUATED,
      completed_at: observedAt,
      letters_captured: REQUIRED_COUNT,
      model_version: prediction.model_version,
      updated_at: new Date(),
    });

    logger.info('Writing Check evaluated', {
      checkId, studentId: check.student_id,
      outcome: outside ? 'outside_reference_range' : prediction.state_code,
      modelVersion: prediction.model_version,
    });

    return {
      status: outside ? 'outside_reference_range' : 'assigned',
      check, evaluation, history,
      aggregate: { smoothnessScore, dtwDistance, speedCv },
      ood,
    };
  } catch (err) {
    logger.error('Writing Check result save failed', { checkId, errorMessage: err.message });
    return { status: 'save_failed', check };
  }
}

/**
 * Teacher-facing Writing Check history, newest first. Pure read — never calls
 * the ML service.
 *
 * Each entry carries only what a teacher surface needs: when, and what the
 * model concluded. Cluster ids are deliberately not surfaced.
 */
async function getPatternCheckHistory({ studentId }) {
  if (!isPositiveInteger(studentId)) return { status: 'invalid_input', checks: [] };
  try {
    const checks = await LetterMotorPatternCheck.findAll({
      where: { student_id: studentId },
      order: [['started_at', 'DESC'], ['id', 'DESC']],
      raw: true,
    });
    if (checks.length === 0) return { status: 'found', checks: [] };

    const ids = checks.map(c => c.id);
    const [evaluations, histories] = await Promise.all([
      LetterMotorStateEvaluation.findAll({ where: { pattern_check_id: { [Op.in]: ids } }, raw: true }),
      LetterMotorStateHistory.findAll({ where: { pattern_check_id: { [Op.in]: ids } }, raw: true }),
    ]);
    const evalByCheck = new Map(evaluations.map(e => [e.pattern_check_id, e]));
    const histByCheck = new Map(histories.map(h => [h.pattern_check_id, h]));

    return {
      status: 'found',
      checks: checks.map(c => {
        const ev = evalByCheck.get(c.id) ?? null;
        const hi = histByCheck.get(c.id) ?? null;
        return {
          id: c.id,
          status: c.status,
          started_at: c.started_at,
          completed_at: c.completed_at,
          letters_captured: c.letters_captured,
          required_count: REQUIRED_COUNT,
          evaluation_status: ev ? ev.evaluation_status : null,
          state_code: hi ? hi.state_code : null,
          observed_at: ev ? ev.observed_at : null,
          model_version: c.model_version,
          ood_reason: ev ? ev.ood_reason : null,
        };
      }),
    };
  } catch (err) {
    logger.error('Writing Check history read failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', checks: [] };
  }
}

module.exports = {
  STATUS,
  WRITING_CHECK_MILESTONE,
  REQUIRED_PAIRS,
  REQUIRED_COUNT,
  isUsableCheckCapture,
  startOrResumePatternCheck,
  getPatternCheckProgress,
  completeAndEvaluatePatternCheck,
  getPatternCheckHistory,
};
