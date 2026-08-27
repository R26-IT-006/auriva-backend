'use strict';

// Pre-device P0 fix — Blocker 2, recordLetterCompletion(). Proves:
//   - an owned student's request succeeds exactly as before
//   - an unowned/nonexistent student's request is rejected BEFORE any
//     write — zero LetterAttempt, zero LetterProgress, zero threshold
//     write, zero Feature 11B evidence/state write
//   - the two rejection cases (other teacher's real student vs. a
//     nonexistent id) are indistinguishable to the caller (both resolve
//     through the same getOwnStudentById 404 path — no existence leak)
//   - authorization happens even in collection_mode (production logic
//     never depends on collection_mode for its authorization boundary)
const ApiError = require('../src/utils/ApiError');

const mockGetOwnStudentById = jest.fn();
const mockLetterAttemptBulkCreate = jest.fn();
const mockLetterProgressFindOrCreate = jest.fn();
const mockLetterProgressFindOne = jest.fn();
const mockLetterProgressFindAll = jest.fn();
const mockStudentFindByPk = jest.fn();
const mockResolveProgressionThreshold = jest.fn();
const mockProcessDynamicThresholdAfterLetterSession = jest.fn();
const mockGetStudentThreshold = jest.fn();
const mockOnLetterMastered = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/models', () => ({
  HandwritingAssessment: {},
  LetterProgress: {
    findOrCreate: (...a) => mockLetterProgressFindOrCreate(...a),
    findOne:      (...a) => mockLetterProgressFindOne(...a),
    findAll:      (...a) => mockLetterProgressFindAll(...a),
  },
  Student: { findByPk: (...a) => mockStudentFindByPk(...a) },
  ExplanationResult: {}, RecommendationHistory: {}, StudentMotorFeature: {}, ShapeFeature: {},
  LetterAttempt: { bulkCreate: (...a) => mockLetterAttemptBulkCreate(...a) },
}));

jest.mock('../src/services/progressionThresholdResolver', () => ({
  resolveProgressionThreshold: (...a) => mockResolveProgressionThreshold(...a),
}));
jest.mock('../src/services/dynamicThresholdService', () => ({
  processDynamicThresholdAfterLetterSession: (...a) => mockProcessDynamicThresholdAfterLetterSession(...a),
}));
jest.mock('../src/utils/thresholdUtils', () => ({
  getStudentThreshold: (...a) => mockGetStudentThreshold(...a),
}));
jest.mock('../src/services/letterMotorMasteryService', () => ({
  onLetterMastered: (...a) => mockOnLetterMastered(...a),
}));
jest.mock('../src/utils/featureNormalization', () => ({
  normalizeShapeFeatures: jest.fn(),
  normalizeLetterFeatures: jest.fn().mockReturnValue({ normalized: { stroke_order_meta: null }, validity: {} }),
}));
jest.mock('../src/utils/motorScore', () => ({
  computeMotorScore: jest.fn().mockReturnValue({ motor_score: 80, quality_score: 80, score_version: 'v1' }),
}));
jest.mock('../src/services/explainabilityService', () => ({ analyzeMotorDifficulty: jest.fn() }));
jest.mock('../src/services/motorBaselineService', () => ({ createInitialMotorBaseline: jest.fn(), getStudentMotorBaseline: jest.fn() }));
jest.mock('../src/services/motorClusterService', () => ({ predictInitialMotorCluster: jest.fn() }));
jest.mock('../src/services/letterCategoryCompletionService', () => ({}));

const { recordLetterCompletion } = require('../src/controllers/handwritingController');

const TEACHER_A_ID = 7;
const STUDENT_A_ID = 13; // owned by Teacher A
const STUDENT_B_ID = 99; // owned by a DIFFERENT teacher

function makeReq(overrides = {}) {
  return {
    user: { id: TEACHER_A_ID },
    body: {
      student_id: STUDENT_A_ID, letter: 'l', case_type: 'lowercase',
      attempt_scores: [90], wrote_correctly: true,
      attempts: [
        // Fixture note: `strokes` must be NON-EMPTY. Capture completeness is checked
        // before coverage (src/utils/captureStatus.js), and an attempt with no strokes
        // is a CAPTURE FAULT that never reaches evaluation — so an empty array here
        // would silently stop these suites from testing what they are about. The
        // geometry itself is irrelevant; computeMotorScore is mocked.
        { attempt_number: 1, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [{ stroke_id: 1, points: [{ x: 10, y: 10 }, { x: 200, y: 10 }] }] },
        { attempt_number: 2, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [{ stroke_id: 1, points: [{ x: 10, y: 10 }, { x: 200, y: 10 }] }] },
        { attempt_number: 3, features: { smoothness: 0.1, dtw_distance: 10 }, strokes: [{ stroke_id: 1, points: [{ x: 10, y: 10 }, { x: 200, y: 10 }] }] },
      ],
      ...overrides,
    },
  };
}
function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }
function makeProgressRecord(overrides = {}) {
  return { id: 1, increment: jest.fn().mockResolvedValue(undefined), update: jest.fn().mockResolvedValue(undefined), ...overrides };
}
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

function expectNoWritesHappened() {
  expect(mockLetterAttemptBulkCreate).not.toHaveBeenCalled();
  expect(mockLetterProgressFindOrCreate).not.toHaveBeenCalled();
  expect(mockProcessDynamicThresholdAfterLetterSession).not.toHaveBeenCalled();
  expect(mockOnLetterMastered).not.toHaveBeenCalled();
  expect(mockStudentFindByPk).not.toHaveBeenCalled(); // the personal_thresholds auto-adjust path
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
  mockLetterAttemptBulkCreate.mockResolvedValue([]);
  mockLetterProgressFindOrCreate.mockResolvedValue([makeProgressRecord(), true]);
  mockLetterProgressFindOne.mockResolvedValue({ id: 1, blocked_attempts: 1 });
  mockLetterProgressFindAll.mockResolvedValue([]);
  mockStudentFindByPk.mockResolvedValue({ personal_thresholds: {}, update: jest.fn().mockResolvedValue(undefined) });
  mockGetStudentThreshold.mockResolvedValue(55);
  mockResolveProgressionThreshold.mockResolvedValue({ status: 'resolved', threshold: 55, source: 'global_default', family: null, historyId: null });
  mockProcessDynamicThresholdAfterLetterSession.mockResolvedValue({ status: 'not_applicable', family: null, decision: null, newThreshold: null, historyId: null });
  mockOnLetterMastered.mockResolvedValue({ status: 'evidence_created', evidence: { id: 1 }, milestoneResults: [] });
});

describe('OWN STUDENT — success path unchanged', () => {
  it('completes normally when the authenticated teacher owns the student', async () => {
    const res = makeRes();
    await recordLetterCompletion(makeReq(), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockLetterAttemptBulkCreate).toHaveBeenCalledTimes(1);
  });
});

describe('OTHER TEACHER\'S STUDENT — rejected before any write', () => {
  it('rejects with the same error getOwnStudentById itself raises, and performs zero writes', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(recordLetterCompletion(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toMatchObject({ statusCode: 404 });
    expectNoWritesHappened();
  });

  it('zero LetterAttempt, zero LetterProgress, zero threshold orchestration, zero Feature 11B evidence/state writes', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(recordLetterCompletion(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toThrow();
    expect(mockLetterAttemptBulkCreate).not.toHaveBeenCalled(); // zero LetterAttempt writes
    expect(mockLetterProgressFindOrCreate).not.toHaveBeenCalled(); // zero LetterProgress writes/mastery
    expect(mockProcessDynamicThresholdAfterLetterSession).not.toHaveBeenCalled(); // zero threshold writes
    expect(mockOnLetterMastered).not.toHaveBeenCalled(); // zero Feature 11B evidence/state writes
  });

  it('is rejected identically in collection_mode too (authorization does not depend on collection_mode)', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(recordLetterCompletion(makeReq({ student_id: STUDENT_B_ID, collection_mode: true }), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockLetterAttemptBulkCreate).not.toHaveBeenCalled();
  });
});

describe('NONEXISTENT STUDENT — same safe behavior as an unowned real student (no existence leak)', () => {
  it('rejects with the exact same 404 shape as the other-teacher case', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(recordLetterCompletion(makeReq({ student_id: 999999 }), res)).rejects.toMatchObject({
      statusCode: 404, message: 'Student not found or not assigned to you',
    });
    expect(mockLetterAttemptBulkCreate).not.toHaveBeenCalled();
  });
});

describe('Authorization occurs before ML/Feature-11 side effects specifically', () => {
  it('letterMotorMasteryService.onLetterMastered is never invoked for an unauthorized request', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(recordLetterCompletion(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toThrow();
    expect(mockOnLetterMastered).not.toHaveBeenCalled();
  });
});

describe('Error response follows existing conventions', () => {
  it('never exposes a raw stack trace or internal detail in the thrown error message', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    try {
      await recordLetterCompletion(makeReq({ student_id: STUDENT_B_ID }), res);
      throw new Error('expected recordLetterCompletion to reject');
    } catch (err) {
      expect(err.statusCode).toBe(404);
      expect(err.message).not.toMatch(/at Object\.|node_modules|\.js:\d+/);
    }
  });
});
