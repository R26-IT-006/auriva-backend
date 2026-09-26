'use strict';

// Pre-device P0 fix — Blocker 2, submitPreWritingActivity(). Proves an
// unauthorized teacher cannot create prewriting warm-up history for
// another teacher's student — ownership is checked before
// ShapeFeature.bulkCreate.
const ApiError = require('../src/utils/ApiError');

const mockShapeFeatureBulkCreate = jest.fn();
const mockGetOwnStudentById = jest.fn();

jest.mock('../src/models', () => ({
  ShapeFeature: { bulkCreate: (...a) => mockShapeFeatureBulkCreate(...a) },
  HandwritingAssessment: {}, LetterProgress: {}, Student: {}, ExplanationResult: {}, RecommendationHistory: {}, LetterAttempt: {},
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

const { submitPreWritingActivity } = require('../src/controllers/handwritingController');

const TEACHER_A_ID = 7;
const STUDENT_A_ID = 10;
const STUDENT_B_ID = 55;

function makeReq(overrides = {}) {
  return {
    user: { id: TEACHER_A_ID },
    body: {
      student_id: STUDENT_A_ID,
      results: [{ activity_id: 'warmup_1', duration_ms: 1000, smoothness: 0.1, dtw_distance: 5, strokes: [] }],
      ...overrides,
    },
  };
}
function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
  mockShapeFeatureBulkCreate.mockResolvedValue([{ id: 1 }]);
});

describe('OWN STUDENT — success path unchanged', () => {
  it('saves normally when the teacher owns the student', async () => {
    const res = makeRes();
    await submitPreWritingActivity(makeReq(), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(mockShapeFeatureBulkCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('OTHER TEACHER\'S STUDENT — rejected before any write', () => {
  it('rejects with 404 and creates zero ShapeFeature rows — no prewriting history for another teacher\'s student', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(submitPreWritingActivity(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockShapeFeatureBulkCreate).not.toHaveBeenCalled();
  });

  it('rejects before the collection_mode rejection check even runs', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    // collection_mode: true would normally 422 further down — the 404
    // ownership rejection must win first.
    await expect(submitPreWritingActivity(makeReq({ student_id: STUDENT_B_ID, collection_mode: true }), res))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('NONEXISTENT STUDENT — same safe behavior as an unowned real student', () => {
  it('rejects with the identical 404 shape (no existence leak)', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(submitPreWritingActivity(makeReq({ student_id: 999999 }), res)).rejects.toMatchObject({
      statusCode: 404, message: 'Student not found or not assigned to you',
    });
  });
});
