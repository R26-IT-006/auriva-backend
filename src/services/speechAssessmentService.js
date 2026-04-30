'use strict';

const speech  = require('@google-cloud/speech');
const fuzz    = require('fuzzball');

const client = new speech.SpeechClient();

const FILLERS = /\b(um|uh|er|ah|like|you know)\b/gi;

function normalise(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s']/g, '')
    .replace(FILLERS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Assess a child's spoken response against a word's keyword_triggers.
 *
 * @param {string} audioBase64   - base64-encoded audio data
 * @param {string} mimeType      - 'audio/m4a' | 'audio/ogg' | 'audio/wav' | etc.
 * @param {object} triggers      - { target, score3[], score2[], score1[] }
 * @returns {{ score: number, transcript: string, match_type: string }}
 */
async function assessSpeech(audioBase64, mimeType, triggers) {
  // Determine Google Cloud STT encoding from MIME type
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
      model:                      'command_and_search', // best for short words/phrases
      maxAlternatives:            3,                   // catch near-misses
      enableAutomaticPunctuation: false,
    },
  });

  const rawTranscript = response.results
    .map((r) => r.alternatives[0]?.transcript ?? '')
    .join(' ')
    .trim();

  if (!rawTranscript) {
    return { score: 0, transcript: '', match_type: 'none' };
  }

  const transcript = normalise(rawTranscript);

  // ── Exact match (score 3) ────────────────────────────────────────────────
  const norm3 = triggers.score3.map(normalise);
  if (norm3.includes(transcript)) {
    return { score: 3, transcript: rawTranscript, match_type: 'exact' };
  }

  // ── Keyword match (score 2) ──────────────────────────────────────────────
  const norm2 = triggers.score2.map(normalise);
  const hasKeyword = norm2.some((kw) => transcript.includes(kw));
  if (hasKeyword) {
    return { score: 2, transcript: rawTranscript, match_type: 'keyword' };
  }

  // ── Fuzzy match against all score-3 triggers ─────────────────────────────
  const bestFuzzy = Math.max(
    ...norm3.map((t) => fuzz.token_sort_ratio(transcript, t))
  );
  if (bestFuzzy >= 80) {
    return { score: 3, transcript: rawTranscript, match_type: 'fuzzy' };
  }
  if (bestFuzzy >= 60) {
    return { score: 2, transcript: rawTranscript, match_type: 'fuzzy' };
  }

  // ── Loose match (score 1) ────────────────────────────────────────────────
  const norm1 = triggers.score1.map(normalise);
  const hasLoose = norm1.some((kw) => transcript.includes(kw));
  if (hasLoose) {
    return { score: 1, transcript: rawTranscript, match_type: 'keyword' };
  }

  return { score: 0, transcript: rawTranscript, match_type: 'none' };
}

module.exports = { assessSpeech };
