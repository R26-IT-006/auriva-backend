'use strict';

// Feature 9 Step 4 — GET /handwriting/worksheet-recommendation-validations/:studentId
// (handwritingController.getWorksheetRecommendationValidations) verified in
// isolation. teacherService and teacherRecommendationValidationService are
// mocked. No live DB read ever happens in this file.

const mockGetOwnStudentById = jest.fn();
const mockGetTeacherValidationHistory = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: (...a) => mockGetOwnStudentById(...a),
}));

jest.mock('../src/services/teacherRecommendationValidationService', () => ({
  validateWorksheetRecommendation: jest.fn(),
  getTeacherValidationHistory: (...a) => mockGetTeacherValidationHistory(...a),
  getLatestValidationForRecommendation: jest.fn(),
}));

const ApiError = require('../src/utils/ApiError');
const { getWorksheetRecommendationValidations } = require('../src/controllers/handwritingController');

function makeReq({ studentId = '13', userId = 14, query = {} } = {}) {
  return { params: { studentId }, user: { id: userId }, query };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function makeEvent(overrides = {}) {
  return {
    id: 1, caseType: 'lowercase', family: 'curved',
    recommendation: { type: 'motor_family_practice', title: 'Curved Movement Practice', focusLetters: ['c', 'o'] },
    validation: 'confirmed', teacherNote: null, validatedAt: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockGetOwnStudentById.mockReset();
  mockGetTeacherValidationHistory.mockReset();
  mockGetOwnStudentById.mockResolvedValue({ sid: 13, teacher_id: 14 });
  mockGetTeacherValidationHistory.mockResolvedValue({ status: 'evaluated', studentId: 13, events: [], latestByStream: { lowercase: {}, uppercase: {} } });
});

describe('21. owned student -> 200', () => {
  it('passes through the service result', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'evaluated', studentId: 13, events: [makeEvent()], latestByStream: { lowercase: { curved: { validation: 'confirmed', teacherNote: null, validatedAt: '2026-08-10T00:00:00.000Z' } }, uppercase: {} } });
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'evaluated', studentId: 13 }));
  });
});

describe('22. unowned -> 404', () => {
  it('propagates the 404, never calling the service', async () => {
    mockGetOwnStudentById.mockRejectedValueOnce(new ApiError(404, 'Student not found or not assigned to you'));
    const res = makeRes();
    await expect(getWorksheetRecommendationValidations(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockGetTeacherValidationHistory).not.toHaveBeenCalled();
  });
});

describe('23. ownership checked before the service call', () => {
  it('getOwnStudentById runs before getTeacherValidationHistory', async () => {
    const callOrder = [];
    mockGetOwnStudentById.mockImplementationOnce(async () => { callOrder.push('ownership'); throw new ApiError(404, 'not found'); });
    mockGetTeacherValidationHistory.mockImplementationOnce(async () => { callOrder.push('service'); return { status: 'evaluated', studentId: 13, events: [], latestByStream: {} }; });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidations(makeReq(), res)).rejects.toMatchObject({ statusCode: 404 });
    expect(callOrder).toEqual(['ownership']);
  });
});

describe('24. empty history -> 200', () => {
  it('returns 200 with an empty events array, not a 404', async () => {
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ events: [] }));
  });
});

describe('25. events returned newest-first (passed through unmodified)', () => {
  it('preserves the exact order the service returned', async () => {
    const events = [makeEvent({ id: 2 }), makeEvent({ id: 1 })];
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'evaluated', studentId: 13, events, latestByStream: {} });
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(body.events.map((e) => e.id)).toEqual([2, 1]);
  });
});

describe('26. latestByStream preserved unmodified', () => {
  it('passes through the exact latestByStream object from the service', async () => {
    const latestByStream = { lowercase: { curved: { validation: 'dismissed', teacherNote: null, validatedAt: '2026-08-12T00:00:00.000Z' } }, uppercase: {} };
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'evaluated', studentId: 13, events: [], latestByStream });
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(body.latestByStream).toEqual(latestByStream);
  });
});

describe('27. a valid caseType query filter is forwarded', () => {
  it('passes caseType through to the service', async () => {
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq({ query: { caseType: 'uppercase' } }), res);
    const [callArgs] = mockGetTeacherValidationHistory.mock.calls[0];
    expect(callArgs.caseType).toBe('uppercase');
  });
});

describe('28. a valid family query filter is forwarded', () => {
  it('passes family through to the service', async () => {
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq({ query: { family: 'straight' } }), res);
    const [callArgs] = mockGetTeacherValidationHistory.mock.calls[0];
    expect(callArgs.family).toBe('straight');
  });
});

describe('29. an invalid caseType filter -> 422 (service invalid_input propagates)', () => {
  it('throws ApiError(422) when the service reports invalid_input', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'invalid_input', events: null, latestByStream: null });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidations(makeReq({ query: { caseType: 'mixedcase' } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('30. an invalid family filter -> 422', () => {
  it('throws ApiError(422) when the service reports invalid_input', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'invalid_input', events: null, latestByStream: null });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidations(makeReq({ query: { family: 'diagonal' } }), res)).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('31. hashes excluded from the response', () => {
  it('the response body never contains a fingerprint field', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'evaluated', studentId: 13, events: [makeEvent()], latestByStream: {} });
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/[Ff]ingerprint/);
  });
});

describe('32. teacherId excluded from the response', () => {
  it('the response body never contains a teacherId field', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'evaluated', studentId: 13, events: [makeEvent()], latestByStream: {} });
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/teacherId|teacher_id/);
  });
});

describe('33. policy/mapping versions excluded from the response', () => {
  it('the response body never contains a policy/mapping version field', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'evaluated', studentId: 13, events: [makeEvent()], latestByStream: {} });
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    const body = res.json.mock.calls[0][0];
    expect(JSON.stringify(body)).not.toMatch(/policy_version|PolicyVersion|mapping_version|mappingVersion/);
  });
});

describe('34. service called exactly once', () => {
  it('getTeacherValidationHistory is called exactly once per GET', async () => {
    const res = makeRes();
    await getWorksheetRecommendationValidations(makeReq(), res);
    expect(mockGetTeacherValidationHistory).toHaveBeenCalledTimes(1);
  });
});

describe('35. no writes — read_failed maps to 500, never attempts a write', () => {
  it('propagates a 500 on read_failed', async () => {
    mockGetTeacherValidationHistory.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, events: null, latestByStream: null });
    const res = makeRes();
    await expect(getWorksheetRecommendationValidations(makeReq(), res)).rejects.toMatchObject({ statusCode: 500 });
  });
});
