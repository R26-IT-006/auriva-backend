'use strict';

/**
 * preWritingFamilyMapping.js
 *
 * Feature 4 Step 2: the authoritative, read-only mapping layer that answers,
 * for a specific (letter, caseType):
 *
 *   Given Feature 2's reviewed baseline family for this letter, which
 *   pre-writing primitive group — if any — is safe to use as the source of
 *   Feature 4 warm-up activities?
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * Feature 4 Step 1's audit proved two things that make a naive family-name
 * translation (straight→vertical_horizontal, curved→curved, complex→
 * diagonal) unsafe:
 *
 *   1. Feature 2's REVIEWED "curved" letter set (config/letterBaselineFamilies.js
 *      — only c/o/C/O) is NOT the same letter set as this file's "curved"
 *      motor-primitive group (config/letterMotorPrimitives.js — a/c/e/g/o/s/
 *      C/G/O/S). Same word, different membership.
 *   2. Feature 2's "complex" family does not map to one primitive group at
 *      all — its reviewed letters actually land in THREE different
 *      primitive groups (diagonal, curved, and mixed — see the coverage
 *      report in tests/preWritingFamilyMapping.test.js and Feature 4 Step 2's
 *      audit report for the full per-letter breakdown).
 *
 * This file therefore never guesses a primitive group from a family name.
 * It always resolves per LETTER, per CASE TYPE, using the two existing
 * authoritative sources directly:
 *
 *   - config/letterBaselineFamilies.js  → getLetterBaselineMapping()
 *     (Feature 2's own reviewed/ambiguous discipline — the ONLY source of
 *     baselineFamily; never re-derived or second-guessed here)
 *   - config/letterMotorPrimitives.js   → LETTER_TO_PRIMITIVE
 *     (the same primitive grouping already used by the Teacher Report's
 *     "Motor Pattern Progress" section AND by the frontend's
 *     preWritingActivities.js LETTER_PRIMITIVE_MAP — confirmed letter-for-
 *     letter identical to that frontend map; see
 *     tests/preWritingFamilyMapping.test.js's parity section)
 *
 * ── Trigger family vs. activity group — kept distinct on purpose ──────────
 * A recommendation may legitimately say "the DIFFICULTY signal is the
 * complex family, but the ACTIVITY offered is from the curved primitive
 * pool" (e.g. letter 's'). `baselineFamily` (the trigger) and
 * `primitiveGroup` (the activity pool) are never renamed into each other or
 * collapsed into a single field — a future recommendation service must
 * report both.
 *
 * ── What this file does NOT do ───────────────────────────────────────────
 * - It does not invent a baseline family from the motor-primitive taxonomy.
 *   If Feature 2 has no reviewed family for a letter (`baselineFamily ===
 *   null`, i.e. `mappingConfidence: 'ambiguous'`), this file returns
 *   `status: 'not_applicable'` — never a guessed family.
 * - It does not decide WHEN a warm-up should be recommended, WHICH specific
 *   activity to show, or track completion/session state. Pure mapping only.
 * - It does not change PRE_WRITING_ACTIVITIES, ShapeFeature, or any
 *   navigation/trigger code. Read-only against the two source configs.
 */

const { getLetterBaselineMapping } = require('./letterBaselineFamilies');
const { LETTER_TO_PRIMITIVE } = require('./letterMotorPrimitives');

const MAPPING_VERSION = 'pre-writing-family-mapping-v1';

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

// NOTE: letterMotorPrimitives.js also exports a `PRIMITIVE_GROUPS` constant,
// but it maps group-name -> array-of-letters (e.g. PRIMITIVE_GROUPS.curved
// === ['a','c','e',...]), NOT group-name -> group-name string the way
// auriva-frontend's constants/preWritingActivities.js's own (differently
// shaped) `PRIMITIVE_GROUPS` does. To avoid re-creating that exact
// same-name/different-shape confusion here, this file defines its own
// explicit string constants below instead of importing either one.
const PRIMITIVE_GROUP_NAMES = {
  VERTICAL_HORIZONTAL: 'vertical_horizontal',
  CURVED: 'curved',
  DIAGONAL: 'diagonal',
  MIXED: 'mixed',
};

// ─── Catalogue availability ─────────────────────────────────────────────────
// Whether auriva-frontend's constants/preWritingActivities.js currently has
// ANY activities in a given primitive group. This is deliberately a static,
// documented, manually-synced constant, not a live cross-repo import —
// auriva-frontend and auriva-backend are independent git repositories (see
// tests/letterSupportLevelsParity.test.js for the same documented pattern
// used for Feature 3's support-level vocabulary). As of Feature 4 Step 1's
// audit: vertical_horizontal=6, curved=6, diagonal=6, mixed=0 activities.
// Whenever preWritingActivities.js's GROUP_ACTIVITY_COUNT changes, this
// constant must be updated in the same change — the parity test in
// tests/preWritingFamilyMapping.test.js is the tripwire that catches drift.
const CATALOGUE_HAS_ACTIVITIES = {
  [PRIMITIVE_GROUP_NAMES.VERTICAL_HORIZONTAL]: true,
  [PRIMITIVE_GROUP_NAMES.CURVED]: true,
  [PRIMITIVE_GROUP_NAMES.DIAGONAL]: true,
  [PRIMITIVE_GROUP_NAMES.MIXED]: false,
};

const STATUS = {
  REVIEWED: 'reviewed',
  NOT_APPLICABLE: 'not_applicable',
  INVALID: 'invalid_input',
};

/**
 * Resolves the pre-writing primitive group for a single (letter, caseType),
 * strictly from Feature 2's reviewed baseline family plus the letter's
 * actual motor primitive. Never throws.
 *
 * @param {string} letter
 * @param {string} caseType — 'lowercase' | 'uppercase'
 * @returns {{
 *   letter: string,
 *   caseType: string,
 *   baselineFamily: 'straight'|'curved'|'complex'|null,
 *   primitiveGroup: 'vertical_horizontal'|'curved'|'diagonal'|'mixed'|null,
 *   hasActivities: boolean|null,
 *   status: 'reviewed'|'not_applicable'|'invalid_input',
 *   reason: string,
 * }}
 */
function getPreWritingPrimitiveMapping(letter, caseType) {
  if (typeof letter !== 'string' || letter.length !== 1 || !/^[A-Za-z]$/.test(letter)) {
    return {
      letter, caseType, baselineFamily: null, primitiveGroup: null, hasActivities: null,
      status: STATUS.INVALID, reason: 'invalid_letter',
    };
  }
  if (!VALID_CASE_TYPES.includes(caseType)) {
    return {
      letter, caseType, baselineFamily: null, primitiveGroup: null, hasActivities: null,
      status: STATUS.INVALID, reason: 'invalid_case_type',
    };
  }

  // Feature 2 is the SOLE source of baselineFamily. This file never derives
  // a family from letterMotorPrimitives.js or any other taxonomy.
  const baselineEntry = getLetterBaselineMapping(letter, caseType);

  if (!baselineEntry) {
    // No Feature 2 entry exists at all for this exact (letter, caseType)
    // pair (e.g. a mismatched case pairing like 'a'+'uppercase').
    return {
      letter, caseType, baselineFamily: null, primitiveGroup: null, hasActivities: null,
      status: STATUS.INVALID, reason: 'no_baseline_entry',
    };
  }

  if (baselineEntry.baselineFamily === null) {
    // Feature 2 itself marks this letter 'ambiguous' — Feature 4 must not
    // apply here. Do not invent a family from the motor primitive.
    return {
      letter, caseType, baselineFamily: null, primitiveGroup: null, hasActivities: null,
      status: STATUS.NOT_APPLICABLE, reason: 'baseline_family_ambiguous',
    };
  }

  const baselineFamily = baselineEntry.baselineFamily;
  const primitiveGroup = LETTER_TO_PRIMITIVE[letter] ?? PRIMITIVE_GROUP_NAMES.MIXED;
  const hasActivities = CATALOGUE_HAS_ACTIVITIES[primitiveGroup] ?? false;

  return {
    letter,
    caseType,
    baselineFamily,
    primitiveGroup,
    hasActivities,
    status: STATUS.REVIEWED,
    reason: `${baselineFamily}_family_${primitiveGroup}_primitive`,
  };
}

// ─── Full coverage table (computed once, at module load) ──────────────────
// Built by iterating every taught letter form through
// getPreWritingPrimitiveMapping() — never hand-typed — so it can never drift
// from the two authoritative source files it reads.

const ALL_LOWERCASE = 'abcdefghijklmnopqrstuvwxyz'.split('');
const ALL_UPPERCASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

const PRE_WRITING_FAMILY_MAPPING = [
  ...ALL_LOWERCASE.map(letter => getPreWritingPrimitiveMapping(letter, 'lowercase')),
  ...ALL_UPPERCASE.map(letter => getPreWritingPrimitiveMapping(letter, 'uppercase')),
];

/**
 * @returns {object[]} only the entries where status === 'reviewed' — i.e.
 *   letters Feature 4 could safely act on today.
 */
function getReviewedPreWritingMappings() {
  return PRE_WRITING_FAMILY_MAPPING.filter(entry => entry.status === STATUS.REVIEWED);
}

/**
 * Reports which primitive groups a given Feature 2 family's reviewed
 * letters actually resolve to, and whether each group has any catalogue
 * activities. Read-only reporting helper — does not select an activity or
 * decide anything. Useful for "which pools are reachable from family X".
 *
 * @param {'straight'|'curved'|'complex'} family
 * @returns {{primitiveGroup: string, hasActivities: boolean, letterCount: number}[]}
 */
function getReachablePrimitiveGroupsForFamily(family) {
  const pools = new Map();
  for (const entry of getReviewedPreWritingMappings()) {
    if (entry.baselineFamily !== family) continue;
    if (!pools.has(entry.primitiveGroup)) {
      pools.set(entry.primitiveGroup, {
        primitiveGroup: entry.primitiveGroup,
        hasActivities: entry.hasActivities,
        letterCount: 0,
      });
    }
    pools.get(entry.primitiveGroup).letterCount += 1;
  }
  return Array.from(pools.values()).sort((a, b) => b.letterCount - a.letterCount);
}

/**
 * @param {string} primitiveGroup
 * @returns {boolean} true only if the pre-writing catalogue currently has
 *   at least one activity for this primitive group (per
 *   CATALOGUE_HAS_ACTIVITIES above). Unknown groups return false, never throw.
 */
function hasPreWritingActivitiesForPrimitiveGroup(primitiveGroup) {
  return CATALOGUE_HAS_ACTIVITIES[primitiveGroup] ?? false;
}

module.exports = {
  MAPPING_VERSION,
  STATUS,
  CATALOGUE_HAS_ACTIVITIES,
  PRE_WRITING_FAMILY_MAPPING,
  getPreWritingPrimitiveMapping,
  getReviewedPreWritingMappings,
  getReachablePrimitiveGroupsForFamily,
  hasPreWritingActivitiesForPrimitiveGroup,
};
