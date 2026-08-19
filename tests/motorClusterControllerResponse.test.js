'use strict';

// Feature 11 pilot model integration — GET /handwriting/motor-cluster/:studentId
// (handwritingController.getMotorCluster) in isolation. Mirrors
// familyThresholdsControllerRetrieval.test.js's exact convention:
// teacherService and motorClusterService are mocked; handwritingController's
// own require('../models') is left real (harmless, no DB connection).
const mockGetOwnStudentById = jest.fn();
const mockPredictInitialMotorCluster = jest.fn();

jest.mock('../src/services/teacherService', () => ({
  getOwnStudentById: mockGetOwnStudentById,
}));

jest.mock('../src/services/motorClusterService', () => ({
  predictInitialMotorCluster: (...args) => mockPredictInitialMotorCluster(...args),
}));

const { getMotorCluster } = require('../src/controllers/handwritingController');

function makeReq(studentIdParam, userId = 5) {
  return { params: { studentId: studentIdParam }, user: { id: userId, role: 'teacher' } };
}
function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() };
}
async function callRoute(studentIdParam, userId = 5) {
  const res = makeRes();
  await getMotorCluster(makeReq(studentIdParam, userId), res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOwnStudentById.mockResolvedValue({ sid: 40, teacher_id: 5 });
});

test('an invalid studentId is rejected before any service call', async () => {
  await expect(callRoute('not-a-number')).rejects.toMatchObject({ statusCode: 422 });
  expect(mockGetOwnStudentById).not.toHaveBeenCalled();
});

test('ownership is checked before the prediction is computed', async () => {
  mockPredictInitialMotorCluster.mockResolvedValueOnce({ status: 'predicted', prediction: { cluster_id: 1 } });
  await callRoute('40');
  expect(mockGetOwnStudentById).toHaveBeenCalledWith(5, 40);
});

test('a predicted result returns 200 with the full prediction payload', async () => {
  const prediction = { cluster_id: 2, profile_code: 'PROFILE_B', display_name: 'Motor Profile B' };
  mockPredictInitialMotorCluster.mockResolvedValueOnce({ status: 'predicted', prediction });
  const res = await callRoute('40');
  expect(res.json).toHaveBeenCalledWith({ status: 'predicted', prediction });
});

test('baseline_not_found returns a clean 404, not a 500 or a fabricated prediction', async () => {
  mockPredictInitialMotorCluster.mockResolvedValueOnce({ status: 'baseline_not_found', prediction: null });
  const res = await callRoute('40');
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith({ status: 'baseline_not_found', prediction: null });
});

test('ml_service_unavailable surfaces as a 503, not a silent empty success', async () => {
  mockPredictInitialMotorCluster.mockResolvedValueOnce({ status: 'ml_service_unavailable', prediction: null });
  await expect(callRoute('40')).rejects.toMatchObject({ statusCode: 503 });
});

test('read_failed surfaces as a 500', async () => {
  mockPredictInitialMotorCluster.mockResolvedValueOnce({ status: 'read_failed', prediction: null });
  await expect(callRoute('40')).rejects.toMatchObject({ statusCode: 500 });
});

test('another teacher\'s student is ownership-blocked before any prediction happens', async () => {
  mockGetOwnStudentById.mockRejectedValueOnce(new Error('not found'));
  await expect(callRoute('40')).rejects.toThrow();
  expect(mockPredictInitialMotorCluster).not.toHaveBeenCalled();
});
