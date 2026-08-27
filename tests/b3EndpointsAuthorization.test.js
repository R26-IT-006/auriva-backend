'use strict';

// Final pre-PP2 fix — B-3: the five handwriting endpoints the exhaustive
// authorization re-audit found with NO ownership check at all. Mirrors the
// established pattern from motorBaselineControllerRetrieval.test.js /
// recordLetterCompletionAuthorization.test.js: mock teacherService +
// whatever models/services the function under test touches, assert the
// ownership check runs BEFORE any student-specific read/write, and that a
// rejected request produces zero downstream calls (zero writes for
// explainAssessment specifically).
const ApiError = require('../src/utils/ApiError');

const mockGetOwnStudentById = jest.fn();
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const mockHandwritingAssessmentFindOne = jest.fn();
const mockLetterProgressCount          = jest.fn();
const mockLetterAttemptFindAll         = jest.fn();
const mockExplanationResultCreate      = jest.fn();
const mockExplanationResultFindOne     = jest.fn();
const mockRecommendationHistoryCreate  = jest.fn();

jest.mock('../src/models', () => ({
  HandwritingAssessment: { findOne: (...a) => mockHandwritingAssessmentFindOne(...a) },
  LetterProgress:        { count:   (...a) => mockLetterProgressCount(...a) },
  LetterAttempt:         { findAll: (...a) => mockLetterAttemptFindAll(...a) },
  ExplanationResult:     { create: (...a) => mockExplanationResultCreate(...a), findOne: (...a) => mockExplanationResultFindOne(...a) },
  RecommendationHistory: { create: (...a) => mockRecommendationHistoryCreate(...a) },
  Student: {}, StudentMotorFeature: {}, ShapeFeature: {},
}));

const mockAnalyzeMotorDifficulty = jest.fn();
jest.mock('../src/services/explainabilityService', () => ({
  analyzeMotorDifficulty: (...a) => mockAnalyzeMotorDifficulty(...a),
}));

const {
  getProgress, explainAssessment, getLatestExplanation, getInitialReport, getLetterProgressReport,
} = require('../src/controllers/handwritingController');

const TEACHER_A_ID  = 7;
const STUDENT_A_ID  = 10;
const STUDENT_B_ID  = 55;
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
  mockHandwritingAssessmentFindOne.mockResolvedValue(null);
  mockLetterProgressCount.mockResolvedValue(0);
  mockLetterAttemptFindAll.mockResolvedValue([]);
  mockExplanationResultFindOne.mockResolvedValue(null);
});

// ─── 1/2. getProgress ────────────────────────────────────────────────────
describe('getProgress — GET /handwriting/progress/:studentId', () => {
  function makeReq(studentIdParam, userId = TEACHER_A_ID) {
    return { params: { studentId: studentIdParam }, user: { id: userId } };
  }

  it('OWN STUDENT — existing behavior unchanged (200, ownership checked with the right ids)', async () => {
    const res = makeRes();
    await getProgress(makeReq(String(STUDENT_A_ID)), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ lowercase_completed: 0, uppercase_completed: 0 }));
  });

  it("OTHER TEACHER'S STUDENT — rejected 404, no student-specific query ever runs", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(getProgress(makeReq(String(STUDENT_B_ID)), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockHandwritingAssessmentFindOne).not.toHaveBeenCalled();
    expect(mockLetterProgressCount).not.toHaveBeenCalled();
  });

  it('NONEXISTENT STUDENT — same safe 404 as an unowned student, no leak', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(getProgress(makeReq('999999'), res)).rejects.toMatchObject({ statusCode: 404, message: 'Student not found or not assigned to you' });
  });
});

// ─── 3/4/5. explainAssessment ───────────────────────────────────────────
describe('explainAssessment — POST /handwriting/explain', () => {
  function makeReq(overrides = {}, userId = TEACHER_A_ID) {
    return { user: { id: userId }, body: { student_id: STUDENT_A_ID, shapes: [{ shape_id: 'circle' }], ...overrides } };
  }

  beforeEach(() => {
    mockAnalyzeMotorDifficulty.mockReturnValue({
      difficultyKey: 'NONE', difficulty: 'None', confidence: 0.9, motorScore: 80,
      featureContributions: {}, featureContributionsMap: {}, explanation: [], recommendations: [], letterFocus: null,
    });
    mockExplanationResultCreate.mockResolvedValue({ id: 1 });
  });

  it('OWN STUDENT — existing behavior unchanged (201, ExplanationResult created)', async () => {
    const res = makeRes();
    await explainAssessment(makeReq(), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(mockExplanationResultCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("OTHER TEACHER'S STUDENT — rejected 404, ZERO writes of any kind", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(explainAssessment(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockExplanationResultCreate).not.toHaveBeenCalled();
    expect(mockRecommendationHistoryCreate).not.toHaveBeenCalled();
    expect(mockAnalyzeMotorDifficulty).not.toHaveBeenCalled(); // unauthorized request performs zero work of any kind
  });

  it('unauthorized explainAssessment creates zero rows even when the difficulty analysis would have recommended something', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    mockAnalyzeMotorDifficulty.mockReturnValue({ difficultyKey: 'WEAK_CURVE_CONTROL', difficulty: 'Weak curve control' });
    const res = makeRes();
    await expect(explainAssessment(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockExplanationResultCreate).not.toHaveBeenCalled();
    expect(mockRecommendationHistoryCreate).not.toHaveBeenCalled();
  });
});

// ─── 6/7. getLatestExplanation ───────────────────────────────────────────
describe('getLatestExplanation — GET /handwriting/explanation/:studentId', () => {
  function makeReq(studentIdParam, userId = TEACHER_A_ID) {
    return { params: { studentId: studentIdParam }, user: { id: userId } };
  }

  it('OWN STUDENT — existing behavior unchanged', async () => {
    const res = makeRes();
    await getLatestExplanation(makeReq(String(STUDENT_A_ID)), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(res.json).toHaveBeenCalledWith({ message: 'No explanation found for this student', data: null });
  });

  it("OTHER TEACHER'S STUDENT — rejected 404, the explanation is never read", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(getLatestExplanation(makeReq(String(STUDENT_B_ID)), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockExplanationResultFindOne).not.toHaveBeenCalled();
  });
});

// ─── 8/9. getInitialReport ────────────────────────────────────────────────
describe('getInitialReport — GET /handwriting/initial-report/:studentId', () => {
  function makeReq(studentIdParam, userId = TEACHER_A_ID) {
    return { params: { studentId: studentIdParam }, user: { id: userId } };
  }

  it('OWN STUDENT — existing behavior unchanged (hasData:false path when no assessment exists)', async () => {
    const res = makeRes();
    await getInitialReport(makeReq(String(STUDENT_A_ID)), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    // hasData is UNCHANGED — still "no renderable assessment row". The two
    // assessmentStatus* fields are ADDITIVE routing semantics (see
    // services/initialAssessmentStatusService.js). This suite stubs the
    // models, so the status read fails and correctly reports its own distinct
    // reason rather than claiming completeness it could not verify.
    expect(res.json).toHaveBeenCalledWith({
      hasData: false,
      assessmentStatus: 'incomplete',
      assessmentStatusReason: 'initial_assessment_status_read_failed',
      letterMastery: [],
    });
  });

  it("OTHER TEACHER'S STUDENT — rejected 404, no LetterAttempt/HandwritingAssessment read", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(getInitialReport(makeReq(String(STUDENT_B_ID)), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockLetterAttemptFindAll).not.toHaveBeenCalled();
    expect(mockHandwritingAssessmentFindOne).not.toHaveBeenCalled();
  });
});

// ─── 10/11. getLetterProgressReport ───────────────────────────────────────
describe('getLetterProgressReport — GET /handwriting/letter-progress-report/:studentId', () => {
  function makeReq(studentIdParam, userId = TEACHER_A_ID) {
    return { params: { studentId: studentIdParam }, user: { id: userId } };
  }

  it('OWN STUDENT — existing behavior unchanged', async () => {
    const res = makeRes();
    await getLetterProgressReport(makeReq(String(STUDENT_A_ID)), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ letters: [], motorPatterns: expect.any(Array) }));
  });

  it("OTHER TEACHER'S STUDENT — rejected 404, LetterAttempt never queried", async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(getLetterProgressReport(makeReq(String(STUDENT_B_ID)), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockLetterAttemptFindAll).not.toHaveBeenCalled();
  });
});
