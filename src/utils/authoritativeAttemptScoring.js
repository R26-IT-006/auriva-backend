'use strict';

/**
 * authoritativeAttemptScoring.js
 *
 * Motor Score Unification, Phase 1 (spec §2/§4/§5) — computes the
 * AUTHORITATIVE per-attempt and session-best motor score entirely from
 * backend-derived data (attempt.features + attempt.strokes), reusing the
 * exact existing normalizeLetterFeatures() -> computeMotorScore() pipeline
 * that already runs inside saveLetterAttempts() for persistence. This
 * module makes that same pipeline available BEFORE the pass/fail decision
 * is made, so mastery/threshold gating uses it too — never the
 * client-supplied `attempt_scores` array.
 *
 * Eligibility rule (spec §5 — "preserve existing rules around usable
 * attempt/coverage/attempt numbering"): reuses isAttemptCoverageValid()
 * UNCHANGED (same geometry-only coverage/geometry gate the old
 * computeCoverageFilteredBestScore() used) — an attempt whose drawing
 * fails the coverage check is excluded from bestScore eligibility here
 * exactly as it was before. The only thing that changed is WHICH SCORE is
 * computed for each eligible attempt: computeMotorScore() (backend,
 * authoritative), never featuresToScore() (client-supplied, no longer
 * trusted for this decision — spec §4).
 *
 * A null motor_score (computeMotorScore() found no usable components at
 * all for that attempt) is also excluded from eligibility — an attempt
 * that produced no derivable score cannot set the session's best score.
 */

const { isAttemptCoverageValid } = require('./attemptCoverageValidity');
const { normalizeLetterFeatures } = require('./featureNormalization');
const { computeMotorScore } = require('./motorScore');

/**
 * @param {{
 *   attempts: Array<{features?: Object, strokes?: Array}>,
 *   canvasWidth: number|null|undefined,
 *   canvasHeight: number|null|undefined,
 * }} params
 * @returns {{
 *   bestScore: number|null,
 *   attemptScores: Array<number|null>,   // one entry per input attempt, in order — null where ineligible/uncomputable
 *   eligibleCount: number,
 * }}
 */
function computeAuthoritativeBestScore({ attempts, canvasWidth, canvasHeight }) {
  const attemptsArray = Array.isArray(attempts) ? attempts : [];

  const attemptScores = attemptsArray.map((attempt) => {
    const coverageValid = isAttemptCoverageValid(attempt?.strokes, canvasWidth, canvasHeight);
    // Fail open on undeterminable coverage (missing canvas dims) — same
    // rule the pre-unification coverage filter used: only an EXPLICIT
    // `false` excludes an attempt, never an unknown (`null`).
    if (coverageValid === false) return null;

    const { normalized } = normalizeLetterFeatures(attempt?.features, { strokePoints: attempt?.strokes });
    const { motor_score } = computeMotorScore(normalized);
    return motor_score; // already 0-100 integer, or null
  });

  const eligible = attemptScores.filter((s) => s != null);

  return {
    bestScore: eligible.length > 0 ? Math.max(...eligible) : null,
    attemptScores,
    eligibleCount: eligible.length,
  };
}

module.exports = { computeAuthoritativeBestScore };
