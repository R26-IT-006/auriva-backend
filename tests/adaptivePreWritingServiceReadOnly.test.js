'use strict';

// Feature 4 Step 4 — proves the REAL end-to-end call chain
// (evaluatePreWritingRecommendation -> real evaluateDynamicThresholds +
// real evaluateSupportRecommendations -> real models) never performs a
// single write. Mocks only ../src/models (same pattern
// tests/adaptiveSupportServiceRecommendation.test.js and
// tests/dynamicThresholdService.test.js already use for their own read-only
// guarantee tests) — every write stand-in (create/bulkCreate/update/
// destroy/save/transaction) is asserted never called, across every early
// exit path this service has (invalid input, not_applicable, no_activity,
// and a full evaluated pass through both real services).

const mockLaFindAll    = jest.fn().mockResolvedValue([]);
const mockLaCount      = jest.fn().mockResolvedValue(0);
const mockLaCreate     = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate     = jest.fn();
const mockLaDestroy    = jest.fn();
const mockLaSave       = jest.fn();

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
const mockSfFindAll    = jest.fn().mockResolvedValue([]);

const mockTransaction  = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    count:   (...a) => mockLaCount(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate, destroy: mockLaDestroy, save: mockLaSave,
  },
  ThresholdHistory: {
    findOne: (...a) => mockThFindOne(...a),
    findAll: (...a) => mockThFindAll(...a),
    create: mockThCreate, bulkCreate: mockThBulkCreate, update: mockThUpdate, destroy: mockThDestroy,
  },
  ShapeFeature: {
    findAll: (...a) => mockSfFindAll(...a),
    create: mockSfCreate, bulkCreate: mockSfBulkCreate, update: mockSfUpdate, destroy: mockSfDestroy,
  },
  Student: { findOne: jest.fn().mockResolvedValue(null), findByPk: jest.fn().mockResolvedValue(null), update: jest.fn() },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const { evaluatePreWritingRecommendation } = require('../src/services/adaptivePreWritingService');

function expectNoWrites() {
  expect(mockLaCreate).not.toHaveBeenCalled();
  expect(mockLaBulkCreate).not.toHaveBeenCalled();
  expect(mockLaUpdate).not.toHaveBeenCalled();
  expect(mockLaDestroy).not.toHaveBeenCalled();
  expect(mockLaSave).not.toHaveBeenCalled();
  expect(mockThCreate).not.toHaveBeenCalled();
  expect(mockThBulkCreate).not.toHaveBeenCalled();
  expect(mockThUpdate).not.toHaveBeenCalled();
  expect(mockThDestroy).not.toHaveBeenCalled();
  expect(mockSfCreate).not.toHaveBeenCalled();
  expect(mockSfBulkCreate).not.toHaveBeenCalled();
  expect(mockSfUpdate).not.toHaveBeenCalled();
  expect(mockSfDestroy).not.toHaveBeenCalled();
  expect(mockTransaction).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
  mockLaCount.mockResolvedValue(0);
  mockThFindOne.mockResolvedValue(null);
  mockThFindAll.mockResolvedValue([]);
  mockSfFindAll.mockResolvedValue([]);
});

describe('Read-only guarantee — evaluatePreWritingRecommendation never writes', () => {
  it('a reviewed letter with activities, evaluated all the way through both real services, performs zero writes', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(mockLaFindAll).toHaveBeenCalled(); // real reads DID happen
    expect(mockThFindOne).toHaveBeenCalled();
    expectNoWrites();
  });

  it('an ambiguous letter (short-circuits before any DB read) performs zero writes and zero reads', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.reason).toBe('not_applicable');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expect(mockThFindOne).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('a mixed-group letter (u) with no catalogue activities performs zero writes and zero reads', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'u', caseType: 'lowercase' });
    expect(result.reason).toBe('no_activity_available');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('invalid input performs zero writes and zero reads', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: -1, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('a straight-family letter also performs zero writes', async () => {
    await evaluatePreWritingRecommendation({ studentId: 13, letter: 'l', caseType: 'lowercase' });
    expectNoWrites();
  });

  it('a complex-family diagonal letter also performs zero writes', async () => {
    await evaluatePreWritingRecommendation({ studentId: 13, letter: 'v', caseType: 'lowercase' });
    expectNoWrites();
  });
});
