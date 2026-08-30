'use strict';

/**
 * repetitionPolicy.js
 *
 * Feature 5 Step 2 — the single, authoritative, explicit repetition cap and
 * reason vocabulary. Centralized here (not scattered as a magic number
 * inside the service) so a future adjustment is a deliberate, visible diff,
 * matching the exact discipline Feature 2's INITIAL_THRESHOLD_MARGIN and
 * Feature 3's SUPPORT_SUCCESS_MET_COUNT already established.
 *
 * ── Why a cap exists at all ──────────────────────────────────────────────
 * Feature 5 Step 1's audit found NO existing maximum anywhere in this
 * codebase on same-letter retries or repeated practice — see that audit's
 * §5/§36. Before any automatic spaced-repetition behavior can be built
 * (Step 3+), a small, explicit, conservative cap MUST exist. This is that
 * cap — defined now, before any reinsertion logic exists to need it.
 *
 * ── What this cap does NOT do ────────────────────────────────────────────
 * It does not limit the EXISTING immediate same-letter retry (still
 * unbounded — Feature 5 Step 1 §5, deliberately left untouched, see this
 * step's own report §32/§37). It only bounds a FUTURE Feature 5 behavior
 * (automatic spaced reinsertion) that does not exist in runtime code yet —
 * Step 2 only defines and reads this policy; nothing enforces it yet.
 *
 * ── Pilot engineering default — NOT clinically validated ─────────────────
 * MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION = 1 is a conservative
 * starting point (Step 2 spec §18/§19), exactly like Feature 2's +5 margin
 * or Feature 3's 4-of-5 rule — an engineering safety rule requiring
 * teacher/pilot validation, not a clinical prescription.
 */

const MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION = 1;

// Stable reason vocabulary (Step 2 spec §6) — never an overloaded generic string.
const REPETITION_REASON = {
  FEATURE3_SUPPORT_REVIEW: 'feature3_support_review',
  FEATURE2_SUPPORT_REVIEW: 'feature2_support_review',
  NO_PERSISTENT_DIFFICULTY: 'no_persistent_difficulty',
  INSUFFICIENT_DATA: 'insufficient_data',
  INSUFFICIENT_TARGET: 'insufficient_target',
  NOT_APPLICABLE: 'not_applicable',
  CAP_REACHED: 'cap_reached',
};

module.exports = {
  MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION,
  REPETITION_REASON,
};
