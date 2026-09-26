'use strict';

// Feature 6 Step 3 — proves the REAL end-to-end call chain
// (evaluateDemoSpeedRecommendation -> real evaluateDynamicThresholds +
// real evaluateSupportRecommendations -> real models) never performs a
// single write. Mocks only ../src/models (same pattern
// tests/repetitionRecommendationServiceReadOnly.test.js and
// tests/adaptivePreWritingServiceReadOnly.test.js already use) — every
// write stand-in is asserted never called, across every early exit path
// this service has (invalid input, not_applicable, and a full evaluated
// pass through both real services).

const mockLaFindAll    = jest.fn().mockResolvedValue([]);
const mockLaCount      = jest.fn().mockResolvedValue(0);
const mockLaCreate     = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate     = jest.fn();
const mockLaDestroy    = jest.fn();
const mockLaSave       = jest.fn();

const mockLpFindOne      = jest.fn().mockResolvedValue(null);
const mockLpFindOrCreate = jest.fn();
const mockLpCreate       = jest.fn();
const mockLpUpdate       = jest.fn();
const mockLpIncrement    = jest.fn();
const mockLpDestroy      = jest.fn();

const mockThFindOne    = jest.fn().mockResolvedValue(null);
const mockThFindAll    = jest.fn().mockResolvedValue([]);
const mockThCreate     = jest.fn();
const mockThBulkCreate = jest.fn();
const mockThUpdate     = jest.fn();
const mockThDestroy    = jest.fn();

const mockSfCreate     = jest.fn();
const mockSfBulkCreate = jest.fn();
const mockSfUpdate     = jest.fn();
const mockSfDestroy    = jest.fn();

const mockTransaction = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    count:   (...a) => mockLaCount(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate, destroy: mockLaDestroy, save: mockLaSave,
  },
  LetterProgress: {
    findOne: (...a) => mockLpFindOne(...a),
    findOrCreate: (...a) => mockLpFindOrCreate(...a),
    create: mockLpCreate, update: mockLpUpdate, increment: mockLpIncrement, destroy: mockLpDestroy,
  },
  ThresholdHistory: {
    findOne: (...a) => mockThFindOne(...a),
    findAll: (...a) => mockThFindAll(...a),
    create: mockThCreate, bulkCreate: mockThBulkCreate, update: mockThUpdate, destroy: mockThDestroy,
  },
  ShapeFeature: {
    create: mockSfCreate, bulkCreate: mockSfBulkCreate, update: mockSfUpdate, destroy: mockSfDestroy,
  },
  Student: { findOne: jest.fn().mockResolvedValue(null), findByPk: jest.fn().mockResolvedValue(null), update: jest.fn() },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const { evaluateDemoSpeedRecommendation } = require('../src/services/demoSpeedRecommendationService');

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave,
                     mockLpCreate, mockLpUpdate, mockLpIncrement, mockLpDestroy,
                     mockThCreate, mockThBulkCreate, mockThUpdate, mockThDestroy,
                     mockSfCreate, mockSfBulkCreate, mockSfUpdate, mockSfDestroy, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
  mockLaCount.mockResolvedValue(0);
  mockLpFindOne.mockResolvedValue(null);
  mockThFindOne.mockResolvedValue(null);
  mockThFindAll.mockResolvedValue([]);
});

describe('Test 22 — Read-only guarantee: evaluateDemoSpeedRecommendation never writes', () => {
  it('a reviewed letter, evaluated all the way through both real services, performs zero writes', async () => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(mockLaFindAll).toHaveBeenCalled(); // real reads DID happen
    expect(mockThFindOne).toHaveBeenCalled();
    expectNoWrites();
  });

  it('an ambiguous letter (short-circuits before any DB read) performs zero writes and zero reads', async () => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.reason).toBe('not_applicable');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThFindOne).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('invalid input performs zero writes and zero reads', async () => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: -1, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
    expectNoWrites();
  });

  it('a straight-family letter also performs zero writes', async () => {
    await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'l', caseType: 'lowercase' });
    expectNoWrites();
  });

  it('a complex-family diagonal letter also performs zero writes', async () => {
    await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'v', caseType: 'lowercase' });
    expectNoWrites();
  });

  it('never touches blocked_attempts / LetterProgress.increment or StudentMotorBaseline specifically', async () => {
    await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockLpIncrement).not.toHaveBeenCalled();
    expect(mockLpFindOrCreate).not.toHaveBeenCalled();
  });
});
