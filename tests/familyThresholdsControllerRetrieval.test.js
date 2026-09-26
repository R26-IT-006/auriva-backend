'use strict';

// Verifies GET /handwriting/family-thresholds/:studentId
// (handwritingController.getFamilyThresholds) in isolation — Teacher
// Dashboard integration fix. Mirrors motorBaselineControllerRetrieval.test.js's
// exact convention: teacherService and dynamicThresholdService are mocked;
// handwritingController's own require('../models') is left real (harmless,
// no DB connection).
const mockGetOwnStudentById               = jest.fn(); // teacherService.getOwnStudentById
const mockGetCurrentFamilyThresholdsForStudent = jest.fn(); // dynamicThresholdService.getCurrentFamilyThresholdsForStudent

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: mockGetOwnStudentById,
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  processDynamicThresholdAfterLetterSession: jest.fn(),
  createInitialFamilyThresholds:             jest.fn(),
  getCurrentFamilyThresholdsForStudent:      mockGetCurrentFamilyThresholdsForStudent,
}));

const { getFamilyThresholds } = require('../src/controllers/handwritingController');

function makeReq(studentIdParam, userId = 5) {
  return { params: { studentId: studentIdParam }, user: { id: userId, role: 'teacher' } };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}

async function callRoute(studentIdParam, userId = 5) {
  const res = makeRes();
  await getFamilyThresholds(makeReq(studentIdParam, userId), res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 31, teacher_id: 5 });
});

describe('Test 1 — valid route, all three families available', () => {
  it('responds 200 with the resolved families exactly as the service returned them', async () => {
    mockGetCurrentFamilyThresholdsForStudent.mockResolvedValueOnce({
      status: 'resolved',
      families: {
        straight: { status: 'available', threshold: 89, source: 'initial_from_baseline' },
        curved:   { status: 'available', threshold: 84, source: 'initial_from_baseline' },
        complex:  { status: 'available', threshold: 96, source: 'initial_from_baseline' },
      },
    });

    const res = await callRoute('31');

    expect(res.status).not.toHaveBeenCalled(); // default 200
    expect(res.json).toHaveBeenCalledWith({
      status: 'resolved',
      families: {
        straight: { status: 'available', threshold: 89, source: 'initial_from_baseline' },
        curved:   { status: 'available', threshold: 84, source: 'initial_from_baseline' },
        complex:  { status: 'available', threshold: 96, source: 'initial_from_baseline' },
      },
    });
  });
});

describe('Test 2 — some/all families unavailable', () => {
  it('responds 200 with unavailable entries, never a fabricated number', async () => {
    mockGetCurrentFamilyThresholdsForStudent.mockResolvedValueOnce({
      status: 'resolved',
      families: {
        straight: { status: 'unavailable', threshold: null, source: null },
        curved:   { status: 'unavailable', threshold: null, source: null },
        complex:  { status: 'unavailable', threshold: null, source: null },
      },
    });

    const res = await callRoute('9');

    expect(res.status).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.families.straight.threshold).toBeNull();
    expect(body.families.curved.threshold).toBeNull();
    expect(body.families.complex.threshold).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(/\b55\b/); // never the legacy fallback number
  });
});

describe('Test 3 — invalid route parameter', () => {
  it.each(['abc', '10abc', '0', '-4', '', 'NaN'])('rejects %p with a 422 validation error, no service call', async (param) => {
    await expect(getFamilyThresholds(makeReq(param), makeRes())).rejects.toMatchObject({ statusCode: 422 });
    expect(mockGetOwnStudentById).not.toHaveBeenCalled();
    expect(mockGetCurrentFamilyThresholdsForStudent).not.toHaveBeenCalled();
  });
});

describe('Test 4 — authorization', () => {
  it('an authorized teacher (owns the student) can retrieve the thresholds', async () => {
    mockGetCurrentFamilyThresholdsForStudent.mockResolvedValueOnce({ status: 'resolved', families: {} });

    await getFamilyThresholds(makeReq('31', 5), makeRes());

    expect(mockGetOwnStudentById).toHaveBeenCalledWith(5, 31);
    expect(mockGetCurrentFamilyThresholdsForStudent).toHaveBeenCalledWith({ studentId: 31 });
  });

  it('denies a teacher who does not own the student, and never calls the threshold lookup', async () => {
    const notOwnedError = Object.assign(new Error('Student not found or not assigned to you'), { statusCode: 404 });
    mockGetOwnStudentById.mockRejectedValueOnce(notOwnedError);

    await expect(getFamilyThresholds(makeReq('31', 999), makeRes())).rejects.toMatchObject({ statusCode: 404 });
    expect(mockGetCurrentFamilyThresholdsForStudent).not.toHaveBeenCalled();
  });
});

describe('Test 5 — defensive invalid_input from the service (unreachable in practice)', () => {
  it('surfaces as a 422, matching the pre-validation behavior', async () => {
    mockGetCurrentFamilyThresholdsForStudent.mockResolvedValueOnce({ status: 'invalid_input', families: null });
    await expect(getFamilyThresholds(makeReq('31'), makeRes())).rejects.toMatchObject({ statusCode: 422 });
  });
});
