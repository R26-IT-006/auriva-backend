'use strict';

// Feature 11B Phase 4 — the 4 new handwritingController endpoints verified
// in isolation. teacherService and letterMotorReassessmentService are
// mocked, mirroring tests/getPersistentDifficultyEndpoint.test.js's exact
// convention: the controller duplicates none of the service's logic, only
// maps HTTP shape <-> service status.

const mockGetOwnStudentById = jest.fn();
const mockSaveAttempt   = jest.fn();
const mockFinalize      = jest.fn();
const mockGetLatest     = jest.fn();
const mockGetHistory    = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/letterMotorReassessmentService', () => ({
  saveReassessmentAttempt: (...a) => mockSaveAttempt(...a),
  finalizeReassessment:    (...a) => mockFinalize(...a),
  getLatestReassessment:   (...a) => mockGetLatest(...a),
  getReassessmentHistory:  (...a) => mockGetHistory(...a),
}));

const {
  saveLetterMotorReassessmentAttempt, finalizeLetterMotorReassessment,
  getLatestLetterMotorReassessment, getLetterMotorReassessmentHistory,
} = require('../src/controllers/handwritingController');
const ApiError = require('../src/utils/ApiError');

const STUDENT_ID = 42;
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: STUDENT_ID, teacher_id: 7 });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /letter-motor-reassessment/attempt
// ═══════════════════════════════════════════════════════════════════════════

describe('saveLetterMotorReassessmentAttempt', () => {
  function makeReq(overrides = {}) {
    return {
      user: { id: 7 },
      body: {
        student_id: STUDENT_ID, letter: 'A', case_type: 'uppercase',
        reassessment_session_id: SESSION_ID, support_level: 'low',
        features: {}, strokes: [],
        ...overrides,
      },
    };
  }

  it('201s with the saved attempt on success', async () => {
    mockSaveAttempt.mockResolvedValueOnce({ status: 'saved', attempt: { id: 1, letter: 'A', case_type: 'uppercase', session_key: SESSION_ID } });
    const res = makeRes();
    await saveLetterMotorReassessmentAttempt(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'saved' }));
  });

  it('checks ownership before calling the service', async () => {
    const callOrder = [];
    mockGetOwnStudentById.mockImplementationOnce(async () => { callOrder.push('ownership'); return {}; });
    mockSaveAttempt.mockImplementationOnce(async () => { callOrder.push('service'); return { status: 'saved', attempt: { id: 1 } }; });
    await saveLetterMotorReassessmentAttempt(makeReq(), makeRes());
    expect(callOrder).toEqual(['ownership', 'service']);
  });

  it('422s on an unowned student, before the service ever runs', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await expect(saveLetterMotorReassessmentAttempt(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockSaveAttempt).not.toHaveBeenCalled();
  });

  it('422s on an invalid student id, before the ownership check even runs', async () => {
    await expect(saveLetterMotorReassessmentAttempt(makeReq({ student_id: 'abc' }), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it('422s when the service rejects an invalid support_level', async () => {
    mockSaveAttempt.mockResolvedValueOnce({ status: 'invalid_support_level' });
    await expect(saveLetterMotorReassessmentAttempt(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });

  it('422s when the service rejects a non-required letter', async () => {
    mockSaveAttempt.mockResolvedValueOnce({ status: 'not_required_letter' });
    await expect(saveLetterMotorReassessmentAttempt(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });

  it('500s on save_failed', async () => {
    mockSaveAttempt.mockResolvedValueOnce({ status: 'save_failed' });
    await expect(saveLetterMotorReassessmentAttempt(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 500 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /letter-motor-reassessment/finalize
// ═══════════════════════════════════════════════════════════════════════════

describe('finalizeLetterMotorReassessment', () => {
  function makeReq(overrides = {}) {
    return { user: { id: 7 }, body: { student_id: STUDENT_ID, reassessment_session_id: SESSION_ID, ...overrides } };
  }

  it('200s with status finalized + result', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'finalized', result: { id: 1 } });
    const res = makeRes();
    await finalizeLetterMotorReassessment(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'finalized', result: { id: 1 } });
  });

  it('200s with status already_finalized (idempotent)', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'already_finalized', result: { id: 1 } });
    const res = makeRes();
    await finalizeLetterMotorReassessment(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('200s with status incomplete + missing list (not an error)', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'incomplete', missing: [{ letter: 'A', caseType: 'uppercase' }] });
    const res = makeRes();
    await finalizeLetterMotorReassessment(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'incomplete', missing: [{ letter: 'A', caseType: 'uppercase' }] });
  });

  it('200s with status invalid_features + invalidLetters list', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'invalid_features', invalidLetters: [{ letter: 'A', caseType: 'uppercase' }] });
    const res = makeRes();
    await finalizeLetterMotorReassessment(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'invalid_features', invalidLetters: [{ letter: 'A', caseType: 'uppercase' }] });
  });

  it('200s with status version_mismatch', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'version_mismatch' });
    const res = makeRes();
    await finalizeLetterMotorReassessment(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'version_mismatch' });
  });

  it('503s on ml_service_unavailable', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'ml_service_unavailable' });
    await expect(finalizeLetterMotorReassessment(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 503 });
  });

  it('500s on save_failed', async () => {
    mockFinalize.mockResolvedValueOnce({ status: 'save_failed' });
    await expect(finalizeLetterMotorReassessment(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 500 });
  });

  it('422s on invalid student id, before ownership check', async () => {
    await expect(finalizeLetterMotorReassessment(makeReq({ student_id: 'abc' }), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it('404s on unowned student, before the service ever runs', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await expect(finalizeLetterMotorReassessment(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockFinalize).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /letter-motor-reassessment/latest/:studentId
// ═══════════════════════════════════════════════════════════════════════════

describe('getLatestLetterMotorReassessment', () => {
  function makeReq(studentId = String(STUDENT_ID)) {
    return { user: { id: 7 }, params: { studentId } };
  }

  it('200s with the found result', async () => {
    mockGetLatest.mockResolvedValueOnce({ status: 'found', result: { id: 1 } });
    const res = makeRes();
    await getLatestLetterMotorReassessment(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', result: { id: 1 } });
  });

  it('404s when not found', async () => {
    mockGetLatest.mockResolvedValueOnce({ status: 'not_found', result: null });
    const res = makeRes();
    await getLatestLetterMotorReassessment(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('422s on an invalid student id', async () => {
    await expect(getLatestLetterMotorReassessment(makeReq('abc'), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });

  it('never triggers the service to call predict (read-only contract enforced at the service layer, verified here only via the mock not exposing predict)', async () => {
    mockGetLatest.mockResolvedValueOnce({ status: 'found', result: { id: 1 } });
    await getLatestLetterMotorReassessment(makeReq(), makeRes());
    expect(mockGetLatest).toHaveBeenCalledWith({ studentId: STUDENT_ID });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /letter-motor-reassessment/history/:studentId
// ═══════════════════════════════════════════════════════════════════════════

describe('getLetterMotorReassessmentHistory', () => {
  function makeReq(studentId = String(STUDENT_ID)) {
    return { user: { id: 7 }, params: { studentId } };
  }

  it('200s with the results array', async () => {
    mockGetHistory.mockResolvedValueOnce({ status: 'found', results: [{ id: 1 }, { id: 2 }] });
    const res = makeRes();
    await getLetterMotorReassessmentHistory(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'found', results: [{ id: 1 }, { id: 2 }] });
  });

  it('422s on an invalid student id, before ownership check', async () => {
    await expect(getLetterMotorReassessmentHistory(makeReq('0'), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
  });

  it('404s on unowned student', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await expect(getLetterMotorReassessmentHistory(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 404 });
  });
});
