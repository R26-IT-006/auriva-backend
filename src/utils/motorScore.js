'use strict';

// Motor Score equation (research-defined weights, not clinically validated):
//
//   motor_score = 0.35 * accuracy_component
//               + 0.25 * smoothness_score
//               + 0.15 * pause_control_score
//               + 0.15 * direction_score
//               + 0.10 * speed_control_score
//
// All component scores are 0-100, higher = better. Pressure is intentionally
// excluded — the device does not capture it. Any missing component is
// dropped and the remaining weights are renormalized (null-aware weighting)
// rather than treated as 0. If nothing is available, motor_score is null.
//
// Input provenance (via featureNormalization.js): direction_score is always
// recomputed from raw strokes on the server; smoothness, dtw_distance and
// pause_count come from the client's submitted features, and avg_speed too
// when the client sends it.
//
// score_version identifies this formula + its calibration constants, so a
// later recalibration doesn't silently change the meaning of stored scores.
const SCORE_VERSION = 'v1';

const WEIGHTS = {
  accuracy:    0.35,
  smoothness:  0.25,
  pause:       0.15,
  direction:   0.15,
  speed:       0.10,
};

// ── v1 calibration constants ────────────────────────────────────────────────
// Documented starting points, not clinically validated. motor_score is
// nonetheless the authoritative attempt-3 mastery score (default threshold 70, see
// config/masteryPolicy.js); recalibrate these against collected pilot data.
const SMOOTHNESS_MAX_RAD   = 1.0;   // mean turning-angle ceiling (~57 deg) treated as "worst"
const ACCURACY_MAX_PX      = 60;    // mean pixel deviation from ideal geometry treated as "worst"
// dtw_distance is in dtw_norm_v1 units (frontend dtwNormalization.js), not
// raw pixels. Matches the frontend's DTW_CAP so both scores agree on "worst".
const DTW_MAX_NORM         = 45;
const PAUSE_MAX_COUNT      = 5;     // pauses (>300ms gaps) at/above this score 0
const SPEED_MIN_PX_MS      = 0.05;  // below this, too slow/labored
const SPEED_MAX_PX_MS      = 0.5;   // above this, too fast/sloppy
const REVERSAL_ANGLE_RAD   = Math.PI / 2; // >90 deg turn counts as a "sharp reversal"
const MAX_REVERSAL_DENSITY = 0.3;   // fraction of turning angles that are reversals, treated as "worst"

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Inverts a "lower is better" raw deviation into a 0-100 "higher is better" score.
function scoreFromDeviation(rawValue, ceiling) {
  if (rawValue == null || !Number.isFinite(rawValue)) return null;
  return Math.round(100 * (1 - clamp(rawValue / ceiling, 0, 1)));
}

// Flattens the stored stroke_points shape ([{stroke_id, points:[{x,y,...}]}])
// into one ordered array of {x,y}. Also tolerates an already-flat array.
function flattenStrokePoints(strokePoints) {
  if (!Array.isArray(strokePoints) || strokePoints.length === 0) return [];
  if (strokePoints[0] && Array.isArray(strokePoints[0].points)) {
    return strokePoints.flatMap(stroke => stroke.points ?? []);
  }
  return strokePoints;
}

// direction_score: a geometry-only proxy for direction control — the share
// of measured turning angles that are sharp (>90 deg) reversals along the
// raw path. Assumes no per-letter expected stroke count (no validated ground
// truth exists). Distinct from smoothness_score, which reflects small-angle
// jitter rather than discrete reversals.
function computeDirectionScore(strokePoints) {
  const points = flattenStrokePoints(strokePoints);
  if (points.length < 3) return null;

  let reversals = 0;
  let angleCount = 0;

  for (let i = 1; i < points.length - 1; i++) {
    const v1x = points[i].x - points[i - 1].x;
    const v1y = points[i].y - points[i - 1].y;
    const v2x = points[i + 1].x - points[i].x;
    const v2y = points[i + 1].y - points[i].y;
    const l1 = Math.sqrt(v1x * v1x + v1y * v1y);
    const l2 = Math.sqrt(v2x * v2x + v2y * v2y);
    if (l1 === 0 || l2 === 0) continue;

    const dot   = (v1x * v2x + v1y * v2y) / (l1 * l2);
    const angle = Math.acos(clamp(dot, -1, 1));
    angleCount++;
    if (angle > REVERSAL_ANGLE_RAD) reversals++;
  }

  if (angleCount === 0) return null;
  const reversalDensity = reversals / angleCount;
  return Math.round(100 * (1 - clamp(reversalDensity / MAX_REVERSAL_DENSITY, 0, 1)));
}

function pauseControlScore(pauseCount) {
  if (pauseCount == null || !Number.isFinite(pauseCount)) return null;
  return Math.round(100 * (1 - clamp(pauseCount / PAUSE_MAX_COUNT, 0, 1)));
}

function speedControlScore(avgSpeed) {
  if (avgSpeed == null || !Number.isFinite(avgSpeed)) return null;
  if (avgSpeed >= SPEED_MIN_PX_MS && avgSpeed <= SPEED_MAX_PX_MS) return 100;
  if (avgSpeed < SPEED_MIN_PX_MS) {
    return Math.round(100 * clamp(avgSpeed / SPEED_MIN_PX_MS, 0, 1));
  }
  const excess = avgSpeed - SPEED_MAX_PX_MS;
  return Math.round(100 * clamp(1 - excess / SPEED_MAX_PX_MS, 0, 1));
}

// normalized: the canonical feature object from featureNormalization.js.
// Components that are missing are skipped, never scored as zero.
function computeMotorScore(normalized) {
  const n = normalized ?? {};

  let accuracyComponent = n.accuracy_score;
  if (accuracyComponent == null && n.dtw_distance != null) {
    // No direct accuracy reading (all letters, zigzag, curve_wave):
    // derive the accuracy component from dtw_distance instead.
    accuracyComponent = scoreFromDeviation(n.dtw_distance, DTW_MAX_NORM);
  }

  const components = {
    accuracy:   accuracyComponent,
    smoothness: n.smoothness_score ?? null,
    pause:      pauseControlScore(n.pause_count),
    direction:  n.direction_score ?? null,
    speed:      speedControlScore(n.avg_speed),
  };

  let weightedSum  = 0;
  let weightTotal  = 0;
  for (const key of Object.keys(WEIGHTS)) {
    const value = components[key];
    if (value == null) continue;
    weightedSum += WEIGHTS[key] * value;
    weightTotal += WEIGHTS[key];
  }

  const motor_score = weightTotal > 0
    ? Math.round(clamp(weightedSum / weightTotal, 0, 100))
    : null;

  return {
    motor_score,
    quality_score: motor_score, // mirrors motor_score for v1; kept as its own
                                 // column so it can diverge later without a migration
    score_version: SCORE_VERSION,
    componentScores: components,
  };
}

module.exports = {
  SCORE_VERSION,
  WEIGHTS,
  SMOOTHNESS_MAX_RAD,
  ACCURACY_MAX_PX,
  clamp,
  scoreFromDeviation,
  flattenStrokePoints,
  computeDirectionScore,
  pauseControlScore,
  speedControlScore,
  computeMotorScore,
};
