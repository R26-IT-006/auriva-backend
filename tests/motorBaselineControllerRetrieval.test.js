'use strict';

// Verifies GET /handwriting/motor-baseline/:studentId (handwritingController.getMotorBaseline)
// in isolation. teacherService and motorBaselineService are mocked; handwritingController's
// own require('../models') is left real (harmless — defining Sequelize models makes no DB
// connection, see Step 1 verification), so no DB mock is needed for this file at all.
const mockGetOwnStudentById       = jest.fn(); // teacherService.getOwnStudentById
const mockGetStudentMotorBaseline = jest.fn(); // motorBaselineService.getStudentMotorBaseline

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: mockGetOwnStudentById,
}));

jest.mock('../src/services/motorBaselineService', () => ({
  createInitialMotorBaseline: jest.fn(),
  getStudentMotorBaseline:    mockGetStudentMotorBaseline,
}));

const { getMotorBaseline } = require('../src/controllers/handwritingController');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeBaselineRow(overrides = {}) {
  return {
    id:                    15,
    student_id:            10,
    source_assessment_id:  101,
    straight_score:        72,
    curved_score:          46,
    complex_score:         58,
    overall_motor_score:   61,
    baseline_version:      'baseline-v1',
    taxonomy_version:      'assessment-motor-v1',
    source_type:           'initial_assessment',
    is_backfilled:         false,
    backfilled_at:         null,
    created_at:            new Date('2026-08-07T00:00:00Z'),
    ...overrides,
  };
}

function makeReq(studentIdParam, userId = 5) {
  return { params: { studentId: studentIdParam }, user: { id: userId, role: 'teacher' } };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: requesting teacher owns the student, unless a test overrides it.
  mockGetOwnStudentById.mockResolvedValue({ sid: 10, teacher_id: 5 });
});

// ─── Test 1 — Valid route + baseline exists ────────────────────────────────

describe('Test 1 — valid route, baseline exists', () => {
  it('responds 200 with the serialized baseline', async () => {
    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'found', baseline: makeBaselineRow(), reason: null });

    const res = await callRoute('10');

    expect(res.status).not.toHaveBeenCalled(); // default 200
    expect(res.json).toHaveBeenCalledWith({
      status: 'found',
      baseline: expect.objectContaining({
        id: 15,
        studentId: 10,
        scores: { straight: 72, curved: 46, complex: 58, overall: 61 },
      }),
    });
  });
});

// ─── Test 2 — No baseline ───────────────────────────────────────────────────

describe('Test 2 — no baseline', () => {
  it('responds 404 with baseline_not_found', async () => {
    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'baseline_not_found', baseline: null, reason: null });

    const res = await callRoute('10');

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ status: 'baseline_not_found', baseline: null });
  });
});

// ─── Test 3 — Invalid route parameter ──────────────────────────────────────

describe('Test 3 — invalid route parameter', () => {
  it.each(['abc', '10abc', '0', '-4', '', 'NaN'])('rejects %p with a 422 validation error, no service call', async (param) => {
    await expect(getMotorBaseline(makeReq(param), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
    expect(mockGetStudentMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Test 4 — Read failure ──────────────────────────────────────────────────

describe('Test 4 — read failure', () => {
  it('responds with the standard 500 server-error handling', async () => {
    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'read_failed', baseline: null, reason: null });

    await expect(getMotorBaseline(makeReq('10'), makeRes())).rejects.toMatchObject({ statusCode: 500 });
  });
});

// ─── Test 5 — Serialization ─────────────────────────────────────────────────

describe('Test 5 — serialization', () => {
  it('maps every snake_case DB field to its camelCase API field', async () => {
    const row = makeBaselineRow({
      id: 99, student_id: 10, source_assessment_id: 200,
      straight_score: 11, curved_score: 22, complex_score: 33, overall_motor_score: 44,
      baseline_version: 'baseline-v1', taxonomy_version: 'assessment-motor-v1',
      source_type: 'initial_assessment', is_backfilled: true,
      backfilled_at: new Date('2026-08-01T00:00:00Z'), created_at: new Date('2026-07-01T00:00:00Z'),
    });
    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'found', baseline: row, reason: null });

    const res = await callRoute('10');
    const body = res.json.mock.calls[0][0];

    // `summary` is the additive Initial Motor Baseline Summary — asserted
    // separately below so this exact-shape check stays focused on the
    // pre-existing contract fields, all of which are unchanged.
    const { summary, ...contractFields } = body.baseline;
    expect(contractFields).toEqual({
      id: 99,
      studentId: 10,
      sourceAssessmentId: 200,
      scores: { straight: 11, curved: 22, complex: 33, overall: 44 },
      baselineVersion: 'baseline-v1',
      taxonomyVersion: 'assessment-motor-v1',
      sourceType: 'initial_assessment',
      isBackfilled: true,
      backfilledAt: row.backfilled_at,
      createdAt: row.created_at,
    });
  });

  it('carries a deterministic Initial Motor Baseline Summary derived from the same four scores', async () => {
    const row = makeBaselineRow({
      straight_score: 11, curved_score: 22, complex_score: 33, overall_motor_score: 44,
    });
    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'found', baseline: row, reason: null });

    const res = await callRoute('10');
    const { summary } = res.json.mock.calls[0][0].baseline;

    expect(summary.available).toBe(true);
    expect(summary.overall_score).toBe(44);
    expect(summary.families).toEqual({ straight: 11, curved: 22, complex: 33 });
    expect(summary.relative_summary.highest).toBe('complex');
    expect(summary.relative_summary.lowest).toBe('straight');
    expect(summary.relative_summary.spread).toBe(22);
    expect(summary.disclosure).toContain('not diagnostic or ASD-severity measures');

    // No clustering terminology may ever reach the teacher through this payload.
    expect(JSON.stringify(summary)).not.toMatch(/Profile A|Profile B|Distinct Motor Profile|cluster|centroid|confidence|probability/i);
  });
});

// ─── Test 6 — No database internals leaked ─────────────────────────────────

describe('Test 6 — no database internals leaked', () => {
  it('never exposes dataValues / _previousDataValues / sequelize internals', async () => {
    // Simulates what a real Sequelize instance carries alongside its own
    // column values — the serializer must build an explicit new object,
    // never spread or return the row as-is.
    const rawLikeRow = makeBaselineRow();
    rawLikeRow.dataValues = { ...rawLikeRow };
    rawLikeRow._previousDataValues = { ...rawLikeRow };
    rawLikeRow.sequelize = { config: { password: 'super-secret' } };
    rawLikeRow._changed = new Set();

    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'found', baseline: rawLikeRow, reason: null });

    const res = await callRoute('10');
    const body = res.json.mock.calls[0][0];

    expect(Object.keys(body.baseline).sort()).toEqual([
      'backfilledAt', 'baselineVersion', 'createdAt', 'id', 'isBackfilled',
      'scores', 'sourceAssessmentId', 'sourceType', 'studentId', 'summary', 'taxonomyVersion',
    ].sort());
    expect(body.baseline.dataValues).toBeUndefined();
    expect(body.baseline._previousDataValues).toBeUndefined();
    expect(body.baseline.sequelize).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('super-secret');
  });
});

// ─── Test 7 — Authorization ─────────────────────────────────────────────────

describe('Test 7 — authorization', () => {
  it('an authorized teacher (owns the student) can retrieve the baseline', async () => {
    mockGetOwnStudentById.mockResolvedValueOnce({ sid: 10, teacher_id: 5 });
    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'found', baseline: makeBaselineRow(), reason: null });

    await getMotorBaseline(makeReq('10', 5), makeRes());

    expect(mockGetOwnStudentById).toHaveBeenCalledWith(5, 10);
    expect(mockGetStudentMotorBaseline).toHaveBeenCalledWith({ studentId: 10 });
  });

  it('denies a teacher who does not own the student, and never calls the baseline lookup', async () => {
    const notOwnedError = Object.assign(new Error('Student not found or not assigned to you'), { statusCode: 404 });
    mockGetOwnStudentById.mockRejectedValueOnce(notOwnedError);

    await expect(getMotorBaseline(makeReq('10', 999), makeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockGetStudentMotorBaseline).not.toHaveBeenCalled();
  });
});

// ─── Helper ─────────────────────────────────────────────────────────────────

async function callRoute(studentIdParam, userId = 5) {
  const res = makeRes();
  await getMotorBaseline(makeReq(studentIdParam, userId), res);
  return res;
}
