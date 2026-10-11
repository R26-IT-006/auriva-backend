'use strict';

const VOICE_NAME = 'en-IN-Aarti:DragonHDLatestNeural';
const PROSODY_RATE = '0.6';

/**
 * Builds an Azure Cognitive Services Speech SSML string for a Level 2 sentence.
 *
 * One Dragon HD voice (Aarti) speaks the whole sentence. Proper nouns are
 * handled per district_voice_map.json's two-bucket classification:
 *   - Bucket A (map value === null): internationally anglicized name, spoken
 *     as plain English text. Intentional, not a gap — no warning.
 *   - Bucket B (map value is a non-empty string): everyday local name, spoken
 *     from its Sinhala-script spelling wrapped in <lang xml:lang="si-LK">.
 *   - Key absent from the map entirely: genuine miss, spoken as the English
 *     text AND logs a warning.
 *
 * Microsoft's HD voices doc lists <prosody> as unsupported for DragonHD, but
 * Azure accepts it on Aarti and it measurably slows the audio (checked by
 * output length), so the whole voice body is wrapped in one <prosody rate>.
 * <lang> and <break> are documented as supported. No mstts namespace — it is
 * only needed for mstts:express-as, which this builder does not emit.
 *
 * Voice name and rate can be overridden without a code edit via
 * TTS_AARTI_VOICE_NAME / TTS_AARTI_RATE (read at call time).
 *
 * @param {Array<{text: string, isProperNoun: boolean}>} tokens
 * @param {Object} districtVoiceMap  Contents of district_voice_map.json.
 * @param {'boy'|'girl'} [gender]  Unused — kept so existing callers' signature
 *   is unchanged; a single voice is used regardless of the child's gender.
 * @returns {string}  Complete SSML string ready for Azure Speech synthesis.
 */
function buildSentenceSSML(tokens, districtVoiceMap, gender) { // eslint-disable-line no-unused-vars
  if (!tokens || tokens.length === 0) return '';

  const voiceName = process.env.TTS_AARTI_VOICE_NAME || VOICE_NAME;
  const rate = process.env.TTS_AARTI_RATE || PROSODY_RATE;

  let body = '';

  for (const token of tokens) {
    let content = token.text;

    if (token.isProperNoun) {
      if (Object.prototype.hasOwnProperty.call(districtVoiceMap, token.text)) {
        const mapped = districtVoiceMap[token.text];
        if (mapped) {
          content = `<lang xml:lang="si-LK">${mapped}</lang>`;
        }
        // mapped === null -> Bucket A: plain English text, no warning.
      } else {
        console.warn(`buildSentenceSSML: no district_voice_map entry for proper noun "${token.text}"`);
      }
    }

    if (/[.?]$/.test(token.text)) {
      content += '<break time="450ms"/>';
    }

    body += content;
  }

  return `<speak version="1.0" xml:lang="en-IN" xmlns="http://www.w3.org/2001/10/synthesis"><voice name="${voiceName}"><prosody rate="${rate}">${body}</prosody></voice></speak>`;
}

module.exports = { buildSentenceSSML };