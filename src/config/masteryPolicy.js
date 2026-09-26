'use strict';

/**
 * masteryPolicy.js
 *
 * The NORMAL LETTER PRACTICE mastery policy, in one place.
 *
 * ── The policy ───────────────────────────────────────────────────────────
 *   Cycle 1: attempts 1 (high support), 2 (reduced), 3 (independent)
 *            evaluate ONLY attempt 3
 *            pass -> mastered -> next letter
 *            fail -> Cycle 2
 *   Cycle 2: same, fail -> Cycle 3
 *   Cycle 3: same, fail -> advance UNMASTERED + exact-letter home practice
 *
 *   Maximum 3 cycles x 3 attempts = 9 attempts per letter / case / practice date.
 *
 * ── Why attempt 3 only ───────────────────────────────────────────────────
 * Attempts 1 and 2 are drawn WITH on-screen guidance. Mastering on the best
 * of the three therefore certified a guided drawing as independent writing.
 * The Stage A retrospective analysis measured exactly that on real pilot
 * data (548 normal-learning attempts, 174 complete cycles):
 *
 *   attempt 1 mean 80.2   attempt 2 mean 82.1   attempt 3 mean 76.7
 *   best-of-3 mean 84.5  ->  +7.8 points of leniency over the unguided attempt
 *   attempt 3 was the best attempt in only 24.1% of cycles
 *
 * i.e. roughly three quarters of masteries under the old rule were awarded
 * on a guided attempt. Scores drop 5.4 points when the guide is removed —
 * which is precisely the signal this policy exists to measure.
 *
 * Attempts 1 and 2 are still captured, still scored, and still available to
 * reports and motor analysis. They simply cannot master a letter.
 *
 * ── The threshold ────────────────────────────────────────────────────────
 * NOT clinically validated. A pilot engineering default in the same
 * tradition as Feature 2's +5 margin and the practice-cycle cap — it needs
 * teacher/pilot validation before it can be called anything more.
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
 * Deliberately its own constant, NOT a reuse of
 * progressionThresholdResolver.GLOBAL_DEFAULT (55) — that constant is
 * unchanged and still serves its own callers.
 */

const NORMAL_PRACTICE_MASTERY_THRESHOLD = 70;

/**
 * Which attempt in a cycle is the mastery attempt. 1-based, matching
 * LetterAttempt.attempt_number and the on-screen attempt counter.
 */
const MASTERY_ATTEMPT_NUMBER = 3;

/** Attempts per cycle. */
const ATTEMPTS_PER_CYCLE = 3;

/**
 * Feature 2 progression family thresholds -> automatic mastery gating.
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
 * mastery threshold. This flag disconnects that one operational link and
 * nothing else:
 *
 *   STILL HAPPENS: baselines are computed and stored, threshold history is
 *                  preserved, provenance is intact, the initial assessment
 *                  UI is untouched, research/calibration use continues.
 *   STOPS:         progression_* automatically setting the value a child's
 *                  letter mastery is judged against.
 *
 * Flip back to `true` once Motor Score calibration is validated. Nothing is
 * deleted, so re-enabling needs no migration.
 */
const PROGRESSION_FAMILY_THRESHOLDS_ENABLED = false;

/**
 * Stamped on mastery evidence so a future reader can tell WHICH policy
 * awarded a given mastery. Existing rows predate this and carry no marker —
 * they remain historical truth under the best-of-3 policy that was in force
 * when they were written, and are never rewritten.
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
  // The device never captured the attempt at all — no strokes, or no
  // features. NOT a handwriting judgement, and deliberately distinct from
  // COVERAGE_INVALID, which it used to be silently folded into. A child must
  // never lose a practice cycle to a capture fault.
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
 * Whether a failed cycle uses up one of the day's three.
 *
 * True for every EVALUATED outcome, including a coverage failure — a tiny or
 * off-target real drawing is handwriting evidence and consumes a cycle
 * exactly as a below-threshold score does.
 *
 * False only for a capture fault, and note the asymmetry that leaves: a
 * NETWORK failure still consumes a cycle client-side. That is deliberate.
 * The request may well have reached the server and been recorded; not
 * consuming would permit unbounded retries against a server that already
 * counted the cycle. The server's own per-date count reconciles the state on
 * the next entry or restart, because it is the authority.
 */
function cycleIsConsumed(failReason) {
  return failReason !== MASTERY_FAIL_REASON.CAPTURE_INCOMPLETE;
}

/** Branch labels used by the decision and by [NORMAL_LETTER_CYCLE] logging. */
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
