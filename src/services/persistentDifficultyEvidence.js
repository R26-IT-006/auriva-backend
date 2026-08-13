'use strict';

/**
 * persistentDifficultyEvidence.js
 *
 * Feature 7 Step 2 — Historical Evidence Reconstruction (pure helpers) +
 * ONE narrow read-only candidate-cycle query.
 *
 * Mirrors Feature 2's dynamicThresholdService.js's own "pure derivation
 * functions + one narrow read-only query, no decision endpoint yet" shape
 * from its own Step 2/4. This file builds the reusable building blocks a
 * future Step 3 persistentDifficultyService.js will compose — it does NOT
 * itself expose a single "evaluate persistent difficulty for this student"
 * entry point, does NOT touch a database WRITE path, and does NOT get
 * called from any controller/route yet (Step 2 spec §29).
 *
 * ── Non-circularity (Step 1 audit §27, Step 2 spec §20) ───────────────────
 * Feature 2 and Feature 3 both compute a fresh, single-window decision
 * every time they're called (`support_review` etc.) — see
 * dynamicThresholdService.js/adaptiveSupportService.js, untouched by this
 * file. This module deliberately does NOT call either of those services'
 * CURRENT-decision functions (evaluateDynamicThresholds/
 * evaluateSupportRecommendations) as a substitute for historical
 * reconstruction — doing so would just relabel their own instantaneous
 * signal as "persistent" with no new information. Instead, every helper
 * below reconstructs outcomes directly from each LetterAttempt row's OWN
 * historical `best_score`/`threshold` pair (Step 2 spec §9/§13), which
 * remains meaningful even when a student currently has NO Feature 2 family
 * target at all (`no_target`) — see reconstructCycleOutcome()'s own header
 * and the Step 1 audit's Student 10 finding (26 clean historical cycles,
 * zero current Feature 2 target).
 *
 * ── What this module never does ────────────────────────────────────────────
 *   - never calls LetterAttempt/LetterProgress/ThresholdHistory/ShapeFeature/
 *     StudentMotorBaseline .create/.bulkCreate/.update/.destroy/.save/
 *     .increment, never opens a transaction — fully read-only (see
 *     tests/persistentDifficultyEvidenceReadOnly.test.js);
 *   - never calls getCurrentFamilyThreshold()/evaluateDynamicThresholds()/
 *     evaluateSupportRecommendations() — no current-Feature-2/3-decision
 *     dependency anywhere in this file (see the no-current-threshold
 *     source-scan test);
 *   - never reads LetterProgress.blocked_attempts (a lifetime, never-reset,
 *     immediate-retry-contaminated legacy counter — Step 1 audit §6, Step 2
 *     spec §43) or any raw timing feature (attempt_duration_ms/
 *     attempt_avg_speed/pause metrics — Step 2 spec §42) as a trigger input;
 *   - never merges lowercase and uppercase evidence for the same family
 *     (Step 2 spec §3) — every helper below keeps `caseType` a first-class
 *     dimension throughout, exactly like every other feature in this
 *     codebase already does;
 *   - never guesses a family for an ambiguous (getBaselineFamily === null)
 *     letter (Step 2 spec §4) — ambiguous letters are excluded outright,
 *     never given a letter-only fallback path.
 *
 * ── Research framing ────────────────────────────────────────────────────────
 * A `persistent` result means: "this software's own longitudinal practice
 * data shows the same educational handwriting difficulty recurring across
 * two separate, complete, time-separated evidence windows." Not a clinical
 * treatment, not a motor diagnosis, not an ASD-severity classification. See
 * persistentDifficultyPolicy.js's own header for the full framing.
 */

const { LetterAttempt } = require('../models');
const { getBaselineFamily } = require('../config/letterBaselineFamilies');
const {
  WINDOW_SIZE, MIN_USABLE_CYCLES, DIFFICULTY_MAX_SUCCESSFUL_CYCLES, MIN_WINDOW_SEPARATION_MS,
  PERSISTENT_DIFFICULTY_STATUSES, PERSISTENT_DIFFICULTY_REASONS,
} = require('../config/persistentDifficultyPolicy');
const logger = require('../utils/logger');

// A candidate row for Feature 7 longitudinal evidence is:
//   - attempt_number === 3      — the same "closest proxy to independent
//     performance" Feature 2 already established (Step 1 audit §3/§10,
//     Step 2 spec §6/§7) — attempts 1/2 of the same cycle are support-
//     assisted and must never be counted as separate observations.
//   - collection_mode === false — a fixed research-protocol capture must
//     never contribute to persistent-difficulty evidence (Step 2 spec §5).
//   - capture_status === 'complete' — incomplete/abandoned/network_failed
//     rows never had a full, real writing attempt behind them.
const CANDIDATE_ATTEMPT_NUMBER = 3;
const CANDIDATE_CAPTURE_STATUS = 'complete';

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isUsableNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toTimestampMs(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// ─── reconstructCycleOutcome — pure, per-cycle ─────────────────────────────

/**
 * Reconstructs one cycle's success/failure outcome from ITS OWN historical
 * `best_score`/`threshold` pair — never the current Feature 2 family target
 * (Step 2 spec §8/§9, a hard Feature 7 invariant). `threshold_passed` is
 * used only as a fallback when the score/threshold pair itself is
 * unusable (Step 1 audit §11 found `threshold_passed` is null on ~68% of
 * live deduped cycles even when `best_score`/`threshold` are both present
 * and directly comparable — recomputing is strictly more complete than
 * trusting the stored boolean alone).
 *
 * Numbers are never coerced from strings — same "typeof, never parseFloat"
 * discipline as every other numeric guard in this codebase
 * (isPositiveInteger() above, deriveAttemptPerformanceScore() elsewhere).
 * `NaN`/`Infinity` both fail `Number.isFinite` and are therefore rejected,
 * falling through to the `threshold_passed` fallback (or `'unknown'` if
 * that too is unusable) — a corrupted numeric value is never silently
 * treated as a valid score.
 *
 * @param {{best_score?: *, threshold?: *, threshold_passed?: boolean|null}} cycle
 * @returns {'success'|'failure'|'unknown'}
 */
function reconstructCycleOutcome({ best_score, threshold, threshold_passed } = {}) {
  if (isUsableNumber(best_score) && isUsableNumber(threshold)) {
    return best_score >= threshold ? 'success' : 'failure';
  }
  if (threshold_passed === true) return 'success';
  if (threshold_passed === false) return 'failure';
  return 'unknown';
}

// ─── dedupeCompletedCycles — pure ──────────────────────────────────────────

/**
 * Deduplicates candidate attempt-3 rows by `session_key`, mirroring Feature
 * 2's own `fetchFamilyWindow()` dedup rule EXACTLY (Step 2 spec §27):
 * rows are walked NEWEST FIRST (`created_at` DESC, `id` DESC as the
 * deterministic tiebreak — Feature 2's own documented reason: live data
 * confirms rows from the same bulkCreate() call frequently share an
 * identical `created_at`), and the FIRST row seen for a given
 * `session_key` wins; any further row sharing that `session_key` is a
 * genuine duplicate (the data-quality anomaly Feature 2's own audit found)
 * and is counted, never silently kept.
 *
 * @param {Array<Object>} rows — raw candidate rows (any order).
 * @returns {{cycles: Array<Object>, duplicateCount: number}} `cycles` is
 *   newest-first, one row per distinct `session_key`.
 */
function dedupeCompletedCycles(rows) {
  const sorted = [...rows].sort((a, b) => {
    const byTime = (toTimestampMs(b.created_at) ?? 0) - (toTimestampMs(a.created_at) ?? 0);
    if (byTime !== 0) return byTime;
    return (b.id ?? 0) - (a.id ?? 0);
  });

  const seenSessionKeys = new Set();
  const cycles = [];
  let duplicateCount = 0;

  for (const row of sorted) {
    if (seenSessionKeys.has(row.session_key)) { duplicateCount++; continue; }
    seenSessionKeys.add(row.session_key);
    cycles.push(row);
  }

  return { cycles, duplicateCount };
}

// ─── buildFamilyCaseEvidence — pure ────────────────────────────────────────

/**
 * Filters + dedupes + reconstructs one (caseType, family) evidence stream
 * from a pool of raw candidate rows (any letters/case types mixed
 * together — e.g. the full output of fetchCandidateCycles() below).
 *
 * Defense-in-depth (Step 2 spec §5, mirroring
 * attemptSupportResolution.js's own "correct on its own even if called
 * directly on an unfiltered row, not only correct because of caller
 * discipline elsewhere" principle): collection-mode, non-'complete', and
 * non-attempt-3 rows are re-excluded HERE too, even though
 * fetchCandidateCycles() already filters all three at the query level —
 * this function is provably safe to call on any raw attempt array, not
 * just the query's own output, which is also what keeps it independently
 * unit-testable without a database.
 *
 * Ambiguous letters (`getBaselineFamily(...) === null`) are excluded
 * outright (Step 2 spec §4) — never given a letter-only fallback. Rows
 * whose OWN `case_type` doesn't match the requested `caseType` are also
 * excluded — lowercase and uppercase evidence for the same family are
 * never mixed into one stream (Step 2 spec §3/§32).
 *
 * @param {Object} params
 * @param {Array<Object>} params.attempts — raw candidate rows.
 * @param {'lowercase'|'uppercase'} params.caseType
 * @param {'straight'|'curved'|'complex'} params.family
 * @returns {{
 *   caseType: string, family: string,
 *   cycles: Array<{attemptId: number, sessionKey: string, letter: string,
 *     caseType: string, family: string, createdAt: Date, outcome: string}>,
 *   duplicateCount: number, ambiguousExcludedCount: number, otherCaseExcludedCount: number,
 *   nonCandidateExcludedCount: number,
 * }} `cycles` is sorted chronologically ASCENDING (oldest first) — the
 *   order splitLongitudinalWindows() below expects.
 */
function buildFamilyCaseEvidence({ attempts, caseType, family }) {
  let ambiguousExcludedCount = 0;
  let otherCaseExcludedCount = 0;
  let nonCandidateExcludedCount = 0;

  const candidates = (attempts ?? []).filter((row) => {
    if (row.collection_mode === true
      || row.capture_status !== CANDIDATE_CAPTURE_STATUS
      || row.attempt_number !== CANDIDATE_ATTEMPT_NUMBER) {
      nonCandidateExcludedCount++;
      return false;
    }
    if (row.case_type !== caseType) { otherCaseExcludedCount++; return false; }
    const rowFamily = getBaselineFamily(row.letter, row.case_type);
    if (rowFamily !== family) {
      if (rowFamily == null) ambiguousExcludedCount++;
      return false;
    }
    return true;
  });

  const { cycles: dedupedNewestFirst, duplicateCount } = dedupeCompletedCycles(candidates);

  // Chronological ASCENDING for windowing (splitLongitudinalWindows below
  // needs oldest-first so "the latest N" is a simple tail slice).
  const cycles = [...dedupedNewestFirst]
    .sort((a, b) => (toTimestampMs(a.created_at) ?? 0) - (toTimestampMs(b.created_at) ?? 0) || (a.id ?? 0) - (b.id ?? 0))
    .map((row) => ({
      attemptId: row.id,
      sessionKey: row.session_key,
      letter: row.letter,
      caseType: row.case_type,
      family,
      createdAt: row.created_at,
      outcome: reconstructCycleOutcome(row),
    }));

  return { caseType, family, cycles, duplicateCount, ambiguousExcludedCount, otherCaseExcludedCount, nonCandidateExcludedCount };
}

// ─── splitLongitudinalWindows — pure ───────────────────────────────────────

/**
 * Splits a chronologically-ascending cycle list into two non-overlapping
 * windows of WINDOW_SIZE (Step 2 spec §13/§14): `earlierWindow` = the 5
 * usable cycles immediately preceding `recentWindow`; `recentWindow` = the
 * latest 5 usable cycles overall. Never a sliding/overlapping window (Step
 * 2 spec §14 explicitly rejects cycles 1-5 + 2-6 style overlap).
 *
 * Cycles whose `outcome === 'unknown'` are skipped entirely before
 * windowing (Step 2 spec §25) — they never occupy one of the 10 required
 * slots; the function reaches further back in `cycles` to find a
 * replacement usable cycle instead, up to the full length of the list
 * provided (Step 2 spec §26/§38 — "continue backward ... if possible").
 *
 * @param {Array<{outcome: string}>} cycles — chronologically ASCENDING,
 *   as returned by buildFamilyCaseEvidence().
 * @returns {{
 *   status: 'ok'|'insufficient',
 *   usableCount: number, unknownCount: number,
 *   earlierWindow: Array<Object>|null, recentWindow: Array<Object>|null,
 * }}
 */
function splitLongitudinalWindows(cycles) {
  const list = cycles ?? [];
  const usable = list.filter((c) => c.outcome !== 'unknown');
  const unknownCount = list.length - usable.length;

  if (usable.length < MIN_USABLE_CYCLES) {
    return { status: 'insufficient', usableCount: usable.length, unknownCount, earlierWindow: null, recentWindow: null };
  }

  // "Latest 10 usable cycles" (Step 2 spec §34) — older usable cycles
  // beyond the most recent 10 are not considered, mirroring Feature 2's own
  // "nothing 'recent' would be gained by looking further back once the
  // window is satisfied" discipline.
  const lastTen = usable.slice(-MIN_USABLE_CYCLES);
  const earlierWindow = lastTen.slice(0, WINDOW_SIZE);
  const recentWindow = lastTen.slice(WINDOW_SIZE);

  return { status: 'ok', usableCount: usable.length, unknownCount, earlierWindow, recentWindow };
}

// ─── evaluateDifficultyWindow — pure ───────────────────────────────────────

/**
 * Summarizes one WINDOW_SIZE-length window: success/failure/unknown counts
 * and whether the window itself qualifies as "difficult" — at most
 * DIFFICULTY_MAX_SUCCESSFUL_CYCLES (1) of its cycles succeeded, mirroring
 * Feature 2's own "0 or 1 of 5 met target -> support_review" bar (Step 2
 * spec §19) WITHOUT calling Feature 2's current decision (see module
 * header) — this is computed fresh from the window's own reconstructed
 * outcomes only.
 *
 * @param {Array<{outcome: string, createdAt: *}>|null} window
 * @returns {{
 *   count: number, complete: boolean,
 *   successfulCycles: number, failedCycles: number, unknownCycles: number,
 *   isDifficult: boolean, evidenceStart: *|null, evidenceEnd: *|null,
 * }}
 */
function evaluateDifficultyWindow(window) {
  if (!Array.isArray(window) || window.length === 0) {
    return {
      count: 0, complete: false,
      successfulCycles: 0, failedCycles: 0, unknownCycles: 0,
      isDifficult: false, evidenceStart: null, evidenceEnd: null,
    };
  }

  const successfulCycles = window.filter((c) => c.outcome === 'success').length;
  const failedCycles = window.filter((c) => c.outcome === 'failure').length;
  const unknownCycles = window.filter((c) => c.outcome === 'unknown').length; // defensive — should always be 0 here
  const complete = window.length === WINDOW_SIZE;

  return {
    count: window.length,
    complete,
    successfulCycles, failedCycles, unknownCycles,
    isDifficult: complete && successfulCycles <= DIFFICULTY_MAX_SUCCESSFUL_CYCLES,
    evidenceStart: window[0].createdAt,
    evidenceEnd: window[window.length - 1].createdAt,
  };
}

// ─── evaluateTemporalSeparation — pure ─────────────────────────────────────

/**
 * Computes the real-world time gap between the two windows (Step 2 spec
 * §17): the LAST cycle of `earlierWindow` to the FIRST cycle of
 * `recentWindow` — never window-start-to-window-start, since the relevant
 * question is whether the later evidence period BEGAN sufficiently after
 * the earlier evidence period ENDED.
 *
 * @param {{earlierWindow: Array<{createdAt:*}>, recentWindow: Array<{createdAt:*}>}} params
 * @returns {{separationMs: number|null, meetsMinimum: boolean}}
 */
function evaluateTemporalSeparation({ earlierWindow, recentWindow } = {}) {
  if (!Array.isArray(earlierWindow) || !Array.isArray(recentWindow) || earlierWindow.length === 0 || recentWindow.length === 0) {
    return { separationMs: null, meetsMinimum: false };
  }

  const earlierEndMs = toTimestampMs(earlierWindow[earlierWindow.length - 1].createdAt);
  const recentStartMs = toTimestampMs(recentWindow[0].createdAt);
  if (earlierEndMs == null || recentStartMs == null) {
    return { separationMs: null, meetsMinimum: false };
  }

  const separationMs = recentStartMs - earlierEndMs;
  return { separationMs, meetsMinimum: separationMs >= MIN_WINDOW_SEPARATION_MS };
}

// ─── evaluatePersistentDifficultyWindows — pure, top-level decision ────────

/**
 * Pure decision function (Step 2 spec §47) — zero Sequelize/network/model/
 * logger dependencies. Combines evaluateDifficultyWindow() +
 * evaluateTemporalSeparation() into the final status/reason pair.
 *
 * Decision order (Step 2 spec §21-§24, §48 Cases A-F):
 *   1. Either window incomplete (< WINDOW_SIZE cycles)
 *        -> insufficient_data / insufficient_cycles
 *   2. Both complete but temporal separation < MIN_WINDOW_SEPARATION_MS
 *        -> insufficient_data / insufficient_temporal_dispersion
 *   3. Both windows difficult
 *        -> persistent / repeated_difficulty_across_windows
 *   4. Only the recent window is difficult
 *        -> not_persistent / recent_difficulty_not_yet_persistent
 *      (Step 2 spec §23 — NOT persistent; a single recently-emerging
 *      window is deliberately not enough, avoiding an invented
 *      'emerging_difficulty' tier)
 *   5. Only the earlier window is difficult
 *        -> not_persistent / recent_improvement
 *      (Step 2 spec §24 — sensible recovery-like behavior without
 *      introducing a formal 'resolved' status yet)
 *   6. Neither window is difficult
 *        -> not_persistent / no_persistent_difficulty
 *
 * @param {{earlierWindow: Array<Object>, recentWindow: Array<Object>}} params
 * @returns {{
 *   status: string, reason: string,
 *   earlierWindow: ReturnType<typeof evaluateDifficultyWindow>,
 *   recentWindow: ReturnType<typeof evaluateDifficultyWindow>,
 *   separationMs: number|null,
 * }}
 */
function evaluatePersistentDifficultyWindows({ earlierWindow, recentWindow } = {}) {
  const earlier = evaluateDifficultyWindow(earlierWindow);
  const recent = evaluateDifficultyWindow(recentWindow);

  if (!earlier.complete || !recent.complete) {
    return {
      status: PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA,
      reason: PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_CYCLES,
      earlierWindow: earlier, recentWindow: recent, separationMs: null,
    };
  }

  const separation = evaluateTemporalSeparation({ earlierWindow, recentWindow });
  if (!separation.meetsMinimum) {
    return {
      status: PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA,
      reason: PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION,
      earlierWindow: earlier, recentWindow: recent, separationMs: separation.separationMs,
    };
  }

  if (earlier.isDifficult && recent.isDifficult) {
    return {
      status: PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT,
      reason: PERSISTENT_DIFFICULTY_REASONS.REPEATED_DIFFICULTY_ACROSS_WINDOWS,
      earlierWindow: earlier, recentWindow: recent, separationMs: separation.separationMs,
    };
  }

  if (!earlier.isDifficult && recent.isDifficult) {
    return {
      status: PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT,
      reason: PERSISTENT_DIFFICULTY_REASONS.RECENT_DIFFICULTY_NOT_YET_PERSISTENT,
      earlierWindow: earlier, recentWindow: recent, separationMs: separation.separationMs,
    };
  }

  if (earlier.isDifficult && !recent.isDifficult) {
    return {
      status: PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT,
      reason: PERSISTENT_DIFFICULTY_REASONS.RECENT_IMPROVEMENT,
      earlierWindow: earlier, recentWindow: recent, separationMs: separation.separationMs,
    };
  }

  return {
    status: PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT,
    reason: PERSISTENT_DIFFICULTY_REASONS.NO_PERSISTENT_DIFFICULTY,
    earlierWindow: earlier, recentWindow: recent, separationMs: separation.separationMs,
  };
}

// ─── summarizeAffectedLetters — pure ───────────────────────────────────────

/**
 * Builds the letter-level breakdown (Step 2 spec §2/§15/§24/§33-§35) from
 * the SAME cycles contributing to the two evaluated windows — never from
 * unrelated lifetime history. The family-level `status`/`reason` above
 * remains the only "persistent" determination; individual letters are
 * never themselves labeled persistent (Step 2 spec §34).
 *
 * Deterministic ordering (Step 2 spec §35): failedCycles descending, then
 * totalCycles descending, then alphabetical — returned as a plain object
 * built by inserting keys in that exact order, so both `Object.keys(...)`
 * (for order-sensitive tests/future display) and direct `result.c` access
 * (matching the Step 2 spec §33 example shape) work.
 *
 * @param {Array<{letter: string, outcome: string}>} cycles — the combined
 *   earlierWindow + recentWindow cycles (10 total in a complete evaluation).
 * @returns {Object<string, {totalCycles: number, failedCycles: number}>}
 */
function summarizeAffectedLetters(cycles) {
  const byLetter = new Map();

  for (const cycle of cycles ?? []) {
    if (!byLetter.has(cycle.letter)) byLetter.set(cycle.letter, { totalCycles: 0, failedCycles: 0 });
    const entry = byLetter.get(cycle.letter);
    entry.totalCycles += 1;
    if (cycle.outcome === 'failure') entry.failedCycles += 1;
  }

  const orderedLetters = [...byLetter.keys()].sort((a, b) => {
    const ea = byLetter.get(a);
    const eb = byLetter.get(b);
    if (eb.failedCycles !== ea.failedCycles) return eb.failedCycles - ea.failedCycles;
    if (eb.totalCycles !== ea.totalCycles) return eb.totalCycles - ea.totalCycles;
    return a.localeCompare(b);
  });

  const result = {};
  for (const letter of orderedLetters) result[letter] = byLetter.get(letter);
  return result;
}

// ─── fetchCandidateCycles — the ONE narrow read-only query ─────────────────

/**
 * Reads (never writes) every candidate attempt-3, normal-mode, complete row
 * for a student, across ALL letters/case types — family/case filtering
 * happens afterward, in buildFamilyCaseEvidence() (pure, no second query).
 * No DB-side LIMIT — same "correctness over a premature pagination
 * optimization that isn't yet justified by data volume" decision Feature 2
 * already made (Step 1 audit confirms system-wide totals are still small;
 * re-assess only if this table grows dramatically).
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: 'found'|'invalid_input'|'read_failed', studentId: number|null, rows: Array<Object>}>}
 */
async function fetchCandidateCycles({ studentId } = {}) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, rows: [] };
  }

  let rows;
  try {
    rows = await LetterAttempt.findAll({
      where: {
        student_id: studentId,
        attempt_number: CANDIDATE_ATTEMPT_NUMBER,
        collection_mode: false,
        capture_status: CANDIDATE_CAPTURE_STATUS,
      },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });
  } catch (err) {
    logger.error('Persistent-difficulty candidate cycle read failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', studentId, rows: [] };
  }

  return { status: 'found', studentId, rows };
}

module.exports = {
  reconstructCycleOutcome,
  dedupeCompletedCycles,
  buildFamilyCaseEvidence,
  splitLongitudinalWindows,
  evaluateDifficultyWindow,
  evaluateTemporalSeparation,
  evaluatePersistentDifficultyWindows,
  summarizeAffectedLetters,
  fetchCandidateCycles,
};
