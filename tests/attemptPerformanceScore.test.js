'use strict';

// Feature 2 Step 4 — Tests 1-6: performance-score reconstruction parity.
//
// Expected values below were NOT hand-derived from the formula by reasoning
// about the math — they were obtained by running the REAL frontend
// featuresToScore() function (frontend/src/utils/adaptiveSequencing.js),
// transpiled once via @babel/core with babel-preset-expo (the project's real
// Expo transform), against each fixture below. See Step 4 report Section 5
// for the exact command. This proves attemptPerformanceScore.js is
// mathematically identical to the frontend's real-time scoring function for
// every fixture checked here, not merely "close" or "similar".
const { reconstructScoreFromFeatures, deriveAttemptPerformanceScore, SCORE_WEIGHTS, DTW_CAP } = require('../src/utils/attemptPerformanceScore');

describe('SCORE_WEIGHTS / DTW_CAP mirror the frontend constants exactly', () => {
  it('Test 1: SCORE_WEIGHTS = {trajectory: 0.7, smoothness: 0.3}, DTW_CAP = 45', () => {
    expect(SCORE_WEIGHTS).toEqual({ trajectory: 0.7, smoothness: 0.3 });
    expect(DTW_CAP).toBe(45);
  });
});

describe('Test 2: reconstructScoreFromFeatures — verified parity fixtures (real frontend output)', () => {
  it.each([
    // [smoothness, dtw_distance, expectedRoundedScore]
    [0.1,  15,  74],
    [0.35, 22,  55], // dtw_distance at frontend's DTW_CORRECT_THRESHOLD (22) — not a special case in the formula itself
    [0,    0,   100],
    [1,    100, 0],   // dtw_distance far beyond DTW_CAP — capped, not rejected
    [0.5,  45,  15],  // dtw_distance exactly at DTW_CAP
    [0.2,  30,  47],
    [0.05, 5,   91],
    [0.4,  10,  72],
  ])('smoothness=%p dtw_distance=%p -> score %p', (smoothness, dtw_distance, expected) => {
    const result = reconstructScoreFromFeatures({ smoothness, dtw_distance });
    expect(result.status).toBe('valid');
    expect(result.score).toBe(expected);
  });
});

describe('Test 3: score is always an integer in [0, 100]', () => {
  it('never returns a non-integer', () => {
    const result = reconstructScoreFromFeatures({ smoothness: 0.2173, dtw_distance: 13.87 });
    expect(Number.isInteger(result.score)).toBe(true);
  });

  it('never exceeds 100 or drops below 0 even for extreme inputs', () => {
    expect(reconstructScoreFromFeatures({ smoothness: 0, dtw_distance: 0 }).score).toBeLessThanOrEqual(100);
    expect(reconstructScoreFromFeatures({ smoothness: 5, dtw_distance: 1000 }).score).toBeGreaterThanOrEqual(0);
  });
});

describe('Test 4: malformed smoothness is rejected, not coerced', () => {
  it.each([
    [null], [undefined], ['0.5'], [NaN], [Infinity], [-Infinity], [{}], [[]], [true],
  ])('smoothness=%p -> invalid_smoothness', (smoothness) => {
    const result = reconstructScoreFromFeatures({ smoothness, dtw_distance: 10 });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('invalid_smoothness');
  });

  it('negative smoothness is rejected', () => {
    const result = reconstructScoreFromFeatures({ smoothness: -0.1, dtw_distance: 10 });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('negative_smoothness');
  });
});

describe('Test 5: malformed dtw_distance is rejected, not coerced', () => {
  it.each([
    [null], [undefined], ['10'], [NaN], [Infinity], [-Infinity], [{}], [[]], [true],
  ])('dtw_distance=%p -> invalid_dtw_distance', (dtw_distance) => {
    const result = reconstructScoreFromFeatures({ smoothness: 0.2, dtw_distance });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('invalid_dtw_distance');
  });

  it('negative dtw_distance is rejected', () => {
    const result = reconstructScoreFromFeatures({ smoothness: 0.2, dtw_distance: -5 });
    expect(result.status).toBe('invalid');
    expect(result.reason).toBe('negative_dtw_distance');
  });

  it('smoothness is checked before dtw_distance when both are invalid', () => {
    const result = reconstructScoreFromFeatures({ smoothness: null, dtw_distance: null });
    expect(result.reason).toBe('invalid_smoothness');
  });
});

describe('Test 6: deriveAttemptPerformanceScore — LetterAttempt-row wrapper', () => {
  it('extracts .features and reconstructs correctly for a well-formed row', () => {
    const row = { features: { smoothness: 0.1, dtw_distance: 15, pauseCount: 0, strokeCount: 1, completionTime: 1199 } };
    const result = deriveAttemptPerformanceScore(row);
    expect(result).toEqual({ status: 'valid', score: 74 });
  });

  it.each([
    [null], [undefined],
  ])('features=%p on the row -> missing_features', (features) => {
    const result = deriveAttemptPerformanceScore({ features });
    expect(result).toEqual({ status: 'invalid', reason: 'missing_features' });
  });

  it('features as a non-object primitive -> missing_features', () => {
    expect(deriveAttemptPerformanceScore({ features: 'not-an-object' })).toEqual({ status: 'invalid', reason: 'missing_features' });
  });

  it('features as an array -> missing_features (not a valid features shape)', () => {
    expect(deriveAttemptPerformanceScore({ features: [1, 2, 3] })).toEqual({ status: 'invalid', reason: 'missing_features' });
  });

  it('a row with no features property at all -> missing_features (never throws)', () => {
    expect(deriveAttemptPerformanceScore({})).toEqual({ status: 'invalid', reason: 'missing_features' });
  });

  it('a null/undefined row itself -> missing_features (never throws)', () => {
    expect(deriveAttemptPerformanceScore(null)).toEqual({ status: 'invalid', reason: 'missing_features' });
    expect(deriveAttemptPerformanceScore(undefined)).toEqual({ status: 'invalid', reason: 'missing_features' });
  });

  it('propagates the underlying malformed-feature reason (e.g. invalid dtw_distance)', () => {
    const result = deriveAttemptPerformanceScore({ features: { smoothness: 0.1, dtw_distance: 'bad' } });
    expect(result).toEqual({ status: 'invalid', reason: 'invalid_dtw_distance' });
  });
});
