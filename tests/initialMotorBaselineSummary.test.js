'use strict';

// Initial Motor Baseline Summary — pure helper tests.
//
// Proves the deterministic teacher-facing summary uses the four
// authoritative assessment-domain scores exactly as stored, never
// recalculates them, never reaches for progression_* / ML / clustering, and
// never emits evaluative or clinical language.

const path = require('path');
const fs = require('fs');

const {
  buildInitialMotorBaselineSummary,
  SCORE_RESOLUTION,
  TIE_TOLERANCE,
  DISCLOSURE,
} = require('../src/utils/initialMotorBaselineSummary');

// Same comment-stripping convention as tests/periodicReportContent.test.js —
// these assertions are about executable code, not about the header prose
// (which deliberately NAMES progression_* / clustering to document that this
// module does not use them).
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const SOURCE = stripComments(fs.readFileSync(
  path.resolve(__dirname, '../src/utils/initialMotorBaselineSummary.js'),
  'utf8',
));

const base = (straight, curved, complex_, overall) => buildInitialMotorBaselineSummary({
  straightScore:     straight,
  curvedScore:       curved,
  complexScore:      complex_,
  overallMotorScore: overall,
});

// ─── 1. Uses the four authoritative scores, verbatim ────────────────────────

describe('uses the four authoritative scores exactly as stored', () => {
  it('copies straight/curved/complex/overall without recalculation', () => {
    const r = base(95, 91, 94, 93);
    expect(r.available).toBe(true);
    expect(r.families).toEqual({ straight: 95, curved: 91, complex: 94 });
    expect(r.overall_score).toBe(93);
  });

  it('does not round, clamp, or rescale a non-integer historical value', () => {
    const r = base(94.5, 91.25, 90, 92.75);
    expect(r.families.straight).toBe(94.5);
    expect(r.families.curved).toBe(91.25);
    expect(r.overall_score).toBe(92.75);
  });

  it('reports the declared tie tolerance and score resolution', () => {
    const r = base(95, 91, 94, 93);
    expect(r.relative_summary.tolerance).toBe(0.5);
    expect(r.relative_summary.score_resolution).toBe(1);
    expect(TIE_TOLERANCE).toBe(0.5);
    expect(SCORE_RESOLUTION).toBe(1);
  });

  it('never reads progression_* values, ML, or clustering', () => {
    expect(SOURCE).not.toMatch(/progression_/);
    expect(SOURCE).not.toMatch(/cluster|kmeans|KMeans|centroid|predict/i);
    expect(SOURCE).not.toMatch(/require\(/); // pure module: zero dependencies
  });

  it('performs no database access and no writes', () => {
    expect(SOURCE).not.toMatch(/\.create\(|\.update\(|\.destroy\(|\.save\(|findOne|findAll/);
  });
});

// ─── 2. Relative summary: highest / lowest / spread ─────────────────────────

describe('relative summary', () => {
  it('identifies an unambiguous highest and lowest with the correct spread', () => {
    const r = base(95, 91, 94, 93);
    expect(r.relative_summary.highest).toBe('straight');
    expect(r.relative_summary.lowest).toBe('curved');
    expect(r.relative_summary.spread).toBe(4);
    expect(r.relative_summary.tied).toBe(false);
    expect(r.relative_summary.tie_groups).toEqual([['straight'], ['complex'], ['curved']]);
  });

  it('spread always equals max minus min', () => {
    for (const [s, c, x] of [[95, 91, 94], [70, 70, 70], [100, 0, 50], [88, 90, 89]]) {
      const r = base(s, c, x, 90);
      expect(r.relative_summary.spread).toBe(Math.max(s, c, x) - Math.min(s, c, x));
    }
  });

  it('matches the example wording style from the specification', () => {
    const r = base(95, 91, 89, 92);
    expect(r.description).toBe(
      'Within the initial assessment, the Straight movement family had the highest measured score, '
      + 'and the Complex movement family had the lowest measured score. '
      + 'The difference between them was 6 points.',
    );
  });

  it('uses the singular "point" for a one-point difference', () => {
    const r = base(95, 94, 94.5, 95);
    expect(r.description).toContain('was 1 point.');
    expect(r.description).not.toContain('1 points');
  });
});

// ─── 3. Tie handling ────────────────────────────────────────────────────────

describe('tie handling', () => {
  it('reports no highest or lowest when all three families are equal', () => {
    const r = base(90, 90, 90, 90);
    expect(r.relative_summary.tied).toBe(true);
    expect(r.relative_summary.highest).toBeNull();
    expect(r.relative_summary.lowest).toBeNull();
    expect(r.relative_summary.spread).toBe(0);
    expect(r.relative_summary.tie_groups).toEqual([['straight', 'curved', 'complex']]);
    expect(r.description).toContain('no single highest or lowest movement family is reported');
  });

  it('reports no highest but a valid lowest on a two-way top tie', () => {
    const r = base(95, 95, 90, 93);
    expect(r.relative_summary.tied).toBe(false);
    expect(r.relative_summary.highest).toBeNull();
    expect(r.relative_summary.lowest).toBe('complex');
    expect(r.description).toContain('the Straight and Curved movement families had the highest measured scores');
    expect(r.description).toContain('the Complex movement family had the lowest measured score');
  });

  it('reports a valid highest but no lowest on a two-way bottom tie', () => {
    const r = base(95, 90, 90, 92);
    expect(r.relative_summary.highest).toBe('straight');
    expect(r.relative_summary.lowest).toBeNull();
    expect(r.description).toContain('the Curved and Complex movement families had the lowest measured scores');
  });

  it('treats sub-tolerance historical differences as tied', () => {
    const r = base(95, 95.3, 95.4, 95);
    expect(r.relative_summary.tied).toBe(true);
    expect(r.relative_summary.highest).toBeNull();
    expect(r.relative_summary.lowest).toBeNull();
  });

  // Guard: the tolerance must never be widened to swallow adjacent integers,
  // which are the smallest real difference these scores can express.
  it('does NOT treat adjacent integer scores as tied', () => {
    const r = base(95, 94, 93, 94);
    expect(r.relative_summary.tied).toBe(false);
    expect(r.relative_summary.highest).toBe('straight');
    expect(r.relative_summary.lowest).toBe('complex');
    expect(r.relative_summary.spread).toBe(2);
  });

  it('orders tie groups canonically, independent of which family is higher', () => {
    expect(base(91, 95, 94, 93).relative_summary.tie_groups).toEqual([['curved'], ['complex'], ['straight']]);
    expect(base(90, 95, 95, 93).relative_summary.tie_groups).toEqual([['curved', 'complex'], ['straight']]);
  });
});

// ─── 4. Missing / non-finite data handled neutrally ─────────────────────────

describe('missing or non-finite data', () => {
  const badCases = [
    ['missing straight', [null, 91, 94, 93]],
    ['missing curved', [95, undefined, 94, 93]],
    ['missing complex', [95, 91, null, 93]],
    ['missing overall', [95, 91, 94, null]],
    ['NaN', [95, NaN, 94, 93]],
    ['Infinity', [95, 91, Infinity, 93]],
    ['string', [95, '91', 94, 93]],
  ];

  it.each(badCases)('%s yields the neutral unavailable shape', (_label, args) => {
    const r = base(...args);
    expect(r.available).toBe(false);
    expect(r.overall_score).toBeNull();
    expect(r.families).toEqual({ straight: null, curved: null, complex: null });
    expect(r.relative_summary.highest).toBeNull();
    expect(r.relative_summary.lowest).toBeNull();
    expect(r.relative_summary.tie_groups).toEqual([]);
    expect(r.description).toBe('A complete initial motor baseline is not available for this student.');
  });

  it('never partially interprets — no highest/lowest wording when unavailable', () => {
    const r = base(95, null, 94, 93);
    expect(r.description).not.toMatch(/highest|lowest/);
  });

  it('never throws, including on no argument at all', () => {
    expect(() => buildInitialMotorBaselineSummary()).not.toThrow();
    expect(buildInitialMotorBaselineSummary().available).toBe(false);
  });
});

// ─── 5. Neutral, non-clinical language ──────────────────────────────────────

describe('neutral language', () => {
  const BANNED = /\b(good|bad|poor|strong|weak|mild|moderate|severe|impaired|impairment|normal|abnormal|deficit|delay|delayed|risk|better|worse|concern|typical|atypical|diagnos\w*|autis\w*|ASD|severity)\b/i;

  const grid = [];
  for (const s of [0, 47, 90, 95, 100]) {
    for (const c of [0, 47, 90, 95, 100]) {
      for (const x of [0, 47, 90, 95, 100]) grid.push([s, c, x]);
    }
  }

  it('emits no evaluative or clinical vocabulary for any score combination', () => {
    for (const [s, c, x] of grid) {
      const r = base(s, c, x, 90);
      expect(r.description).not.toMatch(BANNED);
    }
  });

  it('every generated description is a within-learner comparison', () => {
    for (const [s, c, x] of grid) {
      const r = base(s, c, x, 90);
      expect(r.description.startsWith('Within the initial assessment,')).toBe(true);
    }
  });

  it('ships the exact required disclosure', () => {
    expect(base(95, 91, 94, 93).disclosure).toBe(
      'These values summarize performance during the initial motor assessment and are intended for '
      + 'educational monitoring. They are not diagnostic or ASD-severity measures.',
    );
    expect(DISCLOSURE).toContain('not diagnostic or ASD-severity measures');
  });

  it('never emits cluster/profile/confidence terminology', () => {
    for (const [s, c, x] of grid) {
      const r = base(s, c, x, 90);
      const text = `${r.description} ${r.disclosure}`;
      expect(text).not.toMatch(/Profile A|Profile B|Distinct Motor Profile|cluster|centroid|confidence|probability/i);
    }
  });
});

// ─── 6. Purity ──────────────────────────────────────────────────────────────

describe('purity', () => {
  it('does not mutate its input object', () => {
    const input = { straightScore: 95, curvedScore: 91, complexScore: 94, overallMotorScore: 93 };
    const snapshot = { ...input };
    buildInitialMotorBaselineSummary(input);
    expect(input).toEqual(snapshot);
  });

  it('is deterministic across repeated calls', () => {
    const a = base(95, 91, 94, 93);
    const b = base(95, 91, 94, 93);
    expect(a).toEqual(b);
  });
});
