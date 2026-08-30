'use strict';

/**
 * motorBaselineService.js
 *
 * Feature 1: Individual Motor-Family Baseline.
 *
 * Creates the student's immutable initial-assessment motor-family baseline
 * (straight / curved / complex + overall motor score) as a
 * StudentMotorBaseline row. This service is READ-ONLY with respect to
 * HandwritingAssessment — it never recalculates scores and never calls
 * assessment.update(...). The single source of truth for the four scores
 * remains calculateMotorProfile() (frontend/src/utils/adaptiveSequencing.js),
 * whose output is already persisted on HandwritingAssessment.motor_score /
 * motor_profile by handwritingController.finalizeAssessment before this
 * service is ever called.
 *
 * Identifiers are accepted, not a client-supplied motor profile — the
 * assessment is re-read from the database inside the service so the
 * persisted values (not whatever a caller claims they are) are always what
 * gets copied into the baseline.
 *
 * NOT involved: ShapeFeature, StudentMotorFeature (raw ML feature stores,
 * not baseline-score sources — see Step 1 audit).
 */

const { HandwritingAssessment, StudentMotorBaseline, ShapeFeature } = require('../models');
// The canonical six-shape protocol, reused - never a second copy of the list.
const { FAMILY_SHAPES } = require('./authoritativeMotorBaselineService');
const logger = require('../utils/logger');

const BASELINE_VERSION = 'baseline-v1';
const TAXONOMY_VERSION = 'assessment-motor-v1';
const SOURCE_TYPE_INITIAL = 'initial_assessment';

const SCORE_MIN = 0;
const SCORE_MAX = 100;

// ─── Validation helpers (private) ──────────────────────────────────────────

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Deliberately requires typeof 'number' rather than coercing with
// Number(value) — Number(null) === 0 and Number('') === 0 would silently
// treat missing data as a real zero score. Live-data inspection (see Step 2
// report) confirmed straightScore/curvedScore/complexScore/motor_score are
// always stored as genuine JSON numbers, never numeric strings, so there is
// no legitimate case that needs string coercion here — a stringified score
// is treated as missing, not parsed.
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isValidScore(value) {
  return isFiniteNumber(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

function validateFamilyScore(value, label) {
  if (!isFiniteNumber(value)) return { valid: false, reason: `missing_${label}_score` };
  if (value < SCORE_MIN || value > SCORE_MAX) return { valid: false, reason: `${label}_score_out_of_range` };
  return { valid: true };
}

// ─── Shared score-validity rule (exported) ─────────────────────────────────
//
// The single source of truth for "is this persisted motor_profile +
// motor_score valid enough to become a baseline" — used by
// createInitialMotorBaseline (real-time, below) AND by
// src/scripts/backfillMotorBaselines.js (historical, read-only). Extracted
// so the two paths can never drift apart on score rules. Pure function: no
// DB access, no logging, no side effects — safe to call from a read-only
// context.
//
// @param {Object|null} motorProfile — assessment.motor_profile as persisted
// @param {*} motorScore — assessment.motor_score as persisted
// @returns {{
//   valid: boolean,
//   reason: string|null,
//   scores: {straightScore, curvedScore, complexScore, overallMotorScore}|null
// }}
function validateMotorProfileForBaseline(motorProfile, motorScore) {
  if (motorProfile == null || typeof motorProfile !== 'object' || Array.isArray(motorProfile)) {
    return { valid: false, reason: 'motor_profile_missing', scores: null };
  }

  const straightCheck = validateFamilyScore(motorProfile.straightScore, 'straight');
  if (!straightCheck.valid) return { valid: false, reason: straightCheck.reason, scores: null };

  const curvedCheck = validateFamilyScore(motorProfile.curvedScore, 'curved');
  if (!curvedCheck.valid) return { valid: false, reason: curvedCheck.reason, scores: null };

  const complexCheck = validateFamilyScore(motorProfile.complexScore, 'complex');
  if (!complexCheck.valid) return { valid: false, reason: complexCheck.reason, scores: null };

  // Single reason code for missing/non-finite/out-of-range overall score —
  // matches the approved Step 2 spec's example response exactly.
  if (!isValidScore(motorScore)) {
    return { valid: false, reason: 'invalid_overall_motor_score', scores: null };
  }

  return {
    valid:  true,
    reason: null,
    scores: {
      straightScore:     motorProfile.straightScore,
      curvedScore:       motorProfile.curvedScore,
      complexScore:      motorProfile.complexScore,
      overallMotorScore: motorScore,
    },
  };
}

/**
 * Is THIS assessment usable as a student's initial motor baseline?
 *
 * One predicate, one place. It asks exactly what createInitialMotorBaseline
 * actually needs and nothing more:
 *   - not a research/collection-protocol assessment
 *   - a persisted motor_profile whose three family scores are valid
 *   - a valid overall motor_score
 *
 * Deliberately does NOT require `is_initial` (documented as historically
 * unreliable) or a finalized flag.
 *
 * This is the LEGACY half only. A baseline row exists to do three jobs -
 * describe the initial motor summary, carry the authoritative progression
 * family scores, and initialize personalized family thresholds - and the last
 * two need linked ShapeFeature evidence that motor_profile alone cannot
 * provide. `findEarliestEligibleAssessment` applies both halves; use it, not
 * this predicate on its own, to decide what may become a baseline.
 *
 * Pure — no DB access, no logging. Shared by the real-time path and the
 * historical backfill so the two can never drift.
 *
 * @param {Object|null} assessment — a HandwritingAssessment row/instance
 * @returns {{eligible: boolean, reason: string|null}}
 */
function isEligibleInitialMotorAssessment(assessment) {
  if (!assessment) return { eligible: false, reason: 'assessment_missing' };
  if (assessment.collection_mode === true) {
    return { eligible: false, reason: 'collection_assessment_not_eligible' };
  }
  const validation = validateMotorProfileForBaseline(assessment.motor_profile, assessment.motor_score);
  if (!validation.valid) return { eligible: false, reason: validation.reason };
  return { eligible: true, reason: null };
}

/**
 * The EARLIEST ELIGIBLE non-collection assessment for a student.
 *
 * ── Why this replaced "the earliest non-collection assessment" ───────────
 * That older rule assumed the earliest row was the real initial assessment.
 * Live data disproved it: student 10's earliest non-collection assessment
 * (2026-05-01) carries motor_profile = NULL, and the rule rejected the whole
 * student rather than looking past it — while 59 perfectly valid assessments
 * sat behind it. The student could therefore NEVER receive a baseline, and
 * every letter threshold fell back to the global default forever.
 *
 * Chronology is still respected, and this still never "picks a later
 * assessment because an earlier one failed to pass validation for an
 * interesting reason": it walks forward in time and takes the FIRST row that
 * is genuinely usable. An earlier eligible row always wins over a later one.
 *
 * @param {{studentId: number}} args
 * @returns {Promise<{assessment: Object|null, skipped: Array<{id, reason}>}>}
 */
async function findEarliestEligibleAssessment({ studentId }) {
  const candidates = await HandwritingAssessment.findAll({
    where: { student_id: studentId, collection_mode: false },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
  });
  if (candidates.length === 0) return { assessment: null, skipped: [] };

  // ONE evidence query for every candidate, not one per assessment - a
  // long-running student can have well over a hundred of them.
  //
  // source = 'initial_assessment' is what excludes pre-writing warm-up
  // captures, which are written with assessment_id NULL by design and must
  // never become baseline evidence.
  let evidenceRows = [];
  try {
    evidenceRows = await ShapeFeature.findAll({
      where: {
        student_id: studentId,
        assessment_id: candidates.map((c) => c.id),
        source: SOURCE_INITIAL_ASSESSMENT_EVIDENCE,
        collection_mode: false,
      },
      attributes: ['assessment_id', 'shape_type', 'motor_score'],
      raw: true,
    });
  } catch (err) {
    logEvent('warn', 'Motor baseline: shape-evidence lookup failed', {
      studentId, assessmentId: null, status: 'evidence_read_failed',
    });
    // Fails CLOSED: with no evidence readable, nothing is fully eligible, so
    // no baseline is created from an unverified assessment.
  }

  const byAssessment = new Map();
  for (const row of evidenceRows) {
    if (!byAssessment.has(row.assessment_id)) byAssessment.set(row.assessment_id, []);
    byAssessment.get(row.assessment_id).push(row);
  }

  const skipped = [];
  for (const candidate of candidates) {
    // Half 1 - the legacy descriptive fields.
    const { eligible, reason } = isEligibleInitialMotorAssessment(candidate);
    if (!eligible) {
      skipped.push({ id: candidate.id, reason });
      continue;
    }
    // Half 2 - the authoritative progression evidence.
    const evidence = evaluateShapeEvidence(byAssessment.get(candidate.id));
    if (!evidence.sufficient) {
      skipped.push({ id: candidate.id, reason: evidence.reason, missing: evidence.missing });
      continue;
    }
    return { assessment: candidate, skipped };
  }
  return { assessment: null, skipped };
}

// ─── Authoritative shape evidence ───────────────────────────────────────────
//
// The six canonical initial-assessment tasks, flattened from the SAME family
// map computeAuthoritativeFamilyProfile() averages over. Deliberately derived
// rather than re-listed: a second hand-written copy of these six strings is
// exactly how the two would drift.
const REQUIRED_SHAPES = Object.freeze(Object.values(FAMILY_SHAPES).flat());
const SOURCE_INITIAL_ASSESSMENT_EVIDENCE = 'initial_assessment';

/**
 * Does this assessment carry the evidence the AUTHORITATIVE progression
 * scores actually need?
 *
 * Checks the canonical task SET, not a row count. Six rows that are five
 * copies of horizontal_line plus a zigzag would satisfy `COUNT(*) >= 6` and
 * produce a baseline with two null families - so presence is checked per
 * shape, and each must carry a finite motor_score.
 *
 * Pure: takes the already-loaded rows, so the caller can fetch every
 * candidate's evidence in ONE query instead of one per assessment.
 *
 * @param {Array<{shape_type: string, motor_score: number|null}>} rows
 * @returns {{sufficient: boolean, reason: string|null, missing: string[]}}
 */
function evaluateShapeEvidence(rows) {
  const usable = new Map();
  for (const row of rows ?? []) {
    const score = row?.motor_score;
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    if (!usable.has(row.shape_type)) usable.set(row.shape_type, score);
  }

  const missing = REQUIRED_SHAPES.filter((shape) => !usable.has(shape));
  if (missing.length > 0) {
    return { sufficient: false, reason: 'incomplete_shape_evidence', missing };
  }
  return { sufficient: true, reason: null, missing: [] };
}

function result(status, baseline, reason = null) {
  return { status, baseline, reason };
}

// Structured, low-detail logging only — studentId/assessmentId/baselineId
// are pseudonymous database IDs, never names or raw handwriting data.
function logEvent(level, message, { studentId, assessmentId, baselineId = null, baselineVersion = null, status }) {
  logger[level](message, { studentId, assessmentId, baselineId, baselineVersion, status });
}

// ─── Main service function ─────────────────────────────────────────────────

/**
 * Creates the student's immutable initial motor-family baseline from an
 * already-finalized HandwritingAssessment.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} params.assessmentId
 * @param {boolean} [params.isBackfilled=false] — true only when called from
 *   the controlled backfill utility (not yet implemented in this step).
 * @returns {Promise<{status: string, baseline: Object|null, reason: string|null}>}
 *
 * Possible statuses:
 *   created, already_exists, student_baseline_already_exists, invalid_input,
 *   source_assessment_not_found, student_mismatch,
 *   collection_assessment_not_eligible, not_initial_assessment,
 *   invalid_motor_profile, save_failed
 */
async function createInitialMotorBaseline({ studentId, assessmentId, isBackfilled = false }) {
  // 1. Validate identifiers — never throw for ordinary validation failures.
  if (!isPositiveInteger(studentId)) {
    return result('invalid_input', null, 'invalid_student_id');
  }
  if (!isPositiveInteger(assessmentId)) {
    return result('invalid_input', null, 'invalid_assessment_id');
  }

  try {
    // 2. Load source assessment.
    const assessment = await HandwritingAssessment.findByPk(assessmentId);
    if (!assessment) {
      logEvent('warn', 'Motor baseline: source assessment not found', { studentId, assessmentId, status: 'source_assessment_not_found' });
      return result('source_assessment_not_found', null);
    }
    if (assessment.student_id !== studentId) {
      logEvent('warn', 'Motor baseline: student mismatch', { studentId, assessmentId, status: 'student_mismatch' });
      return result('student_mismatch', null);
    }

    // 3. Reject collection/research-protocol assessments — they must never
    // automatically become the student's permanent learning baseline.
    if (assessment.collection_mode === true) {
      logEvent('info', 'Motor baseline: collection-mode assessment not eligible', { studentId, assessmentId, status: 'collection_assessment_not_eligible' });
      return result('collection_assessment_not_eligible', null);
    }

    // 4. Initial-assessment eligibility — do NOT trust assessment.is_initial
    // (documented as historically unreliable, see Step 1 audit / getInitialReport
    // in handwritingController.js). Reuse that same existing project
    // convention: the earliest non-collection assessment for this student.
    // id is a deterministic tiebreaker for equal created_at timestamps.
    // If THIS assessment is itself unusable, say so specifically rather than
    // reporting the generic "not the initial one". Its own reason
    // (motor_profile_missing, missing_curved_score, ...) is far more useful
    // to a caller and to the backfill utility, and step 6 below produces it.
    // Falling through here keeps that contract byte-identical.
    const selfEligibility = isEligibleInitialMotorAssessment(assessment);
    if (!selfEligibility.eligible) {
      logEvent('info', 'Motor baseline: invalid motor profile', { studentId, assessmentId, status: 'invalid_motor_profile' });
      return result('invalid_motor_profile', null, selfEligibility.reason);
    }

    const { assessment: earliestEligible, skipped } = await findEarliestEligibleAssessment({ studentId });
    if (!earliestEligible) {
      // No usable assessment anywhere for this student. Honest status, no
      // fabricated baseline - the threshold resolver's safe global fallback
      // keeps the child unblocked.
      logEvent('info', 'Motor baseline: no eligible assessment for this student', {
        studentId, assessmentId, status: 'not_initial_assessment',
      });
      return result('not_initial_assessment', null, 'no_eligible_assessment');
    }
    if (earliestEligible.id !== assessment.id) {
      // Chronology is preserved: an EARLIER eligible assessment already owns
      // this student's baseline, so this later one must not become it.
      logEvent('info', 'Motor baseline: not the earliest eligible assessment', {
        studentId, assessmentId, status: 'not_initial_assessment',
      });
      return result('not_initial_assessment', null, 'earlier_eligible_assessment_exists');
    }
    if (skipped.length > 0) {
      // Visible, not silent: this student had earlier rows that could not be
      // used, and which ones. Exactly the case that used to block a baseline
      // outright (see findEarliestEligibleAssessment's header).
      logEvent('info', 'Motor baseline: skipped earlier ineligible assessments', {
        studentId, assessmentId, status: 'skipped_ineligible',
        skippedCount: skipped.length,
        skippedReasons: [...new Set(skipped.map(s => s.reason))].join(','),
      });
    }

    // 5. Idempotency — one baseline per source assessment (also enforced by
    // the UNIQUE(source_assessment_id) DB constraint, see step 9 below).
    const existingBySource = await StudentMotorBaseline.findOne({ where: { source_assessment_id: assessmentId } });
    if (existingBySource) {
      logEvent('info', 'Motor baseline already exists for this assessment', { studentId, assessmentId, baselineId: existingBySource.id, status: 'already_exists' });
      return result('already_exists', existingBySource);
    }

    // Additional student-level protection: only one *normal* initial
    // baseline is intended per student in this feature. Checked regardless
    // of is_backfilled on the existing row (a prior normal baseline blocks a
    // later backfill attempt and vice versa) — this is exactly the guard
    // against historical is_initial inconsistencies producing two "initial"
    // baselines for the same student from different source assessments.
    // Future versioned re-baselining is a separate, explicit process — not
    // implemented here.
    const existingForStudent = await StudentMotorBaseline.findOne({
      where: { student_id: studentId, source_type: SOURCE_TYPE_INITIAL },
    });
    if (existingForStudent) {
      logEvent('warn', 'Motor baseline: student already has a baseline from a different assessment', { studentId, assessmentId, baselineId: existingForStudent.id, status: 'student_baseline_already_exists' });
      return result('student_baseline_already_exists', existingForStudent);
    }

    // 6, 7 & 8. Validate persisted motor_profile + overall motor_score —
    // copy only, never recompute. Delegates to the shared validator so this
    // path and the backfill script can never drift on score rules.
    const validation = validateMotorProfileForBaseline(assessment.motor_profile, assessment.motor_score);
    if (!validation.valid) {
      logEvent('info', 'Motor baseline: invalid motor profile', { studentId, assessmentId, status: 'invalid_motor_profile' });
      return result('invalid_motor_profile', null, validation.reason);
    }
    const { straightScore, curvedScore, complexScore, overallMotorScore } = validation.scores;

    // 9. Create the immutable baseline. No updated_at, no manual created_at
    // (DB/model default timestamp is used).
    let baseline;
    try {
      baseline = await StudentMotorBaseline.create({
        student_id:            studentId,
        source_assessment_id:  assessmentId,
        straight_score:        straightScore,
        curved_score:          curvedScore,
        complex_score:         complexScore,
        overall_motor_score:   overallMotorScore,
        baseline_version:      BASELINE_VERSION,
        taxonomy_version:      TAXONOMY_VERSION,
        source_type:           SOURCE_TYPE_INITIAL,
        is_backfilled:         !!isBackfilled,
        backfilled_at:         isBackfilled ? new Date() : null,
      });
    } catch (createErr) {
      // 10. Race-condition safety: two requests could both pass the
      // findOne() idempotency check above before either inserts. The DB's
      // UNIQUE(source_assessment_id) constraint is the real guard; here we
      // just resolve the resulting error back to the same already_exists
      // contract instead of surfacing it as a failure.
      if (createErr.name === 'SequelizeUniqueConstraintError') {
        const raceExisting = await StudentMotorBaseline.findOne({ where: { source_assessment_id: assessmentId } });
        if (raceExisting) {
          logEvent('info', 'Motor baseline: race condition resolved to already_exists', { studentId, assessmentId, baselineId: raceExisting.id, status: 'already_exists' });
          return result('already_exists', raceExisting);
        }
      }
      throw createErr; // anything else falls through to the outer catch → save_failed
    }

    logEvent('info', 'Motor baseline created', { studentId, assessmentId, baselineId: baseline.id, baselineVersion: BASELINE_VERSION, status: 'created' });
    return result('created', baseline);

  } catch (err) {
    // 11. Unexpected DB failure — never break the caller's flow, never
    // expose DB internals (SQL/password/host) to the returned result.
    logger.error('Motor baseline creation failed', { studentId, assessmentId, status: 'save_failed', errorMessage: err.message });
    return result('save_failed', null);
  }
}

// ─── Read-only retrieval ────────────────────────────────────────────────────

/**
 * Reads the student's authoritative Individual Motor-Family Baseline.
 *
 * READ ONLY — never creates, backfills, or derives a baseline from
 * HandwritingAssessment.motor_profile. StudentMotorBaseline is the
 * authoritative persisted store; if no row exists yet, that is reported as
 * `baseline_not_found`, not silently synthesized from the source assessment.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, baseline: Object|null, reason: string|null}>}
 *
 * Possible statuses: found, baseline_not_found, invalid_input, read_failed
 */
async function getStudentMotorBaseline({ studentId }) {
  if (!isPositiveInteger(studentId)) {
    return result('invalid_input', null, 'invalid_student_id');
  }

  try {
    // One active initial baseline is expected per student (enforced by the
    // student-level guard in createInitialMotorBaseline), but the lookup is
    // kept deterministic regardless — earliest by created_at, id as tiebreaker.
    const baseline = await StudentMotorBaseline.findOne({
      where: { student_id: studentId, source_type: SOURCE_TYPE_INITIAL },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });

    if (!baseline) {
      logEvent('info', 'Motor baseline read: not found', { studentId, assessmentId: null, status: 'baseline_not_found' });
      return result('baseline_not_found', null);
    }

    logEvent('info', 'Motor baseline read: found', { studentId, assessmentId: baseline.source_assessment_id, baselineId: baseline.id, status: 'found' });
    return result('found', baseline);

  } catch (err) {
    logger.error('Motor baseline read failed', { studentId, status: 'read_failed', errorMessage: err.message });
    return result('read_failed', null);
  }
}

module.exports = {
  isEligibleInitialMotorAssessment,
  findEarliestEligibleAssessment,
  evaluateShapeEvidence,
  REQUIRED_SHAPES, createInitialMotorBaseline, getStudentMotorBaseline, validateMotorProfileForBaseline };
