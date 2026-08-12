'use strict';

/**
 * repetitionRecommendationService.js
 *
 * Feature 5 Step 2 — READ-ONLY repetition signal + cap model.
 *
 * Answers, for a student + target letter: "should this handwriting target
 * be scheduled for ONE additional spaced repetition later in the sequence,
 * and has the adaptive repetition cap already been reached?" Nothing here
 * reinserts a letter into any sequence, marks any guard state, or persists
 * a decision — this module only COMPUTES and RETURNS a recommendation,
 * mirroring exactly the read-only-decision-simulation discipline Feature 4
 * Step 4 (evaluatePreWritingRecommendation) already established, which
 * itself mirrored Feature 2 Step 5 / Feature 3 Step 5.
 *
 * ── Core distinction (Step 2 spec §1) ────────────────────────────────────
 * The EXISTING immediate same-letter retry (Feature 5 Step 1 audit §4) is
 * untouched and unrelated — this service never fires in response to it and
 * never replaces it. This service answers a different, separate question:
 * should the SAME target come back around LATER, as one additional,
 * deliberately spaced repetition — not "try again right now."
 *
 * ── What this module never does ──────────────────────────────────────────
 *   - never calls LetterAttempt/LetterProgress/ThresholdHistory/ShapeFeature
 *     .create/.bulkCreate/.update/.destroy/.save/.increment, never opens a
 *     transaction — read-only via .findAll() only (see
 *     tests/repetitionRecommendationServiceReadOnly.test.js);
 *   - never persists a repetition recommendation — no new table, no new
 *     column. Every call recomputes fresh from Feature 2/3's current live
 *     state plus a fresh LetterAttempt history read;
 *   - never touches `blocked_attempts` — that legacy per-letter counter is
 *     read by nothing here and remains exactly as Feature 5 Step 1 found it
 *     (lifetime-cumulative, never reset, gates only the legacy per-letter
 *     personal_thresholds auto-lower);
 *   - never independently reconstructs a Feature 2/3 window or decision —
 *     it reuses evaluateDynamicThresholds() and evaluateSupportRecommendations()
 *     completely as-is, exactly like adaptivePreWritingService.js does;
 *   - never uses historical cycle COUNT as a trigger (Step 2 spec §28) —
 *     `history` is diagnostic-only. The one and only trigger is Feature 2/3's
 *     `support_review`, gated first by the repetition cap.
 *
 * ── The cap is NOT reconstructable from lifetime session_key history ─────
 * Feature 5 Step 1's audit found that historical `session_key` counts mix
 * manual re-practice, immediate retries, AND any future Feature-5
 * repetitions indistinguishably (no `repetition_reason` field exists) — so
 * a lifetime cycle count must NEVER be used to enforce the cap (Step 2 spec
 * §14/§15). The cap this service checks is `adaptiveRepetitionsUsed`, a
 * value the CALLER supplies (Step 3's frontend will own counting this
 * per-interaction, exactly mirroring how Feature 4's `interactionId`/guard
 * state lives frontend-side only) — this backend never claims to know the
 * current interaction's repetition count on its own.
 *
 * ── Research framing ──────────────────────────────────────────────────────
 * A `shouldRepeat: true` result means: "software identifies that a
 * handwriting target may benefit from one additional spaced revisit because
 * persistent family-level difficulty is observed." Not a clinical
 * prescription. The cap (1 automatic spaced repetition per letter per
 * interaction) is a conservative pilot engineering safety rule requiring
 * teacher/pilot validation — see config/repetitionPolicy.js.
 */

const { LetterAttempt } = require('../models');
const { getBaselineFamily } = require('../config/letterBaselineFamilies');
const { evaluateDynamicThresholds } = require('./dynamicThresholdService');
const { evaluateSupportRecommendations } = require('./adaptiveSupportService');
const { MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION, REPETITION_REASON } = require('../config/repetitionPolicy');
const logger = require('../utils/logger');

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidLetter(letter) {
  return typeof letter === 'string' && /^[A-Za-z]$/.test(letter);
}

function isValidRepetitionCount(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function emptyResult(status, { studentId = null, letter = null, caseType = null, family = null } = {}) {
  return {
    status,
    studentId, letter, caseType, family,
    shouldRepeat: false, reason: null,
    signals: null, policy: null, history: null,
  };
}

function buildPolicy(adaptiveRepetitionsUsed) {
  return {
    maxAdaptiveRepetitionsPerInteraction: MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION,
    adaptiveRepetitionsUsed,
    remainingAdaptiveRepetitions: Math.max(0, MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION - adaptiveRepetitionsUsed),
  };
}

/**
 * Decides, from Feature 2's and Feature 3's already-computed per-family
 * decisions, whether persistent difficulty justifies a spaced repetition.
 * Pure function — identical decision shape to
 * adaptivePreWritingService.js's decideFromSignals(), renamed for this
 * feature's own vocabulary (Step 2 spec §5/§6/§9/§10).
 *
 * @param {string} feature2Decision
 * @param {string} feature3Decision
 * @returns {{shouldRepeat: boolean, reason: string}}
 */
function decideFromSignals(feature2Decision, feature3Decision) {
  if (feature2Decision === 'no_target') {
    return { shouldRepeat: false, reason: REPETITION_REASON.INSUFFICIENT_TARGET };
  }
  if (feature3Decision === 'support_review') {
    return { shouldRepeat: true, reason: REPETITION_REASON.FEATURE3_SUPPORT_REVIEW };
  }
  if (feature2Decision === 'support_review') {
    return { shouldRepeat: true, reason: REPETITION_REASON.FEATURE2_SUPPORT_REVIEW };
  }
  if (feature2Decision === 'insufficient_data' && feature3Decision === 'insufficient_data') {
    return { shouldRepeat: false, reason: REPETITION_REASON.INSUFFICIENT_DATA };
  }
  return { shouldRepeat: false, reason: REPETITION_REASON.NO_PERSISTENT_DIFFICULTY };
}

/**
 * Deduplication identity — session_key + attempt_number, same rationale as
 * Feature 3's attemptIdentity() (adaptiveSupportService.js): a genuine
 * duplicate is two rows sharing BOTH the same session_key AND the same
 * attempt_number (the Step 1 audit's "six-row session" anomaly), never
 * session_key alone (a real 3-attempt cycle normally has three distinct
 * attempt_number rows sharing one session_key).
 *
 * @param {Array<{session_key: string, attempt_number: number}>} rows
 * @returns {{totalCycles: number, cleanCycles: number, malformedCycles: number}}
 */
function buildCycleHistory(rows) {
  const bySession = new Map(); // session_key -> Set of deduped attempt_numbers

  for (const row of rows) {
    if (!bySession.has(row.session_key)) bySession.set(row.session_key, new Set());
    bySession.get(row.session_key).add(row.attempt_number);
  }

  let cleanCycles = 0;
  for (const attemptNumbers of bySession.values()) {
    const isClean = attemptNumbers.size === 3
      && attemptNumbers.has(1) && attemptNumbers.has(2) && attemptNumbers.has(3);
    if (isClean) cleanCycles++;
  }

  const totalCycles = bySession.size;
  return { totalCycles, cleanCycles, malformedCycles: totalCycles - cleanCycles };
}

/**
 * Read-only repetition recommendation for one student + target letter.
 * Persists nothing, reinserts nothing, marks no guard state — see module
 * header.
 *
 * Evaluation order (Step 2 spec §23/§24): input validation, then letter ->
 * family resolution (zero DB work for an ambiguous letter), then the
 * repetition cap (zero DB work when already reached — the system cannot
 * act regardless of what Feature 2/3 would say), and only then the
 * expensive real reads (Feature 2, Feature 3, and cycle-history).
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @param {string} params.letter
 * @param {string} params.caseType — 'lowercase'|'uppercase'
 * @param {number} [params.adaptiveRepetitionsUsed=0] — how many automatic
 *   spaced repetitions this letter has already received THIS interaction,
 *   as counted by the caller (frontend, Step 3) — never reconstructed here.
 * @returns {Promise<{
 *   status: 'evaluated'|'invalid_input'|'read_failed',
 *   studentId: number|null,
 *   letter: string|null,
 *   caseType: string|null,
 *   family: string|null,
 *   shouldRepeat: boolean,
 *   reason: string|null,
 *   signals: {feature2Decision: string, feature3Decision: string}|null,
 *   policy: {maxAdaptiveRepetitionsPerInteraction: number, adaptiveRepetitionsUsed: number, remainingAdaptiveRepetitions: number}|null,
 *   history: {totalCycles: number, cleanCycles: number, malformedCycles: number}|null,
 * }>}
 */
async function evaluateRepetitionRecommendation({
  studentId, letter, caseType, adaptiveRepetitionsUsed = 0,
} = {}) {
  if (!isPositiveInteger(studentId) || !isValidLetter(letter) || !VALID_CASE_TYPES.includes(caseType)
      || !isValidRepetitionCount(adaptiveRepetitionsUsed)) {
    return emptyResult('invalid_input', {
      studentId: isPositiveInteger(studentId) ? studentId : null,
      letter: isValidLetter(letter) ? letter : null,
      caseType: VALID_CASE_TYPES.includes(caseType) ? caseType : null,
    });
  }

  // ── Step 1: family resolution (Feature 2's own reviewed mapping only) ──
  // Never derives a family from teaching category or motor primitive
  // (Step 2 spec §7) — getBaselineFamily() is the sole source.
  const family = getBaselineFamily(letter, caseType);
  if (!family) {
    return {
      status: 'evaluated', studentId, letter, caseType, family: null,
      shouldRepeat: false, reason: REPETITION_REASON.NOT_APPLICABLE,
      signals: null, policy: null, history: null,
    };
  }

  // ── Step 2: repetition cap, BEFORE any expensive read (spec §23/§24) ───
  // Once the cap is reached, the system cannot act regardless of what
  // Feature 2/3 would say — no point spending a Feature 2/3/history read.
  if (adaptiveRepetitionsUsed >= MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION) {
    return {
      status: 'evaluated', studentId, letter, caseType, family,
      shouldRepeat: false, reason: REPETITION_REASON.CAP_REACHED,
      signals: null, policy: buildPolicy(adaptiveRepetitionsUsed), history: null,
    };
  }

  // ── Step 3: the only real DB/service reads in this module ──────────────
  let thresholdsResult, supportResult, historyRows;
  try {
    [thresholdsResult, supportResult, historyRows] = await Promise.all([
      evaluateDynamicThresholds({ studentId }),
      evaluateSupportRecommendations({ studentId }),
      LetterAttempt.findAll({
        where: { student_id: studentId, letter, case_type: caseType, collection_mode: false },
        attributes: ['session_key', 'attempt_number'],
      }),
    ]);
  } catch (err) {
    logger.error('Repetition recommendation read threw unexpectedly', { studentId, letter, caseType, errorMessage: err.message });
    return { ...emptyResult('read_failed', { studentId, letter, caseType }), family };
  }

  // Conservative fail-closed behavior, same as Feature 4 Step 4: a read
  // failure on EITHER Feature 2 or Feature 3 means the whole recommendation
  // is read_failed — never a partial recommendation based on only the
  // system that happened to succeed.
  if (thresholdsResult.status !== 'evaluated' || supportResult.status !== 'evaluated') {
    return { ...emptyResult('read_failed', { studentId, letter, caseType }), family };
  }

  const feature2Decision = thresholdsResult.families[family].decision;
  const feature3Decision = supportResult.families[family].decision;
  const { shouldRepeat, reason } = decideFromSignals(feature2Decision, feature3Decision);

  return {
    status: 'evaluated', studentId, letter, caseType, family,
    shouldRepeat, reason,
    signals: { feature2Decision, feature3Decision },
    policy: buildPolicy(adaptiveRepetitionsUsed),
    history: buildCycleHistory(historyRows),
  };
}

module.exports = {
  REPETITION_REASON,
  evaluateRepetitionRecommendation,
};
