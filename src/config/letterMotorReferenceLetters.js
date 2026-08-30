'use strict';

/**
 * letterMotorReferenceLetters.js
 *
 * Feature 11B Phase 5 — the single authoritative list of the 20 exact
 * (letter, caseType) pairs letter_motor_cluster_v1 was trained on. This is
 * the SAME 20-letter set as Phase 4's now-removed
 * letterMotorReassessmentLetters.js (renamed here — Phase 5 replaced the
 * explicit 20-letter reassessment-session design with mastery-evidence
 * accumulation during normal learning; see letterMotorMasteryService.js).
 * The list itself, and its role as "which letters are eligible to become
 * Feature 11B evidence," is unchanged.
 *
 * A letter/case pair is a "reference letter" here iff it was one of the 20
 * used to train the frozen K=2 model. Only mastery of a reference letter
 * can ever produce a letter_motor_mastery_evidence row — mastering any
 * other letter (the remaining 32 of the 52-letter curriculum) never
 * contributes to Feature 11B (see §9 eligibility rule).
 */

const LIST_VERSION = 'letter-motor-reference-letters-v1';

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

// Ordered exactly as the Colab training export: 10 uppercase (A,B,C,H,I,K,
// L,O,S,T), then their 10 lowercase counterparts.
const LETTER_MOTOR_REFERENCE_LETTERS = [
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

const REFERENCE_KEYS = new Set(
  LETTER_MOTOR_REFERENCE_LETTERS.map(({ letter, caseType }) => lookupKey(letter, caseType))
);

/**
 * @returns {{letter: string, caseType: string}[]} a fresh copy — callers
 *   must not mutate the shared constant.
 */
function getReferenceLetterPairs() {
  return LETTER_MOTOR_REFERENCE_LETTERS.map(entry => ({ ...entry }));
}

/**
 * @returns {number} always 20.
 */
function getReferenceLetterCount() {
  return LETTER_MOTOR_REFERENCE_LETTERS.length;
}

/**
 * @param {string} letter
 * @param {string} caseType
 * @returns {boolean} true iff this exact (letter, caseType) pair is one of
 *   the 20 letter_motor_cluster_v1 training letters.
 */
function isReferenceLetter(letter, caseType) {
  if (typeof letter !== 'string' || letter.length !== 1) return false;
  if (!VALID_CASE_TYPES.includes(caseType)) return false;
  return REFERENCE_KEYS.has(lookupKey(letter, caseType));
}

module.exports = {
  LIST_VERSION,
  LETTER_MOTOR_REFERENCE_LETTERS,
  lookupKey,
  getReferenceLetterPairs,
  getReferenceLetterCount,
  isReferenceLetter,
};
