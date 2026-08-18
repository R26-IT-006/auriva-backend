'use strict';

// Feature 9 Step 4 — POST /handwriting/worksheet-recommendation-validations/:studentId
// (handwritingController.postWorksheetRecommendationValidation) verified in
// isolation. teacherService and teacherRecommendationValidationService are
// mocked — the controller duplicates none of validateWorksheetRecommendation's
// logic. No live DB write ever happens in this file.

const mockGetOwnStudentById = jest.fn();
const mockValidateWorksheetRecommendation = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/teacherRecommendationValidationService', () => ({
  validateWorksheetRecommendation: (...a) => mockValidateWorksheetRecommendation(...a),
  getTeacherValidationHistory: jest.fn(),
  getLatestValidationForRecommendation: jest.fn(),
}));

const ApiError = require('../src/utils/ApiError');
const { postWorksheetRecommendationValidation } = require('../src/controllers/handwritingController');

const FP = 'a'.repeat(64);
const ACTION_ID = '11111111-1111-4111-8111-111111111111';

function makeReq({ studentId = '13', userId = 14, body = {} } = {}) {
  return {
    params: { studentId },
    user: { id: userId },
    body: {
      caseType: 'lowercase', family: 'curved', validation: 'confirmed',
      recommendationFingerprint: FP, actionId: ACTION_ID,
      ...body,
    },
  };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  // mockReset (not clearAllMocks) — see spec's own documented reasoning
  // (Feature 8's own getWorksheetRecommendationsEndpoint.test.js): avoids a
  // queued mockImplementationOnce leaking into a later test when an
  // ownership-rejection test never consumes it.
  mockGetOwnStudentById.mockReset();
  mockValidateWorksheetRecommendation.mockReset();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
});

describe('1. invalid student id -> 422', () => {
  it('rejects a non-numeric studentId param before any service call', async () => {
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq({ studentId: 'abc' }), res)).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
    expect(mockValidateWorksheetRecommendation).not.toHaveBeenCalled();
  });
});

describe('2. unowned student -> 404', () => {
  it('propagates the 404 from getOwnStudentById', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockValidateWorksheetRecommendation).not.toHaveBeenCalled();
  });
});

describe('3. ownership checked before the service call', () => {
  it('getOwnStudentById runs before validateWorksheetRecommendation', async () => {
    const callOrder = [];
    mockGetOwnStudentById.mockImplementationOnce(async () => { callOrder.push('ownership'); throw new ApiError(404, 'not found'); });
    mockValidateWorksheetRecommendation.mockImplementationOnce(async () => { callOrder.push('service'); return { status: 'validated', duplicate: false, id: 1, validatedAt: '2026-08-14T00:00:00.000Z' }; });

    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(callOrder).toEqual(['ownership']);
  });
});

describe('4. body teacherId/teacher_id is never trusted', () => {
  it('always calls the service with teacherId = req.user.id, ignoring any body teacherId/teacher_id', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'validated', duplicate: false, id: 1, validatedAt: '2026-08-14T00:00:00.000Z' });
    const res = makeRes();
    await postWorksheetRecommendationValidation(
      makeReq({ userId: 14, body: { teacherId: 999, teacher_id: 999 } }),
      res
    );
    const [callArgs] = mockValidateWorksheetRecommendation.mock.calls[0];
    expect(callArgs.teacherId).toBe(14);
  });
});

describe('5. confirmed success (new) -> 201', () => {
  it('returns 201 with duplicate:false', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'validated', duplicate: false, id: 5, validatedAt: '2026-08-14T00:00:00.000Z' });
    const res = makeRes();
    await postWorksheetRecommendationValidation(makeReq({ body: { validation: 'confirmed' } }), res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'validated', duplicate: false }));
  });
});

describe('6. dismissed success (new) -> 201', () => {
  it('returns 201 with duplicate:false', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'validated', duplicate: false, id: 6, validatedAt: '2026-08-14T00:00:00.000Z' });
    const res = makeRes();
    await postWorksheetRecommendationValidation(makeReq({ body: { validation: 'dismissed' } }), res);
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('7. duplicate -> 200', () => {
  it('returns 200 (not 409) when the service reports duplicate:true', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'validated', duplicate: true, id: 5, validatedAt: '2026-08-10T00:00:00.000Z' });
    const res = makeRes();
    await postWorksheetRecommendationValidation(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true }));
  });
});

describe('8. recommendation_changed -> 409', () => {
  it('throws ApiError(409) with status details, no fingerprint in the message', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'recommendation_changed', currentRecommendationFingerprint: 'f'.repeat(64) });
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq(), res)).rejects.toMatchObject({
      statusCode: 409,
      details: { status: 'recommendation_changed' },
    });
  });
});

describe('9. recommendation_not_found -> 409', () => {
  it('throws ApiError(409) with status details', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'recommendation_not_found' });
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq(), res)).rejects.toMatchObject({
      statusCode: 409,
      details: { status: 'recommendation_not_found' },
    });
  });
});

describe('10. read_failed -> 500', () => {
  it('throws ApiError(500)', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'read_failed' });
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq(), res)).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe('11. write_failed -> 500', () => {
  it('throws ApiError(500)', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'write_failed' });
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq(), res)).rejects.toMatchObject({ statusCode: 500 });
  });
});

describe('12. invalid validation -> 422', () => {
  it('throws ApiError(422) when the service reports invalid_input', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'invalid_input', reason: 'invalid_validation' });
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq({ body: { validation: 'approved' } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('13. malformed fingerprint -> 422', () => {
  it('throws ApiError(422) when the service reports invalid_input for a malformed fingerprint', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'invalid_input', reason: 'malformed_recommendation_fingerprint' });
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq({ body: { recommendationFingerprint: 'not-a-hash' } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('14. oversized note -> 422', () => {
  it('throws ApiError(422) when the service reports invalid_input for a too-long note', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'invalid_input', reason: 'teacher_note_too_long' });
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq({ body: { teacherNote: 'x'.repeat(3000) } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('15. no raw hashes returned', () => {
  it('the 201 response body never includes evidenceFingerprint/recommendationFingerprint', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({
      status: 'validated', duplicate: false, id: 1, validatedAt: '2026-08-14T00:00:00.000Z',
    });
    const res = makeRes();
    await postWorksheetRecommendationValidation(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/[Ff]ingerprint/);
  });
});

describe('16. no teacherId returned', () => {
  it('the 201 response body never includes teacherId', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({
      status: 'validated', duplicate: false, id: 1, validatedAt: '2026-08-14T00:00:00.000Z',
    });
    const res = makeRes();
    await postWorksheetRecommendationValidation(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/teacherId|teacher_id/);
  });
});

describe('17. no server fingerprint leaked on 409', () => {
  it('the thrown ApiError never carries currentRecommendationFingerprint anywhere', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({
      status: 'recommendation_changed', currentRecommendationFingerprint: 'f'.repeat(64),
    });
    const res = makeRes();
    let caught;
    try {
      await postWorksheetRecommendationValidation(makeReq(), res);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(JSON.stringify({ message: caught.message, details: caught.details })).not.toMatch(/f{10,}/);
  });
});

describe('18. service called exactly once', () => {
  it('validateWorksheetRecommendation is called exactly once per POST', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'validated', duplicate: false, id: 1, validatedAt: '2026-08-14T00:00:00.000Z' });
    const res = makeRes();
    await postWorksheetRecommendationValidation(makeReq(), res);
    expect(mockValidateWorksheetRecommendation).toHaveBeenCalledTimes(1);
  });
});

describe('19. no write attempt if ownership fails', () => {
  it('validateWorksheetRecommendation is never called when getOwnStudentById rejects', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'not found'));
    const res = makeRes();
    await expect(postWorksheetRecommendationValidation(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockValidateWorksheetRecommendation).not.toHaveBeenCalled();
  });
});

describe('20. client title/focusLetters (if present on the body) are ignored', () => {
  it('only the 6 expected body fields are ever forwarded to the service', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'validated', duplicate: false, id: 1, validatedAt: '2026-08-14T00:00:00.000Z' });
    const res = makeRes();
    await postWorksheetRecommendationValidation(
      makeReq({ body: { title: 'FAKE', focusLetters: ['x', 'y'], rationale: 'FAKE RATIONALE', suggestedActivities: ['fake'] } }),
      res
    );
    const [callArgs] = mockValidateWorksheetRecommendation.mock.calls[0];
    expect(Object.keys(callArgs).sort()).toEqual(
      ['studentId', 'teacherId', 'caseType', 'family', 'validation', 'teacherNote', 'recommendationFingerprint', 'actionId'].sort()
    );
  });
});

describe('21. actionId is forwarded to the service unchanged (Feature 9 repair)', () => {
  it('passes the body actionId through verbatim', async () => {
    mockValidateWorksheetRecommendation.mockResolvedValueOnce({ status: 'validated', duplicate: false, id: 1, validatedAt: '2026-08-14T00:00:00.000Z' });
    const res = makeRes();
    await postWorksheetRecommendationValidation(makeReq({ body: { actionId: ACTION_ID } }), res);
    const [callArgs] = mockValidateWorksheetRecommendation.mock.calls[0];
    expect(callArgs.actionId).toBe(ACTION_ID);
  });
});
