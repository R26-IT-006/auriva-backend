'use strict';

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const FFT = require('fft.js');

const { WORD_PROFILES } = require('./wordProfiles');

const execFileAsync = promisify(execFile);

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 512;
const HOP_SIZE = 160;
const MEL_FILTER_COUNT = 26;
const MFCC_COUNT = 13;
const PRE_EMPHASIS = 0.97;
const QUALITY_FRAME_SECONDS = 0.02;
const MIN_TOTAL_DURATION_SECONDS = 0.18;
const MIN_VOICED_DURATION_SECONDS = 0.14;
const MIN_VOICED_FRAME_COUNT = 5;
const MIN_PEAK_AMPLITUDE = 0.015;
const MIN_VOICED_RMS = 0.012;
const MIN_SNR_DB = 8;
const MAX_CLIPPING_RATIO = 0.04;
const REFERENCE_AUDIO_DIR = path.resolve(
  __dirname,
  '../../../auriva-frontend/assets/pronounciation-audios'
);

const referenceAnalysisCache = new Map();

class AudioQualityError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AudioQualityError';
    this.code = 'AUDIO_QUALITY_FAILED';
    this.details = details;
  }
}

class ReferenceAudioError extends Error {
  constructor(message, wordId) {
    super(message);
    this.name = 'ReferenceAudioError';
    this.code = 'REFERENCE_AUDIO_NOT_FOUND';
    this.wordId = wordId;
  }
}

function getReferenceAudioPath(wordId) {
  const normalized = String(wordId || '').toLowerCase().trim();
  if (!/^[a-z]+$/.test(normalized)) {
    throw new ReferenceAudioError(`Invalid word id "${wordId}" for reference audio lookup`, wordId);
  }
  return path.join(REFERENCE_AUDIO_DIR, `${normalized}.mp3`);
}

function clampScore(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getInputExtension(mimeType = '') {
  const lower = String(mimeType).toLowerCase();
  if (lower.includes('webm')) return '.webm';
  if (lower.includes('wav')) return '.wav';
  if (lower.includes('mpeg') || lower.includes('mp3')) return '.mp3';
  if (lower.includes('3gpp')) return '.3gp';
  return '.m4a';
}

async function decodeAudioFileToPcm(filePath) {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    filePath,
    '-ac',
    '1',
    '-ar',
    String(SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1',
  ], {
    encoding: 'buffer',
    maxBuffer: 32 * 1024 * 1024,
  });

  const sampleCount = Math.floor(stdout.length / 4);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    samples[i] = stdout.readFloatLE(i * 4);
  }
  return samples;
}

async function decodeBase64AudioToPcm(rawAudioBase64, mimeType) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auriva-mfcc-'));
  const inputPath = path.join(tmpDir, `attempt${getInputExtension(mimeType)}`);

  try {
    await fs.writeFile(inputPath, Buffer.from(rawAudioBase64, 'base64'));
    return await decodeAudioFileToPcm(inputPath);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function rootMeanSquare(samples, start, end) {
  let total = 0;
  const safeEnd = Math.min(end, samples.length);
  for (let i = start; i < safeEnd; i += 1) {
    total += samples[i] * samples[i];
  }
  return Math.sqrt(total / Math.max(1, safeEnd - start));
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))
  );
  return sorted[index];
}

function analyzeAudioQuality(samples) {
  const totalDuration = samples.length / SAMPLE_RATE;
  const frameSize = Math.max(1, Math.floor(SAMPLE_RATE * QUALITY_FRAME_SECONDS));
  const frameStats = [];
  let clippedSamples = 0;
  let maxAbs = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const absolute = Math.abs(samples[index]);
    maxAbs = Math.max(maxAbs, absolute);
    if (absolute >= 0.98) clippedSamples += 1;
  }

  for (let start = 0; start < samples.length; start += frameSize) {
    const end = Math.min(samples.length, start + frameSize);
    frameStats.push(rootMeanSquare(samples, start, end));
  }

  const noiseFloorRms = percentile(frameStats, 0.1);
  const peakFrameRms = percentile(frameStats, 0.95);
  const voiceThreshold = Math.max(0.008, noiseFloorRms * 3.2, peakFrameRms * 0.16);
  const voicedFrames = frameStats.filter((rms) => rms >= voiceThreshold);
  const firstVoicedFrame = frameStats.findIndex((rms) => rms >= voiceThreshold);
  const voicedDuration = voicedFrames.length * QUALITY_FRAME_SECONDS;
  const voicedRms = voicedFrames.length
    ? voicedFrames.reduce((total, rms) => total + rms, 0) / voicedFrames.length
    : 0;
  const snrDb = 20 * Math.log10((voicedRms + 1e-8) / (noiseFloorRms + 1e-8));
  const clippingRatio = samples.length ? clippedSamples / samples.length : 0;
  const silenceRatio = frameStats.length
    ? 1 - voicedFrames.length / frameStats.length
    : 1;
  const failures = [];

  if (totalDuration < MIN_TOTAL_DURATION_SECONDS) {
    failures.push('recording_too_short');
  }
  if (voicedFrames.length < MIN_VOICED_FRAME_COUNT || voicedDuration < MIN_VOICED_DURATION_SECONDS) {
    failures.push('not_enough_speech');
  }
  if (maxAbs < MIN_PEAK_AMPLITUDE || voicedRms < MIN_VOICED_RMS) {
    failures.push('too_quiet');
  }
  if (snrDb < MIN_SNR_DB) {
    failures.push('too_noisy');
  }
  if (clippingRatio > MAX_CLIPPING_RATIO) {
    failures.push('audio_clipping');
  }

  return {
    passed: failures.length === 0,
    failures,
    total_duration: Number(totalDuration.toFixed(3)),
    voiced_duration: Number(voicedDuration.toFixed(3)),
    speech_onset_seconds: firstVoicedFrame >= 0
      ? Number((firstVoicedFrame * QUALITY_FRAME_SECONDS).toFixed(3))
      : null,
    silence_ratio: Number(silenceRatio.toFixed(3)),
    peak_amplitude: Number(maxAbs.toFixed(4)),
    voiced_rms: Number(voicedRms.toFixed(4)),
    noise_floor_rms: Number(noiseFloorRms.toFixed(4)),
    snr_db: Number(snrDb.toFixed(1)),
    clipping_ratio: Number(clippingRatio.toFixed(4)),
    voice_threshold: Number(voiceThreshold.toFixed(4)),
  };
}

function getQualityFailureMessage(failures) {
  if (failures.includes('not_enough_speech') || failures.includes('recording_too_short')) {
    return 'The recording does not contain enough speech to compare. Please record the word again.';
  }
  if (failures.includes('too_quiet')) {
    return 'The recording is too quiet to compare accurately. Please move closer and record again.';
  }
  if (failures.includes('too_noisy')) {
    return 'The recording has too much background noise for accurate scoring. Please record again in a quieter place.';
  }
  if (failures.includes('audio_clipping')) {
    return 'The recording is distorted or too loud. Please record again a little farther from the microphone.';
  }
  return 'The recording quality is not clear enough for accurate scoring. Please record again.';
}

function trimSilence(samples) {
  if (!samples.length) return samples;

  const frame = Math.floor(SAMPLE_RATE * 0.02);
  let maxRms = 0;
  for (let start = 0; start < samples.length; start += frame) {
    maxRms = Math.max(maxRms, rootMeanSquare(samples, start, start + frame));
  }

  const threshold = Math.max(0.008, maxRms * 0.12);
  let first = 0;
  let last = samples.length - 1;

  for (let start = 0; start < samples.length; start += frame) {
    if (rootMeanSquare(samples, start, start + frame) >= threshold) {
      first = Math.max(0, start - frame);
      break;
    }
  }

  for (let start = samples.length - frame; start >= 0; start -= frame) {
    if (rootMeanSquare(samples, start, start + frame) >= threshold) {
      last = Math.min(samples.length - 1, start + frame * 2);
      break;
    }
  }

  return first < last ? samples.slice(first, last + 1) : samples;
}

function normalizeAndPreEmphasize(samples) {
  const trimmed = trimSilence(samples);
  let maxAbs = 0;
  for (const sample of trimmed) {
    maxAbs = Math.max(maxAbs, Math.abs(sample));
  }

  if (maxAbs <= 0) return new Float32Array();

  const normalized = new Float32Array(trimmed.length);
  for (let i = 0; i < trimmed.length; i += 1) {
    const current = trimmed[i] / maxAbs;
    const previous = i > 0 ? trimmed[i - 1] / maxAbs : 0;
    normalized[i] = current - PRE_EMPHASIS * previous;
  }
  return normalized;
}

function getFrameTime(frameIndex) {
  return Number(((frameIndex * HOP_SIZE + FRAME_SIZE / 2) / SAMPLE_RATE).toFixed(3));
}

function createHammingWindow(size) {
  return Array.from({ length: size }, (_, index) =>
    0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (size - 1))
  );
}

const HAMMING_WINDOW = createHammingWindow(FRAME_SIZE);

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (10 ** (mel / 2595) - 1);
}

function createMelFilterBank() {
  const fftBins = Math.floor(FRAME_SIZE / 2) + 1;
  const minMel = hzToMel(0);
  const maxMel = hzToMel(SAMPLE_RATE / 2);
  const melPoints = Array.from({ length: MEL_FILTER_COUNT + 2 }, (_, index) =>
    minMel + (index / (MEL_FILTER_COUNT + 1)) * (maxMel - minMel)
  );
  const binPoints = melPoints.map((mel) =>
    Math.floor(((FRAME_SIZE + 1) * melToHz(mel)) / SAMPLE_RATE)
  );

  return Array.from({ length: MEL_FILTER_COUNT }, (_, filterIndex) => {
    const filter = new Float32Array(fftBins);
    const left = binPoints[filterIndex];
    const center = binPoints[filterIndex + 1];
    const right = binPoints[filterIndex + 2];

    for (let bin = left; bin < center; bin += 1) {
      if (bin >= 0 && bin < fftBins) {
        filter[bin] = (bin - left) / Math.max(1, center - left);
      }
    }
    for (let bin = center; bin < right; bin += 1) {
      if (bin >= 0 && bin < fftBins) {
        filter[bin] = (right - bin) / Math.max(1, right - center);
      }
    }

    return filter;
  });
}

const MEL_FILTER_BANK = createMelFilterBank();

const fftInstance = new FFT(FRAME_SIZE);
const fftOutput = fftInstance.createComplexArray();
const fftInput = new Array(FRAME_SIZE).fill(0);

function powerSpectrum(frame) {
  const bins = Math.floor(FRAME_SIZE / 2) + 1;
  const spectrum = new Float32Array(bins);

  for (let i = 0; i < FRAME_SIZE; i += 1) fftInput[i] = frame[i];
  fftInstance.realTransform(fftOutput, fftInput);
  fftInstance.completeSpectrum(fftOutput);

  for (let k = 0; k < bins; k += 1) {
    const real = fftOutput[2 * k];
    const imaginary = fftOutput[2 * k + 1];
    spectrum[k] = (real * real + imaginary * imaginary) / FRAME_SIZE;
  }

  return spectrum;
}

function applyDct(logEnergies) {
  const coefficients = new Array(MFCC_COUNT).fill(0);
  for (let coefficient = 0; coefficient < MFCC_COUNT; coefficient += 1) {
    let total = 0;
    for (let index = 0; index < logEnergies.length; index += 1) {
      total += logEnergies[index] *
        Math.cos((Math.PI * coefficient * (index + 0.5)) / logEnergies.length);
    }
    coefficients[coefficient] = total;
  }
  return coefficients;
}

const DELTA_WINDOW = 2;
const DELTA_DENOMINATOR = 2 * Array.from({ length: DELTA_WINDOW }, (_, i) => (i + 1) ** 2)
  .reduce((total, value) => total + value, 0);

function computeDeltaCoefficients(frames) {
  if (!frames.length) return frames;

  return frames.map((_, frameIndex) => {
    const delta = new Array(frames[0].length).fill(0);
    for (let n = 1; n <= DELTA_WINDOW; n += 1) {
      const next = frames[Math.min(frames.length - 1, frameIndex + n)];
      const previous = frames[Math.max(0, frameIndex - n)];
      for (let c = 0; c < delta.length; c += 1) {
        delta[c] += (n * (next[c] - previous[c])) / DELTA_DENOMINATOR;
      }
    }
    return delta;
  });
}

function cepstralMeanVarianceNormalize(frames) {
  if (!frames.length) return frames;

  const means = new Array(MFCC_COUNT).fill(0);
  frames.forEach((frame) => {
    frame.forEach((value, index) => {
      means[index] += value;
    });
  });
  for (let i = 0; i < means.length; i += 1) means[i] /= frames.length;

  const variances = new Array(MFCC_COUNT).fill(0);
  frames.forEach((frame) => {
    frame.forEach((value, index) => {
      variances[index] += (value - means[index]) ** 2;
    });
  });
  const deviations = variances.map((variance) =>
    Math.max(1e-4, Math.sqrt(variance / frames.length))
  );

  return frames.map((frame) =>
    frame.map((value, index) => (value - means[index]) / deviations[index])
  );
}

function extractMfccAnalysis(samples) {
  const prepared = normalizeAndPreEmphasize(samples);
  if (prepared.length < FRAME_SIZE) return [];

  const analysis = [];
  for (let start = 0; start + FRAME_SIZE <= prepared.length; start += HOP_SIZE) {
    const frame = new Float32Array(FRAME_SIZE);
    for (let index = 0; index < FRAME_SIZE; index += 1) {
      frame[index] = prepared[start + index] * HAMMING_WINDOW[index];
    }

    const rms = rootMeanSquare(frame, 0, frame.length);
    const spectrum = powerSpectrum(frame);
    const logEnergies = MEL_FILTER_BANK.map((filter) => {
      let energy = 0;
      for (let bin = 0; bin < filter.length; bin += 1) {
        energy += spectrum[bin] * filter[bin];
      }
      return Math.log(Math.max(energy, 1e-10));
    });

    analysis.push({
      mfcc: applyDct(logEnergies),
      rms,
      startTime: Number((start / SAMPLE_RATE).toFixed(3)),
      endTime: Number(((start + FRAME_SIZE) / SAMPLE_RATE).toFixed(3)),
      centerTime: getFrameTime(analysis.length),
    });
  }

  const staticFrames = cepstralMeanVarianceNormalize(analysis.map((entry) => entry.mfcc));
  const deltaFrames = computeDeltaCoefficients(staticFrames);
  const deltaDeltaFrames = computeDeltaCoefficients(deltaFrames);

  return analysis.map((entry, index) => ({
    ...entry,
    mfcc: [
      ...staticFrames[index],
      ...deltaFrames[index],
      ...deltaDeltaFrames[index],
    ],
  }));
}

function extractMfccFrames(samples) {
  return extractMfccAnalysis(samples).map((entry) => entry.mfcc);
}

function frameDistance(a, b) {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let i = 0; i < length; i += 1) {
    const delta = a[i] - b[i];
    total += delta * delta;
  }
  return Math.sqrt(total / Math.max(1, length));
}

function calculateDtw(referenceFrames, attemptFrames) {
  const n = referenceFrames.length;
  const m = attemptFrames.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const parent = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  const window = Math.max(12, Math.abs(n - m) + Math.floor(Math.max(n, m) * 0.18));

  dp[0][0] = 0;
  for (let i = 1; i <= n; i += 1) {
    const minJ = Math.max(1, i - window);
    const maxJ = Math.min(m, i + window);
    for (let j = minJ; j <= maxJ; j += 1) {
      const choices = [
        { value: dp[i - 1][j], parentCode: 1 },
        { value: dp[i][j - 1], parentCode: 2 },
        { value: dp[i - 1][j - 1], parentCode: 3 },
      ].sort((a, b) => a.value - b.value);
      dp[i][j] = frameDistance(referenceFrames[i - 1], attemptFrames[j - 1]) + choices[0].value;
      parent[i][j] = choices[0].parentCode;
    }
  }

  const pathPoints = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    pathPoints.push({ referenceIndex: i - 1, attemptIndex: j - 1 });
    const parentCode = parent[i][j];
    if (parentCode === 3) {
      i -= 1;
      j -= 1;
    } else if (parentCode === 2) {
      j -= 1;
    } else {
      i -= 1;
    }
  }

  const path = pathPoints.reverse();
  const normalizedDistance = dp[n][m] / Math.max(1, path.length);

  return {
    distance: dp[n][m],
    normalizedDistance,
    path,
  };
}

// Provisional constants for CMVN-normalized 39-dim features; Phase 4
// calibration refits both from labeled correct/incorrect attempts.
const DISTANCE_SCORE_MIDPOINT = 0.85;
const DISTANCE_SCORE_SLOPE = 0.18;

function distanceToScore(distance) {
  return clampScore(
    100 / (1 + Math.exp((distance - DISTANCE_SCORE_MIDPOINT) / DISTANCE_SCORE_SLOPE))
  );
}

function getBoundaryPath({ boundary, path }) {
  return path.filter((point) =>
    point.referenceIndex >= boundary.frameStart &&
    point.referenceIndex < boundary.frameEnd
  );
}

function scoreBoundaryPath({ referenceFrames, attemptFrames, boundary, path }) {
  const segmentPath = getBoundaryPath({ boundary, path });
  if (!segmentPath.length) return 0;

  const averageDistance = segmentPath.reduce((total, point) =>
    total + frameDistance(referenceFrames[point.referenceIndex], attemptFrames[point.attemptIndex])
  , 0) / segmentPath.length;

  return distanceToScore(averageDistance);
}

function getTimingScore(referenceDuration, studentDuration) {
  if (!referenceDuration || !studentDuration) return 0;
  const durationRatio = studentDuration / referenceDuration;
  return clampScore(100 * Math.exp(-Math.abs(Math.log(durationRatio)) * 1.2));
}

function framesToBoundary({ phoneme, frameStart, frameEnd }) {
  return {
    phoneme,
    frameStart,
    frameEnd,
    startTime: getFrameTime(frameStart),
    endTime: getFrameTime(Math.max(frameStart, frameEnd - 1)),
  };
}

function resolveTargetPhonemes(wordId, data = {}) {
  const provided = Array.isArray(data.target_phonemes)
    ? data.target_phonemes
      .map((sound) => (typeof sound === 'string' ? sound : sound?.text))
      .filter(Boolean)
    : [];
  if (provided.length) return provided;
  return WORD_PROFILES[wordId]?.sounds || [];
}

function smoothValues(values, radius = 2) {
  return values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length - 1, index + radius);
    let total = 0;
    for (let i = start; i <= end; i += 1) total += values[i];
    return total / (end - start + 1);
  });
}

function normalizeValues(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (range <= 0) return values.map(() => 0);
  return values.map((value) => (value - min) / range);
}

function getBoundaryStrengths(referenceAnalysis) {
  const flux = referenceAnalysis.map((entry, index) =>
    index === 0 ? 0 : frameDistance(entry.mfcc, referenceAnalysis[index - 1].mfcc)
  );
  const smoothedFlux = normalizeValues(smoothValues(flux));
  const smoothedEnergy = normalizeValues(smoothValues(referenceAnalysis.map((entry) => entry.rms)));

  // Phoneme transitions show high spectral change (flux peak) and low energy (valley).
  return referenceAnalysis.map(
    (_, index) => smoothedFlux[index] * 0.65 + (1 - smoothedEnergy[index]) * 0.35
  );
}

function proportionalCuts(frameCount, segmentCount) {
  return Array.from({ length: segmentCount - 1 }, (_, index) =>
    Math.round(((index + 1) * frameCount) / segmentCount)
  );
}

function detectReferenceBoundaries(referenceAnalysis, phonemes) {
  const frameCount = referenceAnalysis.length;
  const segmentCount = phonemes.length;
  if (!segmentCount || frameCount < 3) return [];

  if (segmentCount === 1) {
    return [framesToBoundary({ phoneme: phonemes[0], frameStart: 0, frameEnd: frameCount })];
  }

  const minSegmentFrames = Math.max(2, Math.floor(frameCount / (segmentCount * 3)));
  const cuts = frameCount < segmentCount * 2
    ? proportionalCuts(frameCount, segmentCount)
    : (() => {
      const strengths = getBoundaryStrengths(referenceAnalysis);
      const searchRadius = Math.max(2, Math.round(frameCount * 0.12));
      const snapped = [];
      let previousCut = 0;

      for (let k = 1; k < segmentCount; k += 1) {
        const target = Math.round((k * frameCount) / segmentCount);
        const minCut = previousCut + minSegmentFrames;
        const maxCut = frameCount - (segmentCount - k) * minSegmentFrames;
        const searchStart = Math.max(minCut, target - searchRadius);
        const searchEnd = Math.min(maxCut, target + searchRadius);
        let cut = Math.max(minCut, Math.min(maxCut, target));

        if (searchStart <= searchEnd) {
          let bestStrength = -Infinity;
          for (let index = searchStart; index <= searchEnd; index += 1) {
            if (strengths[index] > bestStrength) {
              bestStrength = strengths[index];
              cut = index;
            }
          }
        }

        snapped.push(cut);
        previousCut = cut;
      }

      return snapped;
    })();

  const edges = [0, ...cuts, frameCount];
  return phonemes.map((phoneme, index) =>
    framesToBoundary({
      phoneme,
      frameStart: edges[index],
      frameEnd: Math.max(edges[index] + 1, edges[index + 1]),
    })
  );
}

function mapBoundaryToAttempt({ boundary, path, attemptFrameCount }) {
  const segmentPath = getBoundaryPath({ boundary, path });
  const attemptIndexes = segmentPath.map((point) => point.attemptIndex);

  if (!attemptIndexes.length) {
    const nearest = path
      .slice()
      .sort((a, b) =>
        Math.abs(a.referenceIndex - boundary.frameStart) -
        Math.abs(b.referenceIndex - boundary.frameStart)
      )[0];
    const fallbackIndex = nearest?.attemptIndex ?? 0;
    return {
      frameStart: fallbackIndex,
      frameEnd: Math.min(attemptFrameCount, fallbackIndex + 1),
      startTime: getFrameTime(fallbackIndex),
      endTime: getFrameTime(fallbackIndex),
    };
  }

  const frameStart = Math.max(0, Math.min(...attemptIndexes));
  const frameEnd = Math.min(attemptFrameCount, Math.max(...attemptIndexes) + 1);

  return {
    frameStart,
    frameEnd,
    startTime: getFrameTime(frameStart),
    endTime: getFrameTime(Math.max(frameStart, frameEnd - 1)),
  };
}

function buildPhonemeBoundaryAlignment({ phonemes, referenceAnalysis, attemptAnalysis, path }) {
  const referenceFrames = referenceAnalysis.map((entry) => entry.mfcc);
  const attemptFrames = attemptAnalysis.map((entry) => entry.mfcc);
  const referenceBoundaries = detectReferenceBoundaries(referenceAnalysis, phonemes);

  return referenceBoundaries.map((boundary) => {
    const studentBoundary = mapBoundaryToAttempt({
      boundary,
      path,
      attemptFrameCount: attemptFrames.length,
    });
    const referenceDuration = Math.max(0.01, boundary.endTime - boundary.startTime);
    const studentDuration = Math.max(0.01, studentBoundary.endTime - studentBoundary.startTime);
    const similarityScore = scoreBoundaryPath({
      referenceFrames,
      attemptFrames,
      boundary,
      path,
    });
    const timingScore = getTimingScore(referenceDuration, studentDuration);

    return {
      phoneme: boundary.phoneme,
      reference_start: boundary.startTime,
      reference_end: boundary.endTime,
      student_start: studentBoundary.startTime,
      student_end: studentBoundary.endTime,
      reference_duration: Number(referenceDuration.toFixed(3)),
      student_duration: Number(studentDuration.toFixed(3)),
      duration_ratio: Number((studentDuration / referenceDuration).toFixed(2)),
      similarity_score: similarityScore,
      // Timing is reported as an observation only. ASD speech commonly shows
      // atypical rate and prosody, so duration never lowers the accuracy score.
      timing_score: timingScore,
      score: similarityScore,
    };
  });
}

async function getReferenceAnalysis(wordId) {
  const normalized = String(wordId || '').toLowerCase().trim();
  if (referenceAnalysisCache.has(normalized)) {
    return referenceAnalysisCache.get(normalized);
  }

  const referencePath = getReferenceAudioPath(normalized);
  try {
    await fs.access(referencePath);
  } catch {
    throw new ReferenceAudioError(
      `No reference audio found for word "${normalized}"`,
      normalized
    );
  }

  const samples = await decodeAudioFileToPcm(referencePath);
  const analysis = extractMfccAnalysis(samples);
  referenceAnalysisCache.set(normalized, analysis);
  return analysis;
}

async function scoreWordPronunciationAttempt(data) {
  if (!data.raw_audio_base64) {
    throw new Error('MFCC-DTW scoring requires raw_audio_base64');
  }

  const wordId = String(data.word_id || '').toLowerCase().trim();
  const phonemes = resolveTargetPhonemes(wordId, data);
  const [referenceAnalysis, attemptSamples] = await Promise.all([
    getReferenceAnalysis(wordId),
    decodeBase64AudioToPcm(data.raw_audio_base64, data.raw_audio_mime_type),
  ]);
  const quality = analyzeAudioQuality(attemptSamples);
  if (!quality.passed) {
    throw new AudioQualityError(getQualityFailureMessage(quality.failures), quality);
  }

  const referenceFrames = referenceAnalysis.map((entry) => entry.mfcc);
  const attemptAnalysis = extractMfccAnalysis(attemptSamples);
  const attemptFrames = attemptAnalysis.map((entry) => entry.mfcc);

  if (referenceFrames.length < 3 || attemptFrames.length < 3) {
    throw new Error('Not enough voiced audio frames for MFCC-DTW scoring');
  }

  const dtw = calculateDtw(referenceFrames, attemptFrames);
  const phonemeAlignment = buildPhonemeBoundaryAlignment({
    phonemes,
    referenceAnalysis,
    attemptAnalysis,
    path: dtw.path,
  });
  const segmentScores = phonemeAlignment.map((entry) => entry.score);
  const referenceDuration = referenceFrames.length * (HOP_SIZE / SAMPLE_RATE);
  const attemptDuration = attemptFrames.length * (HOP_SIZE / SAMPLE_RATE);
  const segmentalAccuracy = distanceToScore(dtw.normalizedDistance);

  return {
    overall_score: segmentalAccuracy,
    segmental_accuracy: segmentalAccuracy,
    timing_observation: {
      informational_only: true,
      speech_onset_seconds: quality.speech_onset_seconds,
      reference_duration: Number(referenceDuration.toFixed(3)),
      attempt_duration: Number(attemptDuration.toFixed(3)),
      duration_ratio: Number((attemptDuration / Math.max(0.01, referenceDuration)).toFixed(2)),
      timing_score: getTimingScore(referenceDuration, attemptDuration),
      per_phoneme: phonemeAlignment.map((entry) => ({
        phoneme: entry.phoneme,
        duration_ratio: entry.duration_ratio,
        timing_score: entry.timing_score,
      })),
    },
    dtw_distance: Number(dtw.normalizedDistance.toFixed(4)),
    segment_scores: segmentScores,
    phoneme_boundary_alignment: phonemeAlignment,
    audio_quality: quality,
    scoring_method: 'mfcc_dtw_v2',
    reference_word_id: wordId,
    mfcc_config: {
      sample_rate: SAMPLE_RATE,
      frame_size: FRAME_SIZE,
      hop_size: HOP_SIZE,
      mfcc_count: MFCC_COUNT,
      mel_filter_count: MEL_FILTER_COUNT,
      features: 'mfcc+delta+delta2',
      normalization: 'cmvn',
      feature_dimension: MFCC_COUNT * 3,
      delta_window: DELTA_WINDOW,
      reference_frames: referenceFrames.length,
      attempt_frames: attemptFrames.length,
    },
  };
}

module.exports = {
  scoreWordPronunciationAttempt,
  getReferenceAnalysis,
  extractMfccFrames,
  extractMfccAnalysis,
  calculateDtw,
  analyzeAudioQuality,
  AudioQualityError,
  ReferenceAudioError,
};
