'use strict';

const textToSpeech = require('@google-cloud/text-to-speech');
const ApiError = require('../utils/ApiError');

const client = new textToSpeech.TextToSpeechClient();

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

module.exports = { generateSessionAudio };
