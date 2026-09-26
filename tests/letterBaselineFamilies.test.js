'use strict';

const {
  MAPPING_VERSION, LETTER_BASELINE_FAMILIES,
  getLetterBaselineMapping, getBaselineFamily, isBaselineFamilyMapped,
  getMappedLettersForFamily,
  validateLetterBaselineFamilies,
} = require('../src/config/letterBaselineFamilies');

// ─── Mapping Test 1 — known clean straight mappings ────────────────────────

describe('Mapping Test 1 — known clean straight mappings', () => {
  it.each([
    ['l', 'lowercase'], ['i', 'lowercase'], ['t', 'lowercase'],
    ['I', 'uppercase'], ['L', 'uppercase'], ['T', 'uppercase'],
    ['E', 'uppercase'], ['F', 'uppercase'], ['H', 'uppercase'],
  ])('%s (%s) resolves to straight', (letter, caseType) => {
    expect(getBaselineFamily(letter, caseType)).toBe('straight');
  });
});

// ─── Mapping Test 2 — known clean curved mappings ──────────────────────────

describe('Mapping Test 2 — known clean curved mappings', () => {
  it.each([
    ['o', 'lowercase'], ['c', 'lowercase'],
    ['O', 'uppercase'], ['C', 'uppercase'],
  ])('%s (%s) resolves to curved', (letter, caseType) => {
    expect(getBaselineFamily(letter, caseType)).toBe('curved');
  });
});

// ─── Mapping Test 3 — known clean complex mappings ─────────────────────────

describe('Mapping Test 3 — known clean complex mappings', () => {
  it.each([
    ['v', 'lowercase'], ['w', 'lowercase'], ['x', 'lowercase'], ['y', 'lowercase'],
    ['s', 'lowercase'], ['u', 'lowercase'],
    ['V', 'uppercase'], ['W', 'uppercase'], ['X', 'uppercase'],
    ['S', 'uppercase'], ['U', 'uppercase'],
  ])('%s (%s) resolves to complex', (letter, caseType) => {
    expect(getBaselineFamily(letter, caseType)).toBe('complex');
  });
});

// ─── Mapping Test 4 — ambiguous/unmapped letters return null ──────────────

describe('Mapping Test 4 — ambiguous/unmapped letters return null', () => {
  it.each([
    ['a', 'lowercase'], ['k', 'lowercase'], ['m', 'lowercase'], ['n', 'lowercase'], ['r', 'lowercase'],
    ['A', 'uppercase'], ['K', 'uppercase'], ['M', 'uppercase'], ['N', 'uppercase'], ['R', 'uppercase'],
  ])('%s (%s) is genuinely ambiguous — baselineFamily is null', (letter, caseType) => {
    expect(getBaselineFamily(letter, caseType)).toBeNull();
    // Ambiguous is a distinct state from "no entry at all" — the entry exists.
    const mapping = getLetterBaselineMapping(letter, caseType);
    expect(mapping).not.toBeNull();
    expect(mapping.mappingConfidence).toBe('ambiguous');
  });

  it('a character with no entry at all also returns null, not an error', () => {
    expect(getBaselineFamily('1', 'lowercase')).toBeNull();
    expect(getLetterBaselineMapping('1', 'lowercase')).toBeNull();
  });
});

// ─── Mapping Test 5 — uppercase/lowercase independence ─────────────────────

describe('Mapping Test 5 — uppercase/lowercase independence', () => {
  it('lowercase y is clean-complex while uppercase Y is ambiguous — not assumed equal', () => {
    expect(getBaselineFamily('y', 'lowercase')).toBe('complex');
    expect(getBaselineFamily('Y', 'uppercase')).toBeNull();
  });

  it('a (lowercase) and A (uppercase) resolve independently', () => {
    // Both happen to be ambiguous today, but via independent entries, not
    // because the lookup coerces one case into the other.
    const lower = getLetterBaselineMapping('a', 'lowercase');
    const upper = getLetterBaselineMapping('A', 'uppercase');
    expect(lower).not.toBe(upper);
    expect(lower.letter).toBe('a');
    expect(upper.letter).toBe('A');
  });

  it('does not coerce a mismatched letter/caseType pairing to an existing entry', () => {
    // 'a' only has an entry paired with 'lowercase' — asking for it paired
    // with 'uppercase' must not silently fall back to the 'A' entry.
    expect(getLetterBaselineMapping('a', 'uppercase')).toBeNull();
    expect(getLetterBaselineMapping('A', 'lowercase')).toBeNull();
  });
});

// ─── Mapping Test 6 — invalid letter returns safe result ──────────────────

describe('Mapping Test 6 — invalid letter returns safe result', () => {
  it.each([
    ['$'], ['1'], ['ab'], [''], [null], [undefined], [5], [{}],
  ])('getBaselineFamily(%p, "lowercase") returns null, never throws', (badLetter) => {
    expect(() => getBaselineFamily(badLetter, 'lowercase')).not.toThrow();
    expect(getBaselineFamily(badLetter, 'lowercase')).toBeNull();
  });
});

// ─── Mapping Test 7 — invalid case type returns safe result ───────────────

describe('Mapping Test 7 — invalid case type returns safe result', () => {
  it.each([
    ['foo'], [''], [null], [undefined], ['Lowercase'], ['UPPERCASE'],
  ])('getBaselineFamily("a", %p) returns null, never throws', (badCaseType) => {
    expect(() => getBaselineFamily('a', badCaseType)).not.toThrow();
    expect(getBaselineFamily('a', badCaseType)).toBeNull();
  });
});

// ─── Mapping Test 8 — mapping version ──────────────────────────────────────

describe('Mapping Test 8 — mapping version', () => {
  it('MAPPING_VERSION is exactly letter-baseline-family-v1', () => {
    expect(MAPPING_VERSION).toBe('letter-baseline-family-v1');
  });
});

// ─── Mapping Test 9 — no invalid family strings exist ──────────────────────

describe('Mapping Test 9 — no invalid family strings exist', () => {
  it('every non-null baselineFamily is one of straight/curved/complex', () => {
    const allowed = new Set(['straight', 'curved', 'complex']);
    for (const entry of LETTER_BASELINE_FAMILIES) {
      if (entry.baselineFamily !== null) {
        expect(allowed.has(entry.baselineFamily)).toBe(true);
      }
    }
  });

  it('never uses "mixed" as a baseline family', () => {
    expect(LETTER_BASELINE_FAMILIES.some(e => e.baselineFamily === 'mixed')).toBe(false);
  });
});

// ─── Mapping Test 10 — no duplicate letter/case mapping ────────────────────

describe('Mapping Test 10 — no duplicate letter/case mapping', () => {
  it('every (letter, caseType) pair is unique', () => {
    const keys = LETTER_BASELINE_FAMILIES.map(e => `${e.letter}|${e.caseType}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ─── Coverage + validator sanity ───────────────────────────────────────────

describe('Coverage and isBaselineFamilyMapped', () => {
  it('covers all 26 lowercase and all 26 uppercase letters exactly once', () => {
    const lowercase = LETTER_BASELINE_FAMILIES.filter(e => e.caseType === 'lowercase');
    const uppercase = LETTER_BASELINE_FAMILIES.filter(e => e.caseType === 'uppercase');
    expect(lowercase).toHaveLength(26);
    expect(uppercase).toHaveLength(26);
  });

  it('isBaselineFamilyMapped is true only for reviewed (non-ambiguous) entries', () => {
    expect(isBaselineFamilyMapped('l', 'lowercase')).toBe(true);
    expect(isBaselineFamilyMapped('a', 'lowercase')).toBe(false);
    expect(isBaselineFamilyMapped('1', 'lowercase')).toBe(false);
  });
});

describe('validateLetterBaselineFamilies()', () => {
  it('reports the real mapping data as fully valid', () => {
    expect(validateLetterBaselineFamilies()).toEqual({ valid: true, errors: [] });
  });
});

// ─── Feature 2 Step 4 — getMappedLettersForFamily() ────────────────────────

describe('getMappedLettersForFamily()', () => {
  it('returns exactly the reviewed straight-family letter/case pairs', () => {
    const pairs = getMappedLettersForFamily('straight');
    const keys = pairs.map(p => `${p.letter}|${p.caseType}`).sort();
    expect(keys).toEqual([
      'E|uppercase', 'F|uppercase', 'H|uppercase', 'I|uppercase', 'L|uppercase', 'T|uppercase',
      'i|lowercase', 'l|lowercase', 't|lowercase',
    ].sort());
  });

  it('returns exactly the reviewed curved-family letter/case pairs', () => {
    const pairs = getMappedLettersForFamily('curved');
    const keys = pairs.map(p => `${p.letter}|${p.caseType}`).sort();
    expect(keys).toEqual(['C|uppercase', 'O|uppercase', 'c|lowercase', 'o|lowercase'].sort());
  });

  it('returns exactly the reviewed complex-family letter/case pairs, including s/S and u/U (not curved)', () => {
    const pairs = getMappedLettersForFamily('complex');
    const keys = pairs.map(p => `${p.letter}|${p.caseType}`).sort();
    expect(keys).toEqual([
      'S|uppercase', 'U|uppercase', 'V|uppercase', 'W|uppercase', 'X|uppercase',
      's|lowercase', 'u|lowercase', 'v|lowercase', 'w|lowercase', 'x|lowercase', 'y|lowercase',
    ].sort());
    // Case-independence spot check: lowercase 'y' is clean-complex, uppercase
    // 'Y' is ambiguous — 'Y' must NOT appear in this list.
    expect(keys).not.toContain('Y|uppercase');
  });

  it('every entry returned is consistent with getBaselineFamily for that exact pair', () => {
    for (const family of ['straight', 'curved', 'complex']) {
      for (const { letter, caseType } of getMappedLettersForFamily(family)) {
        expect(getBaselineFamily(letter, caseType)).toBe(family);
      }
    }
  });

  it('the three families are pairwise disjoint and together account for every "reviewed" entry', () => {
    const straight = getMappedLettersForFamily('straight');
    const curved = getMappedLettersForFamily('curved');
    const complex_ = getMappedLettersForFamily('complex');
    const allKeys = [...straight, ...curved, ...complex_].map(p => `${p.letter}|${p.caseType}`);
    expect(new Set(allKeys).size).toBe(allKeys.length); // no letter/case pair in two families

    const reviewedCount = LETTER_BASELINE_FAMILIES.filter(e => e.mappingConfidence === 'reviewed').length;
    expect(allKeys.length).toBe(reviewedCount);
  });

  it.each(['mixed', 'diagonal', '', null, undefined, 123])('an invalid family (%p) returns an empty array, never throws', (family) => {
    expect(getMappedLettersForFamily(family)).toEqual([]);
  });
});
