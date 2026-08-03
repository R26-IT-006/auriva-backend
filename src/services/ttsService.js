'use strict';

const textToSpeech = require('@google-cloud/text-to-speech');
const axios = require('axios');
const ApiError = require('../utils/ApiError');
const { buildSentenceSSML } = require('../utils/ssmlBuilder');
const districtVoiceMap = require('../data/district_voice_map.json');

const client = new textToSpeech.TextToSpeechClient();

const AZURE_KEY = process.env.AZURE_SPEECH_KEY;

/**
 * Generate a single MP3 audio clip via Google Cloud TTS.
 * Voice selection follows FSD §3: en-GB-Neural2-B for male, en-GB-Neural2-A for female.
 *
 * @param {string} text     - The sentence or paragraph to synthesise.
 * @param {'boy'|'girl'} gender - Determines voice selection.
 * @returns {Promise<string>} Base64-encoded MP3 audio content.
 */
async function generateClip(text, gender) {
  const voiceName = gender === 'girl' ? 'en-GB-Neural2-A' : 'en-GB-Neural2-B';

  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: 'en-GB',
      name: voiceName,
    },
    audioConfig: {
      audioEncoding: 'MP3',
    },
  });

  return response.audioContent.toString('base64');
}

/**
 * Generate all 6 TTS clips for a Level 2 Self-Introduction session.
 * Returns early with a structured error if any clip fails (BR-02).
 *
 * @param {string[]} sentences  - Array of 5 sentence strings.
 * @param {string} fullParagraph - The combined paragraph text.
 * @param {'boy'|'girl'} gender
 * @returns {Promise<{ sentenceAudios: string[], paragraphAudio: string }>}
 */
async function generateSessionAudio(sentences, fullParagraph, gender) {
  try {
    const clips = await Promise.all([
      ...sentences.map((s) => generateClip(s, gender)),
      generateClip(fullParagraph, gender),
    ]);

    return {
      sentenceAudios: clips.slice(0, 5),
      paragraphAudio: clips[5],
    };
  } catch (err) {
    throw new ApiError(502, 'Could not prepare the lesson audio. Please check your connection and try again.');
  }
}

/**
 * Generates a single audio buffer for a Level 2 sentence using SSML, via
 * Azure Cognitive Services Speech. Proper nouns are routed to en-GB or
 * si-LK voice segments per district_voice_map.json's two-bucket
 * classification (TASK-29) — see ssmlBuilder.buildSentenceSSML.
 *
 * @param {Array<{text: string, isProperNoun: boolean}>} tokens
 *   Tokenised sentence — use tokeniseSentence() below to produce this.
 * @param {'boy'|'girl'} [gender] - Determines si-LK voice selection.
 * @param {Object} [dynamicNames]  Per-request proper nouns not in the static
 *   district table (e.g. the child's own name, TASK-30). Same shape as
 *   district_voice_map.json: English key -> Sinhala-script value, or null.
 *   Merged over district_voice_map.json — dynamicNames wins on key
 *   collision (documented, not left implicit — see tokeniseSentence below
 *   for the same rule). buildSentenceSSML itself is untouched: it only ever
 *   sees a single already-merged map and has no idea dynamicNames exists.
 * @returns {Promise<Buffer>}
 */
async function generateSentenceAudioSSML(tokens, gender, dynamicNames = {}) {
  const mergedMap = { ...districtVoiceMap, ...dynamicNames };
  const ssml = buildSentenceSSML(tokens, mergedMap, gender);

  // Azure Speech's direct (public) REST synthesis endpoint only works on the
  // regional tts.speech.microsoft.com host — the resource's custom-subdomain
  // endpoint (cognitiveservices.azure.com) 404s here; that shape is only
  // usable behind a private-network/Private Link setup. AZURE_SPEECH_REGION
  // is the source of truth for this URL as of TASK-29.
  const response = await axios.post(
    `https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    ssml,
    {
      headers: {
        'Ocp-Apim-Subscription-Key': AZURE_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      responseType: 'arraybuffer',
    }
  );

  return Buffer.from(response.data);
}

/**
 * Tokenises a Level 2 sentence string into plain-text and proper-noun tokens.
 * Proper nouns are identified by presence in the merged
 * {...districtVoiceMapArg, ...dynamicNames} key set (case-sensitive match
 * first, then case-insensitive fallback with a warn-log for the mismatch).
 * Multi-word lookup keys (e.g. "Nuwara Eliya") are matched as a single
 * token. Tokens only ever carry {text, isProperNoun} — the actual Sinhala
 * spelling is resolved later, by buildSentenceSSML against the same merged
 * map (TASK-30 §1: passing the merged map through is the smaller, more
 * surgical change vs. baking a resolved spelling into each token, since it
 * requires zero edits to ssmlBuilder.js's existing per-token lookup logic).
 *
 * @param {string} sentence  e.g. "My name is Ashan. I live in Nugegoda."
 * @param {Object} [districtVoiceMapArg]  Contents of district_voice_map.json.
 *   Defaults to this module's own require — pass explicitly only when a
 *   caller (e.g. a test) needs to override it; production call sites in
 *   this codebase omit it (pass `undefined`) and rely on the default.
 * @param {Object} [dynamicNames]  Per-request proper nouns not in the static
 *   district table (e.g. the child's own name, TASK-30). Same shape as
 *   district_voice_map.json. Merged over districtVoiceMapArg — dynamicNames
 *   wins on key collision (documented, not left implicit — e.g. a child
 *   literally named "Kandy" would resolve via their own dynamicNames entry,
 *   not the district one).
 * @returns {Array<{text: string, isProperNoun: boolean}>}
 */
function tokeniseSentence(sentence, districtVoiceMapArg = districtVoiceMap, dynamicNames = {}) {
  const mergedMap = { ...districtVoiceMapArg, ...dynamicNames };
  const properNounKeys = Object.keys(mergedMap)
    .filter((k) => k !== '_comment')
    .sort((a, b) => b.length - a.length); // longest first: "Nuwara Eliya" before "Nuwara"

  const isWordChar = (ch) => /[A-Za-z']/.test(ch);
  const wordBoundaryAfter = (str, len) => len >= str.length || !isWordChar(str[len]);

  const tokens = [];
  let remaining = sentence;

  while (remaining.length > 0) {
    let matchedKey = null;

    for (const key of properNounKeys) {
      if (remaining.startsWith(key) && wordBoundaryAfter(remaining, key.length)) {
        matchedKey = key;
        break;
      }
    }

    if (!matchedKey) {
      for (const key of properNounKeys) {
        const candidate = remaining.slice(0, key.length);
        if (candidate.toLowerCase() === key.toLowerCase() && wordBoundaryAfter(remaining, key.length)) {
          console.warn(`tokeniseSentence: case-insensitive proper noun match for "${candidate}" -> "${key}"`);
          matchedKey = key;
          break;
        }
      }
    }

    if (matchedKey) {
      tokens.push({ text: matchedKey, isProperNoun: true });
      remaining = remaining.slice(matchedKey.length);
      continue;
    }

    const wsMatch = remaining.match(/^\s+/);
    if (wsMatch) {
      tokens.push({ text: wsMatch[0], isProperNoun: false });
      remaining = remaining.slice(wsMatch[0].length);
      continue;
    }

    const punctMatch = remaining.match(/^[.,!?;:]+/);
    if (punctMatch) {
      tokens.push({ text: punctMatch[0], isProperNoun: false });
      remaining = remaining.slice(punctMatch[0].length);
      continue;
    }

    const wordMatch = remaining.match(/^[A-Za-z']+/);
    if (wordMatch) {
      tokens.push({ text: wordMatch[0], isProperNoun: false });
      remaining = remaining.slice(wordMatch[0].length);
      continue;
    }

    tokens.push({ text: remaining[0], isProperNoun: false });
    remaining = remaining.slice(1);
  }

  return tokens;
}

module.exports = { generateSessionAudio, generateSentenceAudioSSML, tokeniseSentence };
