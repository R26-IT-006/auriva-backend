'use strict';

/**
 * worksheetRecommendationPolicy.js
 *
 * Feature 8 Step 2 — Worksheet Recommendation Vocabulary + Family-to-Content
 * Mapping Policy.
 *
 * PURE POLICY/CONFIGURATION + PURE HELPERS ONLY. No DB reads, no network
 * calls, no import of `persistentDifficultyService.js` (that composition
 * happens in Step 3) — this file exists so the vocabulary and family→content
 * mapping a future Step 3 recommendation service will need are defined,
 * named, and testable BEFORE that service is built, the same discipline
 * every prior feature's own Step 2 already established (Feature 4's
 * preWritingFamilyMapping.js, Feature 5's repetitionPolicy.js, Feature 6's
 * demoSpeedPolicy.js, Feature 7's persistentDifficultyPolicy.js).
 *
 * ── Feature 7 remains the sole source of truth (Step 1 audit §29/§34) ────
 * Every function here is a pure mapping FROM a Feature 7 `persistent`
 * stream's own fields (`family`, `caseType`, `affectedLetters`,
 * `earlierWindow`, `recentWindow`) — nothing here recomputes persistence,
 * queries `LetterAttempt`, or calls Feature 2/3/4/5/6. A future Step 3
 * service is expected to call `evaluatePersistentDifficulty()`, filter for
 * `status === 'persistent'` streams, and pass each stream's own fields
 * into `buildWorksheetRecommendation()` below — this file never does that
 * composition itself.
 *
 * ── Family taxonomy discipline (Step 1 audit §12/§17/§20/§22) ────────────
 * Keys here are EXACTLY Feature 7's own three baseline families
 * (`straight`/`curved`/`complex`) — never `letterMotorPrimitives.js`'s
 * `vertical_horizontal`/`diagonal`/`mixed` taxonomy, never
 * `difficultyRules.js`'s `WEAK_CURVE_CONTROL`/`WEAK_STRAIGHT_LINE`/
 * `ZIGZAG_INSTABILITY` category names, and never a fourth invented
 * taxonomy. This codebase already has three other letter/movement
 * taxonomies (Feature 1/2/7's own, the frontend teaching taxonomy, the
 * backend motor-primitive taxonomy) plus `difficultyRules.js`'s own
 * implicit categories — Feature 8 adds none of its own.
 *
 * `suggestedActivities` content below is seeded from `difficultyRules.js`'s
 * existing exercise wording (`WEAK_STRAIGHT_LINE`/`WEAK_CURVE_CONTROL`/
 * `ZIGZAG_INSTABILITY`'s own `exercises[].text` values, inspected verbatim
 * during Step 1) — reworded only where the original hardcoded specific
 * letters (e.g. "Letters V, W, M, N, Z practice") into a generic,
 * live-letter-agnostic form ("Guided tracing of focus letters"), since
 * `difficultyRules.js`'s own `letterFocus` arrays are NOT Feature 7's
 * `affectedLetters` and must never be copied in (Step 1 audit §20, Step 2
 * spec §9/§10/§11/§15). This file never imports `difficultyRules.js` — the
 * content was reviewed and adapted by hand, not reused programmatically,
 * since that module's selection logic (condition/threshold-based, driving
 * the separate initial-assessment "Motor Difficulty Analysis" card) must
 * stay fully independent of Feature 8's own family-keyed lookup.
 *
 * ── Research framing ──────────────────────────────────────────────────────
 * A worksheet recommendation means: "a teacher-facing educational
 * handwriting practice suggestion, based on an already-established Feature
 * 7 persistent stream." Never a therapy plan, clinical intervention,
 * diagnosis, or motor-impairment treatment.
 */

// ─── Recommendation type vocabulary ─────────────────────────────────────────
// Exactly one MVP value — Feature 7 currently supports no evidence that
// could distinguish a "foundation"/"guided"/"independent"/"advanced"
// progression stage (Step 1 audit §23), so none is invented here.

const WORKSHEET_RECOMMENDATION_TYPES = Object.freeze({
  MOTOR_FAMILY_PRACTICE: 'motor_family_practice',
});

// ─── Family taxonomy (Feature 7's own three values, reused verbatim) ──────

const VALID_FAMILIES = Object.freeze(['straight', 'curved', 'complex']);

function isValidFamily(value) {
  return typeof value === 'string' && VALID_FAMILIES.includes(value);
}

// ─── Family → static content mapping ───────────────────────────────────────
//
// Deliberately parallel structure across all three families (Step 2 spec
// §25 — no family significantly more elaborate than another without
// evidence): one pattern-level activity, one refinement activity, one
// combined/generic-pattern activity, then the same two live-letter-agnostic
// closing activities every family shares ("guided tracing" then
// "independent writing" of whatever letters Feature 7 actually flagged —
// never a hardcoded letter, per Step 2 spec §15/§23).
//
// Titles use the exact teacher-friendly vocabulary Step 2 spec §16
// specifies — never "deficit"/"problem"/"severe" framing.

const WORKSHEET_RECOMMENDATION_POLICY = Object.freeze({
  straight: Object.freeze({
    title: 'Straight Movement Practice',
    suggestedActivities: Object.freeze([
      'Vertical line tracing',
      'Horizontal line tracing',
      'Straight-stroke pattern practice',
      'Guided tracing of focus letters',
      'Independent writing of focus letters',
    ]),
  }),
  curved: Object.freeze({
    title: 'Curved Movement Practice',
    suggestedActivities: Object.freeze([
      'Circle tracing exercises',
      'Half-circle tracing with visual guides',
      'Slow curved-stroke repetition',
      'Guided tracing of focus letters',
      'Independent writing of focus letters',
    ]),
  }),
  complex: Object.freeze({
    title: 'Complex Movement Practice',
    // Deliberately generic (Step 2 spec §11) — Feature 7's `complex` family
    // is not identical to difficultyRules.js's ZIGZAG_INSTABILITY category
    // (Step 1 audit §20), so this wording must stay broad enough to cover
    // any reviewed complex-family letter (e.g. 's', 'v', 'w', 'x', 'y'),
    // never implying every complex letter is a diagonal/zigzag shape.
    suggestedActivities: Object.freeze([
      'Zigzag tracing',
      'Direction-change pattern tracing',
      'Combined-stroke tracing',
      'Guided tracing of focus letters',
      'Independent writing of focus letters',
    ]),
  }),
});

/**
 * @param {string} family — expected 'straight'|'curved'|'complex'.
 * @returns {{title: string, suggestedActivities: ReadonlyArray<string>}|null}
 *   `null` for any family not in Feature 7's own vocabulary — never a
 *   guessed/default template.
 */
function getWorksheetRecommendationTemplate(family) {
  return isValidFamily(family) ? WORKSHEET_RECOMMENDATION_POLICY[family] : null;
}

// ─── Focus-letter extraction ────────────────────────────────────────────────

/**
 * Extracts the plain letter list from Feature 7's `affectedLetters` shape
 * (`[{letter, totalCycles, failedCycles}, ...]`), preserving Feature 7's
 * own order EXACTLY (Step 2 spec §13/§15) — that order is already
 * deterministic (failedCycles desc, then totalCycles desc, then
 * alphabetical, per Feature 7 Step 2/3) and must never be re-sorted or
 * reinterpreted here. `failedCycles`/`totalCycles` are read only to the
 * extent needed to validate shape — never used to alter ordering or content
 * (Step 2 spec §32 — Feature 8 must not interpret them as intervention
 * severity).
 *
 * Never throws — malformed input (null/undefined/non-array/malformed
 * entries) safely resolves to `[]` (Step 2 spec §14).
 *
 * @param {Array<{letter: *, totalCycles?: *, failedCycles?: *}>|null|undefined} affectedLetters
 * @returns {string[]}
 */
function extractFocusLetters(affectedLetters) {
  if (!Array.isArray(affectedLetters)) return [];
  return affectedLetters
    .filter((entry) => entry != null && typeof entry.letter === 'string' && entry.letter.length > 0)
    .map((entry) => entry.letter);
}

// ─── Rationale ──────────────────────────────────────────────────────────────
//
// Teacher-friendly wording only (Step 2 spec §17/§18/§19) — never raw
// separationMs, the 24-hour rule, window indices, session IDs, or raw
// scores/ratios. `earlierWindow`/`recentWindow` are consulted only for
// their PRESENCE (both evaluated windows existed and contributed evidence),
// never their raw counts.

const RATIONALE_INTRO = Object.freeze({
  straight: 'Straight movement practice is recommended because difficulty remained across two separate practice periods.',
  curved: 'Curved movement practice is recommended because difficulty remained across two separate practice periods.',
  complex: 'Complex movement practice is recommended because difficulty remained across two separate practice periods.',
});

const RATIONALE_EVIDENCE_SENTENCE = 'The pattern was observed in both the earlier and recent practice periods.';

/**
 * @param {Object} params
 * @param {string} params.family — expected 'straight'|'curved'|'complex'.
 * @param {Object|null} [params.earlierWindow] — presence-only signal.
 * @param {Object|null} [params.recentWindow] — presence-only signal.
 * @returns {string|null} `null` for an invalid family — never a guessed
 *   generic sentence.
 */
function buildWorksheetRationale({ family, earlierWindow, recentWindow } = {}) {
  const intro = isValidFamily(family) ? RATIONALE_INTRO[family] : null;
  if (!intro) return null;
  return earlierWindow != null && recentWindow != null
    ? `${intro} ${RATIONALE_EVIDENCE_SENTENCE}`
    : intro;
}

// ─── Recommendation builder ─────────────────────────────────────────────────

/**
 * Builds one worksheet recommendation object from a single Feature 7
 * `persistent` stream's own fields. Pure — no DB access, no I/O, no
 * randomness; the same input always produces the exact same output
 * (Step 2 spec §31/§38).
 *
 * The caller (a future Step 3 service) is expected to invoke this ONLY for
 * streams where `status === 'persistent'` — this function itself does not
 * check `status`, since it has no opinion on triggering, only on shaping
 * the content for a stream the caller has already decided is persistent.
 *
 * @param {Object} params
 * @param {string} [params.caseType] — 'lowercase'|'uppercase', passed
 *   through verbatim (never validated/coerced here — Feature 7 already
 *   guarantees a valid value on a real stream).
 * @param {string} params.family — expected 'straight'|'curved'|'complex'.
 * @param {Array|null|undefined} [params.affectedLetters] — Feature 7's own
 *   `affectedLetters` array for this stream.
 * @param {Object|null} [params.earlierWindow]
 * @param {Object|null} [params.recentWindow]
 * @returns {{
 *   recommendationType: string,
 *   caseType: string|null,
 *   family: string,
 *   title: string,
 *   focusLetters: string[],
 *   rationale: string,
 *   suggestedActivities: string[],
 * }|null} `null` when `family` is not one of Feature 7's own three values —
 *   never a guessed/default recommendation (Step 2 spec §21).
 */
function buildWorksheetRecommendation({ caseType, family, affectedLetters, earlierWindow, recentWindow } = {}) {
  const template = getWorksheetRecommendationTemplate(family);
  if (!template) return null;

  return {
    recommendationType: WORKSHEET_RECOMMENDATION_TYPES.MOTOR_FAMILY_PRACTICE,
    caseType: caseType ?? null,
    family,
    title: template.title,
    // Feature 7's own live letters ONLY — never expanded with a static
    // family-template letter list (Step 2 spec §15/§22).
    focusLetters: extractFocusLetters(affectedLetters),
    rationale: buildWorksheetRationale({ family, earlierWindow, recentWindow }),
    // Copied (not referenced) so a caller can never mutate the frozen
    // policy array via the returned recommendation object.
    suggestedActivities: [...template.suggestedActivities],
  };
}

// ─── Summary helper ─────────────────────────────────────────────────────────

/**
 * @param {Array|null|undefined} recommendations
 * @returns {{recommendationCount: number}}
 */
function summarizeWorksheetRecommendations(recommendations) {
  return { recommendationCount: Array.isArray(recommendations) ? recommendations.length : 0 };
}

module.exports = {
  WORKSHEET_RECOMMENDATION_TYPES,
  VALID_FAMILIES,
  isValidFamily,
  WORKSHEET_RECOMMENDATION_POLICY,
  getWorksheetRecommendationTemplate,
  extractFocusLetters,
  buildWorksheetRationale,
  buildWorksheetRecommendation,
  summarizeWorksheetRecommendations,
};
