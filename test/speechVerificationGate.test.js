'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchesTargetWord,
  normalizeTranscript,
  isConfidentDifferentWord,
} = require('../src/services/speechRecognitionService');

test('normalizeTranscript strips bracketed ASR annotations and punctuation', () => {
  assert.equal(normalizeTranscript(' Cat! [BLANK_AUDIO] (noise) '), 'cat');
  assert.equal(normalizeTranscript('DOG.'), 'dog');
});

test('matchesTargetWord accepts exact and near matches within tolerance', () => {
  assert.equal(matchesTargetWord('cat', 'cat'), true);
  assert.equal(matchesTargetWord('cet', 'cat'), true); // distance 1, length 3
  assert.equal(matchesTargetWord('dog', 'cat'), false);
});

test('matchesTargetWord accepts spoken letter names for single-letter targets', () => {
  assert.equal(matchesTargetWord('bee', 'b'), true);
  assert.equal(matchesTargetWord('zed', 'z'), true);
  assert.equal(matchesTargetWord('en', 'm'), false);
});

// Mismatch policy: hard WORD_MISMATCH only when the transcript confidently
// names a DIFFERENT vocabulary word or letter. Garbled/disordered speech —
// which this product's population produces on genuine attempts — must score
// on acoustic/GOP evidence with a teacher-review flag instead of blocking.
test('isConfidentDifferentWord: garbled speech is not a confident mismatch', () => {
  assert.equal(isConfidentDifferentWord('vis', 'fish'), false);
  assert.equal(isConfidentDifferentWord('fsh sh', 'fish'), false);
});

test('isConfidentDifferentWord: a different vocabulary word is a confident mismatch', () => {
  assert.equal(isConfidentDifferentWord('dog', 'cat'), true);
  assert.equal(isConfidentDifferentWord('the dog', 'cat'), true);
});

test('isConfidentDifferentWord: letter targets require a clearly spoken different letter', () => {
  assert.equal(isConfidentDifferentWord('em', 'n'), true); // said "m", target "n"
  assert.equal(isConfidentDifferentWord('mmm sound', 'n'), false); // not a letter name
});
