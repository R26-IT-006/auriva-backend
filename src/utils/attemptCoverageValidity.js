'use strict';

/**
 * attemptCoverageValidity.js
 *
 * Coverage-fix audit — the real gate (recordLetterCompletion) had no
 * coverage/geometry check at all: a small or incomplete drawing could clear
 * the smoothness/DTW-based score threshold. This mirrors ONLY the coverage
 * sub-check of the frontend's didPassAttempt() (LetterWritingScreen.js:
 * 318-325 / UppercaseWritingScreen.js:372-379, byte-identical) — not its
 * smoothness<0.35 or dtw_distance<22 conditions, which overlap with/are
 * superseded by the existing score-based threshold gate and are out of
 * scope (letter scoring calibration is untouched).
 *
 * Pure; no I/O. Safe to unit test directly.
 */

function flattenStrokePoints(strokePoints) {
  if (!Array.isArray(strokePoints) || strokePoints.length === 0) return [];
  if (strokePoints[0] && Array.isArray(strokePoints[0].points)) {
    return strokePoints.flatMap(stroke => stroke.points ?? []);
  }
  return strokePoints;
}

function getDrawingBounds(strokePoints) {
  const points = flattenStrokePoints(strokePoints);
  if (points.length === 0) return { length: 0, width: 0, height: 0 };
  let minX = points[0].x, maxX = points[0].x;
  let minY = points[0].y, maxY = points[0].y;
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < minX) minX = points[i].x;
    if (points[i].x > maxX) maxX = points[i].x;
    if (points[i].y < minY) minY = points[i].y;
    if (points[i].y > maxY) maxY = points[i].y;
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return { length, width: maxX - minX, height: maxY - minY };
}

/**
 * Mirrors didPassAttempt's coverage condition only:
 *   length >= canvasHeight * 0.25
 *   && (width >= canvasWidth * 0.10 || height >= canvasHeight * 0.15)
 *
 * Returns null (undeterminable) — never a guessed true/false — when canvas
 * dimensions are missing. Callers MUST fail open on null: never invalidate
 * an attempt just because its canvas dimensions weren't recorded.
 *
 * @param {Array} strokePoints — one attempt's raw stroke_points
 * @param {number|null|undefined} canvasWidth
 * @param {number|null|undefined} canvasHeight
 * @returns {boolean|null}
 */
function isAttemptCoverageValid(strokePoints, canvasWidth, canvasHeight) {
  if (!canvasWidth || !canvasHeight) return null;
  const { length, width, height } = getDrawingBounds(strokePoints);
  return length >= canvasHeight * 0.25 && (width >= canvasWidth * 0.10 || height >= canvasHeight * 0.15);
}

/**
 * Computes bestScore for a letter-completion session, excluding any attempt
 * that fails the coverage/geometry check from being eligible to set it.
 * Extracted as its own pure function (rather than inlined in
 * recordLetterCompletion) so the index-alignment guard below is
 * independently unit-testable without a request/DB round trip.
 *
 * Index-alignment guard: `attemptScores[i]` is only trustworthy as "the
 * score for `attempts[i]`'s drawing" because a well-behaved client pushes
 * both arrays in the same lockstep, never independently reordered (see the
 * frontend's attemptScoresRef/sessionAttemptsRef). If the two arrays don't
 * even have the same LENGTH, that guarantee is already broken — filtering
 * against possibly-misaligned indices could silently disqualify the wrong
 * attempt's score. Rather than risk that, the coverage filter is skipped
 * entirely and every score is treated as valid (fail open, i.e. identical
 * to the pre-fix `bestScore = Math.max(...attemptScores)` behavior for that
 * session). This should never happen with the real client — callers are
 * expected to log a warning when `skippedForMismatch` is true, since it
 * indicates a real client bug.
 *
 * @param {{
 *   attemptScores: number[],
 *   attempts: Array<{strokes?: Array}>,
 *   canvasWidth: number|null|undefined,
 *   canvasHeight: number|null|undefined,
 * }} params
 * @returns {{ bestScore: number|null, skippedForMismatch: boolean }}
 */
function computeCoverageFilteredBestScore({ attemptScores, attempts, canvasWidth, canvasHeight }) {
  const scores = Array.isArray(attemptScores) ? attemptScores : [];
  const attemptsArray = Array.isArray(attempts) ? attempts : [];

  if (scores.length !== attemptsArray.length) {
    return {
      bestScore: scores.length > 0 ? Math.max(...scores) : null,
      skippedForMismatch: true,
    };
  }

  const validScores = scores.filter((score, i) =>
    isAttemptCoverageValid(attemptsArray[i]?.strokes, canvasWidth, canvasHeight) !== false
  );
  return {
    bestScore: validScores.length > 0 ? Math.max(...validScores) : null,
    skippedForMismatch: false,
  };
}

module.exports = { isAttemptCoverageValid, getDrawingBounds, computeCoverageFilteredBestScore };
