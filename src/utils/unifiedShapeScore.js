'use strict';

// Unified shape score — canonical formula for the six-shape initial
// assessment: direction-invariant DTW (0.8) + smoothness (0.2).
//
// auriva-frontend/src/utils/unifiedShapeScoreMirror.js mirrors this file so
// the tablet can score shapes on-device before any network call. Change the
// formula or constants HERE first, then mirror them;
// tests/unifiedShapeScoreMirrorParity.test.js fails if the two disagree.
//
// Two shape-score domains — do not confuse them:
//   - This formula (via the frontend mirror) produces the per-shape scores
//     behind motor_profile and StudentMotorBaseline.straight/curved/
//     complex_score, which feed rule-based letter sequencing and the
//     teacher-facing Initial Handwriting Skills Summary. On the backend,
//     deriveMotorScoreFromStoredShape() recomputes it on read for older
//     assessments that lack a stored motor_score (getInitialReport).
//   - utils/motorScore.js's computeMotorScore() is a separate 5-component
//     formula. It fills ShapeFeature.motor_score (and from it the
//     StudentMotorBaseline.progression_* columns) and is the authoritative
//     letter-mastery score for LetterAttempt rows.
// The inactive Shape K-Means model is served from the straight/curved/
// complex_score columns; its training vectors came from a different score
// domain (ML workflow audit, docs/ml-workflow-audit/02, outside this repo).
//
// Shares no code with the frontend's letter DTW (computeMultiStrokeDTW in
// dtw.js): this module must run in Node, and its shape-only invariances
// (reversal, full_circle rotation search) do not apply to letters. The DTW
// recurrence itself is the same as dtw.js's computeDTW.

const DTW_DIVISOR        = 10;   // invariant DTW distance treated as "worst" at this value
const ROTATION_STEP_DEG  = 10;   // full_circle rotation-search granularity (36 rotations)
const SMOOTHNESS_CEILING = 0.3;  // mean turning-angle (rad) treated as "worst"
const SMOOTHNESS_WEIGHT  = 0.2;  // secondary weight; DTW carries the remaining 0.8

// Shapes with no canonical start point get a rotation-sweep search in
// addition to direction (reversal) invariance. Only a full circle qualifies;
// every other shape has two distinct endpoints, which reversal alone covers.
const ROTATION_INVARIANT_SHAPES = ['full_circle'];

const N_TEMPLATE_POINTS = 100;

// Generic [{stroke_id, points}] -> [{x,y,...}] helper (not part of the formula).
const { flattenStrokePoints } = require('./motorScore');

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Reference template for each shape, in canvas pixels. Same geometry as the
// frontend mirror's computeShapeTemplate(); canvas size is a parameter
// (stored per row as canvas_width/canvas_height), not a hardcoded device size.
function computeShapeTemplate(shapeId, canvasWidth, canvasHeight, nPoints = N_TEMPLATE_POINTS) {
  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;
  const pts = [];

  if (shapeId === 'horizontal_line') {
    for (let i = 0; i <= nPoints; i++) {
      const t = i / nPoints;
      pts.push({ x: cx - 200 + t * 400, y: cy });
    }
  } else if (shapeId === 'vertical_line') {
    for (let i = 0; i <= nPoints; i++) {
      const t = i / nPoints;
      pts.push({ x: cx, y: cy - 150 + t * 300 });
    }
  } else if (shapeId === 'full_circle') {
    const r = 120;
    for (let i = 0; i <= nPoints; i++) {
      const angle = -Math.PI / 2 + (i / nPoints) * 2 * Math.PI;
      pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  } else if (shapeId === 'half_circle') {
    const r = 150;
    for (let i = 0; i <= nPoints; i++) {
      const angle = Math.PI + (i / nPoints) * Math.PI;
      pts.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
    }
  } else if (shapeId === 'zigzag') {
    const nodes = [
      { x: cx - 180, y: cy + 40 }, { x: cx - 120, y: cy - 40 }, { x: cx - 60, y: cy + 40 },
      { x: cx,       y: cy - 40 }, { x: cx + 60,  y: cy + 40 }, { x: cx + 120, y: cy - 40 },
      { x: cx + 180, y: cy + 40 },
    ];
    const segs = nodes.length - 1;
    const perSeg = Math.floor(nPoints / segs);
    for (let s = 0; s < segs; s++) {
      const from = nodes[s], to = nodes[s + 1];
      const count = s === segs - 1 ? nPoints - s * perSeg + 1 : perSeg;
      for (let i = 0; i < count; i++) {
        const t = i / (count > 1 ? count - 1 : 1);
        pts.push({ x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) });
      }
    }
  } else if (shapeId === 'curve_wave') {
    const segs = [
      { p0: { x: cx - 180, y: cy }, p1: { x: cx - 120, y: cy - 60 }, p2: { x: cx - 60, y: cy } },
      { p0: { x: cx - 60,  y: cy }, p1: { x: cx,       y: cy + 60 }, p2: { x: cx + 60, y: cy } },
      { p0: { x: cx + 60,  y: cy }, p1: { x: cx + 120, y: cy - 60 }, p2: { x: cx + 180, y: cy } },
    ];
    const perSeg = Math.floor(nPoints / 3);
    for (let s = 0; s < 3; s++) {
      const { p0, p1, p2 } = segs[s];
      const count = s === 2 ? nPoints - s * perSeg + 1 : perSeg;
      for (let i = 0; i < count; i++) {
        const t = i / (count > 1 ? count - 1 : 1);
        pts.push({
          x: (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x,
          y: (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y,
        });
      }
    }
  }

  return pts;
}

// Bounding-box normalization (dtw_norm_v1 — same method as
// dtwNormalization.js: translate + scale to a 100-unit box, order-invariant
// since it only uses min/max).
function normalizePoints(points, targetSize = 100) {
  if (!Array.isArray(points) || points.length === 0) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (!Number.isFinite(minX)) return points.map(p => ({ ...p }));
  const span = Math.max(maxX - minX, maxY - minY);
  const scale = span > 1e-6 ? targetSize / span : 1;
  return points.map(p => ({ ...p, x: (p.x - minX) * scale, y: (p.y - minY) * scale }));
}

// Same DP algorithm as dtw.js's computeDTW.
function computeDtw(seqA, seqB) {
  if (!seqA || !seqB || seqA.length < 2 || seqB.length < 2) return null;
  const n = seqA.length, m = seqB.length;
  const cost = new Float64Array(n * m);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  cost[0] = dist(seqA[0], seqB[0]);
  for (let i = 1; i < n; i++) cost[i * m] = cost[(i - 1) * m] + dist(seqA[i], seqB[0]);
  for (let j = 1; j < m; j++) cost[j] = cost[j - 1] + dist(seqA[0], seqB[j]);
  for (let i = 1; i < n; i++) {
    for (let j = 1; j < m; j++) {
      const left = cost[i * m + (j - 1)], down = cost[(i - 1) * m + j], diag = cost[(i - 1) * m + (j - 1)];
      cost[i * m + j] = dist(seqA[i], seqB[j]) + Math.min(left, down, diag);
    }
  }
  const distance = cost[n * m - 1];

  let i = n - 1, j = m - 1, pathLen = 1;
  while (i > 0 || j > 0) {
    if (i === 0) j--;
    else if (j === 0) i--;
    else {
      const left = cost[i * m + (j - 1)], down = cost[(i - 1) * m + j], diag = cost[(i - 1) * m + (j - 1)];
      if (diag <= left && diag <= down) { i--; j--; }
      else if (left <= down) j--;
      else i--;
    }
    pathLen++;
  }
  return distance / pathLen;
}

function rotateTemplate(template, shiftPoints) {
  return [...template.slice(shiftPoints), ...template.slice(0, shiftPoints)];
}

/**
 * Direction- and (for full_circle only) start-point-invariant DTW distance.
 * @param {Array<{x:number,y:number}>} childPoints  raw stroke points (flattened, absolute canvas pixels)
 */
function computeInvariantDtwDistance(childPoints, shapeId, canvasWidth, canvasHeight) {
  if (!Array.isArray(childPoints) || childPoints.length < 2) return null;
  const template = computeShapeTemplate(shapeId, canvasWidth, canvasHeight);
  if (template.length < 2) return null;

  const normChildFwd = normalizePoints(childPoints);
  const normChildRev = [...normChildFwd].reverse();

  const rotationShifts = ROTATION_INVARIANT_SHAPES.includes(shapeId)
    ? Array.from(
        { length: Math.round(360 / ROTATION_STEP_DEG) },
        (_, k) => Math.round((k * ROTATION_STEP_DEG / 360) * N_TEMPLATE_POINTS),
      )
    : [0];

  let best = Infinity;
  for (const shift of rotationShifts) {
    const rotated = shift === 0 ? template : rotateTemplate(template, shift);
    const normTemplate = normalizePoints(rotated);
    const fwd = computeDtw(normChildFwd, normTemplate);
    const rev = computeDtw(normChildRev, normTemplate);
    if (fwd != null && fwd < best) best = fwd;
    if (rev != null && rev < best) best = rev;
  }
  return Number.isFinite(best) ? best : null;
}

// Mean turning angle (radians), the same metric as the frontend's
// calculateFeatures(). Exported for validation/backfill tooling; not called
// by deriveMotorScoreFromStoredShape(), which uses the stored client value.
// Limitation: fewer than 3 points returns 0, which scores as perfectly smooth.
function computeSmoothnessRaw(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  const changes = [];
  for (let i = 1; i < points.length - 1; i++) {
    const v1x = points[i].x - points[i - 1].x, v1y = points[i].y - points[i - 1].y;
    const v2x = points[i + 1].x - points[i].x, v2y = points[i + 1].y - points[i].y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (l1 > 0 && l2 > 0) {
      const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
      changes.push(Math.acos(clamp(dot, -1, 1)));
    }
  }
  return changes.length > 0 ? changes.reduce((a, b) => a + b, 0) / changes.length : 0;
}

// Calculate unified motor score: 0.8 * dtwScore + 0.2 * smoothnessScore.
// Ceilings (DTW_DIVISOR, SMOOTHNESS_CEILING) sit just above the observed
// maximum in the 42-row pilot sample, so nothing clips; pilot-derived, not
// clinically validated. Coverage was tested and excluded (89.4-100%, SD 2.16,
// effectively constant). If one component is missing, the other is used alone.
function computeUnifiedShapeScore(dtwDistance, smoothnessRaw) {
  const dtwScore = dtwDistance == null ? null : clamp(100 - (dtwDistance / DTW_DIVISOR) * 100, 0, 100);
  const smoothnessScore = smoothnessRaw == null ? null : clamp(100 - (smoothnessRaw / SMOOTHNESS_CEILING) * 100, 0, 100);

  if (dtwScore == null && smoothnessScore == null) return { motor_score: null, dtw_score: null, smoothness_score: null };
  if (dtwScore == null) return { motor_score: Math.round(smoothnessScore), dtw_score: null, smoothness_score: Math.round(smoothnessScore) };
  if (smoothnessScore == null) return { motor_score: Math.round(dtwScore), dtw_score: Math.round(dtwScore), smoothness_score: null };

  const motor_score = (1 - SMOOTHNESS_WEIGHT) * dtwScore + SMOOTHNESS_WEIGHT * smoothnessScore;
  return {
    motor_score: Math.round(clamp(motor_score, 0, 100)),
    dtw_score: Math.round(dtwScore),
    smoothness_score: Math.round(smoothnessScore),
  };
}

/**
 * Derives motor_score for one stored shape row on read (no migration).
 * Older assessments lack features.motor_score; it is recomputed with this
 * formula from the stored strokes, canvas size and the client's
 * features.smoothness. Returns explicit nulls, never a placeholder, when the
 * data is insufficient.
 *
 * @param {{ shapeId: string, features: object, strokes: Array, canvasWidth: number|null, canvasHeight: number|null }} shape
 * @returns {{ motor_score: number|null, dtw_score: number|null, smoothness_score: number|null, source: 'stored'|'recomputed_on_read'|'unavailable' }}
 */
function deriveMotorScoreFromStoredShape({ shapeId, features, strokes, canvasWidth, canvasHeight }) {
  // Use a stored score as-is (assessments captured with the current app).
  if (features?.motor_score != null) {
    return {
      motor_score: features.motor_score,
      dtw_score: features.dtw_score ?? null,
      smoothness_score: features.smoothness_score ?? null,
      source: 'stored',
    };
  }

  // Otherwise recompute from raw strokes; missing inputs stay null.
  const points = flattenStrokePoints(strokes);
  const canRecomputeDtw = shapeId
    && points.length >= 2
    && Number.isFinite(canvasWidth)
    && Number.isFinite(canvasHeight);
  const dtwDistance = canRecomputeDtw
    ? computeInvariantDtwDistance(points, shapeId, canvasWidth, canvasHeight)
    : null;
  const smoothnessRaw = typeof features?.smoothness === 'number' ? features.smoothness : null;

  const result = computeUnifiedShapeScore(dtwDistance, smoothnessRaw);
  return {
    ...result,
    source: result.motor_score == null ? 'unavailable' : 'recomputed_on_read',
  };
}

module.exports = {
  DTW_DIVISOR, ROTATION_STEP_DEG, SMOOTHNESS_CEILING, SMOOTHNESS_WEIGHT,
  ROTATION_INVARIANT_SHAPES, N_TEMPLATE_POINTS,
  computeShapeTemplate, normalizePoints, computeDtw,
  computeInvariantDtwDistance, computeSmoothnessRaw, computeUnifiedShapeScore,
  deriveMotorScoreFromStoredShape,
};
