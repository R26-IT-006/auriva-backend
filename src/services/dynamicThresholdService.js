'use strict';

/**
 * dynamicThresholdService.js
 *
 * Feature 2 Steps 2 & 3 — initial family-threshold DERIVATION (pure,
 * read-only, unchanged since Step 2) and CONTROLLED PERSISTENCE (new in
 * Step 3) into student_threshold_history as auditable 'initial_from_baseline'
 * events. Step 4 — read-only recent independent performance windows. Step 5
 * — read-only DECISION SIMULATION (what the system would recommend), still
 * with zero persistence. Step 6A — teacher-override PROVENANCE (a real
 * write, but a human-authored one) plus a read-only protection helper the
 * future automatic-persistence step must consult before ever writing an
 * 'automatic' row. Teacher family threshold overrides are human supervisory
 * adjustments to a pilot adaptive-learning target — not clinical
 * prescriptions; this system is educational/adaptive, not diagnostic.
 * Step 6B — CONTROLLED AUTOMATIC PERSISTENCE: a qualifying 'raise' decision
 * (and only 'raise') may become a real append-only 'automatic' history
 * event, gated by teacher protection, a staleness re-check, and
 * evidence-level idempotency (evidence_fingerprint). Step 7 (a different
 * file — progressionThresholdResolver.js) is where a Feature 2 family
 * target first started GATING real child progression. Step 8 —
 * FINAL AUTOMATIC ORCHESTRATION: processDynamicThresholdAfterLetterSession()
 * is the one event-driven trigger, called only from recordLetterCompletion
 * after a normal-mode session's LetterAttempt rows are successfully saved,
 * that turns "new practice evidence" into an automatic re-evaluation —
 * still reusing Step 5/6B exactly as-is, still never lowering a threshold,
 * still never overriding a teacher decision, still never touching
 * students.personal_thresholds. Pilot rule-based adaptive-progression
 * events, not clinical decisions — the 5-attempt window, 4-of-5 rule, and
 * +5 step remain pilot engineering defaults requiring teacher/pilot
 * validation.
 *
 * What this module still never does, even after Step 8:
 *   - never writes students.personal_thresholds (the live progression gate
 *     is completely untouched — see thresholdUtils.getStudentThreshold /
 *     handwritingController.recordLetterCompletion, neither imported here);
 *   - never mutates StudentMotorBaseline (read-only via
 *     motorBaselineService.getStudentMotorBaseline());
 *   - never activates anything in the live child-facing progression gate —
 *     a student_threshold_history row is provenance/history only until a
 *     future, separate step wires it into getStudentThreshold();
 *   - Step 5's evaluateDynamicThresholds() never inserts an 'automatic'
 *     ThresholdHistory row, never has a "lower" decision for a family
 *     threshold, and never touches the legacy per-letter auto-raise/
 *     auto-lower system in handwritingController.recordLetterCompletion —
 *     it only computes and returns what the system WOULD recommend. These
 *     are pilot rule-based adaptive-progression recommendations, not
 *     clinical decisions — the 5-attempt window, the 4-of-5 raise rule, and
 *     the +5 increment are pilot engineering defaults requiring later
 *     teacher/pilot validation, exactly like INITIAL_THRESHOLD_MARGIN above.
 *
 * Source of truth for baseline values: StudentMotorBaseline only, via the
 * existing motorBaselineService.getStudentMotorBaseline() — never
 * HandwritingAssessment, never frontend motor_profile, never
 * StudentMotorFeature/ShapeFeature, never current performance, never
 * students.personal_thresholds. Family scores only
 * (straight_score/curved_score/complex_score) — overall_motor_score is
 * deliberately ignored for this derivation (it may still be useful for
 * reporting elsewhere, but must not determine one family's target).
 *
 * Formula (pilot engineering default, NOT clinically validated):
 *   rawTarget = baselineFamilyScore + margin
 *
 * No ceiling is inherited from the legacy per-letter system (its 85 cap has
 * no established relevance to a family-level target — see the Feature 2
 * audit). The only bound enforced here is the score space itself (0-100):
 * a computed target above 100 is flagged 'requires_review', never silently
 * clamped, and never persisted — see createInitialFamilyThresholds().
 */

const { Op } = require('sequelize');
const crypto = require('crypto');
const { getStudentMotorBaseline } = require('./motorBaselineService');
const { MAPPING_VERSION, getMappedLettersForFamily, getBaselineFamily } = require('../config/letterBaselineFamilies');
const { deriveAttemptPerformanceScore } = require('../utils/attemptPerformanceScore');
const { sequelize, ThresholdHistory, LetterAttempt, Student } = require('../models');
const logger = require('../utils/logger');

// Pilot engineering default — NOT clinically validated. Centralized here so
// it is never scattered as a bare "+5" magic number.
const INITIAL_THRESHOLD_MARGIN = 5;

const SCORE_MIN = 0;
const SCORE_MAX = 100;

// ─── Validation helpers (private) ──────────────────────────────────────────

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

// Same rationale as motorBaselineService.js: typeof-gated, never Number(value)
// coerced — a numeric string or other coercible value must never silently
// count as a real number here.
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// margin === 0 is deliberately ALLOWED: "target = baseline" is a legitimate
// pilot configuration (e.g. for comparing against an unmargined baseline),
// even though the +5 default is what's actually used in practice. Negative
// margins are rejected because a threshold below the immutable baseline
// would contradict the "target >= baseline" invariant this service exists
// to protect (see deriveFamilyThreshold below).
function isValidMargin(value) {
  return isFiniteNumber(value) && value >= 0;
}

function isValidBaselineScore(value) {
  return isFiniteNumber(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

// ─── Per-family derivation (pure) ───────────────────────────────────────────

/**
 * @param {*} baselineScore — assessment.motor_profile-derived family score,
 *   as persisted on StudentMotorBaseline (straight_score/curved_score/complex_score)
 * @param {number} margin — already validated by the caller
 * @returns {{
 *   baselineScore: number|null,
 *   margin: number,
 *   rawTarget: number|null,
 *   status: 'ready'|'requires_review'|'invalid_baseline_score'|'invalid_derivation',
 *   reason: string|null,
 * }}
 */
function deriveFamilyThreshold(baselineScore, margin) {
  if (!isValidBaselineScore(baselineScore)) {
    return {
      baselineScore: typeof baselineScore === 'number' ? baselineScore : null,
      margin,
      rawTarget: null,
      status: 'invalid_baseline_score',
      reason: 'baseline_score_invalid',
    };
  }

  const rawTarget = baselineScore + margin;

  // Defensive, not merely assumed: margin >= 0 already guarantees
  // rawTarget >= baselineScore mathematically, but the "initial target must
  // never fall below the immutable baseline" invariant is checked
  // explicitly, per the same "prove it" discipline used throughout this
  // feature rather than trusting arithmetic silently.
  if (rawTarget < baselineScore) {
    return { baselineScore, margin, rawTarget, status: 'invalid_derivation', reason: 'target_below_baseline' };
  }

  if (rawTarget > SCORE_MAX) {
    // Deliberately NOT clamped to 100 — flagged for explicit review instead,
    // so a deployable value is never silently fabricated. See module header.
    return { baselineScore, margin, rawTarget, status: 'requires_review', reason: 'target_exceeds_score_range' };
  }

  return { baselineScore, margin, rawTarget, status: 'ready', reason: null };
}

// ─── Main service function ─────────────────────────────────────────────────

/**
 * Derives (never persists) an initial per-family progression target for a
 * student, from their immutable Feature 1 baseline.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.margin=INITIAL_THRESHOLD_MARGIN]
 * @returns {Promise<{
 *   status: 'derived'|'invalid_input'|'invalid_margin'|'baseline_not_found'|'read_failed',
 *   studentId: number|null,
 *   baselineId: number|null,
 *   baselineVersion: string|null,
 *   mappingVersion: string,
 *   margin: number|null,
 *   thresholds: {straight: Object, curved: Object, complex: Object}|null,
 * }>}
 */
async function deriveInitialFamilyThresholds({ studentId, margin = INITIAL_THRESHOLD_MARGIN } = {}) {
  if (!isPositiveInteger(studentId)) {
    return {
      status: 'invalid_input', studentId: null, baselineId: null, baselineVersion: null,
      mappingVersion: MAPPING_VERSION, margin: null, thresholds: null,
    };
  }

  if (!isValidMargin(margin)) {
    return {
      status: 'invalid_margin', studentId, baselineId: null, baselineVersion: null,
      mappingVersion: MAPPING_VERSION, margin: null, thresholds: null,
    };
  }

  // Reuses the existing Feature 1 service directly — never the HTTP GET
  // endpoint, never a fresh query against StudentMotorBaseline written here.
  // One authoritative baseline lookup, one place its rules can change.
  const baselineResult = await getStudentMotorBaseline({ studentId });

  if (baselineResult.status !== 'found') {
    // Covers both baseline_not_found (no row exists — the expected common
    // case for most students today) and read_failed (an unexpected DB
    // error) — reported as distinct statuses rather than collapsed into one,
    // matching this project's existing "never hide a real failure behind a
    // not-found status" convention (see backfillMotorBaselines.js).
    const status = baselineResult.status === 'read_failed' ? 'read_failed' : 'baseline_not_found';
    return {
      status, studentId, baselineId: null, baselineVersion: null,
      mappingVersion: MAPPING_VERSION, margin, thresholds: null,
    };
  }

  const baseline = baselineResult.baseline;

  // Family scores only — overall_motor_score is intentionally never read here.
  const thresholds = {
    straight: deriveFamilyThreshold(baseline.straight_score, margin),
    curved:   deriveFamilyThreshold(baseline.curved_score, margin),
    complex:  deriveFamilyThreshold(baseline.complex_score, margin),
  };

  return {
    status: 'derived',
    studentId,
    baselineId: baseline.id,
    baselineVersion: baseline.baseline_version,
    mappingVersion: MAPPING_VERSION,
    margin,
    thresholds,
  };
}

// ─── Step 3: controlled persistence ─────────────────────────────────────────

const FAMILIES               = ['straight', 'curved', 'complex'];
const SCOPE_TYPE_FAMILY      = 'family';
const SOURCE_INITIAL         = 'initial_from_baseline';
const REASON_BASELINE_MARGIN = 'baseline_plus_margin';

/**
 * Read-only: derives thresholds AND checks student_threshold_history for an
 * existing initial_from_baseline row per family, producing a per-family
 * action ('would_create' | 'already_initialized' | 'skipped_requires_review'
 * | 'skipped_invalid_baseline') without writing anything. This is the single
 * shared decision logic used by BOTH the dry-run CLI (which must never call
 * the writing function at all) and createInitialFamilyThresholds() below —
 * "what would happen" is computed in exactly one place.
 *
 * Idempotency key: (student_id, scope_type='family', scope_key=family,
 * source='initial_from_baseline', baseline_id, mapping_version) — NOT
 * margin. Initialization is tied to a specific baseline + mapping version,
 * not freely re-runnable with a different margin (Step 3 Decision #12): a
 * later call with a different margin still resolves existing families to
 * 'already_initialized', never a second/overwriting event.
 *
 * @returns {Promise<{
 *   derivation: ReturnType<typeof deriveInitialFamilyThresholds> extends Promise<infer T> ? T : never,
 *   classification: {straight, curved, complex}|null,
 * }>}
 */
async function classifyFamilyInitialization({ studentId, margin = INITIAL_THRESHOLD_MARGIN } = {}) {
  const derivation = await deriveInitialFamilyThresholds({ studentId, margin });

  if (derivation.status !== 'derived') {
    return { derivation, classification: null };
  }

  const { baselineId, mappingVersion } = derivation;

  let existingRows;
  try {
    existingRows = await ThresholdHistory.findAll({
      where: {
        student_id:      studentId,
        scope_type:      SCOPE_TYPE_FAMILY,
        source:          SOURCE_INITIAL,
        baseline_id:     baselineId,
        mapping_version: mappingVersion,
      },
    });
  } catch (err) {
    logger.error('Initial family threshold lookup failed', { studentId, status: 'read_failed', errorMessage: err.message });
    return { derivation: { ...derivation, status: 'read_failed' }, classification: null };
  }
  const existingByFamily = new Map(existingRows.map(r => [r.scope_key, r]));

  const classification = {};
  for (const family of FAMILIES) {
    const familyResult = derivation.thresholds[family];
    const existing = existingByFamily.get(family);

    if (existing) {
      classification[family] = { action: 'already_initialized', historyId: existing.id, newThreshold: existing.new_threshold };
    } else if (familyResult.status === 'requires_review') {
      classification[family] = { action: 'skipped_requires_review', reason: familyResult.reason, rawTarget: familyResult.rawTarget };
    } else if (familyResult.status !== 'ready') {
      // invalid_baseline_score / invalid_derivation — never persisted.
      classification[family] = { action: 'skipped_invalid_baseline', reason: familyResult.reason };
    } else {
      classification[family] = { action: 'would_create', rawTarget: familyResult.rawTarget, baselineScore: familyResult.baselineScore };
    }
  }

  return { derivation, classification };
}

function summarizeTopLevelStatus(created) {
  const statuses = Object.values(created).map(c => c.status);
  if (statuses.some(s => s === 'created')) return 'created';
  if (statuses.some(s => s === 'save_failed')) return 'save_failed';
  if (statuses.every(s => s === 'already_initialized')) return 'already_initialized';
  return 'no_eligible_families';
}

/**
 * Persists initial family threshold history rows for a student, one per
 * eligible family, as auditable source='initial_from_baseline' events.
 *
 * Does NOT write students.personal_thresholds. Does NOT activate anything
 * in the live progression gate — getStudentThreshold() has no knowledge of
 * this table. Families are processed independently: one malformed/
 * requires_review family never blocks its siblings from being created.
 *
 * Idempotent: a family that already has an initial_from_baseline row for
 * this exact baseline_id + mapping_version is reported as
 * 'already_initialized', never duplicated, never overwritten — even if this
 * call was given a different margin than the original. DB-backed via a
 * partial unique index (student_threshold_history_initial_family_uniq, see
 * migrations/20260808000002-...) as the ultimate race-safety net, on top of
 * this function's own findAll-before-insert application-level guard.
 *
 * The eligible rows (only) are inserted inside one transaction — an
 * unexpected mid-batch DB failure rolls back rather than leaving e.g.
 * "straight created, curved failed" half-done. Families that were skipped
 * as ineligible (requires_review / invalid_baseline_score) or that already
 * existed are decided BEFORE the transaction opens and are not part of it.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.margin=INITIAL_THRESHOLD_MARGIN]
 * @returns {Promise<{
 *   status: 'created'|'already_initialized'|'no_eligible_families'|'save_failed'
 *           |'invalid_input'|'invalid_margin'|'baseline_not_found'|'read_failed',
 *   studentId: number|null,
 *   baselineId: number|null,
 *   baselineVersion: string|null,
 *   mappingVersion: string,
 *   margin: number|null,
 *   created: {straight: Object, curved: Object, complex: Object}|null,
 * }>}
 */
async function createInitialFamilyThresholds({ studentId, margin = INITIAL_THRESHOLD_MARGIN } = {}) {
  const { derivation, classification } = await classifyFamilyInitialization({ studentId, margin });

  if (derivation.status !== 'derived') {
    return {
      status: derivation.status, studentId: derivation.studentId, baselineId: null, baselineVersion: null,
      mappingVersion: derivation.mappingVersion, margin: derivation.margin, created: null,
    };
  }

  const { baselineId, baselineVersion, mappingVersion } = derivation;
  const created = {};
  const toInsert = [];

  for (const family of FAMILIES) {
    const c = classification[family];
    if (c.action === 'already_initialized') {
      created[family] = { status: 'already_initialized', historyId: c.historyId, newThreshold: c.newThreshold };
    } else if (c.action === 'skipped_requires_review') {
      created[family] = { status: 'skipped_requires_review', reason: c.reason };
    } else if (c.action === 'skipped_invalid_baseline') {
      created[family] = { status: 'skipped_invalid_baseline', reason: c.reason };
    } else { // 'would_create'
      toInsert.push({
        family,
        row: {
          student_id:       studentId,
          scope_type:       SCOPE_TYPE_FAMILY,
          scope_key:        family,
          baseline_family:  family,
          old_threshold:    null, // initial event — no prior value
          new_threshold:    c.rawTarget,
          source:           SOURCE_INITIAL,
          reason:           REASON_BASELINE_MARGIN,
          baseline_id:      baselineId,
          baseline_version: baselineVersion,
          mapping_version:  mappingVersion,
          recent_window_snapshot: null, // recent-window logic not implemented yet
        },
      });
    }
  }

  if (toInsert.length > 0) {
    try {
      const insertedRows = await sequelize.transaction(
        (t) => ThresholdHistory.bulkCreate(toInsert.map(item => item.row), { transaction: t })
      );
      insertedRows.forEach((row, i) => {
        created[toInsert[i].family] = { status: 'created', historyId: row.id, newThreshold: row.new_threshold };
      });
      logger.info('Initial family thresholds created', {
        studentId, baselineId, status: 'created', familiesCreated: toInsert.map(i => i.family).join(','),
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        // Race: another call initialized one or more of these families
        // between our findAll() check and this insert. Re-read and resolve
        // to already_initialized — never a duplicate, never a 500.
        const raceRows = await ThresholdHistory.findAll({
          where: {
            student_id: studentId, scope_type: SCOPE_TYPE_FAMILY, source: SOURCE_INITIAL,
            baseline_id: baselineId, mapping_version: mappingVersion,
          },
        });
        const raceByFamily = new Map(raceRows.map(r => [r.scope_key, r]));
        for (const item of toInsert) {
          const existing = raceByFamily.get(item.family);
          created[item.family] = existing
            ? { status: 'already_initialized', historyId: existing.id, newThreshold: existing.new_threshold }
            : { status: 'save_failed', reason: 'race_condition_unresolved' };
        }
        logger.info('Initial family threshold race resolved to already_initialized', { studentId, baselineId, status: 'already_initialized' });
      } else {
        logger.error('Initial family threshold creation failed', { studentId, baselineId, status: 'save_failed', errorMessage: err.message });
        for (const item of toInsert) created[item.family] = { status: 'save_failed', reason: null };
      }
    }
  }

  return {
    status: summarizeTopLevelStatus(created),
    studentId, baselineId, baselineVersion, mappingVersion, margin,
    created,
  };
}

// ─── Step 4: read-only recent independent performance window ──────────────
//
// Everything below is READ-ONLY. Nothing here writes to LetterAttempt,
// ThresholdHistory, StudentMotorBaseline, or Student — see
// tests/dynamicThresholdService.test.js's "read-only guarantee" test, which
// asserts none of create/bulkCreate/update/destroy/save/transaction are ever
// invoked by getRecentFamilyPerformance(). No threshold comparison/decision
// logic exists here either — this only surfaces "what recent independent
// attempts exist per family", nothing more. See Feature 2 Step 4.

// Pilot default (overridable) — same "explicit, centralized, not a scattered
// magic number" discipline as INITIAL_THRESHOLD_MARGIN. NOT clinically
// validated; chosen as a plausible small sample size for a first cut.
const RECENT_FAMILY_WINDOW_SIZE = 5;

// A "valid" candidate attempt for the recent-performance window is:
//   - attempt_number === 3        (the no-guide-in-normal-mode attempt —
//     the closest proxy this schema has to "independent" performance; see
//     module header / Step 4 audit for why 1 and 2 are support-assisted)
//   - collection_mode === false   (a fixed research-protocol capture is not
//     representative of normal independent practice — filtered at the query
//     level, never loaded)
//   - capture_status === 'complete' (incomplete/abandoned/network_failed
//     rows never had a full, real writing attempt behind them)
//   - letter/case_type maps to a REVIEWED (non-ambiguous) baseline family —
//     via getBaselineFamily()/getMappedLettersForFamily() only, never a
//     direct read of letterCategories.js/letterMotorPrimitives.js
// Deliberately NOT filtered on `passed` / `threshold_passed` — see module
// header: those are session-level values that would silently exclude
// legitimate independent-attempt data. A "failed but complete" attempt is
// still real independent performance data and belongs in the window.
const CANDIDATE_ATTEMPT_NUMBER = 3;
const CANDIDATE_CAPTURE_STATUS = 'complete';

function isValidWindowSize(value) {
  return isPositiveInteger(value);
}

/**
 * Builds the Sequelize Op.or clause matching every (letter, case_type) pair
 * mapped to one family. Returns null when the family has no reviewed
 * letters at all (defensive — not expected to happen for straight/curved/
 * complex today, but never assumed).
 */
function buildFamilyLetterClause(family) {
  const pairs = getMappedLettersForFamily(family);
  if (pairs.length === 0) return null;
  return { [Op.or]: pairs.map(p => ({ letter: p.letter, case_type: p.caseType })) };
}

/**
 * Fetches every candidate attempt-3 row for one family (no DB-side LIMIT —
 * see Step 4 Decision: with 774 total letter_attempts rows across the whole
 * system today, correctness (never truncating a family's real history
 * before dedup/validity filtering completes) is preferred over a premature
 * pagination optimization that isn't yet justified by data volume. If this
 * table grows dramatically, a future step should reconsider this), then
 * walks results NEWEST FIRST (created_at DESC, id DESC — id as the
 * deterministic tiebreaker: live data confirms rows from the same
 * bulkCreate() call frequently share an identical created_at timestamp, see
 * Step 4 live audit), taking the first `windowSize` that are both a) not a
 * duplicate session_key already counted for this family and b) yield a
 * valid reconstructed score. Malformed/duplicate rows encountered before the
 * window fills are counted; rows never reached because the window already
 * filled are not examined (nothing "recent" would be gained by looking
 * further back once windowSize is satisfied).
 */
async function fetchFamilyWindow(studentId, family, windowSize) {
  const letterClause = buildFamilyLetterClause(family);
  if (!letterClause) {
    return { count: 0, windowComplete: false, attempts: [], malformedCount: 0, duplicateCount: 0 };
  }

  const rows = await LetterAttempt.findAll({
    where: {
      student_id: studentId,
      attempt_number: CANDIDATE_ATTEMPT_NUMBER,
      collection_mode: false,
      capture_status: CANDIDATE_CAPTURE_STATUS,
      ...letterClause,
    },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });

  const seenSessionKeys = new Set();
  const attempts = [];
  let malformedCount = 0;
  let duplicateCount = 0;

  for (const row of rows) {
    if (attempts.length >= windowSize) break;

    if (seenSessionKeys.has(row.session_key)) {
      duplicateCount++;
      continue;
    }
    seenSessionKeys.add(row.session_key);

    const scoreResult = deriveAttemptPerformanceScore(row);
    if (scoreResult.status !== 'valid') {
      malformedCount++;
      continue;
    }

    attempts.push({
      attemptId: row.id,
      sessionKey: row.session_key,
      letter: row.letter,
      caseType: row.case_type,
      family,
      attemptNumber: row.attempt_number,
      performanceScore: scoreResult.score,
      thresholdPassed: row.threshold_passed,
      createdAt: row.created_at,
    });
  }

  return {
    count: attempts.length,
    windowComplete: attempts.length >= windowSize,
    attempts,
    malformedCount,
    duplicateCount,
  };
}

/**
 * Student-wide count of attempt-3, non-collection, complete rows whose
 * (letter, case_type) has no REVIEWED family mapping at all — i.e. rows
 * that never entered ANY family's candidate pool. Family-independent by
 * construction (a letter maps to at most one family), so computed once
 * rather than duplicated per family.
 */
async function countUnmappedLetterAttempts(studentId) {
  const allMappedPairs = [
    ...getMappedLettersForFamily('straight'),
    ...getMappedLettersForFamily('curved'),
    ...getMappedLettersForFamily('complex'),
  ];

  const baseWhere = {
    student_id: studentId,
    attempt_number: CANDIDATE_ATTEMPT_NUMBER,
    collection_mode: false,
    capture_status: CANDIDATE_CAPTURE_STATUS,
  };

  const totalCandidates = await LetterAttempt.count({ where: baseWhere });
  if (allMappedPairs.length === 0) return totalCandidates;

  const mappedCandidates = await LetterAttempt.count({
    where: {
      ...baseWhere,
      [Op.or]: allMappedPairs.map(p => ({ letter: p.letter, case_type: p.caseType })),
    },
  });

  return totalCandidates - mappedCandidates;
}

/**
 * Reads (never writes) the most recent independent-performance window for a
 * student, per baseline family, straight/curved/complex kept fully
 * independent — a full window in one family and an empty window in another
 * is expected and normal, not an error.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.windowSize=RECENT_FAMILY_WINDOW_SIZE]
 * @returns {Promise<{
 *   status: 'found'|'invalid_input'|'invalid_window_size'|'read_failed',
 *   studentId: number|null,
 *   mappingVersion: string,
 *   windowSize: number|null,
 *   families: {straight: Object, curved: Object, complex: Object}|null,
 *   exclusions: Object|null,
 * }>}
 */
async function getRecentFamilyPerformance({ studentId, windowSize = RECENT_FAMILY_WINDOW_SIZE } = {}) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, mappingVersion: MAPPING_VERSION, windowSize: null, families: null, exclusions: null };
  }
  if (!isValidWindowSize(windowSize)) {
    return { status: 'invalid_window_size', studentId, mappingVersion: MAPPING_VERSION, windowSize: null, families: null, exclusions: null };
  }

  let straightWindow, curvedWindow, complexWindow;
  try {
    [straightWindow, curvedWindow, complexWindow] = await Promise.all([
      fetchFamilyWindow(studentId, 'straight', windowSize),
      fetchFamilyWindow(studentId, 'curved', windowSize),
      fetchFamilyWindow(studentId, 'complex', windowSize),
    ]);
  } catch (err) {
    logger.error('Recent family performance window lookup failed', { studentId, status: 'read_failed', errorMessage: err.message });
    return { status: 'read_failed', studentId, mappingVersion: MAPPING_VERSION, windowSize, families: null, exclusions: null };
  }

  // Global, family-independent exclusion counts — best-effort/non-fatal: a
  // failure here must not invalidate the windows already computed above.
  let collectionModeExcluded = null, nonThirdAttemptExcluded = null,
      invalidCaptureStatusExcluded = null, unmappedLetterExcluded = null;
  try {
    [collectionModeExcluded, nonThirdAttemptExcluded, invalidCaptureStatusExcluded, unmappedLetterExcluded] = await Promise.all([
      LetterAttempt.count({ where: { student_id: studentId, attempt_number: CANDIDATE_ATTEMPT_NUMBER, collection_mode: true } }),
      LetterAttempt.count({ where: { student_id: studentId, attempt_number: { [Op.in]: [1, 2] }, collection_mode: false } }),
      LetterAttempt.count({ where: { student_id: studentId, attempt_number: CANDIDATE_ATTEMPT_NUMBER, collection_mode: false, capture_status: { [Op.ne]: CANDIDATE_CAPTURE_STATUS } } }),
      countUnmappedLetterAttempts(studentId),
    ]);
  } catch (err) {
    logger.error('Recent family performance exclusion-count lookup failed', { studentId, errorMessage: err.message });
  }

  return {
    status: 'found',
    studentId,
    mappingVersion: MAPPING_VERSION,
    windowSize,
    families: {
      straight: { count: straightWindow.count, windowComplete: straightWindow.windowComplete, attempts: straightWindow.attempts },
      curved:   { count: curvedWindow.count,   windowComplete: curvedWindow.windowComplete,   attempts: curvedWindow.attempts },
      complex:  { count: complexWindow.count,  windowComplete: complexWindow.windowComplete,  attempts: complexWindow.attempts },
    },
    exclusions: {
      collectionMode:       collectionModeExcluded,
      nonThirdAttempt:      nonThirdAttemptExcluded,
      invalidCaptureStatus: invalidCaptureStatusExcluded,
      unmappedLetter:       unmappedLetterExcluded,
      malformedFeatures:    straightWindow.malformedCount + curvedWindow.malformedCount + complexWindow.malformedCount,
      duplicateSession:     straightWindow.duplicateCount + curvedWindow.duplicateCount + complexWindow.duplicateCount,
    },
  };
}

// ─── Step 5: read-only dynamic threshold decision evaluation ──────────────
//
// Everything below is READ-ONLY / DECISION SIMULATION ONLY. Nothing here
// writes to ThresholdHistory, Student, LetterAttempt, or StudentMotorBaseline
// — see tests/dynamicThresholdService.test.js's Step 5 read-only guarantee
// test. No 'automatic' history row is ever inserted, students.
// personal_thresholds is never touched, and there is deliberately NO
// "lower" decision for a family threshold in this MVP (the pre-existing
// legacy per-letter auto-lower system in handwritingController.
// recordLetterCompletion is untouched and not merged with this system).

// Pilot engineering default — NOT clinically validated. Same "explicit,
// centralized, never a scattered magic number" discipline as
// INITIAL_THRESHOLD_MARGIN.
const THRESHOLD_INCREASE_STEP = 5;

// Current accepted target-setting sources for a Feature 2 FAMILY-scoped
// decision. 'legacy' exists in ThresholdHistory's own SOURCE_VALUES enum
// but is deliberately excluded here: nothing in this codebase currently
// writes a 'legacy' row (confirmed by inspection — the enum value has no
// producer yet), and the legacy per-letter auto-raise/auto-lower system it
// would presumably represent uses students.personal_thresholds with
// per-letter/default scope, not family scope — there is no evidence today
// that a future 'legacy' row would even be family-scoped. Revisit this list
// only once a real 'legacy' backfill/producer exists and its scope is known.
const VALID_TARGET_SOURCES = ['initial_from_baseline', 'automatic', 'teacher_override'];

const DECISION_NO_TARGET             = 'no_target';
const DECISION_INSUFFICIENT_DATA     = 'insufficient_data';
const DECISION_RAISE                 = 'raise';
const DECISION_RAISE_REQUIRES_REVIEW = 'raise_requires_review';
const DECISION_HOLD                  = 'hold';
const DECISION_SUPPORT_REVIEW        = 'support_review';

const REASON_TARGET_NOT_INITIALIZED     = 'target_not_initialized';
const REASON_INSUFFICIENT_WINDOW        = 'insufficient_window';
const REASON_4_OR_5_MET_TARGET          = '4_or_5_met_target';
const REASON_2_OR_3_MET_TARGET          = '2_or_3_met_target';
const REASON_0_OR_1_MET_TARGET          = '0_or_1_met_target';
const REASON_PROPOSED_EXCEEDS_RANGE     = 'proposed_target_exceeds_score_range';

/**
 * Reads (never writes) the CURRENT Feature 2 family target for a student —
 * the most recent valid target-setting event in student_threshold_history,
 * NOT students.personal_thresholds and NOT the legacy default (55).
 *
 * "Current" means the LATEST event (created_at DESC, id DESC), never the
 * maximum numeric value — a future teacher_override that intentionally
 * lowers a target must still be treated as current the moment it's the
 * newest row. This lookup is already compatible with a future
 * initial -> automatic -> teacher_override history chain (Step 6) without
 * any change needed here.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.family — 'straight'|'curved'|'complex'
 * @returns {Promise<{
 *   status: 'found'|'no_target'|'invalid_input'|'invalid_family'|'read_failed',
 *   studentId: number|null,
 *   family: string|null,
 *   currentThreshold: number|null,
 *   sourceEvent: {historyId: number, source: string, reason: string, createdAt: Date,
 *                 baselineId: number|null, baselineVersion: string|null, mappingVersion: string|null}|null,
 * }>}
 */
async function getCurrentFamilyThreshold({ studentId, family } = {}) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, family: family ?? null, currentThreshold: null, sourceEvent: null };
  }
  if (!FAMILIES.includes(family)) {
    return { status: 'invalid_family', studentId, family: null, currentThreshold: null, sourceEvent: null };
  }

  let row;
  try {
    row = await ThresholdHistory.findOne({
      where: {
        student_id:      studentId,
        scope_type:      SCOPE_TYPE_FAMILY,
        scope_key:       family,
        baseline_family: family,
        source:          { [Op.in]: VALID_TARGET_SOURCES },
      },
      order: [['created_at', 'DESC'], ['id', 'DESC']],
    });
  } catch (err) {
    logger.error('Current family threshold lookup failed', { studentId, family, status: 'read_failed', errorMessage: err.message });
    return { status: 'read_failed', studentId, family, currentThreshold: null, sourceEvent: null };
  }

  if (!row) {
    return { status: 'no_target', studentId, family, currentThreshold: null, sourceEvent: null };
  }

  return {
    status: 'found',
    studentId,
    family,
    currentThreshold: row.new_threshold,
    sourceEvent: {
      historyId: row.id, source: row.source, reason: row.reason, createdAt: row.created_at,
      // Baseline lineage carried on THIS row already — Step 6A reuses these
      // directly to propagate provenance onto a new teacher_override row
      // without a second baseline read (see setTeacherFamilyThreshold()).
      baselineId: row.baseline_id, baselineVersion: row.baseline_version, mappingVersion: row.mapping_version,
    },
  };
}

/**
 * Builds one family's decision-simulation result from its current target
 * (already resolved) and its recent-performance window (already resolved by
 * getRecentFamilyPerformance() — see Step 4, never re-queried here).
 *
 * Decision vocabulary: no_target | insufficient_data | raise |
 * raise_requires_review | hold | support_review. There is deliberately no
 * "lower" outcome anywhere in this function.
 */
function evaluateFamilyDecision(family, targetResult, windowResult, increaseStep) {
  const scores = windowResult.attempts.map(a => a.performanceScore);

  if (targetResult.status !== 'found') {
    return {
      family,
      currentThreshold: null,
      window: { count: windowResult.count, complete: windowResult.windowComplete },
      scores,
      metTargetCount: null,
      decision: DECISION_NO_TARGET,
      rawRecommendedThreshold: null,
      recommendedThreshold: null,
      requiresReview: false,
      reason: REASON_TARGET_NOT_INITIALIZED,
      attemptEvaluations: [],
    };
  }

  const currentThreshold = targetResult.currentThreshold;

  // Diagnostic per-attempt view — a derived comparison, never a mutation of
  // Step 4's stored attempt/window data.
  const attemptEvaluations = windowResult.attempts.map(a => ({
    attemptId:         a.attemptId,
    letter:            a.letter,
    caseType:          a.caseType,
    performanceScore:  a.performanceScore,
    targetAtEvaluation: currentThreshold,
    metTarget:         a.performanceScore >= currentThreshold, // >= , not > — 88 meets an 88 target
  }));

  if (!windowResult.windowComplete) {
    // A short window is NEVER interpreted as failure — see module header.
    // metTargetCount stays null (it must not drive any decision here); the
    // count of currently-met attempts is still exposed, but only as
    // diagnostic metadata, under a clearly different field name.
    return {
      family,
      currentThreshold,
      window: { count: windowResult.count, complete: false },
      scores,
      metTargetCount: null,
      diagnosticMetTargetCount: attemptEvaluations.filter(e => e.metTarget).length,
      decision: DECISION_INSUFFICIENT_DATA,
      rawRecommendedThreshold: currentThreshold,
      recommendedThreshold: currentThreshold,
      requiresReview: false,
      reason: REASON_INSUFFICIENT_WINDOW,
      attemptEvaluations,
    };
  }

  // Complete window (count === windowSize, per getRecentFamilyPerformance).
  const metTargetCount = attemptEvaluations.filter(e => e.metTarget).length;

  if (metTargetCount >= 4) {
    const rawRecommendedThreshold = currentThreshold + increaseStep;
    if (rawRecommendedThreshold > SCORE_MAX) {
      // Deliberately NOT clamped to 100 — same discipline as
      // deriveFamilyThreshold() in Step 2. A deployable value is never
      // silently fabricated; this is flagged for explicit review instead.
      return {
        family, currentThreshold,
        window: { count: windowResult.count, complete: true },
        scores, metTargetCount,
        decision: DECISION_RAISE_REQUIRES_REVIEW,
        rawRecommendedThreshold,
        recommendedThreshold: null,
        requiresReview: true,
        reason: REASON_PROPOSED_EXCEEDS_RANGE,
        attemptEvaluations,
      };
    }
    return {
      family, currentThreshold,
      window: { count: windowResult.count, complete: true },
      scores, metTargetCount,
      decision: DECISION_RAISE,
      rawRecommendedThreshold,
      recommendedThreshold: rawRecommendedThreshold,
      requiresReview: false,
      reason: REASON_4_OR_5_MET_TARGET,
      attemptEvaluations,
    };
  }

  if (metTargetCount >= 2) {
    return {
      family, currentThreshold,
      window: { count: windowResult.count, complete: true },
      scores, metTargetCount,
      decision: DECISION_HOLD,
      rawRecommendedThreshold: currentThreshold,
      recommendedThreshold: currentThreshold,
      requiresReview: false,
      reason: REASON_2_OR_3_MET_TARGET,
      attemptEvaluations,
    };
  }

  // metTargetCount is 0 or 1. NEVER a threshold decrease — the current
  // target stays fixed; a future, separate support/pre-writing system may
  // react to support_review, but that integration is explicitly out of
  // scope here (see module header / Step 5 scope).
  return {
    family, currentThreshold,
    window: { count: windowResult.count, complete: true },
    scores, metTargetCount,
    decision: DECISION_SUPPORT_REVIEW,
    rawRecommendedThreshold: currentThreshold,
    recommendedThreshold: currentThreshold,
    requiresReview: false,
    reason: REASON_0_OR_1_MET_TARGET,
    attemptEvaluations,
  };
}

/**
 * Read-only decision SIMULATION for a student across all three baseline
 * families: current target + recent independent performance window ->
 * decision. Persists nothing — see module header.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.windowSize=RECENT_FAMILY_WINDOW_SIZE]
 * @param {number} [params.increaseStep=THRESHOLD_INCREASE_STEP]
 * @returns {Promise<{
 *   status: 'evaluated'|'invalid_input'|'invalid_window_size'|'invalid_increase_step'|'read_failed',
 *   studentId: number|null,
 *   mappingVersion: string|null,
 *   windowSize: number|null,
 *   increaseStep: number|null,
 *   families: {straight: Object, curved: Object, complex: Object}|null,
 * }>}
 */
async function evaluateDynamicThresholds({
  studentId, windowSize = RECENT_FAMILY_WINDOW_SIZE, increaseStep = THRESHOLD_INCREASE_STEP,
} = {}) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, mappingVersion: null, windowSize: null, increaseStep: null, families: null };
  }
  if (!isValidWindowSize(windowSize)) {
    return { status: 'invalid_window_size', studentId, mappingVersion: null, windowSize: null, increaseStep: null, families: null };
  }
  // Same rule as INITIAL_THRESHOLD_MARGIN: 0 is a legitimate pilot value
  // (compare recommendations with no increment applied); negative/non-finite
  // is rejected. isValidMargin() already implements exactly this rule.
  if (!isValidMargin(increaseStep)) {
    return { status: 'invalid_increase_step', studentId, mappingVersion: null, windowSize, increaseStep: null, families: null };
  }

  let straightTarget, curvedTarget, complexTarget;
  try {
    [straightTarget, curvedTarget, complexTarget] = await Promise.all([
      getCurrentFamilyThreshold({ studentId, family: 'straight' }),
      getCurrentFamilyThreshold({ studentId, family: 'curved' }),
      getCurrentFamilyThreshold({ studentId, family: 'complex' }),
    ]);
  } catch (err) {
    logger.error('Dynamic threshold evaluation target lookup failed', { studentId, status: 'read_failed', errorMessage: err.message });
    return { status: 'read_failed', studentId, mappingVersion: MAPPING_VERSION, windowSize, increaseStep, families: null };
  }

  // A genuine DB error must never be silently reported as "no target" — see
  // getCurrentFamilyThreshold()'s distinct 'read_failed' status.
  if ([straightTarget, curvedTarget, complexTarget].some(t => t.status === 'read_failed')) {
    return { status: 'read_failed', studentId, mappingVersion: MAPPING_VERSION, windowSize, increaseStep, families: null };
  }

  // Reuses Step 4's getRecentFamilyPerformance() directly — Step 4 remains
  // the single, authoritative source for "what counts as a valid
  // independent attempt". No second performance query, no re-filtering.
  const performanceResult = await getRecentFamilyPerformance({ studentId, windowSize });
  if (performanceResult.status !== 'found') {
    return { status: performanceResult.status, studentId, mappingVersion: MAPPING_VERSION, windowSize, increaseStep, families: null };
  }

  const families = {
    straight: evaluateFamilyDecision('straight', straightTarget, performanceResult.families.straight, increaseStep),
    curved:   evaluateFamilyDecision('curved',   curvedTarget,   performanceResult.families.curved,   increaseStep),
    complex:  evaluateFamilyDecision('complex',  complexTarget,  performanceResult.families.complex,  increaseStep),
  };

  return {
    status: 'evaluated',
    studentId,
    mappingVersion: performanceResult.mappingVersion,
    windowSize,
    increaseStep,
    families,
  };
}

// ─── Step 6A: teacher override provenance + automatic-overwrite protection ─
//
// setTeacherFamilyThreshold() IS a real write — the one write function in
// this module that is not read-only/simulation-only. It never touches
// students.personal_thresholds (the legacy per-letter endpoint's own table
// column — see teacherService.setThreshold, completely untouched by this
// step) and never touches StudentMotorBaseline. It inserts exactly one
// append-only student_threshold_history row per call — no uniqueness
// constraint applies to source='teacher_override' (see migrations/
// 20260808000002-...), so a teacher may override a family's target multiple
// times; every event is preserved, "current" is simply the latest one (see
// getCurrentFamilyThreshold above, already proven compatible with this).
//
// getFamilyThresholdProtection() is READ-ONLY and is not called anywhere in
// this module yet — it exists for a FUTURE automatic-persistence step to
// consult before writing an 'automatic' row. No automatic writes exist in
// this codebase at all yet.

const SOURCE_TEACHER_OVERRIDE = 'teacher_override';
const REASON_TEACHER_OVERRIDE = 'teacher_override';

/**
 * Creates an append-only teacher_override ThresholdHistory event for one
 * student/family, changing the CURRENT Feature 2 family target. This is a
 * human supervisory adjustment to a pilot adaptive-learning target, not a
 * clinical decision.
 *
 * Deliberately does NOT accept a free-form note/reason parameter: the
 * persisted `reason` column is always the fixed string 'teacher_override' —
 * see module header / Step 6A scope ("no free-form note persisted in this
 * step"). Accepting a parameter that would be silently discarded seemed
 * worse than simply not offering it yet; a real note field can be added
 * later as a deliberate, reviewed schema change if actually needed.
 *
 * Ownership: re-runs the exact same `Student.findOne({where:{sid,
 * teacher_id}})` check already used independently by every function in
 * teacherService.js (setThreshold, setAvatar, startSession, endSession all
 * repeat this identical inline check rather than sharing a helper — this
 * follows that same established, already-repeated convention) rather than
 * importing teacherService here, which would introduce a new cross-service
 * dependency and would throw ApiError from inside a module whose entire
 * existing contract (Steps 2-5) is "always return a status object, never
 * throw" — callers (the controller) map statuses to HTTP responses instead.
 *
 * Does NOT allow creating a target with no baseline provenance: if no
 * current Feature 2 family target exists yet, returns
 * 'threshold_not_initialized' and inserts nothing — a teacher override
 * changes an initialized target, it does not silently originate one.
 *
 * @param {Object} params
 * @param {number} params.teacherId
 * @param {number} params.studentId
 * @param {string} params.family — 'straight'|'curved'|'complex'
 * @param {number} params.value — 0-100 inclusive
 * @returns {Promise<{
 *   status: 'updated'|'invalid_input'|'invalid_family'|'invalid_value'
 *           |'student_not_found'|'threshold_not_initialized'|'read_failed'|'save_failed',
 *   studentId: number|null,
 *   family: string|null,
 *   oldThreshold: number|null,
 *   newThreshold: number|null,
 *   source: string|null,
 *   historyId: number|null,
 * }>}
 */
async function setTeacherFamilyThreshold({ teacherId, studentId, family, value } = {}) {
  const empty = { studentId: null, family: null, oldThreshold: null, newThreshold: null, source: null, historyId: null };

  if (!isPositiveInteger(teacherId)) {
    return { status: 'invalid_input', ...empty };
  }
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', ...empty };
  }
  if (!FAMILIES.includes(family)) {
    return { status: 'invalid_family', ...empty, studentId };
  }
  // Feature 2 family overrides use the full 0-100 score range — the legacy
  // per-letter system's 20-85 auto-adjustment bounds (recordLetterCompletion)
  // do not apply here; see module header / Step 6 Decision.
  if (!isFiniteNumber(value) || value < SCORE_MIN || value > SCORE_MAX) {
    return { status: 'invalid_value', ...empty, studentId, family };
  }

  let student;
  try {
    student = await Student.findOne({ where: { sid: studentId, teacher_id: teacherId }, attributes: ['sid'] });
  } catch (err) {
    logger.error('Teacher family threshold ownership check failed', { teacherId, studentId, family, status: 'read_failed', errorMessage: err.message });
    return { status: 'read_failed', ...empty, studentId, family };
  }
  if (!student) {
    // Never reveals whether another teacher owns this student — identical
    // "not found" outcome either way, matching teacherService.js's own
    // existing convention throughout (setThreshold, setAvatar, etc.).
    return { status: 'student_not_found', ...empty, studentId, family };
  }

  // Reuses Step 5's lookup directly — no second/duplicated current-target query.
  const currentResult = await getCurrentFamilyThreshold({ studentId, family });
  if (currentResult.status === 'read_failed') {
    return { status: 'read_failed', ...empty, studentId, family };
  }
  if (currentResult.status !== 'found') {
    // 'no_target' — an override must change an initialized target, never
    // silently originate one with no baseline provenance behind it.
    return { status: 'threshold_not_initialized', ...empty, studentId, family };
  }

  const oldThreshold = currentResult.currentThreshold;
  const { baselineId, baselineVersion, mappingVersion } = currentResult.sourceEvent;

  let created;
  try {
    created = await ThresholdHistory.create({
      student_id:       studentId,
      scope_type:       SCOPE_TYPE_FAMILY,
      scope_key:        family,
      baseline_family:  family,
      old_threshold:    oldThreshold,
      new_threshold:    value,
      source:           SOURCE_TEACHER_OVERRIDE,
      reason:           REASON_TEACHER_OVERRIDE,
      baseline_id:      baselineId,
      baseline_version: baselineVersion,
      mapping_version:  mappingVersion,
      recent_window_snapshot: null, // a human decision, not an algorithmic one — see module header
    });
  } catch (err) {
    logger.error('Teacher family threshold override save failed', { teacherId, studentId, family, status: 'save_failed', errorMessage: err.message });
    return { status: 'save_failed', ...empty, studentId, family, oldThreshold };
  }

  logger.info('Teacher family threshold override created', {
    teacherId, studentId, family, status: 'updated', oldThreshold, newThreshold: value, historyId: created.id,
  });

  return {
    status: 'updated',
    studentId, family,
    oldThreshold, newThreshold: value,
    source: SOURCE_TEACHER_OVERRIDE,
    historyId: created.id,
  };
}

/**
 * READ-ONLY. Answers "is this family's current target protected from a
 * future automatic adjustment?" — for a future, separate automatic-
 * persistence step to consult before ever writing an 'automatic' row. Not
 * called anywhere yet; no automatic writes exist in this codebase.
 *
 * Rule: protected === true iff the CURRENT/LATEST target-setting event's
 * source is 'teacher_override' — never "has a teacher_override EVER
 * existed for this family" (that would permanently lock it forever, even
 * after a later 'automatic' event legitimately became current — see module
 * header / Step 6A Decision #16).
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.family
 * @returns {Promise<{
 *   status: 'found'|'no_target'|'invalid_input'|'invalid_family'|'read_failed',
 *   protected: boolean,
 *   reason: string|null,
 *   currentThreshold: number|null,
 *   historyId: number|null,
 * }>}
 */
async function getFamilyThresholdProtection({ studentId, family } = {}) {
  const currentResult = await getCurrentFamilyThreshold({ studentId, family });

  if (currentResult.status === 'invalid_input' || currentResult.status === 'invalid_family' || currentResult.status === 'read_failed') {
    return { status: currentResult.status, protected: false, reason: null, currentThreshold: null, historyId: null };
  }

  if (currentResult.status === 'no_target') {
    return { status: 'no_target', protected: false, reason: 'no_target', currentThreshold: null, historyId: null };
  }

  const isProtected = currentResult.sourceEvent.source === SOURCE_TEACHER_OVERRIDE;
  return {
    status: 'found',
    protected: isProtected,
    reason: isProtected ? 'latest_target_is_teacher_override' : null,
    currentThreshold: currentResult.currentThreshold,
    historyId: currentResult.sourceEvent.historyId,
  };
}

// ─── Step 6B: controlled automatic threshold persistence ───────────────────
//
// persistAutomaticThresholdDecisions() IS a real write — an append-only
// insert per eligible family, gated by teacher protection AND evidence-level
// idempotency. It still does not touch students.personal_thresholds, does
// not touch StudentMotorBaseline, and is never imported into
// handwritingController.js / recordLetterCompletion — the live child
// progression gate remains completely unaware of Feature 2 family targets.
// These are pilot rule-based adaptive-progression events, not clinical
// decisions — see module header.
//
// classifyAutomaticThresholdPersistence() is READ-ONLY and is the single
// shared decision logic used by BOTH the dry-run CLI and
// persistAutomaticThresholdDecisions() below — "what would happen" is
// computed in exactly one place, mirroring the exact classify/create split
// already proven in Step 3 (classifyFamilyInitialization /
// createInitialFamilyThresholds).

const SOURCE_AUTOMATIC = 'automatic';

/**
 * Deterministic evidence fingerprint for one family's raise decision —
 * ties an automatic write to the EXACT evidence it was based on (which
 * current-target history event, which attempt IDs, what window size, what
 * mapping version) so the same evidence can never produce two automatic
 * events. Attempt IDs are sorted before hashing so the fingerprint is
 * independent of whatever order the window happened to be walked in —
 * only the SET of evidence matters, not its incidental ordering. No
 * timestamp is included (a re-run against unchanged evidence must hash
 * identically). No raw feature/trajectory data, names, or tokens — IDs and
 * small integers only.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.family
 * @param {number} params.currentThresholdHistoryId
 * @param {number[]} params.attemptIds
 * @param {number} params.windowSize
 * @param {string} params.mappingVersion
 * @returns {string} 64-char sha256 hex digest
 */
function computeEvidenceFingerprint({ studentId, family, currentThresholdHistoryId, attemptIds, windowSize, mappingVersion }) {
  const sortedAttemptIds = [...attemptIds].sort((a, b) => a - b);
  const payload = JSON.stringify({
    studentId, family, currentThresholdHistoryId,
    attemptIds: sortedAttemptIds, windowSize, mappingVersion,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Classifies ONE family's automatic-persistence outcome. Read-only — never
 * inserts. Returns { action, reason, row?, evidenceFingerprint?, historyId?, newThreshold? }.
 *
 * action vocabulary:
 *   would_create | already_persisted | stale_decision | skipped_teacher_protected
 *   | skipped_requires_review | skipped_hold | skipped_support_review
 *   | skipped_insufficient_data | skipped_no_target | read_failed
 */
async function classifyOneFamilyForAutomaticPersistence({ studentId, family, familyDecision, windowSize, increaseStep }) {
  const { decision } = familyDecision;

  // Only 'raise' is eligible — every other decision is output-only (Sections 3, 17-20).
  if (decision === 'no_target')            return { action: 'skipped_no_target',         reason: REASON_TARGET_NOT_INITIALIZED };
  if (decision === 'insufficient_data')     return { action: 'skipped_insufficient_data', reason: familyDecision.reason };
  if (decision === 'hold')                  return { action: 'skipped_hold',              reason: familyDecision.reason };
  if (decision === 'support_review')        return { action: 'skipped_support_review',    reason: familyDecision.reason };
  if (decision === 'raise_requires_review') return { action: 'skipped_requires_review',   reason: familyDecision.reason };
  // decision === 'raise' is the only remaining case.

  // Step 1 (Section 4) — teacher-protection gate. Reuses Step 6A's helper
  // directly; never bypassed, even for a 'raise' decision.
  const protection = await getFamilyThresholdProtection({ studentId, family });
  if (protection.status === 'read_failed') {
    return { action: 'read_failed', reason: null };
  }
  if (protection.status !== 'found') {
    return { action: 'skipped_no_target', reason: REASON_TARGET_NOT_INITIALIZED };
  }
  if (protection.protected) {
    return { action: 'skipped_teacher_protected', reason: protection.reason };
  }

  // Step 2 (Section 5) — fresh re-read + staleness check. Protects against
  // the target changing (a teacher override, or another automatic run)
  // between evaluateDynamicThresholds() and this write attempt. A second
  // query is deliberate here, not an oversight — Sections 4 and 5 describe
  // two distinct sequential checks, and getFamilyThresholdProtection()'s
  // own return shape does not carry baseline/mapping provenance, which this
  // function still needs for the row it may build below.
  const freshCurrent = await getCurrentFamilyThreshold({ studentId, family });
  if (freshCurrent.status === 'read_failed') {
    return { action: 'read_failed', reason: null };
  }
  if (freshCurrent.status !== 'found') {
    return { action: 'skipped_no_target', reason: REASON_TARGET_NOT_INITIALIZED };
  }
  if (freshCurrent.currentThreshold !== familyDecision.currentThreshold) {
    return { action: 'stale_decision', reason: 'target_changed_since_evaluation' };
  }

  // Step 3 (Sections 9-11) — evidence fingerprint + idempotency check.
  const attemptIds = familyDecision.attemptEvaluations.map(a => a.attemptId);
  const evidenceFingerprint = computeEvidenceFingerprint({
    studentId, family,
    currentThresholdHistoryId: freshCurrent.sourceEvent.historyId,
    attemptIds, windowSize, mappingVersion: freshCurrent.sourceEvent.mappingVersion,
  });

  let existing;
  try {
    existing = await ThresholdHistory.findOne({
      where: {
        student_id: studentId, scope_type: SCOPE_TYPE_FAMILY, scope_key: family,
        source: SOURCE_AUTOMATIC, evidence_fingerprint: evidenceFingerprint,
      },
    });
  } catch (err) {
    logger.error('Automatic threshold evidence lookup failed', { studentId, family, status: 'read_failed', errorMessage: err.message });
    return { action: 'read_failed', reason: null };
  }
  if (existing) {
    return { action: 'already_persisted', reason: null, historyId: existing.id, newThreshold: existing.new_threshold };
  }

  // Step 4 (Sections 6-7) — build the row. IDs + scores only, no raw
  // trajectory/feature data, no names, no tokens.
  const recentWindowSnapshot = {
    windowSize,
    scores: familyDecision.scores,
    metTarget: familyDecision.attemptEvaluations.map(a => a.metTarget),
    metTargetCount: familyDecision.metTargetCount,
    evaluatedThreshold: familyDecision.currentThreshold,
    increaseStep,
    attemptIds,
  };

  const row = {
    student_id:       studentId,
    scope_type:       SCOPE_TYPE_FAMILY,
    scope_key:        family,
    baseline_family:  family,
    old_threshold:    familyDecision.currentThreshold,
    new_threshold:    familyDecision.recommendedThreshold,
    source:           SOURCE_AUTOMATIC,
    reason:           familyDecision.reason, // '4_or_5_met_target' — the evaluator's own stable vocabulary, never a new synonym
    baseline_id:      freshCurrent.sourceEvent.baselineId,
    baseline_version: freshCurrent.sourceEvent.baselineVersion,
    mapping_version:  freshCurrent.sourceEvent.mappingVersion,
    recent_window_snapshot: recentWindowSnapshot,
    evidence_fingerprint:   evidenceFingerprint,
  };

  return { action: 'would_create', reason: familyDecision.reason, row, evidenceFingerprint };
}

/**
 * Read-only classifier: evaluates current decisions for a student (reusing
 * evaluateDynamicThresholds() directly — no re-derivation of decision logic)
 * and reports, per family, exactly what persistAutomaticThresholdDecisions()
 * would do. Powers the dry-run CLI without ever writing.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.windowSize=RECENT_FAMILY_WINDOW_SIZE]
 * @param {number} [params.increaseStep=THRESHOLD_INCREASE_STEP]
 * @returns {Promise<{
 *   status: 'classified'|'invalid_input'|'invalid_window_size'|'invalid_increase_step'|'read_failed',
 *   studentId: number|null,
 *   mappingVersion: string|null,
 *   windowSize: number|null,
 *   increaseStep: number|null,
 *   families: {straight: Object, curved: Object, complex: Object}|null,
 * }>}
 */
async function classifyAutomaticThresholdPersistence({
  studentId, windowSize = RECENT_FAMILY_WINDOW_SIZE, increaseStep = THRESHOLD_INCREASE_STEP,
} = {}) {
  const evaluation = await evaluateDynamicThresholds({ studentId, windowSize, increaseStep });

  if (evaluation.status !== 'evaluated') {
    return {
      status: evaluation.status, studentId: evaluation.studentId ?? null,
      mappingVersion: null, windowSize: evaluation.windowSize ?? null, increaseStep: evaluation.increaseStep ?? null,
      families: null,
    };
  }

  const families = {};
  for (const family of FAMILIES) {
    families[family] = await classifyOneFamilyForAutomaticPersistence({
      studentId, family, familyDecision: evaluation.families[family], windowSize, increaseStep,
    });
  }

  return {
    status: 'classified',
    studentId,
    mappingVersion: evaluation.mappingVersion,
    windowSize,
    increaseStep,
    families,
  };
}

function summarizeAutomaticTopLevelStatus(results) {
  const statuses = Object.values(results).map(r => r.status);
  if (statuses.some(s => s === 'created')) return 'created';
  if (statuses.some(s => s === 'save_failed')) return 'save_failed';
  if (statuses.length > 0 && statuses.every(s => s === 'already_persisted')) return 'already_persisted';
  return 'no_eligible_families';
}

/**
 * Persists eligible 'raise' decisions as append-only 'automatic'
 * student_threshold_history events. Families that are ineligible (any
 * decision other than 'raise'), teacher-protected, stale, or already
 * persisted under identical evidence are never inserted — see
 * classifyOneFamilyForAutomaticPersistence() for the full per-family logic,
 * which is classified BEFORE the transaction opens (Section 16): only
 * families resolved to 'would_create' are included in the transactional
 * insert, so a logical skip in one family never blocks a real write in
 * another, and the transaction itself only ever contains genuine writes.
 *
 * Idempotent at the evidence level (Sections 9-11): the same 5 attempts +
 * the same current-target event can never produce two automatic rows, even
 * across repeated runs, even under a race (DB-backed via the partial unique
 * index — see migrations/20260808000003-...— on top of this function's own
 * findOne-before-insert application-level guard, exactly mirroring Step 3's
 * dual-layer idempotency design).
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {number} [params.windowSize=RECENT_FAMILY_WINDOW_SIZE]
 * @param {number} [params.increaseStep=THRESHOLD_INCREASE_STEP]
 * @returns {Promise<{
 *   status: 'created'|'already_persisted'|'no_eligible_families'|'save_failed'
 *           |'invalid_input'|'invalid_window_size'|'invalid_increase_step'|'read_failed',
 *   studentId: number|null,
 *   windowSize: number|null,
 *   increaseStep: number|null,
 *   families: {straight: Object, curved: Object, complex: Object}|null,
 * }>}
 */
async function persistAutomaticThresholdDecisions({
  studentId, windowSize = RECENT_FAMILY_WINDOW_SIZE, increaseStep = THRESHOLD_INCREASE_STEP,
} = {}) {
  const classification = await classifyAutomaticThresholdPersistence({ studentId, windowSize, increaseStep });

  if (classification.status !== 'classified') {
    return {
      status: classification.status, studentId: classification.studentId,
      windowSize: classification.windowSize, increaseStep: classification.increaseStep, families: null,
    };
  }

  const results = {};
  const toInsert = [];

  for (const family of FAMILIES) {
    const c = classification.families[family];
    if (c.action === 'would_create') {
      toInsert.push({ family, row: c.row, evidenceFingerprint: c.evidenceFingerprint });
    } else {
      results[family] = { status: c.action, reason: c.reason ?? null, historyId: c.historyId ?? null, newThreshold: c.newThreshold ?? null };
    }
  }

  if (toInsert.length > 0) {
    try {
      const insertedRows = await sequelize.transaction(
        (t) => ThresholdHistory.bulkCreate(toInsert.map(item => item.row), { transaction: t })
      );
      insertedRows.forEach((row, i) => {
        results[toInsert[i].family] = { status: 'created', historyId: row.id, oldThreshold: row.old_threshold, newThreshold: row.new_threshold };
      });
      logger.info('Automatic family thresholds created', {
        studentId, status: 'created', familiesCreated: toInsert.map(i => i.family).join(','),
      });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        // Race: another run persisted one or more of these exact evidence
        // fingerprints between our findOne() check and this insert.
        // Re-read and resolve to already_persisted — never a duplicate,
        // never a 500.
        for (const item of toInsert) {
          const existingRow = await ThresholdHistory.findOne({
            where: {
              student_id: studentId, scope_type: SCOPE_TYPE_FAMILY, scope_key: item.family,
              source: SOURCE_AUTOMATIC, evidence_fingerprint: item.evidenceFingerprint,
            },
          });
          results[item.family] = existingRow
            ? { status: 'already_persisted', historyId: existingRow.id, oldThreshold: existingRow.old_threshold, newThreshold: existingRow.new_threshold }
            : { status: 'save_failed', reason: 'race_condition_unresolved' };
        }
        logger.info('Automatic family threshold race resolved to already_persisted', { studentId, status: 'already_persisted' });
      } else {
        logger.error('Automatic family threshold creation failed', { studentId, status: 'save_failed', errorMessage: err.message });
        for (const item of toInsert) results[item.family] = { status: 'save_failed', reason: null, historyId: null, newThreshold: null };
      }
    }
  }

  return {
    status: summarizeAutomaticTopLevelStatus(results),
    studentId, windowSize, increaseStep,
    families: results,
  };
}

// ─── Step 8: final automatic orchestration (event-driven, from a completed
// letter session) ───────────────────────────────────────────────────────
//
// processDynamicThresholdAfterLetterSession() is the ONLY place a normal
// letter-completion request can trigger Feature 2 automatic persistence.
// It is deliberately a thin coordination layer — it does NOT duplicate any
// evaluator/persistence logic. It reuses persistAutomaticThresholdDecisions()
// (Step 6B) exactly as-is, whole-student (all three families), even though
// a single completed letter can only ever have changed ONE family's window.
//
// Section 7 Decision (documented inefficiency, accepted deliberately):
// evaluateDynamicThresholds()/persistAutomaticThresholdDecisions() have no
// single-family mode — adding one would mean modifying Step 5/6B's already
// proven, heavily-tested code paths for a marginal efficiency gain. This
// function instead accepts evaluating (and read-only-querying) all three
// families on every eligible completion, then reports only the ONE family
// relevant to the letter that was just completed. The other two families'
// evaluation is pure read-only overhead — it can only ever produce a skip
// for them (their own windows didn't change), never a spurious write,
// since persistAutomaticThresholdDecisions() is itself already fully
// family-independent and evidence-gated. Correctness over optimization,
// exactly as directed.
//
// Never called from anywhere except recordLetterCompletion, and never
// triggers a second evaluation itself (no event hooks, no recursion — an
// inserted 'automatic' ThresholdHistory row does not re-invoke this
// function). No setInterval/setTimeout/polling/cron exists here or
// anywhere in this pipeline — this is purely request-driven.
const DYNAMIC_THRESHOLD_STATUS_MAP = {
  created:                    'automatic_created',
  already_persisted:          'already_persisted',
  stale_decision:             'stale_decision',
  skipped_teacher_protected:  'teacher_protected',
  skipped_requires_review:    'raise_requires_review',
  skipped_hold:                'hold',
  skipped_support_review:      'support_review',
  skipped_insufficient_data:   'insufficient_data',
  skipped_no_target:           'not_applicable',
  save_failed:                 'error',
};

function mapFamilyResultToDynamicThresholdStatus(familyStatus) {
  return DYNAMIC_THRESHOLD_STATUS_MAP[familyStatus] ?? 'error';
}

/**
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.letter
 * @param {string} params.caseType
 * @param {string} [params.sessionKey] — logging/traceability only; this
 *   function does not need it functionally (persistAutomaticThresholdDecisions
 *   re-derives everything fresh from the DB, independent of any one session).
 * @param {boolean} params.hasAttempt3Evidence — Section 5: computed by the
 *   caller from the just-saved request's own `attempts` array
 *   (`attempts.some(a => a?.attempt_number === 3)`) — a cheap, local guard
 *   against firing a full evaluation for a request that could not possibly
 *   have changed any family's recent window. `getRecentFamilyPerformance`
 *   would itself safely no-op in that case too (defense in depth, not the
 *   only safety net).
 * @param {number|null} [params.requestedQualityThreshold] — Section 42: a
 *   non-null explicit request override means this session was gated under
 *   an experimental/non-standard threshold; it must never be allowed to
 *   contaminate Feature 2's evidence-based history.
 * @param {number} [params.windowSize=RECENT_FAMILY_WINDOW_SIZE]
 * @param {number} [params.increaseStep=THRESHOLD_INCREASE_STEP]
 * @returns {Promise<{
 *   status: 'skipped_request_override'|'not_applicable'|'insufficient_data'
 *           |'hold'|'support_review'|'raise_requires_review'|'teacher_protected'
 *           |'stale_decision'|'already_persisted'|'automatic_created'|'error',
 *   family: 'straight'|'curved'|'complex'|null,
 *   decision: string|null, // the raw persistAutomaticThresholdDecisions family status, for logging
 *   newThreshold: number|null,
 *   historyId: number|null,
 * }>}
 */
async function processDynamicThresholdAfterLetterSession({
  studentId, letter, caseType, sessionKey, hasAttempt3Evidence, requestedQualityThreshold,
  windowSize = RECENT_FAMILY_WINDOW_SIZE, increaseStep = THRESHOLD_INCREASE_STEP,
} = {}) {
  // Section 42 — checked first, before even determining the family: an
  // experimental request override taints the whole completion, regardless
  // of what letter/family was involved.
  if (requestedQualityThreshold != null) {
    return { status: 'skipped_request_override', family: null, decision: null, newThreshold: null, historyId: null };
  }

  if (!hasAttempt3Evidence) {
    return { status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null };
  }

  // Section 8/43/44 — ambiguous/unmapped letters (and, structurally,
  // collection-mode/incomplete-capture rows, which never reach this
  // function at all — see the controller integration) never trigger
  // Feature 2 adaptation. Legacy progression remains sufficient for them.
  const family = getBaselineFamily(letter, caseType);
  if (!family) {
    return { status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null };
  }

  let persistResult;
  try {
    persistResult = await persistAutomaticThresholdDecisions({ studentId, windowSize, increaseStep });
  } catch (err) {
    logger.error('Dynamic threshold orchestration failed unexpectedly', {
      studentId, sessionKey, letter, caseType, family, errorMessage: err.message,
    });
    return { status: 'error', family, decision: null, newThreshold: null, historyId: null };
  }

  if (persistResult.status === 'invalid_input' || persistResult.status === 'invalid_window_size'
      || persistResult.status === 'invalid_increase_step' || persistResult.status === 'read_failed') {
    logger.error('Dynamic threshold orchestration could not evaluate the student', {
      studentId, sessionKey, letter, caseType, family, status: persistResult.status,
    });
    return { status: 'error', family, decision: null, newThreshold: null, historyId: null };
  }

  const familyResult = persistResult.families?.[family];
  if (!familyResult) {
    logger.error('Dynamic threshold orchestration got an unexpected result shape', { studentId, sessionKey, letter, caseType, family });
    return { status: 'error', family, decision: null, newThreshold: null, historyId: null };
  }

  const dynamicThresholdStatus = mapFamilyResultToDynamicThresholdStatus(familyResult.status);
  const newThreshold = familyResult.status === 'created' ? familyResult.newThreshold : null;

  // Section 29 — structured, IDs-only logging. No names, no raw trajectories.
  logger.info('Dynamic threshold orchestration completed', {
    studentId, sessionKey, letter, caseType, family,
    previousThreshold: familyResult.oldThreshold ?? null,
    decision: familyResult.status,
    dynamicThresholdStatus,
    newThreshold,
    automaticHistoryId: familyResult.historyId ?? null,
  });

  return {
    status: dynamicThresholdStatus,
    family,
    decision: familyResult.status,
    newThreshold,
    historyId: familyResult.historyId ?? null,
  };
}

module.exports = {
  INITIAL_THRESHOLD_MARGIN,
  deriveInitialFamilyThresholds,
  classifyFamilyInitialization,
  createInitialFamilyThresholds,
  RECENT_FAMILY_WINDOW_SIZE,
  getRecentFamilyPerformance,
  THRESHOLD_INCREASE_STEP,
  getCurrentFamilyThreshold,
  evaluateDynamicThresholds,
  setTeacherFamilyThreshold,
  getFamilyThresholdProtection,
  computeEvidenceFingerprint,
  classifyAutomaticThresholdPersistence,
  persistAutomaticThresholdDecisions,
  processDynamicThresholdAfterLetterSession,
};
