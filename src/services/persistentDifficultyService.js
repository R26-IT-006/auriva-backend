'use strict';

/**
 * persistentDifficultyService.js
 *
 * Feature 7 Step 3 — READ-ONLY student-wide persistent-difficulty
 * detection. Orchestrates the Step 2 evidence-reconstruction helpers
 * (persistentDifficultyEvidence.js) across all six (caseType, family)
 * streams — it duplicates none of their internal logic, exactly mirroring
 * every prior feature's own "service composes, never re-derives" discipline
 * (demoSpeedRecommendationService.js composing dynamicThresholdService.js +
 * adaptiveSupportService.js is the closest precedent).
 *
 * ── One read, six pure evaluations (Step 3 spec §22/§23) ──────────────────
 * `fetchCandidateCycles({studentId})` is called EXACTLY ONCE per
 * evaluatePersistentDifficulty() call — every stream (lowercase/uppercase ×
 * straight/curved/complex) derives from that single in-memory candidate
 * list via buildFamilyCaseEvidence()'s own (caseType, family) filtering. A
 * read failure therefore fails the WHOLE evaluation (`status: 'read_failed'`)
 * rather than ever returning six fabricated `insufficient_data` streams —
 * "no evidence" and "could not read evidence" are kept explicitly distinct.
 *
 * ── What this module never does ────────────────────────────────────────────
 *   - never calls evaluateDynamicThresholds()/getCurrentFamilyThreshold()
 *     (Feature 2) or evaluateSupportRecommendations() (Feature 3) — Feature
 *     7 uses only row-local historical `best_score`/`threshold` evidence,
 *     never a live current-target lookup (Step 2's own non-circularity
 *     invariant, reused unchanged here);
 *   - never calls adaptivePreWritingService/repetitionRecommendationService/
 *     demoSpeedRecommendationService (Features 4/5/6) — v1's trigger remains
 *     independently reconstructable from LetterAttempt history alone;
 *   - never queries StudentMotorBaseline — baseline stays contextual only,
 *     never a trigger dependency;
 *   - never reads support_level/demo_speed_level/blocked_attempts/any raw
 *     timing feature as a trigger input;
 *   - never calls a write method — see
 *     tests/persistentDifficultyServiceReadOnly.test.js.
 *
 * ── Research framing ────────────────────────────────────────────────────────
 * A `persistent` stream means: "this software's own longitudinal practice
 * data shows the same educational handwriting difficulty recurring across
 * two separate, complete, time-separated evidence periods." Never a
 * clinical diagnosis, motor-impairment classification, or ASD-severity
 * judgment — see persistentDifficultyPolicy.js's own header.
 */

const {
  fetchCandidateCycles, buildFamilyCaseEvidence, splitLongitudinalWindows,
  evaluatePersistentDifficultyWindows, summarizeAffectedLetters,
} = require('./persistentDifficultyEvidence');
const {
  WINDOW_SIZE, MIN_WINDOW_SEPARATION_MS,
  PERSISTENT_DIFFICULTY_STATUSES, PERSISTENT_DIFFICULTY_REASONS,
} = require('../config/persistentDifficultyPolicy');
const logger = require('../utils/logger');

// Exactly the six streams (Step 3 spec §5) — never dynamically invented.
const CASE_TYPES = ['lowercase', 'uppercase'];
const FAMILIES = ['straight', 'curved', 'complex'];

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * ISO-serializes a timestamp, tolerant of either a Date instance (the live
 * Sequelize path) or an already-string value (tests) — API responses must
 * never leak a database-native Date object (Step 3 spec §14).
 */
function toIso(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function serializeWindow(evaluatedWindow) {
  if (!evaluatedWindow || evaluatedWindow.count === 0) return null;
  return {
    successfulCycles: evaluatedWindow.successfulCycles,
    failedCycles: evaluatedWindow.failedCycles,
    evidenceStart: toIso(evaluatedWindow.evidenceStart),
    evidenceEnd: toIso(evaluatedWindow.evidenceEnd),
  };
}

/**
 * Object-keyed-by-letter (Step 2's own deterministic insertion order) ->
 * array shape (Step 3 spec §7/§13 example response). `Object.entries`
 * preserves that insertion order, so the array is deterministically ordered
 * without re-sorting here.
 */
function serializeAffectedLetters(lettersByLetter) {
  return Object.entries(lettersByLetter).map(([letter, counts]) => ({
    letter, totalCycles: counts.totalCycles, failedCycles: counts.failedCycles,
  }));
}

/**
 * Evaluates ONE (caseType, family) stream from the already-fetched,
 * student-wide candidate pool. Pure orchestration — every actual decision
 * (family/case filtering, dedup, outcome reconstruction, windowing,
 * temporal-separation check, persistent/not_persistent/insufficient_data
 * decision, affected-letters summary) is delegated entirely to the Step 2
 * helpers; nothing here re-implements any of it.
 */
function evaluateStream({ attempts, caseType, family }) {
  const evidence = buildFamilyCaseEvidence({ attempts, caseType, family });
  const split = splitLongitudinalWindows(evidence.cycles);

  const base = {
    caseType, family,
    validCycleCount: evidence.cycles.length,
    usableCycleCount: split.usableCount,
    windowSize: WINDOW_SIZE,
    requiredSeparationMs: MIN_WINDOW_SEPARATION_MS,
    // Additive window-selection provenance (see splitLongitudinalWindows'
    // own header). `cyclesNewerThanWindow > 0` means the newest usable
    // cycles were skipped because their earlier/recent boundary fell inside
    // one practice sitting, and an older but genuinely time-separated
    // candidate was used instead — never hidden, so a reader can always see
    // which evidence the decision rests on.
    cyclesNewerThanWindow: split.cyclesNewerThanWindow ?? 0,
    separationSatisfied: split.separationSatisfied ?? false,
  };

  if (split.status !== 'ok') {
    // Not enough usable cycles to even attempt two windows — Step 3 spec
    // §8: never hide the useful validCycleCount/usableCycleCount, and still
    // surface whatever affectedLetters evidence DOES exist (from every
    // reconstructed cycle, not just a windowed subset, since no window was
    // ever selected).
    return {
      ...base,
      status: PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA,
      reason: PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_CYCLES,
      earlierWindow: null, recentWindow: null, separationMs: null,
      affectedLetters: serializeAffectedLetters(summarizeAffectedLetters(evidence.cycles)),
    };
  }

  const decision = evaluatePersistentDifficultyWindows({
    earlierWindow: split.earlierWindow, recentWindow: split.recentWindow,
  });

  // affectedLetters is built ONLY from the exact 10 cycles selected into
  // the two evaluated windows (Step 3 spec §13) — never the full,
  // potentially-larger evidence.cycles list once a window selection exists.
  const selectedCycles = [...split.earlierWindow, ...split.recentWindow];

  return {
    ...base,
    status: decision.status,
    reason: decision.reason,
    earlierWindow: serializeWindow(decision.earlierWindow),
    recentWindow: serializeWindow(decision.recentWindow),
    separationMs: decision.separationMs,
    affectedLetters: serializeAffectedLetters(summarizeAffectedLetters(selectedCycles)),
  };
}

/**
 * Read-only, student-wide persistent-difficulty evaluation across all six
 * (caseType, family) streams. Persists nothing, computed fresh on every
 * call (Feature 7 has no persistence table as of this step).
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{
 *   status: 'evaluated'|'invalid_input'|'read_failed',
 *   studentId: number|null,
 *   evaluatedAt: string|null,
 *   streams: {lowercase: Object, uppercase: Object}|null,
 *   summary: {evaluatedStreamCount: number, persistentCount: number,
 *     notPersistentCount: number, insufficientDataCount: number,
 *     persistentStreams: Array<{caseType: string, family: string}>}|null,
 * }>}
 */
async function evaluatePersistentDifficulty({ studentId } = {}) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', studentId: null, evaluatedAt: null, streams: null, summary: null };
  }

  // ── The ONE database read for this whole evaluation (Step 3 spec §22/§23) ──
  let candidateResult;
  try {
    candidateResult = await fetchCandidateCycles({ studentId });
  } catch (err) {
    logger.error('Persistent-difficulty candidate read threw unexpectedly', { studentId, errorMessage: err.message });
    return { status: 'read_failed', studentId, evaluatedAt: null, streams: null, summary: null };
  }

  if (candidateResult.status !== 'found') {
    // 'invalid_input' is unreachable here (studentId already validated
    // above with an identical rule) but propagated defensively rather than
    // assumed unreachable; 'read_failed' is the realistic case — and it
    // fails the ENTIRE evaluation, never six fabricated insufficient_data
    // streams (Step 3 spec §21).
    return {
      status: candidateResult.status === 'invalid_input' ? 'invalid_input' : 'read_failed',
      studentId, evaluatedAt: null, streams: null, summary: null,
    };
  }

  const attempts = candidateResult.rows;
  const streams = { lowercase: {}, uppercase: {} };
  let persistentCount = 0, notPersistentCount = 0, insufficientDataCount = 0;
  const persistentStreams = [];

  for (const caseType of CASE_TYPES) {
    for (const family of FAMILIES) {
      const streamResult = evaluateStream({ attempts, caseType, family });
      streams[caseType][family] = streamResult;

      if (streamResult.status === PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT) {
        persistentCount += 1;
        persistentStreams.push({ caseType, family });
      } else if (streamResult.status === PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT) {
        notPersistentCount += 1;
      } else {
        insufficientDataCount += 1;
      }
    }
  }

  return {
    status: 'evaluated',
    studentId,
    evaluatedAt: new Date().toISOString(),
    streams,
    summary: {
      evaluatedStreamCount: CASE_TYPES.length * FAMILIES.length,
      persistentCount, notPersistentCount, insufficientDataCount,
      // Deliberately NO global "student is persistent" boolean (Step 3
      // spec §11) — persistent difficulty belongs to specific streams,
      // surfaced here as an explicit list, never collapsed into one flag.
      persistentStreams,
    },
  };
}

module.exports = { evaluatePersistentDifficulty };
