'use strict';

// Feature 2 Step 5 — dryRunDynamicThresholdDecision.js CLI. Verifies argument
// parsing and orchestration without hitting the real database. The critical
// property under test: --apply is a hard error — evaluateDynamicThresholds()
// never persists anything, so no write mode exists to opt into.
const mockFindAll = jest.fn(); // StudentMotorBaseline.findAll
const mockEvaluateDynamicThresholds = jest.fn();

jest.mock('../src/models', () => ({
  StudentMotorBaseline: { findAll: (...args) => mockFindAll(...args) },
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  RECENT_FAMILY_WINDOW_SIZE: 5,
  THRESHOLD_INCREASE_STEP: 5,
  evaluateDynamicThresholds: (...args) => mockEvaluateDynamicThresholds(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, findStudentIdsWithBaselines, run } = require('../src/scripts/dryRunDynamicThresholdDecision');

function makeResult(overrides = {}) {
  return {
    status: 'evaluated',
    studentId: 13,
    mappingVersion: 'letter-baseline-family-v1',
    windowSize: 5,
    increaseStep: 5,
    families: {
      straight: { family: 'straight', currentThreshold: 67, window: { count: 0, complete: false }, scores: [], metTargetCount: null, decision: 'insufficient_data', rawRecommendedThreshold: 67, recommendedThreshold: 67, requiresReview: false, reason: 'insufficient_window', attemptEvaluations: [] },
      curved:   { family: 'curved', currentThreshold: 88, window: { count: 2, complete: false }, scores: [79, 77], metTargetCount: null, decision: 'insufficient_data', rawRecommendedThreshold: 88, recommendedThreshold: 88, requiresReview: false, reason: 'insufficient_window', attemptEvaluations: [] },
      complex:  { family: 'complex', currentThreshold: 73, window: { count: 0, complete: false }, scores: [], metTargetCount: null, decision: 'insufficient_data', rawRecommendedThreshold: 73, recommendedThreshold: 73, requiresReview: false, reason: 'insufficient_window', attemptEvaluations: [] },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to no student filter, default window size and increase step', () => {
    expect(parseArgs([])).toEqual({ studentId: null, windowSize: 5, increaseStep: 5 });
  });

  it('--apply is a hard error — no write mode exists for this script', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });

  it('parses --student-id=13', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13, windowSize: 5, increaseStep: 5 });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });

  it('parses --window-size=8', () => {
    expect(parseArgs(['--window-size=8'])).toEqual({ studentId: null, windowSize: 8, increaseStep: 5 });
  });

  it.each(['abc', '0', '-1', '2.5'])('rejects an invalid --window-size value (%p)', (v) => {
    expect(() => parseArgs([`--window-size=${v}`])).toThrow();
  });

  it('parses --increase-step=3', () => {
    expect(parseArgs(['--increase-step=3'])).toEqual({ studentId: null, windowSize: 5, increaseStep: 3 });
  });

  it('parses --increase-step=0 (allowed)', () => {
    expect(parseArgs(['--increase-step=0'])).toEqual({ studentId: null, windowSize: 5, increaseStep: 0 });
  });

  it.each(['abc', '-1'])('rejects an invalid --increase-step value (%p)', (v) => {
    expect(() => parseArgs([`--increase-step=${v}`])).toThrow();
  });

  it('combines all three flags', () => {
    expect(parseArgs(['--student-id=13', '--window-size=3', '--increase-step=2']))
      .toEqual({ studentId: 13, windowSize: 3, increaseStep: 2 });
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

describe('run — calls evaluateDynamicThresholds only, never a write function', () => {
  it('reports each student\'s decision result', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockEvaluateDynamicThresholds.mockResolvedValueOnce(makeResult());

    const report = await run({ studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(mockEvaluateDynamicThresholds).toHaveBeenCalledWith({ studentId: 13, windowSize: 5, increaseStep: 5 });
    expect(report.mode).toBe('read-only-decision-simulation');
    expect(report.students).toHaveLength(1);
    expect(report.students[0].result.families.curved.decision).toBe('insufficient_data');
  });

  it('propagates a custom --increase-step to every student call', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 5 }, { student_id: 13 }]);
    mockEvaluateDynamicThresholds
      .mockResolvedValueOnce(makeResult({ studentId: 5, increaseStep: 3 }))
      .mockResolvedValueOnce(makeResult({ studentId: 13, increaseStep: 3 }));

    await run({ studentId: null, windowSize: 5, increaseStep: 3 });

    expect(mockEvaluateDynamicThresholds).toHaveBeenNthCalledWith(1, { studentId: 5, windowSize: 5, increaseStep: 3 });
    expect(mockEvaluateDynamicThresholds).toHaveBeenNthCalledWith(2, { studentId: 13, windowSize: 5, increaseStep: 3 });
  });

  it('processes every student with a baseline when no --student-id is given', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 5 }, { student_id: 13 }]);
    mockEvaluateDynamicThresholds
      .mockResolvedValueOnce(makeResult({ studentId: 5 }))
      .mockResolvedValueOnce(makeResult({ studentId: 13 }));

    const report = await run({ studentId: null, windowSize: 5, increaseStep: 5 });

    expect(mockEvaluateDynamicThresholds).toHaveBeenCalledTimes(2);
    expect(report.students).toHaveLength(2);
  });

  it('handles zero students with a baseline gracefully', async () => {
    mockFindAll.mockResolvedValueOnce([]);
    const report = await run({ studentId: null, windowSize: 5, increaseStep: 5 });
    expect(report.students).toHaveLength(0);
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
  });

  it('a raise decision is reported correctly, including the recommendedThreshold', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockEvaluateDynamicThresholds.mockResolvedValueOnce(makeResult({
      families: {
        straight: { family: 'straight', currentThreshold: 67, window: { count: 0, complete: false }, scores: [], metTargetCount: null, decision: 'insufficient_data', rawRecommendedThreshold: 67, recommendedThreshold: 67, requiresReview: false, reason: 'insufficient_window', attemptEvaluations: [] },
        curved:   { family: 'curved', currentThreshold: 88, window: { count: 5, complete: true }, scores: [90, 91, 92, 93, 94], metTargetCount: 5, decision: 'raise', rawRecommendedThreshold: 93, recommendedThreshold: 93, requiresReview: false, reason: '4_or_5_met_target', attemptEvaluations: [] },
        complex:  { family: 'complex', currentThreshold: 73, window: { count: 0, complete: false }, scores: [], metTargetCount: null, decision: 'insufficient_data', rawRecommendedThreshold: 73, recommendedThreshold: 73, requiresReview: false, reason: 'insufficient_window', attemptEvaluations: [] },
      },
    }));

    const report = await run({ studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(report.students[0].result.families.curved.decision).toBe('raise');
    expect(report.students[0].result.families.curved.recommendedThreshold).toBe(93);
  });

  it('a status other than "evaluated" (e.g. read_failed) is still reported, not thrown', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockEvaluateDynamicThresholds.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, mappingVersion: 'letter-baseline-family-v1', windowSize: 5, increaseStep: 5, families: null });

    const report = await run({ studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(report.students[0].result.status).toBe('read_failed');
  });
});
