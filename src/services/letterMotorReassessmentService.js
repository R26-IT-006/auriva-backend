'use strict';

/**
 * letterMotorReassessmentService.js
 *
 * Feature 11B Phase 4 — the standardized Letter Motor Reassessment backend
 * logic: a narrow, non-side-effecting save path for raw observations, plus
 * an idempotent finalize step that aggregates exactly 20 valid observations
 * and calls auriva-ml-service's letter_motor_cluster_v1 model.
 *
 * ── What this service deliberately never touches ───────────────────────────
 * saveReassessmentAttempt() below does NOT call LetterProgress.findOrCreate/
 * .increment, does NOT read/write Student.personal_thresholds, does NOT call
 * runDynamicThresholdOrchestration / write ThresholdHistory, does NOT touch
 * persistent-difficulty evidence, worksheet recommendations, demo-speed
 * recommendation state, support recommendations, streaks, or word-writing
 * progression. This was the central finding of Phase 3/4's audit of
 * recordLetterCompletion() (handwritingController.js): that endpoint
 * triggers every one of those side effects unconditionally, even outside
 * collection_mode, so it could not be safely reused here — this service is
 * a deliberately separate, narrower write path onto the SAME LetterAttempt
 * table, distinguished at read time by source_type (see LetterAttempt.js).
 *
 * ── Relationship to collection_mode ──────────────────────────────────────
 * collection_mode is a separate, temporary, pre-deployment research concept
 * (see Phase 3's audit). Reassessment rows always have collection_mode:
 * false — a reassessment is normal (non-research) clinical/educational use,
 * just captured through a narrower path than ordinary practice. Isolation
 * from normal learning is achieved entirely through source_type, never
 * through collection_mode.
 *
 * ── Relationship to Features 1-10 ────────────────────────────────────────
 * Every normal-learning query that reads letter_attempts has been updated
 * (see the query-exclusion audit in this feature's final report) to filter
 * `source_type: null`, so reassessment rows are invisible to Features 1-10
 * regardless of what this service does. This service's own restraint above
 * is a second, independent layer of the same guarantee — belt and braces.
 */

const { LetterAttempt, LetterMotorReassessment } = require('../models');
const { normalizeLetterFeatures } = require('../utils/featureNormalization');
const { computeMotorScore } = require('../utils/motorScore');
const { predictLetterMotorState } = require('./mlServiceClient');
const {
  getRequiredLetterPairs, getRequiredLetterCount, isRequiredReassessmentLetter,
  getMissingLetterPairs, lookupKey,
} = require('../config/letterMotorReassessmentLetters');
const { isValidLetterSupportLevel } = require('../config/letterSupportLevels');
const logger = require('../utils/logger');

const SOURCE_TYPE_REASSESSMENT = 'letter_motor_reassessment';
// A reassessment observation is a single, non-cyclical capture — never a
// 1/2/3 adaptive-support sequence like normal practice. Fixed at 1 so this
// column's normal-practice meaning ("which try within the session") is
// never accidentally implied here; deliberately chosen NOT to collide with
// Feature 2's own attempt_number===3 recent-window selector
// (dynamicThresholdService.js), on top of (not instead of) the source_type
// exclusion every Feature 1-10 query now also applies.
const REASSESSMENT_ATTEMPT_NUMBER = 1;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Mirrors handwritingController.js's rowCaptureStatus() exactly — kept as a
// small, independent copy rather than an export from that controller file,
// since this service must not create a dependency on Features 1-10's own
// controller module. If that logic ever changes, mirror the change here too.
function rowCaptureStatus({ strokePoints, features }) {
  const hasStrokes  = Array.isArray(strokePoints) && strokePoints.length > 0;
  const hasFeatures = features != null && typeof features === 'object' && Object.keys(features).length > 0;
  return hasStrokes && hasFeatures ? 'complete' : 'incomplete';
}

function result(status, data = {}) {
  return { status, ...data };
}

function logEvent(level, message, fields) {
  logger[level](message, fields);
}

// ─── Save path (one raw observation per call) ──────────────────────────────

/**
 * Saves ONE raw Letter Motor Reassessment observation as a LetterAttempt
 * row with source_type = 'letter_motor_reassessment'. Narrow by design —
 * see this module's header comment for the full list of Features 1-10 side
 * effects this deliberately never triggers.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.letter        — single character
 * @param {string} params.caseType      — 'lowercase' | 'uppercase'
 * @param {string} params.reassessmentSessionId — UUID, generated once by the
 *   caller per reassessment session and reused across all ~20 attempt calls
 *   (stored as this row's session_key — the same reuse-not-reinvent decision
 *   documented in the letter_motor_reassessments migration).
 * @param {string} params.supportLevel  — MUST be exactly 'low'. Rejected
 *   otherwise (never trusted from the frontend alone — Phase 4 spec).
 * @param {Object} [params.features]    — same raw per-attempt features shape
 *   LetterWritingScreen/UppercaseWritingScreen already send to
 *   /handwriting/letter-complete (camelCase: completionTime, pauseCount,
 *   strokeCount, smoothness, dtw_distance, ...).
 * @param {Array}  [params.strokes]
 * @param {Object} [params.meta]        — device_type, app_version,
 *   feature_version, template_version, normalization_version, canvas_width,
 *   canvas_height (all optional, stored verbatim like saveLetterAttempts).
 * @returns {Promise<{status: string, attempt: Object|null, reason: string|null}>}
 *
 * Possible statuses: saved, invalid_input, invalid_support_level,
 * not_required_letter, save_failed
 */
async function saveReassessmentAttempt({
  studentId, letter, caseType, reassessmentSessionId, supportLevel, features, strokes, meta = {},
}) {
  if (!isPositiveInteger(studentId)) {
    return result('invalid_input', { attempt: null, reason: 'invalid_student_id' });
  }
  if (typeof letter !== 'string' || letter.length !== 1) {
    return result('invalid_input', { attempt: null, reason: 'invalid_letter' });
  }
  if (!['lowercase', 'uppercase'].includes(caseType)) {
    return result('invalid_input', { attempt: null, reason: 'invalid_case_type' });
  }
  if (!isValidUuid(reassessmentSessionId)) {
    return result('invalid_input', { attempt: null, reason: 'invalid_reassessment_session_id' });
  }

  // Server-side enforcement — never trust the frontend alone (Phase 4 spec).
  // 'high'/'medium'/null/anything else is rejected outright, not coerced.
  if (supportLevel !== 'low' || !isValidLetterSupportLevel(supportLevel)) {
    return result('invalid_support_level', { attempt: null, reason: 'support_level_must_be_low' });
  }

  // Reassessment is closed to exactly the 20 trained (letter, caseType)
  // pairs — see letterMotorReassessmentLetters.js. Any other letter is
  // rejected rather than silently accepted into a table finalize() will
  // never be able to use.
  if (!isRequiredReassessmentLetter(letter, caseType)) {
    return result('not_required_letter', { attempt: null, reason: 'letter_not_in_reassessment_set' });
  }

  try {
    const { normalized, validity } = normalizeLetterFeatures(features, { strokePoints: strokes });
    const { motor_score, quality_score, score_version } = computeMotorScore(normalized);

    const attempt = await LetterAttempt.create({
      student_id:      studentId,
      letter,
      case_type:       caseType,
      session_key:     reassessmentSessionId,
      attempt_number:  REASSESSMENT_ATTEMPT_NUMBER,
      // `passed` has no gating meaning for reassessment rows — a
      // reassessment never blocks/re-prompts on quality (Phase 3 design:
      // observation only, no adaptive interruption). Always true; nothing
      // in this service or its callers ever reads it as a real pass/fail
      // signal for reassessment rows.
      passed:          true,
      best_score:      null,
      threshold:       null,
      features:        features ?? null,
      stroke_points:   strokes  ?? null,
      support_level:   'low',
      demo_speed_level: null, // reassessment never shows an animated tracer/demo
      collection_mode: false, // separate concept from source_type — see header comment
      source_type:     SOURCE_TYPE_REASSESSMENT,

      collection_session_id: null,
      protocol_version:      null,
      task_order:             null,
      capture_status: rowCaptureStatus({ strokePoints: strokes, features }),

      canvas_width:  meta.canvas_width  ?? null,
      canvas_height: meta.canvas_height ?? null,
      device_type:      meta.device_type ?? null,
      app_version:      meta.app_version ?? null,
      feature_version:  meta.feature_version ?? null,
      template_version: meta.template_version ?? null,
      normalization_version: meta.normalization_version ?? null,

      normalized_features: normalized,
      feature_validity:    validity,
      motor_score,
      quality_score,
      score_version,

      collection_accepted: true,
      threshold_passed:    null, // no threshold gate exists for reassessment
      stroke_order_matches_template: normalized.stroke_order_meta?.strokeOrderMatchesTemplate ?? null,
    });

    logEvent('info', 'Letter motor reassessment attempt saved', {
      studentId, letter, caseType, reassessmentSessionId, attemptId: attempt.id, status: 'saved',
    });
    return result('saved', { attempt, reason: null });

  } catch (err) {
    logger.error('Letter motor reassessment attempt save failed', {
      studentId, letter, caseType, reassessmentSessionId, status: 'save_failed', errorMessage: err.message,
    });
    return result('save_failed', { attempt: null, reason: null });
  }
}

// ─── Finalize (selection, validation, aggregation, ML call, persistence) ──

/**
 * Picks one eligible row per required (letter, caseType) pair from a set of
 * raw rows that may contain retries. Selection rule (documented per Phase 4
 * spec §"selection rule if retries exist"): the MOST RECENT row for that
 * letter wins — ordered by created_at DESC, id DESC as a deterministic
 * tiebreaker for equal timestamps. Mirrors this codebase's existing
 * recency-preference convention (dynamicThresholdService.js's own recent-
 * window selection, StudentMotorBaseline's earliest-first convention is the
 * opposite direction deliberately: a reassessment retry means "the
 * student's most recent attempt is the one that should represent them",
 * not "the first one").
 *
 * @param {Array} rows — raw LetterAttempt rows (Sequelize instances)
 * @returns {Map<string, Object>} key -> selected row, key = "letter|caseType"
 */
function selectMostRecentPerLetter(rows) {
  const sorted = [...rows].sort((a, b) => {
    const byDate = new Date(b.created_at) - new Date(a.created_at);
    if (byDate !== 0) return byDate;
    return b.id - a.id;
  });
  const selected = new Map();
  for (const row of sorted) {
    const key = lookupKey(row.letter, row.case_type);
    if (!selected.has(key)) selected.set(key, row);
  }
  return selected;
}

function average(values) {
  const finite = values.filter(v => Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((sum, v) => sum + v, 0) / finite.length;
}

/**
 * Finalizes a standardized Letter Motor Reassessment session: selects one
 * eligible row per required letter, validates completeness/version
 * consistency/feature finiteness, aggregates via arithmetic mean (exactly
 * matching Colab training aggregation), calls auriva-ml-service, and
 * persists the result — idempotently.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.reassessmentSessionId — UUID (== the session_key
 *   shared by this session's raw LetterAttempt rows)
 * @returns {Promise<Object>} { status, result, ... } — see statuses below.
 *
 * Possible statuses:
 *   already_finalized  — idempotent replay; `result` is the existing row.
 *   finalized          — newly created; `result` is the new row.
 *   invalid_input
 *   incomplete         — fewer than 20 required letters have an eligible
 *                        observation yet; `missing` lists which ones.
 *   invalid_features   — a selected row's normalized_features.
 *                        {smoothness_score,dtw_distance,speed_cv} is missing
 *                        or non-finite; `invalidLetters` lists which ones.
 *   version_mismatch   — the 20 selected rows do not all share one
 *                        (feature_version, template_version,
 *                        normalization_version) triple; NEVER averaged
 *                        across mismatched versions.
 *   ml_service_unavailable
 *   save_failed
 */
async function finalizeReassessment({ studentId, reassessmentSessionId }) {
  if (!isPositiveInteger(studentId)) {
    return result('invalid_input', { result: null, reason: 'invalid_student_id' });
  }
  if (!isValidUuid(reassessmentSessionId)) {
    return result('invalid_input', { result: null, reason: 'invalid_reassessment_session_id' });
  }

  try {
    // 1. Idempotency — a second finalize call for a session already
    // finalized (under ANY model_version) returns the existing result
    // rather than re-predicting. This is a deliberately coarser check than
    // the DB's own (student_id, reassessment_session_id, model_version)
    // unique index — that index guards the true race condition (step 6
    // below); this check is the normal-path short-circuit for "the caller
    // already finalized this session and is calling again".
    const existing = await LetterMotorReassessment.findOne({
      where: { student_id: studentId, reassessment_session_id: reassessmentSessionId },
      order: [['completed_at', 'DESC'], ['id', 'DESC']],
    });
    if (existing) {
      logEvent('info', 'Letter motor reassessment finalize: idempotent replay', {
        studentId, reassessmentSessionId, resultId: existing.id, status: 'already_finalized',
      });
      return result('already_finalized', { result: existing });
    }

    // 2. Fetch every raw row for this exact session — reassessment rows
    // only, via source_type. collection_mode/capture_status/support_level
    // are re-verified below rather than assumed from the save path, since
    // this must never trust stale/pre-existing data it didn't itself write
    // in this call.
    const rawRows = await LetterAttempt.findAll({
      where: {
        student_id:  studentId,
        session_key: reassessmentSessionId,
        source_type: SOURCE_TYPE_REASSESSMENT,
      },
    });

    const eligibleRows = rawRows.filter(r =>
      r.collection_mode === false &&
      r.capture_status === 'complete' &&
      r.support_level === 'low'
    );

    // 3. Select one row per required letter (most-recent-wins on retries).
    const selectedByKey = selectMostRecentPerLetter(eligibleRows);

    // 4. Completeness — exactly 20/20 required, no partial/minimum-N
    // fallback (Phase 4 spec, explicit).
    const collectedKeys = new Set(selectedByKey.keys());
    const missing = getMissingLetterPairs(collectedKeys);
    if (missing.length > 0) {
      logEvent('info', 'Letter motor reassessment finalize: incomplete', {
        studentId, reassessmentSessionId, missingCount: missing.length,
        requiredCount: getRequiredLetterCount(), status: 'incomplete',
      });
      return result('incomplete', { result: null, missing });
    }

    const requiredPairs = getRequiredLetterPairs();
    const selectedRows = requiredPairs.map(({ letter, caseType }) => selectedByKey.get(lookupKey(letter, caseType)));

    // 5. Feature finiteness — every selected row must have a usable
    // (smoothness_score, dtw_distance, speed_cv) vector. Never silently
    // imputed/skipped — a single unusable row blocks the whole finalize.
    const invalidLetters = [];
    for (let i = 0; i < selectedRows.length; i++) {
      const row = selectedRows[i];
      const nf = row.normalized_features ?? {};
      if (!isFiniteNumber(nf.smoothness_score) || !isFiniteNumber(nf.dtw_distance) || !isFiniteNumber(nf.speed_cv)) {
        invalidLetters.push({ letter: requiredPairs[i].letter, caseType: requiredPairs[i].caseType });
      }
    }
    if (invalidLetters.length > 0) {
      logEvent('warn', 'Letter motor reassessment finalize: invalid features', {
        studentId, reassessmentSessionId, invalidCount: invalidLetters.length, status: 'invalid_features',
      });
      return result('invalid_features', { result: null, invalidLetters });
    }

    // 6. Version consistency — all 20 selected rows must share ONE
    // (feature_version, template_version, normalization_version) triple.
    // A null in any of the three, or any disagreement, is a mismatch —
    // never averaged across versions (Phase 4 spec, explicit).
    const versionKey = row => `${row.feature_version ?? 'NULL'}|${row.template_version ?? 'NULL'}|${row.normalization_version ?? 'NULL'}`;
    const distinctVersionKeys = new Set(selectedRows.map(versionKey));
    const firstRow = selectedRows[0];
    const hasNullVersionField = selectedRows.some(r =>
      r.feature_version == null || r.template_version == null || r.normalization_version == null
    );
    if (distinctVersionKeys.size > 1 || hasNullVersionField) {
      logEvent('warn', 'Letter motor reassessment finalize: version mismatch', {
        studentId, reassessmentSessionId, distinctVersionCount: distinctVersionKeys.size, status: 'version_mismatch',
      });
      return result('version_mismatch', { result: null });
    }
    const featureVersion       = firstRow.feature_version;
    const templateVersion      = firstRow.template_version;
    const normalizationVersion = firstRow.normalization_version;

    // 7. Aggregate — arithmetic mean, exactly matching Colab training
    // aggregation (Phase 4 spec, explicit).
    const smoothnessScore = average(selectedRows.map(r => r.normalized_features.smoothness_score));
    const dtwDistance     = average(selectedRows.map(r => r.normalized_features.dtw_distance));
    const speedCv         = average(selectedRows.map(r => r.normalized_features.speed_cv));

    // 8. Call the ML service. Never fabricate a result on failure.
    let prediction;
    try {
      prediction = await predictLetterMotorState({ smoothnessScore, dtwDistance, speedCv });
    } catch (mlErr) {
      logger.error('Letter motor reassessment finalize: ML service call failed', {
        studentId, reassessmentSessionId, status: 'ml_service_unavailable', errorMessage: mlErr.message,
      });
      return result('ml_service_unavailable', { result: null });
    }

    // 9. Persist — race-condition-safe create, mirroring
    // motorBaselineService.js's own established pattern: two concurrent
    // finalize calls could both pass the idempotency check above before
    // either inserts; the DB's UNIQUE(student_id, reassessment_session_id,
    // model_version) index is the real guard.
    let created;
    try {
      created = await LetterMotorReassessment.create({
        student_id:               studentId,
        reassessment_session_id:  reassessmentSessionId,
        completed_at:             new Date(),

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

        feature_version:       featureVersion,
        template_version:      templateVersion,
        normalization_version: normalizationVersion,
      });
    } catch (createErr) {
      if (createErr.name === 'SequelizeUniqueConstraintError') {
        const raceExisting = await LetterMotorReassessment.findOne({
          where: {
            student_id: studentId, reassessment_session_id: reassessmentSessionId,
            model_version: prediction.model_version,
          },
        });
        if (raceExisting) {
          logEvent('info', 'Letter motor reassessment finalize: race condition resolved to already_finalized', {
            studentId, reassessmentSessionId, resultId: raceExisting.id, status: 'already_finalized',
          });
          return result('already_finalized', { result: raceExisting });
        }
      }
      throw createErr; // falls through to the outer catch -> save_failed
    }

    logEvent('info', 'Letter motor reassessment finalized', {
      studentId, reassessmentSessionId, resultId: created.id,
      stateCode: created.state_code, modelVersion: created.model_version, status: 'finalized',
    });
    return result('finalized', { result: created });

  } catch (err) {
    logger.error('Letter motor reassessment finalize failed unexpectedly', {
      studentId, reassessmentSessionId, status: 'save_failed', errorMessage: err.message,
    });
    return result('save_failed', { result: null });
  }
}

// ─── Read-only endpoints (never trigger ML prediction) ─────────────────────

/**
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, result: Object|null}>}
 * Possible statuses: found, not_found, invalid_input, read_failed
 */
async function getLatestReassessment({ studentId }) {
  if (!isPositiveInteger(studentId)) {
    return result('invalid_input', { result: null });
  }
  try {
    const latest = await LetterMotorReassessment.findOne({
      where: { student_id: studentId },
      order: [['completed_at', 'DESC'], ['id', 'DESC']],
    });
    return latest ? result('found', { result: latest }) : result('not_found', { result: null });
  } catch (err) {
    logger.error('Letter motor reassessment latest read failed', { studentId, status: 'read_failed', errorMessage: err.message });
    return result('read_failed', { result: null });
  }
}

/**
 * Chronological (oldest -> newest) history of every finalized reassessment
 * for a student.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, results: Object[]}>}
 * Possible statuses: found, invalid_input, read_failed
 */
async function getReassessmentHistory({ studentId }) {
  if (!isPositiveInteger(studentId)) {
    return result('invalid_input', { results: [] });
  }
  try {
    const results = await LetterMotorReassessment.findAll({
      where: { student_id: studentId },
      order: [['completed_at', 'ASC'], ['id', 'ASC']],
    });
    return result('found', { results });
  } catch (err) {
    logger.error('Letter motor reassessment history read failed', { studentId, status: 'read_failed', errorMessage: err.message });
    return result('read_failed', { results: [] });
  }
}

module.exports = {
  SOURCE_TYPE_REASSESSMENT,
  REASSESSMENT_ATTEMPT_NUMBER,
  saveReassessmentAttempt,
  finalizeReassessment,
  getLatestReassessment,
  getReassessmentHistory,
  // Exported for tests only:
  selectMostRecentPerLetter,
};
