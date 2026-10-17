'use strict';

// Normalize handwriting features.
//
// Maps the two raw feature shapes the frontend sends (shapes: snake_case;
// letters: camelCase completionTime/pauseCount/strokeCount plus snake_case
// dtw_distance) into one canonical schema, used by the Motor Score, mastery
// and ML:
//
//   duration_ms, total_distance, avg_speed, smoothness_score, pause_count,
//   accuracy_score, dtw_distance, stroke_count, direction_score, plus the
//   trajectory extras below
//
// The raw `features` column is stored unchanged; this module only produces
// `normalized_features`.
//
// Provenance — not everything is recomputed on the server:
//   recomputed from raw strokes: direction_score, speed_mean/std/cv, pause extras
//   client value when sent, else derived from strokes: total_distance,
//     avg_speed, attempt_* family
//   client value only: smoothness, dtw_distance, pause_count, duration_ms,
//     stroke_count
//
// smoothness and accuracy arrive as lower-is-better deviations (mean turning
// angle in radians; mean pixel deviation), not 0-100 scores. They are
// inverted and scaled here; the Motor Score formula lives in motorScore.js.
const {
  scoreFromDeviation,
  computeDirectionScore,
  SMOOTHNESS_MAX_RAD,
  ACCURACY_MAX_PX,
} = require('./motorScore');

// Trajectory formulas mirrored from the frontend's utils/trajectoryFeatures.js.
// Also used by the backfill scripts for already-collected rows.
const {
  hasUsableTrajectory,
  calculateTotalDistance,
  calculateAverageSpeed,
  calculateSpeedStats,
  calculatePauseMetrics,
  calculateAttemptDurationFromAbsoluteTime,
  calculateAttemptAverageSpeed,
  calculateAttemptPauseMetrics,
} = require('./trajectoryFeatures');

function toFiniteOrNull(value) {
  if (value == null) return null; // Number(null) is 0, not NaN — guard explicitly
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Derive trajectory features from the raw stroke_points.
//
// - total_distance, avg_speed and the attempt_* values: a client-sent value
//   wins when present; otherwise derived from strokes.
// - speed_mean/std/cv and pause extras: always derived from strokes.
// - durationMs (the row's duration_ms, client-sent) is the denominator for
//   avg_speed and the pause rates, so they stay consistent with duration_ms.
// - attempt_duration_ms uses raw tAbs only; it never falls back to the
//   possibly truncated multi-stroke durationMs, and stays null instead.
//
// Every field is null, never a fabricated 0, when the trajectory is unusable
// (fewer than 2 valid points).
function deriveTrajectoryFeatures(strokePoints, {
  existingTotalDistance, existingAvgSpeed, durationMs,
  existingAttemptDurationMs, existingAttemptAvgSpeed,
  existingAttemptPauseFrequency, existingAttemptPauseDurationRatio,
} = {}) {
  const usable = hasUsableTrajectory(strokePoints);

  const total_distance = existingTotalDistance != null
    ? existingTotalDistance
    : (usable ? calculateTotalDistance(strokePoints) : null);

  const avg_speed = existingAvgSpeed != null
    ? existingAvgSpeed
    : (usable ? calculateAverageSpeed(strokePoints, durationMs) : null);

  const { speed_mean, speed_std, speed_cv } = usable
    ? calculateSpeedStats(strokePoints)
    : { speed_mean: null, speed_std: null, speed_cv: null };

  const pauseExtras = usable
    ? calculatePauseMetrics(strokePoints, { durationMs })
    : { total_pause_duration_ms: null, mean_pause_duration_ms: null, pause_frequency: null, pause_duration_ratio: null };

  // Independent of `usable`: valid timestamps can exist even when x/y are
  // malformed. Null-safety (>= 2 valid tAbs, max > min) is inside the helper.
  const attempt_duration_ms = existingAttemptDurationMs != null
    ? existingAttemptDurationMs
    : calculateAttemptDurationFromAbsoluteTime(strokePoints);

  const attempt_avg_speed = existingAttemptAvgSpeed != null
    ? existingAttemptAvgSpeed
    : calculateAttemptAverageSpeed(total_distance, attempt_duration_ms);

  const attemptPauseExtras = calculateAttemptPauseMetrics(
    pauseExtras.pause_count ?? null, pauseExtras.total_pause_duration_ms, attempt_duration_ms,
  );
  const attempt_pause_frequency = existingAttemptPauseFrequency != null
    ? existingAttemptPauseFrequency
    : attemptPauseExtras.attempt_pause_frequency;
  const attempt_pause_duration_ratio = existingAttemptPauseDurationRatio != null
    ? existingAttemptPauseDurationRatio
    : attemptPauseExtras.attempt_pause_duration_ratio;

  return {
    total_distance, avg_speed, speed_mean, speed_std, speed_cv,
    total_pause_duration_ms: pauseExtras.total_pause_duration_ms,
    mean_pause_duration_ms:  pauseExtras.mean_pause_duration_ms,
    pause_frequency:         pauseExtras.pause_frequency,
    pause_duration_ratio:    pauseExtras.pause_duration_ratio,
    attempt_duration_ms, attempt_avg_speed, attempt_pause_frequency, attempt_pause_duration_ratio,
  };
}

function buildValidity(normalized) {
  const keys = [
    'duration_ms', 'total_distance', 'avg_speed', 'smoothness_score',
    'pause_count', 'accuracy_score', 'dtw_distance', 'stroke_count', 'direction_score',
    // Trajectory extras (deriveTrajectoryFeatures).
    'speed_mean', 'speed_std', 'speed_cv',
    'total_pause_duration_ms', 'mean_pause_duration_ms', 'pause_frequency', 'pause_duration_ratio',
    // tAbs-based attempt-level counterparts.
    'attempt_duration_ms', 'attempt_avg_speed', 'attempt_pause_frequency', 'attempt_pause_duration_ratio',
  ];
  const validity = {};
  for (const key of keys) validity[key] = normalized[key] != null;
  return validity;
}

// Normalize shape features.
// raw: the shape's `features` object (snake_case, ShapeAssessmentScreen.js).
// meta.strokeCount: shape.stroke_count (sibling field, not inside features).
// meta.strokePoints: shape.strokes (raw per-stroke point arrays).
function normalizeShapeFeatures(raw, meta = {}) {
  const r = raw ?? {};

  const duration_ms = toFiniteOrNull(r.duration_ms);

  // Shapes send total_distance/avg_speed and the attempt_* values; client
  // values win when present (see deriveTrajectoryFeatures).
  const derived = deriveTrajectoryFeatures(meta.strokePoints, {
    existingTotalDistance: toFiniteOrNull(r.total_distance),
    existingAvgSpeed:      toFiniteOrNull(r.avg_speed),
    durationMs:            duration_ms,
    existingAttemptDurationMs:         toFiniteOrNull(r.attempt_duration_ms),
    existingAttemptAvgSpeed:            toFiniteOrNull(r.attempt_avg_speed),
    existingAttemptPauseFrequency:      toFiniteOrNull(r.attempt_pause_frequency),
    existingAttemptPauseDurationRatio:  toFiniteOrNull(r.attempt_pause_duration_ratio),
  });

  const normalized = {
    duration_ms,
    total_distance:   derived.total_distance,
    avg_speed:        derived.avg_speed,
    smoothness_score: r.smoothness != null ? scoreFromDeviation(toFiniteOrNull(r.smoothness), SMOOTHNESS_MAX_RAD) : null,
    pause_count:      toFiniteOrNull(r.pause_count),
    // Missing accuracy (zigzag/curve_wave) stays null, never 0.
    accuracy_score:   r.accuracy != null ? scoreFromDeviation(toFiniteOrNull(r.accuracy), ACCURACY_MAX_PX) : null,
    dtw_distance:      toFiniteOrNull(r.dtw_distance),
    stroke_count:      toFiniteOrNull(meta.strokeCount) ?? toFiniteOrNull(r.stroke_count),
    direction_score:   computeDirectionScore(meta.strokePoints),
    // Shapes have no multi-stroke stroke-order matching (letters only), so
    // this is normally null.
    stroke_order_meta: r.stroke_order_meta ?? null,
    // Trajectory extras: not used by the Motor Score.
    speed_mean:               derived.speed_mean,
    speed_std:                 derived.speed_std,
    speed_cv:                  derived.speed_cv,
    total_pause_duration_ms:   derived.total_pause_duration_ms,
    mean_pause_duration_ms:    derived.mean_pause_duration_ms,
    pause_frequency:           derived.pause_frequency,
    pause_duration_ratio:      derived.pause_duration_ratio,
    // tAbs-based attempt-level values.
    attempt_duration_ms:          derived.attempt_duration_ms,
    attempt_avg_speed:             derived.attempt_avg_speed,
    attempt_pause_frequency:       derived.attempt_pause_frequency,
    attempt_pause_duration_ratio:  derived.attempt_pause_duration_ratio,
  };

  return { normalized, validity: buildValidity(normalized) };
}

// Normalize letter features.
// raw: the per-attempt `features` object (camelCase, LetterWritingScreen.js).
// meta.strokePoints: attempt.strokes (raw per-stroke point arrays).
function normalizeLetterFeatures(raw, meta = {}) {
  const r = raw ?? {};

  const duration_ms = toFiniteOrNull(r.completionTime ?? r.duration_ms);

  // Current app builds send total_distance/avg_speed and the attempt_*
  // values; client values win when present. Older builds and backfilled
  // rows derive them from strokes (null when the trajectory is unusable).
  const derived = deriveTrajectoryFeatures(meta.strokePoints, {
    existingTotalDistance: toFiniteOrNull(r.total_distance),
    existingAvgSpeed:      toFiniteOrNull(r.avg_speed),
    durationMs:            duration_ms,
    existingAttemptDurationMs:         toFiniteOrNull(r.attempt_duration_ms),
    existingAttemptAvgSpeed:            toFiniteOrNull(r.attempt_avg_speed),
    existingAttemptPauseFrequency:      toFiniteOrNull(r.attempt_pause_frequency),
    existingAttemptPauseDurationRatio:  toFiniteOrNull(r.attempt_pause_duration_ratio),
  });

  const normalized = {
    duration_ms,
    total_distance:   derived.total_distance,
    avg_speed:        derived.avg_speed,
    smoothness_score: r.smoothness != null ? scoreFromDeviation(toFiniteOrNull(r.smoothness), SMOOTHNESS_MAX_RAD) : null,
    pause_count:      toFiniteOrNull(r.pauseCount ?? r.pause_count),
    // Letters have no direct accuracy reading — null by design. motorScore.js
    // derives the accuracy component from dtw_distance instead.
    accuracy_score:   null,
    dtw_distance:      toFiniteOrNull(r.dtw_distance),
    stroke_count:      toFiniteOrNull(r.strokeCount ?? r.stroke_count),
    direction_score:   computeDirectionScore(meta.strokePoints),
    // From the frontend's computeMultiStrokeDTW: null for single-stroke
    // templates, an object for multi-stroke ones.
    stroke_order_meta: r.stroke_order_meta ?? null,
    // Trajectory extras: not used by the Motor Score. speed_cv is a
    // Letter V1 ML input (letterMotorPatternCheckService.js).
    speed_mean:               derived.speed_mean,
    speed_std:                 derived.speed_std,
    speed_cv:                  derived.speed_cv,
    total_pause_duration_ms:   derived.total_pause_duration_ms,
    mean_pause_duration_ms:    derived.mean_pause_duration_ms,
    pause_frequency:           derived.pause_frequency,
    pause_duration_ratio:      derived.pause_duration_ratio,
    // tAbs-based attempt-level values.
    attempt_duration_ms:          derived.attempt_duration_ms,
    attempt_avg_speed:             derived.attempt_avg_speed,
    attempt_pause_frequency:       derived.attempt_pause_frequency,
    attempt_pause_duration_ratio:  derived.attempt_pause_duration_ratio,
  };

  return { normalized, validity: buildValidity(normalized) };
}

module.exports = { normalizeShapeFeatures, normalizeLetterFeatures };
