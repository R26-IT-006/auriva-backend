'use strict';

/**
 * letterMotorMilestones.js
 *
 * Feature 11B Phase 5 — the three pilot cluster-eligibility milestones
 * (spec §1/§13/§14/§15), derived programmatically from
 * letterLearningCategories.js + letterMotorReferenceLetters.js rather than
 * hardcoded a third time, so the milestone letter sets can never silently
 * drift from the taxonomy/reference-set files they're built from.
 *
 *   UPPERCASE_STRAIGHT_14 — first eligible milestone. Required set = every
 *     reference letter in the 4 lowercase categories (10) + uppercase
 *     straight (4) = 14.
 *   UPPERCASE_CURVED_17   — 14-set + uppercase curved's 3 reference letters
 *     (C, O, S) = 17.
 *   FULL_REFERENCE_20     — 17-set + uppercase mixed's 3 reference letters
 *     (A, B, K) = 20 (the complete reference set).
 *
 * Each milestone's requiredPairs is therefore always an exact, named,
 * reviewable subset of the 20 reference letters — never "any N reference
 * letters," matching spec §13's "Do not substitute other letters to reach
 * count 14" requirement.
 *
 * PILOT POLICY, per the research decision this file encodes (spec §1):
 * these three thresholds come from an n=7 pilot perturbation study and are
 * NOT claimed to generalize. 3/20, 7/20, 10/20 (lowercase-only coverage)
 * are deliberately NOT milestones here — trend/evidence display only, no
 * ML call, no state-history row (spec §12/§18).
 */

const { getCategoryLetters, isReferenceLetterInCategory } = (() => {
  const { getCategoryLetters: getLetters } = require('./letterLearningCategories');
  const { isReferenceLetter } = require('./letterMotorReferenceLetters');
  return {
    getCategoryLetters: getLetters,
    isReferenceLetterInCategory: (caseType, category) =>
      getLetters(caseType, category).filter(letter => isReferenceLetter(letter, caseType)).map(letter => ({ letter, caseType })),
  };
})();

const MILESTONE_UPPERCASE_STRAIGHT_14 = 'UPPERCASE_STRAIGHT_14';
const MILESTONE_UPPERCASE_CURVED_17   = 'UPPERCASE_CURVED_17';
const MILESTONE_FULL_REFERENCE_20     = 'FULL_REFERENCE_20';

// Composition, exactly matching the audited category-overlap accounting:
//   lowercase straight -> i, l, t                  (3)
//   lowercase curved   -> a, c, o, s                (4)
//   lowercase mixed    -> b, h, k                   (3)
//   uppercase straight -> H, I, L, T                (4)   => 14 cumulative
//   uppercase curved   -> C, O, S                    (3)   => 17 cumulative
//   uppercase mixed    -> A, B, K                    (3)   => 20 cumulative
const LOWERCASE_STRAIGHT_REF = isReferenceLetterInCategory('lowercase', 'straight');
const LOWERCASE_CURVED_REF   = isReferenceLetterInCategory('lowercase', 'curved');
const LOWERCASE_MIXED_REF    = isReferenceLetterInCategory('lowercase', 'mixed');
const UPPERCASE_STRAIGHT_REF = isReferenceLetterInCategory('uppercase', 'straight');
const UPPERCASE_CURVED_REF   = isReferenceLetterInCategory('uppercase', 'curved');
const UPPERCASE_MIXED_REF    = isReferenceLetterInCategory('uppercase', 'mixed');

const FOURTEEN_SET = [
  ...LOWERCASE_STRAIGHT_REF, ...LOWERCASE_CURVED_REF, ...LOWERCASE_MIXED_REF,
  ...UPPERCASE_STRAIGHT_REF,
];
const SEVENTEEN_SET = [...FOURTEEN_SET, ...UPPERCASE_CURVED_REF];
const TWENTY_SET     = [...SEVENTEEN_SET, ...UPPERCASE_MIXED_REF];

const MILESTONES = [
  {
    code: MILESTONE_UPPERCASE_STRAIGHT_14,
    coverageN: 14,
    completedCategory: { caseType: 'uppercase', category: 'straight' },
    requiredPairs: FOURTEEN_SET,
  },
  {
    code: MILESTONE_UPPERCASE_CURVED_17,
    coverageN: 17,
    completedCategory: { caseType: 'uppercase', category: 'curved' },
    requiredPairs: SEVENTEEN_SET,
  },
  {
    code: MILESTONE_FULL_REFERENCE_20,
    coverageN: 20,
    completedCategory: { caseType: 'uppercase', category: 'mixed' },
    requiredPairs: TWENTY_SET,
  },
];

// Sanity-checked at module load (cheap, pure, no I/O) — a real error here
// means the taxonomy/reference files disagree with the documented
// composition above, which must never silently produce a wrong-sized
// milestone. Throws at import time rather than failing a later ML call
// with confusing evidence.
for (const m of MILESTONES) {
  if (m.requiredPairs.length !== m.coverageN) {
    throw new Error(
      `letterMotorMilestones.js: ${m.code} composed to ${m.requiredPairs.length} pairs, expected ${m.coverageN}. ` +
      'letterLearningCategories.js and letterMotorReferenceLetters.js may have drifted out of sync.'
    );
  }
}

module.exports = {
  MILESTONE_UPPERCASE_STRAIGHT_14,
  MILESTONE_UPPERCASE_CURVED_17,
  MILESTONE_FULL_REFERENCE_20,
  MILESTONES,
};
