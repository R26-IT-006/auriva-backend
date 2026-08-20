'use strict';

// Pre-device P0 fix — Blocker 2, submitAssessment(). Proves a teacher
// cannot inject initial-assessment records into another teacher's student
// history — ownership is checked before HandwritingAssessment.create,
// before ShapeFeature.bulkCreate, and before StudentMotorFeature.create.
const ApiError = require('../src/utils/ApiError');

const mockHwaCount  = jest.fn();
const mockHwaCreate = jest.fn();
const mockShapeFeatureBulkCreate = jest.fn();
const mockStudentMotorFeatureCreate = jest.fn();
const mockGetOwnStudentById = jest.fn();

jest.mock('../src/models', () => ({
  HandwritingAssessment: { count: (...a) => mockHwaCount(...a), create: (...a) => mockHwaCreate(...a) },
  ShapeFeature:          { bulkCreate: (...a) => mockShapeFeatureBulkCreate(...a) },
  StudentMotorFeature:   { create: (...a) => mockStudentMotorFeatureCreate(...a) },
  LetterProgress: {}, Student: {}, ExplanationResult: {}, RecommendationHistory: {}, LetterAttempt: {},
}));
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));
jest.mock('../src/utils/featureNormalization', () => ({
  normalizeShapeFeatures: jest.fn().mockReturnValue({ normalized: {}, validity: {} }),
  normalizeLetterFeatures: jest.fn(),
}));
jest.mock('../src/utils/motorScore', () => ({
  computeMotorScore: jest.fn().mockReturnValue({ motor_score: 80, quality_score: 80, score_version: 'v1' }),
}));

const { submitAssessment } = require('../src/controllers/handwritingController');

const TEACHER_A_ID = 7;
const STUDENT_A_ID = 10;
const STUDENT_B_ID = 55;

function makeReq(overrides = {}) {
  return {
    user: { id: TEACHER_A_ID },
    body: {
      student_id: STUDENT_A_ID, session_start: 1000, session_end: 2000,
      shapes: [{ shape_id: 'horizontal_line', stroke_count: 1, strokes: [], features: { duration_ms: 100 } }],
      ...overrides,
    },
  };
}
function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
  mockHwaCount.mockResolvedValue(0);
  mockHwaCreate.mockResolvedValue({ id: 42 });
  mockShapeFeatureBulkCreate.mockResolvedValue([]);
  mockStudentMotorFeatureCreate.mockResolvedValue({});
});

describe('OWN STUDENT — success path unchanged', () => {
  it('saves the assessment normally when the teacher owns the student', async () => {
    const res = makeRes();
    await submitAssessment(makeReq(), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(mockHwaCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('OTHER TEACHER\'S STUDENT — rejected before any write', () => {
  it('rejects with 404 and creates zero HandwritingAssessment/ShapeFeature/StudentMotorFeature rows', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(submitAssessment(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockHwaCreate).not.toHaveBeenCalled();
    expect(mockShapeFeatureBulkCreate).not.toHaveBeenCalled();
    expect(mockStudentMotorFeatureCreate).not.toHaveBeenCalled();
    expect(mockHwaCount).not.toHaveBeenCalled();
  });

  it('a teacher cannot inject initial-assessment records into another teacher\'s student history even with is_initial-relevant data', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(submitAssessment(makeReq({
      student_id: STUDENT_B_ID,
      shapes: [
        { shape_id: 'horizontal_line', stroke_count: 1, strokes: [], features: {} },
        { shape_id: 'vertical_line', stroke_count: 1, strokes: [], features: {} },
        { shape_id: 'full_circle', stroke_count: 1, strokes: [], features: {} },
        { shape_id: 'half_circle', stroke_count: 1, strokes: [], features: {} },
        { shape_id: 'zigzag', stroke_count: 1, strokes: [], features: {} },
        { shape_id: 'curve_wave', stroke_count: 1, strokes: [], features: {} },
      ],
    }), res)).rejects.toThrow();
    expect(mockHwaCreate).not.toHaveBeenCalled();
  });
});

describe('NONEXISTENT STUDENT — same safe behavior as an unowned real student', () => {
  it('rejects with the identical 404 shape (no existence leak)', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(submitAssessment(makeReq({ student_id: 999999 }), res)).rejects.toMatchObject({
      statusCode: 404, message: 'Student not found or not assigned to you',
    });
  });
});
