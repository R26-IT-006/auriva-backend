'use strict';

// Feature 2 Step 6A — teacherController.setFamilyThreshold (family-level
// teacher override) and a regression check that the EXISTING legacy
// setThreshold (per-letter personal_thresholds) controller function is
// completely unaffected by this addition. Mirrors this project's existing
// controller-test convention (see motorBaselineControllerIntegration.test.js):
// call the controller function directly with a mocked req/res, never real
// HTTP/supertest.
const mockValidationResult          = jest.fn();
const mockSetTeacherFamilyThreshold = jest.fn();
const mockTeacherServiceSetThreshold = jest.fn();

jest.mock('express-validator', () => ({
  validationResult: (...args) => mockValidationResult(...args),
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  setTeacherFamilyThreshold: (...args) => mockSetTeacherFamilyThreshold(...args),
}));

jest.mock('../src/services/teacherService', () => ({
  setThreshold: (...args) => mockTeacherServiceSetThreshold(...args),
}));

const { setFamilyThreshold, setThreshold } = require('../src/controllers/teacherController');

function makeReq(overrides = {}) {
  return {
    params: { id: '13' },
    body: { family: 'curved', value: 85 },
    user: { id: 5 },
    ...overrides,
  };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

function validPassResult() {
  return { isEmpty: () => true, array: () => [] };
}

function validationFailureResult() {
  return { isEmpty: () => false, array: () => [{ msg: 'family must be one of: straight, curved, complex' }] };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidationResult.mockReturnValue(validPassResult());
});

// ─── Section 31 — controller/route tests ───────────────────────────────────

describe('Test 1 — owned student success', () => {
  it('calls the service with teacherId/studentId/family/value and returns the serialized result', async () => {
    mockSetTeacherFamilyThreshold.mockResolvedValueOnce({
      status: 'updated', studentId: 13, family: 'curved', oldThreshold: 88, newThreshold: 85, source: 'teacher_override', historyId: 4,
    });

    const res = makeRes();
    await setFamilyThreshold(makeReq(), res);

    expect(mockSetTeacherFamilyThreshold).toHaveBeenCalledWith({ teacherId: 5, studentId: 13, family: 'curved', value: 85 });
    expect(res.json).toHaveBeenCalledWith({
      status: 'updated', studentId: 13, family: 'curved', oldThreshold: 88, newThreshold: 85, source: 'teacher_override',
    });
  });
});

describe('Test 2 — unowned student -> 404', () => {
  it('throws ApiError(404) with the same message as the legacy endpoint, never revealing another teacher\'s ownership', async () => {
    mockSetTeacherFamilyThreshold.mockResolvedValueOnce({ status: 'student_not_found', studentId: 13, family: 'curved', oldThreshold: null, newThreshold: null, source: null, historyId: null });

    await expect(setFamilyThreshold(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 404, message: 'Student not found or not assigned to you' });
  });
});

describe('Test 3 — invalid body (express-validator) -> 422, service never called', () => {
  it('throws ApiError(422) before invoking the service', async () => {
    mockValidationResult.mockReturnValue(validationFailureResult());

    await expect(setFamilyThreshold(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockSetTeacherFamilyThreshold).not.toHaveBeenCalled();
  });
});

describe('Test 4 — invalid family (service-level defense-in-depth) -> 422', () => {
  it('throws ApiError(422)', async () => {
    mockSetTeacherFamilyThreshold.mockResolvedValueOnce({ status: 'invalid_family', studentId: 13, family: null, oldThreshold: null, newThreshold: null, source: null, historyId: null });

    await expect(setFamilyThreshold(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('Test 5 — invalid value (service-level defense-in-depth) -> 422', () => {
  it('throws ApiError(422)', async () => {
    mockSetTeacherFamilyThreshold.mockResolvedValueOnce({ status: 'invalid_value', studentId: 13, family: 'curved', oldThreshold: null, newThreshold: null, source: null, historyId: null });

    await expect(setFamilyThreshold(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('Test 6 — response serialization: no raw Sequelize object, no internal fields leaked', () => {
  it('res.json is called with EXACTLY the documented shape — historyId is not exposed', async () => {
    mockSetTeacherFamilyThreshold.mockResolvedValueOnce({
      status: 'updated', studentId: 13, family: 'curved', oldThreshold: 88, newThreshold: 85, source: 'teacher_override', historyId: 4,
    });

    const res = makeRes();
    await setFamilyThreshold(makeReq(), res);

    const responseBody = res.json.mock.calls[0][0];
    expect(Object.keys(responseBody).sort()).toEqual(['family', 'newThreshold', 'oldThreshold', 'source', 'status', 'studentId'].sort());
    expect(responseBody).not.toHaveProperty('historyId');
  });
});

describe('Test 7 — legacy /threshold endpoint is unaffected', () => {
  it('setThreshold still calls only teacherService.setThreshold, never the new family-threshold service', async () => {
    mockTeacherServiceSetThreshold.mockResolvedValueOnce({ student_id: 13, letter: 'a', value: 70, personal_thresholds: { a: 70 } });

    const req = { params: { id: '13' }, body: { letter: 'a', value: 70 }, user: { id: 5 } };
    const res = makeRes();
    await setThreshold(req, res);

    expect(mockTeacherServiceSetThreshold).toHaveBeenCalledWith(5, '13', 'a', 70);
    expect(mockSetTeacherFamilyThreshold).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ student_id: 13, letter: 'a', value: 70, personal_thresholds: { a: 70 } });
  });
});

// ─── Additional controller-level coverage ──────────────────────────────────

describe('threshold_not_initialized -> 409', () => {
  it('throws ApiError(409), never a silent success', async () => {
    mockSetTeacherFamilyThreshold.mockResolvedValueOnce({ status: 'threshold_not_initialized', studentId: 13, family: 'curved', oldThreshold: null, newThreshold: null, source: null, historyId: null });

    await expect(setFamilyThreshold(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('invalid student ID in the URL param is rejected before calling the service', () => {
  it('throws ApiError(422) for a non-numeric id', async () => {
    await expect(setFamilyThreshold(makeReq({ params: { id: 'abc' } }), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockSetTeacherFamilyThreshold).not.toHaveBeenCalled();
  });

  it('throws ApiError(422) for id=0', async () => {
    await expect(setFamilyThreshold(makeReq({ params: { id: '0' } }), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('an unexpected service failure (save_failed/read_failed) surfaces as 500, not a silent 200', () => {
  it.each(['save_failed', 'read_failed'])('status=%s -> ApiError(500)', async (status) => {
    mockSetTeacherFamilyThreshold.mockResolvedValueOnce({ status, studentId: 13, family: 'curved', oldThreshold: null, newThreshold: null, source: null, historyId: null });
    await expect(setFamilyThreshold(makeReq(), makeRes())).rejects.toMatchObject({ statusCode: 500 });
  });
});
