'use strict';

// Feature 3 Step 4 — dryRunSupportPerformance.js CLI. Verifies argument
// parsing and orchestration without hitting the real database. Mirrors
// tests/dryRunRecentFamilyPerformance.test.js's convention: the critical
// property under test is that --apply is a hard error (no write mode
// exists for this script at all).
const mockGetSupportPerformanceByFamily = jest.fn();

jest.mock('../src/services/adaptiveSupportService', () => ({
  SUPPORT_PERFORMANCE_WINDOW_SIZE: 5,
  getSupportPerformanceByFamily: (...args) => mockGetSupportPerformanceByFamily(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, run } = require('../src/scripts/dryRunSupportPerformance');

function makeResult(overrides = {}) {
  return {
    status: 'found',
    studentId: 13,
    windowSize: 5,
    families: {
      straight: {
        high:   { count: 0, windowComplete: false, attempts: [], averageScore: null, minScore: null, maxScore: null },
        medium: { count: 0, windowComplete: false, attempts: [], averageScore: null, minScore: null, maxScore: null },
        low:    { count: 0, windowComplete: false, attempts: [], averageScore: null, minScore: null, maxScore: null },
      },
      curved: {
        high:   { count: 2, windowComplete: false, attempts: [], averageScore: 80, minScore: 79, maxScore: 81 },
        medium: { count: 2, windowComplete: false, attempts: [], averageScore: 80, minScore: 75, maxScore: 85 },
        low:    { count: 2, windowComplete: false, attempts: [], averageScore: 78, minScore: 77, maxScore: 79 },
      },
      complex: {
        high:   { count: 0, windowComplete: false, attempts: [], averageScore: null, minScore: null, maxScore: null },
        medium: { count: 0, windowComplete: false, attempts: [], averageScore: null, minScore: null, maxScore: null },
        low:    { count: 0, windowComplete: false, attempts: [], averageScore: null, minScore: null, maxScore: null },
      },
    },
    supportSourceCounts: { explicit: 0, historicalProxy: 6 },
    exclusions: { collectionMode: 0, invalidCaptureStatus: 0, unmappedLetter: 0, invalidSupport: 0, malformedFeatures: 0, duplicateAttempt: 0 },
    diagnostics: { totalSessions: 2, malformedSessionCount: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('--student-id is required', () => {
    expect(() => parseArgs([])).toThrow(/--student-id is required/);
  });

  it('parses --student-id=13 with the default window size', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13, windowSize: 5 });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });

  it('parses --window-size=8', () => {
    expect(parseArgs(['--student-id=13', '--window-size=8'])).toEqual({ studentId: 13, windowSize: 8 });
  });

  it.each(['abc', '0', '-1', '2.5'])('rejects an invalid --window-size value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=13`, `--window-size=${v}`])).toThrow();
  });

  it('--apply is a hard error — no write mode exists for this script', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow(/read-only/);
  });

  it('--apply is rejected even before other args are considered invalid', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });
});

// ─── Orchestration ──────────────────────────────────────────────────────────

describe('run — calls getSupportPerformanceByFamily only, never a write function', () => {
  it('reports the student\'s support-performance result', async () => {
    mockGetSupportPerformanceByFamily.mockResolvedValueOnce(makeResult());

    const report = await run({ studentId: 13, windowSize: 5 });

    expect(mockGetSupportPerformanceByFamily).toHaveBeenCalledWith({ studentId: 13, windowSize: 5 });
    expect(report.mode).toBe('read-only');
    expect(report.studentId).toBe(13);
    expect(report.result.families.curved.high.count).toBe(2);
  });

  it('propagates a custom --window-size', async () => {
    mockGetSupportPerformanceByFamily.mockResolvedValueOnce(makeResult({ windowSize: 8 }));

    await run({ studentId: 13, windowSize: 8 });

    expect(mockGetSupportPerformanceByFamily).toHaveBeenCalledWith({ studentId: 13, windowSize: 8 });
  });

  it('a status other than "found" (e.g. read_failed) is still reported, not thrown', async () => {
    mockGetSupportPerformanceByFamily.mockResolvedValueOnce({
      status: 'read_failed', studentId: 13, windowSize: 5, families: null, supportSourceCounts: null, exclusions: null, diagnostics: null,
    });

    const report = await run({ studentId: 13, windowSize: 5 });

    expect(report.result.status).toBe('read_failed');
  });

  it('never calls anything other than getSupportPerformanceByFamily — no write function exists to call', async () => {
    mockGetSupportPerformanceByFamily.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13, windowSize: 5 });
    expect(mockGetSupportPerformanceByFamily).toHaveBeenCalledTimes(1);
  });
});
