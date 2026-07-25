'use strict';

const ffmpegPath = require('ffmpeg-static');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

const { PassThrough } = require('stream');

/**
 * Transcodes an audio buffer (any container ffmpeg can read — m4a, mp4,
 * webm, ogg) to LINEAR16 PCM WAV at 16kHz mono, matching what Google Cloud
 * STT expects for the 'LINEAR16' encoding.
 *
 * @param {Buffer} inputBuffer  Raw audio bytes as received from the client.
 * @param {string} inputFormat  ffmpeg input format hint, e.g. 'mp4' for m4a,
 *                              'webm' for web recordings, 'ogg' for ogg.
 * @returns {Promise<Buffer>}  WAV (LINEAR16, 16kHz, mono) audio buffer.
 */
function transcodeToLinear16(inputBuffer, inputFormat) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const input = new PassThrough();
    input.end(inputBuffer);

    ffmpeg(input)
      .inputFormat(inputFormat)
      .audioCodec('pcm_s16le')
      .audioFrequency(16000)
      .audioChannels(1)
      .format('wav')
      .on('error', reject)
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe()
      .on('data', (chunk) => chunks.push(chunk))
      .on('error', reject);
  });
}

module.exports = { transcodeToLinear16 };
