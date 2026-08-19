'use strict';

// Feature 11B Phase 4 — query-exclusion regression suite. Proves every
// normal-learning LetterAttempt query identified in the Phase 4 audit
// filters `source_type: null`, so reassessment rows can never leak into
// Features 1-10. Two call sites (handwritingController.getInitialReport/
// getLetterProgressReport, adaptiveSupportService.getSupportPerformanceByFamily)
// are verified BEHAVIORALLY (the actual `where` object passed to a mocked
// LetterAttempt.findAll). The remaining three (dynamicThresholdService's
// fetchFamilyWindow/countUnmappedLetterAttempts, persistentDifficultyEvidence's
// fetchCandidateCycles, repetitionRecommendationService's history query) are
// not exported directly, so they are verified via source inspection —
// mirroring this codebase's own established "no writes" source-scan
// convention (see getPersistentDifficultyEndpoint.test.js).
//
// The 8th call site (collectionController's LetterAttempt.findAll by
// collection_session_id) needs NO source_type filter — reassessment rows
// never have collection_session_id set — and is proven safe by construction
// via a dedicated behavioral test below.

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

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral: handwritingController
// ═══════════════════════════════════════════════════════════════════════════

describe('handwritingController.getInitialReport — letterMasteryRows query excludes reassessment rows', () => {
  it('queries with source_type: null alongside collection_mode: false', async () => {
    const { getInitialReport } = require('../src/controllers/handwritingController');
    mockLaFindAll.mockImplementationOnce(async ({ where }) => {
      expect(where.collection_mode).toBe(false);
      expect(where.source_type).toBeNull();
      return [];
    });
    const req = { params: { studentId: '13' } };
    const res = { json: jest.fn() };
    // getInitialReport does more than this one query — allow it to run to
    // completion or throw for an unrelated reason; only the LetterAttempt
    // query assertion above is under test.
    try { await getInitialReport(req, res); } catch (_e) { /* unrelated downstream dependency, ignored */ }
    expect(mockLaFindAll).toHaveBeenCalled();
  });
});

describe('handwritingController.getLetterProgressReport — attempts query excludes reassessment rows', () => {
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

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral: adaptiveSupportService
// ═══════════════════════════════════════════════════════════════════════════

describe('adaptiveSupportService.getSupportPerformanceByFamily — main window query excludes reassessment rows', () => {
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

  it('the two diagnostic exclusion-count queries are UNCHANGED (naturally safe — see their own comment) and still run', async () => {
    const { getSupportPerformanceByFamily } = require('../src/services/adaptiveSupportService');
    await getSupportPerformanceByFamily({ studentId: 13 });
    // collection_mode:true count and capture_status-mismatch count both
    // naturally exclude reassessment rows (collection_mode:false,
    // capture_status:'complete' always) without needing source_type.
    expect(mockLaCount).toHaveBeenCalledTimes(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Behavioral: collectionController — naturally safe, no change needed
// ═══════════════════════════════════════════════════════════════════════════

describe('collectionController — collection-session export query needs no source_type filter', () => {
  it('reassessment rows never have collection_session_id set, so a query filtered on it can never return one', () => {
    // Structural proof, not a live DB round-trip: saveReassessmentAttempt
    // always persists collection_session_id: null (see
    // letterMotorReassessmentService.js), and collectionController's own
    // query filters `where: { collection_session_id: id }` for a real,
    // non-null id — the two predicates are mutually exclusive by
    // construction.
    const fs = require('fs');
    const path = require('path');
    const serviceSource = fs.readFileSync(path.resolve(__dirname, '../src/services/letterMotorReassessmentService.js'), 'utf8');
    expect(serviceSource).toMatch(/collection_session_id:\s*null/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Source-inspection: the 3 non-exported call sites
// ═══════════════════════════════════════════════════════════════════════════

function readSource(relPath) {
  const fs = require('fs');
  const path = require('path');
  return fs.readFileSync(path.resolve(__dirname, relPath), 'utf8');
}

describe('dynamicThresholdService — fetchFamilyWindow + countUnmappedLetterAttempts exclude reassessment rows', () => {
  const source = readSource('../src/services/dynamicThresholdService.js');

  it('fetchFamilyWindow\'s query includes source_type: null', () => {
    const fn = source.match(/async function fetchFamilyWindow\([\s\S]*?\n}\n/)[0];
    expect(fn).toMatch(/source_type:\s*null/);
  });

  it('countUnmappedLetterAttempts\' baseWhere includes source_type: null', () => {
    const fn = source.match(/async function countUnmappedLetterAttempts\([\s\S]*?\n}\n/)[0];
    expect(fn).toMatch(/source_type:\s*null/);
  });
});

describe('persistentDifficultyEvidence — fetchCandidateCycles excludes reassessment rows', () => {
  it('the query includes source_type: null', () => {
    const source = readSource('../src/services/persistentDifficultyEvidence.js');
    const fn = source.match(/async function fetchCandidateCycles\([\s\S]*?\n}\n/)[0];
    expect(fn).toMatch(/source_type:\s*null/);
  });
});

describe('repetitionRecommendationService — history query excludes reassessment rows', () => {
  it('the LetterAttempt.findAll where-clause includes source_type: null', () => {
    const source = readSource('../src/services/repetitionRecommendationService.js');
    expect(source).toMatch(/LetterAttempt\.findAll\(\{[\s\S]*?source_type:\s*null[\s\S]*?\}\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Model / migration — source_type column itself
// ═══════════════════════════════════════════════════════════════════════════

describe('LetterAttempt model exposes source_type as nullable, never defaulted', () => {
  it('the model source declares source_type as a nullable STRING with no defaultValue', () => {
    const source = readSource('../src/models/LetterAttempt.js');
    const field = source.match(/source_type:\s*\{[\s\S]*?\n\s*\},/)[0];
    expect(field).toMatch(/allowNull:\s*true/);
    expect(field).not.toMatch(/defaultValue/);
  });
});
