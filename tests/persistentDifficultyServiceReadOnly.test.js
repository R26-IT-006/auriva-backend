'use strict';

// Feature 7 Step 3 — proves the REAL end-to-end call chain
// (evaluatePersistentDifficulty -> real persistentDifficultyEvidence.js
// helpers -> real models) never performs a single write. Mocks only
// ../src/models (same pattern demoSpeedRecommendationServiceReadOnly.test.js
// and feature3EndToEndOrchestration.test.js already use) — every write
// stand-in is asserted never called.

const mockLaFindAll    = jest.fn().mockResolvedValue([]);
const mockLaCount      = jest.fn().mockResolvedValue(0);
const mockLaCreate     = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate     = jest.fn();
const mockLaDestroy    = jest.fn();
const mockLaSave       = jest.fn();
const mockLaIncrement  = jest.fn();
const mockLaFindOrCreate = jest.fn();
const mockTransaction  = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    count:   (...a) => mockLaCount(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate,
    destroy: mockLaDestroy, save: mockLaSave, increment: mockLaIncrement,
    findOrCreate: mockLaFindOrCreate,
  },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const { evaluatePersistentDifficulty } = require('../src/services/persistentDifficultyService');

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave, mockLaIncrement, mockLaFindOrCreate, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
});

describe('Test 44 — Read-only guarantee: evaluatePersistentDifficulty never writes', () => {
  it('a student with zero candidate rows performs exactly one findAll and zero writes', async () => {
    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(result.status).toBe('evaluated');
    expect(mockLaFindAll).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it('a student with real candidate rows across multiple letters/families still performs exactly one findAll and zero writes', async () => {
    mockLaFindAll.mockResolvedValueOnce([
      { id: 1, student_id: 13, letter: 'c', case_type: 'lowercase', session_key: 's1', attempt_number: 3, collection_mode: false, capture_status: 'complete', best_score: 90, threshold: 55, threshold_passed: true, created_at: '2026-01-01T00:00:00.000Z' },
      { id: 2, student_id: 13, letter: 'l', case_type: 'lowercase', session_key: 's2', attempt_number: 3, collection_mode: false, capture_status: 'complete', best_score: 30, threshold: 55, threshold_passed: false, created_at: '2026-01-02T00:00:00.000Z' },
    ]);
    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(result.status).toBe('evaluated');
    expect(result.streams.lowercase.curved.validCycleCount).toBe(1);
    expect(result.streams.lowercase.straight.validCycleCount).toBe(1);
    expect(mockLaFindAll).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it('invalid input performs zero reads and zero writes', async () => {
    const result = await evaluatePersistentDifficulty({ studentId: -1 });
    expect(result.status).toBe('invalid_input');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('a read failure performs zero writes', async () => {
    mockLaFindAll.mockRejectedValueOnce(new Error('boom'));
    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expectNoWrites();
  });

  it('never touches blocked_attempts / LetterProgress / ThresholdHistory / StudentMotorBaseline specifically — none are even mocked here, so a real call would throw', async () => {
    // The models mock above deliberately exposes ONLY LetterAttempt +
    // sequelize.transaction — if evaluatePersistentDifficulty ever tried to
    // read/write LetterProgress, ThresholdHistory, or StudentMotorBaseline,
    // destructuring them from the mocked module would yield `undefined`,
    // and calling any method on `undefined` would throw. It doesn't.
    await expect(evaluatePersistentDifficulty({ studentId: 13 })).resolves.toMatchObject({ status: 'evaluated' });
  });
});
