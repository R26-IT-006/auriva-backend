'use strict';

// trajectoryFeatures.js — canonical stroke-aware trajectory feature
// calculations, mirroring auriva-frontend's src/utils/trajectoryFeatures.js
// (same formulas, same guards, same "never fabricate a value" contract).
// This is an intentionally separate implementation, not a shared import —
// the frontend and backend are different repos/runtimes (React Native ES
// modules vs Node CommonJS) — but the math is kept identical and both are
// unit-tested against the same worked examples.
//
// Used two ways:
//   1. featureNormalization.js — as an ADDITIVE fallback, deriving
//      total_distance/avg_speed/speed_std/speed_cv/pause-extras from the
//      raw stroke_points already stored for every shape/letter submission,
//      whenever the client-sent value is missing. Never overwrites a
//      genuinely present client-sent value.
//   2. scripts/backfillLetterTrajectoryFeatures.js and
//      scripts/backfillShapeTrajectoryFeatures.js — the exact same
//      functions, applied once to already-collected rows.
//
// Input format: `strokePoints` is the same shape stored in the
// shape_features.stroke_points / letter_attempts.stroke_points JSONB
// columns and passed as `meta.strokePoints` into normalizeShapeFeatures()/
// normalizeLetterFeatures() today: an array of
// `{ stroke_id, points: [{x, y, t, tAbs, stroke_id}, ...] }` objects. A
// bare array-of-arrays or a single flat point array is also tolerated (see
// toStrokeArrays), matching motorScore.js's flattenStrokePoints()
// tolerance — but unlike that helper, stroke boundaries are PRESERVED
// here (returned as an array-of-arrays), never flattened away, because the
// distance/speed/pause math below must never cross a stroke boundary
// (Part 12 of the ML-readiness pass).
//
// ── NOTE ON `t` (see the frontend module's matching comment) ──────────────
// Each stroke's `t` clock resets to 0 at that stroke's own capture start on
// the frontend — it is NOT one continuous clock across a whole multi-stroke
// attempt. calculateDuration() below replicates the existing app-wide
// convention (the last point's `t`, in flattened stroke order) for
// backward compatibility with already-stored duration_ms/completionTime
// values, exactly as featureNormalization.js already does
// (`duration_ms: r.completionTime ?? r.duration_ms`). It is deliberately
// NOT "fixed" here.

function isFinitePoint(p) {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

function euclidean(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Converts any of the tolerated input shapes into an array-of-arrays with
// stroke boundaries intact. Never throws on malformed input — returns [].
function toStrokeArrays(strokePoints) {
  if (!Array.isArray(strokePoints) || strokePoints.length === 0) return [];
  if (strokePoints[0] && Array.isArray(strokePoints[0].points)) {
    // [{ stroke_id, points: [...] }] — the DB/wire format.
    return strokePoints.map(s => (Array.isArray(s.points) ? s.points : []));
  }
  if (strokePoints[0] && typeof strokePoints[0].x === 'number') {
    // A single flat point array (no stroke wrapper) — treat as one stroke.
    return [strokePoints];
  }
  // Already an array-of-arrays.
  return strokePoints;
}

function countPoints(strokes) {
  let n = 0;
  for (const stroke of strokes) {
    if (Array.isArray(stroke)) n += stroke.length;
  }
  return n;
}

/**
 * Whether strokePoints represents a usable (>= 2 real points) trajectory —
 * used to distinguish "not applicable / malformed" from "genuinely
 * measured", both at ingestion time and in the backfill scripts.
 */
function hasUsableTrajectory(strokePoints) {
  return countPoints(toStrokeArrays(strokePoints)) >= 2;
}

/**
 * Sum of Euclidean distances between consecutive points, computed
 * separately within each stroke — never across a stroke boundary.
 * @param {Array} strokePoints
 * @returns {number} pixels; 0 for empty/degenerate input
 */
function calculateTotalDistance(strokePoints) {
  const strokes = toStrokeArrays(strokePoints);
  let total = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1];
      const b = stroke[i];
      if (!isFinitePoint(a) || !isFinitePoint(b)) continue;
      total += euclidean(a, b);
    }
  }
  return total;
}

/**
 * Replicates the existing app-wide duration convention: the `t` value of
 * the very last captured point, in flattened stroke order.
 * @param {Array} strokePoints
 * @returns {number} milliseconds; 0 for empty input
 */
function calculateDuration(strokePoints) {
  const strokes = toStrokeArrays(strokePoints);
  const flat = strokes.flat();
  if (flat.length === 0) return 0;
  const last = flat[flat.length - 1];
  return Number.isFinite(last?.t) ? last.t : 0;
}

/**
 * avg_speed = total_distance / duration_ms. Returns null (never a
 * fabricated 0) when duration is not strictly positive/finite, or the
 * trajectory has fewer than 2 points total.
 * @param {Array} strokePoints
 * @param {number} [durationMsOverride] — use an already-computed
 *   duration_ms (e.g. the normalized value already stored elsewhere for
 *   this row) instead of re-deriving it from strokePoints.
 * @returns {number|null} pixels/millisecond
 */
function calculateAverageSpeed(strokePoints, durationMsOverride) {
  if (!hasUsableTrajectory(strokePoints)) return null;
  const totalDistance = calculateTotalDistance(strokePoints);
  const durationMs = Number.isFinite(durationMsOverride) ? durationMsOverride : calculateDuration(strokePoints);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
  if (!Number.isFinite(totalDistance)) return null;
  return totalDistance / durationMs;
}

/**
 * Per-segment speed (px/ms) for every consecutive, same-stroke point pair
 * with a strictly positive time delta. Stroke-boundary segments are
 * excluded as a side effect of the dt > 0 guard (see module doc comment).
 * @param {Array} strokePoints
 * @returns {number[]}
 */
function calculateSegmentSpeeds(strokePoints) {
  const strokes = toStrokeArrays(strokePoints);
  const speeds = [];
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1];
      const b = stroke[i];
      if (!isFinitePoint(a) || !isFinitePoint(b)) continue;
      const dt = b.t - a.t;
      if (!Number.isFinite(dt) || dt <= 0) continue;
      speeds.push(euclidean(a, b) / dt);
    }
  }
  return speeds;
}

/**
 * speed_mean / speed_std (population standard deviation) / speed_cv from
 * the valid segment-speed sequence. All null when there are no valid
 * segments; speed_cv additionally null when speed_mean is not strictly
 * positive.
 * @param {Array} strokePoints
 * @returns {{speed_mean: number|null, speed_std: number|null, speed_cv: number|null}}
 */
function calculateSpeedStats(strokePoints) {
  const speeds = calculateSegmentSpeeds(strokePoints);
  if (speeds.length === 0) return { speed_mean: null, speed_std: null, speed_cv: null };

  const speed_mean = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  const variance = speeds.reduce((s, v) => s + (v - speed_mean) ** 2, 0) / speeds.length;
  const speed_std = Math.sqrt(variance);
  const speed_cv = speed_mean > 0 ? speed_std / speed_mean : null;

  return { speed_mean, speed_std, speed_cv };
}

// Matches the inline `300` pause-gap literal used throughout the frontend
// capture screens exactly.
const DEFAULT_PAUSE_THRESHOLD_MS = 300;

/**
 * Pause metrics from consecutive, same-stroke point gaps STRICTLY GREATER
 * THAN thresholdMs. Computed per-stroke so a pen-up transition between
 * strokes is never counted as a pause (within-stroke pauses only — see the
 * frontend module's matching doc comment for why this exactly reproduces
 * the existing pause_count semantics).
 * @param {Array} strokePoints
 * @param {{thresholdMs?: number, durationMs?: number}} [options]
 * @returns {{
 *   pause_count: number,
 *   total_pause_duration_ms: number,
 *   mean_pause_duration_ms: number|null,
 *   pause_frequency: number|null,
 *   pause_duration_ratio: number|null,
 * }}
 */
function calculatePauseMetrics(strokePoints, options = {}) {
  const thresholdMs = Number.isFinite(options.thresholdMs) ? options.thresholdMs : DEFAULT_PAUSE_THRESHOLD_MS;
  const durationMs = Number.isFinite(options.durationMs) ? options.durationMs : calculateDuration(strokePoints);
  const strokes = toStrokeArrays(strokePoints);

  let pause_count = 0;
  let total_pause_duration_ms = 0;

  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1];
      const b = stroke[i];
      if (!Number.isFinite(a?.t) || !Number.isFinite(b?.t)) continue;
      const gap = b.t - a.t;
      if (gap > thresholdMs) {
        pause_count += 1;
        total_pause_duration_ms += gap;
      }
    }
  }

  const mean_pause_duration_ms = pause_count > 0 ? total_pause_duration_ms / pause_count : null;
  const pause_frequency = Number.isFinite(durationMs) && durationMs > 0
    ? pause_count / (durationMs / 1000)
    : null;
  const pause_duration_ratio = Number.isFinite(durationMs) && durationMs > 0
    ? total_pause_duration_ms / durationMs
    : null;

  return { pause_count, total_pause_duration_ms, mean_pause_duration_ms, pause_frequency, pause_duration_ratio };
}

// ─── ML-safe "attempt" duration — absolute-time based ──────────────────────
//
// Mirrors auriva-frontend's src/utils/trajectoryFeatures.js exactly (see
// that module's matching doc comment for the full rationale): calculateDuration()
// above only reflects the LAST stroke's own relative-`t` span for a
// multi-stroke attempt, because each stroke's `t` clock resets to 0 at its
// own start on the frontend. Every captured point also carries `tAbs`
// (absolute epoch-ms, confirmed monotonic across strokes for real captured
// data — see the duration-correction pass's inspection report). The
// functions below derive an ML-safe duration/speed/pause-rate family from
// `tAbs` instead, WITHOUT touching calculateDuration()/calculateAverageSpeed()/
// calculatePauseMetrics() above, which remain exactly as they were.

/**
 * True wall-clock span of a (possibly multi-stroke) attempt, derived from
 * `tAbs` rather than the stroke-local `t` clock.
 *
 * attempt_duration_ms = max(valid tAbs) - min(valid tAbs), across every
 * point in every stroke. Requires at least 2 valid (finite) `tAbs` values
 * with max strictly greater than min; returns null (never 0, never
 * negative, never invented) otherwise.
 *
 * @param {Array} strokePoints — same tolerant input as every other function
 *   in this module (DB/wire format, flat array, or array-of-arrays).
 * @returns {number|null} milliseconds
 */
function calculateAttemptDurationFromAbsoluteTime(strokePoints) {
  const strokes = toStrokeArrays(strokePoints);
  let min = Infinity;
  let max = -Infinity;
  let validCount = 0;

  for (const stroke of strokes) {
    for (const point of stroke) {
      const tAbs = point?.tAbs;
      if (!Number.isFinite(tAbs)) continue;
      validCount += 1;
      if (tAbs < min) min = tAbs;
      if (tAbs > max) max = tAbs;
    }
  }

  if (validCount < 2) return null;
  if (max <= min) return null;
  return max - min;
}

/**
 * ML-safe average speed: total_distance / attempt_duration_ms. Kept
 * distinct from calculateAverageSpeed() — both are preserved side by side.
 *
 * @param {number|null} totalDistance — within-stroke-only distance; pen-up
 *   movement is never included (Part 3 requirement — this function does
 *   not recompute distance, it only divides the value it's given).
 * @param {number|null} attemptDurationMs — from
 *   calculateAttemptDurationFromAbsoluteTime().
 * @returns {number|null} pixels/millisecond
 */
function calculateAttemptAverageSpeed(totalDistance, attemptDurationMs) {
  if (!Number.isFinite(totalDistance)) return null;
  if (!Number.isFinite(attemptDurationMs) || attemptDurationMs <= 0) return null;
  return totalDistance / attemptDurationMs;
}

/**
 * ML-safe pause-rate pair, using attempt_duration_ms as the denominator
 * instead of the legacy duration_ms. Takes the already-computed
 * pause_count/total_pause_duration_ms (the underlying >300ms,
 * within-stroke-only pause DETECTION is unchanged — only the rate/ratio
 * denominator differs here) rather than recomputing pause detection.
 *
 * @param {number|null} pauseCount
 * @param {number|null} totalPauseDurationMs
 * @param {number|null} attemptDurationMs
 * @returns {{attempt_pause_frequency: number|null, attempt_pause_duration_ratio: number|null}}
 */
function calculateAttemptPauseMetrics(pauseCount, totalPauseDurationMs, attemptDurationMs) {
  if (!Number.isFinite(attemptDurationMs) || attemptDurationMs <= 0) {
    return { attempt_pause_frequency: null, attempt_pause_duration_ratio: null };
  }
  const attempt_pause_frequency = Number.isFinite(pauseCount)
    ? pauseCount / (attemptDurationMs / 1000)
    : null;
  const attempt_pause_duration_ratio = Number.isFinite(totalPauseDurationMs)
    ? totalPauseDurationMs / attemptDurationMs
    : null;
  return { attempt_pause_frequency, attempt_pause_duration_ratio };
}

module.exports = {
  toStrokeArrays,
  hasUsableTrajectory,
  calculateTotalDistance,
  calculateDuration,
  calculateAverageSpeed,
  calculateSegmentSpeeds,
  calculateSpeedStats,
  calculatePauseMetrics,
  calculateAttemptDurationFromAbsoluteTime,
  calculateAttemptAverageSpeed,
  calculateAttemptPauseMetrics,
  DEFAULT_PAUSE_THRESHOLD_MS,
};
