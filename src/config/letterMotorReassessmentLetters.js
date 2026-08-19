'use strict';

/**
 * letterMotorReassessmentLetters.js
 *
 * Feature 11B Phase 4 — the single authoritative list of the 20 exact
 * (letter, caseType) pairs a standardized Letter Motor Reassessment must
 * collect one valid, eligible observation for before letterMotorReassessmentService.js
 * is allowed to call the ML service. This is the SAME 20-letter set used to
 * train letter_motor_cluster_v1 (see the Feature 11 Continuous Profile Study
 * Step 2 stroke-composition export and the Phase 2 coverage audit's
 * TRAINING_LETTERS list) — reproduced here as the one authoritative,
 * versioned, reviewable source so no service ever hardcodes its own copy.
 *
 * No partial/minimum-N fallback exists anywhere that reads this list: a
 * reassessment session is only eligible for finalization once it has
 * exactly one valid row for EVERY entry below (see
 * letterMotorReassessmentService.js's finalizeReassessment()).
 *
 * Deliberately NOT derived from letterBaselineFamilies.js,
 * letterCategories.js, or letterMotorPrimitives.js — this list is a
 * fixed, closed training-set membership question ("was this exact letter
 * form one of the 20 the model was trained on?"), not a shape/motor-family
 * classification question. Reusing one of those taxonomies here would wire
 * an unrelated concept's future edits into this list by accident.
 */

const LIST_VERSION = 'letter-motor-reassessment-letters-v1';

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

// Ordered exactly as the Phase 2 coverage audit / Colab training export:
// 10 uppercase (A,B,C,H,I,K,L,O,S,T), then their 10 lowercase counterparts.
const LETTER_MOTOR_REASSESSMENT_LETTERS = [
  { letter: 'A', caseType: 'uppercase' },
  { letter: 'B', caseType: 'uppercase' },
  { letter: 'C', caseType: 'uppercase' },
  { letter: 'H', caseType: 'uppercase' },
  { letter: 'I', caseType: 'uppercase' },
  { letter: 'K', caseType: 'uppercase' },
  { letter: 'L', caseType: 'uppercase' },
  { letter: 'O', caseType: 'uppercase' },
  { letter: 'S', caseType: 'uppercase' },
  { letter: 'T', caseType: 'uppercase' },
  { letter: 'a', caseType: 'lowercase' },
  { letter: 'b', caseType: 'lowercase' },
  { letter: 'c', caseType: 'lowercase' },
  { letter: 'h', caseType: 'lowercase' },
  { letter: 'i', caseType: 'lowercase' },
  { letter: 'k', caseType: 'lowercase' },
  { letter: 'l', caseType: 'lowercase' },
  { letter: 'o', caseType: 'lowercase' },
  { letter: 's', caseType: 'lowercase' },
  { letter: 't', caseType: 'lowercase' },
];

function lookupKey(letter, caseType) {
  return `${letter}|${caseType}`;
}

const REQUIRED_KEYS = new Set(
  LETTER_MOTOR_REASSESSMENT_LETTERS.map(({ letter, caseType }) => lookupKey(letter, caseType))
);

/**
 * @returns {{letter: string, caseType: string}[]} a fresh copy — callers
 *   must not mutate the shared constant.
 */
function getRequiredLetterPairs() {
  return LETTER_MOTOR_REASSESSMENT_LETTERS.map(entry => ({ ...entry }));
}

/**
 * @returns {number} always 20 — exposed as a named constant so callers
 *   never hardcode the literal 20 in more than one place.
 */
function getRequiredLetterCount() {
  return LETTER_MOTOR_REASSESSMENT_LETTERS.length;
}

/**
 * @param {string} letter
 * @param {string} caseType
 * @returns {boolean} true iff this exact (letter, caseType) pair is one of
 *   the 20 required training letters.
 */
function isRequiredReassessmentLetter(letter, caseType) {
  if (typeof letter !== 'string' || letter.length !== 1) return false;
  if (!VALID_CASE_TYPES.includes(caseType)) return false;
  return REQUIRED_KEYS.has(lookupKey(letter, caseType));
}

/**
 * Given a set of collected {letter, caseType} keys (as produced by
 * lookupKey / matching that shape), returns which of the 20 required pairs
 * are still missing. Used by the service layer to decide whether a
 * reassessment session is eligible for finalization, and to report exactly
 * what's missing to the caller when it is not.
 *
 * @param {Set<string>} collectedKeys — keys in "letter|caseType" form
 * @returns {{letter: string, caseType: string}[]}
 */
function getMissingLetterPairs(collectedKeys) {
  return LETTER_MOTOR_REASSESSMENT_LETTERS
    .filter(({ letter, caseType }) => !collectedKeys.has(lookupKey(letter, caseType)))
    .map(entry => ({ ...entry }));
}

module.exports = {
  LIST_VERSION,
  LETTER_MOTOR_REASSESSMENT_LETTERS,
  lookupKey,
  getRequiredLetterPairs,
  getRequiredLetterCount,
  isRequiredReassessmentLetter,
  getMissingLetterPairs,
};
