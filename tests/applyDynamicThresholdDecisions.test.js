'use strict';

// Feature 2 Step 6B — applyDynamicThresholdDecisions CLI's argument parsing
// and dry-run/apply dispatch without hitting the real database. The
// critical property under test: dry-run mode must NEVER call the writing
// function (mirrors tests/initializeFamilyThresholds.test.js exactly).
const mockFindAll  = jest.fn();
const mockClassify = jest.fn();
const mockPersist  = jest.fn();

jest.mock('../src/models', () => ({
  StudentMotorBaseline: { findAll: (...args) => mockFindAll(...args) },
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  RECENT_FAMILY_WINDOW_SIZE: 5,
  THRESHOLD_INCREASE_STEP: 5,
  classifyAutomaticThresholdPersistence: (...args) => mockClassify(...args),
  persistAutomaticThresholdDecisions: (...args) => mockPersist(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, findStudentIdsWithBaselines, run } = require('../src/scripts/applyDynamicThresholdDecisions');

function makeClassification(overrides = {}) {
  return {
    status: 'classified', studentId: 13, mappingVersion: 'letter-baseline-family-v1', windowSize: 5, increaseStep: 5,
    families: {
      straight: { action: 'skipped_insufficient_data', reason: 'insufficient_window' },
      curved:   { action: 'skipped_insufficient_data', reason: 'insufficient_window' },
      complex:  { action: 'skipped_insufficient_data', reason: 'insufficient_window' },
    },
    ...overrides,
  };
}

function makePersistResult(overrides = {}) {
  return {
    status: 'no_eligible_families', studentId: 13, windowSize: 5, increaseStep: 5,
    families: {
      straight: { status: 'skipped_insufficient_data', reason: 'insufficient_window', historyId: null, newThreshold: null },
      curved:   { status: 'skipped_insufficient_data', reason: 'insufficient_window', historyId: null, newThreshold: null },
      complex:  { status: 'skipped_insufficient_data', reason: 'insufficient_window', historyId: null, newThreshold: null },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to dry-run, no student filter, default window/increase-step', () => {
    expect(parseArgs([])).toEqual({ apply: false, studentId: null, windowSize: 5, increaseStep: 5 });
  });

  it('parses --apply', () => {
    expect(parseArgs(['--apply'])).toEqual({ apply: true, studentId: null, windowSize: 5, increaseStep: 5 });
  });

  it('parses --student-id=13', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ apply: false, studentId: 13, windowSize: 5, increaseStep: 5 });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });

  it('parses --window-size=8', () => {
    expect(parseArgs(['--window-size=8'])).toEqual({ apply: false, studentId: null, windowSize: 8, increaseStep: 5 });
  });

  it.each(['abc', '0', '-1', '2.5'])('rejects an invalid --window-size value (%p)', (v) => {
    expect(() => parseArgs([`--window-size=${v}`])).toThrow();
  });

  it('parses --increase-step=3', () => {
    expect(parseArgs(['--increase-step=3'])).toEqual({ apply: false, studentId: null, windowSize: 5, increaseStep: 3 });
  });

  it('parses --increase-step=0 (allowed)', () => {
    expect(parseArgs(['--increase-step=0'])).toEqual({ apply: false, studentId: null, windowSize: 5, increaseStep: 0 });
  });

  it.each(['abc', '-1'])('rejects an invalid --increase-step value (%p)', (v) => {
    expect(() => parseArgs([`--increase-step=${v}`])).toThrow();
  });

  it('combines --apply, --student-id, --window-size, --increase-step', () => {
    expect(parseArgs(['--apply', '--student-id=13', '--window-size=3', '--increase-step=2']))
      .toEqual({ apply: true, studentId: 13, windowSize: 3, increaseStep: 2 });
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
  it('calls classifyAutomaticThresholdPersistence only — persistAutomaticThresholdDecisions is never referenced', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockClassify.mockResolvedValueOnce(makeClassification());

    const report = await run({ apply: false, studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(mockClassify).toHaveBeenCalledWith({ studentId: 13, windowSize: 5, increaseStep: 5 });
    expect(mockPersist).not.toHaveBeenCalled();
    expect(report.mode).toBe('dry-run');
    expect(report.students[0].classification.families.curved.action).toBe('skipped_insufficient_data');
  });

  it('a would_create classification is reported in dry-run without writing', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockClassify.mockResolvedValueOnce(makeClassification({
      families: {
        straight: { action: 'skipped_no_target', reason: 'target_not_initialized' },
        curved:   { action: 'would_create', reason: '4_or_5_met_target', row: { old_threshold: 88, new_threshold: 93 }, evidenceFingerprint: 'abc123' },
        complex:  { action: 'skipped_no_target', reason: 'target_not_initialized' },
      },
    }));

    const report = await run({ apply: false, studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(report.students[0].classification.families.curved.action).toBe('would_create');
    expect(mockPersist).not.toHaveBeenCalled();
  });
});

// ─── Apply mode: writes via persistAutomaticThresholdDecisions ────────────

describe('Apply mode writes via persistAutomaticThresholdDecisions', () => {
  it('calls persistAutomaticThresholdDecisions, not classifyAutomaticThresholdPersistence', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockPersist.mockResolvedValueOnce(makePersistResult({
      status: 'created',
      families: {
        straight: { status: 'skipped_no_target', reason: 'target_not_initialized', historyId: null, newThreshold: null },
        curved:   { status: 'created', reason: null, historyId: 4, newThreshold: 93 },
        complex:  { status: 'skipped_no_target', reason: 'target_not_initialized', historyId: null, newThreshold: null },
      },
    }));

    const report = await run({ apply: true, studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(mockPersist).toHaveBeenCalledWith({ studentId: 13, windowSize: 5, increaseStep: 5 });
    expect(mockClassify).not.toHaveBeenCalled();
    expect(report.mode).toBe('apply');
    expect(report.summary.created).toBe(1);
  });

  it('a second apply with unchanged evidence reports already_persisted', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockPersist.mockResolvedValueOnce(makePersistResult({
      status: 'already_persisted',
      families: {
        straight: { status: 'skipped_no_target', reason: 'target_not_initialized', historyId: null, newThreshold: null },
        curved:   { status: 'already_persisted', reason: null, historyId: 4, newThreshold: 93 },
        complex:  { status: 'skipped_no_target', reason: 'target_not_initialized', historyId: null, newThreshold: null },
      },
    }));

    const report = await run({ apply: true, studentId: 13, windowSize: 5, increaseStep: 5 });

    expect(report.summary.created).toBe(0);
    expect(report.summary.alreadyPersisted).toBe(1);
  });
});

// ─── Unscoped dry-run ───────────────────────────────────────────────────────

describe('Unscoped dry-run (no --student-id)', () => {
  it('processes every student with a baseline', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 5 }, { student_id: 13 }]);
    mockClassify
      .mockResolvedValueOnce(makeClassification({ studentId: 5 }))
      .mockResolvedValueOnce(makeClassification({ studentId: 13 }));

    const report = await run({ apply: false, studentId: null, windowSize: 5, increaseStep: 5 });

    expect(mockClassify).toHaveBeenCalledTimes(2);
    expect(report.students).toHaveLength(2);
    expect(mockPersist).not.toHaveBeenCalled();
  });

  it('handles zero students with a baseline gracefully', async () => {
    mockFindAll.mockResolvedValueOnce([]);
    const report = await run({ apply: false, studentId: null, windowSize: 5, increaseStep: 5 });
    expect(report.students).toHaveLength(0);
    expect(mockClassify).not.toHaveBeenCalled();
  });
});

// ─── Custom window-size / increase-step propagation ────────────────────────

describe('Custom --window-size / --increase-step are propagated', () => {
  it('dry-run passes both through to classifyAutomaticThresholdPersistence', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockClassify.mockResolvedValueOnce(makeClassification());

    await run({ apply: false, studentId: 13, windowSize: 8, increaseStep: 3 });

    expect(mockClassify).toHaveBeenCalledWith({ studentId: 13, windowSize: 8, increaseStep: 3 });
  });

  it('apply passes both through to persistAutomaticThresholdDecisions', async () => {
    mockFindAll.mockResolvedValueOnce([{ student_id: 13 }]);
    mockPersist.mockResolvedValueOnce(makePersistResult());

    await run({ apply: true, studentId: 13, windowSize: 8, increaseStep: 3 });

    expect(mockPersist).toHaveBeenCalledWith({ studentId: 13, windowSize: 8, increaseStep: 3 });
  });
});
