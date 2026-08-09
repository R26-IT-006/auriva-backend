'use strict';

/**
 * letterBaselineFamilies.js
 *
 * Feature 2 Step 1: the authoritative, explicit, versioned mapping from each
 * taught letter (lowercase and uppercase independently) to one of the three
 * IMMUTABLE Feature 1 baseline families: straight | curved | complex.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * The project already has three taxonomies that must NOT be merged:
 *   1. Feature 1 baseline families   — straight | curved | complex
 *      (derived from the 6-shape assessment: straight = avg(horizontal_line,
 *      vertical_line); curved = avg(full_circle, half_circle); complex =
 *      avg(zigzag, curve_wave) — see frontend/src/utils/adaptiveSequencing.js)
 *   2. Frontend teaching taxonomy    — straight | curved | mixed
 *      (frontend/src/constants/letterCategories.js — used for adaptive
 *      sequencing, NOT motor-family precision; a "mixed" bucket sweeps every
 *      multi-primitive letter together without distinguishing which
 *      primitives it mixes)
 *   3. Backend primitive taxonomy    — vertical_horizontal | curved |
 *      diagonal | mixed (config/letterMotorPrimitives.js — used only for the
 *      Teacher Report's "Motor Pattern Progress" rollup)
 * None of the three are reused directly here. This file derives its mapping
 * from first principles: each letter's `strokeTypes` array, as already
 * defined in letterCategories.js, using the SAME six shape IDs the baseline
 * assessment itself scores. That is the most direct, code-verifiable link
 * available between "how this letter is drawn" and "which baseline family
 * that drawing exercises":
 *
 *   horizontal_line, vertical_line  → straight
 *   full_circle,      half_circle    → curved
 *   zigzag,            curve_wave     → complex
 *
 * A letter maps CLEANLY (mappingConfidence: 'reviewed') only when every one
 * of its strokeTypes belongs to the SAME family. The instant a letter's
 * strokeTypes span more than one family, it is marked
 * mappingConfidence: 'ambiguous', baselineFamily: null — deliberately, per
 * the Feature 2 audit's explicit instruction not to silently force
 * multi-primitive letters into one bucket via undocumented "dominant
 * stroke" guesswork. Applying this rule strictly (not just to the obvious
 * cases like A/K/M/N/R) turns out to affect the MAJORITY of letters: 15/26
 * lowercase and 13/26 uppercase are ambiguous under this rule — see the
 * Feature 2 audit for the full accounting.
 *
 * Two notable consequences of deriving strictly from strokeTypes rather
 * than reusing the frontend's teaching labels:
 *   - 'u'/'U' and 's'/'S' are taught as "curved" in letterCategories.js
 *     (for pedagogical simplicity — they visually resemble curves), but
 *     their actual guide shape is curve_wave, a COMPLEX-family baseline
 *     shape. They map to 'complex' here, not 'curved'. This is intentional,
 *     not an error — flagged explicitly in each entry's rationale.
 *   - Case sensitivity is real: lowercase 'y' (strokeTypes: zigzag,
 *     curve_wave — both complex) maps cleanly to 'complex', while uppercase
 *     'Y' (strokeTypes: zigzag, vertical_line — complex + straight) is
 *     ambiguous. The two forms of the same letter identity are NOT assumed
 *     equivalent anywhere in this file.
 *
 * This file does not derive anything dynamically from letterCategories.js
 * or letterMotorPrimitives.js at runtime — it is a static, explicit,
 * reviewable artifact by design, so a future correction is a deliberate,
 * visible diff to this file, not a side effect of some other taxonomy
 * changing shape.
 *
 * Feature 2 has exactly three baseline families. 'mixed' is deliberately
 * never used as a value here — see the two existing taxonomies above for
 * where that word already means something else.
 */

const MAPPING_VERSION = 'letter-baseline-family-v1';

const VALID_FAMILIES   = ['straight', 'curved', 'complex'];
const VALID_CASE_TYPES = ['lowercase', 'uppercase'];

// ─── The mapping itself ─────────────────────────────────────────────────────
// One entry per taught letter form. Ordered lowercase a-z, then uppercase A-Z.

const LETTER_BASELINE_FAMILIES = [
  // ── lowercase ──────────────────────────────────────────────────────────
  { letter: 'a', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [full_circle, vertical_line] span curved and straight — no single family without review." },
  { letter: 'b', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, half_circle] span straight and curved — no single family without review." },
  { letter: 'c', caseType: 'lowercase', baselineFamily: 'curved', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [half_circle] — single curved-family shape." },
  { letter: 'd', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [full_circle, vertical_line] span curved and straight — no single family without review." },
  { letter: 'e', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [half_circle, horizontal_line] span curved and straight — no single family without review." },
  { letter: 'f', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [curve_wave, horizontal_line] span complex and straight — no single family without review." },
  { letter: 'g', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [full_circle, vertical_line] span curved and straight — no single family without review." },
  { letter: 'h', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, curve_wave] span straight and complex — no single family without review." },
  { letter: 'i', caseType: 'lowercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line] — single straight-family shape." },
  { letter: 'j', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, curve_wave] span straight and complex — no single family without review." },
  { letter: 'k', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, zigzag] span straight and complex — no single family without review." },
  { letter: 'l', caseType: 'lowercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line] — single straight-family shape." },
  { letter: 'm', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, curve_wave, curve_wave] span straight and complex — no single family without review." },
  { letter: 'n', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, curve_wave] span straight and complex — no single family without review." },
  { letter: 'o', caseType: 'lowercase', baselineFamily: 'curved', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [full_circle] — single curved-family shape." },
  { letter: 'p', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, half_circle] span straight and curved — no single family without review." },
  { letter: 'q', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [full_circle, vertical_line] span curved and straight — no single family without review." },
  { letter: 'r', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, half_circle] span straight and curved — no single family without review." },
  { letter: 's', caseType: 'lowercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [curve_wave] — single complex-family shape. Note: letterCategories.js teaches 's' under the 'curved' category for pedagogical simplicity, but curve_wave is a complex-family baseline shape, not full_circle/half_circle — deliberately mapped to 'complex' here, not 'curved'." },
  { letter: 't', caseType: 'lowercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line, horizontal_line] — both straight-family shapes." },
  { letter: 'u', caseType: 'lowercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [curve_wave] — single complex-family shape. Note: letterCategories.js teaches 'u' under the 'curved' category for pedagogical simplicity, but curve_wave is a complex-family baseline shape — deliberately mapped to 'complex' here, not 'curved'." },
  { letter: 'v', caseType: 'lowercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [zigzag] — single complex-family shape." },
  { letter: 'w', caseType: 'lowercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [zigzag, zigzag] — both complex-family shapes." },
  { letter: 'x', caseType: 'lowercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [zigzag, zigzag] — both complex-family shapes." },
  { letter: 'y', caseType: 'lowercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [zigzag, curve_wave] — both complex-family shapes. Contrast with uppercase 'Y' (see below), whose strokeTypes are NOT the same set — case independence matters here." },
  { letter: 'z', caseType: 'lowercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [horizontal_line, zigzag, horizontal_line] span straight and complex — no single family without review." },

  // ── uppercase ──────────────────────────────────────────────────────────
  { letter: 'A', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [zigzag, horizontal_line] span complex and straight — no single family without review." },
  { letter: 'B', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, half_circle, half_circle] span straight and curved — no single family without review." },
  { letter: 'C', caseType: 'uppercase', baselineFamily: 'curved', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [half_circle] — single curved-family shape." },
  { letter: 'D', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, half_circle] span straight and curved — no single family without review." },
  { letter: 'E', caseType: 'uppercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line, horizontal_line, horizontal_line] — all straight-family shapes." },
  { letter: 'F', caseType: 'uppercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line, horizontal_line] — both straight-family shapes." },
  { letter: 'G', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [half_circle, horizontal_line] span curved and straight — no single family without review." },
  { letter: 'H', caseType: 'uppercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line, vertical_line, horizontal_line] — all straight-family shapes." },
  { letter: 'I', caseType: 'uppercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line] — single straight-family shape." },
  { letter: 'J', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, curve_wave] span straight and complex — no single family without review." },
  { letter: 'K', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, zigzag] span straight and complex — no single family without review." },
  { letter: 'L', caseType: 'uppercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line, horizontal_line] — both straight-family shapes." },
  { letter: 'M', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, zigzag, vertical_line] span straight and complex — no single family without review." },
  { letter: 'N', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, zigzag, vertical_line] span straight and complex — no single family without review." },
  { letter: 'O', caseType: 'uppercase', baselineFamily: 'curved', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [full_circle] — single curved-family shape." },
  { letter: 'P', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, half_circle] span straight and curved — no single family without review." },
  { letter: 'Q', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [full_circle, zigzag] span curved and complex — no single family without review." },
  { letter: 'R', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [vertical_line, half_circle, zigzag] span all three families (straight, curved, complex) — no single family without review." },
  { letter: 'S', caseType: 'uppercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [curve_wave] — single complex-family shape. Note: letterCategories.js teaches 'S' under the 'curved' category for pedagogical simplicity, but curve_wave is a complex-family baseline shape — deliberately mapped to 'complex' here, not 'curved'." },
  { letter: 'T', caseType: 'uppercase', baselineFamily: 'straight', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [vertical_line, horizontal_line] — both straight-family shapes." },
  { letter: 'U', caseType: 'uppercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [curve_wave] — single complex-family shape. Note: letterCategories.js teaches 'U' under the 'curved' category for pedagogical simplicity, but curve_wave is a complex-family baseline shape — deliberately mapped to 'complex' here, not 'curved'." },
  { letter: 'V', caseType: 'uppercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [zigzag] — single complex-family shape." },
  { letter: 'W', caseType: 'uppercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [zigzag, zigzag] — both complex-family shapes." },
  { letter: 'X', caseType: 'uppercase', baselineFamily: 'complex', mappingConfidence: 'reviewed',
    rationale: "strokeTypes [zigzag, zigzag] — both complex-family shapes." },
  { letter: 'Y', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [zigzag, vertical_line] span complex and straight — no single family without review. Contrast with lowercase 'y' (see above), which IS clean — case independence matters here." },
  { letter: 'Z', caseType: 'uppercase', baselineFamily: null, mappingConfidence: 'ambiguous',
    rationale: "strokeTypes [horizontal_line, zigzag, horizontal_line] span straight and complex — no single family without review." },
];

// ─── Lookup index (built once, at module load) ─────────────────────────────

function lookupKey(letter, caseType) {
  return `${letter}|${caseType}`;
}

const MAPPING_BY_KEY = new Map(
  LETTER_BASELINE_FAMILIES.map(entry => [lookupKey(entry.letter, entry.caseType), entry])
);

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns the full mapping entry for a letter form, or null if this exact
 * (letter, caseType) combination has no entry at all — e.g. a non-letter
 * character, or a case/letter pairing that doesn't exist (this file never
 * coerces 'a'+'uppercase' into the 'A' entry — letter and caseType must
 * match a real, explicitly-authored row).
 *
 * @param {string} letter    — single character, e.g. 'a' or 'A'
 * @param {string} caseType  — 'lowercase' | 'uppercase'
 * @returns {{letter, caseType, baselineFamily, mappingConfidence, rationale}|null}
 */
function getLetterBaselineMapping(letter, caseType) {
  if (typeof letter !== 'string' || letter.length !== 1) return null;
  if (!VALID_CASE_TYPES.includes(caseType)) return null;
  return MAPPING_BY_KEY.get(lookupKey(letter, caseType)) ?? null;
}

/**
 * @param {string} letter
 * @param {string} caseType
 * @returns {'straight'|'curved'|'complex'|null} null for both "not mapped
 *   at all" and "mapped but ambiguous" — callers that need to distinguish
 *   the two should use getLetterBaselineMapping() directly.
 */
function getBaselineFamily(letter, caseType) {
  return getLetterBaselineMapping(letter, caseType)?.baselineFamily ?? null;
}

/**
 * @param {string} letter
 * @param {string} caseType
 * @returns {boolean} true only when a mapping entry exists AND it resolves
 *   to a real (non-null) baseline family.
 */
function isBaselineFamilyMapped(letter, caseType) {
  return getBaselineFamily(letter, caseType) !== null;
}

/**
 * Feature 2 Step 4: the reviewed (non-ambiguous) letter forms mapped to a
 * given baseline family, as {letter, caseType} pairs — both cases included
 * where each maps cleanly (a letter's lowercase and uppercase forms are not
 * assumed to share a family; see 'y' vs 'Y' above). Added specifically so
 * the recent-family-performance query in dynamicThresholdService.js does
 * not hardcode its own second copy of "which letters belong to which
 * family" — this file remains the single, authoritative source for that.
 *
 * @param {string} family — 'straight'|'curved'|'complex'
 * @returns {{letter: string, caseType: string}[]} empty array for an
 *   invalid/unknown family — never throws.
 */
function getMappedLettersForFamily(family) {
  if (!VALID_FAMILIES.includes(family)) return [];
  return LETTER_BASELINE_FAMILIES
    .filter(entry => entry.baselineFamily === family)
    .map(entry => ({ letter: entry.letter, caseType: entry.caseType }));
}

// ─── Validation (exported for tests — see tests/letterBaselineFamilies.test.js) ─
//
// Not run automatically at module load / production startup, matching this
// project's existing convention (letterMotorPrimitives.js and
// letterCategories.js likewise perform no self-validation at import time) —
// malformed mapping data must be caught by tests, not by risking a
// production boot-time crash.

function validateLetterBaselineFamilies() {
  const errors = [];
  const seenKeys = new Set();

  if (typeof MAPPING_VERSION !== 'string' || MAPPING_VERSION.length === 0) {
    errors.push('MAPPING_VERSION is missing or empty');
  }

  for (const entry of LETTER_BASELINE_FAMILIES) {
    const key = lookupKey(entry.letter, entry.caseType);

    if (seenKeys.has(key)) errors.push(`Duplicate mapping for ${key}`);
    seenKeys.add(key);

    if (typeof entry.letter !== 'string' || !/^[A-Za-z]$/.test(entry.letter)) {
      errors.push(`Invalid letter value: ${JSON.stringify(entry.letter)}`);
    }
    if (!VALID_CASE_TYPES.includes(entry.caseType)) {
      errors.push(`Invalid caseType for ${key}: ${JSON.stringify(entry.caseType)}`);
    }
    if (entry.caseType === 'lowercase' && entry.letter !== entry.letter.toLowerCase()) {
      errors.push(`${key}: caseType is 'lowercase' but letter is not lowercase`);
    }
    if (entry.caseType === 'uppercase' && entry.letter !== entry.letter.toUpperCase()) {
      errors.push(`${key}: caseType is 'uppercase' but letter is not uppercase`);
    }
    if (entry.baselineFamily !== null && !VALID_FAMILIES.includes(entry.baselineFamily)) {
      errors.push(`${key}: invalid baselineFamily ${JSON.stringify(entry.baselineFamily)}`);
    }
    if (entry.baselineFamily === null && entry.mappingConfidence !== 'ambiguous') {
      errors.push(`${key}: baselineFamily is null but mappingConfidence is not 'ambiguous'`);
    }
    if (entry.baselineFamily !== null && entry.mappingConfidence === 'ambiguous') {
      errors.push(`${key}: baselineFamily is set but mappingConfidence is 'ambiguous'`);
    }
    if (!['reviewed', 'ambiguous'].includes(entry.mappingConfidence)) {
      errors.push(`${key}: invalid mappingConfidence ${JSON.stringify(entry.mappingConfidence)}`);
    }
    if (typeof entry.rationale !== 'string' || entry.rationale.length === 0) {
      errors.push(`${key}: missing rationale`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = {
  MAPPING_VERSION,
  LETTER_BASELINE_FAMILIES,
  getLetterBaselineMapping,
  getBaselineFamily,
  isBaselineFamilyMapped,
  getMappedLettersForFamily,
  validateLetterBaselineFamilies,
};
