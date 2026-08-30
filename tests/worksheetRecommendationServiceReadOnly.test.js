'use strict';

// Feature 8 Step 3 — proves the REAL end-to-end call chain
// (evaluateWorksheetRecommendations -> real persistentDifficultyService ->
// real persistentDifficultyEvidence -> real models) never performs a
// single write. Mocks only ../src/models (same convention every prior
// read-only suite in this project uses).

const mockLaFindAll = jest.fn().mockResolvedValue([]);
const mockLaCreate = jest.fn();
const mockLaBulkCreate = jest.fn();
const mockLaUpdate = jest.fn();
const mockLaDestroy = jest.fn();
const mockLaSave = jest.fn();
const mockLaIncrement = jest.fn();
const mockLaFindOrCreate = jest.fn();
const mockTransaction = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    create: mockLaCreate, bulkCreate: mockLaBulkCreate, update: mockLaUpdate,
    destroy: mockLaDestroy, save: mockLaSave, increment: mockLaIncrement,
    findOrCreate: mockLaFindOrCreate,
  },
  sequelize: { transaction: (...a) => mockTransaction(...a) },
}));

const { evaluateWorksheetRecommendations } = require('../src/services/worksheetRecommendationService');

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave, mockLaIncrement, mockLaFindOrCreate, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
});

describe('Read-only guarantee: evaluateWorksheetRecommendations never writes', () => {
  it('a student with zero candidate rows performs exactly one findAll (via Feature 7) and zero writes', async () => {
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.status).toBe('evaluated');
    expect(result.recommendations).toEqual([]);
    expect(mockLaFindAll).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it('invalid input performs zero reads and zero writes', async () => {
    const result = await evaluateWorksheetRecommendations({ studentId: -1 });
    expect(result.status).toBe('invalid_input');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('a read failure still performs zero writes', async () => {
    mockLaFindAll.mockRejectedValueOnce(new Error('boom'));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expectNoWrites();
  });

  it('never touches LetterProgress/ThresholdHistory/StudentMotorBaseline specifically — none are even mocked here, so a real access would throw', async () => {
    await expect(evaluateWorksheetRecommendations({ studentId: 13 })).resolves.toMatchObject({ status: 'evaluated' });
  });
});
