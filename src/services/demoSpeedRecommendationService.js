'use strict';

/**
 * demoSpeedRecommendationService.js
 *
 * Feature 6 Step 3 — READ-ONLY demonstration-speed recommendation.
 *
 * Answers, for a student + target letter: "should this letter's animated
 * demonstration (the tracer dot) be recommended at STANDARD or SLOW speed?"
 * Nothing here renders anything, changes any tracer timing, or persists a
 * decision — this module only COMPUTES and RETURNS a categorical
 * recommendation, mirroring exactly the read-only-decision-simulation
 * discipline Feature 4 Step 4 (evaluatePreWritingRecommendation) and
 * Feature 5 Step 2 (evaluateRepetitionRecommendation) already established.
 *
 * ── Backend/frontend ownership split (Step 3 spec §2) ────────────────────
 * This module knows NOTHING about pixels, `Animated.timing`, stroke arc
 * length, or canvas dimensions — it returns only the categorical vocabulary
 * `standard`/`slow` from demoSpeedPolicy.js. Converting a level into an
 * actual px/ms value is exclusively the frontend's job
 * (auriva-frontend/src/constants/demoSpeedLevels.js's
 * getTracerSpeedForLevel()), which this backend has no need to duplicate or
 * even reference.
 *
 * ── What this module never does ──────────────────────────────────────────
 *   - never calls LetterAttempt/LetterProgress/ThresholdHistory/ShapeFeature/
 *     StudentMotorBaseline .create/.bulkCreate/.update/.destroy/.save/
 *     .increment, never opens a transaction — fully read-only, composing
 *     only evaluateDynamicThresholds() and evaluateSupportRecommendations()
 *     (both already exhaustively read-only-tested in their own features);
 *   - never persists a recommendation — no new table, no new column. Every
 *     call recomputes fresh from Feature 2/3's current live state;
 *   - never reads or considers ANY raw timing feature
 *     (attempt_duration_ms/attempt_avg_speed/attempt_pause_frequency/
 *     attempt_pause_duration_ratio/legacy duration_ms) — Feature 6 Step 2's
 *     trust model (MVP_TIMING_SIGNALS_ENABLED = false) is enforced here by
 *     simple omission: this file has no LetterAttempt import at all, and
 *     therefore structurally cannot read a timing feature even by mistake
 *     (see tests/demoSpeedRecommendationServiceReadOnly.test.js's explicit
 *     "no LetterAttempt reference" source-scan test);
 *   - never independently reconstructs a Feature 2/3 window or decision —
 *     it reuses evaluateDynamicThresholds() and evaluateSupportRecommendations()
 *     completely as-is, exactly like adaptivePreWritingService.js and
 *     repetitionRecommendationService.js both already do.
 *
 * ── Research framing ──────────────────────────────────────────────────────
 * A `recommendedSpeedLevel: 'slow'` result means: "software recommends a
 * reduced demonstration speed because persistent family-level handwriting
 * difficulty is observed." Not a clinical treatment, not a motor diagnosis,
 * not an ASD-severity classification. The 0.75 slow multiplier (defined in
 * demoSpeedPolicy.js/demoSpeedLevels.js, Step 2) remains a conservative
 * pilot engineering default requiring teacher/pilot validation.
 */

const { getBaselineFamily } = require('../config/letterBaselineFamilies');
const { evaluateDynamicThresholds } = require('./dynamicThresholdService');
const { evaluateSupportRecommendations } = require('./adaptiveSupportService');
const { DEMO_SPEED_LEVELS, DEFAULT_DEMO_SPEED_LEVEL, DEMO_SPEED_REASONS } = require('../config/demoSpeedPolicy');
const logger = require('../utils/logger');

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isValidLetter(letter) {
  return typeof letter === 'string' && /^[A-Za-z]$/.test(letter);
}

function emptyResult(status, { studentId = null, letter = null, caseType = null, family = null } = {}) {
  return {
    status,
    studentId, letter, caseType, family,
    recommendedSpeedLevel: DEFAULT_DEMO_SPEED_LEVEL,
    reason: null,
    signals: null,
  };
}

/**
 * Decides, from Feature 2's and Feature 3's already-computed per-family
 * decisions, whether persistent difficulty justifies a slow demonstration.
 * Pure function: no I/O, fully unit-testable without a DB. Identical
 * decision shape/priority to adaptivePreWritingService.js's
 * decideFromSignals() and repetitionRecommendationService.js's own
 * (Step 3 spec §9/§10) — only the vocabulary differs
 * (recommendedSpeedLevel instead of recommended/shouldRepeat).
 *
 * Decision order:
 *   1. Feature 2 has no target for this family -> insufficient_target
 *      (Feature 3 independently reaches the structurally-equivalent
 *      'insufficient_target' the moment Feature 2 has no_target, since it
 *      reads the same getCurrentFamilyThreshold()).
 *   2. Feature 3 = support_review -> slow, feature3_support_review
 *      (checked first — Feature 3's signal means even HIGH visual support
 *      has not produced sufficient performance, the stronger existing
 *      software-support signal; engineering rationale, not a clinical rule).
 *   3. Feature 2 = support_review -> slow, feature2_support_review.
 *   4. Both = insufficient_data -> standard, insufficient_data (sparse
 *      evidence is never treated as proof of difficulty).
 *   5. Otherwise (at least one system reached a complete, non-review
 *      decision — raise/raise_requires_review/hold, or
 *      recommend_low/medium/high) -> standard, no_persistent_difficulty.
 *      recommend_high is explicitly NOT support_review — visual support
 *      being sufficient must never alone trigger a slower demonstration.
 *
 * @param {string} feature2Decision
 * @param {string} feature3Decision
 * @returns {{recommendedSpeedLevel: string, reason: string}}
 */
function decideFromSignals(feature2Decision, feature3Decision) {
  if (feature2Decision === 'no_target') {
    return { recommendedSpeedLevel: DEMO_SPEED_LEVELS.STANDARD, reason: DEMO_SPEED_REASONS.INSUFFICIENT_TARGET };
  }
  if (feature3Decision === 'support_review') {
    return { recommendedSpeedLevel: DEMO_SPEED_LEVELS.SLOW, reason: DEMO_SPEED_REASONS.FEATURE3_SUPPORT_REVIEW };
  }
  if (feature2Decision === 'support_review') {
    return { recommendedSpeedLevel: DEMO_SPEED_LEVELS.SLOW, reason: DEMO_SPEED_REASONS.FEATURE2_SUPPORT_REVIEW };
  }
  if (feature2Decision === 'insufficient_data' && feature3Decision === 'insufficient_data') {
    return { recommendedSpeedLevel: DEMO_SPEED_LEVELS.STANDARD, reason: DEMO_SPEED_REASONS.INSUFFICIENT_DATA };
  }
  return { recommendedSpeedLevel: DEMO_SPEED_LEVELS.STANDARD, reason: DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY };
}

/**
 * Read-only demo-speed recommendation for one student + target letter.
 * Persists nothing, renders nothing, changes no tracer timing — see module
 * header.
 *
 * Evaluation order: input validation, then letter -> family resolution
 * (zero DB work for an ambiguous letter), and only then the real Feature
 * 2/3 reads.
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
 *   recommendedSpeedLevel: 'standard'|'slow',
 *   reason: string|null,
 *   signals: {feature2Decision: string, feature3Decision: string}|null,
 * }>}
 */
async function evaluateDemoSpeedRecommendation({ studentId, letter, caseType } = {}) {
  if (!isPositiveInteger(studentId) || !isValidLetter(letter) || !VALID_CASE_TYPES.includes(caseType)) {
    return emptyResult('invalid_input', {
      studentId: isPositiveInteger(studentId) ? studentId : null,
      letter: isValidLetter(letter) ? letter : null,
      caseType: VALID_CASE_TYPES.includes(caseType) ? caseType : null,
    });
  }

  // ── Step 1: family resolution (Feature 2's own reviewed mapping only) ──
  // Never teaching category, never Feature 4's motor-primitive mapping.
  const family = getBaselineFamily(letter, caseType);
  if (!family) {
    return {
      status: 'evaluated', studentId, letter, caseType, family: null,
      recommendedSpeedLevel: DEFAULT_DEMO_SPEED_LEVEL, reason: DEMO_SPEED_REASONS.NOT_APPLICABLE,
      signals: null,
    };
  }

  // ── Step 2: the only real DB/service reads in this module ──────────────
  let thresholdsResult, supportResult;
  try {
    [thresholdsResult, supportResult] = await Promise.all([
      evaluateDynamicThresholds({ studentId }),
      evaluateSupportRecommendations({ studentId }),
    ]);
  } catch (err) {
    logger.error('Demo speed recommendation read threw unexpectedly', { studentId, letter, caseType, errorMessage: err.message });
    return { ...emptyResult('read_failed', { studentId, letter, caseType }), family };
  }

  // Conservative fail-closed behavior, same as Feature 4/5: a read failure
  // on EITHER Feature 2 or Feature 3 means the whole recommendation is
  // read_failed — never a partial slow recommendation based on only the
  // system that happened to succeed. STANDARD is always the safe fallback.
  if (thresholdsResult.status !== 'evaluated' || supportResult.status !== 'evaluated') {
    return { ...emptyResult('read_failed', { studentId, letter, caseType }), family };
  }

  const feature2Decision = thresholdsResult.families[family].decision;
  const feature3Decision = supportResult.families[family].decision;
  const { recommendedSpeedLevel, reason } = decideFromSignals(feature2Decision, feature3Decision);

  return {
    status: 'evaluated', studentId, letter, caseType, family,
    recommendedSpeedLevel, reason,
    signals: { feature2Decision, feature3Decision },
  };
}

module.exports = {
  evaluateDemoSpeedRecommendation,
};
