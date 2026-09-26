'use strict';

// Pre-device P0 fix — Blocker 2, finalizeAssessment(). Special case (spec
// §10): this endpoint takes NO student_id — only an assessment id in the
// URL. Ownership must be derived from the ALREADY-LOADED assessment row's
// own student_id, never a client-supplied value, and verified BEFORE
// classifyFinalizeRequest/assessment.update/ExplanationResult/
// RecommendationHistory/createInitialMotorBaseline can run. Proves an
// attacker who knows another teacher's assessment id still cannot
// finalize it or touch that student's baseline.
const ApiError = require('../src/utils/ApiError');

const mockFindByPk             = jest.fn();
const mockExplanationFindAll   = jest.fn();
const mockExplanationCreate    = jest.fn();
const mockRecommendationCreate = jest.fn();
const mockAnalyzeMotorDifficulty     = jest.fn();
const mockCreateInitialMotorBaseline = jest.fn();
const mockCreateInitialFamilyThresholds = jest.fn();
const mockGetOwnStudentById = jest.fn();

jest.mock('../src/models', () => ({
  HandwritingAssessment: { findByPk: (...a) => mockFindByPk(...a) },
  ExplanationResult:     { findAll: (...a) => mockExplanationFindAll(...a), create: (...a) => mockExplanationCreate(...a) },
  RecommendationHistory: { create: (...a) => mockRecommendationCreate(...a) },
}));
jest.mock('../src/services/explainabilityService', () => ({ analyzeMotorDifficulty: (...a) => mockAnalyzeMotorDifficulty(...a) }));
jest.mock('../src/services/motorBaselineService', () => ({ createInitialMotorBaseline: (...a) => mockCreateInitialMotorBaseline(...a) }));
jest.mock('../src/services/dynamicThresholdService', () => ({
  createInitialFamilyThresholds: (...a) => mockCreateInitialFamilyThresholds(...a),
  processDynamicThresholdAfterLetterSession: jest.fn(),
}));
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

const { finalizeAssessment } = require('../src/controllers/handwritingController');

const TEACHER_A_ID = 7;
const STUDENT_A_ID = 10; // owned by Teacher A
const ASSESSMENT_ID = 101; // belongs to STUDENT_A_ID
const OTHER_STUDENT_ASSESSMENT_ID = 202; // belongs to a DIFFERENT teacher's student

function makeAssessmentInstance(overrides = {}) {
  const instance = { id: ASSESSMENT_ID, student_id: STUDENT_A_ID, is_initial: true, shapes: [], motor_score: null, motor_profile: null, ...overrides };
  instance.update = jest.fn(async (fields) => { Object.assign(instance, fields); return instance; });
  return instance;
}
function makeReq(overrides = {}) {
  return {
    user: { id: TEACHER_A_ID },
    params: { id: String(ASSESSMENT_ID) },
    body: { motor_score: 61, motor_profile: { straightScore: 72, curvedScore: 46, complexScore: 58 }, ...overrides },
  };
}
function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

function expectNoBaselineConsequences() {
  expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
  expect(mockExplanationCreate).not.toHaveBeenCalled();
  expect(mockRecommendationCreate).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
  mockFindByPk.mockResolvedValue(makeAssessmentInstance());
  mockExplanationFindAll.mockResolvedValue([]);
  mockExplanationCreate.mockResolvedValue({ id: 1 });
  mockRecommendationCreate.mockResolvedValue({ id: 1 });
  mockAnalyzeMotorDifficulty.mockReturnValue({ difficultyKey: 'NONE', difficulty: 'Good Motor Control', confidence: null, featureContributions: [], explanation: [], recommendations: [] });
  mockCreateInitialMotorBaseline.mockResolvedValue({ status: 'created', baseline: { id: 5 }, reason: null });
  mockCreateInitialFamilyThresholds.mockResolvedValue({ status: 'created', studentId: STUDENT_A_ID, baselineId: 5, created: {} });
});

describe('OWN STUDENT — success path unchanged', () => {
  it('finalizes normally and derives ownership from assessment.student_id', async () => {
    const res = makeRes();
    await finalizeAssessment(makeReq(), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    // finalizeAssessment responds via res.json(...) directly (200 is
    // Express's implicit default — .status() is never called on success).
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Assessment finalized' }));
  });
});

describe('ASSESSMENT/STUDENT BELONGING TO ANOTHER TEACHER — rejected before any mutation', () => {
  it('rejects with 404, and does not update the assessment, create explanations, or touch the baseline', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance({ id: OTHER_STUDENT_ASSESSMENT_ID, student_id: 999 }));
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();

    await expect(finalizeAssessment(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    // Ownership must have been checked against the REAL assessment.student_id (999), not a body value.
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, 999);
    expectNoBaselineConsequences();
  });

  it('the assessment.update() call the instance itself tracks is never invoked', async () => {
    const assessment = makeAssessmentInstance({ id: OTHER_STUDENT_ASSESSMENT_ID, student_id: 999 });
    mockFindByPk.mockResolvedValueOnce(assessment);
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(finalizeAssessment(makeReq(), res)).rejects.toThrow();
    expect(assessment.update).not.toHaveBeenCalled();
  });

  it('cannot create OR alter a StudentMotorBaseline for the other student', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance({ id: OTHER_STUDENT_ASSESSMENT_ID, student_id: 999 }));
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(finalizeAssessment(makeReq(), res)).rejects.toThrow();
    expect(mockCreateInitialMotorBaseline).not.toHaveBeenCalled();
  });
});

describe('NONEXISTENT ASSESSMENT — existing project-safe 404, before ownership is even checked', () => {
  it('rejects with 404 "Assessment not found" when the assessment id does not exist at all — never reaches the ownership check', async () => {
    mockFindByPk.mockResolvedValueOnce(null);
    const res = makeRes();
    await expect(finalizeAssessment(makeReq(), res)).rejects.toMatchObject({ statusCode: 404, message: 'Assessment not found' });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });
});

describe('NONEXISTENT STUDENT (assessment exists but points at a deleted/unowned student) — same 404 shape as the cross-teacher case', () => {
  it('never leaks whether the OTHER student exists — identical 404 either way', async () => {
    mockFindByPk.mockResolvedValueOnce(makeAssessmentInstance({ student_id: 424242 }));
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(finalizeAssessment(makeReq(), res)).rejects.toMatchObject({
      statusCode: 404, message: 'Student not found or not assigned to you',
    });
  });
});
