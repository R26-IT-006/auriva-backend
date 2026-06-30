'use strict';

const speech  = require('@google-cloud/speech');
const fuzz    = require('fuzzball');
const axios   = require('axios');

const client = new speech.SpeechClient();

const FILLERS = /\b(um|uh|er|ah|like|you know)\b/gi;
const MICROSERVICE_URL = process.env.PHONEME_MICROSERVICE_URL || 'http://localhost:5001';
const MICROSERVICE_TIMEOUT_MS = 2000;

function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, '')
    .replace(FILLERS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── RC1 — Phoneme-aware scoring (replaces the old fuzzy/loose thresholds) ──
// Falls back to the original fuzzball logic if the microservice is down —
// this is the graceful degradation the FSD requires.
async function phonemeScore(normalisedTranscript, rawTranscript, triggers) {
  try {
    const { data } = await axios.post(
      `${MICROSERVICE_URL}/score-phoneme`,
      { transcript: normalisedTranscript, target_word: triggers.target },
      { timeout: MICROSERVICE_TIMEOUT_MS }
    );
    return {
      score: data.score,
      match_type: 'fuzzy', // stays within the existing DB enum — see note below
      phoneme_error_class: data.error_class,
      phoneme_accuracy: data.phoneme_accuracy,
    };
  } catch {
    const norm3 = triggers.score3.map(normalise);
    const bestFuzzy = Math.max(...norm3.map((t) => fuzz.token_sort_ratio(normalisedTranscript, t)));
    if (bestFuzzy >= 80) return { score: 3, match_type: 'fuzzy', phoneme_error_class: null, phoneme_accuracy: null };
    if (bestFuzzy >= 60) return { score: 2, match_type: 'fuzzy', phoneme_error_class: null, phoneme_accuracy: null };

    const norm1 = triggers.score1.map(normalise);
    const hasLoose = norm1.some((kw) => normalisedTranscript.includes(kw));
    if (hasLoose) return { score: 1, match_type: 'keyword', phoneme_error_class: null, phoneme_accuracy: null };

    return { score: 0, match_type: 'none', phoneme_error_class: null, phoneme_accuracy: null };
  }
}

async function assessSpeech(audioBase64, mimeType, triggers) {
  const encodingMap = {
    'audio/wav':  'LINEAR16',
    'audio/wave': 'LINEAR16',
    'audio/ogg':  'OGG_OPUS',
    'audio/webm': 'WEBM_OPUS',
    'audio/mp4':  'MP3',
    'audio/m4a':  'MP3',
    'audio/mpeg': 'MP3',
  };
  const encoding = encodingMap[mimeType] ?? 'LINEAR16';
  const audioBytes = Buffer.from(audioBase64, 'base64');

  const [response] = await client.recognize({
    audio: { content: audioBytes.toString('base64') },
    config: {
      encoding,
      sampleRateHertz:            16000,
      audioChannelCount:          1,
      languageCode:               'en-GB',
      model:                      'command_and_search',
      maxAlternatives:            3,
      enableAutomaticPunctuation: false,
      enableWordTimeOffsets:      true, // RC3 — needed for child_speech_onset_ts
    },
  });

  // RC3 — offset of the first detected word within this recording.
  // Caller combines this with recording_start_ts to get true speech onset.
  // Falls back to null if STT returns no word-level timing for this audio.
  const firstWord = response.results[0]?.alternatives[0]?.words?.[0];
  const first_word_offset_ms = firstWord?.startTime
    ? Number(firstWord.startTime.seconds ?? 0) * 1000 + Number(firstWord.startTime.nanos ?? 0) / 1e6
    : null;

  const rawTranscript = response.results
    .map((r) => r.alternatives[0]?.transcript ?? '')
    .join(' ')
    .trim();

  if (!rawTranscript) {
    return { score: 0, transcript: '', match_type: 'none', phoneme_error_class: null, phoneme_accuracy: null, first_word_offset_ms: null };
  }

  const transcript = normalise(rawTranscript);

  // ── Layer 1a — exact match (score 3) ──────────────────────────────────
  const norm3 = triggers.score3.map(normalise);
  if (norm3.includes(transcript)) {
    return { score: 3, transcript: rawTranscript, match_type: 'exact', phoneme_error_class: null, phoneme_accuracy: 1.0, first_word_offset_ms };
  }

  // ── Layer 1b — keyword match (score 2) ────────────────────────────────
  const norm2 = triggers.score2.map(normalise);
  const hasKeyword = norm2.some((kw) => transcript.includes(kw));
  if (hasKeyword) {
    return { score: 2, transcript: rawTranscript, match_type: 'keyword', phoneme_error_class: null, phoneme_accuracy: null, first_word_offset_ms };
  }

  // ── Layer 2 — RC1 phoneme-aware scoring ───────────────────────────────
  const result = await phonemeScore(transcript, rawTranscript, triggers);
  return {
    score:                result.score,
    transcript:           rawTranscript,
    match_type:           result.match_type,
    phoneme_error_class:  result.phoneme_error_class,
    phoneme_accuracy:     result.phoneme_accuracy,
    first_word_offset_ms,
  };
}

module.exports = { assessSpeech };