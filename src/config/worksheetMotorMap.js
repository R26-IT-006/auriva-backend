'use strict';

/**
 * worksheetMotorMap.js
 *
 * The single authoritative map from a taught letter to the MOTOR PREPARATION
 * a practice worksheet should rehearse before that letter is written.
 *
 * ── The design principle this file exists to serve ────────────────────────
 * A worksheet must NOT open by repeating the letter the child is struggling
 * with. It works up to it:
 *
 *     motor-preparation shapes -> letter tracing -> copying -> independent
 *
 * So for `c` the page starts with curved movement and half-circles, and only
 * then shows a dotted `c`.
 *
 * ── Derived, not invented ─────────────────────────────────────────────────
 * Every prerequisite below is derived from the letter's OWN `strokeTypes` in
 * the frontend teaching taxonomy (letterCategories.js) — the same six shape
 * ids the initial assessment scores and the same array letterBaselineFamilies.js
 * already derives its families from. Nothing here is a fresh guess about how a
 * letter is written.
 *
 * The six shape ids, and the warm-up each maps to:
 *   vertical_line   -> vertical strokes
 *   horizontal_line -> horizontal strokes
 *   full_circle     -> full circles
 *   half_circle     -> half circles / open curves
 *   zigzag          -> diagonal strokes
 *   curve_wave      -> waves / alternating curves
 *
 * Case matters and is never assumed symmetric: `a` is [full_circle,
 * vertical_line] while `A` is [zigzag, horizontal_line]; `h` is
 * [vertical_line, curve_wave] while `H` is [vertical_line, vertical_line,
 * horizontal_line]. Each form is mapped from its own strokeTypes.
 *
 * ── Unmapped letters are flagged, never guessed ───────────────────────────
 * getWorksheetMotorPlan() returns `status: 'unmapped'` for any letter this
 * file has no stroke data for. A caller must surface that for manual teacher
 * configuration rather than fabricating a preparation sequence.
 *
 * ── What this file is NOT ─────────────────────────────────────────────────
 * Not a difficulty model, not a severity scale, not a clinical sequence. It is
 * a printable-practice ordering, and it never feeds mastery, Motor Score,
 * thresholds or adaptive sequencing.
 */

// ─── Shape vocabulary ───────────────────────────────────────────────────────
// Teacher/child-facing labels for the six shape ids. Short, literal, and free
// of any performance language — these are printed on a child's worksheet.
const SHAPE_LIBRARY = Object.freeze({
  vertical_line:   { id: 'vertical_line',   label: 'Straight down lines',   instruction: 'Trace the lines down.' },
  horizontal_line: { id: 'horizontal_line', label: 'Straight across lines', instruction: 'Trace the lines across.' },
  full_circle:     { id: 'full_circle',     label: 'Circles',               instruction: 'Trace the circles.' },
  half_circle:     { id: 'half_circle',     label: 'Curves',                instruction: 'Trace the curves.' },
  zigzag:          { id: 'zigzag',          label: 'Slanted lines',         instruction: 'Trace the slanted lines.' },
  curve_wave:      { id: 'curve_wave',      label: 'Waves',                 instruction: 'Trace the waves.' },
});

const VALID_SHAPE_IDS = Object.freeze(Object.keys(SHAPE_LIBRARY));

// ─── Letter stroke definitions ──────────────────────────────────────────────
//
// Copied VERBATIM from auriva-frontend/src/constants/letterCategories.js's own
// per-letter `strokeTypes`. Backend and frontend are separate runtimes with no
// shared package (the same reason letterLearningCategories.js exists as a
// hand-kept copy), so this is that established convention applied again.
// tests/worksheetMotorMap.test.js parses the frontend file directly and asserts
// the two agree, so a drift fails CI rather than silently mis-preparing a page.

const LETTER_STROKE_TYPES = Object.freeze({
  // -- lowercase --
  a: ['full_circle', 'vertical_line'],
  b: ['vertical_line', 'half_circle'],
  c: ['half_circle'],
  d: ['full_circle', 'vertical_line'],
  e: ['half_circle', 'horizontal_line'],
  f: ['curve_wave', 'horizontal_line'],
  g: ['full_circle', 'vertical_line'],
  h: ['vertical_line', 'curve_wave'],
  i: ['vertical_line'],
  j: ['vertical_line', 'curve_wave'],
  k: ['vertical_line', 'zigzag'],
  l: ['vertical_line'],
  m: ['vertical_line', 'curve_wave', 'curve_wave'],
  n: ['vertical_line', 'curve_wave'],
  o: ['full_circle'],
  p: ['vertical_line', 'half_circle'],
  q: ['full_circle', 'vertical_line'],
  r: ['vertical_line', 'half_circle'],
  s: ['curve_wave'],
  t: ['vertical_line', 'horizontal_line'],
  u: ['curve_wave'],
  v: ['zigzag'],
  w: ['zigzag', 'zigzag'],
  x: ['zigzag', 'zigzag'],
  y: ['zigzag', 'curve_wave'],
  z: ['horizontal_line', 'zigzag', 'horizontal_line'],

  // -- uppercase --
  A: ['zigzag', 'horizontal_line'],
  B: ['vertical_line', 'half_circle', 'half_circle'],
  C: ['half_circle'],
  D: ['vertical_line', 'half_circle'],
  E: ['vertical_line', 'horizontal_line', 'horizontal_line'],
  F: ['vertical_line', 'horizontal_line'],
  G: ['half_circle', 'horizontal_line'],
  H: ['vertical_line', 'vertical_line', 'horizontal_line'],
  I: ['vertical_line'],
  J: ['vertical_line', 'curve_wave'],
  K: ['vertical_line', 'zigzag'],
  L: ['vertical_line', 'horizontal_line'],
  M: ['vertical_line', 'zigzag', 'vertical_line'],
  N: ['vertical_line', 'zigzag', 'vertical_line'],
  O: ['full_circle'],
  P: ['vertical_line', 'half_circle'],
  Q: ['full_circle', 'zigzag'],
  R: ['vertical_line', 'half_circle', 'zigzag'],
  S: ['curve_wave'],
  T: ['vertical_line', 'horizontal_line'],
  U: ['curve_wave'],
  V: ['zigzag'],
  W: ['zigzag', 'zigzag'],
  X: ['zigzag', 'zigzag'],
  Y: ['zigzag', 'vertical_line'],
  Z: ['horizontal_line', 'zigzag', 'horizontal_line'],
});

// ─── Family emphasis (Phase 7) ──────────────────────────────────────────────
//
// The persistent-difficulty stream that produced the recommendation decides
// which warm-up gets the EXTRA row — it never changes which letter is
// targeted, and never removes a prerequisite the letter genuinely needs.
//
// Families are Feature 2's baseline families (straight | curved | complex).
const FAMILY_EMPHASIS = Object.freeze({
  straight: ['vertical_line', 'horizontal_line'],
  curved:   ['full_circle', 'half_circle'],
  complex:  ['curve_wave', 'zigzag'],
});

// Warm-up rows per shape. 'extended' adds one practice row per shape — more
// repetition of the same movements, never a harder or different task.
const ROWS_BY_INTENSITY = Object.freeze({ standard: 1, extended: 2 });
const VALID_INTENSITIES = Object.freeze(Object.keys(ROWS_BY_INTENSITY));

function isValidIntensity(value) {
  return typeof value === 'string' && VALID_INTENSITIES.includes(value);
}

/**
 * @param {string} letter
 * @returns {string[]|null} this letter form's own stroke ids, or null if this
 *   file has no definition for it (never a guessed default).
 */
function getLetterStrokeTypes(letter) {
  if (typeof letter !== 'string' || letter.length !== 1) return null;
  return LETTER_STROKE_TYPES[letter] ? [...LETTER_STROKE_TYPES[letter]] : null;
}

/**
 * Builds the full motor-preparation plan for one worksheet.
 *
 * Ordering is deliberate and always the same, so a child meets the page in a
 * predictable shape:
 *   1. warm-up shapes  — every distinct stroke this letter needs, de-duplicated
 *      in first-appearance order, with the difficulty family's own shapes
 *      given an extra row
 *   2. shape practice  — the letter's PRIMARY shape (its first stroke), drawn
 *      large -> medium -> small, walking down toward letter size
 *   3-5. trace / copy / independent — handled by the renderer, not here
 *
 * @param {Object} params
 * @param {string} params.letter
 * @param {'lowercase'|'uppercase'} params.caseType
 * @param {'straight'|'curved'|'complex'|null} [params.family] — the stream that
 *   produced the recommendation. Only adjusts emphasis.
 * @param {'standard'|'extended'} [params.intensity='standard']
 * @returns {{
 *   status: 'ok'|'unmapped'|'invalid_input',
 *   letter: string|null, caseType: string|null,
 *   strokeTypes: string[], warmUp: Array<Object>, primaryShape: Object|null,
 *   shapePracticeSizes: string[], intensity: string,
 * }}
 */
function getWorksheetMotorPlan({ letter, caseType, family = null, intensity = 'standard' } = {}) {
  const empty = {
    letter: null, caseType: null, strokeTypes: [], warmUp: [],
    primaryShape: null, shapePracticeSizes: [], intensity: 'standard',
  };

  if (!['lowercase', 'uppercase'].includes(caseType)) {
    return { status: 'invalid_input', ...empty };
  }
  if (typeof letter !== 'string' || letter.length !== 1) {
    return { status: 'invalid_input', ...empty };
  }
  // The letter form must match the requested case — 'C' is never served as a
  // lowercase plan, because the two forms have genuinely different strokes.
  const expected = caseType === 'lowercase' ? letter.toLowerCase() : letter.toUpperCase();
  if (letter !== expected) return { status: 'invalid_input', ...empty };

  const strokeTypes = getLetterStrokeTypes(letter);
  if (!strokeTypes) {
    // Flagged for manual teacher configuration — never a fabricated sequence.
    return { status: 'unmapped', ...empty, letter, caseType };
  }

  const safeIntensity = isValidIntensity(intensity) ? intensity : 'standard';
  const baseRows = ROWS_BY_INTENSITY[safeIntensity];
  const emphasised = FAMILY_EMPHASIS[family] ?? [];

  // De-duplicated in first-appearance order: H's two vertical strokes are one
  // warm-up, not two identical rows.
  const seen = new Set();
  const warmUp = [];
  for (const id of strokeTypes) {
    if (seen.has(id) || !VALID_SHAPE_IDS.includes(id)) continue;
    seen.add(id);
    warmUp.push({
      ...SHAPE_LIBRARY[id],
      // The difficulty family's own shapes get one extra row of the SAME
      // movement — more practice, never a harder task.
      rows: emphasised.includes(id) ? baseRows + 1 : baseRows,
      emphasised: emphasised.includes(id),
    });
  }

  // The letter's primary shape leads Section 2, stepped down in size so the
  // movement narrows toward writing scale before the letter itself appears.
  const primaryShape = warmUp.length > 0 ? { ...SHAPE_LIBRARY[strokeTypes[0]] } : null;

  return {
    status: 'ok',
    letter, caseType,
    strokeTypes,
    warmUp,
    primaryShape,
    shapePracticeSizes: ['large', 'medium', 'small'],
    intensity: safeIntensity,
  };
}

module.exports = {
  SHAPE_LIBRARY,
  VALID_SHAPE_IDS,
  LETTER_STROKE_TYPES,
  FAMILY_EMPHASIS,
  ROWS_BY_INTENSITY,
  VALID_INTENSITIES,
  isValidIntensity,
  getLetterStrokeTypes,
  getWorksheetMotorPlan,
};
