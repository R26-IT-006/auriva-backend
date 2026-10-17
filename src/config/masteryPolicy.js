'use strict';

/**
 * masteryPolicy.js — normal letter-practice mastery policy.
 *
 * ── The policy ───────────────────────────────────────────────────────────
 *   Cycle 1: attempts 1 (high support), 2 (reduced), 3 (independent)
 *            evaluate ONLY attempt 3 (authoritative backend Motor Score)
 *            pass -> mastered -> next letter
 *            fail -> Cycle 2
 *   Cycle 2: same; fail -> short motor warm-up (client), then Cycle 3
 *   Cycle 3: same; fail -> advance UNMASTERED, letter becomes a home-practice
 *            candidate
 *
 *   Maximum 3 cycles x 3 attempts = 9 attempts per letter / case / practice
 *   date (see practiceCyclePolicy.js for where that cap is enforced).
 *
 * Known gap: recordLetterCompletion evaluates attempt 3 only when the request
 * includes `attempts`; a request without them is not yet rejected.
 *
 * ── Why attempt 3 only ───────────────────────────────────────────────────
 * Attempts 1 and 2 are drawn WITH on-screen guidance, so best-of-3 certified
 * a guided drawing as independent writing. Stage A retrospective analysis of
 * pilot data (548 normal-learning attempts, 174 complete cycles):
 *
 *   attempt 1 mean 80.2   attempt 2 mean 82.1   attempt 3 mean 76.7
 *   best-of-3 mean 84.5  ->  +7.8 points of leniency over the unguided attempt
 *   attempt 3 was the best attempt in only 24.1% of cycles
 *
 * Attempts 1 and 2 are still captured, scored and reported; they simply
 * cannot master a letter.
 *
 * ── The threshold ────────────────────────────────────────────────────────
 * Default 70. NOT clinically validated — a pilot engineering default that
 * needs teacher/pilot validation. Resolved by
 * progressionThresholdResolver.js; a numeric `quality_threshold` in the
 * request currently overrides it (no bounds check).
 *
 * Chosen from a retrospective sensitivity sweep over Attempt-3-only scores
 * (79 letter-days; NOT a clinical trial, and NOT trained on this data):
 *
 *   T=55  attempt-3 pass 96.6%  mastered 88.6%   <- current global fallback,
 *                                                   so permissive it is inert
 *   T=65  attempt-3 pass 70.7%  mastered 78.5%
 *   T=68  attempt-3 pass 62.1%  mastered 75.9%
 *   T=70  attempt-3 pass 58.0%  mastered 72.2%   <- chosen
 *   T=72  attempt-3 pass 56.9%  mastered 72.2%   <- no gain over 70
 *   T=75  attempt-3 pass 51.1%  mastered 65.8%
 *
 * 70 is the SMALLEST defensible value: 72 buys strictness with no observed
 * benefit, and 75 nearly doubles homework on a dataset with only five
 * observed third cycles.
 *
 * Separate from progressionThresholdResolver.GLOBAL_DEFAULT (55), which still
 * serves its own fallback callers.
 */

const NORMAL_PRACTICE_MASTERY_THRESHOLD = 70;

/** The mastery attempt (1-based, matches LetterAttempt.attempt_number). */
const MASTERY_ATTEMPT_NUMBER = 3;

const ATTEMPTS_PER_CYCLE = 3;

/**
 * Progression family thresholds -> automatic mastery gating.
 *
 * DISABLED for the pilot, deliberately and reversibly.
 *
 * The Motor Score calibration audit found the authoritative shape scores
 * that produce StudentMotorBaseline.progression_* are systematically higher
 * than the legacy scores computed from the SAME trajectories (mean +25
 * points, up to +60), driven by:
 *   - pause / direction / speed contributing a near-fixed +40 (saturated on
 *     91-95% of rows)
 *   - DTW_MAX_NORM = 45 against a shape dtw_distance P90 of 16.15
 *   - SMOOTHNESS_MAX_RAD = 1.0 against an observed P90 of ~0.20
 *   - computeMotorScore preferring `accuracy_score` (a radial-distance
 *     proxy the frontend itself labels diagnostic-only) over DTW for shapes
 *
 * Those baselines are therefore not yet trustworthy as the SOURCE of a
 * mastery threshold. This flag only stops progression_* from setting the
 * mastery threshold; baselines and threshold history are still computed and
 * stored. Re-enable once Motor Score calibration is validated (no migration
 * needed).
 */
const PROGRESSION_FAMILY_THRESHOLDS_ENABLED = false;

/**
 * Records which policy awarded a mastery. Older rows carry no marker and
 * remain valid under the best-of-3 policy of their time; they are never
 * rewritten.
 */
const MASTERY_POLICY_VERSION = 'attempt3-only-3cycle-v1';

/** The policy that produced every mastery row written before the above. */
const LEGACY_MASTERY_POLICY_VERSION = 'best-of-3-2cycle-v0';

/** Stable reason vocabulary for why a cycle did not master. */
const MASTERY_FAIL_REASON = {
  BELOW_THRESHOLD:        'attempt3_below_threshold',
  // A genuinely captured trajectory that did not cover enough of the canvas.
  // The child wrote something; it was not enough. An EVALUATED failure.
  COVERAGE_INVALID:       'attempt3_coverage_invalid',
  ATTEMPT_MISSING:        'attempt3_missing',
  SCORE_UNAVAILABLE:      'attempt3_score_unavailable',
  // The device never captured the attempt (no strokes or no features). Not a
  // handwriting judgement, so it must never cost the child a practice cycle.
  CAPTURE_INCOMPLETE:     'attempt3_capture_incomplete',
};

/**
 * Did the system actually get to judge this cycle's handwriting?
 *
 *   'evaluated'         a real attempt 3 was scored — pass or fail, the cycle
 *                       counts. Covers below-threshold AND coverage-invalid.
 *   'capture_incomplete' nothing was captured; there was nothing to judge, so
 *                       the cycle must NOT count.
 */
const EVALUATION_STATUS = {
  EVALUATED:          'evaluated',
  CAPTURE_INCOMPLETE: 'capture_incomplete',
};

/**
 * Whether a failed cycle uses up one of the day's three (reported to the
 * client as `cycle_consumed`).
 *
 * True for every EVALUATED outcome, including a coverage failure — a tiny or
 * off-target real drawing is handwriting evidence. False only for a capture
 * fault.
 *
 * A network failure never reaches this function: the client receives no
 * response, consumes no cycle, and keeps the child on attempt 3 to resubmit
 * (LetterWritingScreen.js). If the request did reach the server, its rows
 * count towards the server's per-date cycle total on the next submission.
 */
function cycleIsConsumed(failReason) {
  return failReason !== MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE;
}

/**
 * Branch labels for [NORMAL_LETTER_CYCLE] logging (logging only; the client
 * performs the retry, warm-up and advance).
 */
const CYCLE_BRANCH = {
  MASTERED_ADVANCE:             'MASTERED_ADVANCE',
  FAILED_START_CYCLE_2:         'FAILED_START_CYCLE_2',
  FAILED_START_CYCLE_3:         'FAILED_START_CYCLE_3',
  FAILED_ADVANCE_AFTER_CYCLE_3: 'FAILED_ADVANCE_AFTER_CYCLE_3',
};

module.exports = {
  NORMAL_PRACTICE_MASTERY_THRESHOLD,
  MASTERY_ATTEMPT_NUMBER,
  ATTEMPTS_PER_CYCLE,
  PROGRESSION_FAMILY_THRESHOLDS_ENABLED,
  MASTERY_POLICY_VERSION,
  LEGACY_MASTERY_POLICY_VERSION,
  MASTERY_FAIL_REASON,
  EVALUATION_STATUS,
  cycleIsConsumed,
  CYCLE_BRANCH,
};
