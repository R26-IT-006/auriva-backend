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

// ─── ML readiness pass — additive derivation from raw stroke_points ────────
// (total_distance/avg_speed fallback for letters, plus speed_std/speed_cv/
// pause-extras for both shapes and letters — see deriveTrajectoryFeatures()
// in src/utils/featureNormalization.js and src/utils/trajectoryFeatures.js)

describe('normalizeLetterFeatures — trajectory-derived fallback (ML readiness pass)', () => {
  const strokePoints = [{
    stroke_id: 1,
    points: [
      { x: 0, y: 0, t: 0 },
      { x: 30, y: 40, t: 500 },   // +50px, gap 500 -> pause
      { x: 30, y: 90, t: 1200 },  // +50px, gap 700 -> pause
    ],
  }];

  it('derives total_distance/avg_speed from raw stroke_points when the client sent neither (old app build)', () => {
    const raw = { completionTime: 1200, smoothness: 0.1 }; // no total_distance/avg_speed sent
    const { normalized, validity } = normalizeLetterFeatures(raw, { strokePoints });

    expect(normalized.total_distance).toBe(100); // 50 + 50
    expect(normalized.avg_speed).toBeCloseTo(100 / 1200, 10); // uses the row's own duration_ms
    expect(validity.total_distance).toBe(true);
    expect(validity.avg_speed).toBe(true);
  });

  it('never overwrites a client-sent total_distance/avg_speed, even when stroke_points are also present', () => {
    const raw = { completionTime: 1200, total_distance: 999, avg_speed: 0.5 };
    const { normalized } = normalizeLetterFeatures(raw, { strokePoints });

    expect(normalized.total_distance).toBe(999);
    expect(normalized.avg_speed).toBe(0.5);
  });

  it('derives speed_mean/speed_std/speed_cv and pause-extras that never existed before', () => {
    const raw = { completionTime: 1200 };
    const { normalized, validity } = normalizeLetterFeatures(raw, { strokePoints });

    expect(normalized.speed_mean).not.toBeNull();
    expect(normalized.speed_std).not.toBeNull();
    // pause_count (existing field) is unaffected — client never sent pauseCount here, so it stays null;
    // the NEW total_pause_duration_ms/pause_frequency/pause_duration_ratio are still derived from raw points.
    expect(normalized.pause_count).toBeNull();
    expect(normalized.total_pause_duration_ms).toBe(1200); // 500 + 700
    expect(normalized.mean_pause_duration_ms).toBe(600);
    expect(normalized.pause_frequency).toBeCloseTo(2 / 1.2, 10); // 2 pauses / 1.2s
    expect(normalized.pause_duration_ratio).toBeCloseTo(1200 / 1200, 10);
    expect(validity.speed_std).toBe(true);
    expect(validity.pause_frequency).toBe(true);
  });

  it('stays honestly null (never a fabricated 0) for a malformed/too-short trajectory', () => {
    const raw = { completionTime: 900 };
    const singlePoint = [{ stroke_id: 1, points: [{ x: 5, y: 5, t: 0 }] }];
    const { normalized, validity } = normalizeLetterFeatures(raw, { strokePoints: singlePoint });

    expect(normalized.total_distance).toBeNull();
    expect(normalized.avg_speed).toBeNull();
    expect(normalized.speed_std).toBeNull();
    expect(normalized.total_pause_duration_ms).toBeNull();
    expect(validity.total_distance).toBe(false);
  });

  it('never crosses a pen-lift boundary when deriving total_distance for a multi-stroke letter', () => {
    const multiStroke = [
      { stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 3, y: 4, t: 100 }] }, // +5
      { stroke_id: 2, points: [{ x: 500, y: 500, t: 0 }, { x: 500, y: 508, t: 50 }] }, // +8, no cross-stroke jump
    ];
    const { normalized } = normalizeLetterFeatures({ completionTime: 150 }, { strokePoints: multiStroke });
    expect(normalized.total_distance).toBe(13); // 5 + 8, not 5 + huge-jump + 8
  });
});

describe('normalizeShapeFeatures — new speed/pause fields are additive only (ML readiness pass)', () => {
  it('leaves the existing client-sent total_distance/avg_speed untouched while adding speed_std/pause-extras', () => {
    const strokePoints = [{ stroke_id: 1, points: [
      { x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 500 }, { x: 200, y: 0, t: 1200 },
    ] }];
    const raw = { duration_ms: 1200, total_distance: 300, avg_speed: 0.25, smoothness: 0.1, accuracy: 5 };
    const { normalized, validity } = normalizeShapeFeatures(raw, { strokeCount: 1, strokePoints });

    // Existing pass-through behavior — completely unchanged.
    expect(normalized.total_distance).toBe(300);
    expect(normalized.avg_speed).toBe(0.25);
    // New, additive fields — derived from the raw points.
    expect(normalized.speed_mean).not.toBeNull();
    expect(normalized.total_pause_duration_ms).not.toBeNull();
    expect(validity.speed_mean).toBe(true);
  });

  it('new fields are null (not 0) when no strokePoints are supplied, matching existing null-safety conventions', () => {
    const { normalized, validity } = normalizeShapeFeatures({ duration_ms: 500 }, {});
    expect(normalized.speed_mean).toBeNull();
    expect(normalized.speed_std).toBeNull();
    expect(normalized.speed_cv).toBeNull();
    expect(normalized.pause_frequency).toBeNull();
    expect(validity.speed_cv).toBe(false);
  });
});

// ─── Duration-correction pass — tAbs-based attempt_* fields ────────────────

describe('normalizeLetterFeatures — attempt_duration_ms fixes the real multi-stroke undercount bug', () => {
  // Exact scenario from the duration-correction spec: 3 strokes, each with
  // its own t-clock reset, legacy duration_ms would report only the last
  // stroke's own 500ms span; attempt_duration_ms must reflect the true
  // 2450ms wall-clock span (tAbs 100000 -> 102450).
  const multiStrokePoints = [
    { stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 100000 }, { x: 1, y: 1, t: 900, tAbs: 100900 }] },
    { stroke_id: 2, points: [{ x: 2, y: 2, t: 0, tAbs: 101100 }, { x: 3, y: 3, t: 650, tAbs: 101750 }] },
    { stroke_id: 3, points: [{ x: 4, y: 4, t: 0, tAbs: 101950 }, { x: 5, y: 5, t: 500, tAbs: 102450 }] },
  ];

  it('derives attempt_duration_ms from tAbs, independent of and different from legacy duration_ms', () => {
    const raw = { completionTime: 500, smoothness: 0.1 }; // legacy completionTime = last stroke's own t
    const { normalized } = normalizeLetterFeatures(raw, { strokePoints: multiStrokePoints });

    expect(normalized.duration_ms).toBe(500);           // legacy — completely unchanged
    expect(normalized.attempt_duration_ms).toBe(2450);   // ML-safe — true wall-clock span
  });

  it('derives attempt_avg_speed using attempt_duration_ms, never the legacy duration_ms', () => {
    const raw = { completionTime: 500 };
    const { normalized } = normalizeLetterFeatures(raw, { strokePoints: multiStrokePoints });
    // total_distance for this fixture: sqrt(2) per segment * 3 segments (within-stroke only)
    const expectedTotalDistance = normalized.total_distance;
    expect(normalized.attempt_avg_speed).toBeCloseTo(expectedTotalDistance / 2450, 10);
  });

  it('never overwrites a client-sent attempt_duration_ms/attempt_avg_speed, even when stroke_points are also present', () => {
    const raw = { completionTime: 500, attempt_duration_ms: 9999, attempt_avg_speed: 1.23 };
    const { normalized } = normalizeLetterFeatures(raw, { strokePoints: multiStrokePoints });
    expect(normalized.attempt_duration_ms).toBe(9999);
    expect(normalized.attempt_avg_speed).toBe(1.23);
  });

  it('does NOT fall back to the legacy duration_ms when tAbs is missing (Part 8) — stays null', () => {
    const noTabs = [
      { stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 900 }] },
      { stroke_id: 2, points: [{ x: 2, y: 2, t: 0 }, { x: 3, y: 3, t: 650 }] },
    ];
    const { normalized, validity } = normalizeLetterFeatures({ completionTime: 500 }, { strokePoints: noTabs });
    expect(normalized.duration_ms).toBe(500);       // legacy still derived normally
    expect(normalized.attempt_duration_ms).toBeNull(); // NOT silently substituted with 500
    expect(validity.attempt_duration_ms).toBe(false);
  });

  it('derives attempt_pause_frequency/attempt_pause_duration_ratio against attempt_duration_ms, not legacy duration_ms', () => {
    // Single stroke with one clear >300ms pause, so pause_count=1 is unambiguous.
    const strokePoints = [{ stroke_id: 1, points: [
      { x: 0, y: 0, t: 0, tAbs: 1000 },
      { x: 1, y: 1, t: 500, tAbs: 1500 }, // gap 500 > 300 -> pause
    ] }];
    const { normalized } = normalizeLetterFeatures({ completionTime: 500 }, { strokePoints });
    expect(normalized.attempt_duration_ms).toBe(500); // tAbs 1000->1500
    expect(normalized.attempt_pause_frequency).toBeCloseTo(1 / 0.5, 10); // 1 pause / 0.5s
    expect(normalized.attempt_pause_duration_ratio).toBeCloseTo(500 / 500, 10);
  });

  it('stays null when only one valid tAbs value exists, never invents a duration', () => {
    const oneTabs = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 1000 }, { x: 1, y: 1, t: 100 }] }];
    const { normalized } = normalizeLetterFeatures({ completionTime: 100 }, { strokePoints: oneTabs });
    expect(normalized.attempt_duration_ms).toBeNull();
    expect(normalized.attempt_avg_speed).toBeNull();
  });
});

describe('normalizeShapeFeatures — attempt_* fields are additive alongside the existing client-sent total_distance/avg_speed', () => {
  it('derives attempt_duration_ms/attempt_avg_speed even though total_distance/avg_speed are already client-sent', () => {
    const strokePoints = [{ stroke_id: 1, points: [
      { x: 0, y: 0, t: 0, tAbs: 5000 }, { x: 100, y: 0, t: 500, tAbs: 5500 }, { x: 200, y: 0, t: 1200, tAbs: 6200 },
    ] }];
    const raw = { duration_ms: 1200, total_distance: 300, avg_speed: 0.25, smoothness: 0.1 };
    const { normalized, validity } = normalizeShapeFeatures(raw, { strokeCount: 1, strokePoints });

    expect(normalized.total_distance).toBe(300); // legacy, unchanged
    expect(normalized.attempt_duration_ms).toBe(1200); // tAbs 6200-5000
    expect(normalized.attempt_avg_speed).toBeCloseTo(300 / 1200, 10);
    expect(validity.attempt_duration_ms).toBe(true);
  });
});
