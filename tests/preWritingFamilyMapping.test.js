'use strict';

// Feature 4 Step 2 — pure mapping tests. No DB, no navigation, no
// recommendation logic. Verifies getPreWritingPrimitiveMapping() resolves
// strictly from Feature 2's reviewed baseline family (letterBaselineFamilies.js)
// plus the letter's actual motor primitive (letterMotorPrimitives.js), never
// inventing a family or guessing a primitive from a family name.

const {
  MAPPING_VERSION,
  STATUS,
  CATALOGUE_HAS_ACTIVITIES,
  PRE_WRITING_FAMILY_MAPPING,
  getPreWritingPrimitiveMapping,
  getReviewedPreWritingMappings,
  getReachablePrimitiveGroupsForFamily,
  hasPreWritingActivitiesForPrimitiveGroup,
} = require('../src/config/preWritingFamilyMapping');

const { getBaselineFamily } = require('../src/config/letterBaselineFamilies');
const { LETTER_TO_PRIMITIVE } = require('../src/config/letterMotorPrimitives');

// NOTE: letterMotorPrimitives.js's own `PRIMITIVE_GROUPS` export maps
// group-name -> array-of-letters (not group-name -> group-name string), so
// it is deliberately NOT used here to build this list — see
// preWritingFamilyMapping.js's header comment for the same caution.
const VALID_PRIMITIVE_GROUPS = ['vertical_horizontal', 'curved', 'diagonal', 'mixed'];
const VALID_FAMILIES = ['straight', 'curved', 'complex'];

// ─── Mapping Test 1/2 — valid reviewed straight letters ───────────────────

describe('Mapping Test 1/2 — valid reviewed straight letters', () => {
  it('lowercase straight letter (i) maps to vertical_horizontal, reviewed', () => {
    const result = getPreWritingPrimitiveMapping('i', 'lowercase');
    expect(result.baselineFamily).toBe('straight');
    expect(result.primitiveGroup).toBe('vertical_horizontal');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });

  it('uppercase straight letter (I) maps to vertical_horizontal, reviewed', () => {
    const result = getPreWritingPrimitiveMapping('I', 'uppercase');
    expect(result.baselineFamily).toBe('straight');
    expect(result.primitiveGroup).toBe('vertical_horizontal');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });
});

// ─── Mapping Test 3/4 — valid reviewed curved letters ──────────────────────

describe('Mapping Test 3/4 — valid reviewed curved letters', () => {
  it('lowercase curved letter (c) maps to curved, reviewed', () => {
    const result = getPreWritingPrimitiveMapping('c', 'lowercase');
    expect(result.baselineFamily).toBe('curved');
    expect(result.primitiveGroup).toBe('curved');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });

  it('uppercase curved letter (C) maps to curved, reviewed', () => {
    const result = getPreWritingPrimitiveMapping('C', 'uppercase');
    expect(result.baselineFamily).toBe('curved');
    expect(result.primitiveGroup).toBe('curved');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });
});

// ─── Mapping Test 5/6 — valid reviewed complex letters ─────────────────────
// The interesting family: reviewed complex letters resolve to THREE distinct
// primitive groups depending on the individual letter's actual primitive —
// never a single forced "complex → diagonal" translation.

describe('Mapping Test 5/6 — valid reviewed complex letters resolve per-letter, not per-family', () => {
  it('lowercase complex letter v resolves to diagonal (has activities)', () => {
    const result = getPreWritingPrimitiveMapping('v', 'lowercase');
    expect(result.baselineFamily).toBe('complex');
    expect(result.primitiveGroup).toBe('diagonal');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });

  it('uppercase complex letter V resolves to diagonal (has activities)', () => {
    const result = getPreWritingPrimitiveMapping('V', 'uppercase');
    expect(result.baselineFamily).toBe('complex');
    expect(result.primitiveGroup).toBe('diagonal');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });

  it('lowercase complex letter s resolves to curved, NOT diagonal (has activities)', () => {
    const result = getPreWritingPrimitiveMapping('s', 'lowercase');
    expect(result.baselineFamily).toBe('complex');
    expect(result.primitiveGroup).toBe('curved');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });

  it('uppercase complex letter S resolves to curved, NOT diagonal (has activities)', () => {
    const result = getPreWritingPrimitiveMapping('S', 'uppercase');
    expect(result.baselineFamily).toBe('complex');
    expect(result.primitiveGroup).toBe('curved');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(true);
  });

  it('lowercase complex letter u resolves to mixed — reviewed mapping, but NO catalogue activities exist', () => {
    const result = getPreWritingPrimitiveMapping('u', 'lowercase');
    expect(result.baselineFamily).toBe('complex');
    expect(result.primitiveGroup).toBe('mixed');
    expect(result.status).toBe(STATUS.REVIEWED); // the MAPPING itself is not uncertain
    expect(result.hasActivities).toBe(false);     // but the catalogue has nothing for it
  });

  it('uppercase complex letter U resolves to mixed — reviewed mapping, but NO catalogue activities exist', () => {
    const result = getPreWritingPrimitiveMapping('U', 'uppercase');
    expect(result.baselineFamily).toBe('complex');
    expect(result.primitiveGroup).toBe('mixed');
    expect(result.status).toBe(STATUS.REVIEWED);
    expect(result.hasActivities).toBe(false);
  });
});

// ─── Mapping Test 7 — ambiguous Feature 2 letter → not_applicable ─────────

describe('Mapping Test 7 — ambiguous Feature 2 letter never gets a primitive group', () => {
  it.each([
    ['a', 'lowercase'], ['k', 'lowercase'], ['m', 'lowercase'], ['n', 'lowercase'], ['r', 'lowercase'],
    ['A', 'uppercase'], ['K', 'uppercase'], ['M', 'uppercase'], ['R', 'uppercase'],
  ])('%s (%s) → not_applicable, baselineFamily and primitiveGroup both null', (letter, caseType) => {
    const result = getPreWritingPrimitiveMapping(letter, caseType);
    expect(result.status).toBe(STATUS.NOT_APPLICABLE);
    expect(result.baselineFamily).toBeNull();
    expect(result.primitiveGroup).toBeNull();
    expect(result.hasActivities).toBeNull();
  });
});

// ─── Mapping Test 8 — invalid letter ───────────────────────────────────────

describe('Mapping Test 8 — invalid letter → invalid_input, never throws', () => {
  it.each([['$'], ['1'], ['ab'], [''], [null], [undefined], [5], [{}]])(
    'getPreWritingPrimitiveMapping(%p, "lowercase") returns invalid_input',
    (badLetter) => {
      expect(() => getPreWritingPrimitiveMapping(badLetter, 'lowercase')).not.toThrow();
      const result = getPreWritingPrimitiveMapping(badLetter, 'lowercase');
      expect(result.status).toBe(STATUS.INVALID);
      expect(result.baselineFamily).toBeNull();
      expect(result.primitiveGroup).toBeNull();
    }
  );
});

// ─── Mapping Test 9 — invalid case type ────────────────────────────────────

describe('Mapping Test 9 — invalid case type → invalid_input, never throws', () => {
  it.each([['foo'], [''], [null], [undefined], ['Lowercase'], ['UPPERCASE']])(
    'getPreWritingPrimitiveMapping("a", %p) returns invalid_input',
    (badCaseType) => {
      expect(() => getPreWritingPrimitiveMapping('a', badCaseType)).not.toThrow();
      const result = getPreWritingPrimitiveMapping('a', badCaseType);
      expect(result.status).toBe(STATUS.INVALID);
      expect(result.primitiveGroup).toBeNull();
    }
  );

  it('a mismatched letter/caseType pairing (no Feature 2 entry) is also invalid_input, not not_applicable', () => {
    // 'a' only has a Feature 2 entry paired with 'lowercase'.
    const result = getPreWritingPrimitiveMapping('a', 'uppercase');
    expect(result.status).toBe(STATUS.INVALID);
    expect(result.reason).toBe('no_baseline_entry');
  });
});

// ─── Mapping Test 10 — no silent guessed family ────────────────────────────

describe('Mapping Test 10 — no silent guessed family', () => {
  it('every not_applicable entry has an explicit reason, never a bare null', () => {
    for (const entry of PRE_WRITING_FAMILY_MAPPING) {
      if (entry.status === STATUS.NOT_APPLICABLE) {
        expect(entry.reason).toBe('baseline_family_ambiguous');
      }
    }
  });

  it("'a' is primitive-taxonomy curved but Feature 2 ambiguous — never silently promoted to reviewed/curved", () => {
    // letterMotorPrimitives.js classifies 'a' as curved, but Feature 2 marks
    // it ambiguous (strokeTypes span full_circle + vertical_line). This
    // mapping must respect Feature 2's discipline, not the looser primitive
    // taxonomy's optimism.
    expect(LETTER_TO_PRIMITIVE['a']).toBe('curved');
    const result = getPreWritingPrimitiveMapping('a', 'lowercase');
    expect(result.status).toBe(STATUS.NOT_APPLICABLE);
    expect(result.primitiveGroup).toBeNull();
  });
});

// ─── Taxonomy Test 11 — mapping uses getBaselineFamily ─────────────────────

describe('Taxonomy Test 11 — baselineFamily always matches getBaselineFamily() directly', () => {
  it('every reviewed entry\'s baselineFamily equals getBaselineFamily(letter, caseType)', () => {
    for (const entry of getReviewedPreWritingMappings()) {
      expect(entry.baselineFamily).toBe(getBaselineFamily(entry.letter, entry.caseType));
    }
  });
});

// ─── Taxonomy Test 12 — mapping uses authoritative motor primitive ─────────

describe('Taxonomy Test 12 — primitiveGroup always matches LETTER_TO_PRIMITIVE directly', () => {
  it('every reviewed entry\'s primitiveGroup equals LETTER_TO_PRIMITIVE[letter]', () => {
    for (const entry of getReviewedPreWritingMappings()) {
      expect(entry.primitiveGroup).toBe(LETTER_TO_PRIMITIVE[entry.letter]);
    }
  });
});

// ─── Taxonomy Test 13 — curved letter maps per actual primitive, not string name ─

describe('Taxonomy Test 13 — Feature 2 "curved" is a strict subset of primitive "curved"', () => {
  it('Feature 2 reviewed curved letters (c,o,C,O) are exactly 4 — far fewer than primitive-curved letters (10)', () => {
    const reviewedCurved = getReviewedPreWritingMappings().filter(e => e.baselineFamily === 'curved');
    expect(reviewedCurved.map(e => e.letter).sort()).toEqual(['C', 'O', 'c', 'o'].sort());
  });

  it('letters that are primitive-curved but NOT Feature-2-curved (e.g. a, e, g) are never labeled curved-reviewed here', () => {
    for (const letter of ['a', 'e', 'g']) {
      expect(LETTER_TO_PRIMITIVE[letter]).toBe('curved'); // primitive taxonomy says curved
      const result = getPreWritingPrimitiveMapping(letter, 'lowercase');
      expect(result.status).not.toBe(STATUS.REVIEWED); // but Feature 2 disagrees — must not be reviewed/curved
    }
  });
});

// ─── Taxonomy Test 14 — complex family reaches more than one primitive group ─

describe('Taxonomy Test 14 — complex family is NOT forced into a single primitive group', () => {
  it('reviewed complex-family letters resolve to diagonal, curved, AND mixed', () => {
    const pools = getReachablePrimitiveGroupsForFamily('complex');
    const groups = pools.map(p => p.primitiveGroup).sort();
    expect(groups).toEqual(['curved', 'diagonal', 'mixed'].sort());
  });
});

// ─── Taxonomy Test 15 — no Feature 2 family is rewritten ───────────────────

describe('Taxonomy Test 15 — Feature 2 family data is read-only, never rewritten', () => {
  it('this module does not mutate letterBaselineFamilies exports', () => {
    // Sanity: known Feature 2 values are unchanged after this module has
    // been fully loaded and exercised above.
    expect(getBaselineFamily('l', 'lowercase')).toBe('straight');
    expect(getBaselineFamily('o', 'lowercase')).toBe('curved');
    expect(getBaselineFamily('s', 'lowercase')).toBe('complex');
    expect(getBaselineFamily('a', 'lowercase')).toBeNull();
  });
});

// ─── Taxonomy Test 16 — no motor primitive treated as baseline family ──────

describe('Taxonomy Test 16 — motor primitives are never used as baseline families', () => {
  // 'curved' is a legitimate value in BOTH vocabularies (a Feature 2 family
  // AND a motor-primitive group name), so this checks against the
  // primitive-ONLY names instead of full set difference — the real risk
  // this guards against is baselineFamily ever becoming 'vertical_horizontal',
  // 'diagonal', or 'mixed', which Feature 2 has never had as a family.
  const PRIMITIVE_ONLY_NAMES = ['vertical_horizontal', 'diagonal', 'mixed'];

  it('no entry\'s baselineFamily is ever a primitive-only-group value', () => {
    for (const entry of PRE_WRITING_FAMILY_MAPPING) {
      if (entry.baselineFamily !== null) {
        expect(PRIMITIVE_ONLY_NAMES).not.toContain(entry.baselineFamily);
        expect(VALID_FAMILIES).toContain(entry.baselineFamily);
      }
    }
  });
});

// ─── Coverage Test 17 — every reviewed entry is well-formed ────────────────

describe('Coverage Test 17 — table-driven completeness over every reviewed mapping', () => {
  it('every reviewed entry has a valid baselineFamily, a valid primitiveGroup, and an explicit status', () => {
    const reviewed = getReviewedPreWritingMappings();
    expect(reviewed.length).toBeGreaterThan(0);
    for (const entry of reviewed) {
      expect(VALID_FAMILIES).toContain(entry.baselineFamily);
      expect(VALID_PRIMITIVE_GROUPS).toContain(entry.primitiveGroup);
      expect(typeof entry.hasActivities).toBe('boolean');
      expect(entry.status).toBe(STATUS.REVIEWED);
    }
  });

  it('covers all 26 lowercase and all 26 uppercase letters exactly once (52 total)', () => {
    expect(PRE_WRITING_FAMILY_MAPPING).toHaveLength(52);
    const lowercase = PRE_WRITING_FAMILY_MAPPING.filter(e => e.caseType === 'lowercase');
    const uppercase = PRE_WRITING_FAMILY_MAPPING.filter(e => e.caseType === 'uppercase');
    expect(lowercase).toHaveLength(26);
    expect(uppercase).toHaveLength(26);
  });
});

// ─── Coverage Test 18/19 — exact reviewed-letter sets and counts ───────────

describe('Coverage Test 18/19 — exact reviewed mapping sets and counts', () => {
  it('reviewed straight letters all map to vertical_horizontal (9 letters, no exceptions)', () => {
    const straight = getReviewedPreWritingMappings().filter(e => e.baselineFamily === 'straight');
    const keys = straight.map(e => `${e.letter}|${e.caseType}`).sort();
    expect(keys).toEqual([
      'i|lowercase', 'l|lowercase', 't|lowercase',
      'E|uppercase', 'F|uppercase', 'H|uppercase', 'I|uppercase', 'L|uppercase', 'T|uppercase',
    ].sort());
    expect(straight.every(e => e.primitiveGroup === 'vertical_horizontal')).toBe(true);
    expect(straight.every(e => e.hasActivities === true)).toBe(true);
  });

  it('reviewed curved letters all map to curved (4 letters, no exceptions)', () => {
    const curved = getReviewedPreWritingMappings().filter(e => e.baselineFamily === 'curved');
    const keys = curved.map(e => `${e.letter}|${e.caseType}`).sort();
    expect(keys).toEqual(['c|lowercase', 'o|lowercase', 'C|uppercase', 'O|uppercase'].sort());
    expect(curved.every(e => e.primitiveGroup === 'curved')).toBe(true);
    expect(curved.every(e => e.hasActivities === true)).toBe(true);
  });

  it('reviewed complex letters (11 total) split diagonal(7) / curved(2) / mixed(2)', () => {
    const complex = getReviewedPreWritingMappings().filter(e => e.baselineFamily === 'complex');
    expect(complex).toHaveLength(11);

    const diagonal = complex.filter(e => e.primitiveGroup === 'diagonal').map(e => e.letter).sort();
    const curved = complex.filter(e => e.primitiveGroup === 'curved').map(e => e.letter).sort();
    const mixed = complex.filter(e => e.primitiveGroup === 'mixed').map(e => e.letter).sort();

    expect(diagonal).toEqual(['v', 'w', 'x', 'y', 'V', 'W', 'X'].sort());
    expect(curved).toEqual(['s', 'S'].sort());
    expect(mixed).toEqual(['u', 'U'].sort());

    expect(complex.filter(e => e.primitiveGroup === 'diagonal').every(e => e.hasActivities === true)).toBe(true);
    expect(complex.filter(e => e.primitiveGroup === 'curved').every(e => e.hasActivities === true)).toBe(true);
    expect(complex.filter(e => e.primitiveGroup === 'mixed').every(e => e.hasActivities === false)).toBe(true);
  });

  it('coverage counts: 24 reviewed total, 28 not_applicable, 9→vertical_horizontal, 6→curved, 7→diagonal, 2→mixed', () => {
    const reviewed = getReviewedPreWritingMappings();
    const notApplicable = PRE_WRITING_FAMILY_MAPPING.filter(e => e.status === STATUS.NOT_APPLICABLE);
    expect(reviewed).toHaveLength(24);
    expect(notApplicable).toHaveLength(28);
    expect(reviewed.length + notApplicable.length).toBe(52);

    const byGroup = {};
    for (const entry of reviewed) {
      byGroup[entry.primitiveGroup] = (byGroup[entry.primitiveGroup] ?? 0) + 1;
    }
    expect(byGroup).toEqual({
      vertical_horizontal: 9,
      curved: 6,
      diagonal: 7,
      mixed: 2,
    });
  });

  it('getReachablePrimitiveGroupsForFamily reports the exact same breakdown per family', () => {
    expect(getReachablePrimitiveGroupsForFamily('straight')).toEqual([
      { primitiveGroup: 'vertical_horizontal', hasActivities: true, letterCount: 9 },
    ]);
    expect(getReachablePrimitiveGroupsForFamily('curved')).toEqual([
      { primitiveGroup: 'curved', hasActivities: true, letterCount: 4 },
    ]);
    const complexPools = getReachablePrimitiveGroupsForFamily('complex');
    expect(complexPools).toEqual(
      expect.arrayContaining([
        { primitiveGroup: 'diagonal', hasActivities: true, letterCount: 7 },
        { primitiveGroup: 'curved', hasActivities: true, letterCount: 2 },
        { primitiveGroup: 'mixed', hasActivities: false, letterCount: 2 },
      ])
    );
    expect(complexPools).toHaveLength(3);
  });

  it('an unknown family returns an empty pool list, never throws', () => {
    expect(getReachablePrimitiveGroupsForFamily('diagonal')).toEqual([]);
    expect(getReachablePrimitiveGroupsForFamily(null)).toEqual([]);
  });
});

// ─── Catalogue availability helper ──────────────────────────────────────────

describe('hasPreWritingActivitiesForPrimitiveGroup()', () => {
  it('matches CATALOGUE_HAS_ACTIVITIES for all four groups', () => {
    expect(hasPreWritingActivitiesForPrimitiveGroup('vertical_horizontal')).toBe(true);
    expect(hasPreWritingActivitiesForPrimitiveGroup('curved')).toBe(true);
    expect(hasPreWritingActivitiesForPrimitiveGroup('diagonal')).toBe(true);
    expect(hasPreWritingActivitiesForPrimitiveGroup('mixed')).toBe(false);
  });

  it('an unknown group returns false, never throws', () => {
    expect(hasPreWritingActivitiesForPrimitiveGroup('nonexistent')).toBe(false);
    expect(hasPreWritingActivitiesForPrimitiveGroup(undefined)).toBe(false);
  });

  it('CATALOGUE_HAS_ACTIVITIES has no stale/extra keys beyond the four real primitive groups', () => {
    expect(Object.keys(CATALOGUE_HAS_ACTIVITIES).sort()).toEqual(VALID_PRIMITIVE_GROUPS.sort());
  });
});

// ─── Mapping Test — version ─────────────────────────────────────────────────

describe('Mapping version', () => {
  it('MAPPING_VERSION is exactly pre-writing-family-mapping-v1', () => {
    expect(MAPPING_VERSION).toBe('pre-writing-family-mapping-v1');
  });
});

// ─── Frontend/backend primitive parity (golden fixture) ────────────────────
//
// auriva-frontend and auriva-backend are independent git repositories, so
// this cannot be a live cross-package import — the same documented
// limitation as tests/letterSupportLevelsParity.test.js for Feature 3's
// support-level vocabulary. FRONTEND_LETTER_PRIMITIVE_MAP below is a
// manually-synced golden copy of
// auriva-frontend/src/constants/preWritingActivities.js's
// LETTER_PRIMITIVE_MAP, as re-verified by direct inspection during Feature 4
// Step 2. Whenever that frontend map changes, this golden copy — and
// letterMotorPrimitives.js on the backend, which it already mirrors — must
// be updated together. This test is the tripwire that catches a forgotten
// update; it is not a fully automatic cross-repo guarantee.

const FRONTEND_LETTER_PRIMITIVE_MAP = {
  a: 'curved', b: 'mixed', c: 'curved', d: 'mixed', e: 'curved', f: 'vertical_horizontal',
  g: 'curved', h: 'mixed', i: 'vertical_horizontal', j: 'mixed', k: 'diagonal', l: 'vertical_horizontal',
  m: 'mixed', n: 'mixed', o: 'curved', p: 'mixed', q: 'mixed', r: 'mixed', s: 'curved',
  t: 'vertical_horizontal', u: 'mixed', v: 'diagonal', w: 'diagonal', x: 'diagonal', y: 'diagonal', z: 'diagonal',
  A: 'diagonal', B: 'mixed', C: 'curved', D: 'mixed', E: 'vertical_horizontal', F: 'vertical_horizontal',
  G: 'curved', H: 'vertical_horizontal', I: 'vertical_horizontal', J: 'mixed', K: 'diagonal', L: 'vertical_horizontal',
  M: 'mixed', N: 'mixed', O: 'curved', P: 'mixed', Q: 'mixed', R: 'mixed', S: 'curved',
  T: 'vertical_horizontal', U: 'mixed', V: 'diagonal', W: 'diagonal', X: 'diagonal', Y: 'diagonal', Z: 'diagonal',
};

describe('Parity Test 20 — backend LETTER_TO_PRIMITIVE matches frontend LETTER_PRIMITIVE_MAP (golden fixture)', () => {
  it('every one of the 52 taught letters resolves identically on both sides', () => {
    for (const letter of Object.keys(FRONTEND_LETTER_PRIMITIVE_MAP)) {
      expect(LETTER_TO_PRIMITIVE[letter]).toBe(FRONTEND_LETTER_PRIMITIVE_MAP[letter]);
    }
  });

  it('this mapping layer\'s resolved primitiveGroup (for reviewed letters) also matches the frontend golden copy', () => {
    for (const entry of getReviewedPreWritingMappings()) {
      expect(entry.primitiveGroup).toBe(FRONTEND_LETTER_PRIMITIVE_MAP[entry.letter]);
    }
  });
});
