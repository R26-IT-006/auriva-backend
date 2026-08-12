'use strict';

const logger = require('../utils/logger');

// Literature-informed starting allocation — NOT empirically derived.
// See Tier1_Baseline_Scorer_Formula.md for the direction/rationale behind
// each weight and term. Replace via the calibration step described there
// if/when pursued; do not hand-tune these without updating that doc too.
const WEIGHTS = { speech: 0.35, phoneme: 0.25, echolalia: 0.15, prompt: 0.15, latency: 0.10 };

const MAX_PROMPTS = 3; // matches this system's own non-verbal-fallback trigger threshold
const T_FAST = 0.75;
const T_STRUGGLING = 0.4;
// Both thresholds are placeholders — same caveat as the weights above.

// L_CEILING should be set from real pilot data's own latency distribution
// (e.g. 90th percentile). No real-data-driven value exists yet, so this is
// an explicitly-flagged placeholder ceiling.
// TODO: replace with a value derived from real pilot latency data once available.
const L_CEILING = 8000;

function clip(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isPresent(value) {
  return value !== null && value !== undefined;
}

/**
 * Tier 1 literature-grounded baseline scorer. Pure, deterministic, no
 * network/DB access — the fallback used when Tier 2 (calibrated ML model)
 * is unavailable or below TRAJECTORY_MIN_CONFIDENCE.
 *
 * `features` is the same shape as the feature payload buildSession1Features
 * (or its equivalent) assembles: { speech_score, phoneme_accuracy,
 * echolalia_flag, prompt_count, response_latency_ms_phase2, ... }.
 */
function computeTier1Trajectory(features = {}) {
  const {
    speech_score,
    phoneme_accuracy,
    echolalia_flag,
    prompt_count,
    response_latency_ms_phase2,
  } = features || {};

  const terms = {};

  if (isPresent(speech_score)) {
    terms.speech = clip(speech_score / 3, 0, 1);
  }
  if (isPresent(phoneme_accuracy)) {
    terms.phoneme = clip(phoneme_accuracy, 0, 1);
  }
  if (isPresent(echolalia_flag)) {
    terms.echolalia = echolalia_flag ? 0 : 1;
  }
  if (isPresent(prompt_count)) {
    terms.prompt = clip(1 - (prompt_count - 1) / (MAX_PROMPTS - 1), 0, 1);
  }
  if (isPresent(response_latency_ms_phase2)) {
    terms.latency = clip(1 - response_latency_ms_phase2 / L_CEILING, 0, 1);
  }

  const availableTermKeys = Object.keys(terms);

  if (availableTermKeys.length === 0) {
    logger.warn('computeTier1Trajectory: all terms missing from features payload, defaulting to typical');
    return 'typical';
  }

  const availableWeightTotal = availableTermKeys.reduce((sum, key) => sum + WEIGHTS[key], 0);

  const score = availableTermKeys.reduce((sum, key) => {
    const normalizedWeight = WEIGHTS[key] / availableWeightTotal;
    return sum + normalizedWeight * terms[key];
  }, 0);

  if (score >= T_FAST) return 'fast';
  if (score <= T_STRUGGLING) return 'struggling';
  return 'typical';
}

module.exports = {
  computeTier1Trajectory,
  WEIGHTS,
  MAX_PROMPTS,
  T_FAST,
  T_STRUGGLING,
  L_CEILING,
};
