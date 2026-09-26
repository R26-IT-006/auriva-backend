'use strict';

// Feature 2 Step 4 — dryRunRecentFamilyPerformance.js CLI. Verifies argument
// parsing and orchestration without hitting the real database. The critical
// property under test: --apply is a hard error (there is no write mode for
// this script at all — unlike the Step 2/3 CLIs, which have a real --apply).
const mockFindAll = jest.fn(); // StudentMotorBaseline.findAll
const mockGetRecentFamilyPerformance = jest.fn();

jest.mock('../src/models', () => ({
  StudentMotorBaseline: { findAll: (...args) => mockFindAll(...args) },
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  RECENT_FAMILY_WINDOW_SIZE: 5,
  getRecentFamilyPerformance: (...args) => mockGetRecentFamilyPerformance(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, findStudentIdsWithBaselines, run } = require('../src/scripts/dryRunRecentFamilyPerformance');

function makeResult(overrides = {}) {
  return {
    status: 'found',
    studentId: 13,
    mappingVersion: 'letter-baseline-family-v1',
    windowSize: 5,
    families: {
      straight: { count: 0, windowComplete: false, attempts: [] },
      curved:   { count: 2, windowComplete: false, attempts: [{ attemptId: 1, letter: 'o', caseType: 'lowercase', performanceScore: 81, createdAt: new Date() }] },
      complex:  { count: 0, windowComplete: false, attempts: [] },
    },
    exclusions: { collectionMode: 0, nonThirdAttempt: 0, invalidCaptureStatus: 0, unmappedLetter: 0, malformedFeatures: 0, duplicateSession: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to no student filter, default window size, no apply concept at all', () => {
    expect(parseArgs([])).toEqual({ studentId: null, windowSize: 5 });
  });

  it('--apply is a hard error — no write mode exists for this script', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });

  it('parses --student-id=13', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13, windowSize: 5 });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });

  it('parses --window-size=8', () => {
    expect(parseArgs(['--window-size=8'])).toEqual({ studentId: null, windowSize: 8 });
  });

  it.each(['abc', '0', '-1', '2.5'])('rejects an invalid --window-size value (%p)', (v) => {
    expect(() => parseArgs([`--window-size=${v}`])).toThrow();
  });

  it('combines --student-id and --window-size', () => {
    expect(parseArgs(['--student-id=13', '--window-size=3'])).toEqual({ studentId: 13, windowSize: 3 });
  });
});

// ─── findStudentIdsWithBaselines ───────────────────────────────────────────

describe('findStudentIdsWithBaselines', () => {
  it('queries only source_type=initial_assessment, dedupes and sorts', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }, { student_id: 5 }, { student_id: 13 }]);
    const ids = await findStudentIdsWithBaselines(null);
    expect(ids).toEqual([5, 13]);
  });

  it('filters to one student when given', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    await findStudentIdsWithBaselines(13);
    expect(mockFindAll).toHaveBeenCalledWith({
      where: { source_type: 'initial_assessment', student_id: 13 },
      attributes: ['student_id'],
    });
  });
});

// ─── Orchestration ──────────────────────────────────────────────────────────

describe('run — calls getRecentFamilyPerformance only, never a write function', () => {
  it('reports each student\'s window result', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockGetRecentFamilyPerformance.mockResolvedValueOnce(makeResult());

    const report = await run({ studentId: 13, windowSize: 5 });

    expect(mockGetRecentFamilyPerformance).toHaveBeenCalledWith({ studentId: 13, windowSize: 5 });
    expect(report.mode).toBe('read-only');
    expect(report.students).toHaveLength(1);
    expect(report.students[0].result.families.curved.count).toBe(2);
  });

  it('propagates a custom --window-size to every student call', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 5 }, { student_id: 13 }]);
    mockGetRecentFamilyPerformance
      .mockResolvedValueOnce(makeResult({ studentId: 5, windowSize: 8 }))
      .mockResolvedValueOnce(makeResult({ studentId: 13, windowSize: 8 }));

    await run({ studentId: null, windowSize: 8 });

    expect(mockGetRecentFamilyPerformance).toHaveBeenNthCalledWith(1, { studentId: 5, windowSize: 8 });
    expect(mockGetRecentFamilyPerformance).toHaveBeenNthCalledWith(2, { studentId: 13, windowSize: 8 });
  });

  it('processes every student with a baseline when no --student-id is given', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 5 }, { student_id: 13 }]);
    mockGetRecentFamilyPerformance
      .mockResolvedValueOnce(makeResult({ studentId: 5 }))
      .mockResolvedValueOnce(makeResult({ studentId: 13 }));

    const report = await run({ studentId: null, windowSize: 5 });

    expect(mockGetRecentFamilyPerformance).toHaveBeenCalledTimes(2);
    expect(report.students).toHaveLength(2);
  });

  it('handles zero students with a baseline gracefully', async () => {
    mockFindAll.mockResolvedValueOnce([]);
    const report = await run({ studentId: null, windowSize: 5 });
    expect(report.students).toHaveLength(0);
    expect(mockGetRecentFamilyPerformance).not.toHaveBeenCalled();
  });

  it('a status other than "found" (e.g. invalid_input) is still reported, not thrown', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockGetRecentFamilyPerformance.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, mappingVersion: 'letter-baseline-family-v1', windowSize: 5, families: null, exclusions: null });

    const report = await run({ studentId: 13, windowSize: 5 });

    expect(report.students[0].result.status).toBe('read_failed');
  });
});
