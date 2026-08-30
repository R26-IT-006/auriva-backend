'use strict';

// Maps the two disagreeing raw feature shapes sent by the frontend today
// (shapes: snake_case duration_ms/total_distance/avg_speed/smoothness/
// pause_count/accuracy/dtw_distance; letters: camelCase completionTime/
// pauseCount/smoothness/strokeCount mixed with snake_case dtw_distance)
// into one canonical schema used everywhere downstream for ML:
//
//   duration_ms, total_distance, avg_speed, smoothness_score, pause_count,
//   accuracy_score, dtw_distance, stroke_count, direction_score
//
// The original `features` column is left untouched (raw, as received) for
// backward compatibility — this module only produces the *additional*
// `normalized_features` value.
//
// smoothness_score/accuracy_score are not simple renames: the frontend's
// raw `smoothness` (mean turning angle in radians) and `accuracy` (mean
// pixel deviation from ideal geometry) are lower-is-better deviations, not
// already 0-100 scores — see ShapeAssessmentScreen.js's calculateFeatures
// and LetterWritingScreen.js's calculateDrawingFeatures. This module
// inverts and scales them; motor_score's own math lives in motorScore.js.
const {
  scoreFromDeviation,
  computeDirectionScore,
  SMOOTHNESS_MAX_RAD,
  ACCURACY_MAX_PX,
} = require('./motorScore');

// ML readiness pass (collection-mode feature-completeness fix): additive
// derivation from the already-stored raw stroke_points, used ONLY as a
// fallback when the client-sent value is missing — never overwrites a
// genuinely present client value. See src/utils/trajectoryFeatures.js for
// the formulas (mirrored from the frontend's utils/trajectoryFeatures.js).
// Reused as-is by scripts/backfillLetterTrajectoryFeatures.js and
// scripts/backfillShapeTrajectoryFeatures.js for already-collected rows.
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

// Derives total_distance/avg_speed/speed_mean/speed_std/speed_cv/pause-extras
// from meta.strokePoints — the SAME raw trajectory already stored verbatim
// in the stroke_points column. `existingTotalDistance`/`existingAvgSpeed`
// are the already-normalized (possibly client-sent) values: when present
// and finite, they are returned untouched (never recomputed, never
// overwritten) so a client that DOES compute these itself is always
// authoritative. `durationMs` is the already-computed normalized
// duration_ms for this row, used as the reference duration for avg_speed/
// pause_frequency/pause_duration_ratio — never re-derived independently —
// so these new fields stay internally consistent with the row's own
// duration_ms rather than a second, possibly slightly different value.
//
// Returns null (never a fabricated 0) for every field when strokePoints
// doesn't represent a usable (>= 2 point) trajectory — a genuinely
// malformed/empty capture is left honestly unmeasurable, not zero-filled.
// Duration-correction pass: also derives the tAbs-based, ML-safe
// attempt_duration_ms/attempt_avg_speed/attempt_pause_frequency/
// attempt_pause_duration_ratio family. `existingAttempt*` follow the exact
// same "client-sent value wins, never overwritten" rule as
// existingTotalDistance/existingAvgSpeed above. attempt_duration_ms is
// ALWAYS computed from raw tAbs via calculateAttemptDurationFromAbsoluteTime()
// — it never falls back to `durationMs` (the legacy, possibly
// multi-stroke-truncated value) even when tAbs derivation fails; in that
// case it stays null (Part 8: "do not fall back to the broken multi-stroke
// duration_ms for attempt_duration_ms").
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

  // attempt_duration_ms is independent of `usable`/`durationMs` — it has
  // its own null-safety (>= 2 valid tAbs, max > min) inside
  // calculateAttemptDurationFromAbsoluteTime() itself, and is derived even
  // for a "not usable by x/y standards" trajectory as long as tAbs is fine
  // (x/y malformed but timestamps intact is a real, distinct case).
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
    // ML readiness pass — additive keys, see deriveTrajectoryFeatures() above.
    'speed_mean', 'speed_std', 'speed_cv',
    'total_pause_duration_ms', 'mean_pause_duration_ms', 'pause_frequency', 'pause_duration_ratio',
    // Duration-correction pass — tAbs-based, ML-safe counterparts.
    'attempt_duration_ms', 'attempt_avg_speed', 'attempt_pause_frequency', 'attempt_pause_duration_ratio',
  ];
  const validity = {};
  for (const key of keys) validity[key] = normalized[key] != null;
  return validity;
}

// raw: the `features` object sent for a shape (ShapeAssessmentScreen.js
// naming — already snake_case).
// meta.strokeCount: shape.stroke_count (sibling field, not inside features).
// meta.strokePoints: shape.strokes (the stored/raw per-stroke point arrays).
function normalizeShapeFeatures(raw, meta = {}) {
  const r = raw ?? {};

  const duration_ms = toFiniteOrNull(r.duration_ms);

  // ML readiness pass: shapes already send total_distance/avg_speed today
  // (existingTotalDistance/existingAvgSpeed below), so this only ever
  // supplies speed_mean/speed_std/speed_cv/pause-extras, which never
  // existed before — total_distance/avg_speed pass through exactly as
  // they always have.
  const derived = deriveTrajectoryFeatures(meta.strokePoints, {
    existingTotalDistance: toFiniteOrNull(r.total_distance),
    existingAvgSpeed:      toFiniteOrNull(r.avg_speed),
    durationMs:            duration_ms,
    // Duration-correction pass: an updated frontend sends these directly
    // (ShapeAssessmentScreen.js's calculateFeatures) — client value wins,
    // never recomputed/overwritten when present.
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
    // item 4: never fabricate 0 for missing shape accuracy (zigzag/curve_wave) — null when unavailable.
    accuracy_score:   r.accuracy != null ? scoreFromDeviation(toFiniteOrNull(r.accuracy), ACCURACY_MAX_PX) : null,
    dtw_distance:      toFiniteOrNull(r.dtw_distance),
    stroke_count:      toFiniteOrNull(meta.strokeCount) ?? toFiniteOrNull(r.stroke_count),
    direction_score:   computeDirectionScore(meta.strokePoints),
    // Shapes have no multi-stroke template/bipartite-matching concept today
    // (see computeMultiStrokeDTW, letters only) — honestly null, not fabricated.
    stroke_order_meta: r.stroke_order_meta ?? null,
    // ML readiness pass — additive fields, derived from raw stroke_points
    // via trajectoryFeatures.js. Never fed into motor_score/motorScore.js
    // (Part 6/7: "do not immediately use these in existing... motor score").
    speed_mean:               derived.speed_mean,
    speed_std:                 derived.speed_std,
    speed_cv:                  derived.speed_cv,
    total_pause_duration_ms:   derived.total_pause_duration_ms,
    mean_pause_duration_ms:    derived.mean_pause_duration_ms,
    pause_frequency:           derived.pause_frequency,
    pause_duration_ratio:      derived.pause_duration_ratio,
    // Duration-correction pass — tAbs-based, ML-safe. duration_ms/avg_speed/
    // pause_frequency/pause_duration_ratio above are completely unchanged.
    attempt_duration_ms:          derived.attempt_duration_ms,
    attempt_avg_speed:             derived.attempt_avg_speed,
    attempt_pause_frequency:       derived.attempt_pause_frequency,
    attempt_pause_duration_ratio:  derived.attempt_pause_duration_ratio,
  };

  return { normalized, validity: buildValidity(normalized) };
}

// raw: the `features` object sent per letter attempt (LetterWritingScreen.js
// naming — camelCase, mapped per item 3's table).
// meta.strokePoints: attempt.strokes (the stored/raw per-stroke point arrays).
function normalizeLetterFeatures(raw, meta = {}) {
  const r = raw ?? {};

  const duration_ms = toFiniteOrNull(r.completionTime ?? r.duration_ms);

  // ML readiness pass (Parts 1/2/6/7): letters historically never computed
  // total_distance/avg_speed on the frontend, and speed_std/speed_cv/
  // pause-extras never existed at all. As of this pass an updated frontend
  // DOES send total_distance/avg_speed (see LetterWritingScreen.js /
  // UppercaseWritingScreen.js's calculateDrawingFeatures) — when present,
  // that client-sent value is used as-is (existingTotalDistance/
  // existingAvgSpeed below, never overwritten). When absent (an
  // older/not-yet-updated app build, or any already-collected historical
  // row processed by the backfill script), every field here is derived
  // from the SAME raw stroke_points already stored in meta.strokePoints —
  // never a fabricated 0, and null whenever the trajectory itself is too
  // short/malformed to measure (see hasUsableTrajectory in
  // trajectoryFeatures.js).
  const derived = deriveTrajectoryFeatures(meta.strokePoints, {
    existingTotalDistance: toFiniteOrNull(r.total_distance),
    existingAvgSpeed:      toFiniteOrNull(r.avg_speed),
    durationMs:            duration_ms,
    // Duration-correction pass: an updated frontend sends these directly
    // (LetterWritingScreen.js / UppercaseWritingScreen.js's
    // calculateDrawingFeatures) — client value wins, never
    // recomputed/overwritten when present.
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
    // Letters never compute a raw `accuracy` deviation — always null here;
    // motorScore.js's dtw_distance fallback supplies the accuracy component.
    // Unchanged by this pass — see Part 4 of the ML-readiness report:
    // this remains NULL BY DESIGN, not a bug.
    accuracy_score:   null,
    dtw_distance:      toFiniteOrNull(r.dtw_distance),
    stroke_count:      toFiniteOrNull(r.strokeCount ?? r.stroke_count),
    direction_score:   computeDirectionScore(meta.strokePoints),
    // From computeMultiStrokeDTW on the frontend (dtw.js) — null for
    // single-stroke letters/templates, an object for multi-stroke ones.
    stroke_order_meta: r.stroke_order_meta ?? null,
    // ML readiness pass — additive fields, see deriveTrajectoryFeatures()
    // above. Never fed into motor_score/motorScore.js.
    speed_mean:               derived.speed_mean,
    speed_std:                 derived.speed_std,
    speed_cv:                  derived.speed_cv,
    total_pause_duration_ms:   derived.total_pause_duration_ms,
    mean_pause_duration_ms:    derived.mean_pause_duration_ms,
    pause_frequency:           derived.pause_frequency,
    pause_duration_ratio:      derived.pause_duration_ratio,
    // Duration-correction pass — tAbs-based, ML-safe. duration_ms/avg_speed/
    // pause_frequency/pause_duration_ratio above are completely unchanged.
    attempt_duration_ms:          derived.attempt_duration_ms,
    attempt_avg_speed:             derived.attempt_avg_speed,
    attempt_pause_frequency:       derived.attempt_pause_frequency,
    attempt_pause_duration_ratio:  derived.attempt_pause_duration_ratio,
  };

  return { normalized, validity: buildValidity(normalized) };
}

module.exports = { normalizeShapeFeatures, normalizeLetterFeatures };
