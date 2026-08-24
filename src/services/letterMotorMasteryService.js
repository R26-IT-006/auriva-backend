'use strict';

/**
 * letterMotorMasteryService.js
 *
 * Feature 11B Phase 5 — consumes motor evidence naturally produced while a
 * child learns and masters letters, instead of a separate 20-letter
 * reassessment workflow (Phase 4's rejected design — see this feature's
 * final report for the disposition of that infrastructure).
 *
 * Two entry points:
 *   onLetterMastered()        — called from handwritingController's
 *                                recordLetterCompletion() success path,
 *                                the FIRST time a letter is mastered
 *                                (LetterProgress row newly created). Freezes
 *                                one evidence row (if the letter is a
 *                                Feature 11B reference letter and eligible),
 *                                then checks/triggers milestones.
 *   getLatestLetterMotorState() / getLetterMotorStateHistory() — pure
 *                                reads, NEVER call the ML service (spec
 *                                §24 Teacher-report requirement).
 *
 * Non-fatal by design throughout: every failure mode returns a status
 * string rather than throwing, so a Feature 11B bug can never turn a
 * successful letter-completion response into a server error, and can never
 * retroactively change mastery/threshold/adaptive decisions already made
 * (spec §21 — Features 1-10 isolation. Fixing the mastered-letter resume
 * bug is a SEPARATE, normal-progression change — see
 * letterProgressionService.js — not part of this file).
 */

const { LetterAttempt, LetterMotorMasteryEvidence, LetterMotorStateHistory } = require('../models');
const { isReferenceLetter } = require('../config/letterMotorReferenceLetters');
const { MILESTONES } = require('../config/letterMotorMilestones');
const { predictLetterMotorState } = require('./mlServiceClient');
const logger = require('../utils/logger');

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function average(values) {
  const finite = values.filter(v => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

function lookupKey(letter, caseType) {
  return `${letter}|${caseType}`;
}

function result(status, data = {}) {
  return { status, ...data };
}

// ─── Eligibility (spec §9) ──────────────────────────────────────────────────
//
// An evidence observation requires ALL of:
//   attempt_number = 3, support_level = 'low', collection_mode = false,
//   source_type IS NULL, capture_status = 'complete',
//   smoothness_score finite, dtw_distance finite >= 0, speed_cv finite >= 0,
//   feature_version/template_version/normalization_version non-null.
// motor_score/best_score/threshold/passed are NEVER read here — Feature
// 11B inputs are exactly [smoothness_score, dtw_distance, speed_cv] from
// normalized_features, nothing else (spec §9 explicit exclusion list).
function validateEvidenceEligibility(row) {
  if (!row) return { valid: false, reason: 'row_not_found' };
  if (row.attempt_number !== 3) return { valid: false, reason: 'not_attempt_3' };
  if (row.support_level !== 'low') return { valid: false, reason: 'support_level_not_low' };
  if (row.collection_mode !== false) return { valid: false, reason: 'collection_mode_true' };
  if (row.source_type != null) return { valid: false, reason: 'source_type_not_null' };
  if (row.capture_status !== 'complete') return { valid: false, reason: 'capture_status_not_complete' };

  const nf = row.normalized_features ?? {};
  if (!isFiniteNumber(nf.smoothness_score)) return { valid: false, reason: 'smoothness_score_not_finite' };
  if (!isFiniteNumber(nf.dtw_distance) || nf.dtw_distance < 0) return { valid: false, reason: 'dtw_distance_invalid' };
  if (!isFiniteNumber(nf.speed_cv) || nf.speed_cv < 0) return { valid: false, reason: 'speed_cv_invalid' };

  if (row.feature_version == null) return { valid: false, reason: 'feature_version_null' };
  if (row.template_version == null) return { valid: false, reason: 'template_version_null' };
  if (row.normalization_version == null) return { valid: false, reason: 'normalization_version_null' };

  return { valid: true, reason: null };
}

// ─── Evidence freeze (spec §8/§9/§10/§11) ──────────────────────────────────

/**
 * Called ONLY from the first (LetterProgress-creating) mastery of a
 * letter. Freezes one immutable evidence row from the attempt_number=3 row
 * of the passing session, if and only if the letter is a Feature 11B
 * reference letter and that row is eligible. Idempotent — a letter that
 * already has an evidence row is never touched again (spec §11
 * immutability), regardless of how many more times it's "mastered" (it
 * shouldn't be, once the resume/skip fix lands, but this stays safe even
 * if it somehow is).
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.letter
 * @param {string} params.caseType
 * @param {string} params.sessionKey — the LetterAttempt.session_key of the
 *   mastering session (from recordLetterCompletion's own sessionKey).
 * @returns {Promise<{status: string, evidence: Object|null, milestoneResults: Object[]|null}>}
 *
 * Possible statuses: not_reference_letter, evidence_already_exists,
 * attempt_row_not_found, not_eligible, evidence_created, save_failed
 */
async function onLetterMastered({ studentId, letter, caseType, sessionKey }) {
  if (!isPositiveInteger(studentId) || typeof letter !== 'string' || !sessionKey) {
    return result('invalid_input', { evidence: null, milestoneResults: null });
  }

  if (!isReferenceLetter(letter, caseType)) {
    return result('not_reference_letter', { evidence: null, milestoneResults: null });
  }

  try {
    // Idempotency check up front — avoids an unnecessary LetterAttempt
    // lookup on the (expected to be rare after the resume/skip fix, but
    // still possible) re-mastery path.
    const existing = await LetterMotorMasteryEvidence.findOne({
      where: { student_id: studentId, letter, case_type: caseType },
    });
    if (existing) {
      const milestoneResults = await checkAndTriggerMilestones({ studentId });
      return result('evidence_already_exists', { evidence: existing, milestoneResults });
    }

    const row = await LetterAttempt.findOne({
      where: { student_id: studentId, letter, case_type: caseType, session_key: sessionKey, attempt_number: 3 },
    });
    if (!row) {
      logger.warn('Mastery evidence: attempt-3 row not found for mastering session', { studentId, letter, caseType, sessionKey });
      return result('attempt_row_not_found', { evidence: null, milestoneResults: null });
    }

    const eligibility = validateEvidenceEligibility(row);
    if (!eligibility.valid) {
      // Not fabricated, not substituted — this reference letter simply
      // never gets Feature 11B evidence from this mastery event. Since
      // mastery only ever happens once (LetterProgress.findOrCreate), and
      // the resume/skip fix means this letter will never be re-presented,
      // this is a known, reported limitation (see final report §15/§16),
      // not silently retried later.
      logger.warn('Mastery evidence: mastering attempt-3 row not eligible', {
        studentId, letter, caseType, sessionKey, reason: eligibility.reason,
      });
      return result('not_eligible', { evidence: null, milestoneResults: null, reason: eligibility.reason });
    }

    let evidence;
    try {
      evidence = await LetterMotorMasteryEvidence.create({
        student_id: studentId,
        letter, case_type: caseType,
        letter_attempt_id: row.id,
        mastered_at: new Date(),
        smoothness_score: row.normalized_features.smoothness_score,
        dtw_distance:     row.normalized_features.dtw_distance,
        speed_cv:         row.normalized_features.speed_cv,
        support_level:    row.support_level,
        feature_version:       row.feature_version,
        template_version:      row.template_version,
        normalization_version: row.normalization_version,
      });
    } catch (createErr) {
      if (createErr.name === 'SequelizeUniqueConstraintError') {
        const raceExisting = await LetterMotorMasteryEvidence.findOne({
          where: { student_id: studentId, letter, case_type: caseType },
        });
        if (raceExisting) {
          const milestoneResults = await checkAndTriggerMilestones({ studentId });
          return result('evidence_already_exists', { evidence: raceExisting, milestoneResults });
        }
      }
      throw createErr;
    }

    logger.info('Letter motor mastery evidence frozen', { studentId, letter, caseType, evidenceId: evidence.id });

    const milestoneResults = await checkAndTriggerMilestones({ studentId });
    return result('evidence_created', { evidence, milestoneResults });

  } catch (err) {
    logger.error('Mastery evidence freeze failed unexpectedly', { studentId, letter, caseType, errorMessage: err.message });
    return result('save_failed', { evidence: null, milestoneResults: null });
  }
}

// ─── Milestone check + trigger (spec §12-§19) ──────────────────────────────

/**
 * Checks all 3 pilot milestones (14/17/20) for a student and, for any not
 * yet recorded whose exact required evidence set is now fully present,
 * aggregates + calls the frozen ML model + persists a state-history row.
 * Idempotent — an already-recorded (student, milestone, model_version) is
 * never re-predicted (spec §19). Milestones are checked independently and
 * in ascending order so a student who reaches evidence coverage
 * out-of-order (e.g. via the category-picker "testing convenience" path —
 * see final report §Uppercase-issues) still gets every eligible milestone
 * recorded, not just the highest one.
 *
 * Never throws — a failure for one milestone is logged and the loop
 * continues to the next; the caller (onLetterMastered, always wrapped
 * non-fatally by recordLetterCompletion) never sees this reject.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<Object[]>} one entry per milestone:
 *   { milestone, status, result? } — status one of: already_recorded,
 *   not_yet_eligible, version_mismatch, ml_service_unavailable, recorded,
 *   save_failed
 */
async function checkAndTriggerMilestones({ studentId }) {
  const results = [];
  let evidenceRows;
  try {
    evidenceRows = await LetterMotorMasteryEvidence.findAll({ where: { student_id: studentId } });
  } catch (err) {
    logger.error('Milestone check: evidence read failed', { studentId, errorMessage: err.message });
    return MILESTONES.map(m => ({ milestone: m.code, status: 'save_failed' }));
  }
  const evidenceByKey = new Map(evidenceRows.map(r => [lookupKey(r.letter, r.case_type), r]));

  for (const milestone of MILESTONES) {
    try {
      const already = await LetterMotorStateHistory.findOne({
        where: { student_id: studentId, milestone: milestone.code },
      });
      if (already) {
        results.push({ milestone: milestone.code, status: 'already_recorded', result: already });
        continue;
      }

      const missing = milestone.requiredPairs.filter(p => !evidenceByKey.has(lookupKey(p.letter, p.caseType)));
      if (missing.length > 0) {
        results.push({ milestone: milestone.code, status: 'not_yet_eligible', missingCount: missing.length });
        continue;
      }

      const rows = milestone.requiredPairs.map(p => evidenceByKey.get(lookupKey(p.letter, p.caseType)));

      // Version consistency — strict, Phase 4's rule unchanged (spec §16:
      // do NOT silently relax this; report the longitudinal risk instead —
      // see this feature's final report).
      const versionKey = row => `${row.feature_version}|${row.template_version}|${row.normalization_version}`;
      const distinctVersionKeys = new Set(rows.map(versionKey));
      if (distinctVersionKeys.size > 1) {
        logger.warn('Milestone check: version mismatch across evidence rows', {
          studentId, milestone: milestone.code, distinctVersionCount: distinctVersionKeys.size,
        });
        results.push({ milestone: milestone.code, status: 'version_mismatch' });
        continue;
      }
      const { feature_version, template_version, normalization_version } = rows[0];

      const smoothnessScore = average(rows.map(r => r.smoothness_score));
      const dtwDistance     = average(rows.map(r => r.dtw_distance));
      const speedCv         = average(rows.map(r => r.speed_cv));

      let prediction;
      try {
        prediction = await predictLetterMotorState({ smoothnessScore, dtwDistance, speedCv });
      } catch (mlErr) {
        logger.error('Milestone check: ML service call failed', {
          studentId, milestone: milestone.code, errorMessage: mlErr.message,
        });
        results.push({ milestone: milestone.code, status: 'ml_service_unavailable' });
        continue;
      }

      // Reference-range guard (ML-service side). When the aggregated vector
      // falls outside the range the reference data represents, the model
      // returns no pattern — so there is nothing to persist. Deliberately
      // NOT written as a history row: cluster_id/state_code/display_name are
      // NOT NULL by design (see the model/migration), and relaxing that
      // would need a migration this change does not make. Nothing is
      // fabricated and no existing row is touched; the milestone simply
      // stays unrecorded and is re-evaluated on the next mastery event
      // (evidence rows are immutable, so the outcome is deterministic).
      if (prediction.status === 'outside_reference_range') {
        logger.info('Milestone check: observation outside reference range — no pattern recorded', {
          studentId, milestone: milestone.code, modelVersion: prediction.model_version,
          reason: prediction.ood?.reason ?? null, status: 'outside_reference_range',
        });
        results.push({ milestone: milestone.code, status: 'outside_reference_range', ood: prediction.ood ?? null });
        continue;
      }

      let created;
      try {
        created = await LetterMotorStateHistory.create({
          student_id: studentId,
          milestone: milestone.code,
          coverage_n: milestone.coverageN,
          completed_category: milestone.completedCategory,
          observed_at: new Date(),

          smoothness_score: smoothnessScore,
          dtw_distance:     dtwDistance,
          speed_cv:         speedCv,

          cluster_id:   prediction.cluster_id,
          state_code:   prediction.state_code,
          display_name: prediction.display_name,

          nearest_distance:        prediction.nearest_distance,
          second_nearest_distance: prediction.second_nearest_distance,
          separation_margin:       prediction.separation_margin,

          model_version: prediction.model_version,

          feature_version, template_version, normalization_version,
        });
      } catch (createErr) {
        if (createErr.name === 'SequelizeUniqueConstraintError') {
          const raceExisting = await LetterMotorStateHistory.findOne({
            where: { student_id: studentId, milestone: milestone.code, model_version: prediction.model_version },
          });
          if (raceExisting) {
            results.push({ milestone: milestone.code, status: 'already_recorded', result: raceExisting });
            continue;
          }
        }
        logger.error('Milestone check: state-history save failed', {
          studentId, milestone: milestone.code, errorMessage: createErr.message,
        });
        results.push({ milestone: milestone.code, status: 'save_failed' });
        continue;
      }

      logger.info('Letter motor state history recorded', {
        studentId, milestone: milestone.code, stateCode: created.state_code, modelVersion: created.model_version,
      });
      results.push({ milestone: milestone.code, status: 'recorded', result: created });

    } catch (err) {
      logger.error('Milestone check failed unexpectedly', { studentId, milestone: milestone.code, errorMessage: err.message });
      results.push({ milestone: milestone.code, status: 'save_failed' });
    }
  }

  return results;
}

// ─── Read-only endpoints (never trigger ML prediction) ─────────────────────

/**
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, result: Object|null}>}
 * Possible statuses: found, not_found, invalid_input, read_failed
 */
async function getLatestLetterMotorState({ studentId }) {
  if (!isPositiveInteger(studentId)) return result('invalid_input', { result: null });
  try {
    const latest = await LetterMotorStateHistory.findOne({
      where: { student_id: studentId },
      order: [['observed_at', 'DESC'], ['id', 'DESC']],
    });
    return latest ? result('found', { result: latest }) : result('not_found', { result: null });
  } catch (err) {
    logger.error('Latest letter motor state read failed', { studentId, errorMessage: err.message });
    return result('read_failed', { result: null });
  }
}

/**
 * Chronological (oldest -> newest) state-history for a student.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, results: Object[]}>}
 */
async function getLetterMotorStateHistory({ studentId }) {
  if (!isPositiveInteger(studentId)) return result('invalid_input', { results: [] });
  try {
    const results = await LetterMotorStateHistory.findAll({
      where: { student_id: studentId },
      order: [['observed_at', 'ASC'], ['id', 'ASC']],
    });
    return result('found', { results });
  } catch (err) {
    logger.error('Letter motor state history read failed', { studentId, errorMessage: err.message });
    return result('read_failed', { results: [] });
  }
}

/**
 * Descriptive-only cumulative trend aggregate for a student's current
 * evidence (spec §12) — mean smoothness/dtw/speed_cv over whatever
 * reference-letter evidence exists so far, plus the raw coverage count.
 * NEVER calls the ML service, NEVER implies a cluster/state (spec §12:
 * "3/20, 7/20, 10/20 must NOT produce State A/B").
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, coverageN: number, meanSmoothness: number|null, meanDtw: number|null, meanSpeedCv: number|null}>}
 */
async function getMasteryEvidenceTrend({ studentId }) {
  if (!isPositiveInteger(studentId)) {
    return result('invalid_input', { coverageN: 0, meanSmoothness: null, meanDtw: null, meanSpeedCv: null });
  }
  try {
    const rows = await LetterMotorMasteryEvidence.findAll({ where: { student_id: studentId } });
    return result('found', {
      coverageN: rows.length,
      meanSmoothness: average(rows.map(r => r.smoothness_score)),
      meanDtw:        average(rows.map(r => r.dtw_distance)),
      meanSpeedCv:    average(rows.map(r => r.speed_cv)),
    });
  } catch (err) {
    logger.error('Mastery evidence trend read failed', { studentId, errorMessage: err.message });
    return result('read_failed', { coverageN: 0, meanSmoothness: null, meanDtw: null, meanSpeedCv: null });
  }
}

module.exports = {
  validateEvidenceEligibility,
  onLetterMastered,
  checkAndTriggerMilestones,
  getLatestLetterMotorState,
  getLetterMotorStateHistory,
  getMasteryEvidenceTrend,
};
