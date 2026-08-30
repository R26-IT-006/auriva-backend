'use strict';

/**
 * adaptivePreWritingService.js
 *
 * Feature 4 Step 4 — READ-ONLY adaptive pre-writing RECOMMENDATION.
 *
 * Answers, for a student + target letter: "does persistent, family-level
 * handwriting difficulty justify suggesting a short pre-writing
 * motor-preparation activity before this letter, and if so, which ONE
 * existing activity?" Nothing here navigates, persists a decision, marks
 * the Step 3 loop guard, or changes ShapeFeature/PreWritingActivityScreen in
 * any way — this module only COMPUTES and RETURNS a recommendation, exactly
 * mirroring the read-only-decision-simulation discipline Feature 2 Step 5
 * (evaluateDynamicThresholds) and Feature 3 Step 5
 * (evaluateSupportRecommendations) already established.
 *
 * ── Research framing (Step 4 spec §48) ──────────────────────────────────
 * A recommendation from this module means: "software suggests a short
 * pre-writing motor-preparation activity because persistent handwriting
 * difficulty is observed at a family level." It is NOT clinical therapy,
 * NOT a diagnosis, NOT a medical intervention, and NOT a validated autism
 * treatment. Using Feature 2/3 `support_review` as the trigger is an
 * engineering/pilot rule requiring teacher/pilot validation, exactly like
 * every other pilot default in this codebase (INITIAL_THRESHOLD_MARGIN,
 * SUPPORT_SUCCESS_MET_COUNT, etc.).
 *
 * ── What this module never does ──────────────────────────────────────────
 *   - never calls LetterAttempt/ThresholdHistory/ShapeFeature .create/
 *     .bulkCreate/.update/.destroy/.save, never opens a transaction — it
 *     only reads, via the two existing read-only services below (see
 *     tests/adaptivePreWritingServiceReadOnly.test.js);
 *   - never persists a recommendation-history row — no new table, no new
 *     column on ShapeFeature (target_letter/target_case_type/interactionId/
 *     reason are explicitly deferred — Step 4 spec §32). Every call
 *     recomputes fresh from Feature 2/3's current live state;
 *   - never calls the frontend's hasWarmupHandled() loop guard (Step 3) —
 *     that is interaction/navigation state this backend service has no way
 *     to know. This separation is intentional: Step 5's frontend activation
 *     is expected to combine "this backend recommendation" WITH "the Step 3
 *     guard says this interaction hasn't already warmed up" before ever
 *     navigating anywhere;
 *   - never independently reconstructs a window, a target, or a "recent
 *     performance" concept — it reuses evaluateDynamicThresholds()
 *     (Feature 2 Step 5) and evaluateSupportRecommendations() (Feature 3
 *     Step 5) completely as-is. Both already encode "complete evidence
 *     window" internally (windowComplete gating); this module trusts that
 *     encoding rather than re-deriving its own notion of completeness;
 *   - never modifies either underlying system: Feature 2's target/decision
 *     vocabulary and Feature 3's support/decision vocabulary are read
 *     exactly as those services already compute them, never re-interpreted
 *     or altered.
 *
 * ── Trigger principle (Step 4 spec §3) ───────────────────────────────────
 * A single failed letter attempt is never sufficient evidence. Both
 * Feature 2 and Feature 3's `support_review` decisions already require a
 * COMPLETE window (Feature 2: 5 independent attempt-3 rows, 0-1 meeting
 * target; Feature 3: a complete HIGH-support window still below the success
 * bar) — this service reuses those decisions directly rather than
 * reconstructing a second, looser trigger from raw attempt data.
 *
 * ── Signal priority (Step 4 spec §8/§9) ──────────────────────────────────
 * Feature 3 support_review (even maximum visual guidance still fails the
 * family target) takes priority over Feature 2 support_review (independent
 * performance remains below target) as the reported `reason`, when both are
 * true — Feature 3's signal is conceptually closer to "a motor-preparation
 * detour might help" than Feature 2's. This is an engineering ordering
 * choice, not a clinical rule. Both diagnostics are always returned under
 * `signals`, regardless of which one drove the decision — the two systems
 * are never collapsed into one undocumented boolean.
 */

const { evaluateDynamicThresholds } = require('./dynamicThresholdService');
const { evaluateSupportRecommendations } = require('./adaptiveSupportService');
const { getPreWritingPrimitiveMapping } = require('../config/preWritingFamilyMapping');
const { getEasiestActivityId } = require('../config/preWritingActivityCatalog');
const logger = require('../utils/logger');

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

// ─── Stable reason vocabulary (Step 4 spec §21) — never an overloaded
//     generic string. ─────────────────────────────────────────────────────
const REASON = {
  FEATURE3_SUPPORT_REVIEW: 'feature3_support_review',
  FEATURE2_SUPPORT_REVIEW: 'feature2_support_review',
  INSUFFICIENT_DATA:       'insufficient_data',
  INSUFFICIENT_TARGET:     'insufficient_target',
  NOT_APPLICABLE:          'not_applicable',
  NO_ACTIVITY_AVAILABLE:   'no_activity_available',
  NO_PERSISTENT_DIFFICULTY: 'no_persistent_difficulty',
};

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidLetter(letter) {
  return typeof letter === 'string' && /^[A-Za-z]$/.test(letter);
}

function emptyResult(status, { studentId = null, letter = null, caseType = null } = {}) {
  return {
    status,
    studentId, letter, caseType,
    family: null, primitiveGroup: null,
    recommended: false, activityId: null, reason: null,
    signals: null,
  };
}

/**
 * Decides, from Feature 2's and Feature 3's already-computed per-family
 * decisions, whether persistent difficulty is indicated and — if so — which
 * reason to report. Pure function: no I/O, fully unit-testable without a DB.
 *
 * Decision order (Step 4 spec §7/§8/§10/§11/§22/§23/§24/§25):
 *   1. Feature 2 has no target for this family at all -> insufficient_target
 *      (Feature 3 independently reaches the structurally-equivalent
 *      'insufficient_target' the moment Feature 2 has no_target, since it
 *      reads the same getCurrentFamilyThreshold() — both signals agree by
 *      construction; Feature 2's own 'no_target' vocabulary is treated as
 *      authoritative here).
 *   2. Feature 3 = support_review -> recommended, feature3_support_review
 *      (checked first — Step 4 spec §8/§9 priority).
 *   3. Feature 2 = support_review -> recommended, feature2_support_review.
 *   4. Both = insufficient_data -> not recommended, insufficient_data
 *      (sparse evidence is never treated as proof of difficulty).
 *   5. Otherwise (at least one system reached a complete, non-review
 *      decision — raise/raise_requires_review/hold, or
 *      recommend_low/medium/high) -> not recommended, no_persistent_difficulty.
 *      recommend_high is explicitly NOT support_review (Step 4 spec §23) —
 *      visual support being sufficient must never alone trigger a warm-up.
 *
 * @param {string} feature2Decision
 * @param {string} feature3Decision
 * @returns {{recommended: boolean, reason: string}}
 */
function decideFromSignals(feature2Decision, feature3Decision) {
  if (feature2Decision === 'no_target') {
    return { recommended: false, reason: REASON.INSUFFICIENT_TARGET };
  }
  if (feature3Decision === 'support_review') {
    return { recommended: true, reason: REASON.FEATURE3_SUPPORT_REVIEW };
  }
  if (feature2Decision === 'support_review') {
    return { recommended: true, reason: REASON.FEATURE2_SUPPORT_REVIEW };
  }
  if (feature2Decision === 'insufficient_data' && feature3Decision === 'insufficient_data') {
    return { recommended: false, reason: REASON.INSUFFICIENT_DATA };
  }
  return { recommended: false, reason: REASON.NO_PERSISTENT_DIFFICULTY };
}

/**
 * Read-only adaptive pre-writing recommendation for one student + target
 * letter. Persists nothing, navigates nothing, marks no guard state — see
 * module header.
 *
 * Evaluation order (Step 4 spec §27/§28): input validation, then letter ->
 * family/primitive mapping, then activity-catalogue availability, BEFORE
 * any Feature 2/3 database read — an ambiguous letter or a mapped-but-
 * activity-less group (u/U -> mixed) short-circuits with zero DB work.
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.letter
 * @param {string} params.caseType — 'lowercase'|'uppercase'
 * @returns {Promise<{
 *   status: 'evaluated'|'invalid_input'|'read_failed',
 *   studentId: number|null,
 *   letter: string|null,
 *   caseType: string|null,
 *   family: string|null,
 *   primitiveGroup: string|null,
 *   recommended: boolean,
 *   activityId: string|null,
 *   reason: string|null,
 *   signals: {feature2Decision: string, feature3Decision: string}|null,
 * }>}
 */
async function evaluatePreWritingRecommendation({ studentId, letter, caseType } = {}) {
  if (!isPositiveInteger(studentId) || !isValidLetter(letter) || !VALID_CASE_TYPES.includes(caseType)) {
    return emptyResult('invalid_input', { studentId: isPositiveInteger(studentId) ? studentId : null, letter: isValidLetter(letter) ? letter : null, caseType: VALID_CASE_TYPES.includes(caseType) ? caseType : null });
  }

  // ── Step 1: mapping (Feature 4 Step 2, read-only/pure, no DB) ──────────
  const mapping = getPreWritingPrimitiveMapping(letter, caseType);

  if (mapping.status === 'invalid_input') {
    // e.g. a mismatched letter/caseType pairing with no Feature 2 entry at
    // all — malformed input, not a "letter genuinely has no family" case.
    return emptyResult('invalid_input', { studentId, letter, caseType });
  }

  if (mapping.status === 'not_applicable') {
    // Feature 2 itself is ambiguous for this letter — never guess a family
    // from the motor-primitive taxonomy (Step 4 spec §12).
    return {
      status: 'evaluated',
      studentId, letter, caseType,
      family: null, primitiveGroup: null,
      recommended: false, activityId: null, reason: REASON.NOT_APPLICABLE,
      signals: null,
    };
  }

  // mapping.status === 'reviewed' from here on.
  const { baselineFamily: family, primitiveGroup, hasActivities } = mapping;

  // ── Step 2: activity-catalogue availability, BEFORE any DB read ────────
  // Deliberately checked before touching Feature 2/3 at all (Step 4 spec
  // §27/§28) — for u/U (family=complex, primitiveGroup=mixed,
  // hasActivities=false) there is no product action possible regardless of
  // how much difficulty evidence exists, so no DB work is spent finding out.
  if (!hasActivities) {
    return {
      status: 'evaluated',
      studentId, letter, caseType,
      family, primitiveGroup,
      recommended: false, activityId: null, reason: REASON.NO_ACTIVITY_AVAILABLE,
      signals: null,
    };
  }

  // ── Step 3: Feature 2 + Feature 3 signals (the only DB reads in this
  //     module) ────────────────────────────────────────────────────────────
  let thresholdsResult, supportResult;
  try {
    [thresholdsResult, supportResult] = await Promise.all([
      evaluateDynamicThresholds({ studentId }),
      evaluateSupportRecommendations({ studentId }),
    ]);
  } catch (err) {
    logger.error('Pre-writing recommendation signal lookup threw unexpectedly', { studentId, letter, caseType, errorMessage: err.message });
    return { ...emptyResult('read_failed', { studentId, letter, caseType }), family, primitiveGroup };
  }

  // Conservative fail-closed behavior (Step 4 spec §26): a read failure on
  // EITHER system means the whole recommendation is read_failed — never a
  // partial recommendation based on only the system that happened to succeed.
  if (thresholdsResult.status !== 'evaluated' || supportResult.status !== 'evaluated') {
    return { ...emptyResult('read_failed', { studentId, letter, caseType }), family, primitiveGroup };
  }

  const feature2Decision = thresholdsResult.families[family].decision;
  const feature3Decision = supportResult.families[family].decision;

  const { recommended, reason } = decideFromSignals(feature2Decision, feature3Decision);

  // hasActivities was already confirmed true above, so getEasiestActivityId
  // is guaranteed non-null here — but the null-coalescing call itself is
  // still routed through the one shared, tested helper rather than assumed.
  const activityId = recommended ? getEasiestActivityId(primitiveGroup) : null;

  return {
    status: 'evaluated',
    studentId, letter, caseType,
    family, primitiveGroup,
    recommended, activityId, reason,
    signals: { feature2Decision, feature3Decision },
  };
}

module.exports = {
  REASON,
  evaluatePreWritingRecommendation,
};
