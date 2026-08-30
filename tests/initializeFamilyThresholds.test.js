'use strict';

// Verifies the initializeFamilyThresholds CLI's argument parsing and
// dry-run/apply dispatch without hitting the real database. The critical
// property under test: dry-run mode must NEVER call the writing function.
const mockFindAll   = jest.fn();
const mockClassify  = jest.fn();
const mockCreate    = jest.fn();

jest.mock('../src/models', () => ({
  StudentMotorBaseline: { findAll: (...args) => mockFindAll(...args) },
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  INITIAL_THRESHOLD_MARGIN: 5,
  classifyFamilyInitialization: (...args) => mockClassify(...args),
  createInitialFamilyThresholds: (...args) => mockCreate(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, findStudentIdsWithBaselines, run } = require('../src/scripts/initializeFamilyThresholds');

function makeClassification(overrides = {}) {
  return {
    straight: { action: 'would_create', baselineScore: 62, rawTarget: 67 },
    curved:   { action: 'would_create', baselineScore: 83, rawTarget: 88 },
    complex:  { action: 'would_create', baselineScore: 68, rawTarget: 73 },
    ...overrides,
  };
}

function makeCreateResult(overrides = {}) {
  return {
    status: 'created', studentId: 13, baselineId: 1, baselineVersion: 'baseline-v1',
    mappingVersion: 'letter-baseline-family-v1', margin: 5,
    created: {
      straight: { status: 'created', historyId: 1, newThreshold: 67 },
      curved:   { status: 'created', historyId: 2, newThreshold: 88 },
      complex:  { status: 'created', historyId: 3, newThreshold: 73 },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to dry-run, no student filter, default margin', () => {
    expect(parseArgs([])).toEqual({ apply: false, studentId: null, margin: 5 });
  });

  it('parses --apply', () => {
    expect(parseArgs(['--apply'])).toEqual({ apply: true, studentId: null, margin: 5 });
  });

  it('parses --student-id=13', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ apply: false, studentId: 13, margin: 5 });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });

  it('parses --margin=3', () => {
    expect(parseArgs(['--margin=3'])).toEqual({ apply: false, studentId: null, margin: 3 });
  });

  it.each(['abc', '-1'])('rejects an invalid --margin value (%p)', (v) => {
    expect(() => parseArgs([`--margin=${v}`])).toThrow();
  });

  it('combines --apply, --student-id, and --margin', () => {
    expect(parseArgs(['--apply', '--student-id=13', '--margin=3'])).toEqual({ apply: true, studentId: 13, margin: 3 });
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

// ─── Dry-run mode: no writes ────────────────────────────────────────────────

describe('Dry-run mode never writes', () => {
  it('calls classifyFamilyInitialization only — createInitialFamilyThresholds is never referenced', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockClassify.mockResolvedValueOnce({
      derivation: { status: 'derived', studentId: 13, baselineId: 1, baselineVersion: 'baseline-v1', mappingVersion: 'letter-baseline-family-v1', margin: 5 },
      classification: makeClassification(),
    });

    const report = await run({ apply: false, studentId: 13, margin: 5 });

    expect(mockClassify).toHaveBeenCalledWith({ studentId: 13, margin: 5 });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(report.mode).toBe('dry-run');
    expect(report.students[0].classification.straight.action).toBe('would_create');
  });
});

// ─── Apply mode: writes via createInitialFamilyThresholds ─────────────────

describe('Apply mode writes via createInitialFamilyThresholds', () => {
  it('calls createInitialFamilyThresholds, not classifyFamilyInitialization', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockCreate.mockResolvedValueOnce(makeCreateResult());

    const report = await run({ apply: true, studentId: 13, margin: 5 });

    expect(mockCreate).toHaveBeenCalledWith({ studentId: 13, margin: 5 });
    expect(mockClassify).not.toHaveBeenCalled();
    expect(report.mode).toBe('apply');
    expect(report.summary.created).toBe(3);
  });

  it('second apply reports already_initialized, summary reflects it', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockCreate.mockResolvedValueOnce(makeCreateResult({
      status: 'already_initialized',
      created: {
        straight: { status: 'already_initialized', historyId: 1, newThreshold: 67 },
        curved:   { status: 'already_initialized', historyId: 2, newThreshold: 88 },
        complex:  { status: 'already_initialized', historyId: 3, newThreshold: 73 },
      },
    }));

    const report = await run({ apply: true, studentId: 13, margin: 5 });

    expect(report.summary.created).toBe(0);
    expect(report.summary.alreadyInitialized).toBe(3);
  });
});

// ─── Unscoped dry-run ───────────────────────────────────────────────────────

describe('Unscoped dry-run (no --student-id)', () => {
  it('processes every student with a baseline', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 5 }, { student_id: 13 }]);
    mockClassify
      .mockResolvedValueOnce({ derivation: { status: 'derived' }, classification: makeClassification() })
      .mockResolvedValueOnce({ derivation: { status: 'derived' }, classification: makeClassification() });

    const report = await run({ apply: false, studentId: null, margin: 5 });

    expect(mockClassify).toHaveBeenCalledTimes(2);
    expect(report.students).toHaveLength(2);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('handles zero students with a baseline gracefully', async () => {
    mockFindAll.mockResolvedValueOnce([]);
    const report = await run({ apply: false, studentId: null, margin: 5 });
    expect(report.students).toHaveLength(0);
    expect(mockClassify).not.toHaveBeenCalled();
  });
});

// ─── Custom margin propagation ──────────────────────────────────────────────

describe('Custom --margin is propagated to the underlying service call', () => {
  it('dry-run passes margin through to classifyFamilyInitialization', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockClassify.mockResolvedValueOnce({ derivation: { status: 'derived' }, classification: makeClassification() });

    await run({ apply: false, studentId: 13, margin: 3 });

    expect(mockClassify).toHaveBeenCalledWith({ studentId: 13, margin: 3 });
  });

  it('apply passes margin through to createInitialFamilyThresholds', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockCreate.mockResolvedValueOnce(makeCreateResult());

    await run({ apply: true, studentId: 13, margin: 3 });

    expect(mockCreate).toHaveBeenCalledWith({ studentId: 13, margin: 3 });
  });
});
