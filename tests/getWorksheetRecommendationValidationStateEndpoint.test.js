'use strict';

// Feature 9 Step 4 — GET /handwriting/worksheet-recommendation-validation-state/:studentId
// (handwritingController.getWorksheetRecommendationValidationState) verified
// in isolation. teacherService and teacherRecommendationValidationService
// are mocked. No live DB read ever happens in this file.

const mockGetOwnStudentById = jest.fn();
const mockGetLatestValidationForRecommendation = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/teacherRecommendationValidationService', () => ({
  validateWorksheetRecommendation: jest.fn(),
  getTeacherValidationHistory: jest.fn(),
  getLatestValidationForRecommendation: (...a) => mockGetLatestValidationForRecommendation(...a),
}));

const ApiError = require('../src/utils/ApiError');
const { getWorksheetRecommendationValidationState } = require('../src/controllers/handwritingController');

const FP = 'a'.repeat(64);

function makeReq({ studentId = '13', userId = 14, query = {} } = {}) {
  return {
    params: { studentId },
    user: { id: userId },
    query: { caseType: 'lowercase', family: 'curved', recommendationFingerprint: FP, ...query },
  };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

beforeEach(() => {
  mockGetOwnStudentById.mockReset();
  mockGetLatestValidationForRecommendation.mockReset();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
  mockGetLatestValidationForRecommendation.mockResolvedValue({ status: 'evaluated', current: null });
});

describe('36. owned -> 200', () => {
  it('returns 200 with the service result', async () => {
    const res = makeRes();
    await getWorksheetRecommendationValidationState(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'evaluated' }));
  });
});

describe('37. unowned -> 404', () => {
  it('propagates the 404, never calling the service', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getWorksheetRecommendationValidationState(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockGetLatestValidationForRecommendation).not.toHaveBeenCalled();
  });
});

describe('38. invalid caseType -> 422', () => {
  it('throws ApiError(422) when the service reports invalid_input', async () => {
    mockGetLatestValidationForRecommendation.mockResolvedValueOnce({ status: 'invalid_input', current: null });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidationState(makeReq({ query: { caseType: 'mixedcase' } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('39. invalid family -> 422', () => {
  it('throws ApiError(422) when the service reports invalid_input', async () => {
    mockGetLatestValidationForRecommendation.mockResolvedValueOnce({ status: 'invalid_input', current: null });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidationState(makeReq({ query: { family: 'diagonal' } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('40. malformed fingerprint -> 422', () => {
  it('throws ApiError(422) when the service reports invalid_input', async () => {
    mockGetLatestValidationForRecommendation.mockResolvedValueOnce({ status: 'invalid_input', current: null });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidationState(makeReq({ query: { recommendationFingerprint: 'not-a-hash' } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('41. never reviewed -> current:null', () => {
  it('returns { status: "evaluated", current: null }', async () => {
    const res = makeRes();
    await getWorksheetRecommendationValidationState(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({ status: 'evaluated', current: null });
  });
});

describe('42. reviewed -> current object', () => {
  it('returns the current validation object exactly as the service provided', async () => {
    mockGetLatestValidationForRecommendation.mockResolvedValueOnce({
      status: 'evaluated',
      current: { validation: 'confirmed', teacherNote: 'Focus on o before c', validatedAt: '2026-08-10T00:00:00.000Z' },
    });
    const res = makeRes();
    await getWorksheetRecommendationValidationState(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith({
      status: 'evaluated',
      current: { validation: 'confirmed', teacherNote: 'Focus on o before c', validatedAt: '2026-08-10T00:00:00.000Z' },
    });
  });
});

describe('43. no fingerprint echo', () => {
  it('the response body never includes the recommendationFingerprint the request carried', async () => {
    mockGetLatestValidationForRecommendation.mockResolvedValueOnce({
      status: 'evaluated', current: { validation: 'confirmed', teacherNote: null, validatedAt: '2026-08-10T00:00:00.000Z' },
    });
    const res = makeRes();
    await getWorksheetRecommendationValidationState(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/[Ff]ingerprint/);
  });
});

describe('44. no teacherId', () => {
  it('the response body never includes a teacherId field', async () => {
    mockGetLatestValidationForRecommendation.mockResolvedValueOnce({
      status: 'evaluated', current: { validation: 'confirmed', teacherNote: null, validatedAt: '2026-08-10T00:00:00.000Z' },
    });
    const res = makeRes();
    await getWorksheetRecommendationValidationState(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/teacherId|teacher_id/);
  });
});

describe('45. no writes — read_failed maps to 500, ownership checked before the service call', () => {
  it('propagates a 500 on read_failed', async () => {
    mockGetLatestValidationForRecommendation.mockResolvedValueOnce({ status: 'read_failed', current: null });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidationState(makeReq(), res)).rejects.toMatchObject({ statusCode: 500 });
  });

  it('ownership check runs before the service call', async () => {
    const callOrder = [];
    mockGetOwnStudentById.mockImplementationOnce(async () => { callOrder.push('ownership'); throw new ApiError(404, 'not found'); });
    mockGetLatestValidationForRecommendation.mockImplementationOnce(async () => { callOrder.push('service'); return { status: 'evaluated', current: null }; });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidationState(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(callOrder).toEqual(['ownership']);
  });
});
