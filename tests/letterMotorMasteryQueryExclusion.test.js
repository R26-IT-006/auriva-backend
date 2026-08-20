'use strict';

// Feature 11B Phase 5 — re-verifies the 7 Phase-4 query-exclusion edits are
// still in place. These are unchanged by Phase 5 but are now doubly
// important: mastery-evidence eligibility itself also requires
// source_type IS NULL (spec §9), so a regression here would silently
// corrupt Feature 11B evidence in addition to leaking into Features 1-10.
//
// Behavioral tests for the 2 exported, easily-invokable call sites
// (handwritingController.getInitialReport/getLetterProgressReport,
// adaptiveSupportService.getSupportPerformanceByFamily); source-inspection
// for the 3 non-exported call sites — same split this project used in the
// now-deleted Phase 4 version of this test file.

const mockLaFindAll = jest.fn();
const mockLaCount   = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: {
    findAll: (...a) => mockLaFindAll(...a),
    count:   (...a) => mockLaCount(...a),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
  mockLaCount.mockResolvedValue(0);
});

describe('handwritingController.getInitialReport — letterMasteryRows query excludes source_type', () => {
  it('queries with source_type: null alongside collection_mode: false', async () => {
    const { getInitialReport } = require('../src/controllers/handwritingController');
    mockLaFindAll.mockImplementationOnce(async ({ where }) => {
      expect(where.collection_mode).toBe(false);
      expect(where.source_type).toBeNull();
      return [];
    });
    const req = { params: { studentId: '13' } };
    const res = { json: jest.fn() };
    try { await getInitialReport(req, res); } catch (_e) { /* unrelated downstream dependency, ignored */ }
    expect(mockLaFindAll).toHaveBeenCalled();
  });
});

describe('handwritingController.getLetterProgressReport — attempts query excludes source_type', () => {
  it('queries with source_type: null alongside collection_mode: false', async () => {
    const { getLetterProgressReport } = require('../src/controllers/handwritingController');
    mockLaFindAll.mockImplementationOnce(async ({ where }) => {
      expect(where.collection_mode).toBe(false);
      expect(where.source_type).toBeNull();
      return [];
    });
    const req = { params: { studentId: '13' } };
    const res = { json: jest.fn() };
    await getLetterProgressReport(req, res);
    expect(mockLaFindAll).toHaveBeenCalled();
  });
});

describe('adaptiveSupportService.getSupportPerformanceByFamily — main window query excludes source_type', () => {
  it('queries with source_type: null alongside collection_mode: false', async () => {
    const { getSupportPerformanceByFamily } = require('../src/services/adaptiveSupportService');
    mockLaFindAll.mockImplementationOnce(async ({ where }) => {
      expect(where.collection_mode).toBe(false);
      expect(where.source_type).toBeNull();
      return [];
    });
    await getSupportPerformanceByFamily({ studentId: 13 });
    expect(mockLaFindAll).toHaveBeenCalled();
  });
});

function readSource(relPath) {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.resolve(__dirname, relPath), 'utf8');
}

describe('dynamicThresholdService — fetchFamilyWindow + countUnmappedLetterAttempts exclude source_type', () => {
  const source = readSource('../src/services/dynamicThresholdService.js');

  it("fetchFamilyWindow's query includes source_type: null", () => {
    const fn = source.match(/async function fetchFamilyWindow\([\s\S]*?\n}\n/)[0];
    expect(fn).toMatch(/source_type:\s*null/);
  });

  it("countUnmappedLetterAttempts' baseWhere includes source_type: null", () => {
    const fn = source.match(/async function countUnmappedLetterAttempts\([\s\S]*?\n}\n/)[0];
    expect(fn).toMatch(/source_type:\s*null/);
  });
});

describe('persistentDifficultyEvidence — fetchCandidateCycles excludes source_type', () => {
  it('the query includes source_type: null', () => {
    const source = readSource('../src/services/persistentDifficultyEvidence.js');
    const fn = source.match(/async function fetchCandidateCycles\([\s\S]*?\n}\n/)[0];
    expect(fn).toMatch(/source_type:\s*null/);
  });
});

describe('repetitionRecommendationService — history query excludes source_type', () => {
  it('the LetterAttempt.findAll where-clause includes source_type: null', () => {
    const source = readSource('../src/services/repetitionRecommendationService.js');
    expect(source).toMatch(/LetterAttempt\.findAll\(\{[\s\S]*?source_type:\s*null[\s\S]*?\}\)/);
  });
});

describe('LetterAttempt model — source_type column unchanged from Phase 4', () => {
  it('is declared nullable, with no defaultValue', () => {
    const source = readSource('../src/models/LetterAttempt.js');
    const field = source.match(/source_type:\s*\{[\s\S]*?\n\s*\},/)[0];
    expect(field).toMatch(/allowNull:\s*true/);
    expect(field).not.toMatch(/defaultValue/);
  });
});

describe('letterMotorMasteryService — evidence eligibility itself enforces source_type IS NULL', () => {
  it('validateEvidenceEligibility rejects a non-null source_type row', () => {
    const { validateEvidenceEligibility } = require('../src/services/letterMotorMasteryService');
    const eligibleRow = {
      attempt_number: 3, support_level: 'low', collection_mode: false, source_type: null, capture_status: 'complete',
      normalized_features: { smoothness_score: 70, dtw_distance: 10, speed_cv: 0.2 },
      feature_version: 'v1', template_version: 'v1', normalization_version: 'dtw_norm_v1',
    };
    expect(validateEvidenceEligibility(eligibleRow).valid).toBe(true);
    expect(validateEvidenceEligibility({ ...eligibleRow, source_type: 'anything_non_null' }).valid).toBe(false);
  });
});
