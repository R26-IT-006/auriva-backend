'use strict';

/**
 * demoSpeedPolicy.js
 *
 * Feature 6 Step 2 — Formal Demonstration-Speed Vocabulary + Timing-Data
 * Trust Model.
 *
 * PURE POLICY/CONFIGURATION ONLY. This file contains no recommendation
 * logic, no DB reads, no network calls, and is not imported or called by
 * anything else in this codebase yet — no recommendation endpoint, no
 * frontend fetch, no tracer behavior change exist as of this step. It
 * exists so the vocabulary and trust rules a future Step 3 recommendation
 * service will need are defined, named, and testable BEFORE that service
 * is built — the same discipline every prior feature's own Step 2 already
 * established (Feature 4's preWritingFamilyMapping.js, Feature 5's
 * repetitionPolicy.js).
 *
 * ── Direction (Step 1 audit, confirmed) ──────────────────────────────────
 * Feature 6 only ever REDUCES demonstration speed below the existing,
 * already-deployed presentation. There is no "faster than current" level —
 * `STANDARD` IS today's exact behavior, not a lesser option among several.
 *
 * ── Speed vs duration — do not confuse the two ──────────────────────────
 * `SLOW_SPEED_MULTIPLIER = 0.75` means the tracer moves at 75% of its
 * current pixel-per-millisecond velocity — approximately 25% slower
 * velocity. Because `duration = arcLength / speed`, a 0.75× speed produces
 * a `1 / 0.75 ≈ 1.333×` (≈33% LONGER) duration for the same stroke — these
 * are related but NOT the same percentage. See demoSpeedLevels.js
 * (frontend) for the actual duration formula this implies; nothing here
 * computes a duration itself, since the backend never needs canvas pixels
 * or Animated.timing (Step 2 spec §9/§12).
 *
 * ── Pilot-status ──────────────────────────────────────────────────────────
 * The 0.75 multiplier is a conservative engineering/pilot default — NOT
 * clinically validated, NOT a therapeutic threshold, NOT an autism
 * diagnostic parameter, and requires teacher/pilot validation before any
 * stronger claim is made about it, exactly like Feature 2's +5 margin,
 * Feature 3's 4-of-5 success rule, and Feature 5's 1-repeat cap.
 */

// ─── Vocabulary ─────────────────────────────────────────────────────────────
// Exactly two levels. Deliberately NO 'fast', NO 'very_slow', NO 'medium' —
// Feature 6 never speeds a child up, and a conservative MVP does not need
// more than one reduced tier (Step 1 audit §26/§58).

const DEMO_SPEED_LEVELS = Object.freeze({
  STANDARD: 'standard',
  SLOW: 'slow',
});

const VALID_DEMO_SPEED_LEVELS = Object.freeze(Object.values(DEMO_SPEED_LEVELS));

// The safe fallback for absolutely everything: invalid recommendation,
// network failure, backend error, malformed response, unsupported level.
// Feature 6 failing in any way must always reproduce today's exact,
// current behavior (Step 2 spec §41) — never a guessed level, never SLOW
// by default.
const DEFAULT_DEMO_SPEED_LEVEL = DEMO_SPEED_LEVELS.STANDARD;

/**
 * @param {*} value
 * @returns {boolean} true only for the exact strings 'standard'|'slow' —
 *   never coerced (a number, boolean, or differently-cased/spelled string
 *   is rejected).
 */
function isValidDemoSpeedLevel(value) {
  return typeof value === 'string' && VALID_DEMO_SPEED_LEVELS.includes(value);
}

// ─── Reason vocabulary ──────────────────────────────────────────────────────
// Mirrors Feature 4/5's exact reason-vocabulary shape and priority
// philosophy (Step 2 spec §33/§34/§35) — defined now as the formal
// contract a future Step 3 service will return, not yet produced by any
// running code.

const DEMO_SPEED_REASONS = Object.freeze({
  FEATURE3_SUPPORT_REVIEW: 'feature3_support_review',
  FEATURE2_SUPPORT_REVIEW: 'feature2_support_review',
  NO_PERSISTENT_DIFFICULTY: 'no_persistent_difficulty',
  INSUFFICIENT_DATA: 'insufficient_data',
  INSUFFICIENT_TARGET: 'insufficient_target',
  NOT_APPLICABLE: 'not_applicable',
});

// The only two signals a future Step 3 recommendation may use as its
// TRIGGER (Step 2 spec §32/§33) — both already require a COMPLETE
// family-level evidence window in their own owning feature (Feature 2/3),
// reused as-is. No new Feature 6 performance window is ever built.
//   Feature 3 support_review — even HIGH visual guidance has not produced
//     sufficient family-level performance; slowing the demonstration is a
//     reasonable next software-support adaptation to test (engineering
//     rationale, not a clinical rule).
//   Feature 2 support_review — independent performance remains below the
//     current family target across a complete window.
// Priority when both fire: FEATURE3_SUPPORT_REVIEW (mirrors Feature 4/5's
// own identical priority choice and rationale).
const APPROVED_MVP_TRIGGER_SIGNALS = Object.freeze([
  DEMO_SPEED_REASONS.FEATURE3_SUPPORT_REVIEW,
  DEMO_SPEED_REASONS.FEATURE2_SUPPORT_REVIEW,
]);

// ─── Collection-mode policy ─────────────────────────────────────────────────
// Collection mode is never adaptive for ANY feature in this codebase
// (Feature 2/3/4/5 all already enforce this). Feature 6 reserves the same
// invariant: collection mode's tracer (where currently shown) always uses
// STANDARD — no adaptive SLOW recommendation may ever apply there.
const COLLECTION_DEMO_SPEED_LEVEL = DEMO_SPEED_LEVELS.STANDARD;

// ─── Timing-data trust model (Step 2 spec §23-§31) ─────────────────────────
//
// MVP_TIMING_SIGNALS_ENABLED = false: none of the timing-derived features
// below are approved MVP recommendation triggers, despite being technically
// trustworthy MEASUREMENTS (Step 1 audit confirmed their formulas/units/
// data quality are sound). "Trustworthy to measure" and "validated as a
// decision signal" are two different questions — only the latter gates
// MVP use, and none of these have cleared that bar yet.
const MVP_TIMING_SIGNALS_ENABLED = false;

// One entry per timing-derived feature the Step 1 audit inventoried.
// `trust` describes measurement reliability; `approvedMvpTrigger` is
// always false in Step 2 — this table exists so a future step (or a
// reviewer) never has to re-derive "is this safe to use" from scattered
// prose, and so a test can assert the policy explicitly rather than by
// absence of code.
const TIMING_SIGNAL_TRUST = Object.freeze({
  attempt_duration_ms: Object.freeze({
    trust: 'MEASUREMENT_TRUSTED',
    approvedMvpTrigger: false,
    reason: 'confounded by path length, stroke count, careful writing, hesitation, and letter '
      + 'complexity — long duration does not by itself mean a slower demo is needed (Step 1 audit §22)',
  }),
  attempt_avg_speed: Object.freeze({
    trust: 'MEASUREMENT_TRUSTED',
    approvedMvpTrigger: false,
    reason: 'ADAPTATION_SIGNAL_EXPERIMENTAL — the total_distance/attempt_duration_ms formula and '
      + 'px/ms unit are reliable, but no validated Feature 6 decision rule exists yet (Step 1 audit §23/§25)',
  }),
  attempt_pause_frequency: Object.freeze({
    trust: 'MEASUREMENT_TRUSTED',
    approvedMvpTrigger: false,
    reason: 'SIGNAL_STRENGTH_NOT_YET_VALIDATED — a real, consistently-derived signal, but live '
      + 'evidence is currently too sparse to assess its strength (Step 1 audit §24/§26)',
  }),
  attempt_pause_duration_ratio: Object.freeze({
    trust: 'MEASUREMENT_TRUSTED',
    approvedMvpTrigger: false,
    reason: 'SIGNAL_STRENGTH_NOT_YET_VALIDATED — same rationale as attempt_pause_frequency',
  }),
  'features.duration_ms': Object.freeze({
    trust: 'NOT_APPROVED',
    approvedMvpTrigger: false,
    reason: 'legacy stroke-local-t duration (aka completionTime) undercounts multi-stroke attempts '
      + '— reflects only the LAST stroke\'s own elapsed time, never the whole attempt\'s wall-clock '
      + 'span. Never an approved Feature 6 signal, in MVP or later (Step 2 spec §29).',
  }),
});

module.exports = {
  DEMO_SPEED_LEVELS,
  VALID_DEMO_SPEED_LEVELS,
  DEFAULT_DEMO_SPEED_LEVEL,
  isValidDemoSpeedLevel,
  DEMO_SPEED_REASONS,
  APPROVED_MVP_TRIGGER_SIGNALS,
  COLLECTION_DEMO_SPEED_LEVEL,
  MVP_TIMING_SIGNALS_ENABLED,
  TIMING_SIGNAL_TRUST,
};
