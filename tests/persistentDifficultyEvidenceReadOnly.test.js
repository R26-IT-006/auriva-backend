'use strict';

// Feature 7 Step 2 — proves fetchCandidateCycles() (the ONE DB-touching
// function in persistentDifficultyEvidence.js) never performs a write.
// Mocks only ../src/models (LetterAttempt, with every write stand-in),
// same convention as demoSpeedRecommendationServiceReadOnly.test.js /
// repetitionRecommendationServiceReadOnly.test.js.

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

const { fetchCandidateCycles } = require('../src/services/persistentDifficultyEvidence');

function expectNoWrites() {
  for (const fn of [mockLaCreate, mockLaBulkCreate, mockLaUpdate, mockLaDestroy, mockLaSave, mockLaIncrement, mockLaFindOrCreate, mockTransaction]) {
    expect(fn).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
});

describe('Test 64 — fetchCandidateCycles() never writes', () => {
  it('a valid studentId performs a read (findAll) and zero writes', async () => {
    const result = await fetchCandidateCycles({ studentId: 13 });
    expect(result.status).toBe('found');
    expect(mockLaFindAll).toHaveBeenCalledTimes(1);
    expectNoWrites();
  });

  it('the query enforces attempt_number=3, collection_mode=false, capture_status=complete', async () => {
    await fetchCandidateCycles({ studentId: 13 });
    const callArgs = mockLaFindAll.mock.calls[0][0];
    expect(callArgs.where).toMatchObject({
      student_id: 13, attempt_number: 3, collection_mode: false, capture_status: 'complete',
    });
  });

  it('invalid input (non-positive-integer studentId) performs zero reads and zero writes', async () => {
    const result = await fetchCandidateCycles({ studentId: -1 });
    expect(result.status).toBe('invalid_input');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('a DB error is caught, not propagated, and still performs zero writes', async () => {
    mockLaFindAll.mockRejectedValueOnce(new Error('boom'));
    const result = await fetchCandidateCycles({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expectNoWrites();
  });

  it('missing studentId entirely performs zero reads and zero writes', async () => {
    const result = await fetchCandidateCycles({});
    expect(result.status).toBe('invalid_input');
    expect(mockLaFindAll).not.toHaveBeenCalled();
    expectNoWrites();
  });
});

describe('Source-scan — no write-method call anywhere in the file', () => {
  it('the evidence file (comment-stripped) never references a write method', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/\.create\(|\.bulkCreate\(|\.update\(|\.destroy\(|\.increment\(|\.findOrCreate\(|\.save\(|transaction\(/);
  });
});

// The remaining four source-scans are all scoped to require()/import lines
// only, not the whole file — this module's own header comment legitimately
// DISCUSSES blocked_attempts/timing metrics/ThresholdHistory/
// StudentMotorBaseline by name (documenting exactly why each is excluded),
// which would otherwise be a false positive on a bare substring match, the
// same recurring pitfall caught throughout this project.
function requireLinesOf(source) {
  return source.split('\n').filter((line) => /require\(/.test(line)).join('\n');
}

describe('blocked_attempts is never referenced (spec §43)', () => {
  it('the evidence file never imports LetterProgress', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    expect(requireLinesOf(source)).not.toMatch(/LetterProgress/);
  });

  it('no code (comment-stripped) reads a .blocked_attempts property', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/blocked_attempts/);
  });
});

describe('No raw timing metrics used as trigger inputs (spec §42)', () => {
  it('no code (comment-stripped) reads attempt_duration_ms/attempt_avg_speed/pause metrics', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/attempt_duration_ms|attempt_avg_speed|pause_frequency|pause_duration_ratio/);
  });
});

describe('No ThresholdHistory dependency (spec §44)', () => {
  it('the evidence file never imports ThresholdHistory', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    expect(requireLinesOf(source)).not.toMatch(/ThresholdHistory/);
  });
});

describe('No StudentMotorBaseline dependency (spec §36)', () => {
  it('the evidence file never imports StudentMotorBaseline', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyEvidence.js'), 'utf8');
    expect(requireLinesOf(source)).not.toMatch(/StudentMotorBaseline/);
  });
});
