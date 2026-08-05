'use strict';

const { normalizeShapeFeatures, normalizeLetterFeatures } = require('../src/utils/featureNormalization');

describe('normalizeShapeFeatures', () => {
  it('maps shape feature names and inverts smoothness/accuracy into 0-100 scores', () => {
    const raw = {
      duration_ms: 1200, total_distance: 300, avg_speed: 0.25,
      smoothness: 0, pause_count: 1, accuracy: 0, dtw_distance: null,
    };
    const { normalized, validity } = normalizeShapeFeatures(raw, { strokeCount: 1, strokePoints: [] });

    expect(normalized.duration_ms).toBe(1200);
    expect(normalized.total_distance).toBe(300);
    expect(normalized.avg_speed).toBe(0.25);
    expect(normalized.smoothness_score).toBe(100); // 0 raw deviation -> perfect score
    expect(normalized.accuracy_score).toBe(100);    // 0 raw deviation -> perfect score
    expect(normalized.pause_count).toBe(1);
    expect(normalized.stroke_count).toBe(1);
    expect(validity.duration_ms).toBe(true);
    expect(validity.dtw_distance).toBe(false);
  });

  it('never fabricates 0 for missing accuracy (item 4) — stays null', () => {
    const raw = { duration_ms: 500, smoothness: 0.2, pause_count: 0, accuracy: null, dtw_distance: 12 };
    const { normalized, validity } = normalizeShapeFeatures(raw, {});

    expect(normalized.accuracy_score).toBeNull();
    expect(validity.accuracy_score).toBe(false);
    expect(normalized.dtw_distance).toBe(12); // passed through raw, not scored here
  });

  it('never fabricates a 0 or perfect dtw_distance for a missing/incomplete attempt — stays null', () => {
    const raw = { duration_ms: 500, smoothness: 0.2, pause_count: 0, accuracy: null, dtw_distance: null };
    const { normalized, validity } = normalizeShapeFeatures(raw, {});

    expect(normalized.dtw_distance).toBeNull();
    expect(validity.dtw_distance).toBe(false);
  });

  it('shapes have no multi-stroke template concept — stroke_order_meta is always null', () => {
    const { normalized } = normalizeShapeFeatures({ dtw_distance: 5 }, {});
    expect(normalized.stroke_order_meta).toBeNull();
  });

  it('worse raw deviations produce lower scores than better ones', () => {
    const good = normalizeShapeFeatures({ smoothness: 0.1, accuracy: 5 }, {}).normalized;
    const bad  = normalizeShapeFeatures({ smoothness: 0.8, accuracy: 55 }, {}).normalized;

    expect(good.smoothness_score).toBeGreaterThan(bad.smoothness_score);
    expect(good.accuracy_score).toBeGreaterThan(bad.accuracy_score);
  });
});

describe('normalizeLetterFeatures', () => {
  it('maps camelCase letter feature names to the canonical schema', () => {
    const raw = { completionTime: 900, pauseCount: 2, smoothness: 0.15, strokeCount: 2, dtw_distance: 8 };
    const { normalized, validity } = normalizeLetterFeatures(raw, { strokePoints: [] });

    expect(normalized.duration_ms).toBe(900);
    expect(normalized.pause_count).toBe(2);
    expect(normalized.stroke_count).toBe(2);
    expect(normalized.dtw_distance).toBe(8);
    // Letters never compute a raw accuracy deviation — always null here.
    expect(normalized.accuracy_score).toBeNull();
    expect(validity.accuracy_score).toBe(false);
    // Letters don't compute total_distance/avg_speed today — honestly null.
    expect(normalized.total_distance).toBeNull();
    expect(normalized.avg_speed).toBeNull();
  });

  it('handles a completely empty features object without throwing', () => {
    const { normalized, validity } = normalizeLetterFeatures(null, {});
    for (const key of Object.keys(validity)) {
      expect(normalized[key]).toBeNull();
      expect(validity[key]).toBe(false);
    }
  });

  it('never fabricates a 0 or perfect dtw_distance for a missing/incomplete attempt — stays null', () => {
    const raw = { completionTime: 900, pauseCount: 2, smoothness: 0.15, strokeCount: 2, dtw_distance: null };
    const { normalized, validity } = normalizeLetterFeatures(raw, {});

    expect(normalized.dtw_distance).toBeNull();
    expect(validity.dtw_distance).toBe(false);
  });

  it('passes stroke_order_meta through unchanged for multi-stroke letters (computeMultiStrokeDTW)', () => {
    const strokeOrderMeta = {
      childStrokeCount: 2, templateStrokeCount: 2,
      strokeOrderMatchesTemplate: false,
      matchedOrder: [{ childStroke: 1, templateStroke: 0 }, { childStroke: 0, templateStroke: 1 }],
    };
    const { normalized } = normalizeLetterFeatures({ dtw_distance: 27, stroke_order_meta: strokeOrderMeta }, {});
    expect(normalized.stroke_order_meta).toEqual(strokeOrderMeta);
  });

  it('single-stroke letters have no stroke order concept — stroke_order_meta is null', () => {
    const { normalized } = normalizeLetterFeatures({ dtw_distance: 5, stroke_order_meta: null }, {});
    expect(normalized.stroke_order_meta).toBeNull();
  });
});
