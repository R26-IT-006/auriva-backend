'use strict';

/**
 * authoritativeAttemptScoring.js
 *
 * Motor Score Unification, Phase 1 (spec §2/§4/§5) — computes the
 * AUTHORITATIVE per-attempt and session-best motor score entirely from
 * backend-derived data (attempt.features + attempt.strokes), reusing the
 * exact existing normalizeLetterFeatures() -> computeMotorScore() pipeline
 * that already runs inside saveLetterAttempts() for persistence. This
 * module makes that same pipeline available BEFORE the pass/fail decision
 * is made, so mastery/threshold gating uses it too — never the
 * client-supplied `attempt_scores` array.
 *
 * Eligibility rule (spec §5 — "preserve existing rules around usable
 * attempt/coverage/attempt numbering"): reuses isAttemptCoverageValid()
 * UNCHANGED (same geometry-only coverage/geometry gate the old
 * computeCoverageFilteredBestScore() used) — an attempt whose drawing
 * fails the coverage check is excluded from bestScore eligibility here
 * exactly as it was before. The only thing that changed is WHICH SCORE is
 * computed for each eligible attempt: computeMotorScore() (backend,
 * authoritative), never featuresToScore() (client-supplied, no longer
 * trusted for this decision — spec §4).
 *
 * A null motor_score (computeMotorScore() found no usable components at
 * all for that attempt) is also excluded from eligibility — an attempt
 * that produced no derivable score cannot set the session's best score.
 */

const { isAttemptCoverageValid } = require('./attemptCoverageValidity');
const { normalizeLetterFeatures } = require('./featureNormalization');
const { computeMotorScore } = require('./motorScore');
const { MASTERY_ATTEMPT_NUMBER, MASTERY_FAIL_REASON } = require('../config/masteryPolicy');
const { isAttemptCaptureComplete } = require('./captureStatus');

/**
 * @param {{
 *   attempts: Array<{features?: Object, strokes?: Array}>,
 *   canvasWidth: number|null|undefined,
 *   canvasHeight: number|null|undefined,
 * }} params
 * @returns {{
 *   bestScore: number|null,
 *   attemptScores: Array<number|null>,   // one entry per input attempt, in order — null where ineligible/uncomputable
 *   eligibleCount: number,
 * }}
 */
function computeAuthoritativeBestScore({ attempts, canvasWidth, canvasHeight }) {
  const attemptsArray = Array.isArray(attempts) ? attempts : [];

  const attemptScores = attemptsArray.map((attempt) => {
    const coverageValid = isAttemptCoverageValid(attempt?.strokes, canvasWidth, canvasHeight);
    // Fail open on undeterminable coverage (missing canvas dims) — same
    // rule the pre-unification coverage filter used: only an EXPLICIT
    // `false` excludes an attempt, never an unknown (`null`).
    if (coverageValid === false) return null;

    const { normalized } = normalizeLetterFeatures(attempt?.features, { strokePoints: attempt?.strokes });
    const { motor_score } = computeMotorScore(normalized);
    return motor_score; // already 0-100 integer, or null
  });

  const eligible = attemptScores.filter((s) => s != null);

  return {
    bestScore: eligible.length > 0 ? Math.max(...eligible) : null,
    attemptScores,
    eligibleCount: eligible.length,
  };
}

/**
 * The AUTHORITATIVE MASTERY score for one normal-practice cycle.
 *
 * Mastery is decided on the INDEPENDENT attempt only — see
 * config/masteryPolicy.js for the evidence behind that rule. Attempts 1 and
 * 2 are drawn with on-screen guidance, so scoring mastery on the best of the
 * three certified a guided drawing as independent writing (it did so in ~76%
 * of real cycles).
 *
 * Deliberately NOT a variant of computeAuthoritativeBestScore(): there is no
 * Math.max here and no fallback to an earlier attempt of any kind. If the
 * mastery attempt is missing, coverage-invalid, or produces no derivable
 * score, the cycle FAILS. Falling back to attempt 1 or 2 would reintroduce
 * exactly the leniency this rule removes.
 *
 * computeAuthoritativeBestScore() is untouched and still used for reporting
 * and for the persisted best_score column — attempts 1 and 2 remain fully
 * captured, scored and available to reports and motor analysis. They simply
 * cannot master a letter.
 *
 * @param {{
 *   attempts: Array<{features?: Object, strokes?: Array}>,
 *   canvasWidth: number|null|undefined,
 *   canvasHeight: number|null|undefined,
 * }} params
 * @returns {{
 *   masteryScore: number|null,      // null whenever the cycle cannot master
 *   attemptNumber: number,          // which attempt was evaluated (1-based)
 *   coverageValid: boolean|null,    // null = undeterminable, never a failure
 *   failReason: string|null,        // MASTERY_FAIL_REASON.* when masteryScore is null
 * }}
 */
function computeAuthoritativeMasteryScore({ attempts, canvasWidth, canvasHeight }) {
  const attemptsArray = Array.isArray(attempts) ? attempts : [];
  const base = { attemptNumber: MASTERY_ATTEMPT_NUMBER, coverageValid: null, masteryScore: null };

  // A cycle that never reached the independent attempt cannot master. This
  // is a FAIL, not an error — the child simply has not yet produced the
  // evidence mastery requires.
  if (attemptsArray.length < MASTERY_ATTEMPT_NUMBER) {
    return { ...base, failReason: MASTERY_FAIL_REASON.ATTEMPT_MISSING };
  }

  const attempt = attemptsArray[MASTERY_ATTEMPT_NUMBER - 1];

  // CAPTURE IS CHECKED BEFORE COVERAGE, and the order is load-bearing.
  //
  // isAttemptCoverageValid() returns `false` for an EMPTY drawing and for a
  // genuine-but-tiny one alike (getDrawingBounds([]) is {0,0,0}). Checking
  // coverage first therefore reported a device fault as
  // `attempt3_coverage_invalid` — a handwriting judgement about handwriting
  // that was never recorded, which then consumed one of the child's three
  // cycles for the day.
  //
  // This uses the SAME predicate that decides what capture_status the row is
  // stored with (utils/captureStatus.js), so "the row we labelled incomplete"
  // and "the attempt we refuse to evaluate" are guaranteed to be the same
  // set. Still a FAIL — a cycle with no captured attempt 3 cannot master —
  // but a DISTINGUISHABLE one, which is what lets the cycle not be consumed.
  if (!isAttemptCaptureComplete(attempt)) {
    return { ...base, failReason: MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE };
  }

  // Same coverage/geometry gate the rest of this module uses. Note the
  // asymmetry, and it is deliberate: only an EXPLICIT `false` fails. An
  // undeterminable coverage result (missing canvas dimensions) must not
  // fail a child for a device/telemetry gap, exactly as
  // computeAuthoritativeBestScore() has always treated it.
  const coverageValid = isAttemptCoverageValid(attempt?.strokes, canvasWidth, canvasHeight);
  if (coverageValid === false) {
    return { ...base, coverageValid: false, failReason: MASTERY_FAIL_REASON.COVERAGE_INVALID };
  }

  const { normalized } = normalizeLetterFeatures(attempt?.features, { strokePoints: attempt?.strokes });
  const { motor_score } = computeMotorScore(normalized);

  if (motor_score == null) {
    return { ...base, coverageValid, failReason: MASTERY_FAIL_REASON.SCORE_UNAVAILABLE };
  }

  return { masteryScore: motor_score, attemptNumber: MASTERY_ATTEMPT_NUMBER, coverageValid, failReason: null };
}

module.exports = { computeAuthoritativeBestScore, computeAuthoritativeMasteryScore };
