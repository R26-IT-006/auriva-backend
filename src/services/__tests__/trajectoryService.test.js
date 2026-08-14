'use strict';

// Mock all external dependencies before requiring the service under test.
jest.mock('axios');
jest.mock('../tier1Scorer', () => ({
  computeTier1Trajectory: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

// Mock Sequelize models — the service imports them as named exports from '../models'
// (resolves to src/models from the service's perspective, src/models from test's
// perspective via ../../models).
jest.mock('../../models', () => ({
  DialogueWord: { findByPk: jest.fn() },
  DialogueWordProgress: { findOne: jest.fn() },
  DialogueWordAttempt: { findOne: jest.fn() },
  DialoguePhase3Attempt: { findOne: jest.fn() },
}));

// Sequelize Op is only used inside buildSession1Features for { [Op.ne]: null }.
// Mock sequelize so the service can destructure Op.
jest.mock('sequelize', () => {
  const actual = jest.requireActual('sequelize');
  return actual;
});

const axios = require('axios');
const { computeTier1Trajectory } = require('../tier1Scorer');
const logger = require('../../utils/logger');
const {
  DialogueWord,
  DialogueWordProgress,
  DialogueWordAttempt,
  DialoguePhase3Attempt,
} = require('../../models');

// Import the service AFTER mocks are set up.
const { getTrajectoryPrediction } = require('../trajectoryService');

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
