'use strict';

// Keep this corpus test deterministic and fast: it verifies the acoustic
// reference path and canonical phoneme alignment, not the optional Whisper
// subprocess (covered by speechVerificationGate.test.js).
process.env.SPEECH_VERIFICATION_ENABLED = 'false';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LETTER_SOUNDS,
  resolveTargetPhonemes,
} = require('../src/services/wordProfiles');
const {
  scorePronunciationAttemptData,
} = require('../src/services/pronunciationScoringService');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

test('all 26 alphabet entries have canonical spoken-name profiles and reference audio', () => {
  assert.deepEqual(Object.keys(LETTER_SOUNDS), ALPHABET);

  for (const letter of ALPHABET) {
    const referencePath = path.resolve(
      __dirname,
      '../assets/reference-audio',
      `${letter}.mp3`
    );

    assert.ok(LETTER_SOUNDS[letter].length > 0, `${letter} needs phonemes`);
    assert.ok(fs.statSync(referencePath).size > 0, `${letter} needs reference audio`);
  }
});

test('alphabet mode ignores legacy client letter-sound overrides for A-Z', () => {
  for (const letter of ALPHABET) {
    assert.deepEqual(
      resolveTargetPhonemes({
        mode: 'alphabet',
        word_id: letter,
        target_phonemes: [{ text: 'incorrect-client-phoneme' }],
      }),
      LETTER_SOUNDS[letter],
      `${letter} should use its spoken-name profile`
    );
  }
});

test('all 26 reference recordings complete the full scoring flow', async () => {
  for (const letter of ALPHABET) {
    const referencePath = path.resolve(
      __dirname,
      '../assets/reference-audio',
      `${letter}.mp3`
    );
    const result = await scorePronunciationAttemptData({
      mode: 'alphabet',
      word_id: letter,
      word_label: letter.toUpperCase(),
      // Deliberately reproduce the old broken payload. The server must still
      // align against the canonical spoken letter name.
      target_phonemes: [{ text: 'incorrect-client-phoneme' }],
      raw_audio_base64: fs.readFileSync(referencePath).toString('base64'),
      raw_audio_mime_type: 'audio/mpeg',
    }, []);
    const alignedPhonemes = result.phoneme_scores.map((entry) => entry.text);

    assert.deepEqual(alignedPhonemes, LETTER_SOUNDS[letter]);
    assert.ok(
      result.overall_score >= 95,
      `${letter.toUpperCase()} reference scored only ${result.overall_score}`
    );
    assert.equal(result.scoring_method, 'mfcc_dtw_v2');
  }
});
