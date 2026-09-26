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

// TASK-43: the feature-payload field each scoring term is derived from, for the
// teacher-facing explanation. Declaration order here is also the order terms are
// inserted below, which the weighted sum depends on — see buildTerms().
const TERM_INPUTS = {
  speech:    'speech_score',
  phoneme:   'phoneme_accuracy',
  echolalia: 'echolalia_flag',
  prompt:    'prompt_count',
  latency:   'response_latency_ms_phase2',
};

/**
 * Normalizes the present terms to 0-1. Extracted from computeTier1Trajectory
 * (TASK-43) so explainTier1 decomposes exactly the same arithmetic rather than
 * a second copy of it that could drift.
 *
 * Insertion order is load-bearing: the weighted sum below reduces over
 * Object.keys(terms), and floating-point addition is not associative, so
 * reordering these blocks could shift a borderline score across a threshold.
 * Keep them in the original speech → phoneme → echolalia → prompt → latency
 * order.
 */
function buildTerms(features = {}) {
  const {
    speech_score,
    phoneme_accuracy,
    echolalia_flag,
    prompt_count,
    response_latency_ms_phase2,
    match_type,
  } = features || {};

  const terms = {};

  if (isPresent(speech_score)) {
    // Non-verbal speech_score is a binary correct/incorrect signal (max 1),
    // not a compressed version of the verbal 0-3 scale — dialogueService.js
    // draws the same distinction for its own pass threshold. Dividing by 3
    // would score a fully-correct non-verbal answer as only 33%.
    terms.speech = match_type === 'non_verbal'
      ? clip(speech_score, 0, 1)
      : clip(speech_score / 3, 0, 1);
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

  return terms;
}

/** The one place the thresholds turn a score into a label. */
function labelForScore(score) {
  if (score >= T_FAST) return 'fast';
  if (score <= T_STRUGGLING) return 'struggling';
  return 'typical';
}

/**
 * Tier 1 literature-grounded baseline scorer. Pure, deterministic, no
 * network/DB access — the fallback used when Tier 2 (calibrated ML model)
 * is unavailable or below TRAJECTORY_MIN_CONFIDENCE.
 *
 * `features` is the same shape as the feature payload buildSession1Features
 * (or its equivalent) assembles: { speech_score, phoneme_accuracy,
 * echolalia_flag, prompt_count, response_latency_ms_phase2, match_type, ... }.
 */
function computeTier1Trajectory(features = {}) {
  const terms = buildTerms(features);

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

  return labelForScore(score);
}

/**
 * TASK-43 — the exact additive decomposition of the Tier 1 score.
 *
 * `normalizedWeight * termValue` per term IS the attribution: the
 * contributions sum to the score by construction, so no post-hoc method
 * (SHAP, LIME) is applicable or needed here.
 *
 * `absentTerms` is not incidental. Weight renormalization means a term that is
 * missing from the payload silently redistributes its weight across the terms
 * that remain — a teacher reading the report has to be able to see that
 * happened, and which term it was.
 *
 * Read-only: this never influences what computeTier1Trajectory returns.
 */
function explainTier1(features = {}) {
  const terms = buildTerms(features);
  const availableTermKeys = Object.keys(terms);

  const absentTerms = Object.keys(TERM_INPUTS).filter((key) => !(key in terms));
  const thresholds = { fast: T_FAST, struggling: T_STRUGGLING };

  // Same degenerate case computeTier1Trajectory short-circuits: no terms, so no
  // score was ever computed. 'typical' here is a default, not a finding.
  if (availableTermKeys.length === 0) {
    return {
      terms: [],
      absentTerms,
      score: null,
      thresholds,
      label: 'typical',
      scored: false,
    };
  }

  const availableWeightTotal = availableTermKeys.reduce((sum, key) => sum + WEIGHTS[key], 0);

  const score = availableTermKeys.reduce((sum, key) => {
    const normalizedWeight = WEIGHTS[key] / availableWeightTotal;
    return sum + normalizedWeight * terms[key];
  }, 0);

  const breakdown = availableTermKeys.map((key) => {
    const renormalizedWeight = WEIGHTS[key] / availableWeightTotal;
    return {
      term:                key,
      input:               TERM_INPUTS[key],
      rawValue:            (features || {})[TERM_INPUTS[key]],
      normalizedValue:     terms[key],
      weight:              WEIGHTS[key],
      renormalizedWeight,
      contribution:        renormalizedWeight * terms[key],
    };
  });

  return {
    terms: breakdown,
    absentTerms,
    score,
    thresholds,
    label: labelForScore(score),
    scored: true,
  };
}

module.exports = {
  computeTier1Trajectory,
  explainTier1,
  WEIGHTS,
  TERM_INPUTS,
  MAX_PROMPTS,
  T_FAST,
  T_STRUGGLING,
  L_CEILING,
};
