'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fitCalibrationFromPairs,
  applyCalibration,
  normalizePopulationTag,
  getAdaptiveScore,
  MIN_SAMPLES_FOR_CALIBRATION,
} = require('../src/services/adaptiveCalibrationService');

test('fitCalibrationFromPairs stays at identity below the minimum sample size', () => {
  const pairs = [[80, 70], [90, 85]];
  const fit = fitCalibrationFromPairs(pairs);
  assert.equal(fit.fitted, false);
  assert.equal(fit.slope, 1);
  assert.equal(fit.intercept, 0);
  assert.equal(fit.sample_size, pairs.length);
});

test('fitCalibrationFromPairs stays at identity with no variance in adaptive_score', () => {
  const pairs = Array.from({ length: MIN_SAMPLES_FOR_CALIBRATION + 2 }, () => [70, 60]);
  const fit = fitCalibrationFromPairs(pairs);
  assert.equal(fit.fitted, false);
});

test('fitCalibrationFromPairs recovers a consistent systematic offset', () => {
  // Model consistently overscores by 10 relative to the teacher's judgment.
  const pairs = Array.from({ length: 12 }, (_, i) => {
    const adaptiveScore = 50 + i * 3;
    return [adaptiveScore, adaptiveScore - 10];
  });
  const fit = fitCalibrationFromPairs(pairs);
  assert.equal(fit.fitted, true);
  assert.ok(Math.abs(fit.slope - 1) < 0.05, `slope ${fit.slope} should be near 1`);
  assert.ok(Math.abs(fit.intercept + 10) < 1, `intercept ${fit.intercept} should be near -10`);
});

test('fitCalibrationFromPairs rejects a pathological slope instead of applying it', () => {
  // Anti-correlated noise: OLS would fit a negative slope, which would invert
  // scores if ever applied. The fit must fall back to identity.
  const pairs = Array.from({ length: 12 }, (_, i) => {
    const adaptiveScore = 40 + i * 4;
    return [adaptiveScore, 100 - adaptiveScore];
  });
  const fit = fitCalibrationFromPairs(pairs);
  assert.equal(fit.fitted, false);
  assert.equal(fit.slope, 1);
  assert.equal(fit.intercept, 0);
  assert.ok(fit.rejected_slope < 0, `expected negative rejected_slope, got ${fit.rejected_slope}`);
});

test('applyCalibration is a no-op when the calibration is not fitted', () => {
  const identity = { slope: 1, intercept: 0, fitted: false };
  assert.equal(applyCalibration(77, identity), 77);
  assert.equal(applyCalibration(77, null), 77);
});

test('applyCalibration adjusts and clamps to 0-100', () => {
  const overscoreFit = { slope: 1, intercept: -10, fitted: true };
  assert.equal(applyCalibration(95, overscoreFit), 85);
  assert.equal(applyCalibration(5, overscoreFit), 0);
  assert.equal(applyCalibration(100, overscoreFit), 90);
});

test('normalizePopulationTag lowercases, trims, and defaults empty input', () => {
  assert.equal(normalizePopulationTag('  Autism Spectrum Disorder '), 'autism spectrum disorder');
  assert.equal(normalizePopulationTag(''), 'unspecified');
  assert.equal(normalizePopulationTag(null), 'unspecified');
  assert.equal(normalizePopulationTag(undefined), 'unspecified');
});

test('getAdaptiveScore reads the nested adaptive_model score defensively', () => {
  assert.equal(
    getAdaptiveScore({ recommendation_details: { adaptive_model: { adaptive_score: 82 } } }),
    82
  );
  assert.equal(getAdaptiveScore({}), null);
  assert.equal(getAdaptiveScore(null), null);
  assert.equal(
    getAdaptiveScore({ recommendation_details: { adaptive_model: { adaptive_score: 'x' } } }),
    null
  );
});
