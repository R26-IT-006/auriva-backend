'use strict';

// Shared core for scripts/backfillLetterTrajectoryFeatures.js and
// scripts/backfillShapeTrajectoryFeatures.js.
//
// WHY "merge only nulls" instead of "recompute total_distance/avg_speed
// directly": inspecting the live dataset before writing this script showed
// two distinct data gaps, not one —
//   1. total_distance/avg_speed simply never existed for letters (the
//      known, expected gap this whole pass targets), and
//   2. a smaller set of ALREADY-COLLECTED rows (both shapes and letters)
//      have normalized_features stored as NULL ENTIRELY — not missing one
//      field, missing all of them — even though their raw `features` and
//      `stroke_points` columns are complete. These are early/legacy rows
//      from before the ML-normalization pipeline matured, not "not
//      applicable" nulls (Part 15).
//
// Both are exactly the same shape of problem: "a derived field is null,
// but the raw inputs needed to derive it are already sitting in the row."
// So this backfill does not hand-roll a second calculation path — it calls
// the EXACT SAME production normalizeShapeFeatures()/normalizeLetterFeatures()
// (which already includes this pass's new trajectory-derived fallback,
// see src/utils/featureNormalization.js) against the row's own stored
// `features` + `stroke_points`, then merges the result into the row:
// for every key, the STORED value wins if it is already non-null; a
// currently-null key is filled from the fresh recomputation. No key that
// already holds a valid value is ever touched — satisfies Part 10 rule #4
// ("does NOT overwrite existing valid feature values") for free, by
// construction, for every field this pipeline knows about (not just
// total_distance/avg_speed).
//
// motor_score/quality_score/score_version are handled the same way: only
// recomputed (via computeMotorScore on the merged normalized object) when
// the row's own motor_score column is currently null. A present motor_score
// is never recalculated or replaced.
//
// Never touches: raw `features`, raw `stroke_points`, DTW/smoothness/
// accuracy inputs (those are pass-through values from the raw features,
// unchanged by this merge), thresholds, pass/fail (`passed`/`threshold_passed`
// are untouched columns), motor profile, or baseline — this script only
// ever writes to `normalized_features`, `feature_validity`, `motor_score`,
// `quality_score`, `score_version` on the row it's processing.

const { computeMotorScore } = require('../../src/utils/motorScore');

/**
 * Decides what (if anything) should change for one row, without writing
 * anything. Pure and side-effect-free — safe to call in dry-run mode.
 *
 * @param {{
 *   rawFeatures: Object|null,
 *   strokePoints: Array|null,
 *   storedNormalizedFeatures: Object|null,
 *   storedMotorScore: number|null,
 *   normalizeFn: (raw: Object, meta: Object) => { normalized: Object, validity: Object },
 * }} input
 * @returns {{
 *   changedFields: string[],
 *   mergedNormalizedFeatures: Object|null,
 *   mergedFeatureValidity: Object|null,
 *   newMotorScore: number|null,
 *   newQualityScore: number|null,
 *   newScoreVersion: string|null,
 *   motorScoreChanged: boolean,
 *   isMalformedTrajectory: boolean,
 * }}
 */
function planRowUpdate({ rawFeatures, strokePoints, storedNormalizedFeatures, storedMotorScore, normalizeFn }) {
  const { normalized: fresh, validity: freshValidity } = normalizeFn(rawFeatures ?? {}, { strokePoints });

  const current = storedNormalizedFeatures ?? {};
  const merged = { ...current };
  const changedFields = [];

  // Every canonical key ends up present in `merged` (explicit null when
  // truly undeliverable), matching the shape a normal ingestion-time
  // normalized_features object always has — but only keys that go from
  // "absent/null" to a genuinely non-null value count as a real change
  // worth reporting/logging.
  for (const key of Object.keys(fresh)) {
    const currentValue = current[key];
    const hasCurrentValue = currentValue !== undefined && currentValue !== null;
    if (hasCurrentValue) continue; // never overwrite an existing valid value
    if (fresh[key] != null) {
      merged[key] = fresh[key];
      changedFields.push(key);
    } else {
      merged[key] = null;
    }
  }
  // feature_validity is fully derived from normalized_features (buildValidity
  // in featureNormalization.js) — once any field changes, recompute the
  // whole validity object from the MERGED result so it never disagrees with
  // what's actually stored. This is the one place we replace rather than
  // merge, because validity booleans have no independent "existing value to
  // preserve" concept distinct from the normalized fields they describe.
  const mergedFeatureValidity = changedFields.length > 0
    ? Object.keys(freshValidity).reduce((acc, key) => {
        acc[key] = merged[key] != null;
        return acc;
      }, {})
    : storedNormalizedFeatures ? null : freshValidity; // no change needed either way

  let newMotorScore = null;
  let newQualityScore = null;
  let newScoreVersion = null;
  let motorScoreChanged = false;
  if (storedMotorScore == null && changedFields.length > 0) {
    const scoreResult = computeMotorScore(merged);
    if (scoreResult.motor_score != null) {
      newMotorScore   = scoreResult.motor_score;
      newQualityScore = scoreResult.quality_score;
      newScoreVersion = scoreResult.score_version;
      motorScoreChanged = true;
    }
  }

  const isMalformedTrajectory = !strokePoints
    || (Array.isArray(strokePoints) && strokePoints.length === 0)
    || (Array.isArray(strokePoints) && strokePoints.every(s => !Array.isArray(s?.points) || s.points.length === 0));

  return {
    changedFields,
    mergedNormalizedFeatures: changedFields.length > 0 ? merged : null,
    mergedFeatureValidity: changedFields.length > 0 ? mergedFeatureValidity : null,
    newMotorScore, newQualityScore, newScoreVersion, motorScoreChanged,
    isMalformedTrajectory,
  };
}

module.exports = { planRowUpdate };
