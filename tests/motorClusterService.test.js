'use strict';

// Feature 11 pilot model integration — motorClusterService.js orchestration,
// isolated from both motorBaselineService and mlServiceClient.
const mockGetStudentMotorBaseline = jest.fn();
const mockPredictMotorCluster = jest.fn();

jest.mock('../src/services/motorBaselineService', () => ({
  getStudentMotorBaseline: (...args) => mockGetStudentMotorBaseline(...args),
}));
jest.mock('../src/services/mlServiceClient', () => ({
  predictMotorCluster: (...args) => mockPredictMotorCluster(...args),
}));

const { predictInitialMotorCluster } = require('../src/services/motorClusterService');

beforeEach(() => jest.clearAllMocks());

function fakeBaseline(overrides = {}) {
  const row = { id: 7, student_id: 40, straight_score: 95, curved_score: 91, complex_score: 94.5, ...overrides };
  return { ...row, get: () => row };
}

test('a found baseline is sent to the ML service using its exact stored scores, and the prediction passes through', async () => {
  mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'found', baseline: fakeBaseline() });
  mockPredictMotorCluster.mockResolvedValueOnce({ cluster_id: 2, profile_code: 'PROFILE_B' });

  const result = await predictInitialMotorCluster({ studentId: 40 });

  expect(mockPredictMotorCluster).toHaveBeenCalledWith({ straightScore: 95, curvedScore: 91, complexScore: 94.5 });
  expect(result).toEqual({ status: 'predicted', prediction: { cluster_id: 2, profile_code: 'PROFILE_B' }, sourceBaselineId: 7 });
});

test.each(['baseline_not_found', 'invalid_input', 'read_failed'])(
  'a %s baseline status passes straight through without ever calling the ML service',
  async status => {
    mockGetStudentMotorBaseline.mockResolvedValueOnce({ status, baseline: null });
    const result = await predictInitialMotorCluster({ studentId: 40 });
    expect(result.status).toBe(status);
    expect(result.prediction).toBeNull();
    expect(mockPredictMotorCluster).not.toHaveBeenCalled();
  }
);

test('an ML service failure resolves to ml_service_unavailable rather than throwing or fabricating a cluster', async () => {
  mockGetStudentMotorBaseline.mockResolvedValueOnce({ status: 'found', baseline: fakeBaseline() });
  mockPredictMotorCluster.mockRejectedValueOnce(new Error('ECONNREFUSED'));

  const result = await predictInitialMotorCluster({ studentId: 40 });
  expect(result.status).toBe('ml_service_unavailable');
  expect(result.prediction).toBeNull();
  expect(result.sourceBaselineId).toBe(7);
});

test('never queries any other Feature 1-10 write path — this module has no create/update/destroy calls anywhere', () => {
  const source = require('fs').readFileSync(require.resolve('../src/services/motorClusterService.js'), 'utf8');
  expect(source).not.toMatch(/\.(create|update|destroy|bulkCreate)\(/);
});
