'use strict';

/**
 * deriveMotorScoreFromStoredShape.test.js
 *
 * Teacher-report null-score fix: historical assessments (recorded before
 * motor_score existed) must render the REAL score computed from their raw
 * stroke_points/canvas dimensions/smoothness — via the same canonical
 * unifiedShapeScore formula — never the old ?? 50 fallback, and never a
 * value that differs from what a live assessment would have produced.
 *
 * Calls the REAL, unmodified production function — no reimplementation.
 */

const {
  computeShapeTemplate, computeInvariantDtwDistance, computeUnifiedShapeScore,
  deriveMotorScoreFromStoredShape,
} = require('../src/utils/unifiedShapeScore');

const CANVAS = { w: 791, h: 427 };

function strokePointsFromFlat(points) {
  return [{ stroke_id: 0, points }];
}

describe('deriveMotorScoreFromStoredShape', () => {
  it('a shape that already has motor_score (post-unification assessment): passes it through verbatim, never recomputes', () => {
    const result = deriveMotorScoreFromStoredShape({
      shapeId: 'full_circle',
      features: { motor_score: 77, dtw_score: 80, smoothness_score: 65, smoothness: 0.5 },
      strokes: [], // deliberately empty/wrong — must be ignored since motor_score is already present
      canvasWidth: CANVAS.w, canvasHeight: CANVAS.h,
    });
    expect(result).toEqual({ motor_score: 77, dtw_score: 80, smoothness_score: 65, source: 'stored' });
  });

  it('a historical shape with no motor_score but real stroke_points/canvas dims/smoothness: recomputes a real score matching direct computation', () => {
    const template = computeShapeTemplate('vertical_line', CANVAS.w, CANVAS.h);
    const smoothnessRaw = 0.08;
    const expectedDtw = computeInvariantDtwDistance(template, 'vertical_line', CANVAS.w, CANVAS.h);
    const expected = computeUnifiedShapeScore(expectedDtw, smoothnessRaw);

    const result = deriveMotorScoreFromStoredShape({
      shapeId: 'vertical_line',
      features: { smoothness: smoothnessRaw }, // no motor_score — the historical-row case
      strokes: strokePointsFromFlat(template),
      canvasWidth: CANVAS.w, canvasHeight: CANVAS.h,
    });

    expect(result.source).toBe('recomputed_on_read');
    expect(result.motor_score).toBe(expected.motor_score);
    expect(result.dtw_score).toBe(expected.dtw_score);
    expect(result.smoothness_score).toBe(expected.smoothness_score);
  });

  it('a historical full_circle shape traced in the "wrong" direction/start point still recomputes correctly (invariance applies on read too)', () => {
    // Mirrors the real id=254 anomaly from the Step 1 investigation: a
    // circle traced starting 172deg from the template's own start.
    const template = computeShapeTemplate('full_circle', CANVAS.w, CANVAS.h);
    const shift = Math.round((172 / 360) * template.length);
    const rotatedChild = [...template.slice(shift), ...template.slice(0, shift)];

    const result = deriveMotorScoreFromStoredShape({
      shapeId: 'full_circle',
      features: { smoothness: 0.1 },
      strokes: strokePointsFromFlat(rotatedChild),
      canvasWidth: CANVAS.w, canvasHeight: CANVAS.h,
    });

    expect(result.source).toBe('recomputed_on_read');
    expect(result.motor_score).toBeGreaterThan(60); // resolved by rotation invariance, not penalized as a near-miss
  });

  it('no stroke_points AND no stored smoothness: explicit unavailable, never a fabricated number', () => {
    const result = deriveMotorScoreFromStoredShape({
      shapeId: 'horizontal_line',
      features: {},
      strokes: [],
      canvasWidth: CANVAS.w, canvasHeight: CANVAS.h,
    });
    expect(result).toEqual({ motor_score: null, dtw_score: null, smoothness_score: null, source: 'unavailable' });
  });

  it('no stroke_points but a stored smoothness value: falls back to a real smoothness-only score, not null and not a fabricated number', () => {
    const result = deriveMotorScoreFromStoredShape({
      shapeId: 'zigzag',
      features: { smoothness: 0.05 },
      strokes: [],
      canvasWidth: CANVAS.w, canvasHeight: CANVAS.h,
    });
    const expected = computeUnifiedShapeScore(null, 0.05);
    expect(result.motor_score).toBe(expected.motor_score);
    expect(result.source).toBe('recomputed_on_read');
  });

  it('missing canvas dimensions: cannot recompute DTW (template geometry unknown), falls back to smoothness-only rather than a wrong template size', () => {
    const template = computeShapeTemplate('full_circle', CANVAS.w, CANVAS.h);
    const result = deriveMotorScoreFromStoredShape({
      shapeId: 'full_circle',
      features: { smoothness: 0.1 },
      strokes: strokePointsFromFlat(template),
      canvasWidth: null, canvasHeight: null,
    });
    const expected = computeUnifiedShapeScore(null, 0.1);
    expect(result.motor_score).toBe(expected.motor_score);
  });
});
