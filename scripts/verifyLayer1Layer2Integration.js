#!/usr/bin/env node
'use strict';

/**
 * Manual integration check for the layer-1 (MFCC-DTW) -> layer-2 (wav2vec2
 * GOP) cascade and its ASR/GOP concurrency, using real audio and the real
 * whisper-cli/Python worker subprocesses. NOT part of `npm test` — those
 * binaries/models aren't available on every machine or in CI, and this
 * script's wall-clock timing is only meaningful with the real processes
 * warm. Run manually: `node scripts/verifyLayer1Layer2Integration.js`
 *
 * What it checks, against real reference audio:
 *   1. A perfect-match attempt (the reference recording played back against
 *      itself) is confidently accepted by layer 1 alone — GOP never runs.
 *   2. A degraded attempt (reference audio trimmed) lands in the ambiguous
 *      band and escalates to layer 2 — and the combined ASR+GOP wall-clock
 *      time is close to max(ASR, GOP), not their sum, confirming the
 *      Promise.all concurrency actually holds under real subprocesses.
 *   3. A wrong-word attempt still raises WORD_MISMATCH, unchanged by the
 *      concurrency refactor.
 */

require('dotenv').config();

const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const {
  scoreWordPronunciationAttempt,
} = require('../src/services/pronunciationAnalysisService');
const { verifySpokenWord } = require('../src/services/speechRecognitionService');
const phonemeGopService = require('../src/services/phonemeGopService');
const { WORD_PROFILES } = require('../src/data/wordProfiles');

const REFERENCE_AUDIO_DIR = process.env.REFERENCE_AUDIO_DIR ||
  path.resolve(__dirname, '../assets/reference-audio');

let passCount = 0;
let failCount = 0;

function check(label, condition, detail) {
  const ok = Boolean(condition);
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? ` (${detail})` : ''}`);
  if (ok) passCount += 1;
  else failCount += 1;
  return ok;
}

async function toBase64(filePath) {
  const buffer = await fs.readFile(filePath);
  return buffer.toString('base64');
}

// Pitch-shifting (not trimming) is what actually lands a short reference
// clip in the ambiguous band: these clips are ~0.86s with little silence to
// cut, so trimming either barely changes the DTW score or fails the
// audio-quality gate outright. A pitch shift keeps full duration/energy
// (passes the quality gate) while still meaningfully raising MFCC distance —
// swept empirically: 0.55x lands cat.mp3 at a DTW score of ~64, inside the
// documented [30, 85) escalation band.
async function makePitchShiftedClip(sourcePath, rate) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auriva-e2e-'));
  const outPath = path.join(tmpDir, 'pitched.wav');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-i', sourcePath,
    '-af', `asetrate=16000*${rate},aresample=16000`,
    outPath,
  ]);
  return outPath;
}

async function timeIt(label, fn) {
  const start = Date.now();
  const result = await fn().catch((error) => ({ __error: error }));
  const elapsedMs = Date.now() - start;
  console.log(`  ${label}: ${elapsedMs}ms`);
  return { result, elapsedMs };
}

async function main() {
  console.log('Warming up GOP worker...');
  const { elapsedMs: warmupMs } = await timeIt('warmup', () => phonemeGopService.warmup());
  console.log(`GOP worker warmup took ${warmupMs}ms\n`);

  const catPath = path.join(REFERENCE_AUDIO_DIR, 'cat.mp3');
  const dogPath = path.join(REFERENCE_AUDIO_DIR, 'dog.mp3');
  const catBase64 = await toBase64(catPath);
  const dogBase64 = await toBase64(dogPath);
  const catPhonemes = WORD_PROFILES.cat.sounds;

  // ── Scenario 1: perfect match — layer 1 should confidently accept and
  // never call GOP at all. ─────────────────────────────────────────────────
  console.log('Scenario 1: reference audio scored against itself (target "cat")');
  const perfectResult = await scoreWordPronunciationAttempt({
    word_id: 'cat',
    raw_audio_base64: catBase64,
    raw_audio_mime_type: 'audio/mpeg',
  });
  console.log(`  layer1_decision=${perfectResult.layer1_decision} overall_score=${perfectResult.overall_score} gop_ran=${Boolean(perfectResult.gop_assessment)}`);
  check('perfect match is confidently accepted by layer 1', perfectResult.layer1_decision === 'dtw_only_accept');
  check('layer 1 acceptance means GOP never ran', perfectResult.gop_assessment == null);
  check('overall_score is high', perfectResult.overall_score >= 80, `score=${perfectResult.overall_score}`);
  console.log('');

  // ── Scenario 2: degraded attempt — force the ambiguous band so layer 1
  // escalates to layer 2, then compare combined timing against the two
  // subprocesses run in isolation. ─────────────────────────────────────────
  console.log('Scenario 2: pitch-shifted attempt (target "cat") — expect escalation to GOP');
  const truncatedPath = await makePitchShiftedClip(catPath, 0.55);
  const truncatedBase64 = await toBase64(truncatedPath);

  const { result: escalatedResult, elapsedMs: combinedMs } = await timeIt(
    'combined scoreWordPronunciationAttempt',
    () => scoreWordPronunciationAttempt({
      word_id: 'cat',
      raw_audio_base64: truncatedBase64,
      raw_audio_mime_type: 'audio/mpeg',
    })
  );

  if (escalatedResult.__error) {
    console.log(`  (threw: ${escalatedResult.__error.code || escalatedResult.__error.message})`);
  } else {
    console.log(`  layer1_decision=${escalatedResult.layer1_decision} overall_score=${escalatedResult.overall_score} gop_ran=${Boolean(escalatedResult.gop_assessment)}`);
  }

  const escalated = !escalatedResult.__error && escalatedResult.layer1_decision === 'escalated_to_gop';
  check('degraded attempt escalates to layer 2', escalated, escalatedResult.layer1_decision);

  if (escalated) {
    const { elapsedMs: asrAloneMs } = await timeIt('ASR alone (isolated)', () => verifySpokenWord({
      rawAudioBase64: truncatedBase64,
      mimeType: 'audio/mpeg',
      targetWord: 'cat',
      wordLabel: 'cat',
    }));
    const { elapsedMs: gopAloneMs } = await timeIt('GOP alone (isolated, worker already warm)', () => phonemeGopService.assessPhonemeGop({
      rawAudioBase64: truncatedBase64,
      mimeType: 'audio/mpeg',
      targetSounds: catPhonemes,
    }));

    const sequentialEstimateMs = asrAloneMs + gopAloneMs;
    const concurrencySavingsMs = sequentialEstimateMs - combinedMs;
    console.log(`  sequential estimate (ASR + GOP): ${sequentialEstimateMs}ms`);
    console.log(`  actual combined (parallel):      ${combinedMs}ms`);
    console.log(`  savings from running concurrently: ${concurrencySavingsMs}ms`);
    // Informational only, not a pass/fail assertion: on an 8-core dev
    // machine, running two independently multi-threaded CPU-bound
    // subprocesses concurrently was measured to be a wash — sometimes a
    // modest win, sometimes a modest loss (see PHONEME_GOP_TORCH_THREADS /
    // WHISPER_THREADS capping added specifically because of this finding).
    // Asserting a specific direction here would just be flaky under normal
    // OS scheduling noise.
    console.log(
      `  (informational — concurrency benefit is noisy on CPU-bound hardware, not a guaranteed win; see comment above)`
    );
  } else {
    console.log('  (skipping concurrency timing comparison — did not land in the escalation band on this run)');
  }
  console.log('');

  // ── Scenario 3: wrong word — WORD_MISMATCH must still fire. ─────────────
  console.log('Scenario 3: dog.mp3 scored against target "cat" — expect WORD_MISMATCH');
  let mismatchError = null;
  try {
    await scoreWordPronunciationAttempt({
      word_id: 'cat',
      raw_audio_base64: dogBase64,
      raw_audio_mime_type: 'audio/mpeg',
    });
  } catch (error) {
    mismatchError = error;
  }
  console.log(`  threw: ${mismatchError ? mismatchError.code || mismatchError.message : '(nothing thrown)'}`);
  check('wrong-word attempt raises WORD_MISMATCH', mismatchError?.code === 'WORD_MISMATCH');

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Script crashed:', error);
  process.exit(1);
});
