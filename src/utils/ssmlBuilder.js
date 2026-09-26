'use strict';

const EN_VOICE_NAME = 'en-GB-SoniaNeural';
const PROSODY_RATE = '0.78';
const PROSODY_PITCH = '+2st';

/**
 * Builds an Azure Cognitive Services Speech SSML string for a Level 2 sentence.
 *
 * Proper nouns are routed to one of two voices per district_voice_map.json:
 *   - Bucket A (map value === null): internationally anglicized name, stays
 *     on the en-GB voice, spoken as the English display text. Intentional,
 *     not a gap — no warning.
 *   - Bucket B (map value is a non-empty string): everyday local name,
 *     switches to the si-LK voice and speaks the Sinhala-script spelling.
 *   - Key absent from the map entirely: genuine miss, falls back to en-GB
 *     with the English text AND logs a warning.
 *
 * @param {Array<{text: string, isProperNoun: boolean}>} tokens
 * @param {Object} districtVoiceMap  Contents of district_voice_map.json.
 * @param {'boy'|'girl'} gender
 * @returns {string}  Complete SSML string ready for Azure Speech synthesis.
 */
function buildSentenceSSML(tokens, districtVoiceMap, gender) {
  if (!tokens || tokens.length === 0) return '';

  const siVoiceName = gender === 'girl' ? 'si-LK-ThiliniNeural' : 'si-LK-SameeraNeural';

  const segments = [];

  for (const token of tokens) {
    let voiceName = EN_VOICE_NAME;
    let content = token.text;

    if (token.isProperNoun) {
      if (Object.prototype.hasOwnProperty.call(districtVoiceMap, token.text)) {
        const mapped = districtVoiceMap[token.text];
        if (mapped) {
          voiceName = siVoiceName;
          content = mapped;
        }
        // mapped === null -> Bucket A: stay on en-GB, speak token.text, no warning.
      } else {
        console.warn(`buildSentenceSSML: no district_voice_map entry for proper noun "${token.text}"`);
      }
    }

    if (/[.?]$/.test(token.text)) {
      content += '<break time="450ms"/>';
    }

    const last = segments[segments.length - 1];
    if (last && last.voiceName === voiceName) {
      last.content += content;
    } else {
      segments.push({ voiceName, content });
    }
  }

  const body = segments
    .map(
      (seg) =>
        `<voice name="${seg.voiceName}"><prosody rate="${PROSODY_RATE}" pitch="${PROSODY_PITCH}">${seg.content}</prosody></voice>`
    )
    .join('');

  return `<speak version="1.0" xml:lang="en-GB" xmlns="http://www.w3.org/2001/10/synthesis">${body}</speak>`;
}

module.exports = { buildSentenceSSML };
