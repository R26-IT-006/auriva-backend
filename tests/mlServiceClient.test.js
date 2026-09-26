'use strict';

// Feature 11 pilot model integration — mlServiceClient.js is the ONLY
// place in the backend that talks to auriva-ml-service over HTTP.
jest.mock('axios');
const axios = require('axios');
const { predictMotorCluster, ML_SERVICE_BASE } = require('../src/services/mlServiceClient');

beforeEach(() => jest.clearAllMocks());

test('posts to /motor-cluster/predict with the exact snake_case field names the ML service expects', async () => {
  axios.post.mockResolvedValueOnce({ data: { cluster_id: 1, profile_code: 'PROFILE_A' } });
  await predictMotorCluster({ straightScore: 95, curvedScore: 91, complexScore: 94.5 });
  expect(axios.post).toHaveBeenCalledWith(
    `${ML_SERVICE_BASE}/motor-cluster/predict`,
    { straight_score: 95, curved_score: 91, complex_score: 94.5 },
  );
});

test('returns the ML service response verbatim — never reshaped or renamed', async () => {
  const full = {
    cluster_id: 2, profile_code: 'PROFILE_B', display_name: 'Motor Profile B',
    description: 'x', model_version: 'motor_cluster_v1', feature_version: 'motor_cluster_feature_v1',
    research_status: 'pilot_exploratory', scores: { straight_score: 95, curved_score: 91, complex_score: 94.5 },
    distances: { cluster_0: 3.5, cluster_1: 2.5, cluster_2: 1.1 },
    nearest_distance: 1.1, second_nearest_distance: 2.5, separation_margin: 1.4,
  };
  axios.post.mockResolvedValueOnce({ data: full });
  const result = await predictMotorCluster({ straightScore: 95, curvedScore: 91, complexScore: 94.5 });
  expect(result).toEqual(full);
});

test('a network/server failure propagates as a real rejection — never swallowed into a fabricated result', async () => {
  axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  await expect(predictMotorCluster({ straightScore: 95, curvedScore: 91, complexScore: 94.5 }))
    .rejects.toThrow('ECONNREFUSED');
});
