'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAdaptiveModel,
  scorePronunciationAttemptData,
  buildHistoryCounts,
} = require('../src/services/pronunciationScoringService');

const BASE_AUDIO_QUALITY = {
  snr_db: 20,
  silence_ratio: 0.1,
  clipping_ratio: 0,
  voiced_duration: 0.4,
};

test('buildAdaptiveModel: strong, consistent attempt recommends continue with high confidence', () => {
  const model = buildAdaptiveModel({
    wordId: 'cat',
    pronunciationSimilarity: 92,
    phonemeScores: [{ score: 90 }, { score: 94 }, { score: 91 }],
    historyCounts: {},
    weakSound: null,
    hesitationTime: 0.5,
    attemptNumber: 1,
    difficulty: 1,
    audioQuality: BASE_AUDIO_QUALITY,
  });

  assert.equal(model.predicted_recommendation_type, 'continue');
  assert.ok(model.adaptive_score > 80, `adaptive_score ${model.adaptive_score} should be high`);
  assert.equal(model.confidence_level, 'high');
});

test('buildAdaptiveModel: weak, repeated-difficulty attempt recommends remediate', () => {
  const model = buildAdaptiveModel({
    wordId: 'cat',
    pronunciationSimilarity: 25,
    phonemeScores: [{ score: 20 }, { score: 30 }, { score: 22 }],
    historyCounts: { k: 2 },
    weakSound: { text: 'k', position: 'initial' },
    hesitationTime: 3,
    attemptNumber: 3,
    difficulty: 3,
    audioQuality: BASE_AUDIO_QUALITY,
  });

  assert.equal(model.predicted_recommendation_type, 'remediate');
});

test('buildAdaptiveModel: poor audio quality lowers confidence and surfaces a reason', () => {
  const goodAudio = buildAdaptiveModel({
    wordId: 'cat',
    pronunciationSimilarity: 70,
    phonemeScores: [{ score: 70 }, { score: 68 }],
    historyCounts: {},
    weakSound: null,
    hesitationTime: 1,
    attemptNumber: 1,
    difficulty: 2,
    audioQuality: BASE_AUDIO_QUALITY,
  });
  const poorAudio = buildAdaptiveModel({
    wordId: 'cat',
    pronunciationSimilarity: 70,
    phonemeScores: [{ score: 70 }, { score: 68 }],
    historyCounts: {},
    weakSound: null,
    hesitationTime: 1,
    attemptNumber: 1,
    difficulty: 2,
    audioQuality: { snr_db: 2, silence_ratio: 0.6, clipping_ratio: 0.08, voiced_duration: 0.1 },
  });

  assert.ok(poorAudio.confidence_score < goodAudio.confidence_score);
  assert.ok(poorAudio.uncertainty_reasons.some((reason) => reason.includes('audio quality')));
});

test('scorePronunciationAttemptData: no audio payload falls back to the prototype scorer', async () => {
  const result = await scorePronunciationAttemptData({ word_id: 'cat', mode: 'word' }, []);

  assert.equal(result.scoring_fallback_reason, 'acoustic_scoring_failed');
  assert.equal(result.scoring_method, 'prototype_signal_rule_v1');
  assert.ok(result.overall_score >= 0 && result.overall_score <= 100);
});

test('scorePronunciationAttemptData: unknown word_id still returns a usable fallback score', async () => {
  const result = await scorePronunciationAttemptData({ word_id: 'not_a_real_word' }, []);
  assert.ok(Number.isFinite(result.overall_score));
  assert.equal(typeof result.recommendation_type, 'string');
});

test('buildHistoryCounts counts weak phonemes only from real acoustic attempts', () => {
  const weakEntry = { text: 'r', score: 40 };
  const results = [
    { scoring_method: 'wav2vec2_gop+mfcc_dtw_v1', phoneme_scores: [weakEntry] },
    { scoring_method: 'mfcc_dtw_v2', phoneme_scores: [weakEntry] },
    // Prototype-fallback rows carry fabricated phoneme scores and must not
    // feed weak-phoneme history.
    { scoring_method: 'prototype_signal_rule_v1', phoneme_scores: [weakEntry, weakEntry] },
  ];

  const counts = buildHistoryCounts(results);
  assert.equal(counts.r, 2);
});
