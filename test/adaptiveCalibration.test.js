'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fitCalibrationFromPairs,
  fitIsotonic,
  predict,
  crossValidate,
  fitLinear,
  applyCalibration,
  normalizePopulationTag,
  getAdaptiveScore,
  getOverallScore,
  invalidateCalibrationCache,
  summarizeCalibration,
  MIN_SAMPLES_FOR_CALIBRATION,
} = require('../src/services/adaptiveCalibrationService');

// Enough points to clear MIN_SAMPLES_FOR_CALIBRATION with room for folds.
const SAMPLES = MIN_SAMPLES_FOR_CALIBRATION + 6;

function buildPairs(toTeacherScore, count = SAMPLES) {
  return Array.from({ length: count }, (_, i) => {
    const modelScore = 40 + i * 1.5;
    return [modelScore, toTeacherScore(modelScore, i)];
  });
}

test('fitCalibrationFromPairs stays at identity below the minimum sample size', () => {
  const pairs = [[80, 70], [90, 85]];
  const fit = fitCalibrationFromPairs(pairs);
  assert.equal(fit.fitted, false);
  assert.equal(fit.slope, 1);
  assert.equal(fit.intercept, 0);
  assert.equal(fit.sample_size, pairs.length);
});

test('fitCalibrationFromPairs stays at identity with no variance in the model score', () => {
  const pairs = Array.from({ length: SAMPLES }, () => [70, 60]);
  const fit = fitCalibrationFromPairs(pairs);
  assert.equal(fit.fitted, false);
  assert.match(fit.validation.rejected_reason, /no variance/);
});

test('fitCalibrationFromPairs recovers a consistent systematic offset', () => {
  // Model consistently overscores by 10 relative to the teacher's judgment.
  const fit = fitCalibrationFromPairs(buildPairs((score) => score - 10));
  assert.equal(fit.fitted, true);
  assert.equal(fit.model, 'linear');
  assert.ok(Math.abs(fit.slope - 1) < 0.05, `slope ${fit.slope} should be near 1`);
  assert.ok(Math.abs(fit.intercept + 10) < 1, `intercept ${fit.intercept} should be near -10`);
  assert.ok(
    fit.validation.mae_improvement > 5,
    `expected a large held-out improvement, got ${fit.validation.mae_improvement}`
  );
});

test('fitCalibrationFromPairs rejects a pathological slope instead of applying it', () => {
  // Anti-correlated: OLS would fit a negative slope, which would invert scores
  // if ever applied, and isotonic collapses to a single block (no signal).
  const fit = fitCalibrationFromPairs(buildPairs((score) => 100 - score));
  assert.equal(fit.fitted, false);
  assert.equal(fit.slope, 1);
  assert.equal(fit.intercept, 0);
  assert.ok(fit.rejected_slope < 0, `expected negative rejected_slope, got ${fit.rejected_slope}`);
  assert.equal(fit.validation.candidates.linear.rejected, true);
  assert.equal(fit.validation.candidates.isotonic.rejected, true);
});

test('fitCalibrationFromPairs leaves an already-agreeing model alone', () => {
  // Teachers confirm the model exactly. A line can be fitted (slope 1), but
  // applying it cannot beat doing nothing, so it must not be marked fitted.
  const fit = fitCalibrationFromPairs(buildPairs((score) => score));
  assert.equal(fit.fitted, false);
  assert.match(fit.validation.rejected_reason, /cross-validated error/);
  assert.ok(fit.validation.mae_improvement < 1);
});

test('fitCalibrationFromPairs rejects a fit that only tracks unbiased noise', () => {
  // Symmetric scatter around the teacher's score with no systematic bias:
  // there is nothing for a calibration to correct.
  const fit = fitCalibrationFromPairs(buildPairs((score, i) => score + (i % 2 ? 6 : -6)));
  assert.equal(fit.fitted, false);
  assert.match(fit.validation.rejected_reason, /cross-validated error/);
});

test('fitCalibrationFromPairs prefers isotonic when the relationship is not a line', () => {
  // Model saturates near the top: teachers keep separating attempts the model
  // has already compressed into a narrow high band. A straight line cannot
  // follow that curve; a monotone step function can.
  const fit = fitCalibrationFromPairs(
    buildPairs((score) => Math.round(100 * (1 - Math.exp(-score / 30))))
  );
  assert.equal(fit.fitted, true);
  assert.equal(fit.model, 'isotonic');
  assert.ok(Array.isArray(fit.knots) && fit.knots.length >= 3);
  assert.ok(
    fit.validation.mae_improvement >= 1,
    `expected a real held-out improvement, got ${fit.validation.mae_improvement}`
  );
});

test('fitIsotonic refuses a degenerate fit that collapses to one block', () => {
  const isotonic = fitIsotonic(buildPairs((score) => 100 - score));
  assert.equal(isotonic.rejected, true);
  assert.ok(isotonic.blocks < 3);
});

test('fitIsotonic produces non-decreasing knots', () => {
  const isotonic = fitIsotonic(buildPairs((score, i) => score + (i % 3) * 4 - 12));
  assert.equal(isotonic.rejected, undefined);
  for (let i = 1; i < isotonic.knots.length; i += 1) {
    assert.ok(isotonic.knots[i][0] > isotonic.knots[i - 1][0], 'x must strictly increase');
    assert.ok(isotonic.knots[i][1] >= isotonic.knots[i - 1][1], 'y must not decrease');
  }
});

test('predict extrapolates an isotonic fit flat rather than off the scale', () => {
  const fit = { model: 'isotonic', knots: [[40, 30], [60, 55], [80, 70]] };
  assert.equal(predict(fit, 0), 30);
  assert.equal(predict(fit, 100), 70);
  assert.equal(predict(fit, 50), 42.5);
});

test('crossValidate reports both calibrated and identity held-out error', () => {
  const result = crossValidate(buildPairs((score) => score - 10), fitLinear);
  assert.ok(result.folds >= 2);
  assert.ok(Math.abs(result.mae_identity - 10) < 1, `identity MAE ${result.mae_identity}`);
  assert.ok(result.mae_calibrated < 1, `calibrated MAE ${result.mae_calibrated}`);
  assert.ok(result.mae_improvement > 5);
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

test('applyCalibration applies an isotonic fit through its knots', () => {
  const isotonicFit = { model: 'isotonic', knots: [[40, 30], [60, 55], [80, 70]], fitted: true };
  assert.equal(applyCalibration(50, isotonicFit), 43);
  assert.equal(applyCalibration(10, isotonicFit), 30);
  assert.equal(applyCalibration(95, isotonicFit), 70);
});

test('normalizePopulationTag lowercases, trims, and defaults empty input', () => {
  assert.equal(normalizePopulationTag('  Autism Spectrum Disorder '), 'autism spectrum disorder');
  assert.equal(normalizePopulationTag(''), 'unspecified');
  assert.equal(normalizePopulationTag(null), 'unspecified');
  assert.equal(normalizePopulationTag(undefined), 'unspecified');
});

test('getAdaptiveScore prefers the column and falls back to the JSONB blob', () => {
  assert.equal(getAdaptiveScore({ adaptive_score: 91 }), 91);
  assert.equal(
    getAdaptiveScore({
      adaptive_score: null,
      recommendation_details: { adaptive_model: { adaptive_score: 82 } },
    }),
    82
  );
  assert.equal(getAdaptiveScore({}), null);
  assert.equal(getAdaptiveScore(null), null);
  assert.equal(
    getAdaptiveScore({ recommendation_details: { adaptive_model: { adaptive_score: 'x' } } }),
    null
  );
});

test('getOverallScore reads the stored overall score defensively', () => {
  assert.equal(getOverallScore({ overall_score: 64 }), 64);
  assert.equal(getOverallScore({}), null);
  assert.equal(getOverallScore(null), null);
});

test('invalidateCalibrationCache is callable without a database', () => {
  assert.doesNotThrow(() => invalidateCalibrationCache());
});

test('summarizeCalibration drops knots and candidate detail before storage', () => {
  const full = fitCalibrationFromPairs(
    buildPairs((score) => Math.round(100 * (1 - Math.exp(-score / 30))))
  );
  full.alternate_target = { calibration_target: 'overall_score', fitted: false, model: 'identity', sample_size: 30, validation: { mae_improvement: 0.2, candidates: {} } };

  const summary = summarizeCalibration(full);
  assert.equal(summary.knots, undefined);
  assert.equal(summary.knot_count, full.knots.length);
  assert.equal(summary.validation.candidates, undefined);
  assert.equal(summary.validation.mae_improvement, full.validation.mae_improvement);
  assert.equal(summary.alternate_target.mae_improvement, 0.2);
  assert.equal(summary.alternate_target.validation, undefined);
  assert.equal(summary.fitted, true);
  assert.equal(summary.model, 'isotonic');
  // The stored blob must stay small no matter how big the corpus grows.
  assert.ok(JSON.stringify(summary).length < 400, JSON.stringify(summary));
});

test('summarizeCalibration passes null through', () => {
  assert.equal(summarizeCalibration(null), null);
});
