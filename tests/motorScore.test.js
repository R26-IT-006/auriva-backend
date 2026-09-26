'use strict';

const {
  computeMotorScore, computeDirectionScore, scoreFromDeviation, clamp,
} = require('../src/utils/motorScore');

describe('scoreFromDeviation / clamp', () => {
  it('clamp bounds a value into [min, max]', () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-10, 0, 100)).toBe(0);
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('scoreFromDeviation inverts a lower-is-better raw value into 0-100', () => {
    expect(scoreFromDeviation(0, 60)).toBe(100);
    expect(scoreFromDeviation(60, 60)).toBe(0);
    expect(scoreFromDeviation(120, 60)).toBe(0); // clamped, doesn't go negative
    expect(scoreFromDeviation(null, 60)).toBeNull();
  });
});

describe('computeDirectionScore', () => {
  it('returns null when there are fewer than 3 points', () => {
    expect(computeDirectionScore([{ points: [{ x: 0, y: 0 }] }])).toBeNull();
  });

  it('scores a straight line higher than a path full of sharp reversals', () => {
    const straight = [{
      points: Array.from({ length: 10 }, (_, i) => ({ x: i * 10, y: 0 })),
    }];
    // zig-zag reversing direction almost every point
    const jagged = [{
      points: Array.from({ length: 10 }, (_, i) => ({ x: i % 2 === 0 ? 0 : 50, y: i * 10 })),
    }];

    const straightScore = computeDirectionScore(straight);
    const jaggedScore   = computeDirectionScore(jagged);
    expect(straightScore).toBe(100);
    expect(jaggedScore).toBeLessThan(straightScore);
  });
});

describe('computeMotorScore — the weighted formula', () => {
  it('computes the documented weighted average when every component is available', () => {
    const normalized = {
      accuracy_score: 80, smoothness_score: 90, pause_count: 0,
      direction_score: 70, avg_speed: 0.2, dtw_distance: null,
    };
    const { motor_score, quality_score, score_version } = computeMotorScore(normalized);

    // pause_control_score(0) = 100, speed_control_score(0.2) = 100 (inside v1 band)
    const expected = Math.round(0.35 * 80 + 0.25 * 90 + 0.15 * 100 + 0.15 * 70 + 0.10 * 100);
    expect(motor_score).toBe(expected);
    expect(quality_score).toBe(motor_score);
    expect(score_version).toBe('v1');
  });

  it('falls back to a dtw-derived accuracy component when accuracy_score is null (item 4)', () => {
    const withDtw = computeMotorScore({
      accuracy_score: null, smoothness_score: 90, pause_count: 0, direction_score: 70,
      avg_speed: 0.2, dtw_distance: 0, // dtw 0 -> perfect fallback score of 100
    });
    const withDirectAccuracy = computeMotorScore({
      accuracy_score: 100, smoothness_score: 90, pause_count: 0, direction_score: 70,
      avg_speed: 0.2, dtw_distance: null,
    });
    expect(withDtw.motor_score).toBe(withDirectAccuracy.motor_score);
  });

  it('the dtw-derived accuracy fallback treats dtw_norm_v1 distances at/above the '
    + 'normalized-space ceiling as the worst possible accuracy score', () => {
    // dtw_distance is post-dtw_norm_v1-normalization (0-100 coordinate space,
    // see frontend utils/dtwNormalization.js), not raw pixels.
    const atCeiling = computeMotorScore({
      accuracy_score: null, smoothness_score: 90, pause_count: 0, direction_score: 70,
      avg_speed: 0.2, dtw_distance: 45,
    });
    const wayBeyondCeiling = computeMotorScore({
      accuracy_score: null, smoothness_score: 90, pause_count: 0, direction_score: 70,
      avg_speed: 0.2, dtw_distance: 500,
    });
    expect(atCeiling.motor_score).toBe(wayBeyondCeiling.motor_score); // both clamp to the same floor
  });

  it('renormalizes weights instead of treating a missing component as 0 (null-aware)', () => {
    // Only smoothness available — should equal smoothness_score itself, not
    // a value crushed toward 0 by the other 80% of weight going unused.
    const { motor_score } = computeMotorScore({
      accuracy_score: null, smoothness_score: 90, pause_count: null,
      direction_score: null, avg_speed: null, dtw_distance: null,
    });
    expect(motor_score).toBe(90);
  });

  it('returns null when no component is available at all', () => {
    const { motor_score, quality_score } = computeMotorScore({
      accuracy_score: null, smoothness_score: null, pause_count: null,
      direction_score: null, avg_speed: null, dtw_distance: null,
    });
    expect(motor_score).toBeNull();
    expect(quality_score).toBeNull();
  });

  it('clamps the final score into [0, 100]', () => {
    const { motor_score } = computeMotorScore({
      accuracy_score: 100, smoothness_score: 100, pause_count: 0,
      direction_score: 100, avg_speed: 0.2,
    });
    expect(motor_score).toBeLessThanOrEqual(100);
    expect(motor_score).toBeGreaterThanOrEqual(0);
  });
});
