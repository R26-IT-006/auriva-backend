'use strict';

/**
 * progressionThresholdResolver.js
 *
 * Feature 2 Step 7 — the FIRST place Feature 2 may affect the real child
 * progression gate (recordLetterCompletion). Pure, read-mostly resolution
 * layer: it never writes ThresholdHistory itself except via the one
 * documented lazy-repair call below, and never writes Student,
 * LetterAttempt, LetterProgress, or StudentMotorBaseline.
 *
 * ── Final workflow integration (removes legacy threshold dependence) ───────
 * A Feature 2 family threshold is a pilot personalised progression target
 * derived from the child's initial motor-family baseline and later
 * performance — not a diagnostic or clinical cutoff. As of this revision,
 * Feature 2 is the ONLY individualized threshold source a normal, properly
 * initialized student's progression gate ever consults. The legacy
 * per-letter/default tiers (students.personal_thresholds, via
 * thresholdUtils.getStudentThreshold's own 3-tier priority) have been
 * REMOVED from this resolution path entirely — they are no longer read
 * here at all, by any branch, for any student. See the "final integration"
 * audit for the full rationale: an individualized legacy threshold must
 * never be used as if it were Feature 2 for a modern student.
 *
 * Resolution priority (highest first):
 *   1. requestedQualityThreshold (explicit request override — unchanged;
 *      exists for tests/research tooling, never sent by the real frontend
 *      in normal child flow)
 *   2. Feature 2 current family threshold (only for a REVIEWED, non-
 *      ambiguous letter+case mapping) — lazily self-initialized from the
 *      student's existing baseline if it has never been initialized before
 *      (see the repair branch below); this is what makes the legacy tiers
 *      unnecessary rather than merely unused
 *   3. SAFE GLOBAL FALLBACK (a single documented constant) — used ONLY when
 *      Feature 2 genuinely cannot resolve a family threshold: an unmapped/
 *      ambiguous letter (no family exists for it at all), no baseline yet
 *      (student hasn't completed/finalized their initial assessment), a
 *      family score requiring manual review, or a genuine DB read failure.
 *      This is a safety net to keep a child from ever being blocked, never
 *      an individualized "legacy" value — it is the same constant for
 *      every student in every one of these situations.
 *
 * Never calls persistAutomaticThresholdDecisions or
 * setTeacherFamilyThreshold — Feature 2's ongoing dynamic re-evaluation
 * remains a separate, explicit, event-driven process
 * (processDynamicThresholdAfterLetterSession, triggered from
 * recordLetterCompletion after a session saves). This file's own only
 * write is the one-time INITIAL threshold creation, and only via the
 * already-idempotent createInitialFamilyThresholds() — never a duplicate
 * formula, never a bespoke write of its own.
 */

const { getBaselineFamily } = require('../config/letterBaselineFamilies');
const { getCurrentFamilyThreshold, createInitialFamilyThresholds } = require('./dynamicThresholdService');
const logger = require('../utils/logger');

// The one safe global fallback value — used only when Feature 2 genuinely
// cannot resolve a family threshold (see module header). Never presented
// as an individualized/legacy value; the same constant for every student.
const GLOBAL_DEFAULT = 55;

// ── Pilot mastery policy (Phase 2 + Phase 3) ────────────────────────────
// GLOBAL_DEFAULT above is UNCHANGED and still exported for its own callers.
// It is simply no longer what normal letter practice is judged against:
// at 55, 96.6% of real independent attempts passed, so it gated nothing.
const {
  NORMAL_PRACTICE_MASTERY_THRESHOLD,
  PROGRESSION_FAMILY_THRESHOLDS_ENABLED,
} = require('../config/masteryPolicy');

// A distinct, honestly-named source. NOT reported as `global_safe_fallback`,
// because it is not a fallback — it is the deliberate pilot policy value.
const SOURCE_NORMAL_PRACTICE_PILOT = 'normal_practice_pilot';

// Why the Feature 2 family branch was skipped, when it was.
const FALLBACK_REASON_FAMILY_DISABLED = 'progression_family_thresholds_disabled';

const SOURCE_REQUEST_OVERRIDE = 'request_override';
const SOURCE_FEATURE2_FAMILY = 'feature2_family';
// Replaces the old legacy_letter / legacy_default / global_default / read-
// error-specific source names — every non-Feature-2 resolution now reports
// this single, clearly-named source; `fallbackReason` (below) carries WHY.
const SOURCE_GLOBAL_SAFE_FALLBACK = 'global_safe_fallback';

const FALLBACK_REASON_UNMAPPED_FAMILY = 'unmapped_family';
const FALLBACK_REASON_NOT_YET_INITIALIZED = 'not_yet_initialized';
const FALLBACK_REASON_READ_ERROR = 'read_error';

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function resolved(threshold, source, family, historyId, fallbackReason = null) {
  return { status: 'resolved', threshold, source, family, historyId, fallbackReason };
}

/**
 * Attempts a ONE-TIME, idempotent, lazy Feature 2 initialization for a
 * student whose baseline predates automatic initialization at finalize
 * time (or whose earlier finalize-time attempt failed) — the "idempotent
 * repair check when resolving Feature 2 for an existing student" mechanism
 * (final integration audit §6). Safe to call on every request that reaches
 * it: createInitialFamilyThresholds() is itself idempotent (a family that
 * already has an initial event is reported 'already_initialized', never
 * duplicated), and once a family is successfully initialized this branch
 * is never reached again for it — getCurrentFamilyThreshold() will return
 * 'found' on every subsequent call instead. No baseline yet, or a
 * requires_review family score, safely no-ops here every time until the
 * underlying condition changes; that repeated no-op is a cheap read, never
 * a repeated write.
 *
 * @returns {Promise<{newThreshold: number, historyId: number}|null>} null
 *   if the repair did not produce a usable threshold for this family.
 */
async function attemptLazyFeature2Repair({ studentId, family }) {
  let repairResult;
  try {
    repairResult = await createInitialFamilyThresholds({ studentId });
  } catch (err) {
    logger.error('Feature 2 lazy repair threw unexpectedly during progression resolution', {
      studentId, family, errorMessage: err.message,
    });
    return null;
  }

  const familyResult = repairResult?.created?.[family];
  if (!familyResult) return null;
  if (familyResult.status !== 'created' && familyResult.status !== 'already_initialized') return null;

  logger.info('Feature 2 family threshold lazily initialized during progression resolution', {
    studentId, family, status: familyResult.status,
  });
  return { newThreshold: familyResult.newThreshold, historyId: familyResult.historyId };
}

/**
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.letter
 * @param {string} params.caseType — 'lowercase'|'uppercase'
 * @param {number|null|undefined} params.requestedQualityThreshold
 * @returns {Promise<{
 *   status: 'resolved'|'invalid_input',
 *   threshold: number|null,
 *   source: string|null,
 *   family: 'straight'|'curved'|'complex'|null,
 *   historyId: number|null,
 *   fallbackReason: string|null,
 * }>}
 */
async function resolveProgressionThreshold({ studentId, letter, caseType, requestedQualityThreshold } = {}) {
  // Priority 1 — checked FIRST, before any validation below, exactly
  // mirroring the original ternary's short-circuit, unchanged.
  if (typeof requestedQualityThreshold === 'number') {
    return resolved(requestedQualityThreshold, SOURCE_REQUEST_OVERRIDE, null, null);
  }

  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', threshold: null, source: null, family: null, historyId: null, fallbackReason: null };
  }

  // letter/caseType are NOT strictly validated here — the real caller
  // (recordLetterCompletion) already validates both before threshold
  // resolution is ever reached, and getBaselineFamily already degrades a
  // malformed letter/caseType to `null` (no mapping) gracefully rather
  // than throwing.
  const family = getBaselineFamily(letter, caseType);

  // Phase 2 — the operational link from StudentMotorBaseline.progression_*
  // to mastery gating is disabled for the pilot. Baselines and threshold
  // history are still written, still readable, and still preserved with
  // full provenance; they simply do not decide what a child is judged
  // against while Motor Score calibration is outstanding. See
  // config/masteryPolicy.js for the audit findings behind this.
  //
  // Placed AFTER the request-override check above, so a teacher-set
  // threshold still wins — a human decision outranks a pilot default.
  // `family` is still resolved and reported so reports and diagnostics keep
  // showing which family a letter belongs to.
  if (!PROGRESSION_FAMILY_THRESHOLDS_ENABLED) {
    return resolved(
      NORMAL_PRACTICE_MASTERY_THRESHOLD,
      SOURCE_NORMAL_PRACTICE_PILOT,
      family,
      null,
      FALLBACK_REASON_FAMILY_DISABLED,
    );
  }

  if (!family) {
    // Feature 2 genuinely cannot exist for this letter/case — an ambiguous
    // (unmapped) letter has no baseline family at all, ever. Never a
    // legacy per-letter lookup.
    return resolved(GLOBAL_DEFAULT, SOURCE_GLOBAL_SAFE_FALLBACK, null, null, FALLBACK_REASON_UNMAPPED_FAMILY);
  }

  let currentResult;
  try {
    currentResult = await getCurrentFamilyThreshold({ studentId, family });
  } catch (err) {
    logger.error('Feature 2 threshold lookup threw unexpectedly during progression resolution', {
      studentId, letter, caseType, family, errorMessage: err.message,
    });
    currentResult = { status: 'read_failed' };
  }

  if (currentResult.status === 'found') {
    logger.debug('Feature 2 family threshold selected for progression gating', {
      studentId, letter, caseType, family, threshold: currentResult.currentThreshold, thresholdSource: SOURCE_FEATURE2_FAMILY,
    });
    return resolved(currentResult.currentThreshold, SOURCE_FEATURE2_FAMILY, family, currentResult.sourceEvent.historyId);
  }

  if (currentResult.status === 'read_failed') {
    logger.error('Feature 2 threshold read failed — using safe global fallback (intentional fail-open policy)', {
      studentId, letter, caseType, family,
    });
    return resolved(GLOBAL_DEFAULT, SOURCE_GLOBAL_SAFE_FALLBACK, family, null, FALLBACK_REASON_READ_ERROR);
  }

  // currentResult.status === 'no_target' — mapped family, not yet
  // initialized. Lazy repair (final workflow integration): attempt a
  // one-time idempotent initialization from the student's existing
  // baseline before falling back — this is what removes the manual
  // admin-script dependency for any student whose baseline predates
  // automatic initialization at finalize time.
  const repaired = await attemptLazyFeature2Repair({ studentId, family });
  if (repaired) {
    return resolved(repaired.newThreshold, SOURCE_FEATURE2_FAMILY, family, repaired.historyId);
  }

  // Genuinely not yet initializable (no baseline yet, or a requires_review
  // family score) — safe global fallback, never a legacy individualized
  // value.
  return resolved(GLOBAL_DEFAULT, SOURCE_GLOBAL_SAFE_FALLBACK, family, null, FALLBACK_REASON_NOT_YET_INITIALIZED);
}

module.exports = {
  resolveProgressionThreshold,
  GLOBAL_DEFAULT,
  SOURCE_NORMAL_PRACTICE_PILOT,
  FALLBACK_REASON_FAMILY_DISABLED,
  SOURCE_REQUEST_OVERRIDE,
  SOURCE_FEATURE2_FAMILY,
  SOURCE_GLOBAL_SAFE_FALLBACK,
  FALLBACK_REASON_UNMAPPED_FAMILY,
  FALLBACK_REASON_NOT_YET_INITIALIZED,
  FALLBACK_REASON_READ_ERROR,
};
