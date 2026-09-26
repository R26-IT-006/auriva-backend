'use strict';

// Feature 11B Phase 5 — sanity tests for the renamed reference-letter
// config (src/config/letterMotorReferenceLetters.js), formerly
// letterMotorReassessmentLetters.js. Same 20 pairs, same guarantees.

const {
  LETTER_MOTOR_REFERENCE_LETTERS,
  getReferenceLetterPairs,
  getReferenceLetterCount,
  isReferenceLetter,
  lookupKey,
} = require('../src/config/letterMotorReferenceLetters');

describe('LETTER_MOTOR_REFERENCE_LETTERS', () => {
  it('has exactly 20 entries', () => {
    expect(LETTER_MOTOR_REFERENCE_LETTERS.length).toBe(20);
    expect(getReferenceLetterCount()).toBe(20);
  });

  it('has no duplicate (letter, caseType) pairs', () => {
    const keys = LETTER_MOTOR_REFERENCE_LETTERS.map(e => lookupKey(e.letter, e.caseType));
    expect(new Set(keys).size).toBe(20);
  });

  it('is exactly the 10 uppercase + 10 lowercase letters from the spec', () => {
    const upper = LETTER_MOTOR_REFERENCE_LETTERS.filter(e => e.caseType === 'uppercase').map(e => e.letter).sort();
    const lower = LETTER_MOTOR_REFERENCE_LETTERS.filter(e => e.caseType === 'lowercase').map(e => e.letter).sort();
    expect(upper).toEqual(['A', 'B', 'C', 'H', 'I', 'K', 'L', 'O', 'S', 'T']);
    expect(lower).toEqual(['a', 'b', 'c', 'h', 'i', 'k', 'l', 'o', 's', 't']);
  });
});

describe('getReferenceLetterPairs()', () => {
  it('returns a fresh, independently mutable copy each call', () => {
    const a = getReferenceLetterPairs();
    a.push({ letter: 'Z', caseType: 'uppercase' });
    expect(getReferenceLetterPairs().length).toBe(20);
  });
});

describe('isReferenceLetter()', () => {
  it('returns true for every one of the 20 pairs', () => {
    for (const { letter, caseType } of LETTER_MOTOR_REFERENCE_LETTERS) {
      expect(isReferenceLetter(letter, caseType)).toBe(true);
    }
  });

  it('returns false for a non-reference letter', () => {
    expect(isReferenceLetter('Z', 'uppercase')).toBe(false);
    expect(isReferenceLetter('z', 'lowercase')).toBe(false);
    expect(isReferenceLetter('d', 'lowercase')).toBe(false);
  });

  it('returns false for a reference letter in the wrong case', () => {
    expect(isReferenceLetter('A', 'lowercase')).toBe(false);
  });

  it('returns false for malformed input without throwing', () => {
    expect(isReferenceLetter('', 'uppercase')).toBe(false);
    expect(isReferenceLetter(null, 'uppercase')).toBe(false);
    expect(isReferenceLetter('A', 'nonsense')).toBe(false);
  });
});
