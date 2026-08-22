'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');

const logger = require('../utils/logger');
const { WORD_PROFILES } = require('./wordProfiles');

const execFileAsync = promisify(execFile);

const WHISPER_CLI_PATH = process.env.WHISPER_CLI_PATH || 'whisper-cli';
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH ||
  path.resolve(__dirname, '../../models/ggml-base.en.bin');
const SPEECH_VERIFICATION_ENABLED = process.env.SPEECH_VERIFICATION_ENABLED !== 'false';
const WHISPER_TIMEOUT_MS = Number(process.env.WHISPER_TIMEOUT_MS || 30000);
// whisper-cli defaults to 4 threads. pronunciationAnalysisService now runs
// this concurrently with the GOP worker's torch inference (also capped, see
// PHONEME_GOP_TORCH_THREADS) — measured on an 8-core machine, two
// full-default-thread subprocesses at once caused CPU oversubscription that
// sometimes made the concurrent run *slower* than sequential. Capping both
// leaves headroom instead of fighting over the same cores.
const WHISPER_THREADS = Number(process.env.WHISPER_THREADS || 2);

// Spoken names of letters for alphabet mode: saying "b" is transcribed "bee".
const LETTER_NAMES = {
  a: ['ay', 'eh'],
  b: ['bee', 'be'],
  c: ['see', 'sea', 'cee'],
  d: ['dee'],
  e: ['ee'],
  f: ['ef', 'eff'],
  g: ['gee'],
  h: ['aitch', 'haitch'],
  i: ['eye', 'i'],
  j: ['jay'],
  k: ['kay'],
  l: ['el', 'ell'],
  m: ['em'],
  n: ['en'],
  o: ['oh', 'o'],
  p: ['pee'],
  q: ['cue', 'queue'],
  r: ['ar', 'are'],
  s: ['es', 'ess'],
  t: ['tee', 'tea'],
  u: ['you', 'yu'],
  v: ['vee'],
  w: ['double you', 'doubleyou'],
  x: ['ex'],
  y: ['why'],
  z: ['zee', 'zed'],
};

// Voicing-pair letter confusions ASR commonly makes on isolated letters
// ("bee" heard as "p"). For these the phoneme-level GOP scorer is the better
// judge, so the word gate defers instead of hard-rejecting.
const CONFUSABLE_LETTER_PAIRS = {
  b: 'p', p: 'b',
  d: 't', t: 'd',
  g: 'k', k: 'g',
  v: 'f', f: 'v',
  s: 'z', z: 's',
};

function transcriptAsLetter(transcript) {
  const tokens = transcript.split(' ').filter(Boolean);
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  if (/^[a-z]$/.test(token)) return token;
  const match = Object.entries(LETTER_NAMES)
    .find(([, names]) => names.includes(token));
  return match ? match[0] : null;
}

class WordMismatchError extends Error {
  constructor({ targetWord, wordLabel, recognizedText }) {
    const label = wordLabel || targetWord;
    super(
      recognizedText
        ? `It sounds like "${recognizedText}" was said instead of "${label}". Please try saying "${label}" again.`
        : `The word "${label}" was not recognized in the recording. Please try saying "${label}" again.`
    );
    this.name = 'WordMismatchError';
    this.code = 'WORD_MISMATCH';
    this.details = {
      target_word: targetWord,
      recognized_text: recognizedText || null,
    };
  }
}

function getInputExtension(mimeType = '') {
  const lower = String(mimeType).toLowerCase();
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('wav')) return '.wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return '.mp3';
  if (lower.includes('3gpp')) return '.3gp';
  return '.m4a';
}

function normalizeTranscript(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distance = Array.from({ length: rows }, (_, i) => {
    const row = new Uint16Array(cols);
    row[0] = i;
    return row;
  });
  for (let j = 0; j < cols; j += 1) distance[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      distance[i][j] = Math.min(
        distance[i - 1][j] + 1,
        distance[i][j - 1] + 1,
        distance[i - 1][j - 1] + substitutionCost
      );
    }
  }
  return distance[a.length][b.length];
}

function getMatchTolerance(targetWord) {
  if (targetWord.length >= 6) return 2;
  if (targetWord.length >= 3) return 1;
  return 0;
}

function matchesTargetWord(transcript, targetWord) {
  const target = normalizeTranscript(targetWord);
  if (!target) return true;

  const tokens = transcript.split(' ').filter(Boolean);
  const acceptedForms = target.length === 1
    ? [target, ...(LETTER_NAMES[target] || [])]
    : [target];

  return tokens.some((token) =>
    acceptedForms.some((form) => {
      if (token === form) return true;
      return levenshteinDistance(token, form) <= getMatchTolerance(form);
    })
  ) || acceptedForms.some((form) => form.includes(' ') && transcript.includes(form));
}

async function transcribeBase64Audio(rawAudioBase64, mimeType) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auriva-asr-'));
  const inputPath = path.join(tmpDir, `attempt${getInputExtension(mimeType)}`);
  const wavPath = path.join(tmpDir, 'attempt.wav');

  try {
    await fs.writeFile(inputPath, Buffer.from(rawAudioBase64, 'base64'));
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', inputPath,
      '-ac', '1',
      '-ar', '16000',
      wavPath,
    ], { timeout: WHISPER_TIMEOUT_MS });

    const { stdout } = await execFileAsync(WHISPER_CLI_PATH, [
      '-m', WHISPER_MODEL_PATH,
      '-f', wavPath,
      '-t', String(WHISPER_THREADS),
      '--no-timestamps',
      '--no-prints',
      '--language', 'en',
    ], { timeout: WHISPER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });

    return normalizeTranscript(stdout);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Transcribes the attempt audio and checks the target word was actually said.
 *
 * Returns a speech_verification object on success or inconclusive results.
 * Throws WordMismatchError when speech was clearly recognized as a different
 * word. Recognition being unavailable (missing binary/model, whisper failure)
 * never blocks scoring — pronunciation scoring still works, only unverified.
 */
async function verifySpokenWord({ rawAudioBase64, mimeType, targetWord, wordLabel }) {
  if (!SPEECH_VERIFICATION_ENABLED) {
    return { status: 'disabled', recognized_text: null };
  }

  let transcript;
  try {
    transcript = await transcribeBase64Audio(rawAudioBase64, mimeType);
  } catch (error) {
    logger.warn(`Speech verification unavailable: ${error.message}`);
    return { status: 'unavailable', recognized_text: null };
  }

  if (!transcript) {
    return { status: 'inconclusive', recognized_text: null };
  }

  if (matchesTargetWord(transcript, targetWord)) {
    return { status: 'verified', recognized_text: transcript };
  }

  const target = normalizeTranscript(targetWord);
  if (target.length === 1) {
    const spokenLetter = transcriptAsLetter(transcript);
    if (spokenLetter && CONFUSABLE_LETTER_PAIRS[target] === spokenLetter) {
      return { status: 'inconclusive_confusable', recognized_text: transcript };
    }
  }

  // Hard-reject only when the transcript confidently IS a different word the
  // app knows (a different vocabulary word or a clearly spoken different
  // letter). Anything else — garbled, partial, or disordered speech the ASR
  // can't parse — is exactly what this product's population produces on a
  // genuine attempt, so scoring proceeds on acoustic/GOP evidence with the
  // attempt flagged for teacher review instead of blocking the child.
  if (isConfidentDifferentWord(transcript, target)) {
    throw new WordMismatchError({
      targetWord,
      wordLabel,
      recognizedText: transcript,
    });
  }

  return { status: 'unverified_speech', recognized_text: transcript };
}

function isConfidentDifferentWord(transcript, target) {
  const tokens = transcript.split(' ').filter(Boolean);

  if (target.length === 1) {
    // Letter target: a clearly spoken different letter name counts.
    const spokenLetter = transcriptAsLetter(transcript);
    return Boolean(spokenLetter && spokenLetter !== target);
  }

  // Word target: an exact match on a different word in the vocabulary counts.
  return tokens.some((token) => token !== target && Boolean(WORD_PROFILES[token]));
}

module.exports = {
  verifySpokenWord,
  transcribeBase64Audio,
  matchesTargetWord,
  normalizeTranscript,
  isConfidentDifferentWord,
  WordMismatchError,
};
