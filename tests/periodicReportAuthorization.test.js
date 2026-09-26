'use strict';

// Proposal FR-19, Phase 7C — controller-level tests: date-range validation
// (items 1-4) + ownership (item 5), mirroring the established
// collectionControllerAuthorization.test.js pattern. The service itself is
// mocked here — its own content/temporal-semantics tests live in
// periodicReportContent.test.js.
const ApiError = require('../src/utils/ApiError');

const mockGetOwnStudentById = jest.fn();
const mockBuildPeriodicReport = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));
jest.mock('../src/services/periodicReportService', () => ({
  buildPeriodicReport: (...a) => mockBuildPeriodicReport(...a),
}));

const { getPeriodicReport } = require('../src/controllers/reportController');

const TEACHER_A_ID = 7;
const STUDENT_A_ID = 10;
const STUDENT_B_ID = 55;
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

function makeReq({ params, query } = {}) {
  return { user: { id: TEACHER_A_ID }, params: params ?? { studentId: String(STUDENT_A_ID) }, query: query ?? {} };
}
function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
  mockBuildPeriodicReport.mockResolvedValue({ metadata: { student_name: 'Test' } });
});

// ─── 1. valid date range ─────────────────────────────────────────────────
describe('valid date range', () => {
  it('resolves and delegates to the service', async () => {
    const res = makeRes();
    await getPeriodicReport(makeReq({ query: { start_date: '2026-01-01', end_date: '2026-06-30' } }), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(mockBuildPeriodicReport).toHaveBeenCalledWith(expect.objectContaining({
      studentId: STUDENT_A_ID, teacherId: TEACHER_A_ID, startDate: '2026-01-01', endDate: '2026-06-30',
    }));
    expect(res.json).toHaveBeenCalled();
  });
});

// ─── 2. invalid start date ───────────────────────────────────────────────
describe('invalid start date', () => {
  it('rejects a malformed start_date before touching ownership/service', async () => {
    const res = makeRes();
    await expect(getPeriodicReport(makeReq({ query: { start_date: 'nope', end_date: '2026-06-30' } }), res))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
    expect(mockBuildPeriodicReport).not.toHaveBeenCalled();
  });
});

// ─── 3. invalid end date ─────────────────────────────────────────────────
describe('invalid end date', () => {
  it('rejects a malformed end_date', async () => {
    const res = makeRes();
    await expect(getPeriodicReport(makeReq({ query: { start_date: '2026-01-01', end_date: 'nope' } }), res))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(mockBuildPeriodicReport).not.toHaveBeenCalled();
  });
});

// ─── 4. start > end rejected ─────────────────────────────────────────────
describe('start > end', () => {
  it('is rejected', async () => {
    const res = makeRes();
    await expect(getPeriodicReport(makeReq({ query: { start_date: '2026-06-30', end_date: '2026-01-01' } }), res))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(mockBuildPeriodicReport).not.toHaveBeenCalled();
  });
});

// ─── 5. unauthorized student rejected ────────────────────────────────────
describe('unauthorized student', () => {
  it("OTHER TEACHER'S STUDENT — rejected, the service is never invoked", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(getPeriodicReport(
      makeReq({ params: { studentId: String(STUDENT_B_ID) }, query: { start_date: '2026-01-01', end_date: '2026-06-30' } }),
      res
    )).rejects.toMatchObject({ statusCode: 404 });
    expect(mockBuildPeriodicReport).not.toHaveBeenCalled();
  });
});

describe('invalid studentId', () => {
  it('rejects a non-numeric studentId before parsing dates', async () => {
    const res = makeRes();
    await expect(getPeriodicReport(makeReq({ params: { studentId: 'abc' }, query: { start_date: '2026-01-01', end_date: '2026-06-30' } }), res))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });
});
