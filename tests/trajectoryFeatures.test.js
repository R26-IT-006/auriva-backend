'use strict';

const {
  toStrokeArrays,
  hasUsableTrajectory,
  calculateTotalDistance,
  calculateDuration,
  calculateAverageSpeed,
  calculateSegmentSpeeds,
  calculateSpeedStats,
  calculatePauseMetrics,
  calculateAttemptDurationFromAbsoluteTime,
  calculateAttemptAverageSpeed,
  calculateAttemptPauseMetrics,
  DEFAULT_PAUSE_THRESHOLD_MS,
} = require('../src/utils/trajectoryFeatures');

// ─── toStrokeArrays — input-format tolerance ───────────────────────────────

describe('toStrokeArrays', () => {
  it('unwraps the DB/wire format ([{stroke_id, points}]) into an array-of-arrays', () => {
    const dbFormat = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 10 }] }];
    expect(toStrokeArrays(dbFormat)).toEqual([[{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 10 }]]);
  });

  it('treats a flat point array as a single stroke', () => {
    const flat = [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 10 }];
    expect(toStrokeArrays(flat)).toEqual([flat]);
  });

  it('returns [] for null/undefined/empty input', () => {
    expect(toStrokeArrays(null)).toEqual([]);
    expect(toStrokeArrays(undefined)).toEqual([]);
    expect(toStrokeArrays([])).toEqual([]);
  });
});

// ─── hasUsableTrajectory ────────────────────────────────────────────────────

describe('hasUsableTrajectory', () => {
  it('is false for empty, missing, or single-point trajectories', () => {
    expect(hasUsableTrajectory(null)).toBe(false);
    expect(hasUsableTrajectory([])).toBe(false);
    expect(hasUsableTrajectory([{ stroke_id: 1, points: [{ x: 1, y: 1, t: 0 }] }])).toBe(false);
  });

  it('is true once at least 2 points exist across strokes', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 10 }] }];
    expect(hasUsableTrajectory(strokePoints)).toBe(true);
  });
});

// ─── calculateTotalDistance ─────────────────────────────────────────────────

describe('calculateTotalDistance', () => {
  it('computes the classic 3-4-5 triangle distance', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 3, y: 4, t: 10 }] }];
    expect(calculateTotalDistance(strokePoints)).toBe(5);
  });

  it('never adds artificial distance between the end of one stroke and the start of the next', () => {
    const strokePoints = [
      { stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 3, y: 4, t: 10 }, { x: 3, y: 16, t: 20 }] }, // 5 + 12 = 17
      { stroke_id: 2, points: [{ x: 500, y: 500, t: 0 }, { x: 500, y: 508, t: 10 }] }, // +8
    ];
    expect(calculateTotalDistance(strokePoints)).toBe(25);
  });

  it('returns 0 for empty/malformed input, never throws', () => {
    expect(calculateTotalDistance(null)).toBe(0);
    expect(calculateTotalDistance([])).toBe(0);
    expect(calculateTotalDistance([{ stroke_id: 1, points: [{ x: 1, y: 1, t: 0 }] }])).toBe(0);
  });
});

// ─── calculateDuration ──────────────────────────────────────────────────────

describe('calculateDuration', () => {
  it('returns the last flattened point\'s t value', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 842 }] }];
    expect(calculateDuration(strokePoints)).toBe(842);
  });

  it('returns 0 for empty input', () => {
    expect(calculateDuration([])).toBe(0);
  });
});

// ─── calculateAverageSpeed ──────────────────────────────────────────────────

describe('calculateAverageSpeed', () => {
  it('matches the shape-assessment semantics: 100px / 1000ms = 0.1 px/ms', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 1000 }] }];
    expect(calculateAverageSpeed(strokePoints)).toBeCloseTo(0.1, 10);
  });

  it('accepts a durationMsOverride (e.g. the already-stored normalized duration_ms)', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 1000 }] }];
    expect(calculateAverageSpeed(strokePoints, 2000)).toBeCloseTo(0.05, 10);
  });

  it('returns null (not 0) for zero duration', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 0 }] }];
    expect(calculateAverageSpeed(strokePoints)).toBeNull();
  });

  it('returns null for a malformed negative duration', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 100 }, { x: 100, y: 0, t: -5 }] }];
    expect(calculateAverageSpeed(strokePoints)).toBeNull();
  });

  it('returns null for an empty or one-point trajectory', () => {
    expect(calculateAverageSpeed([])).toBeNull();
    expect(calculateAverageSpeed([{ stroke_id: 1, points: [{ x: 5, y: 5, t: 100 }] }])).toBeNull();
  });

  it('returns null for missing stroke_points entirely', () => {
    expect(calculateAverageSpeed(null)).toBeNull();
    expect(calculateAverageSpeed(undefined)).toBeNull();
  });
});

// ─── calculateSegmentSpeeds / calculateSpeedStats ──────────────────────────

describe('calculateSegmentSpeeds', () => {
  it('ignores segments where dt <= 0', () => {
    const strokePoints = [{ stroke_id: 1, points: [
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 0 },  // dt == 0 -> dropped
      { x: 20, y: 0, t: -5 }, // dt < 0 -> dropped
    ] }];
    expect(calculateSegmentSpeeds(strokePoints)).toHaveLength(0);
  });

  it('never mixes points from different strokes into one segment', () => {
    const strokePoints = [
      { stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 100 }] }, // speed 0.1
      { stroke_id: 2, points: [{ x: 999, y: 999, t: 0 }, { x: 999, y: 1009, t: 50 }] }, // speed 0.2
    ];
    const speeds = calculateSegmentSpeeds(strokePoints);
    expect(speeds).toHaveLength(2);
    expect(speeds[0]).toBeCloseTo(0.1, 10);
    expect(speeds[1]).toBeCloseTo(0.2, 10);
  });
});

describe('calculateSpeedStats', () => {
  it('computes mean/std/cv for a known segment-speed sequence', () => {
    const strokePoints = [{ stroke_id: 1, points: [
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 100 }, // speed 0.1
      { x: 20, y: 0, t: 150 }, // speed 0.2
    ] }];
    const { speed_mean, speed_std, speed_cv } = calculateSpeedStats(strokePoints);
    expect(speed_mean).toBeCloseTo(0.15, 10);
    expect(speed_std).toBeCloseTo(0.05, 10); // population std dev of [0.1, 0.2]
    expect(speed_cv).toBeCloseTo(0.05 / 0.15, 10);
  });

  it('returns all-null when there are no valid segments', () => {
    expect(calculateSpeedStats([])).toEqual({ speed_mean: null, speed_std: null, speed_cv: null });
  });

  it('leaves speed_cv null when speed_mean is exactly 0, never divides by zero', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 5, y: 5, t: 0 }, { x: 5, y: 5, t: 50 }] }];
    const { speed_mean, speed_cv } = calculateSpeedStats(strokePoints);
    expect(speed_mean).toBe(0);
    expect(speed_cv).toBeNull();
  });
});

// ─── calculatePauseMetrics ──────────────────────────────────────────────────

describe('calculatePauseMetrics', () => {
  it('uses a strict ">" boundary at 300ms, not ">="', () => {
    const exactly = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: DEFAULT_PAUSE_THRESHOLD_MS }] }];
    expect(calculatePauseMetrics(exactly).pause_count).toBe(0);

    const over = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: DEFAULT_PAUSE_THRESHOLD_MS + 1 }] }];
    expect(calculatePauseMetrics(over).pause_count).toBe(1);
  });

  it('never compares the last point of one stroke against the first point of the next', () => {
    const strokePoints = [
      { stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 100 }] },
      { stroke_id: 2, points: [{ x: 5, y: 5, t: 5000 }, { x: 6, y: 6, t: 5050 }] },
    ];
    expect(calculatePauseMetrics(strokePoints).pause_count).toBe(0);
  });

  it('accumulates total/mean pause duration correctly', () => {
    const strokePoints = [{ stroke_id: 1, points: [
      { x: 0, y: 0, t: 0 },
      { x: 1, y: 1, t: 500 },  // gap 500 -> pause
      { x: 2, y: 2, t: 1200 }, // gap 700 -> pause
      { x: 3, y: 3, t: 1250 }, // gap 50, not a pause
    ] }];
    const result = calculatePauseMetrics(strokePoints);
    expect(result.pause_count).toBe(2);
    expect(result.total_pause_duration_ms).toBe(1200);
    expect(result.mean_pause_duration_ms).toBe(600);
  });

  it('computes pause_frequency/pause_duration_ratio against a supplied durationMs, guarding zero duration', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 500 }] }];
    const result = calculatePauseMetrics(strokePoints, { durationMs: 2000 });
    expect(result.pause_frequency).toBeCloseTo(0.5, 10);
    expect(result.pause_duration_ratio).toBeCloseTo(0.25, 10);

    const zero = calculatePauseMetrics(strokePoints, { durationMs: 0 });
    expect(zero.pause_frequency).toBeNull();
    expect(zero.pause_duration_ratio).toBeNull();
  });

  it('handles empty input without throwing', () => {
    const result = calculatePauseMetrics([]);
    expect(result).toEqual({
      pause_count: 0, total_pause_duration_ms: 0,
      mean_pause_duration_ms: null, pause_frequency: null, pause_duration_ratio: null,
    });
  });
});

// ─── calculateAttemptDurationFromAbsoluteTime (tAbs-based, ML-safe) ───────

describe('calculateAttemptDurationFromAbsoluteTime', () => {
  // Test A
  it('Test A: single stroke, tAbs 1000/1200/1500 -> 500ms', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ tAbs: 1000 }, { tAbs: 1200 }, { tAbs: 1500 }] }];
    expect(calculateAttemptDurationFromAbsoluteTime(strokePoints)).toBe(500);
  });

  // Test B
  it('Test B: multi-stroke spans the full attempt (2100-1000=1100), never the final stroke\'s own span', () => {
    const strokePoints = [
      { stroke_id: 1, points: [{ tAbs: 1000 }, { tAbs: 1200 }, { tAbs: 1500 }] },
      { stroke_id: 2, points: [{ tAbs: 1800 }, { tAbs: 2100 }] },
    ];
    const result = calculateAttemptDurationFromAbsoluteTime(strokePoints);
    expect(result).toBe(1100);
    expect(result).not.toBe(300);
  });

  it('matches the worked multi-stroke example from the spec exactly (101600 - 100000 = 1600)', () => {
    const strokePoints = [
      { stroke_id: 1, points: [{ tAbs: 100000 }, { tAbs: 100400 }, { tAbs: 100900 }] },
      { stroke_id: 2, points: [{ tAbs: 101200 }, { tAbs: 101600 }] },
    ];
    expect(calculateAttemptDurationFromAbsoluteTime(strokePoints)).toBe(1600);
  });

  // Test D
  it('Test D: returns null when no point has a valid tAbs', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 100 }] }];
    expect(calculateAttemptDurationFromAbsoluteTime(strokePoints)).toBeNull();
  });

  // Test E
  it('Test E: returns null with only one valid tAbs value', () => {
    expect(calculateAttemptDurationFromAbsoluteTime([{ stroke_id: 1, points: [{ tAbs: 5000 }] }])).toBeNull();
    expect(calculateAttemptDurationFromAbsoluteTime([{ stroke_id: 1, points: [{ tAbs: 5000 }, { tAbs: NaN }] }])).toBeNull();
  });

  it('ignores invalid tAbs values mixed with valid ones', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ tAbs: 1000 }, { tAbs: undefined }, { tAbs: NaN }, { tAbs: 1500 }] }];
    expect(calculateAttemptDurationFromAbsoluteTime(strokePoints)).toBe(500);
  });

  it('returns null (never negative, never 0) when max <= min', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ tAbs: 1000 }, { tAbs: 1000 }] }];
    expect(calculateAttemptDurationFromAbsoluteTime(strokePoints)).toBeNull();
  });

  it('returns null for empty/missing input, never throws', () => {
    expect(calculateAttemptDurationFromAbsoluteTime([])).toBeNull();
    expect(calculateAttemptDurationFromAbsoluteTime(null)).toBeNull();
    expect(calculateAttemptDurationFromAbsoluteTime(undefined)).toBeNull();
  });

  it('accepts the flat (non-wrapped) point-array format too, tolerantly', () => {
    // Real captured points always carry x/y alongside tAbs — toStrokeArrays
    // uses the presence of a numeric `x` to detect this "flat, unwrapped"
    // shape (see its doc comment), so the fixture includes it for realism.
    const flat = [{ x: 0, y: 0, tAbs: 1000 }, { x: 1, y: 1, tAbs: 1500 }];
    expect(calculateAttemptDurationFromAbsoluteTime(flat)).toBe(500);
  });
});

// ─── calculateAttemptAverageSpeed ──────────────────────────────────────────

describe('calculateAttemptAverageSpeed', () => {
  // Test C
  it('Test C: 550px / 1100ms = 0.5 px/ms', () => {
    expect(calculateAttemptAverageSpeed(550, 1100)).toBeCloseTo(0.5, 10);
  });

  it('returns null when attemptDurationMs <= 0', () => {
    expect(calculateAttemptAverageSpeed(100, 0)).toBeNull();
    expect(calculateAttemptAverageSpeed(100, -50)).toBeNull();
  });

  it('returns null when totalDistance is unavailable', () => {
    expect(calculateAttemptAverageSpeed(null, 1000)).toBeNull();
    expect(calculateAttemptAverageSpeed(NaN, 1000)).toBeNull();
  });
});

// ─── calculateAttemptPauseMetrics ──────────────────────────────────────────

describe('calculateAttemptPauseMetrics', () => {
  // Test F
  it('Test F: pause_count=2, attempt_duration_ms=4000 -> 0.5 pauses/sec', () => {
    const { attempt_pause_frequency } = calculateAttemptPauseMetrics(2, 800, 4000);
    expect(attempt_pause_frequency).toBeCloseTo(0.5, 10);
  });

  // Test G
  it('Test G: total_pause_duration_ms=800, attempt_duration_ms=4000 -> ratio 0.2', () => {
    const { attempt_pause_duration_ratio } = calculateAttemptPauseMetrics(2, 800, 4000);
    expect(attempt_pause_duration_ratio).toBeCloseTo(0.2, 10);
  });

  it('returns both null when attemptDurationMs <= 0', () => {
    expect(calculateAttemptPauseMetrics(2, 800, 0)).toEqual({ attempt_pause_frequency: null, attempt_pause_duration_ratio: null });
    expect(calculateAttemptPauseMetrics(2, 800, null)).toEqual({ attempt_pause_frequency: null, attempt_pause_duration_ratio: null });
  });
});

// ─── Integration: attempt_* fields never overwrite legacy fields ─────────

describe('legacy vs attempt-safe duration — the real bug scenario', () => {
  it('legacy duration_ms undercounts a multi-stroke attempt; attempt_duration_ms does not', () => {
    const strokePoints = [
      { stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 100000 }, { x: 1, y: 1, t: 900, tAbs: 100900 }] },
      { stroke_id: 2, points: [{ x: 2, y: 2, t: 0, tAbs: 101100 }, { x: 3, y: 3, t: 650, tAbs: 101750 }] },
      { stroke_id: 3, points: [{ x: 4, y: 4, t: 0, tAbs: 101950 }, { x: 5, y: 5, t: 500, tAbs: 102450 }] },
    ];
    expect(calculateDuration(strokePoints)).toBe(500); // legacy, matches the spec's stated (mis)behavior
    expect(calculateAttemptDurationFromAbsoluteTime(strokePoints)).toBe(2450); // true span
  });
});
