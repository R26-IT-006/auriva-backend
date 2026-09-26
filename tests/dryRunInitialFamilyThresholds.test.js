'use strict';

// Verifies the dry-run CLI's argument parsing and student-enumeration logic
// without hitting the real database.
const mockFindAll = jest.fn();
const mockDerive  = jest.fn();

jest.mock('../src/models', () => ({
  Student:              { findAll: jest.fn() },
  StudentMotorBaseline: { findAll: (...args) => mockFindAll(...args) },
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  INITIAL_THRESHOLD_MARGIN: 5,
  deriveInitialFamilyThresholds: (...args) => mockDerive(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, findStudentIdsWithBaselines, runDryRun } = require('../src/scripts/dryRunInitialFamilyThresholds');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to no student filter and the default margin', () => {
    expect(parseArgs([])).toEqual({ studentId: null, margin: 5 });
  });

  it('parses --student-id=13', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13, margin: 5 });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p) before any DB access', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });

  it('parses --margin=3', () => {
    expect(parseArgs(['--margin=3'])).toEqual({ studentId: null, margin: 3 });
  });

  it.each(['abc', '-1'])('rejects an invalid --margin value (%p)', (v) => {
    expect(() => parseArgs([`--margin=${v}`])).toThrow();
  });

  it('has no --apply option — passing one throws rather than being silently accepted', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/not supported/i);
  });

  it('rejects --apply even combined with a valid --student-id', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow(/not supported/i);
  });
});

// ─── findStudentIdsWithBaselines ───────────────────────────────────────────

describe('findStudentIdsWithBaselines', () => {
  it('queries only source_type=initial_assessment, returns de-duplicated sorted ids', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }, { student_id: 5 }, { student_id: 13 }]);

    const ids = await findStudentIdsWithBaselines(null);

    expect(ids).toEqual([5, 13]);
    expect(mockFindAll).toHaveBeenCalledWith({
      where: { source_type: 'initial_assessment' },
      attributes: ['student_id'],
    });
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

// ─── runDryRun (orchestration) ──────────────────────────────────────────────

describe('runDryRun', () => {
  it('calls deriveInitialFamilyThresholds once per student with a baseline, never writes', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockDerive.mockResolvedValueOnce({
      status: 'derived', studentId: 13, baselineId: 1, baselineVersion: 'baseline-v1',
      mappingVersion: 'letter-baseline-family-v1', margin: 5,
      thresholds: {
        straight: { baselineScore: 62, margin: 5, rawTarget: 67, status: 'ready', reason: null },
        curved:   { baselineScore: 83, margin: 5, rawTarget: 88, status: 'ready', reason: null },
        complex:  { baselineScore: 68, margin: 5, rawTarget: 73, status: 'ready', reason: null },
      },
    });

    const report = await runDryRun({ studentId: 13, margin: 5 });

    expect(mockDerive).toHaveBeenCalledWith({ studentId: 13, margin: 5 });
    expect(report.mode).toBe('dry-run');
    expect(report.students).toHaveLength(1);
    expect(report.students[0].thresholds.curved.rawTarget).toBe(88);
  });

  it('handles zero students with a baseline gracefully', async () => {
    mockFindAll.mockResolvedValueOnce([]);
    const report = await runDryRun({ studentId: null, margin: 5 });
    expect(report.students).toHaveLength(0);
    expect(mockDerive).not.toHaveBeenCalled();
  });
});
