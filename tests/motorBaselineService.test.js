'use strict';

// Verifies motorBaselineService in isolation, without hitting the real
// database — same mocking approach as tests/collectionSessionPropagation.test.js.
// Mock function names below must start with "mock" so Jest's module-factory
// hoisting can reference them inside jest.mock(...).
const mockFindByPk         = jest.fn(); // HandwritingAssessment.findByPk
// The earliest-ELIGIBLE lookup walks the student's assessments in
// chronological order, so the service uses findAll. Backed by a plain list
// rather than a mockResolvedValueOnce queue: `jest.clearAllMocks()` does NOT
// drain a once-queue, so a test that returned early used to leave a queued
// value behind for the NEXT test to consume.
let assessmentCandidates = [];
const mockAssessmentFindOne = jest.fn(); // legacy handle, kept for assertions
const mockAssessmentFindAll = jest.fn(async () => assessmentCandidates);
const mockBaselineFindOne  = jest.fn(); // StudentMotorBaseline.findOne

// The selector now also requires linked initial-assessment shape evidence.
// Default: complete canonical evidence for every assessment queried, so an
// existing "this assessment is eligible" fixture still reads that way. Tests
// that care about missing/duplicate/non-finite evidence override it.
const CANONICAL_SHAPES = [
  'horizontal_line', 'vertical_line', 'full_circle', 'half_circle', 'zigzag', 'curve_wave',
];
const mockShapeFindAll = jest.fn(async (opts) => {
  const ids = opts?.where?.assessment_id;
  const list = Array.isArray(ids) ? ids : (ids == null ? [] : [ids]);
  return list.flatMap((assessment_id) =>
    CANONICAL_SHAPES.map((shape_type) => ({ assessment_id, shape_type, motor_score: 80 })));
});

const mockBaselineCreate   = jest.fn(); // StudentMotorBaseline.create

jest.mock('../src/models', () => ({
  HandwritingAssessment: {
    findByPk: mockFindByPk,
    findOne:  mockAssessmentFindOne,
    findAll:  mockAssessmentFindAll,
  },
  StudentMotorBaseline: {
    findOne: mockBaselineFindOne,
    create:  mockBaselineCreate,
  },
  ShapeFeature: { findAll: mockShapeFindAll },
}));

const { createInitialMotorBaseline, getStudentMotorBaseline } = require('../src/services/motorBaselineService');

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
    id:                    1,
    student_id:            10,
    source_assessment_id:  100,
    straight_score:        72,
    curved_score:          46,
    complex_score:         58,
    overall_motor_score:   61,
    baseline_version:      'baseline-v1',
    taxonomy_version:      'assessment-motor-v1',
    source_type:           'initial_assessment',
    is_backfilled:         false,
    backfilled_at:         null,
    ...overrides,
  };
}

// Queues the mock sequence for "assessment exists, belongs to student, not
// collection mode, and is the eligible earliest initial assessment" — the
// common setup shared by every test that needs to reach score validation.
function queueEligibleAssessment(assessment, { skipBaselineChecks = false } = {}) {
  mockFindByPk.mockResolvedValueOnce(assessment);
  assessmentCandidates = [assessment];
  if (!skipBaselineChecks) {
    mockBaselineFindOne.mockResolvedValueOnce(null); // source_assessment_id check
    mockBaselineFindOne.mockResolvedValueOnce(null); // student-level check
  }
}

beforeEach(() => {
  mockShapeFindAll.mockClear();
  // mockReset, not just clearAllMocks: `clearAllMocks` clears recorded calls
  // but NOT a pending mockResolvedValueOnce queue. Tests that return early
  // (e.g. an invalid profile now short-circuits before the baseline lookups)
  // would otherwise leave queued values behind for the NEXT test to consume,
  // which is exactly how an unrelated lookup test started failing.
  jest.clearAllMocks();
  mockFindByPk.mockReset();
  mockAssessmentFindOne.mockReset();
  mockBaselineFindOne.mockReset();
  mockBaselineCreate.mockReset();
  assessmentCandidates = [];
  mockAssessmentFindAll.mockReset();
  mockAssessmentFindAll.mockImplementation(async () => assessmentCandidates);
});

// ─── Test 1 — Successful creation ──────────────────────────────────────────

describe('Test 1 — successful creation', () => {
  it('creates a baseline copying the persisted scores verbatim', async () => {
    const assessment = makeAssessment();
    queueEligibleAssessment(assessment);
    mockBaselineCreate.mockResolvedValueOnce(makeBaselineRow());

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('created');
    expect(res.reason).toBeNull();
    expect(res.baseline.straight_score).toBe(72);
    expect(res.baseline.curved_score).toBe(46);
    expect(res.baseline.complex_score).toBe(58);
    expect(res.baseline.overall_motor_score).toBe(61);
    expect(res.baseline.baseline_version).toBe('baseline-v1');
    expect(res.baseline.taxonomy_version).toBe('assessment-motor-v1');
    expect(res.baseline.source_type).toBe('initial_assessment');

    expect(mockBaselineCreate).toHaveBeenCalledWith(expect.objectContaining({
      student_id:            10,
      source_assessment_id:  100,
      straight_score:        72,
      curved_score:          46,
      complex_score:         58,
      overall_motor_score:   61,
      baseline_version:      'baseline-v1',
      taxonomy_version:      'assessment-motor-v1',
      source_type:           'initial_assessment',
      is_backfilled:         false,
      backfilled_at:         null,
    }));
    // Service must never set created_at/updated_at itself.
    expect(mockBaselineCreate.mock.calls[0][0]).not.toHaveProperty('created_at');
    expect(mockBaselineCreate.mock.calls[0][0]).not.toHaveProperty('updated_at');
  });
});

// ─── Test 2 — Existing baseline (idempotency) ──────────────────────────────

describe('Test 2 — existing baseline', () => {
  it('second call for the same assessment returns already_exists, no duplicate row', async () => {
    const assessment = makeAssessment();
    const created     = makeBaselineRow();

    // First call: source+student checks both null, then create() succeeds.
    queueEligibleAssessment(assessment);
    mockBaselineCreate.mockResolvedValueOnce(created);

    // Second call: source check now finds the row created above.
    mockFindByPk.mockResolvedValueOnce(assessment);
    assessmentCandidates = [assessment];
    mockBaselineFindOne.mockResolvedValueOnce(created);

    const first  = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    const second = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(first.status).toBe('created');
    expect(second.status).toBe('already_exists');
    expect(second.baseline.id).toBe(first.baseline.id);
    expect(mockBaselineCreate).toHaveBeenCalledTimes(1);
  });
});

// ─── Test 3 — Student mismatch ─────────────────────────────────────────────

describe('Test 3 — student mismatch', () => {
  it('rejects when the assessment belongs to a different student', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessment({ student_id: 10 }));

    const res = await createInitialMotorBaseline({ studentId: 11, assessmentId: 100 });

    expect(res.status).toBe('student_mismatch');
    expect(res.baseline).toBeNull();
    expect(mockAssessmentFindAll).not.toHaveBeenCalled();
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });
});

// ─── Test 4 — Collection mode ──────────────────────────────────────────────

describe('Test 4 — collection mode', () => {
  it('rejects collection-mode assessments', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessment({ collection_mode: true }));

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('collection_assessment_not_eligible');
    expect(res.baseline).toBeNull();
    expect(mockAssessmentFindAll).not.toHaveBeenCalled();
  });
});

// ─── Test 5 — Later assessment ─────────────────────────────────────────────

describe('Test 5 — later assessment', () => {
  it('rejects a non-earliest assessment rather than treating it as initial', async () => {
    const assessment1 = makeAssessment({ id: 1, created_at: new Date('2026-01-01T00:00:00Z') });
    const assessment2 = makeAssessment({ id: 2, created_at: new Date('2026-02-01T00:00:00Z') });

    mockFindByPk.mockResolvedValueOnce(assessment2);
    assessmentCandidates = [assessment1, assessment2]; // assessment 1 is the earliest eligible

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 2 });

    expect(res.status).toBe('not_initial_assessment');
    expect(res.baseline).toBeNull();
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });
});

// ─── Test 6 — Missing motor profile ────────────────────────────────────────

describe('Test 6 — missing motor profile', () => {
  it('rejects a null motor_profile', async () => {
    const assessment = makeAssessment({ motor_profile: null });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('motor_profile_missing');
    expect(res.baseline).toBeNull();
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });
});

// ─── Test 7 — Missing straight score ───────────────────────────────────────

describe('Test 7 — missing straight score', () => {
  it('rejects with reason missing_straight_score', async () => {
    const assessment = makeAssessment({ motor_profile: { curvedScore: 46, complexScore: 58 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('missing_straight_score');
  });
});

// ─── Test 8 — Missing curved score ─────────────────────────────────────────

describe('Test 8 — missing curved score', () => {
  it('rejects with reason missing_curved_score', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: 72, complexScore: 58 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('missing_curved_score');
  });
});

// ─── Test 9 — Missing complex score ────────────────────────────────────────

describe('Test 9 — missing complex score', () => {
  it('rejects with reason missing_complex_score', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: 72, curvedScore: 46 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('missing_complex_score');
  });
});

// ─── Test 10 — Missing overall motor score ─────────────────────────────────

describe('Test 10 — missing overall motor score', () => {
  it('rejects with reason invalid_overall_motor_score', async () => {
    const assessment = makeAssessment({ motor_score: null });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('invalid_overall_motor_score');
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });
});

// ─── Test 11 — NaN / non-finite ─────────────────────────────────────────────

describe('Test 11 — NaN / non-finite values', () => {
  it('rejects NaN straightScore', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: NaN, curvedScore: 46, complexScore: 58 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('missing_straight_score');
  });

  it('rejects Infinity motor_score', async () => {
    const assessment = makeAssessment({ motor_score: Infinity });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('invalid_overall_motor_score');
  });

  it('rejects -Infinity curvedScore', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: 72, curvedScore: -Infinity, complexScore: 58 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('missing_curved_score');
  });
});

// ─── Test 12 — Out-of-range score ──────────────────────────────────────────

describe('Test 12 — out-of-range score', () => {
  it('rejects -1 without clamping', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: -1, curvedScore: 46, complexScore: 58 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('straight_score_out_of_range');
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });

  it('rejects 101 without clamping', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: 72, curvedScore: 46, complexScore: 101 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('complex_score_out_of_range');
  });

  it('rejects an out-of-range overall motor_score', async () => {
    const assessment = makeAssessment({ motor_score: 105 });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('invalid_overall_motor_score');
  });
});

// ─── Test 13 — Numeric string ──────────────────────────────────────────────

describe('Test 13 — numeric string', () => {
  // Decision: live-data inspection (Step 2 report) of every non-null
  // motor_profile row in the actual database found straightScore/curvedScore/
  // complexScore/motor_score are ALWAYS stored as genuine JSON numbers —
  // never as numeric strings. calculateMotorProfile() (the sole producer)
  // always returns Math.round() numbers, never strings. Since no legitimate
  // record has ever needed string coercion, a numeric string is rejected
  // outright and treated identically to a missing value, rather than parsed.
  it('rejects a well-formed numeric string ("72") as missing, not parsed', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: '72', curvedScore: 46, complexScore: 58 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('missing_straight_score');
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed numeric string ("72abc")', async () => {
    const assessment = makeAssessment({ motor_profile: { straightScore: '72abc', curvedScore: 46, complexScore: 58 } });
    queueEligibleAssessment(assessment);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });
    expect(res.status).toBe('invalid_motor_profile');
    expect(res.reason).toBe('missing_straight_score');
  });
});

// ─── Test 14 — Existing student baseline from another assessment ──────────

describe('Test 14 — student already has a baseline from a different assessment', () => {
  it('blocks a second normal baseline for the same student', async () => {
    // Isolated unit test of the student-level guard: the eligibility check
    // (earliest-assessment lookup) is mocked to pass for assessment 200 so
    // this guard can be exercised on its own, independent of Test 5's
    // eligibility logic which is already covered separately.
    const assessmentB      = makeAssessment({ id: 200, student_id: 10 });
    const existingBaseline = makeBaselineRow({ id: 1, source_assessment_id: 100, student_id: 10 });

    mockFindByPk.mockResolvedValueOnce(assessmentB);
    assessmentCandidates = [assessmentB];
    mockBaselineFindOne.mockResolvedValueOnce(null);              // source_assessment_id=200 → none
    mockBaselineFindOne.mockResolvedValueOnce(existingBaseline);  // student-level → found (from assessment 100)

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 200 });

    expect(res.status).toBe('student_baseline_already_exists');
    expect(res.baseline.id).toBe(existingBaseline.id);
    expect(mockBaselineCreate).not.toHaveBeenCalled();
  });
});

// ─── Test 15 — Race condition ──────────────────────────────────────────────

describe('Test 15 — race condition', () => {
  it('resolves a UniqueConstraintError on create() to already_exists', async () => {
    const assessment = makeAssessment();
    const raceRow     = makeBaselineRow({ id: 42 });

    mockFindByPk.mockResolvedValueOnce(assessment);
    assessmentCandidates = [assessment];
    mockBaselineFindOne
      .mockResolvedValueOnce(null)     // source check (before insert attempt)
      .mockResolvedValueOnce(null)     // student check
      .mockResolvedValueOnce(raceRow); // source re-check after the race

    const uniqueErr = new Error('duplicate key value violates unique constraint');
    uniqueErr.name = 'SequelizeUniqueConstraintError';
    mockBaselineCreate.mockRejectedValueOnce(uniqueErr);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100 });

    expect(res.status).toBe('already_exists');
    expect(res.baseline.id).toBe(42);
  });
});

// ─── Test 16 — Unexpected DB failure ───────────────────────────────────────

describe('Test 16 — unexpected DB failure', () => {
  it('returns save_failed when create() fails for a non-race reason, without throwing', async () => {
    const assessment = makeAssessment();
    queueEligibleAssessment(assessment);
    mockBaselineCreate.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    await expect(createInitialMotorBaseline({ studentId: 10, assessmentId: 100 }))
      .resolves.toEqual({ status: 'save_failed', baseline: null, reason: null });
  });

  it('returns save_failed when the initial lookup itself fails, without throwing', async () => {
    mockFindByPk.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(createInitialMotorBaseline({ studentId: 10, assessmentId: 100 }))
      .resolves.toEqual({ status: 'save_failed', baseline: null, reason: null });
  });
});

// ─── Test 17 — Backfilled flag ─────────────────────────────────────────────

describe('Test 17 — backfilled flag', () => {
  it('sets is_backfilled and backfilled_at when isBackfilled: true', async () => {
    const assessment = makeAssessment();
    queueEligibleAssessment(assessment);
    mockBaselineCreate.mockResolvedValueOnce(makeBaselineRow({ is_backfilled: true, backfilled_at: new Date() }));

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 100, isBackfilled: true });

    expect(res.status).toBe('created');
    expect(mockBaselineCreate).toHaveBeenCalledWith(expect.objectContaining({
      is_backfilled: true,
      backfilled_at: expect.any(Date),
    }));
  });
});

// ─── Invalid input (identifier validation) ─────────────────────────────────

describe('Invalid input', () => {
  it.each([
    [null, 100], [undefined, 100], [NaN, 100], ['10', 100], [-1, 100], [0, 100],
  ])('rejects an invalid studentId (%p)', async (studentId, assessmentId) => {
    const res = await createInitialMotorBaseline({ studentId, assessmentId });
    expect(res.status).toBe('invalid_input');
    expect(res.reason).toBe('invalid_student_id');
    expect(mockFindByPk).not.toHaveBeenCalled();
  });

  it.each([
    [10, null], [10, undefined], [10, NaN], [10, '100'], [10, -1], [10, 0],
  ])('rejects an invalid assessmentId (studentId=%p, assessmentId=%p)', async (studentId, assessmentId) => {
    const res = await createInitialMotorBaseline({ studentId, assessmentId });
    expect(res.status).toBe('invalid_input');
    expect(res.reason).toBe('invalid_assessment_id');
    expect(mockFindByPk).not.toHaveBeenCalled();
  });
});

// ─── Assessment not found ───────────────────────────────────────────────────

describe('Source assessment not found', () => {
  it('returns source_assessment_not_found when findByPk resolves null', async () => {
    mockFindByPk.mockResolvedValueOnce(null);

    const res = await createInitialMotorBaseline({ studentId: 10, assessmentId: 999 });

    expect(res.status).toBe('source_assessment_not_found');
    expect(res.baseline).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════
// getStudentMotorBaseline — read-only retrieval (Step 4)
// ═════════════════════════════════════════════════════════════════════════

// ─── Test A — Successful lookup ─────────────────────────────────────────────

describe('Test A — successful lookup', () => {
  it('returns status=found with the existing baseline row', async () => {
    const row = makeBaselineRow({ id: 15, student_id: 10 });
    mockBaselineFindOne.mockResolvedValueOnce(row);

    const res = await getStudentMotorBaseline({ studentId: 10 });

    expect(res.status).toBe('found');
    expect(res.baseline).toBe(row);
    expect(res.reason).toBeNull();
  });
});

// ─── Test B — Missing baseline ──────────────────────────────────────────────

describe('Test B — missing baseline', () => {
  it('returns baseline_not_found when no row exists', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(null);

    const res = await getStudentMotorBaseline({ studentId: 10 });

    expect(res.status).toBe('baseline_not_found');
    expect(res.baseline).toBeNull();
  });
});

// ─── Test C — Invalid ID ─────────────────────────────────────────────────────

describe('Test C — invalid student id', () => {
  it.each([
    [null], [undefined], [NaN], [0], [-1], ['10'],
  ])('rejects %p as invalid_input without querying the database', async (studentId) => {
    const res = await getStudentMotorBaseline({ studentId });

    expect(res.status).toBe('invalid_input');
    expect(res.baseline).toBeNull();
    expect(mockBaselineFindOne).not.toHaveBeenCalled();
  });
});

// ─── Test D — DB failure ─────────────────────────────────────────────────────

describe('Test D — DB failure', () => {
  it('returns read_failed without throwing', async () => {
    mockBaselineFindOne.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

    await expect(getStudentMotorBaseline({ studentId: 10 }))
      .resolves.toEqual({ status: 'read_failed', baseline: null, reason: null });
  });
});

// ─── Test E — Deterministic lookup ──────────────────────────────────────────

describe('Test E — deterministic lookup', () => {
  it('queries by student_id + source_type=initial_assessment with deterministic ordering', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(makeBaselineRow());

    await getStudentMotorBaseline({ studentId: 10 });

    expect(mockBaselineFindOne).toHaveBeenCalledWith({
      where: { student_id: 10, source_type: 'initial_assessment' },
      order: [['created_at', 'ASC'], ['id', 'ASC']],
    });
  });

  it('never queries HandwritingAssessment — StudentMotorBaseline is the sole source', async () => {
    mockBaselineFindOne.mockResolvedValueOnce(makeBaselineRow());

    await getStudentMotorBaseline({ studentId: 10 });

    expect(mockFindByPk).not.toHaveBeenCalled();
    expect(mockAssessmentFindAll).not.toHaveBeenCalled();
  });
});
