'use strict';

/**
 * initialMotorBaselineSummary.js
 *
 * Pure, deterministic, teacher-facing summary of a student's persisted
 * Feature 1 initial motor baseline. No ML, no clustering, no database
 * access, no score recalculation — it reads the four already-persisted
 * authoritative values and reports them plus a within-learner relative
 * comparison.
 *
 * Inputs (StudentMotorBaseline columns, used exactly as stored):
 *   straight_score, curved_score, complex_score, overall_motor_score
 * The progression_* columns are deliberately NOT read here — those belong
 * to the computeMotorScore-domain progression path, not to this
 * assessment-domain baseline summary.
 *
 * ── Score resolution and tie tolerance (both derived, not invented) ───────
 * Every value this module compares is an integer 0-100 by construction:
 *   1. per-shape score  — computeUnifiedShapeScore() returns
 *      `Math.round(clamp(motor_score, 0, 100))`
 *      (see auriva-frontend/src/utils/unifiedShapeScore.js);
 *   2. family score     — calculateMotorProfile() computes
 *      `Math.round((shapeA + shapeB) / 2)` per family
 *      (see auriva-frontend/src/utils/adaptiveSequencing.js);
 *   3. overall score    — `Math.round(mean(per-shape motor_score))`
 *      (see auriva-frontend/src/screens/handwriting/AssessmentCompleteScreen.js);
 *   4. persistence      — validateMotorProfileForBaseline() copies all four
 *      verbatim, never recalculating (see motorBaselineService.js).
 * handwritingController.js's own motor_profile comparison helper documents
 * the same fact against live data ("floats, not rounded like the three
 * family scores").
 *
 * Therefore SCORE_RESOLUTION = 1 and the smallest possible non-zero
 * difference between two family scores is exactly 1.
 *
 * TIE_TOLERANCE = 0.5 is half of one resolution step. For conformant
 * integer data this is behaviourally IDENTICAL to exact equality (any two
 * distinct integers differ by >= 1, which is never < 0.5), so it can never
 * merge two genuinely adjacent scores. It exists only so that historical /
 * backfilled rows — the columns are FLOAT and non-integer values do occur
 * elsewhere in this system — cannot produce a reported ordering from a
 * difference below the measurement resolution.
 *
 * NOTE: this is deliberately NOT the 10-point buffer calculateMotorProfile()
 * uses for `primaryStrength`. That buffer keeps an adaptive SEQUENCING
 * decision stable against noise; this module's job is to report the
 * measured values faithfully. Different purposes, intentionally different
 * constants.
 *
 * Language rule: neutral, within-learner, descriptive only. Never
 * good/bad, mild/moderate/severe, impaired, normal/abnormal, better/worse,
 * and never any clinical or ASD-severity interpretation.
 */

const SCORE_RESOLUTION = 1;
const TIE_TOLERANCE = 0.5;

const FAMILY_KEYS = ['straight', 'curved', 'complex'];

const FAMILY_LABELS = {
  straight: 'Straight',
  curved:   'Curved',
  complex:  'Complex',
};

const DISCLOSURE =
  'These values summarize performance during the initial motor assessment and are intended for '
  + 'educational monitoring. They are not diagnostic or ASD-severity measures.';

const UNAVAILABLE_DESCRIPTION =
  'A complete initial motor baseline is not available for this student.';

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Points are integers in practice (see header); the decimal branch exists
// only for historical non-integer rows and never invents precision.
function formatPoints(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded} ${Math.abs(rounded) === 1 ? 'point' : 'points'}`;
}

function joinLabels(keys) {
  const labels = keys.map((key) => FAMILY_LABELS[key]);
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * Groups the three families into descending tie groups.
 *
 * A family joins the current group when it is within TIE_TOLERANCE of that
 * group's FIRST (highest) member — a deterministic anchor rather than
 * pairwise chaining, so the grouping can never depend on iteration order.
 * For integer data (the real case) this is exact-equality grouping.
 * Ties are ordered by the canonical FAMILY_KEYS order, never by input order.
 */
function buildTieGroups(families) {
  const ordered = FAMILY_KEYS
    .slice()
    .sort((a, b) => (families[b] - families[a]) || (FAMILY_KEYS.indexOf(a) - FAMILY_KEYS.indexOf(b)));

  const groups = [];
  for (const key of ordered) {
    const current = groups[groups.length - 1];
    if (current && Math.abs(families[current[0]] - families[key]) < TIE_TOLERANCE) {
      current.push(key);
    } else {
      groups.push([key]);
    }
  }

  // Canonical ordering within each tie group.
  return groups.map((group) => group.slice().sort((a, b) => FAMILY_KEYS.indexOf(a) - FAMILY_KEYS.indexOf(b)));
}

function buildDescription({ tieGroups, spread, tied }) {
  if (tied) {
    return 'Within the initial assessment, the Straight, Curved and Complex movement family scores '
      + `differed by less than ${TIE_TOLERANCE} points, so no single highest or lowest movement `
      + 'family is reported.';
  }

  const highestGroup = tieGroups[0];
  const lowestGroup = tieGroups[tieGroups.length - 1];

  const highestClause = highestGroup.length === 1
    ? `the ${joinLabels(highestGroup)} movement family had the highest measured score`
    : `the ${joinLabels(highestGroup)} movement families had the highest measured scores`;

  const lowestClause = lowestGroup.length === 1
    ? `the ${joinLabels(lowestGroup)} movement family had the lowest measured score`
    : `the ${joinLabels(lowestGroup)} movement families had the lowest measured scores`;

  const differenceClause = (highestGroup.length === 1 && lowestGroup.length === 1)
    ? `The difference between them was ${formatPoints(spread)}.`
    : `The difference between the highest and lowest measured scores was ${formatPoints(spread)}.`;

  return `Within the initial assessment, ${highestClause}, and ${lowestClause}. ${differenceClause}`;
}

function unavailableSummary() {
  return {
    available: false,
    overall_score: null,
    families: { straight: null, curved: null, complex: null },
    relative_summary: {
      highest: null,
      lowest: null,
      spread: null,
      tied: null,
      tie_groups: [],
      tolerance: TIE_TOLERANCE,
      score_resolution: SCORE_RESOLUTION,
    },
    description: UNAVAILABLE_DESCRIPTION,
    disclosure: DISCLOSURE,
  };
}

/**
 * Builds the Initial Motor Baseline Summary from the four authoritative
 * persisted scores. Pure: no I/O, no mutation of the input, no rounding or
 * rescaling of any score. Never throws — any missing/non-finite value
 * yields the neutral `available: false` shape rather than a partial
 * interpretation.
 *
 * @param {{straightScore, curvedScore, complexScore, overallMotorScore}} scores
 * @returns {{
 *   available: boolean,
 *   overall_score: number|null,
 *   families: {straight: number|null, curved: number|null, complex: number|null},
 *   relative_summary: {
 *     highest: string|null, lowest: string|null, spread: number|null,
 *     tied: boolean|null, tie_groups: string[][],
 *     tolerance: number, score_resolution: number
 *   },
 *   description: string,
 *   disclosure: string,
 * }}
 */
function buildInitialMotorBaselineSummary({ straightScore, curvedScore, complexScore, overallMotorScore } = {}) {
  const families = { straight: straightScore, curved: curvedScore, complex: complexScore };

  const allPresent = FAMILY_KEYS.every((key) => isFiniteNumber(families[key]))
    && isFiniteNumber(overallMotorScore);
  if (!allPresent) return unavailableSummary();

  const values = FAMILY_KEYS.map((key) => families[key]);
  const spread = Math.max(...values) - Math.min(...values);

  const tieGroups = buildTieGroups(families);
  // A single group means every family is within tolerance of the highest —
  // there is no meaningful ordering at all, so neither end is reported.
  const tied = tieGroups.length === 1;
  const highestGroup = tieGroups[0];
  const lowestGroup = tieGroups[tieGroups.length - 1];

  return {
    available: true,
    overall_score: overallMotorScore,
    families: { straight: families.straight, curved: families.curved, complex: families.complex },
    relative_summary: {
      highest: (!tied && highestGroup.length === 1) ? highestGroup[0] : null,
      lowest:  (!tied && lowestGroup.length === 1) ? lowestGroup[0] : null,
      spread,
      tied,
      tie_groups: tieGroups,
      tolerance: TIE_TOLERANCE,
      score_resolution: SCORE_RESOLUTION,
    },
    description: buildDescription({ tieGroups, spread, tied }),
    disclosure: DISCLOSURE,
  };
}

module.exports = {
  buildInitialMotorBaselineSummary,
  SCORE_RESOLUTION,
  TIE_TOLERANCE,
  FAMILY_KEYS,
  FAMILY_LABELS,
  DISCLOSURE,
};
