'use strict';

/**
 * authoritativeAttemptScoring.js — calculate the authoritative Motor Score.
 *
 * Scores attempts on the server with the same normalizeLetterFeatures() ->
 * computeMotorScore() pipeline that saveLetterAttempts() uses for storage,
 * so pass/fail and mastery never use the client's `attempt_scores` array.
 *
 * Input provenance: the score is computed on the server, but not every input
 * is recomputed there. direction_score is derived from the raw strokes;
 * smoothness, dtw_distance and pause_count come from the client's submitted
 * features, and avg_speed too when sent (see featureNormalization.js).
 *
 * An attempt is excluded from bestScore when its coverage check is
 * explicitly false (isAttemptCoverageValid) or when it has no derivable
 * motor_score.
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
    // Fail open on undeterminable coverage (missing canvas dims): only an
    // explicit `false` excludes an attempt, never an unknown (`null`).
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
 * Validate attempt 3 and return the authoritative mastery score for one
 * normal-practice cycle.
 *
 * Mastery uses the independent attempt only (see config/masteryPolicy.js).
 * Attempts 1 and 2 are drawn with on-screen guidance; best-of-3 certified a
 * guided drawing as independent writing in ~76% of real cycles.
 *
 * No Math.max and no fallback to attempts 1 or 2: if attempt 3 is missing,
 * not captured, coverage-invalid or unscoreable, the cycle FAILS.
 * computeAuthoritativeBestScore() still provides the reported/stored
 * best_score.
 *
 * Known gap: the controller calls this only when `attempts` is non-empty
 * (handwritingController.js recordLetterCompletion). A request with no
 * `attempts` skips this check entirely and is not yet rejected.
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

  // Fewer than 3 attempts: a FAIL, not an error.
  if (attemptsArray.length < MASTERY_ATTEMPT_NUMBER) {
    return { ...base, failReason: MASTERY_FAIL_REASON.ATTEMPT_MISSING };
  }

  const attempt = attemptsArray[MASTERY_ATTEMPT_NUMBER - 1];

  // Check capture completeness BEFORE coverage — the order matters.
  // isAttemptCoverageValid() returns false for an empty drawing as well as a
  // tiny real one, so checking coverage first would report a device capture
  // fault as a handwriting failure and spend one of the day's three cycles.
  // Uses the same predicate as the stored capture_status (captureStatus.js).
  // Still a FAIL, but distinguishable, so the cycle is not consumed.
  if (!isAttemptCaptureComplete(attempt)) {
    return { ...base, failReason: MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE };
  }

  // Coverage check. Deliberately asymmetric: only an explicit `false` fails;
  // undeterminable coverage (missing canvas dimensions) must not fail a
  // child for a device/telemetry gap.
  const coverageValid = isAttemptCoverageValid(attempt?.strokes, canvasWidth, canvasHeight);
  if (coverageValid === false) {
    return { ...base, coverageValid: false, failReason: MASTERY_FAIL_REASON.COVERAGE_INVALID };
  }

  // Calculate the attempt-3 Motor Score.
  const { normalized } = normalizeLetterFeatures(attempt?.features, { strokePoints: attempt?.strokes });
  const { motor_score } = computeMotorScore(normalized);

  if (motor_score == null) {
    return { ...base, coverageValid, failReason: MASTERY_FAIL_REASON.SCORE_UNAVAILABLE };
  }

  return { masteryScore: motor_score, attemptNumber: MASTERY_ATTEMPT_NUMBER, coverageValid, failReason: null };
}

module.exports = { computeAuthoritativeBestScore, computeAuthoritativeMasteryScore };
