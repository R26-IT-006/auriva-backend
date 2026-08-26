'use strict';

// Mock all external dependencies before requiring the service under test.
jest.mock('axios');
jest.mock('../tier1Scorer', () => ({
  computeTier1Trajectory: jest.fn(),
  // TASK-43 — additive; no existing test touches it, so every assertion below
  // this line behaves exactly as it did before.
  explainTier1: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

// getTrajectoryReport lazily requires category3Service for the authoritative
// list of abilities words still being taught. Mocked to just that list so this
// stays a unit test — loading the real service would drag in the speech
// assessment stack (and its open handles) for one constant.
jest.mock('../category3Service', () => ({
  CAT3_ASSET_ORDER: [
    'cat3_yes', 'cat3_no',
    'clap', 'run', 'walk', 'jump', 'talk', 'dance', 'sing',
    'brush', 'wash', 'eat', 'drink', 'write', 'play', 'sleep', 'watch',
  ],
}));

// Mock Sequelize models — the service imports them as named exports from '../models'
// (resolves to src/models from the service's perspective, src/models from test's
// perspective via ../../models).
jest.mock('../../models', () => ({
  // findAll added for TASK-43's batch trajectory report; findByPk is unchanged.
  DialogueWord: { findByPk: jest.fn(), findAll: jest.fn() },
  DialogueWordProgress: { findOne: jest.fn() },
  DialogueWordAttempt: { findOne: jest.fn() },
  DialoguePhase3Attempt: { findOne: jest.fn() },
  ActionWordAttempt: { findOne: jest.fn() },
}));

// Sequelize Op is only used inside buildSession1Features for { [Op.ne]: null }.
// Mock sequelize so the service can destructure Op.
jest.mock('sequelize', () => {
  const actual = jest.requireActual('sequelize');
  return actual;
});

const axios = require('axios');
const { Op } = require('sequelize');
const { computeTier1Trajectory, explainTier1 } = require('../tier1Scorer');
const logger = require('../../utils/logger');
const {
  DialogueWord,
  DialogueWordProgress,
  DialogueWordAttempt,
  DialoguePhase3Attempt,
  ActionWordAttempt,
} = require('../../models');

// Import the service AFTER mocks are set up.
const {
  getTrajectoryPrediction,
  getTrajectoryExplanation,
  getTrajectoryReport,
} = require('../trajectoryService');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a mock Sequelize row with a .get({ plain:true }) method. */
function mockRow(data) {
  return { get: () => data };
}

/** Primes the DB mocks with valid data so buildSession1Features succeeds. */
function primeValidDbMocks() {
  DialogueWord.findByPk.mockResolvedValue({ difficulty: 2, category: 'greetings' });

  // phase1_exposure_ratio_snapshot (written once at Phase 1 gate pass, never overwritten)
  DialogueWordProgress.findOne.mockResolvedValue({
    phase1_exposure_ratio_snapshot: 0.75,
  });

  // Phase 2 query — prompt_count was removed from this table's query after bug fix
  DialogueWordAttempt.findOne.mockResolvedValue(
    mockRow({
      speech_score: 2,
      phoneme_accuracy: 0.75,
      phoneme_error_class: 'substitution',
      response_latency_ms: 1200,
      echolalia_flag: false,
    })
  );

  // Phase 3 query — prompt_count now lives here (bug fix 2026-08-13)
  DialoguePhase3Attempt.findOne.mockResolvedValue(
    mockRow({
      response_latency_ms: 1800,
      first_tap_correct: true,
      selection_change_count: 0,
      prompt_count: 1,
    })
  );
}

/** Primes the DB mocks for a non-verbal (image-selection) attempt. */
function primeNonVerbalDbMocks({ speechScore = 1 } = {}) {
  DialogueWord.findByPk.mockResolvedValue({ difficulty: 2, category: 'greetings' });

  DialogueWordProgress.findOne.mockResolvedValue({
    phase1_exposure_ratio_snapshot: 0.75,
  });

  // recordNonVerbalResult never writes phoneme_accuracy / response_latency_ms —
  // they stay null. echolalia_flag defaults to false at the DB level.
  DialogueWordAttempt.findOne.mockResolvedValue(
    mockRow({
      speech_score: speechScore,
      phoneme_accuracy: null,
      phoneme_error_class: null,
      response_latency_ms: null,
      echolalia_flag: false,
      match_type: 'non_verbal',
    })
  );

  DialoguePhase3Attempt.findOne.mockResolvedValue(
    mockRow({
      response_latency_ms: 1800,
      first_tap_correct: true,
      selection_change_count: 0,
      prompt_count: 1,
    })
  );
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
  // Default: kill switch OFF
  delete process.env.TRAJECTORY_ML_ENABLED;
  delete process.env.MICROSERVICE_URL;
  delete process.env.TRAJECTORY_MIN_CONFIDENCE;
});

// ---------------------------------------------------------------------------
// AC1 (implied): smoke test that the module loads and exports correctly
// ---------------------------------------------------------------------------

describe('module export', () => {
  it('exports getTrajectoryPrediction as a function', () => {
    expect(typeof getTrajectoryPrediction).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// AC2: TRAJECTORY_ML_ENABLED false or unset → always returns 'typical',
//      no HTTP call attempted
// ---------------------------------------------------------------------------

describe('AC2 — kill switch', () => {
  it('returns "typical" when TRAJECTORY_ML_ENABLED is unset', async () => {
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('typical');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns "typical" when TRAJECTORY_ML_ENABLED is "false"', async () => {
    process.env.TRAJECTORY_ML_ENABLED = 'false';
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('typical');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('returns "typical" when TRAJECTORY_ML_ENABLED is "0"', async () => {
    process.env.TRAJECTORY_ML_ENABLED = '0';
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('typical');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('does not invoke Tier 1 scorer when kill switch is off', async () => {
    delete process.env.TRAJECTORY_ML_ENABLED;
    await getTrajectoryPrediction(1, 10);
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC3: microservice timeout/failure → Tier 1 invoked, no thrown error
// ---------------------------------------------------------------------------

describe('AC3 — microservice failure falls through to Tier 1', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeValidDbMocks();
    computeTier1Trajectory.mockReturnValue('struggling');
  });

  it('does not throw when axios throws (timeout / network error)', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(getTrajectoryPrediction(1, 10)).resolves.toBeDefined();
  });

  it('returns Tier 1 result when microservice throws', async () => {
    axios.post.mockRejectedValue(new Error('timeout of 2000ms exceeded'));
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('struggling');
    expect(computeTier1Trajectory).toHaveBeenCalledTimes(1);
  });

  it('logs a warning when the microservice call fails', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    await getTrajectoryPrediction(1, 10);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[trajectoryService]'),
      expect.any(String)
    );
  });

  it('invokes Tier 1 with the assembled feature payload', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    await getTrajectoryPrediction(1, 10);
    const callArg = computeTier1Trajectory.mock.calls[0][0];
    // Confirm key features are present in the payload passed to Tier 1
    expect(callArg).toMatchObject({
      speech_score: 2,
      phoneme_accuracy: 0.75,
      phase1_applicable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// AC4: low-confidence response → Tier 1 invoked, Tier 2 value NOT returned
// ---------------------------------------------------------------------------

describe('AC4 — low-confidence Tier 2 response falls through to Tier 1', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeValidDbMocks();
    computeTier1Trajectory.mockReturnValue('typical');
  });

  it('does not return Tier 2 trajectory when confidence is below threshold', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { trajectory: 'fast', confidence: 0.3 },
    });
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).not.toBe('fast');
  });

  it('invokes Tier 1 when confidence is below threshold', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { trajectory: 'fast', confidence: 0.49 },
    });
    await getTrajectoryPrediction(1, 10);
    expect(computeTier1Trajectory).toHaveBeenCalledTimes(1);
  });

  it('returns Tier 1 result when confidence is exactly at threshold boundary (below)', async () => {
    // confidence 0.49 < 0.5 threshold → Tier 1
    axios.post.mockResolvedValue({
      status: 200,
      data: { trajectory: 'fast', confidence: 0.49 },
    });
    computeTier1Trajectory.mockReturnValue('struggling');
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('struggling');
  });

  it('falls through to Tier 1 when microservice returns non-200 status', async () => {
    axios.post.mockResolvedValue({
      status: 503,
      data: {},
    });
    await getTrajectoryPrediction(1, 10);
    expect(computeTier1Trajectory).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// AC5: high-confidence response → Tier 2 value returned, Tier 1 NOT invoked
// ---------------------------------------------------------------------------

describe('AC5 — high-confidence Tier 2 response is returned directly', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeValidDbMocks();
  });

  it('returns Tier 2 trajectory when confidence meets threshold', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { trajectory: 'fast', confidence: 0.9 },
    });
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('fast');
  });

  it('does NOT invoke Tier 1 scorer when Tier 2 confidence meets threshold', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      data: { trajectory: 'struggling', confidence: 0.8 },
    });
    await getTrajectoryPrediction(1, 10);
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
  });

  it('returns Tier 2 trajectory at exactly the threshold (>=)', async () => {
    // confidence 0.5 === 0.5 threshold → Tier 2
    axios.post.mockResolvedValue({
      status: 200,
      data: { trajectory: 'fast', confidence: 0.5 },
    });
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('fast');
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
  });

  it('returns Tier 2 trajectory with a custom TRAJECTORY_MIN_CONFIDENCE', async () => {
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.7';
    axios.post.mockResolvedValue({
      status: 200,
      data: { trajectory: 'typical', confidence: 0.75 },
    });
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('typical');
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// phoneme_error_class null handling — 2026-08-15 fix. NULL is the common
// real-world case (no error to classify: exact/keyword match short-circuits
// before RC1 ever runs, or RC1 ran and found no error). Previously this was
// treated as a fatal missing-feature and buildSession1Features() returned
// null, so getTrajectoryPrediction() bailed out to hardcoded 'typical' —
// Tier 1 and Tier 2 never ran at all for the majority of real rows. Now
// substituted with the literal string 'none', matching the synthetic
// training data's own convention (generate_synthetic_training_set.py never
// writes a raw null here), so the feature stays in-distribution for the
// Tier 2 microservice's get_dummies encoding and no longer blocks assembly.
// ---------------------------------------------------------------------------

describe('phoneme_error_class null handling', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
  });

  function primeDbMocksWithPhonemeErrorClass(value) {
    DialogueWord.findByPk.mockResolvedValue({ difficulty: 2, category: 'greetings' });
    DialogueWordProgress.findOne.mockResolvedValue({ phase1_exposure_ratio_snapshot: 0.75 });
    DialogueWordAttempt.findOne.mockResolvedValue(
      mockRow({
        speech_score: 3,
        phoneme_accuracy: 1.0,
        phoneme_error_class: value,
        response_latency_ms: 1200,
        echolalia_flag: false,
      })
    );
    DialoguePhase3Attempt.findOne.mockResolvedValue(
      mockRow({
        response_latency_ms: 1800,
        first_tap_correct: true,
        selection_change_count: 0,
        prompt_count: 1,
      })
    );
  }

  it('does not bail out to "typical" when phoneme_error_class is null', async () => {
    primeDbMocksWithPhonemeErrorClass(null);
    axios.post.mockRejectedValue(new Error('ECONNREFUSED')); // force the Tier 1 path
    computeTier1Trajectory.mockReturnValue('fast');
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('fast');
    expect(computeTier1Trajectory).toHaveBeenCalledTimes(1);
  });

  it('substitutes the literal string "none" for a null phoneme_error_class (Tier 1 payload)', async () => {
    primeDbMocksWithPhonemeErrorClass(null);
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    computeTier1Trajectory.mockReturnValue('typical');
    await getTrajectoryPrediction(1, 10);
    const callArg = computeTier1Trajectory.mock.calls[0][0];
    expect(callArg.phoneme_error_class).toBe('none');
  });

  it('sends the substituted "none" in the Tier 2 microservice payload too', async () => {
    primeDbMocksWithPhonemeErrorClass(null);
    axios.post.mockResolvedValue({ status: 200, data: { trajectory: 'fast', confidence: 0.9 } });
    await getTrajectoryPrediction(1, 10);
    const postBody = axios.post.mock.calls[0][1];
    expect(postBody.phoneme_error_class).toBe('none');
  });

  it('passes through a real (non-null) phoneme_error_class value unchanged', async () => {
    primeDbMocksWithPhonemeErrorClass('r_deletion');
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    computeTier1Trajectory.mockReturnValue('typical');
    await getTrajectoryPrediction(1, 10);
    const callArg = computeTier1Trajectory.mock.calls[0][0];
    expect(callArg.phoneme_error_class).toBe('r_deletion');
  });
});

// ---------------------------------------------------------------------------
// AC6: non-verbal attempts (match_type='non_verbal') skip Tier 2 entirely
// and go straight to Tier 1 — the ML model has never seen a non-verbal
// training row, so Tier 2 is not a safe fallback for these.
// ---------------------------------------------------------------------------

describe('AC6 — non-verbal attempts bypass Tier 2, go straight to Tier 1', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeNonVerbalDbMocks();
    computeTier1Trajectory.mockReturnValue('typical');
  });

  it('does not call the Tier 2 microservice for a non-verbal attempt', async () => {
    await getTrajectoryPrediction(1, 10);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('calls Tier 1 exactly once with match_type intact and the null verbal fields visible', async () => {
    await getTrajectoryPrediction(1, 10);
    expect(computeTier1Trajectory).toHaveBeenCalledTimes(1);
    const callArg = computeTier1Trajectory.mock.calls[0][0];
    expect(callArg).toMatchObject({
      speech_score: 1,
      match_type: 'non_verbal',
      phoneme_accuracy: null,
      response_latency_ms_phase2: null,
      echolalia_flag: false,
    });
  });

  it('still includes prompt_count sourced from Phase 3 in the non-verbal payload', async () => {
    await getTrajectoryPrediction(1, 10);
    const callArg = computeTier1Trajectory.mock.calls[0][0];
    expect(callArg.prompt_count).toBe(1);
  });

  it('returns the Tier 1 result directly', async () => {
    computeTier1Trajectory.mockReturnValue('fast');
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('fast');
  });

  it('falls back to "typical" without calling Tier 1 when even speech_score is missing (malformed row)', async () => {
    DialogueWordAttempt.findOne.mockResolvedValue(
      mockRow({
        speech_score: null,
        phoneme_accuracy: null,
        phoneme_error_class: null,
        response_latency_ms: null,
        echolalia_flag: false,
        match_type: 'non_verbal',
      })
    );
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('typical');
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC7: abilities-category words read Phase 1/2 features from the correct
// tables (ActionWordAttempt, no DialogueWordProgress.phase1_exposure_ratio_snapshot
// requirement) instead of always failing assembly and defaulting to
// 'typical'. 2026-08-16 fix — category3Service.js has called
// getTrajectoryPrediction() since TASK-38, but buildSession1Features() only
// ever read the greetings/magic_words tables, so every abilities prediction
// silently returned 'typical' regardless of the child's actual trajectory.
// ---------------------------------------------------------------------------

function primeAbilitiesDbMocks({ speechScore = 3, matchType = 'exact' } = {}) {
  DialogueWord.findByPk.mockResolvedValue({ difficulty: 1, category: 'abilities' });

  ActionWordAttempt.findOne.mockResolvedValue(
    mockRow({
      phase2_speech_score:        speechScore,
      phase2_phoneme_accuracy:    matchType === 'non_verbal' ? null : 0.8,
      phase2_phoneme_error_class: null,
      phase2_response_latency_ms: matchType === 'non_verbal' ? null : 1000,
      phase2_echolalia_flag:      false,
      phase2_match_type:          matchType,
    })
  );

  DialoguePhase3Attempt.findOne.mockResolvedValue(
    mockRow({
      response_latency_ms:    1500,
      first_tap_correct:      true,
      selection_change_count: 0,
      prompt_count:            1,
    })
  );
}

describe('AC7 — abilities words read Phase 1/2 features from the correct tables', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeAbilitiesDbMocks();
    computeTier1Trajectory.mockReturnValue('typical');
  });

  it('reads Phase 2 data from ActionWordAttempt, not DialogueWordAttempt', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED')); // force Tier 1 path
    await getTrajectoryPrediction(1, 10);
    expect(ActionWordAttempt.findOne).toHaveBeenCalledTimes(1);
    expect(DialogueWordAttempt.findOne).not.toHaveBeenCalled();
  });

  it('does not query DialogueWordProgress for abilities words (no Phase 1 exposure concept)', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    await getTrajectoryPrediction(1, 10);
    expect(DialogueWordProgress.findOne).not.toHaveBeenCalled();
  });

  it('assembles phase1_applicable=false and the -1.0 sentinel for abilities words', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    await getTrajectoryPrediction(1, 10);
    const callArg = computeTier1Trajectory.mock.calls[0][0];
    expect(callArg).toMatchObject({
      phase1_applicable:    false,
      phase1_exposure_ratio: -1.0,
      category:              'abilities',
    });
  });

  it('no longer bails out to "typical" for an abilities word with real data — Tier 1 actually runs', async () => {
    axios.post.mockRejectedValue(new Error('ECONNREFUSED'));
    computeTier1Trajectory.mockReturnValue('fast');
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('fast');
    expect(computeTier1Trajectory).toHaveBeenCalledTimes(1);
  });

  it('still reaches Tier 2 for a normal (non-non-verbal) abilities attempt', async () => {
    axios.post.mockResolvedValue({ status: 200, data: { trajectory: 'fast', confidence: 0.9 } });
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('fast');
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('skips Tier 2 for a non-verbal abilities attempt (recordPhase2NonVerbal), same as the generic non-verbal path', async () => {
    primeAbilitiesDbMocks({ speechScore: 1, matchType: 'non_verbal' });
    await getTrajectoryPrediction(1, 10);
    expect(axios.post).not.toHaveBeenCalled();
    expect(computeTier1Trajectory).toHaveBeenCalledTimes(1);
    const callArg = computeTier1Trajectory.mock.calls[0][0];
    expect(callArg.match_type).toBe('non_verbal');
  });

  it('falls back to "typical" without calling Tier 1 when an abilities row has no speech_score (malformed)', async () => {
    ActionWordAttempt.findOne.mockResolvedValue(
      mockRow({
        phase2_speech_score:        null,
        phase2_phoneme_accuracy:    null,
        phase2_phoneme_error_class: null,
        phase2_response_latency_ms: null,
        phase2_echolalia_flag:      false,
        phase2_match_type:          'exact',
      })
    );
    const result = await getTrajectoryPrediction(1, 10);
    expect(result).toBe('typical');
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// TASK-43 — getTrajectoryExplanation / getTrajectoryReport
//
// Read-and-explain surface only. The invariant running through every test
// below: adding an explanation must never change which trajectory, or which
// tier, would have been produced without it.
// ===========================================================================

/** Routes axios.post by URL so the prediction and explanation calls can be
 *  primed (and asserted) independently — AC8 turns on exactly that. */
function primeMicroservice({ predict, explain }) {
  axios.post.mockImplementation(async (url) => {
    if (url.endsWith('/predict-trajectory')) {
      if (predict instanceof Error) throw predict;
      return predict;
    }
    if (url.endsWith('/explain-trajectory')) {
      if (explain instanceof Error) throw explain;
      return explain;
    }
    throw new Error(`unexpected URL: ${url}`);
  });
}

const explainUrls = () =>
  axios.post.mock.calls.filter(([url]) => url.endsWith('/explain-trajectory'));

const TIER1_EXPLANATION = {
  terms: [{ term: 'speech', input: 'speech_score', rawValue: 2, normalizedValue: 2 / 3, weight: 0.35, renormalizedWeight: 0.35, contribution: 0.2333 }],
  absentTerms: [],
  score: 0.62,
  thresholds: { fast: 0.75, struggling: 0.4 },
  label: 'typical',
  scored: true,
};

const SHAP_EXPLANATION = {
  trajectory: 'struggling',
  confidence: 0.9,
  base_value: 0.333,
  attributions: [
    { feature: 'prompt_count', value: 3, contribution: 0.18 },
    { feature: 'phoneme_accuracy', value: 0.05, contribution: 0.11 },
  ],
};

describe('AC6 — kill switch off yields tier "disabled" and no microservice call', () => {
  it('returns disabled with no explanation when TRAJECTORY_ML_ENABLED is unset', async () => {
    const result = await getTrajectoryExplanation(1, 10);
    expect(result).toMatchObject({
      trajectory:  'typical',
      tier:        'disabled',
      explanation: null,
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('states plainly in the caveat that "typical" is a default, not a prediction', async () => {
    const result = await getTrajectoryExplanation(1, 10);
    expect(result.caveat).toMatch(/switched off/i);
    expect(result.caveat).toMatch(/not a prediction/i);
  });

  it('does not touch Tier 1 either when the kill switch is off', async () => {
    await getTrajectoryExplanation(1, 10);
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
    expect(explainTier1).not.toHaveBeenCalled();
  });

  it('returns disabled when feature assembly fails, with a different caveat', async () => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    DialogueWord.findByPk.mockResolvedValue(null);
    const result = await getTrajectoryExplanation(1, 10);
    expect(result).toMatchObject({ trajectory: 'typical', tier: 'disabled', explanation: null });
    expect(result.caveat).toMatch(/not enough recorded session data/i);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('AC7 — non-verbal attempts explain via Tier 1 and never call /explain-trajectory', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeNonVerbalDbMocks();
    computeTier1Trajectory.mockReturnValue('typical');
    explainTier1.mockReturnValue(TIER1_EXPLANATION);
  });

  it('returns tier "tier1" with the Tier 1 decomposition', async () => {
    const result = await getTrajectoryExplanation(1, 10);
    expect(result.tier).toBe('tier1');
    expect(result.trajectory).toBe('typical');
    expect(result.explanation).toBe(TIER1_EXPLANATION);
    expect(result.confidence).toBeNull();
  });

  it('never calls the microservice at all — neither predict nor explain', async () => {
    await getTrajectoryExplanation(1, 10);
    expect(axios.post).not.toHaveBeenCalled();
    expect(explainUrls()).toHaveLength(0);
  });

  it('says in the caveat that the Tier 2 model has never seen a non-verbal attempt', async () => {
    const result = await getTrajectoryExplanation(1, 10);
    expect(result.caveat).toMatch(/non-verbal/i);
  });
});

describe('AC8 — a failing explanation never changes the trajectory or the tier', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeValidDbMocks();
    computeTier1Trajectory.mockReturnValue('fast');
    explainTier1.mockReturnValue(TIER1_EXPLANATION);
  });

  it('keeps tier2 and its trajectory when /explain-trajectory times out', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } },
      explain: new Error('timeout of 8000ms exceeded'),
    });
    const result = await getTrajectoryExplanation(1, 10);
    expect(result.tier).toBe('tier2');
    expect(result.trajectory).toBe('struggling');
    expect(result.confidence).toBe(0.9);
    expect(result.explanation).toBeNull();
    expect(result.caveat).toMatch(/trajectory itself is unaffected/i);
    // Never silently downgraded to the Tier 1 answer because SHAP failed.
    expect(result.trajectory).not.toBe('fast');
    expect(computeTier1Trajectory).not.toHaveBeenCalled();
  });

  it('keeps tier2 and its trajectory when /explain-trajectory returns 503', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } },
      explain: { status: 503, data: { error: 'trajectory explainer not available' } },
    });
    const result = await getTrajectoryExplanation(1, 10);
    expect(result).toMatchObject({ tier: 'tier2', trajectory: 'struggling', explanation: null });
  });

  it('keeps tier2 when /explain-trajectory answers 200 with a malformed body', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'fast', confidence: 0.88 } },
      explain: { status: 200, data: { trajectory: 'fast' } }, // no attributions
    });
    const result = await getTrajectoryExplanation(1, 10);
    expect(result).toMatchObject({ tier: 'tier2', trajectory: 'fast', explanation: null });
  });

  it('gives the explanation call a longer budget than the 2s prediction call', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    await getTrajectoryExplanation(1, 10);
    const predictCfg = axios.post.mock.calls.find(([u]) => u.endsWith('/predict-trajectory'))[2];
    const explainCfg = explainUrls()[0][2];
    expect(predictCfg.timeout).toBe(2000);
    expect(explainCfg.timeout).toBeGreaterThan(predictCfg.timeout);
  });
});

describe('TASK-43 — tier2 accepted, tier1 fallbacks', () => {
  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    primeValidDbMocks();
    computeTier1Trajectory.mockReturnValue('typical');
    explainTier1.mockReturnValue(TIER1_EXPLANATION);
  });

  it('returns the SHAP attributions when Tier 2 clears the confidence gate', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.93 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    const result = await getTrajectoryExplanation(1, 10);
    expect(result.tier).toBe('tier2');
    expect(result.trajectory).toBe('struggling');
    expect(result.confidence).toBe(0.93);
    expect(result.explanation).toEqual(SHAP_EXPLANATION);
    // The DEC-07 reliability caveat is display copy owned by the screen, so a
    // healthy tier2 row carries no backend note of its own.
    expect(result.caveat).toBeNull();
  });

  it('sends the same 13-feature payload to both endpoints, match_type stripped', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.93 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    await getTrajectoryExplanation(1, 10);
    const predictBody = axios.post.mock.calls.find(([u]) => u.endsWith('/predict-trajectory'))[1];
    const explainBody = explainUrls()[0][1];
    expect(explainBody).toEqual(predictBody);
    expect(explainBody).not.toHaveProperty('match_type');
  });

  it('falls back to tier1 when Tier 2 is below the confidence gate, and skips /explain-trajectory', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'fast', confidence: 0.31 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    const result = await getTrajectoryExplanation(1, 10);
    expect(result.tier).toBe('tier1');
    expect(result.trajectory).toBe('typical');
    expect(result.explanation).toBe(TIER1_EXPLANATION);
    expect(result.caveat).toMatch(/confidence threshold/i);
    expect(explainUrls()).toHaveLength(0);
  });

  it('falls back to tier1 when the microservice is unreachable', async () => {
    primeMicroservice({
      predict: new Error('ECONNREFUSED'),
      explain: new Error('ECONNREFUSED'),
    });
    const result = await getTrajectoryExplanation(1, 10);
    expect(result.tier).toBe('tier1');
    expect(result.explanation).toBe(TIER1_EXPLANATION);
    expect(result.caveat).toMatch(/could not be reached/i);
    expect(explainUrls()).toHaveLength(0);
  });

  it('returns the same trajectory getTrajectoryPrediction would, for the same inputs', async () => {
    for (const predict of [
      { status: 200, data: { trajectory: 'struggling', confidence: 0.93 } },
      { status: 200, data: { trajectory: 'fast', confidence: 0.31 } },
      { status: 503, data: {} },
    ]) {
      jest.clearAllMocks();
      primeValidDbMocks();
      computeTier1Trajectory.mockReturnValue('typical');
      explainTier1.mockReturnValue(TIER1_EXPLANATION);
      primeMicroservice({ predict, explain: { status: 200, data: SHAP_EXPLANATION } });

      const explained = await getTrajectoryExplanation(1, 10);
      const predicted = await getTrajectoryPrediction(1, 10);
      expect(explained.trajectory).toBe(predicted);
    }
  });
});

describe('TASK-43 — getTrajectoryReport (batch, one report per student)', () => {
  // asset_key is carried because the report filters abilities rows against the
  // taught-curriculum list; 'clap' is a current word, so all three survive.
  const WORDS = [
    { id: 10, word: 'hello',  category: 'greetings',   difficulty: 1, teaching_order: 1, asset_key: 'hello' },
    { id: 11, word: 'please', category: 'magic_words', difficulty: 2, teaching_order: 1, asset_key: 'please' },
    { id: 12, word: 'clap',   category: 'abilities',   difficulty: 1, teaching_order: 1, asset_key: 'clap' },
  ];

  beforeEach(() => {
    process.env.TRAJECTORY_ML_ENABLED = 'true';
    process.env.MICROSERVICE_URL = 'http://localhost:5001';
    process.env.TRAJECTORY_MIN_CONFIDENCE = '0.5';
    DialogueWord.findAll.mockResolvedValue(WORDS.map((w) => mockRow(w)));
    primeValidDbMocks();
    computeTier1Trajectory.mockReturnValue('typical');
    explainTier1.mockReturnValue(TIER1_EXPLANATION);
  });

  it('HARD RULE 4 — restricts the word query to the three in-scope categories', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    await getTrajectoryReport(1);

    const where = DialogueWord.findAll.mock.calls[0][0].where;
    const clause = where.category[Op.in];
    expect(clause.slice().sort()).toEqual(['abilities', 'greetings', 'magic_words']);
    expect(clause).not.toContain('days_of_week');
  });

  it('returns one row per word, carrying trajectory, tier, confidence, explanation and caveat', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    const report = await getTrajectoryReport(1);

    expect(report.words).toHaveLength(3);
    expect(report.words.map((w) => w.word_id)).toEqual([10, 11, 12]);
    for (const row of report.words) {
      expect(row).toHaveProperty('trajectory');
      expect(row).toHaveProperty('tier');
      expect(row).toHaveProperty('confidence');
      expect(row).toHaveProperty('explanation');
      expect(row).toHaveProperty('caveat');
      expect(row).toHaveProperty('category');
    }
  });

  it('reports overview totals, counting tiers and trajectories separately', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    const { totals } = await getTrajectoryReport(1);

    expect(totals.words_total).toBe(3);
    expect(totals.tier2).toBe(3);
    expect(totals.struggling).toBe(3);
    expect(totals.explained).toBe(3);
    expect(totals.fast + totals.typical + totals.struggling).toBe(totals.words_predicted);
  });

  it('excludes "disabled" rows from the trajectory counts — that "typical" is a default, not a finding', async () => {
    DialogueWord.findByPk.mockResolvedValue(null); // every word fails assembly
    const { totals, words } = await getTrajectoryReport(1);

    expect(words.every((w) => w.tier === 'disabled')).toBe(true);
    expect(totals.disabled).toBe(3);
    expect(totals.words_predicted).toBe(0);
    expect(totals.typical).toBe(0);
  });

  it('degrades per row — one word failing to explain does not fail the report', async () => {
    let explainCalls = 0;
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('/predict-trajectory')) {
        return { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } };
      }
      explainCalls += 1;
      if (explainCalls === 2) throw new Error('timeout of 8000ms exceeded');
      return { status: 200, data: SHAP_EXPLANATION };
    });

    const { words, totals } = await getTrajectoryReport(1);

    expect(words).toHaveLength(3);
    expect(words[1].explanation).toBeNull();
    expect(words[1].tier).toBe('tier2');           // tier survives the failure
    expect(words[1].trajectory).toBe('struggling'); // so does the trajectory
    expect(words[1].caveat).toMatch(/could not be generated/i);
    expect(words[0].explanation).toEqual(SHAP_EXPLANATION);
    expect(words[2].explanation).toEqual(SHAP_EXPLANATION);
    expect(totals.explained).toBe(2);
  });

  // AD HOC 2026-08-20 — retired abilities words ("Can you...?", "I can...",
  // "Yes, I can", "No, I can't") are still rows in dialogue_words but are no
  // longer taught, so they must not appear on a teacher's report.
  it('excludes retired abilities words that are no longer in the taught curriculum', async () => {
    DialogueWord.findAll.mockResolvedValue([
      mockRow({ id: 10, word: 'hello',      category: 'greetings',   difficulty: 1, teaching_order: 1, asset_key: 'hello' }),
      mockRow({ id: 30, word: 'Clap',       category: 'abilities',   difficulty: 1, teaching_order: 1, asset_key: 'clap' }),
      mockRow({ id: 31, word: 'Can you...?', category: 'abilities',  difficulty: 1, teaching_order: 2, asset_key: 'can_you' }),
      mockRow({ id: 32, word: 'I can...',   category: 'abilities',   difficulty: 1, teaching_order: 3, asset_key: 'i_can' }),
      mockRow({ id: 33, word: 'Yes, I can', category: 'abilities',   difficulty: 1, teaching_order: 4, asset_key: 'yes_i_can' }),
      mockRow({ id: 34, word: "No, I can't", category: 'abilities',  difficulty: 1, teaching_order: 5, asset_key: 'no_i_cant' }),
      mockRow({ id: 35, word: 'Yes',        category: 'abilities',   difficulty: 1, teaching_order: 6, asset_key: 'cat3_yes' }),
    ]);
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'struggling', confidence: 0.9 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });

    const { words, totals } = await getTrajectoryReport(1);

    expect(words.map((w) => w.word_id)).toEqual([10, 30, 35]);
    // Assert on the word text the teacher would actually have seen on screen —
    // report rows carry `word`, not `asset_key`, so asserting on asset_key here
    // would pass even if the filter did nothing.
    const shown = words.map((w) => w.word);
    for (const retired of ['Can you...?', 'I can...', 'Yes, I can', "No, I can't"]) {
      expect([retired, shown.includes(retired)]).toEqual([retired, false]);
    }
    expect(shown).toEqual(['hello', 'Clap', 'Yes']);
    // Retired rows must not inflate the headline counts either.
    expect(totals.words_total).toBe(3);
  });

  it('keeps every non-abilities word regardless of the abilities curriculum list', async () => {
    DialogueWord.findAll.mockResolvedValue([
      mockRow({ id: 10, word: 'hello',  category: 'greetings',   difficulty: 1, teaching_order: 1, asset_key: 'hello' }),
      mockRow({ id: 11, word: 'please', category: 'magic_words', difficulty: 1, teaching_order: 1, asset_key: 'please' }),
    ]);
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'fast', confidence: 0.9 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });

    const { words } = await getTrajectoryReport(1);
    expect(words.map((w) => w.word_id)).toEqual([10, 11]);
  });

  it('survives a row that throws outright', async () => {
    primeMicroservice({
      predict: { status: 200, data: { trajectory: 'fast', confidence: 0.9 } },
      explain: { status: 200, data: SHAP_EXPLANATION },
    });
    DialogueWord.findByPk
      .mockResolvedValueOnce({ difficulty: 2, category: 'greetings' })
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'))
      .mockResolvedValueOnce({ difficulty: 2, category: 'greetings' });

    const { words } = await getTrajectoryReport(1);
    expect(words).toHaveLength(3);
    expect(words[1].tier).toBe('disabled');
    expect(words[0].tier).toBe('tier2');
    expect(words[2].tier).toBe('tier2');
  });
});
