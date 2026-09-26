'use strict';

/**
 * motorScoreRegime.js
 *
 * Motor Score Unification (spec §24) — the single, centralized marker
 * written to LetterAttempt.progression_score_version /
 * LetterProgress.progression_score_version for every row created under
 * the NEW authoritative-backend-scoring regime (computeMotorScore() gates
 * pass/fail and mastery). A row with this column NULL was created before
 * this phase, under the legacy regime (client featuresToScore()-derived
 * attempt_scores gated pass/fail) — historical rows are never rewritten
 * to carry this marker retroactively (spec §25).
 *
 * Bump this constant (never reuse a retired value) if the authoritative
 * progression-scoring pipeline itself changes again in a way that would
 * make old and new rows non-comparable — mirrors the existing
 * score_version / baseline_version / taxonomy_version convention already
 * used elsewhere in this schema.
 */
const PROGRESSION_SCORE_VERSION = 'motor_score_v1';

module.exports = { PROGRESSION_SCORE_VERSION };
