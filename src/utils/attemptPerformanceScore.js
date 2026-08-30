'use strict';

/**
 * attemptPerformanceScore.js
 *
 * ⚠ NON-AUTHORITATIVE (Motor Score Unification, 2026-08) — this module's
 * output is the retired featuresToScore()-domain mirror. It is no longer
 * read by any runtime code path: dynamicThresholdService.js and
 * adaptiveSupportService.js were switched to read LetterAttempt.motor_score
 * (computeMotorScore()-domain — src/utils/motorScore.js) directly. Mastery,
 * threshold updates, and Feature 2/3 evidence never consult this file.
 * Kept only because its own parity tests (tests/attemptPerformanceScore.test.js)
 * remain a useful, verified historical record of the frontend's real-time
 * featuresToScore() formula. Do not wire this back into any decision path —
 * see tests/motorScoreAuthority.test.js's "Contradiction regression" case
 * for a concrete example of the two domains disagreeing.
 *
 * Original doc (still accurate for what this file computes, just not for
 * who — nobody — currently consumes it):
 *
 * Feature 2 Step 4 — reconstructs a single LetterAttempt row's own
 * performance score from its stored PER-ATTEMPT `features` JSONB
 * ({smoothness, dtw_distance, ...} — see src/models/LetterAttempt.js and
 * handwritingController.saveLetterAttempts()).
 *
 * Why this exists (do not use LetterAttempt.best_score / passed /
 * threshold_passed for this purpose): those three columns are computed ONCE
 * per POST /handwriting/letter-complete call and copied identically onto
 * every attempt row from that session (see saveLetterAttempts() — bestScore
 * and threshold are session-level constants, not attempt_number-specific).
 * They cannot tell attempt 1 apart from attempt 3 within the same session.
 * `features.smoothness` and `features.dtw_distance`, in contrast, ARE
 * genuinely per-attempt (live-verified: within one session, attempt 1/2/3
 * carry three different smoothness/dtw_distance values — see Feature 2 Step
 * 4 live data audit), so this is the only column pair that can reconstruct
 * an individual attempt's own score.
 *
 * The formula below is an intentional, carefully-verified MIRROR of the
 * frontend's real-time scoring function — NOT a new/invented formula. See
 * frontend/src/utils/adaptiveSequencing.js: featuresToScore(). That file is
 * an ES module (`export function ...`) and cannot be `require()`d directly
 * into this CommonJS backend test/runtime without adding an ESM transform
 * to the backend (a footprint change outside this step's scope — see Step 4
 * Section 5 guidance). Instead, the exact frontend function was executed
 * once, out-of-band (via @babel/core, matching the project's real Expo
 * transform), against a fixture set, to obtain verified expected outputs.
 * Those fixtures are the parity tests in
 * tests/attemptPerformanceScore.test.js — this file's output is proven
 * mathematically identical to the frontend's for every fixture checked,
 * not merely "close" or "similar".
 *
 * Deliberately narrower than the frontend function: featuresToScore() has a
 * separate "accuracy" code path used only for shape-assessment scoring
 * (getAccuracyScore, line/circle shapes). Letter attempts never populate
 * `accuracy` — only shapes do — so that path is intentionally omitted here.
 * A letter attempt's features always take the
 * "dtw_distance present" path (frontend Path 2 in this file's header docs).
 */

// Mirrors frontend/src/utils/adaptiveSequencing.js exactly:
//   SCORE_WEIGHTS = { trajectory: 0.7, smoothness: 0.3 }
//   DTW_CAP = 45
const SCORE_WEIGHTS = { trajectory: 0.7, smoothness: 0.3 };
const DTW_CAP = 45;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {{smoothness: number, dtw_distance: number}} features
 * @returns {{status: 'valid', score: number}|{status: 'invalid', reason: string}}
 *   score is an integer 0-100 — Math.round(...), matching the frontend's own
 *   `Math.round(featuresToScore(...))` at the one call site that turns a raw
 *   score into the integer used for threshold comparison
 *   (frontend attemptScoresRef construction).
 */
function reconstructScoreFromFeatures({ smoothness, dtw_distance } = {}) {
  if (!isFiniteNumber(smoothness)) {
    return { status: 'invalid', reason: 'invalid_smoothness' };
  }
  if (!isFiniteNumber(dtw_distance)) {
    return { status: 'invalid', reason: 'invalid_dtw_distance' };
  }
  // dtw_distance < 0 is not physically meaningful (a distance metric) — the
  // frontend never guards against it explicitly either, but treating it as
  // malformed here is safer than silently producing a nonsensical score.
  if (dtw_distance < 0) {
    return { status: 'invalid', reason: 'negative_dtw_distance' };
  }
  if (smoothness < 0) {
    return { status: 'invalid', reason: 'negative_smoothness' };
  }

  const smoothPenalty = smoothness * 100;
  const trajectoryPenalty = (Math.min(dtw_distance, DTW_CAP) / DTW_CAP) * 100;
  const raw = 100 - (SCORE_WEIGHTS.trajectory * trajectoryPenalty + SCORE_WEIGHTS.smoothness * smoothPenalty);
  const clamped = Math.min(100, Math.max(0, raw));

  return { status: 'valid', score: Math.round(clamped) };
}

/**
 * Convenience wrapper taking a LetterAttempt row (or plain object with a
 * `.features` property) directly.
 *
 * @param {{features: any}} letterAttempt
 * @returns {{status: 'valid', score: number}|{status: 'invalid', reason: string}}
 */
function deriveAttemptPerformanceScore(letterAttempt) {
  const features = letterAttempt?.features;
  if (features == null || typeof features !== 'object' || Array.isArray(features)) {
    return { status: 'invalid', reason: 'missing_features' };
  }
  return reconstructScoreFromFeatures(features);
}

module.exports = {
  SCORE_WEIGHTS,
  DTW_CAP,
  reconstructScoreFromFeatures,
  deriveAttemptPerformanceScore,
};
