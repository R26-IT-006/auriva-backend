'use strict';

/**
 * persistentDifficultyPolicy.js
 *
 * Feature 7 Step 2 — Persistent-Difficulty Vocabulary + Windowing Policy.
 *
 * PURE POLICY/CONFIGURATION ONLY. No recommendation logic, no DB reads, no
 * network calls, not imported or called by any endpoint yet — no
 * persistent-difficulty endpoint, no frontend surface, no database table
 * exist as of this step. Exists so the vocabulary and windowing constants a
 * future Step 3 detection service will need are defined, named, and
 * testable BEFORE that service is built — the same discipline every prior
 * feature's own Step 2 already established (Feature 4's
 * preWritingFamilyMapping.js, Feature 5's repetitionPolicy.js, Feature 6's
 * demoSpeedPolicy.js).
 *
 * ── What "persistent" means here ──────────────────────────────────────────
 * `persistent` means: this software's own longitudinal practice evidence
 * shows the same educational handwriting difficulty recurring across TWO
 * separate, complete, temporally-distinct evidence windows. It is NOT a
 * diagnosis. It never means motor impairment, ASD severity, or any
 * developmental-disorder classification — it describes a pattern observed
 * in practice data only (Step 1 audit §53).
 *
 * ── Why two windows, not one (non-circularity) ────────────────────────────
 * Feature 2's `support_review` and Feature 3's `support_review` are both
 * single-window, single-evaluation, re-simulated-fresh-every-time signals —
 * see the Step 1 audit §27. If Feature 7 called a student "persistent" from
 * one such window alone, it would add no new information over what Feature
 * 2/3/5/6 already expose instantaneously. Requiring the SAME difficulty
 * pattern in two independently-complete, non-overlapping windows, separated
 * by a minimum real-world time gap (see MIN_WINDOW_SEPARATION_MS below), is
 * what makes "persistent" a genuinely longitudinal claim rather than a
 * renamed instantaneous one.
 */

// ─── Status vocabulary ──────────────────────────────────────────────────────
// Exactly three. Deliberately NO 'emerging_difficulty' (an arbitrary
// intermediate tier the Step 1 audit found no technical justification for)
// and NO clinical severity tiers (mild/moderate/severe) — see Step 1 audit
// §24/§31.

const PERSISTENT_DIFFICULTY_STATUSES = Object.freeze({
  INSUFFICIENT_DATA: 'insufficient_data',
  NOT_PERSISTENT: 'not_persistent',
  PERSISTENT: 'persistent',
});

const VALID_PERSISTENT_DIFFICULTY_STATUSES = Object.freeze(Object.values(PERSISTENT_DIFFICULTY_STATUSES));

/**
 * @param {*} value
 * @returns {boolean} true only for the exact three status strings above.
 */
function isValidPersistentDifficultyStatus(value) {
  return typeof value === 'string' && VALID_PERSISTENT_DIFFICULTY_STATUSES.includes(value);
}

// ─── Reason vocabulary ──────────────────────────────────────────────────────
// Kept deliberately separate from `status` (Step 2 spec §45) — the public
// status stays simple (three values); the reason carries the diagnostic
// detail a future teacher-facing surface or CLI can display without
// widening the status vocabulary itself.

const PERSISTENT_DIFFICULTY_REASONS = Object.freeze({
  // insufficient_data reasons
  INSUFFICIENT_CYCLES: 'insufficient_cycles',
  INSUFFICIENT_TEMPORAL_DISPERSION: 'insufficient_temporal_dispersion',
  // persistent reason
  REPEATED_DIFFICULTY_ACROSS_WINDOWS: 'repeated_difficulty_across_windows',
  // not_persistent reasons
  RECENT_DIFFICULTY_NOT_YET_PERSISTENT: 'recent_difficulty_not_yet_persistent',
  RECENT_IMPROVEMENT: 'recent_improvement',
  NO_PERSISTENT_DIFFICULTY: 'no_persistent_difficulty',
});

const VALID_PERSISTENT_DIFFICULTY_REASONS = Object.freeze(Object.values(PERSISTENT_DIFFICULTY_REASONS));

/**
 * @param {*} value
 * @returns {boolean} true only for the exact reason strings above.
 */
function isValidPersistentDifficultyReason(value) {
  return typeof value === 'string' && VALID_PERSISTENT_DIFFICULTY_REASONS.includes(value);
}

// ─── Windowing policy ───────────────────────────────────────────────────────
//
// Pilot engineering defaults — NOT clinically validated, NOT autism-specific
// thresholds — same "explicit, centralized, never a scattered magic number"
// discipline as Feature 2's RECENT_FAMILY_WINDOW_SIZE/INITIAL_THRESHOLD_MARGIN,
// Feature 3's SUPPORT_PERFORMANCE_WINDOW_SIZE/SUPPORT_SUCCESS_MET_COUNT, and
// Feature 6's SLOW_SPEED_MULTIPLIER.

// Reuses Feature 2/3's existing window-size precedent exactly, for
// consistency across the whole adaptive system (Step 1 audit §25/§32).
const WINDOW_SIZE = 5;

// Two non-overlapping windows of WINDOW_SIZE each — see module header for
// why two, not one.
const REQUIRED_WINDOW_COUNT = 2;

// Derived, never duplicated as a second literal — the minimum count of
// USABLE (non-'unknown'-outcome) cycles needed before two complete windows
// can even be attempted.
const MIN_USABLE_CYCLES = WINDOW_SIZE * REQUIRED_WINDOW_COUNT; // 10

// A window is "difficult" when at most this many of its WINDOW_SIZE cycles
// succeeded — mirrors Feature 2's own "0 or 1 of 5 met target ->
// support_review" bar (dynamicThresholdService.js's metTargetCount < 2
// branch) exactly, expressed as its own named constant here rather than a
// re-derived magic number.
const DIFFICULTY_MAX_SUCCESSFUL_CYCLES = 1;

// ─── Temporal-dispersion safeguard (Step 2 spec §15-§17) ───────────────────
//
// The Step 1 audit found that a single continuous immediate-retry burst can
// produce many independent `session_key`s within minutes — two 5-cycle
// windows ALONE do not guarantee the two windows represent genuinely
// separate practice periods. This safeguard requires the first cycle of the
// recent window to occur at least this many milliseconds after the last
// cycle of the earlier window.
//
// 24 HOURS IS A CONSERVATIVE ENGINEERING/PILOT SEPARATION SAFEGUARD.
// IT IS NOT CLINICALLY VALIDATED. IT IS NOT AN AUTISM-SPECIFIC THRESHOLD.
// It exists solely to prevent one continuous retry burst from being
// misread as longitudinal persistence — see Step 1 audit §28/§47 and Step 2
// spec §15/§16. A shorter, data-driven X-minute "episode" heuristic was
// deliberately rejected (Step 2 spec §16): the Step 1 audit found no
// natural gap in live data to justify inventing one, whereas a flat
// earlier-period-vs-later-period boundary is simpler and fully auditable
// without reconstructing artificial session boundaries.
const MIN_WINDOW_SEPARATION_MS = 24 * 60 * 60 * 1000;

module.exports = {
  PERSISTENT_DIFFICULTY_STATUSES,
  VALID_PERSISTENT_DIFFICULTY_STATUSES,
  isValidPersistentDifficultyStatus,
  PERSISTENT_DIFFICULTY_REASONS,
  VALID_PERSISTENT_DIFFICULTY_REASONS,
  isValidPersistentDifficultyReason,
  WINDOW_SIZE,
  REQUIRED_WINDOW_COUNT,
  MIN_USABLE_CYCLES,
  DIFFICULTY_MAX_SUCCESSFUL_CYCLES,
  MIN_WINDOW_SEPARATION_MS,
};
