'use strict';

// Pre-device P0 fix — Blocker 2 (collection-mode scope, spec §14).
// collection_mode is temporary, pre-deployment research-only code; these
// endpoints got the same ownership fix as the 4 production endpoints
// where it was trivial/regression-safe. exportMlSamples is intentionally
// NOT covered here — it is a multi-student research export with no
// single studentId to check ownership against (reported separately, not
// fixed in this pass).
const ApiError = require('../src/utils/ApiError');

const mockCollectionSessionCreate = jest.fn();
const mockCollectionSessionFindByPk = jest.fn();
const mockShapeFeatureFindAll = jest.fn();
const mockLetterAttemptFindAll = jest.fn();
const mockTeacherValidationFindOrCreate = jest.fn();
const mockTeacherValidationFindOne = jest.fn();
const mockGetOwnStudentById = jest.fn();

jest.mock('../src/models', () => ({
  sequelize: { query: jest.fn() },
  CollectionSession: { create: (...a) => mockCollectionSessionCreate(...a), findByPk: (...a) => mockCollectionSessionFindByPk(...a) },
  TeacherValidation: { findOrCreate: (...a) => mockTeacherValidationFindOrCreate(...a), findOne: (...a) => mockTeacherValidationFindOne(...a) },
  ShapeFeature: { findAll: (...a) => mockShapeFeatureFindAll(...a) },
  LetterAttempt: { findAll: (...a) => mockLetterAttemptFindAll(...a) },
}));
jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));
jest.mock('../src/utils/collectionProtocolValidation', () => ({ validateSession: jest.fn().mockReturnValue([]) }));

const {
  startCollectionSession, completeCollectionSession, submitTeacherValidation, getTeacherValidation,
} = require('../src/controllers/collectionController');

const TEACHER_A_ID = 7;
const STUDENT_A_ID = 10;
const STUDENT_B_ID = 55;
const NOT_OWNED_ERROR = new ApiError(404, 'Student not found or not assigned to you');

function makeRes() { return { status: jest.fn().mockReturnThis(), json: jest.fn() }; }

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_A_ID, teacher_id: TEACHER_A_ID });
});

describe('startCollectionSession', () => {
  const SESSION_ID = '11111111-1111-4111-8111-111111111111';
  function makeReq(overrides = {}) {
    return { user: { id: TEACHER_A_ID }, body: { id: SESSION_ID, student_id: STUDENT_A_ID, ...overrides } };
  }

  it('OWN STUDENT — creates normally', async () => {
    mockCollectionSessionCreate.mockResolvedValueOnce({ id: SESSION_ID });
    const res = makeRes();
    await startCollectionSession(makeReq(), res);
    expect(mockCollectionSessionCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('OTHER TEACHER\'S STUDENT — rejected, zero CollectionSession rows created', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(startCollectionSession(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockCollectionSessionCreate).not.toHaveBeenCalled();
  });
});

describe('completeCollectionSession — special case: student derived from the loaded session, not the body', () => {
  const SESSION_ID = 'session-1';
  function makeReq(overrides = {}) {
    return { user: { id: TEACHER_A_ID }, params: { id: SESSION_ID }, ...overrides };
  }

  it('OWN STUDENT — completes normally', async () => {
    mockCollectionSessionFindByPk.mockResolvedValueOnce({ id: SESSION_ID, student_id: STUDENT_A_ID, update: jest.fn().mockResolvedValue(undefined) });
    mockShapeFeatureFindAll.mockResolvedValueOnce([]);
    mockLetterAttemptFindAll.mockResolvedValueOnce([]);
    const res = makeRes();
    await completeCollectionSession(makeReq(), res);
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_A_ID);
    expect(res.json).toHaveBeenCalled();
  });

  it('OTHER TEACHER\'S SESSION — rejected before the session is updated or its rows read', async () => {
    const sessionUpdate = jest.fn();
    mockCollectionSessionFindByPk.mockResolvedValueOnce({ id: SESSION_ID, student_id: STUDENT_B_ID, update: sessionUpdate });
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(completeCollectionSession(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockGetOwnStudentById).toHaveBeenCalledWith(TEACHER_A_ID, STUDENT_B_ID);
    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(mockShapeFeatureFindAll).not.toHaveBeenCalled();
    expect(mockLetterAttemptFindAll).not.toHaveBeenCalled();
  });

  it('NONEXISTENT SESSION — existing project-safe 404, never reaches the ownership check', async () => {
    mockCollectionSessionFindByPk.mockResolvedValueOnce(null);
    const res = makeRes();
    await expect(completeCollectionSession(makeReq(), res)).rejects.toMatchObject({ statusCode: 404, message: 'Collection session not found' });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });
});

describe('submitTeacherValidation', () => {
  function makeReq(overrides = {}) {
    return { user: { id: TEACHER_A_ID }, body: { student_id: STUDENT_A_ID, collection_session_id: 'sess-1', ...overrides } };
  }

  it('OWN STUDENT — saves normally', async () => {
    mockTeacherValidationFindOrCreate.mockResolvedValueOnce([{ id: 1, update: jest.fn().mockResolvedValue(undefined) }, true]);
    const res = makeRes();
    await submitTeacherValidation(makeReq(), res);
    expect(mockTeacherValidationFindOrCreate).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('OTHER TEACHER\'S STUDENT — rejected, zero TeacherValidation writes', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(submitTeacherValidation(makeReq({ student_id: STUDENT_B_ID }), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockTeacherValidationFindOrCreate).not.toHaveBeenCalled();
  });
});

describe('getTeacherValidation — read-only, ownership derived from the loaded record', () => {
  function makeReq(overrides = {}) {
    return { user: { id: TEACHER_A_ID }, params: { sessionId: 'sess-1' }, ...overrides };
  }

  it('returns null data (no leak) when no record exists — never even checks ownership', async () => {
    mockTeacherValidationFindOne.mockResolvedValueOnce(null);
    const res = makeRes();
    await getTeacherValidation(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ data: null });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it('OWN STUDENT — returns the record', async () => {
    mockTeacherValidationFindOne.mockResolvedValueOnce({ id: 1, student_id: STUDENT_A_ID });
    const res = makeRes();
    await getTeacherValidation(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ data: { id: 1, student_id: STUDENT_A_ID } });
  });

  it('OTHER TEACHER\'S STUDENT — rejected, the record is never returned', async () => {
    mockTeacherValidationFindOne.mockResolvedValueOnce({ id: 1, student_id: STUDENT_B_ID });
    mockGetOwnStudentById.mockRejectedValueOnce(NOT_OWNED_ERROR);
    const res = makeRes();
    await expect(getTeacherValidation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(res.json).not.toHaveBeenCalled();
  });
});
