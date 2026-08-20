'use strict';

// Feature 11B Phase 5 — proves the backend's static letter-membership copy
// (src/config/letterLearningCategories.js) matches the frontend's
// production teaching taxonomy exactly.
//
// auriva-frontend and auriva-backend are two independent git repositories
// (see tests/letterSupportLevelsParity.test.js's identical rationale) —
// this is a manually-synced golden copy of
// auriva-frontend/src/constants/letterCategories.js's LETTER_CATEGORIES
// letter membership (letters only, not complexity/motorRequirements),
// confirmed against that file directly during this feature's audit.
// Whenever letterCategories.js's letter membership changes, both this
// golden copy AND letterLearningCategories.js itself must be updated in
// the same change — this test is the tripwire that catches a forgotten
// update.
const { LETTER_LEARNING_CATEGORIES, getCategoryLetters, ALL_CATEGORY_KEYS } = require('../src/config/letterLearningCategories');

const FRONTEND_LETTER_CATEGORIES = {
  lowercase: {
    straight: ['l', 'i', 't'],
    curved:   ['o', 'c', 'e', 'u', 'a', 's'],
    mixed:    ['d', 'g', 'n', 'r', 'h', 'f', 'k', 'v', 'w', 'y', 'b', 'j', 'm', 'p', 'q', 'x', 'z'],
  },
  uppercase: {
    straight: ['I', 'L', 'T', 'F', 'E', 'H'],
    curved:   ['O', 'C', 'U', 'J', 'S', 'G', 'Q'],
    mixed:    ['D', 'P', 'B', 'V', 'Y', 'A', 'K', 'M', 'N', 'R', 'W', 'X', 'Z'],
  },
};

describe('Parity — backend category letters match the frontend taxonomy exactly', () => {
  for (const caseType of ['lowercase', 'uppercase']) {
    for (const category of ['straight', 'curved', 'mixed']) {
      it(`${caseType}.${category} matches exactly, in order`, () => {
        expect(LETTER_LEARNING_CATEGORIES[caseType][category]).toEqual(FRONTEND_LETTER_CATEGORIES[caseType][category]);
      });
    }
  }
});

describe('Coverage — every letter appears in exactly one category per case', () => {
  it('lowercase: 26 letters total, no duplicates across categories', () => {
    const all = [
      ...LETTER_LEARNING_CATEGORIES.lowercase.straight,
      ...LETTER_LEARNING_CATEGORIES.lowercase.curved,
      ...LETTER_LEARNING_CATEGORIES.lowercase.mixed,
    ];
    expect(all.length).toBe(26);
    expect(new Set(all).size).toBe(26);
  });

  it('uppercase: 26 letters total, no duplicates across categories', () => {
    const all = [
      ...LETTER_LEARNING_CATEGORIES.uppercase.straight,
      ...LETTER_LEARNING_CATEGORIES.uppercase.curved,
      ...LETTER_LEARNING_CATEGORIES.uppercase.mixed,
    ];
    expect(all.length).toBe(26);
    expect(new Set(all).size).toBe(26);
  });
});

describe('getCategoryLetters()', () => {
  it('returns the right letters for a valid pair', () => {
    expect(getCategoryLetters('lowercase', 'straight')).toEqual(['l', 'i', 't']);
  });

  it('returns [] for an invalid caseType/category, never throws', () => {
    expect(getCategoryLetters('sideways', 'straight')).toEqual([]);
    expect(getCategoryLetters('lowercase', 'nonsense')).toEqual([]);
  });

  it('returns a fresh copy — mutating the result never corrupts the config', () => {
    const letters = getCategoryLetters('lowercase', 'straight');
    letters.push('Z');
    expect(getCategoryLetters('lowercase', 'straight')).toEqual(['l', 'i', 't']);
  });
});

describe('ALL_CATEGORY_KEYS', () => {
  it('enumerates exactly the 6 (caseType, category) pairs', () => {
    expect(ALL_CATEGORY_KEYS.length).toBe(6);
    const keys = ALL_CATEGORY_KEYS.map(k => `${k.caseType}|${k.category}`).sort();
    expect(keys).toEqual([
      'lowercase|curved', 'lowercase|mixed', 'lowercase|straight',
      'uppercase|curved', 'uppercase|mixed', 'uppercase|straight',
    ]);
  });
});
