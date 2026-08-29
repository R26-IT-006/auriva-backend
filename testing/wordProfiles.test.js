'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WORD_PROFILES, LETTER_SOUNDS, resolveTargetPhonemes } = require('../src/services/wordProfiles');
const { computeInformativeness, invalidateReviewedCountsCache } = require('../src/services/pronunciationReviewQueueService');

test('the word corpus contains valid difficulty and phoneme data', () => {
  assert.ok(Object.keys(WORD_PROFILES).length >= 50);
  for (const [word, profile] of Object.entries(WORD_PROFILES)) {
    assert.ok(profile.difficulty >= 1 && profile.difficulty <= 5, `${word} difficulty`);
    assert.ok(profile.sounds.length > 0, `${word} sounds`);
    assert.ok(profile.sounds.every((sound) => typeof sound === 'string' && sound.length > 0), `${word} phonemes`);
  }
});

test('the alphabet corpus covers every lowercase letter', () => {
  assert.deepEqual(Object.keys(LETTER_SOUNDS), 'abcdefghijklmnopqrstuvwxyz'.split(''));
});

test('resolveTargetPhonemes normalizes alphabet IDs and trusts canonical letter names', () => {
  assert.deepEqual(resolveTargetPhonemes({
    mode: 'alphabet', word_id: ' C ', target_phonemes: [{ text: 'wrong' }],
  }), ['s', 'iː']);
});

test('resolveTargetPhonemes accepts string and object phonemes for word mode', () => {
  assert.deepEqual(resolveTargetPhonemes({
    mode: 'word', word_id: 'cat', target_phonemes: ['k', { text: 'æ' }, null, { text: 't' }],
  }), ['k', 'æ', 't']);
});

test('resolveTargetPhonemes falls back to the server word corpus and returns empty for unknown words', () => {
  assert.deepEqual(resolveTargetPhonemes({ word_id: 'CAT' }), WORD_PROFILES.cat.sounds);
  assert.deepEqual(resolveTargetPhonemes({ word_id: 'not-in-corpus' }), []);
  assert.deepEqual(resolveTargetPhonemes(), []);
});

test('review informativeness rewards uncertainty and under-covered populations', () => {
  const uncertain = computeInformativeness({ confidenceScore: 10, reviewedForPopulation: 20 });
  const confident = computeInformativeness({ confidenceScore: 90, reviewedForPopulation: 20 });
  const underCovered = computeInformativeness({ confidenceScore: 50, reviewedForPopulation: 0 });
  const covered = computeInformativeness({ confidenceScore: 50, reviewedForPopulation: 100 });

  assert.ok(uncertain > confident);
  assert.ok(underCovered > covered);
});

test('review informativeness handles missing confidence and negative coverage defensively', () => {
  assert.equal(
    computeInformativeness({ confidenceScore: null, reviewedForPopulation: 10 }),
    computeInformativeness({ confidenceScore: 50, reviewedForPopulation: 10 }),
  );
  assert.equal(
    computeInformativeness({ confidenceScore: 50, reviewedForPopulation: -1 }),
    computeInformativeness({ confidenceScore: 50, reviewedForPopulation: 0 }),
  );
  assert.doesNotThrow(() => invalidateReviewedCountsCache());
});
