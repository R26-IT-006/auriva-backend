'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeInformativeness } = require('../src/services/pronunciationReviewQueueService');

test('computeInformativeness ranks low-confidence attempts above high-confidence ones', () => {
  const uncertain = computeInformativeness({ confidenceScore: 20, reviewedForPopulation: 10 });
  const confident = computeInformativeness({ confidenceScore: 95, reviewedForPopulation: 10 });
  assert.ok(uncertain > confident);
});

test('computeInformativeness gives an under-covered population a boost at equal confidence', () => {
  const underCovered = computeInformativeness({ confidenceScore: 70, reviewedForPopulation: 0 });
  const wellCovered = computeInformativeness({ confidenceScore: 70, reviewedForPopulation: 50 });
  assert.ok(underCovered > wellCovered);
});

test('computeInformativeness treats a missing confidence score as medium uncertainty', () => {
  const missing = computeInformativeness({ confidenceScore: null, reviewedForPopulation: 10 });
  const knownMid = computeInformativeness({ confidenceScore: 50, reviewedForPopulation: 10 });
  assert.equal(missing, knownMid);
});

test('computeInformativeness stays within 0-100', () => {
  const best = computeInformativeness({ confidenceScore: 0, reviewedForPopulation: 0 });
  const worst = computeInformativeness({ confidenceScore: 100, reviewedForPopulation: 1000 });
  assert.ok(best <= 100 && best >= 0);
  assert.ok(worst <= 100 && worst >= 0);
  assert.ok(best > worst);
});
