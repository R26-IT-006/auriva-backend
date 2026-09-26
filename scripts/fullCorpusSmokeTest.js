#!/usr/bin/env node
'use strict';

/**
 * Full-corpus functional smoke test for the Pronunciation Support scoring
 * component. NOT part of `npm test` — needs real ffmpeg/whisper-cli/Python
 * worker, and takes real wall-clock time (a few minutes for the full word
 * bank). Run manually: `node scripts/fullCorpusSmokeTest.js`
 *
 * For every word in WORD_PROFILES and every letter in LETTER_SOUNDS, scores
 * that word's own reference recording against itself (self-match) through
 * the real scoreWordPronunciationAttempt pipeline — layer 1 DTW, the ASR
 * gate, and layer 2 GOP when escalated. A self-match should score high and
 * never throw; anything else is a real bug in a specific word's reference
 * audio, phoneme profile, or the scoring pipeline itself.
 *
 * This is a regression sweep across the whole word bank, not a timing
 * benchmark (see verifyLayer1Layer2Integration.js for that, and its
 * documented limits on this hardware).
 */

require('dotenv').config();

const fs = require('fs/promises');
const path = require('path');

const {
  scoreWordPronunciationAttempt,
} = require('../src/services/pronunciationAnalysisService');
const phonemeGopService = require('../src/services/phonemeGopService');
const { WORD_PROFILES, LETTER_SOUNDS } = require('../src/data/wordProfiles');

const REFERENCE_AUDIO_DIR = path.resolve(
  __dirname,
  '../../auriva-frontend/assets/pronounciation-audios'
);

const LOW_SCORE_THRESHOLD = 70; // a self-match scoring below this is suspicious

async function toBase64(filePath) {
  const buffer = await fs.readFile(filePath);
  return buffer.toString('base64');
}

async function main() {
  console.log('Warming up GOP worker (in case any self-match escalates)...');
  await phonemeGopService.warmup();
  console.log('Ready.\n');

  const entries = [
    ...Object.keys(WORD_PROFILES).map((id) => ({ id, kind: 'word' })),
    ...Object.keys(LETTER_SOUNDS).map((id) => ({ id, kind: 'letter' })),
  ];

  const results = [];
  for (const entry of entries) {
    const audioPath = path.join(REFERENCE_AUDIO_DIR, `${entry.id}.mp3`);
    const row = { id: entry.id, kind: entry.kind };
    try {
      const base64 = await toBase64(audioPath);
      const result = await scoreWordPronunciationAttempt({
        word_id: entry.id,
        raw_audio_base64: base64,
        raw_audio_mime_type: 'audio/mpeg',
      });
      row.ok = true;
      row.overall_score = result.overall_score;
      row.layer1_decision = result.layer1_decision;
      row.gop_ran = Boolean(result.gop_assessment);
      row.speech_verification_status = result.speech_verification?.status || null;
      row.low_score = result.overall_score < LOW_SCORE_THRESHOLD;
    } catch (error) {
      row.ok = false;
      row.error_code = error.code || null;
      row.error_message = error.message;
    }
    results.push(row);
    const label = row.ok
      ? `score=${row.overall_score} layer1=${row.layer1_decision} gop=${row.gop_ran} asr=${row.speech_verification_status}`
      : `THREW ${row.error_code || 'Error'}: ${row.error_message}`;
    console.log(`${row.ok && !row.low_score ? 'PASS' : 'FLAG'} — ${entry.kind} "${entry.id}": ${label}`);
  }

  const thrown = results.filter((r) => !r.ok);
  const lowScoring = results.filter((r) => r.ok && r.low_score);
  const escalated = results.filter((r) => r.ok && r.layer1_decision === 'escalated_to_gop');
  const asrNotVerified = results.filter(
    (r) => r.ok && r.speech_verification_status && !['verified', 'disabled'].includes(r.speech_verification_status)
  );

  console.log(`\n${results.length} total, ${thrown.length} threw, ${lowScoring.length} scored below ${LOW_SCORE_THRESHOLD} on self-match`);
  console.log(`${escalated.length} escalated to layer 2 on a self-match (expected to be rare)`);
  console.log(`${asrNotVerified.length} had a non-"verified" ASR status on a self-match`);

  if (thrown.length) {
    console.log('\nThrew:');
    thrown.forEach((r) => console.log(`  ${r.kind} "${r.id}": ${r.error_code || ''} ${r.error_message}`));
  }
  if (lowScoring.length) {
    console.log('\nLow-scoring self-matches:');
    lowScoring.forEach((r) => console.log(`  ${r.kind} "${r.id}": score=${r.overall_score}`));
  }
  if (escalated.length) {
    console.log('\nEscalated to GOP on a self-match:');
    escalated.forEach((r) => console.log(`  ${r.kind} "${r.id}": score=${r.overall_score}`));
  }
  if (asrNotVerified.length) {
    console.log('\nASR did not confirm the word on its own reference recording:');
    asrNotVerified.forEach((r) => console.log(`  ${r.kind} "${r.id}": status=${r.speech_verification_status}`));
  }

  process.exit(thrown.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Script crashed:', error);
  process.exit(1);
});
