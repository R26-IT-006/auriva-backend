'use strict';

// Feature 11B Phase 4 — sanity tests for the single authoritative 20-letter
// reassessment config (src/config/letterMotorReassessmentLetters.js).

const {
  LETTER_MOTOR_REASSESSMENT_LETTERS,
  getRequiredLetterPairs,
  getRequiredLetterCount,
  isRequiredReassessmentLetter,
  getMissingLetterPairs,
  lookupKey,
} = require('../src/config/letterMotorReassessmentLetters');

describe('LETTER_MOTOR_REASSESSMENT_LETTERS', () => {
  it('has exactly 20 entries', () => {
    expect(LETTER_MOTOR_REASSESSMENT_LETTERS.length).toBe(20);
    expect(getRequiredLetterCount()).toBe(20);
  });

  it('has no duplicate (letter, caseType) pairs', () => {
    const keys = LETTER_MOTOR_REASSESSMENT_LETTERS.map(e => lookupKey(e.letter, e.caseType));
    expect(new Set(keys).size).toBe(20);
  });

  it('is exactly 10 uppercase + 10 lowercase, one form per identity (A/a, B/b, ...)', () => {
    const upper = LETTER_MOTOR_REASSESSMENT_LETTERS.filter(e => e.caseType === 'uppercase');
    const lower = LETTER_MOTOR_REASSESSMENT_LETTERS.filter(e => e.caseType === 'lowercase');
    expect(upper.length).toBe(10);
    expect(lower.length).toBe(10);
    const upperSet = new Set(upper.map(e => e.letter.toLowerCase()));
    const lowerSet = new Set(lower.map(e => e.letter));
    expect(upperSet).toEqual(lowerSet);
  });

  it('every entry has caseType matching the letter case', () => {
    for (const { letter, caseType } of LETTER_MOTOR_REASSESSMENT_LETTERS) {
      if (caseType === 'uppercase') expect(letter).toBe(letter.toUpperCase());
      if (caseType === 'lowercase') expect(letter).toBe(letter.toLowerCase());
    }
  });
});

describe('getRequiredLetterPairs()', () => {
  it('returns a fresh, independently mutable copy each call', () => {
    const a = getRequiredLetterPairs();
    a.push({ letter: 'Z', caseType: 'uppercase' });
    const b = getRequiredLetterPairs();
    expect(b.length).toBe(20);
  });
});

describe('isRequiredReassessmentLetter()', () => {
  it('returns true for every one of the 20 pairs', () => {
    for (const { letter, caseType } of LETTER_MOTOR_REASSESSMENT_LETTERS) {
      expect(isRequiredReassessmentLetter(letter, caseType)).toBe(true);
    }
  });

  it('returns false for a letter not in the set (e.g. Z/z)', () => {
    expect(isRequiredReassessmentLetter('Z', 'uppercase')).toBe(false);
    expect(isRequiredReassessmentLetter('z', 'lowercase')).toBe(false);
  });

  it('returns false for a valid letter but wrong case', () => {
    expect(isRequiredReassessmentLetter('A', 'lowercase')).toBe(false); // 'A' is only required as uppercase
  });

  it('returns false for malformed input without throwing', () => {
    expect(isRequiredReassessmentLetter('', 'uppercase')).toBe(false);
    expect(isRequiredReassessmentLetter('AB', 'uppercase')).toBe(false);
    expect(isRequiredReassessmentLetter(null, 'uppercase')).toBe(false);
    expect(isRequiredReassessmentLetter('A', 'nonsense')).toBe(false);
  });
});

describe('getMissingLetterPairs()', () => {
  it('returns all 20 when nothing is collected', () => {
    expect(getMissingLetterPairs(new Set()).length).toBe(20);
  });

  it('returns 0 when all 20 keys are collected', () => {
    const allKeys = new Set(LETTER_MOTOR_REASSESSMENT_LETTERS.map(e => lookupKey(e.letter, e.caseType)));
    expect(getMissingLetterPairs(allKeys)).toEqual([]);
  });

  it('returns exactly the uncollected ones for a partial set', () => {
    const collected = new Set([lookupKey('A', 'uppercase'), lookupKey('a', 'lowercase')]);
    const missing = getMissingLetterPairs(collected);
    expect(missing.length).toBe(18);
    expect(missing.find(m => m.letter === 'A')).toBeUndefined();
    expect(missing.find(m => m.letter === 'a')).toBeUndefined();
  });
});
