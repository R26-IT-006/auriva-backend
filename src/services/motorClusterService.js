'use strict';

// Feature 11 pilot model integration — Node-side orchestration for the
// INITIAL motor-cluster prediction (integration task sections 16/17).
//
// Deliberately reuses motorBaselineService.getStudentMotorBaseline() as the
// ONLY source of straight/curved/complex scores — the same authoritative
// Feature 1 baseline Feature 2+ already relies on (section 16: "Do NOT
// recalculate these differently inside Feature 11 if the backend already
// has authoritative family scores"). A student without a persisted
// baseline (never-finalized assessment) simply has no Feature 11 profile
// yet — this deliberately does NOT fall back to a different derivation.
//
// READ-ONLY with respect to every other feature (section 21): this module
// never writes to StudentMotorBaseline, ThresholdHistory, LetterProgress,
// or any other table. It also never itself persists a Feature 11 result —
// no Feature 11 observation/history table exists yet (see the integration
// task's own final report, section 22) and one must not be added by this
// module without an explicit, separate migration decision.
//
// getStudentMotorBaseline() only ever returns a baseline created from a
// non-collection-mode assessment (see motorBaselineService.js's own
// eligibility check), so this path is automatically collection-mode-
// isolated (section 20) — no separate filter needed here.

const { getStudentMotorBaseline } = require('./motorBaselineService');
const { predictMotorCluster } = require('./mlServiceClient');

/**
 * @param {{studentId: number}} params
 * @returns {Promise<{status: string, prediction: object|null, sourceBaselineId: number|null}>}
 *
 * Possible statuses:
 *   predicted            — baseline found, ML service returned a real prediction
 *   baseline_not_found   — student has no persisted initial motor baseline yet
 *   invalid_input        — studentId invalid
 *   read_failed          — baseline lookup itself failed (DB error)
 *   ml_service_unavailable — baseline found, but the ML service call failed
 */
async function predictInitialMotorCluster({ studentId }) {
  const { status, baseline } = await getStudentMotorBaseline({ studentId });
  if (status !== 'found') {
    return { status, prediction: null, sourceBaselineId: null };
  }

  const plain = baseline.get ? baseline.get({ plain: true }) : baseline;

  let prediction;
  try {
    prediction = await predictMotorCluster({
      straightScore: plain.straight_score,
      curvedScore: plain.curved_score,
      complexScore: plain.complex_score,
    });
  } catch (err) {
    return { status: 'ml_service_unavailable', prediction: null, sourceBaselineId: plain.id, error: err.message };
  }

  return { status: 'predicted', prediction, sourceBaselineId: plain.id };
}

module.exports = { predictInitialMotorCluster };
