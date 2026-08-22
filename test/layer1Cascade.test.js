'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateDtw,
  analyzeAudioQuality,
  distanceToScore,
  getLayer1Decision,
  LAYER1_CONFIDENT_ACCEPT_SCORE,
  LAYER1_CONFIDENT_REJECT_SCORE,
} = require('../src/services/pronunciationAnalysisService');

test('calculateDtw aligns identical sequences with zero distance', () => {
  const frames = [[0, 0], [1, 1], [2, 2], [3, 3]];
  const result = calculateDtw(frames, frames);
  assert.equal(result.distance, 0);
  assert.equal(result.normalizedDistance, 0);
  assert.equal(result.path.length, frames.length);
});

test('calculateDtw reports growing distance for growing divergence', () => {
  const reference = [[0, 0], [1, 1], [2, 2], [3, 3]];
  const near = reference.map(([a, b]) => [a + 1, b + 1]);
  const far = reference.map(([a, b]) => [a + 10, b + 10]);

  const nearResult = calculateDtw(reference, near);
  const farResult = calculateDtw(reference, far);

  assert.ok(nearResult.distance > 0);
  assert.ok(farResult.normalizedDistance > nearResult.normalizedDistance);
});

test('distanceToScore is monotonically decreasing and bounded to 0-100', () => {
  const perfect = distanceToScore(0);
  const mid = distanceToScore(0.85);
  const bad = distanceToScore(5);

  assert.ok(perfect > mid);
  assert.ok(mid > bad);
  assert.ok(perfect <= 100 && perfect >= 0);
  assert.ok(bad >= 0);
});

test('getLayer1Decision gates on the documented thresholds', () => {
  assert.equal(getLayer1Decision(LAYER1_CONFIDENT_ACCEPT_SCORE), 'dtw_only_accept');
  assert.equal(getLayer1Decision(100), 'dtw_only_accept');
  assert.equal(getLayer1Decision(LAYER1_CONFIDENT_REJECT_SCORE), 'dtw_only_reject');
  assert.equal(getLayer1Decision(0), 'dtw_only_reject');

  const ambiguous = (LAYER1_CONFIDENT_ACCEPT_SCORE + LAYER1_CONFIDENT_REJECT_SCORE) / 2;
  assert.equal(getLayer1Decision(ambiguous), 'escalated_to_gop');
  assert.equal(getLayer1Decision(LAYER1_CONFIDENT_ACCEPT_SCORE - 1), 'escalated_to_gop');
  assert.equal(getLayer1Decision(LAYER1_CONFIDENT_REJECT_SCORE + 1), 'escalated_to_gop');
});

test('analyzeAudioQuality rejects silence and accepts a clear tone with a real noise floor', () => {
  const sampleRate = 16000;

  const silence = new Float32Array(Math.round(sampleRate * 0.5));
  assert.equal(analyzeAudioQuality(silence).passed, false);

  // A real recording has a quiet noise floor around the spoken portion —
  // the quality gate uses that contrast to find voiced frames, so a pure
  // tone with no silence around it is not a representative fixture.
  const silenceSeconds = 0.15;
  const toneSeconds = 0.4;
  const totalSamples = Math.round(sampleRate * (silenceSeconds * 2 + toneSeconds));
  const toneStart = Math.round(sampleRate * silenceSeconds);
  const toneEnd = toneStart + Math.round(sampleRate * toneSeconds);
  const tone = new Float32Array(totalSamples);
  let seed = 42;
  const pseudoNoise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < tone.length; i += 1) {
    tone[i] = i >= toneStart && i < toneEnd
      ? 0.5 * Math.sin((2 * Math.PI * 200 * i) / sampleRate)
      : 0.002 * pseudoNoise();
  }
  const toneResult = analyzeAudioQuality(tone);
  assert.equal(toneResult.passed, true, `unexpected failures: ${toneResult.failures}`);
  assert.equal(toneResult.failures.length, 0);
});
