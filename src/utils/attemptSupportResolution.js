'use strict';

/**
 * attemptSupportResolution.js
 *
 * Feature 3 Step 4 — reconstructs a single LetterAttempt row's support
 * level for READ-ONLY performance-evidence purposes. Sibling to
 * src/utils/attemptPerformanceScore.js (same "pure, per-row reconstruction
 * helper" shape, same file location convention) — deliberately a separate
 * file rather than folded into adaptiveSupportService.js, so it stays
 * independently unit-testable and reusable outside that service.
 *
 * ── Priority order ───────────────────────────────────────────────────────
 *   1. explicit `support_level` (Feature 3 Step 3) — the authoritative,
 *      post-Feature-3 value. Always wins when present and valid, REGARDLESS
 *      of attempt_number — this is deliberate future-proofing: once real
 *      adaptive support exists, attempt_number and support_level will no
 *      longer move in lockstep (e.g. a future session could legitimately
 *      have attempt_number=1 + support_level='medium'), and this resolver
 *      must never silently prefer the old attempt-based guess over a real
 *      recorded value.
 *   2. historical attempt_number proxy (1→high, 2→medium, 3→low) — ONLY for
 *      normal-mode rows with no explicit value. This is an inference, not a
 *      recorded fact, so every result built this way is tagged
 *      `source: 'historical_attempt_proxy'`, never conflated with an
 *      explicit value.
 *
 * ── Collection-mode restriction ──────────────────────────────────────────
 * The historical proxy is NEVER applied to a `collection_mode: true` row,
 * even if this function is called on one directly. Collection-mode attempt
 * 3 has a protocol-specific rendering override (faded ghost guide still
 * visible — see Feature 3 Step 1 audit / Step 2's
 * `handwritingSupportLevels.js` collection-protocol-exception section) that
 * does not match any single support tier's normal-mode presentation, so
 * guessing from attempt_number there would fabricate evidence. In practice
 * adaptiveSupportService.js filters `collection_mode: false` at the query
 * level BEFORE any row ever reaches this function (see that file), so this
 * check is defense-in-depth — this function is correct on its own even if
 * called directly on an unfiltered row, not only correct because of caller
 * discipline elsewhere.
 *
 * An explicit, valid `support_level` on a collection-mode row (should one
 * ever exist) still resolves normally — only the FALLBACK proxy is
 * collection-restricted, never a real recorded value.
 */

const { isValidLetterSupportLevel } = require('../config/letterSupportLevels');

const SUPPORT_SOURCE = Object.freeze({
  EXPLICIT: 'explicit_support_level',
  HISTORICAL_PROXY: 'historical_attempt_proxy',
});

// Single terminal reason for every unresolvable case, matching the Step 4
// spec's example contract exactly. Each call site below is commented with
// WHY it reached this reason — deliberately not split into multiple reason
// strings, since the spec's own recommended shape only names this one value
// and inventing new vocabulary wasn't asked for.
const REASON_UNRESOLVABLE = 'unresolvable_support';

/**
 * @param {{
 *   support_level?: string|null,
 *   attempt_number?: number,
 *   collection_mode?: boolean,
 * }} letterAttempt — a LetterAttempt row (or plain object with the same
 *   shape — this function never touches Sequelize instance methods).
 * @returns {
 *   {status: 'resolved', supportLevel: 'high'|'medium'|'low', source: string}
 *   | {status: 'invalid', supportLevel: null, reason: string}
 * }
 */
function resolveAttemptSupportLevel(letterAttempt) {
  const explicit = letterAttempt?.support_level;

  if (explicit != null) {
    if (isValidLetterSupportLevel(explicit)) {
      return { status: 'resolved', supportLevel: explicit, source: SUPPORT_SOURCE.EXPLICIT };
    }
    // Present but not one of high/medium/low — never guessed via the
    // attempt-number proxy. A corrupted/unexpected explicit value is a
    // reason to distrust the row, not a reason to fall back further.
    return { status: 'invalid', supportLevel: null, reason: REASON_UNRESOLVABLE };
  }

  // explicit is null/undefined — attempt the historical proxy, but only for
  // normal-mode rows (see module header).
  if (letterAttempt?.collection_mode === true) {
    return { status: 'invalid', supportLevel: null, reason: REASON_UNRESOLVABLE };
  }

  const attemptNumber = letterAttempt?.attempt_number;
  if (attemptNumber === 1) return { status: 'resolved', supportLevel: 'high',   source: SUPPORT_SOURCE.HISTORICAL_PROXY };
  if (attemptNumber === 2) return { status: 'resolved', supportLevel: 'medium', source: SUPPORT_SOURCE.HISTORICAL_PROXY };
  if (attemptNumber === 3) return { status: 'resolved', supportLevel: 'low',    source: SUPPORT_SOURCE.HISTORICAL_PROXY };

  // No explicit value and attempt_number is not 1/2/3 (0, 4, null,
  // undefined, a string, etc.) — nothing left to resolve from.
  return { status: 'invalid', supportLevel: null, reason: REASON_UNRESOLVABLE };
}

module.exports = { SUPPORT_SOURCE, resolveAttemptSupportLevel };
