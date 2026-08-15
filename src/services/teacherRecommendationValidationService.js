'use strict';

/**
 * teacherRecommendationValidationService.js
 *
 * Feature 9 Step 3 — append-only teacher-validation write path + read-only
 * history for Feature 8 worksheet recommendations.
 *
 * ── Two Feature 7/8 reads per write, exactly once each (Step 3 spec §41/§42) ──
 * Feature 8's own public result (`evaluateWorksheetRecommendations`) does
 * NOT expose the Feature 7 evidence windows a trusted evidence fingerprint
 * needs (`earlierWindow`/`recentWindow`/`affectedLetters` never leave
 * Feature 7's own stream object once Feature 8 builds a recommendation from
 * it) — confirmed by inspection of both services before writing this file,
 * per the Step 3 prompt's own explicit instruction to re-check the service
 * boundary before coding. Rather than re-querying `LetterAttempt`
 * independently (forbidden — Step 3 spec §41) or modifying Feature 8 to
 * leak internal provenance through its public API (also avoided — Step 3
 * spec §43, lowest-risk option), `validateWorksheetRecommendation()` calls
 * BOTH `evaluatePersistentDifficulty({studentId})` (Feature 7, for evidence
 * provenance) and `evaluateWorksheetRecommendations({studentId})` (Feature
 * 8, for the recommendation content itself) — this is the Step 3 prompt's
 * own explicitly preferred architecture (§42). Both calls are issued
 * concurrently via `Promise.all` to minimize (not eliminate) the time
 * window in which new practice data could land between the two reads; the
 * downstream recommendation-fingerprint comparison (§45/§17) is what
 * actually protects correctness if that narrow window is ever hit — a
 * mismatch is treated as `recommendation_not_found`/`recommendation_changed`,
 * never written. Neither Feature 7 nor Feature 8's own files are modified
 * to support this.
 *
 * ── What this module never does ────────────────────────────────────────────
 *   - never imports `../models/LetterAttempt`, `StudentMotorBaseline`,
 *     `dynamicThresholdService`, `adaptiveSupportService`,
 *     `adaptivePreWritingService`, `repetitionRecommendationService`,
 *     `demoSpeedRecommendationService`, `RecommendationHistory`, or
 *     `TeacherValidation` — its only feature dependencies are
 *     `persistentDifficultyService` (Feature 7) and
 *     `worksheetRecommendationService` (Feature 8), read-only;
 *   - never trusts client-supplied recommendation content (title,
 *     focusLetters, suggestedActivities, rationale, fingerprints, policy
 *     versions, teacherId) — every one of those is server-reconstructed
 *     (Step 3 spec §38/§46/§47/§48);
 *   - never calls `.update()`/`.destroy()`/`.save()` on an existing row —
 *     `findOrCreate()` is the only write, and only ever inserts;
 *   - never suppresses or otherwise alters Feature 8's own recommendation
 *     generation, and never writes back into Feature 1-7's own state
 *     (Step 3 spec §60/§61).
 *
 * ── Research framing ────────────────────────────────────────────────────────
 * This module stores teacher judgement about educational handwriting
 * practice recommendations — never clinical validation, diagnosis
 * confirmation, treatment approval, or severity.
 */

const { TeacherRecommendationValidation } = require('../models');
const { MAX_TEACHER_NOTE_LENGTH } = require('../models/TeacherRecommendationValidation');
const { evaluatePersistentDifficulty } = require('./persistentDifficultyService');
const { evaluateWorksheetRecommendations } = require('./worksheetRecommendationService');
const { PERSISTENT_DIFFICULTY_STATUSES } = require('../config/persistentDifficultyPolicy');
const { MAPPING_VERSION } = require('../config/letterBaselineFamilies');
const {
  PERSISTENT_DIFFICULTY_POLICY_VERSION,
  WORKSHEET_RECOMMENDATION_POLICY_VERSION,
  computePersistentEvidenceFingerprint,
  computeWorksheetRecommendationFingerprint,
} = require('../config/feature9Provenance');
const logger = require('../utils/logger');

const CASE_TYPES = ['lowercase', 'uppercase'];
const FAMILIES = ['straight', 'curved', 'complex'];
const VALIDATION_VALUES = ['confirmed', 'dismissed'];
const SHA256_HEX = /^[a-f0-9]{64}$/;

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function toIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Trims, collapses an empty/whitespace-only note to null, and rejects
// anything over MAX_TEACHER_NOTE_LENGTH (Step 3 spec §17). Returns
// { ok: true, value } or { ok: false }.
function normalizeTeacherNote(teacherNote) {
  if (teacherNote === undefined || teacherNote === null) return { ok: true, value: null };
  if (typeof teacherNote !== 'string') return { ok: false };
  const trimmed = teacherNote.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (trimmed.length > MAX_TEACHER_NOTE_LENGTH) return { ok: false };
  return { ok: true, value: trimmed };
}

function invalidInput(extra = {}) {
  return { status: 'invalid_input', ...extra };
}

// ─── Write path (Step 3 spec §36-§49) ───────────────────────────────────────

/**
 * Records one teacher judgement (confirmed/dismissed) about a specific,
 * server-verified Feature 8 recommendation instance. Append-only — never
 * updates or deletes an existing row.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} params.teacherId - MUST be sourced from the authenticated
 *   req.user.id by the future Step 4 controller — this function trusts
 *   whatever value it is given, so callers must never forward a
 *   client-supplied teacherId.
 * @param {'lowercase'|'uppercase'} params.caseType
 * @param {'straight'|'curved'|'complex'} params.family
 * @param {'confirmed'|'dismissed'} params.validation
 * @param {string} [params.teacherNote]
 * @param {string} params.recommendationFingerprint - the fingerprint the
 *   client last fetched for the recommendation it is validating (race
 *   protection — Step 3 spec §45).
 * @returns {Promise<Object>} one of:
 *   { status: 'invalid_input', reason }
 *   { status: 'read_failed' }
 *   { status: 'recommendation_not_found' }
 *   { status: 'recommendation_changed', currentRecommendationFingerprint }
 *   { status: 'write_failed' }
 *   { status: 'validated', id, duplicate, validatedAt }
 */
async function validateWorksheetRecommendation({
  studentId, teacherId, caseType, family, validation, teacherNote, recommendationFingerprint,
} = {}) {
  // ── Input validation before any Feature 7/8 call (Step 3 spec §37) ────────
  if (!isPositiveInteger(studentId)) return invalidInput({ reason: 'invalid_student_id' });
  if (!isPositiveInteger(teacherId)) return invalidInput({ reason: 'invalid_teacher_id' });
  if (!CASE_TYPES.includes(caseType)) return invalidInput({ reason: 'invalid_case_type' });
  if (!FAMILIES.includes(family)) return invalidInput({ reason: 'invalid_family' });
  if (!VALIDATION_VALUES.includes(validation)) return invalidInput({ reason: 'invalid_validation' });
  if (typeof recommendationFingerprint !== 'string' || !SHA256_HEX.test(recommendationFingerprint)) {
    return invalidInput({ reason: 'malformed_recommendation_fingerprint' });
  }

  const normalizedNote = normalizeTeacherNote(teacherNote);
  if (!normalizedNote.ok) return invalidInput({ reason: 'teacher_note_too_long' });

  // ── One Feature 7 read + one Feature 8 read, concurrently (Step 3 spec §38/§42) ──
  let feature7Result;
  let feature8Result;
  try {
    [feature7Result, feature8Result] = await Promise.all([
      evaluatePersistentDifficulty({ studentId }),
      evaluateWorksheetRecommendations({ studentId }),
    ]);
  } catch (err) {
    logger.error('Teacher-recommendation-validation dependency read threw unexpectedly', {
      studentId, caseType, family, errorMessage: err.message,
    });
    return { status: 'read_failed' };
  }

  // 'invalid_input' from either dependency is unreachable here in practice
  // (studentId already validated above with an identical rule) but
  // propagated defensively as read_failed rather than assumed unreachable
  // (Step 3 spec §39) — a write must never proceed on a non-evaluated
  // dependency result.
  if (feature7Result.status !== 'evaluated' || feature8Result.status !== 'evaluated') {
    return { status: 'read_failed' };
  }

  // ── Locate the matching Feature 8 recommendation (Step 3 spec §40) ────────
  const recommendation = feature8Result.recommendations.find(
    (r) => r.caseType === caseType && r.family === family
  );
  if (!recommendation) return { status: 'recommendation_not_found' };

  // ── Locate the matching Feature 7 stream for evidence provenance ─────────
  // Must independently confirm 'persistent' on THIS read too — if the two
  // concurrent reads ever disagree (the narrow race window noted above),
  // this is what prevents writing a recommendation snapshot whose evidence
  // fingerprint cannot actually be computed as persistent evidence.
  const stream = feature7Result.streams[caseType] && feature7Result.streams[caseType][family];
  if (!stream || stream.status !== PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT) {
    return { status: 'recommendation_not_found' };
  }

  // ── Trusted evidence fingerprint (Step 3 spec §41) ────────────────────────
  const evidenceFingerprint = computePersistentEvidenceFingerprint({
    studentId,
    caseType,
    family,
    earlierWindow: stream.earlierWindow,
    recentWindow: stream.recentWindow,
    affectedLetters: stream.affectedLetters,
    persistentPolicyVersion: PERSISTENT_DIFFICULTY_POLICY_VERSION,
    mappingVersion: MAPPING_VERSION,
  });
  if (evidenceFingerprint === null) {
    // Defensive only — a real 'persistent' stream always carries
    // well-formed windows/affectedLetters; this guards against a
    // malformed upstream result rather than a case expected in practice.
    logger.error('Evidence fingerprint computation failed for a persistent stream', { studentId, caseType, family });
    return { status: 'read_failed' };
  }

  // ── Trusted recommendation fingerprint (Step 3 spec §44) ──────────────────
  const serverRecommendationFingerprint = computeWorksheetRecommendationFingerprint({
    studentId,
    caseType,
    family,
    recommendationType: recommendation.recommendationType,
    focusLetters: recommendation.focusLetters,
    evidenceFingerprint,
    recommendationPolicyVersion: WORKSHEET_RECOMMENDATION_POLICY_VERSION,
  });
  if (serverRecommendationFingerprint === null) {
    logger.error('Recommendation fingerprint computation failed for a persistent stream', { studentId, caseType, family });
    return { status: 'read_failed' };
  }

  // ── Race check (Step 3 spec §45, the future 409 contract) ─────────────────
  if (serverRecommendationFingerprint !== recommendationFingerprint) {
    return { status: 'recommendation_changed', currentRecommendationFingerprint: serverRecommendationFingerprint };
  }

  // ── Server-trusted snapshot + idempotent append-only write (Step 3 spec §46-§49) ──
  try {
    const [row, created] = await TeacherRecommendationValidation.findOrCreate({
      where: {
        student_id: studentId,
        teacher_id: teacherId,
        case_type: caseType,
        family,
        validation,
        recommendation_fingerprint: serverRecommendationFingerprint,
      },
      defaults: {
        student_id: studentId,
        teacher_id: teacherId,
        case_type: caseType,
        family,
        recommendation_type: recommendation.recommendationType,
        recommendation_title: recommendation.title,
        focus_letters: recommendation.focusLetters,
        suggested_activities: recommendation.suggestedActivities,
        rationale: recommendation.rationale,
        validation,
        teacher_note: normalizedNote.value,
        evidence_fingerprint: evidenceFingerprint,
        recommendation_fingerprint: serverRecommendationFingerprint,
        persistent_policy_version: PERSISTENT_DIFFICULTY_POLICY_VERSION,
        recommendation_policy_version: WORKSHEET_RECOMMENDATION_POLICY_VERSION,
        mapping_version: MAPPING_VERSION,
      },
    });

    return {
      status: 'validated',
      id: row.id,
      duplicate: !created,
      validatedAt: toIso(row.created_at),
    };
  } catch (err) {
    logger.error('Teacher-recommendation-validation write failed', {
      studentId, teacherId, caseType, family, validation, errorMessage: err.message,
    });
    return { status: 'write_failed' };
  }
}

// ─── History read path (Step 3 spec §51-§59) ────────────────────────────────

function toPublicHistoryEvent(row) {
  return {
    id: row.id,
    caseType: row.case_type,
    family: row.family,
    recommendation: {
      type: row.recommendation_type,
      title: row.recommendation_title,
      focusLetters: row.focus_letters,
    },
    validation: row.validation,
    teacherNote: row.teacher_note,
    validatedAt: toIso(row.created_at),
  };
}

// Rows are already ordered created_at DESC, id DESC — the first row
// encountered for a given (case_type, family) pair is therefore already
// its latest event (Step 3 spec §55).
function buildLatestByStream(rows) {
  const latestByStream = {};
  for (const caseType of CASE_TYPES) latestByStream[caseType] = {};

  for (const row of rows) {
    const streamsForCase = latestByStream[row.case_type];
    if (!streamsForCase || streamsForCase[row.family]) continue; // already have the latest for this stream
    streamsForCase[row.family] = {
      validation: row.validation,
      teacherNote: row.teacher_note,
      validatedAt: toIso(row.created_at),
    };
  }
  return latestByStream;
}

/**
 * Read-only. Returns the full validation history for a student, optionally
 * narrowed to one (caseType, family) stream, newest-first, plus a
 * latest-by-stream convenience rollup.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} [params.caseType]
 * @param {string} [params.family]
 * @returns {Promise<Object>}
 */
async function getTeacherValidationHistory({ studentId, caseType, family } = {}) {
  if (!isPositiveInteger(studentId)) return invalidInput({ studentId: null, events: null, latestByStream: null });
  if (caseType !== undefined && !CASE_TYPES.includes(caseType)) {
    return invalidInput({ studentId: null, events: null, latestByStream: null });
  }
  if (family !== undefined && !FAMILIES.includes(family)) {
    return invalidInput({ studentId: null, events: null, latestByStream: null });
  }

  const where = { student_id: studentId };
  if (caseType !== undefined) where.case_type = caseType;
  if (family !== undefined) where.family = family;

  let rows;
  try {
    rows = await TeacherRecommendationValidation.findAll({
      where,
      order: [['created_at', 'DESC'], ['id', 'DESC']],
    });
  } catch (err) {
    logger.error('Teacher-recommendation-validation history read threw unexpectedly', {
      studentId, caseType, family, errorMessage: err.message,
    });
    return { status: 'read_failed', studentId, events: null, latestByStream: null };
  }

  return {
    status: 'evaluated',
    studentId,
    events: rows.map(toPublicHistoryEvent),
    latestByStream: buildLatestByStream(rows),
  };
}

/**
 * Read-only. Resolves the teacher's current judgement for ONE specific,
 * currently-displayed recommendation instance — identified by its exact
 * recommendation fingerprint, never by (studentId, caseType, family) alone
 * (Step 3 spec §43/§56/§59): a newer recommendation instance for the same
 * stream may carry a different fingerprint and must not inherit an older
 * instance's judgement.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.caseType
 * @param {string} params.family
 * @param {string} params.recommendationFingerprint
 * @returns {Promise<Object>}
 */
async function getLatestValidationForRecommendation({
  studentId, caseType, family, recommendationFingerprint,
} = {}) {
  if (!isPositiveInteger(studentId)) return invalidInput({ current: null });
  if (!CASE_TYPES.includes(caseType)) return invalidInput({ current: null });
  if (!FAMILIES.includes(family)) return invalidInput({ current: null });
  if (typeof recommendationFingerprint !== 'string' || !SHA256_HEX.test(recommendationFingerprint)) {
    return invalidInput({ current: null });
  }

  let row;
  try {
    row = await TeacherRecommendationValidation.findOne({
      where: {
        student_id: studentId,
        case_type: caseType,
        family,
        recommendation_fingerprint: recommendationFingerprint,
      },
      order: [['created_at', 'DESC'], ['id', 'DESC']],
    });
  } catch (err) {
    logger.error('Latest-validation-for-recommendation read threw unexpectedly', {
      studentId, caseType, family, errorMessage: err.message,
    });
    return { status: 'read_failed', current: null };
  }

  return {
    status: 'evaluated',
    current: row
      ? { validation: row.validation, teacherNote: row.teacher_note, validatedAt: toIso(row.created_at) }
      : null,
  };
}

module.exports = {
  MAX_TEACHER_NOTE_LENGTH,
  validateWorksheetRecommendation,
  getTeacherValidationHistory,
  getLatestValidationForRecommendation,
};
