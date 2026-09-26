'use strict';

// Feature 11 pilot model integration — thin HTTP client for
// auriva-ml-service's motor-cluster prediction endpoint. Mirrors this
// project's existing outbound-service-client convention (see
// conceptService.js's GNN_BASE/axios pattern) rather than inventing a new
// one.
//
// Architecture (integration task section 5):
//   React Native -> Node/Express -> auriva-ml-service -> saved scaler ->
//   saved K-Means -> prediction -> Node returns/persists.
// This module is the ONLY place in the backend that talks to
// auriva-ml-service over HTTP. React Native never calls it directly.
//
// This client never fits/trains anything, never retries into a fabricated
// result, and never invents a cluster/profile on a failure — a failure here
// always propagates as a real error to the caller.

const axios = require('axios');

const ML_SERVICE_BASE = process.env.ML_SERVICE_URL || 'http://localhost:7000';

/**
 * Legacy experimental L2 shape-motor clustering. Retained for
 * research/reference compatibility only. It is not used by the current
 * teacher-facing baseline summary and does not influence adaptive
 * progression.
 *
 * Calls POST /motor-cluster/predict on auriva-ml-service.
 *
 * @param {{straightScore: number, curvedScore: number, complexScore: number}} scores
 * @returns {Promise<object>} the ML service's full prediction response
 *   (cluster_id, profile_code, display_name, description, model_version,
 *   feature_version, research_status, scores, distances,
 *   nearest_distance, second_nearest_distance, separation_margin) —
 *   returned verbatim, never reshaped/renamed here, so the backend never
 *   silently drifts from what the model actually returned.
 * @throws on any network/validation/server failure — callers decide how to
 *   surface that; this function never swallows an error into a fabricated
 *   "no result" response.
 */
async function predictMotorCluster({ straightScore, curvedScore, complexScore }) {
  const { data } = await axios.post(`${ML_SERVICE_BASE}/motor-cluster/predict`, {
    straight_score: straightScore,
    curved_score: curvedScore,
    complex_score: complexScore,
  });
  return data;
}

/**
 * Feature 11B Phase 4 — calls POST /letter-motor-state/predict on
 * auriva-ml-service (letter_motor_cluster_v1, a separate, non-comparable
 * model from motor-cluster/predict's motor_cluster_v1 above — see
 * letter_motor_state_service.py). Same verbatim-passthrough,
 * never-fabricate-on-failure contract as predictMotorCluster().
 *
 * @param {{smoothnessScore: number, dtwDistance: number, speedCv: number}} features
 * @returns {Promise<object>} the ML service's full prediction response
 *   (cluster_id, state_code, display_name, description, model_version,
 *   research_status, features, distances, nearest_distance,
 *   second_nearest_distance, separation_margin) — returned verbatim.
 * @throws on any network/validation/server failure.
 */
async function predictLetterMotorState({ smoothnessScore, dtwDistance, speedCv }) {
  const { data } = await axios.post(`${ML_SERVICE_BASE}/letter-motor-state/predict`, {
    smoothness_score: smoothnessScore,
    dtw_distance: dtwDistance,
    speed_cv: speedCv,
  });
  return data;
}

module.exports = { predictMotorCluster, predictLetterMotorState, ML_SERVICE_BASE };
