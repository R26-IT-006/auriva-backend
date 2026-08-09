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

function toFiniteOrNull(value) {
  if (value == null) return null; // Number(null) is 0, not NaN — guard explicitly
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildValidity(normalized) {
  const keys = [
    'duration_ms', 'total_distance', 'avg_speed', 'smoothness_score',
    'pause_count', 'accuracy_score', 'dtw_distance', 'stroke_count', 'direction_score',
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

  const normalized = {
    duration_ms:      toFiniteOrNull(r.duration_ms),
    total_distance:   toFiniteOrNull(r.total_distance),
    avg_speed:        toFiniteOrNull(r.avg_speed),
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
  };

  return { normalized, validity: buildValidity(normalized) };
}

// raw: the `features` object sent per letter attempt (LetterWritingScreen.js
// naming — camelCase, mapped per item 3's table).
// meta.strokePoints: attempt.strokes (the stored/raw per-stroke point arrays).
function normalizeLetterFeatures(raw, meta = {}) {
  const r = raw ?? {};

  const normalized = {
    duration_ms:      toFiniteOrNull(r.completionTime ?? r.duration_ms),
    // Letters don't compute total_distance/avg_speed on the frontend today —
    // honestly null (feature_validity reflects this) rather than fabricated.
    total_distance:   toFiniteOrNull(r.total_distance),
    avg_speed:        toFiniteOrNull(r.avg_speed),
    smoothness_score: r.smoothness != null ? scoreFromDeviation(toFiniteOrNull(r.smoothness), SMOOTHNESS_MAX_RAD) : null,
    pause_count:      toFiniteOrNull(r.pauseCount ?? r.pause_count),
    // Letters never compute a raw `accuracy` deviation — always null here;
    // motorScore.js's dtw_distance fallback supplies the accuracy component.
    accuracy_score:   null,
    dtw_distance:      toFiniteOrNull(r.dtw_distance),
    stroke_count:      toFiniteOrNull(r.strokeCount ?? r.stroke_count),
    direction_score:   computeDirectionScore(meta.strokePoints),
    // From computeMultiStrokeDTW on the frontend (dtw.js) — null for
    // single-stroke letters/templates, an object for multi-stroke ones.
    stroke_order_meta: r.stroke_order_meta ?? null,
  };

  return { normalized, validity: buildValidity(normalized) };
}

module.exports = { normalizeShapeFeatures, normalizeLetterFeatures };
