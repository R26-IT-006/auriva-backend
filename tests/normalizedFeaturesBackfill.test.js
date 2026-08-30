'use strict';

const { planRowUpdate } = require('../scripts/lib/normalizedFeaturesBackfill');
const { normalizeShapeFeatures, normalizeLetterFeatures } = require('../src/utils/featureNormalization');

// A simple, complete shape trajectory: a straight 100px horizontal segment.
function sampleStrokePoints() {
  return [{ stroke_id: 1, points: [
    { x: 0, y: 0, t: 0 }, { x: 50, y: 0, t: 500 }, { x: 100, y: 0, t: 1000 },
  ] }];
}

describe('planRowUpdate — entirely-null normalized_features (legacy row)', () => {
  it('fills every derivable field from raw features + stroke_points, and computes motor_score since it was null', () => {
    const rawFeatures = {
      duration_ms: 1000, total_distance: 100, avg_speed: 0.1,
      smoothness: 0.05, pause_count: 0, accuracy: 3,
    };
    const plan = planRowUpdate({
      rawFeatures,
      strokePoints: sampleStrokePoints(),
      storedNormalizedFeatures: null,
      storedMotorScore: null,
      normalizeFn: normalizeShapeFeatures,
    });

    expect(plan.changedFields).toEqual(expect.arrayContaining([
      'duration_ms', 'total_distance', 'avg_speed', 'smoothness_score', 'accuracy_score', 'speed_mean',
    ]));
    expect(plan.mergedNormalizedFeatures.total_distance).toBe(100); // client-sent value preserved as-is
    expect(plan.mergedNormalizedFeatures.speed_mean).not.toBeNull(); // newly derived
    expect(plan.motorScoreChanged).toBe(true);
    expect(plan.newMotorScore).not.toBeNull();
    expect(plan.isMalformedTrajectory).toBe(false);
  });
});

describe('planRowUpdate — partial normalized_features (only new trajectory fields missing)', () => {
  it('never overwrites an already-present field, even one that looks recomputable', () => {
    const storedNormalizedFeatures = {
      duration_ms: 1000, total_distance: 999, avg_speed: 0.42, // pretend these differ from a fresh recompute
      smoothness_score: 90, accuracy_score: 88, pause_count: 0,
      dtw_distance: null, stroke_count: 1, direction_score: 95, stroke_order_meta: null,
    };
    const rawFeatures = { duration_ms: 1000, total_distance: 100, avg_speed: 0.1, smoothness: 0.05, accuracy: 3 };

    const plan = planRowUpdate({
      rawFeatures,
      strokePoints: sampleStrokePoints(),
      storedNormalizedFeatures,
      storedMotorScore: 77, // already scored — must not be recomputed
      normalizeFn: normalizeShapeFeatures,
    });

    // Only the brand-new keys (never present before this pass) should change.
    expect(plan.changedFields.sort()).toEqual(
      ['speed_mean', 'speed_std', 'speed_cv', 'total_pause_duration_ms', 'mean_pause_duration_ms', 'pause_frequency', 'pause_duration_ratio'].sort()
    );
    expect(plan.mergedNormalizedFeatures.total_distance).toBe(999); // untouched
    expect(plan.mergedNormalizedFeatures.avg_speed).toBe(0.42);     // untouched
    expect(plan.motorScoreChanged).toBe(false); // storedMotorScore was already present
    expect(plan.newMotorScore).toBeNull();
  });
});

describe('planRowUpdate — nothing to update', () => {
  it('reports no changed fields when the row is already fully populated', () => {
    // Build a fully-populated normalized_features via the real normalizer so
    // every key genuinely matches what a fresh recompute would produce.
    const rawFeatures = { duration_ms: 1000, total_distance: 100, avg_speed: 0.1, smoothness: 0.05, accuracy: 3, pause_count: 0 };
    const { normalized: complete } = normalizeShapeFeatures(rawFeatures, { strokePoints: sampleStrokePoints() });

    const plan = planRowUpdate({
      rawFeatures,
      strokePoints: sampleStrokePoints(),
      storedNormalizedFeatures: complete,
      storedMotorScore: 91,
      normalizeFn: normalizeShapeFeatures,
    });

    expect(plan.changedFields).toEqual([]);
    expect(plan.mergedNormalizedFeatures).toBeNull();
    expect(plan.motorScoreChanged).toBe(false);
  });
});

describe('planRowUpdate — malformed trajectory detection', () => {
  it('flags null stroke_points as malformed', () => {
    const plan = planRowUpdate({
      rawFeatures: { duration_ms: 500 }, strokePoints: null,
      storedNormalizedFeatures: null, storedMotorScore: null, normalizeFn: normalizeLetterFeatures,
    });
    expect(plan.isMalformedTrajectory).toBe(true);
  });

  it('flags an empty stroke_points array as malformed', () => {
    const plan = planRowUpdate({
      rawFeatures: { duration_ms: 500 }, strokePoints: [],
      storedNormalizedFeatures: null, storedMotorScore: null, normalizeFn: normalizeLetterFeatures,
    });
    expect(plan.isMalformedTrajectory).toBe(true);
  });

  it('flags strokes with no points inside them as malformed', () => {
    const plan = planRowUpdate({
      rawFeatures: { duration_ms: 500 }, strokePoints: [{ stroke_id: 1, points: [] }],
      storedNormalizedFeatures: null, storedMotorScore: null, normalizeFn: normalizeLetterFeatures,
    });
    expect(plan.isMalformedTrajectory).toBe(true);
  });

  it('does not flag a genuinely usable trajectory as malformed', () => {
    const plan = planRowUpdate({
      rawFeatures: { duration_ms: 500 }, strokePoints: sampleStrokePoints(),
      storedNormalizedFeatures: null, storedMotorScore: null, normalizeFn: normalizeLetterFeatures,
    });
    expect(plan.isMalformedTrajectory).toBe(false);
  });
});

describe('planRowUpdate — letter row with the real, historically-null accuracy_score', () => {
  it('never invents accuracy_score for a letter, even during a full legacy recompute', () => {
    const plan = planRowUpdate({
      rawFeatures: { completionTime: 1000, smoothness: 0.1, dtw_distance: 12 },
      strokePoints: sampleStrokePoints(),
      storedNormalizedFeatures: null,
      storedMotorScore: null,
      normalizeFn: normalizeLetterFeatures,
    });
    expect(plan.mergedNormalizedFeatures.accuracy_score).toBeNull();
    expect(plan.changedFields).not.toContain('accuracy_score');
  });
});
