'use strict';

// Verifies src/scripts/backfillMotorBaselines.js without hitting the real
// database or filesystem. validateMotorProfileForBaseline is left REAL
// (jest.requireActual) — it's a pure function, and using the genuine rules
// here is what proves the backfill script's score validation actually
// matches production, not a hand-rolled duplicate of the rules.
const mockStudentFindAll    = jest.fn(); // Student.findAll
const mockAssessmentFindOne = jest.fn(); // HandwritingAssessment.findOne
const mockBaselineFindOne   = jest.fn(); // StudentMotorBaseline.findOne
const mockCreateInitialMotorBaseline = jest.fn(); // motorBaselineService.createInitialMotorBaseline

jest.mock('fs'); // auto-mocked: existsSync/mkdirSync/writeFileSync all become no-op jest.fn()

jest.mock('../src/models', () => ({
  Student:               { findAll: mockStudentFindAll },
  HandwritingAssessment: { findOne: mockAssessmentFindOne },
  StudentMotorBaseline:  { findOne: mockBaselineFindOne },
}));

jest.mock('../src/services/motorBaselineService', () => {
  const actual = jest.requireActual('../src/services/motorBaselineService');
  return { ...actual, createInitialMotorBaseline: mockCreateInitialMotorBaseline };
});

const {
  parseArgs, evaluateCandidate, processStudent, buildSummary, classifyValidationReason, runBackfill,
} = require('../src/scripts/backfillMotorBaselines');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeAssessment(overrides = {}) {
  return {
    id:              100,
    student_id:      10,
    collection_mode: false,
    motor_score:     61,
    motor_profile:   { straightScore: 72, curvedScore: 46, complexScore: 58 },
    created_at:      new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeBaselineRow(overrides = {}) {
  return {
    id: 1, student_id: 10, source_assessment_id: 100,
    straight_score: 72, curved_score: 46, complex_score: 58, overall_motor_score: 61,
    baseline_version: 'baseline-v1', taxonomy_version: 'assessment-motor-v1',
    source_type: 'initial_assessment', is_backfilled: false, backfilled_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── CLI argument parsing ───────────────────────────────────────────────────

describe('parseArgs', () => {
  it('defaults to dry run with no flags', () => {
    expect(parseArgs([])).toEqual({ apply: false, studentId: null, limit: null });
  });
  it('parses --apply, --student-id=, --limit=', () => {
    expect(parseArgs(['--apply', '--student-id=10', '--limit=5']))
      .toEqual({ apply: true, studentId: 10, limit: 5 });
  });
  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });
  it.each(['abc', '0', '-1'])('rejects an invalid --limit value (%p)', (v) => {
    expect(() => parseArgs([`--limit=${v}`])).toThrow();
  });
});

// ─── Test 1 — Dry run creates nothing ──────────────────────────────────────

describe('Test 1 — dry run creates nothing', () => {
  it('reports WOULD_CREATE without calling the creation service', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);          // existingForStudent
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment());
    mockBaselineFindOne.mockResolvedValueOnce(null);          // existingBySource

    const res = await processStudent(10, { apply: false });

    expect(res.status).toBe('WOULD_CREATE');
    expect(res.scores).toEqual({ straight: 72, curved: 46, complex: 58, overall: 61 });
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Test 2 — Apply mode creates baseline ──────────────────────────────────

describe('Test 2 — apply mode creates baseline', () => {
  it('calls createInitialMotorBaseline with isBackfilled: true', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ id: 100, student_id: 10 }));
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 5 }, reason: null });

    const res = await processStudent(10, { apply: true });

    expect(mockCreateInitialMotorBaseline).toHaveBeenCalledWith({ studentId: 10, assessmentId: 100, isBackfilled: true });
    expect(res.status).toBe('CREATED');
    expect(res.baselineId).toBe(5);
  });
});

// ─── Test 3 — Earliest assessment chosen ───────────────────────────────────

describe('Test 3 — earliest assessment chosen', () => {
  it('queries with deterministic ordering: created_at ASC, id ASC', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ id: 1 }));
    mockBaselineFindOne.mockResolvedValueOnce(null);

    await evaluateCandidate(10);

    expect(mockAssessmentFindOne).toHaveBeenCalledWith({
      where: { student_id: 10, collection_mode: false },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });
  });
});

// ─── Test 4 — Same timestamp tiebreak ──────────────────────────────────────

describe('Test 4 — same-timestamp tiebreak', () => {
  it('the lower id is chosen when created_at is equal', async () => {
    const sameTime = new Date('2026-01-01T00:00:00Z');
    const fixtures = [
      makeAssessment({ id: 5, created_at: sameTime }),
      makeAssessment({ id: 2, created_at: sameTime }),
    ];
    mockBaselineFindOne.mockResolvedValueOnce(null);
    // Minimal simulation of Sequelize's ORDER BY, proving the tiebreak logic
    // — not just that the order clause is present (Test 3 covers that).
    mockAssessmentFindOne.mockImplementationOnce(async ({ order }) => {
      const sorted = [...fixtures].sort((a, b) => {
        for (const [field, dir] of order) {
          if (a[field] < b[field]) return dir === 'ASC' ? -1 : 1;
          if (a[field] > b[field]) return dir === 'ASC' ? 1 : -1;
        }
        return 0;
      });
      return sorted[0];
    });
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const res = await evaluateCandidate(10);

    expect(res.assessmentId).toBe(2);
  });
});

// ─── Test 5 — Collection assessments excluded ──────────────────────────────

describe('Test 5 — collection assessments excluded', () => {
  it('the earliest non-collection assessment is chosen even if an earlier collection one exists', async () => {
    const collectionAssessment = makeAssessment({ id: 1, collection_mode: true, created_at: new Date('2025-12-01T00:00:00Z') });
    const eligibleAssessment   = makeAssessment({ id: 2, collection_mode: false, created_at: new Date('2026-01-01T00:00:00Z') });
    const all = [collectionAssessment, eligibleAssessment];

    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockImplementationOnce(async ({ where }) => {
      const matches = all.filter(a => a.collection_mode === where.collection_mode);
      return matches.sort((a, b) => a.created_at - b.created_at || a.id - b.id)[0] ?? null;
    });
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const res = await evaluateCandidate(10);

    expect(res.assessmentId).toBe(2);
    expect(mockAssessmentFindOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { student_id: 10, collection_mode: false },
    }));
  });
});

// ─── Test 6 — Earliest non-collection incomplete, no fallback ─────────────

describe('Test 6 — earliest non-collection incomplete', () => {
  it('reports SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT for the earliest assessment, never falls back to a later one', async () => {
    // The query itself only ever returns ONE row (the earliest) — there is
    // structurally no way for the script to "see" Assessment 2 here.
    const incompleteEarliest = makeAssessment({ id: 1, motor_profile: { straightScore: 72, complexScore: 58 } }); // missing curved
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(incompleteEarliest);
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const res = await evaluateCandidate(10);

    expect(res.assessmentId).toBe(1);
    expect(res.status).toBe('SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT');
    expect(res.reason).toBe('missing_curved_score');
  });
});

// ─── Test 7 — No assessment ────────────────────────────────────────────────

describe('Test 7 — no assessment', () => {
  it('reports SKIPPED_NO_ASSESSMENT', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(null);

    const res = await evaluateCandidate(10);
    expect(res.status).toBe('SKIPPED_NO_ASSESSMENT');
  });
});

// ─── Test 8 — Existing baseline ────────────────────────────────────────────

describe('Test 8 — existing baseline', () => {
  it('reports SKIPPED_BASELINE_ALREADY_EXISTS, no write', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(makeBaselineRow({ id: 9 }));

    const res = await processStudent(10, { apply: true });

    expect(res.status).toBe('SKIPPED_BASELINE_ALREADY_EXISTS');
    expect(res.baselineId).toBe(9);
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Test 9 — Invalid score range ──────────────────────────────────────────

describe('Test 9 — invalid score range', () => {
  it('straightScore=105 reports SKIPPED_INVALID_SCORE, not clamped', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ motor_profile: { straightScore: 105, curvedScore: 46, complexScore: 58 } }));
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const res = await evaluateCandidate(10);

    expect(res.status).toBe('SKIPPED_INVALID_SCORE');
    expect(res.reason).toBe('straight_score_out_of_range');
  });
});

// ─── Test 10 — Missing family score ────────────────────────────────────────

describe('Test 10 — missing family score', () => {
  it('reports SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT with a precise reason', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ motor_profile: { curvedScore: 46, complexScore: 58 } }));
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const res = await evaluateCandidate(10);

    expect(res.status).toBe('SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT');
    expect(res.reason).toBe('missing_straight_score');
  });
});

// ─── Test 11 — Missing overall score ───────────────────────────────────────

describe('Test 11 — missing overall score', () => {
  it('skips without creating a baseline', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ motor_score: null }));
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const res = await processStudent(10, { apply: true });

    // invalid_overall_motor_score is classified SKIPPED_INVALID_SCORE here —
    // see classifyValidationReason()'s documented decision.
    expect(res.status).toBe('SKIPPED_INVALID_SCORE');
    expect(res.reason).toBe('invalid_overall_motor_score');
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Test 12 — One student's create failure ────────────────────────────────

describe('Test 12 — one students create failure does not stop others', () => {
  it('continues processing after a per-student failure', async () => {
    mockStudentFindAll.mockResolvedValueOnce([{ sid: 1 }, { sid: 2 }, { sid: 3 }]);

    // student 1 -> created
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ id: 101, student_id: 1 }));
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 1 }, reason: null });

    // student 2 -> service throws -> FAILED
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ id: 102, student_id: 2 }));
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockCreateInitialMotorBaseline.mockRejectedValueOnce(new Error('connection lost'));

    // student 3 -> created
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ id: 103, student_id: 3 }));
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 3 }, reason: null });

    const report = await runBackfill({ apply: true, studentId: null, limit: null });

    expect(report.results.map(r => r.status)).toEqual(['CREATED', 'FAILED', 'CREATED']);
    expect(report.summary.created).toBe(2);
    expect(report.summary.failed).toBe(1);
    expect(report.summary.studentsScanned).toBe(3);
  });
});

// ─── Test 13 — Existing source baseline ────────────────────────────────────

describe('Test 13 — existing source baseline', () => {
  it('reports SKIPPED_SOURCE_ALREADY_BACKFILLED', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null); // existingForStudent
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ id: 100 }));
    mockBaselineFindOne.mockResolvedValueOnce(makeBaselineRow({ id: 7, source_assessment_id: 100 })); // existingBySource

    const res = await evaluateCandidate(10);

    expect(res.status).toBe('SKIPPED_SOURCE_ALREADY_BACKFILLED');
    expect(res.baselineId).toBe(7);
  });
});

// ─── Test 14 — Student filter ──────────────────────────────────────────────

describe('Test 14 — student filter', () => {
  it('--student-id=10 only queries that student', async () => {
    mockStudentFindAll.mockResolvedValueOnce([{ sid: 10 }]);
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment());
    mockBaselineFindOne.mockResolvedValueOnce(null);

    await runBackfill({ apply: false, studentId: 10, limit: null });

    expect(mockStudentFindAll).toHaveBeenCalledWith({
      attributes: ['sid'], where: { sid: 10 }, order: [['sid', 'ASC']],
    });
  });
});

// ─── Test 15 — Dry-run report ──────────────────────────────────────────────

describe('Test 15 — dry-run report', () => {
  it('report has mode=dry-run and correct counters, no writes', async () => {
    mockStudentFindAll.mockResolvedValueOnce([{ sid: 10 }]);
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment());
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const report = await runBackfill({ apply: false, studentId: null, limit: null });

    expect(report.mode).toBe('dry-run');
    expect(report.summary.wouldCreate).toBe(1);
    expect(report.summary.created).toBe(0);
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Test 16 — Apply report ─────────────────────────────────────────────────

describe('Test 16 — apply report', () => {
  it('report has mode=apply and correct created/skipped/failed counts', async () => {
    mockStudentFindAll.mockResolvedValueOnce([{ sid: 10 }, { sid: 11 }]);

    // student 10 -> created
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment({ id: 100, student_id: 10 }));
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockCreateInitialMotorBaseline.mockResolvedValueOnce({ status: 'created', baseline: { id: 1 }, reason: null });

    // student 11 -> no assessment -> skipped
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(null);

    const report = await runBackfill({ apply: true, studentId: null, limit: null });

    expect(report.mode).toBe('apply');
    expect(report.summary.created).toBe(1);
    expect(report.summary.noAssessment).toBe(1);
    expect(report.summary.failed).toBe(0);
  });
});

// ─── Test 17 — No personal data in report ──────────────────────────────────

describe('Test 17 — no personal data in report', () => {
  it('report never contains name/email/teacherName/rawStrokes/motor_profile', async () => {
    mockStudentFindAll.mockResolvedValueOnce([{ sid: 10 }]);
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment());
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const report = await runBackfill({ apply: false, studentId: null, limit: null });
    const json = JSON.stringify(report);

    expect(json).not.toMatch(/"name"|"email"|teacherName|rawStrokes|motor_profile|full_name/i);
    // Only sid was ever requested from the students table.
    expect(mockStudentFindAll).toHaveBeenCalledWith(expect.objectContaining({ attributes: ['sid'] }));
  });
});

// ─── Bonus: major script-level failure vs. non-fatal report-write failure ──

describe('Major failure vs. non-fatal report-write failure', () => {
  it('propagates when students cannot be enumerated at all', async () => {
    mockStudentFindAll.mockRejectedValueOnce(new Error('connection refused'));

    await expect(runBackfill({ apply: false, studentId: null, limit: null })).rejects.toThrow('connection refused');
  });

  it('a report-write failure does not throw or lose the computed summary', async () => {
    mockStudentFindAll.mockResolvedValueOnce([{ sid: 10 }]);
    mockBaselineFindOne.mockResolvedValueOnce(null);
    mockAssessmentFindOne.mockResolvedValueOnce(makeAssessment());
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const fs = require('fs');
    fs.writeFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    const report = await runBackfill({ apply: false, studentId: null, limit: null });
    expect(report.summary.wouldCreate).toBe(1);
  });
});

// ─── classifyValidationReason (direct) ─────────────────────────────────────

describe('classifyValidationReason', () => {
  it.each([
    ['motor_profile_missing', 'SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT'],
    ['missing_straight_score', 'SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT'],
    ['straight_score_out_of_range', 'SKIPPED_INVALID_SCORE'],
    ['invalid_overall_motor_score', 'SKIPPED_INVALID_SCORE'],
  ])('%s -> %s', (reason, expected) => {
    expect(classifyValidationReason(reason)).toBe(expected);
  });
});

// ─── buildSummary (direct) ──────────────────────────────────────────────────

describe('buildSummary', () => {
  it('counts every status bucket correctly', () => {
    const results = [
      { status: 'WOULD_CREATE' }, { status: 'CREATED' },
      { status: 'SKIPPED_BASELINE_ALREADY_EXISTS' }, { status: 'SKIPPED_SOURCE_ALREADY_BACKFILLED' },
      { status: 'SKIPPED_NO_ASSESSMENT' }, { status: 'SKIPPED_INCOMPLETE_INITIAL_ASSESSMENT' },
      { status: 'SKIPPED_INVALID_SCORE' }, { status: 'FAILED' },
    ];
    expect(buildSummary(results)).toEqual({
      studentsScanned: 8, wouldCreate: 1, created: 1, alreadyHadBaseline: 2,
      noAssessment: 1, incompleteInitialAssessment: 1, invalidScore: 1, otherSkipped: 0, failed: 1,
    });
  });
});
