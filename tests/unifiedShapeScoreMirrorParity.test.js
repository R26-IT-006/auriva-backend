'use strict';

// Drift test: unifiedShapeScoreMirror.js (frontend) MUST stay equivalent to
// unifiedShapeScore.js (backend, canonical). Requires both directly and
// fails the whole suite the moment they disagree — do not weaken these
// assertions to make an unmirrored change land; mirror the change instead.
//
// Both files are fully self-contained (each has its own DTW +
// normalization primitives — see unifiedShapeScoreMirror.js's header for
// why it doesn't delegate to auriva-frontend's dtw.js/dtwNormalization.js:
// those are ES modules this backend's plain Jest can't parse, and adding a
// babel/ESM transform just for this test was rejected as its own,
// unnecessary build-config risk). So a failure here has exactly one cause:
// the canonical file and the mirror have drifted apart — either was edited
// without updating the other.

const path = require('path');
const canonical = require('../src/utils/unifiedShapeScore');
const mirror = require(path.resolve(__dirname, '..', '..', 'auriva-frontend', 'src', 'utils', 'unifiedShapeScoreMirror'));

const SHAPES = ['horizontal_line', 'vertical_line', 'full_circle', 'half_circle', 'zigzag', 'curve_wave'];
const CANVAS_SIZES = [{ w: 791, h: 427 }, { w: 1024, h: 768 }];

const reversePath = points => [...points].reverse();
const offsetPath  = (points, dx, dy) => points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }));
const scalePath    = (points, f, cx, cy) => points.map(p => ({ ...p, x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }));

describe('unifiedShapeScoreMirrorParity', () => {
  test('config constants match', () => {
    expect(mirror.DTW_DIVISOR).toBe(canonical.DTW_DIVISOR);
    expect(mirror.ROTATION_STEP_DEG).toBe(canonical.ROTATION_STEP_DEG);
    expect(mirror.SMOOTHNESS_CEILING).toBe(canonical.SMOOTHNESS_CEILING);
    expect(mirror.SMOOTHNESS_WEIGHT).toBe(canonical.SMOOTHNESS_WEIGHT);
    expect(mirror.ROTATION_INVARIANT_SHAPES).toEqual(canonical.ROTATION_INVARIANT_SHAPES);
    expect(mirror.N_TEMPLATE_POINTS).toBe(canonical.N_TEMPLATE_POINTS);
  });

  describe.each(CANVAS_SIZES)('canvas $w x $h', ({ w, h }) => {
    test.each(SHAPES)('%s — template geometry matches', (shapeId) => {
      const a = canonical.computeShapeTemplate(shapeId, w, h);
      const b = mirror.computeShapeTemplate(shapeId, w, h);
      expect(a.length).toBe(b.length);
      a.forEach((p, i) => { expect(b[i].x).toBeCloseTo(p.x, 9); expect(b[i].y).toBeCloseTo(p.y, 9); });
    });

    test.each(SHAPES)('%s — invariant DTW matches: perfect trace', (shapeId) => {
      const template = canonical.computeShapeTemplate(shapeId, w, h);
      const a = canonical.computeInvariantDtwDistance(template, shapeId, w, h);
      const b = mirror.computeInvariantDtwDistance(template, shapeId, w, h);
      expect(a).not.toBeNull();
      expect(b).toBeCloseTo(a, 6);
    });

    test.each(SHAPES)('%s — invariant DTW matches: reversed trace, and equals forward (reversal invariance)', (shapeId) => {
      const template = canonical.computeShapeTemplate(shapeId, w, h);
      const reversed = reversePath(template);
      const a = canonical.computeInvariantDtwDistance(reversed, shapeId, w, h);
      const b = mirror.computeInvariantDtwDistance(reversed, shapeId, w, h);
      const forward = canonical.computeInvariantDtwDistance(template, shapeId, w, h);
      expect(a).not.toBeNull();
      expect(b).toBeCloseTo(a, 6);
      expect(a).toBeCloseTo(forward, 6);
    });

    test.each(SHAPES)('%s — invariant DTW matches: offset + scaled trace', (shapeId) => {
      const template = canonical.computeShapeTemplate(shapeId, w, h);
      const distorted = scalePath(offsetPath(template, 15, -8), 0.85, w / 2, h / 2);
      const a = canonical.computeInvariantDtwDistance(distorted, shapeId, w, h);
      const b = mirror.computeInvariantDtwDistance(distorted, shapeId, w, h);
      expect(a).not.toBeNull();
      expect(b).toBeCloseTo(a, 6);
    });

    test('full_circle — 172deg rotated start point resolved identically by both (mirrors real id=254 case)', () => {
      const template = canonical.computeShapeTemplate('full_circle', w, h);
      const shift = Math.round((172 / 360) * canonical.N_TEMPLATE_POINTS);
      const rotatedChild = [...template.slice(shift), ...template.slice(0, shift)];
      const a = canonical.computeInvariantDtwDistance(rotatedChild, 'full_circle', w, h);
      const b = mirror.computeInvariantDtwDistance(rotatedChild, 'full_circle', w, h);
      expect(a).not.toBeNull();
      expect(a).toBeLessThan(5); // confirms rotation invariance actually resolves it
      expect(b).toBeCloseTo(a, 6);
    });

    test.each(SHAPES)('%s — a genuinely bad trace still matches between canonical and mirror', (shapeId) => {
      const badTrace = Array.from({ length: 60 }, (_, i) => ({ x: (i / 59) * w, y: (i / 59) * h }));
      const a = canonical.computeInvariantDtwDistance(badTrace, shapeId, w, h);
      const b = mirror.computeInvariantDtwDistance(badTrace, shapeId, w, h);
      expect(a).not.toBeNull();
      expect(b).toBeCloseTo(a, 6);
    });
  });

  test.each([
    [0, 0.05], [3.5, 0.12], [8.2, 0.28], [12, 0.05], [0.65, 0.0], [45, 0.5], [null, 0.1], [3, null], [null, null],
  ])('score combiner matches for dtwDistance=%p smoothnessRaw=%p', (dtw, smooth) => {
    expect(mirror.computeUnifiedShapeScore(dtw, smooth)).toEqual(canonical.computeUnifiedShapeScore(dtw, smooth));
  });
});
