'use strict';

// Letter -> motor-preparation mapping. Every prerequisite must be DERIVED from
// the letter's own strokeTypes in the frontend teaching taxonomy, never guessed.

const fs = require('fs');
const path = require('path');
const {
  getWorksheetMotorPlan, getLetterStrokeTypes, LETTER_STROKE_TYPES,
  SHAPE_LIBRARY, VALID_SHAPE_IDS, FAMILY_EMPHASIS,
} = require('../src/config/worksheetMotorMap');

/** Parses the FRONTEND taxonomy so drift fails CI rather than shipping. */
function frontendStrokeTypes() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../auriva-frontend/src/constants/letterCategories.js'), 'utf8');
  const re = /letter:\s*'([A-Za-z])'[\s\S]*?strokeTypes:\s*\[([^\]]*)\]/g;
  const out = {};
  let m;
  while ((m = re.exec(src))) {
    const letter = m[1];
    if (out[letter]) continue;
    out[letter] = m[2].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
  }
  return out;
}

describe('mapping is derived from the real taxonomy', () => {
  const frontend = frontendStrokeTypes();

  it('covers all 52 taught letter forms', () => {
    expect(Object.keys(LETTER_STROKE_TYPES)).toHaveLength(52);
  });

  it('every backend stroke list matches the frontend letterCategories source', () => {
    const drift = [];
    for (const [letter, strokes] of Object.entries(LETTER_STROKE_TYPES)) {
      const want = frontend[letter];
      if (!want) { drift.push(`${letter}: missing in frontend`); continue; }
      if (JSON.stringify(want) !== JSON.stringify(strokes)) {
        drift.push(`${letter}: frontend ${JSON.stringify(want)} vs backend ${JSON.stringify(strokes)}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('only the six assessed shape ids are ever used', () => {
    for (const strokes of Object.values(LETTER_STROKE_TYPES)) {
      for (const s of strokes) expect(VALID_SHAPE_IDS).toContain(s);
    }
  });
});

describe('the specification examples', () => {
  const plan = (letter, caseType, family) => getWorksheetMotorPlan({ letter, caseType, family });
  const ids = (p) => p.warmUp.map((w) => w.id);

  it('C / c -> curve preparation', () => {
    expect(ids(plan('c', 'lowercase', 'curved'))).toEqual(['half_circle']);
    expect(ids(plan('C', 'uppercase', 'curved'))).toEqual(['half_circle']);
  });

  it('O / o -> full-circle preparation', () => {
    expect(ids(plan('o', 'lowercase', 'curved'))).toEqual(['full_circle']);
    expect(ids(plan('O', 'uppercase', 'curved'))).toEqual(['full_circle']);
  });

  it('L -> vertical + horizontal', () => {
    expect(ids(plan('L', 'uppercase', 'straight'))).toEqual(['vertical_line', 'horizontal_line']);
  });

  it('T -> vertical + horizontal', () => {
    expect(ids(plan('T', 'uppercase', 'straight'))).toEqual(['vertical_line', 'horizontal_line']);
  });

  it('K / k -> vertical + diagonal', () => {
    expect(ids(plan('K', 'uppercase', 'complex'))).toEqual(['vertical_line', 'zigzag']);
    expect(ids(plan('k', 'lowercase', 'complex'))).toEqual(['vertical_line', 'zigzag']);
  });

  it('S / s -> wave preparation', () => {
    expect(ids(plan('S', 'uppercase', 'complex'))).toEqual(['curve_wave']);
  });

  it('B / b -> vertical + half circles', () => {
    expect(ids(plan('B', 'uppercase', 'curved'))).toEqual(['vertical_line', 'half_circle']);
    expect(ids(plan('b', 'lowercase', 'curved'))).toEqual(['vertical_line', 'half_circle']);
  });

  it('upper and lower forms are mapped INDEPENDENTLY, never assumed equal', () => {
    // 'a' is a circle + stem; 'A' is diagonals + a crossbar.
    expect(ids(plan('a', 'lowercase'))).toEqual(['full_circle', 'vertical_line']);
    expect(ids(plan('A', 'uppercase'))).toEqual(['zigzag', 'horizontal_line']);
    // 'h' uses a curve shoulder; 'H' is two stems and a bridge.
    expect(ids(plan('h', 'lowercase'))).toEqual(['vertical_line', 'curve_wave']);
    expect(ids(plan('H', 'uppercase'))).toEqual(['vertical_line', 'horizontal_line']);
  });
});

describe('plan construction', () => {
  it('de-duplicates a repeated stroke into one warm-up row group', () => {
    // H is [vertical, vertical, horizontal] — two stems, one warm-up.
    const p = getWorksheetMotorPlan({ letter: 'H', caseType: 'uppercase' });
    expect(p.warmUp.map((w) => w.id)).toEqual(['vertical_line', 'horizontal_line']);
  });

  it("the difficulty family adds a row to its OWN shapes only", () => {
    const curved = getWorksheetMotorPlan({ letter: 'b', caseType: 'lowercase', family: 'curved' });
    const byId = Object.fromEntries(curved.warmUp.map((w) => [w.id, w]));
    expect(byId.half_circle.rows).toBe(2);
    expect(byId.half_circle.emphasised).toBe(true);
    expect(byId.vertical_line.rows).toBe(1);
    expect(byId.vertical_line.emphasised).toBe(false);
  });

  it('family emphasis never removes a prerequisite the letter needs', () => {
    const straight = getWorksheetMotorPlan({ letter: 'b', caseType: 'lowercase', family: 'straight' });
    expect(straight.warmUp.map((w) => w.id)).toEqual(['vertical_line', 'half_circle']);
  });

  it('extended intensity adds repetition of the SAME movements, not new ones', () => {
    const std = getWorksheetMotorPlan({ letter: 'k', caseType: 'lowercase', intensity: 'standard' });
    const ext = getWorksheetMotorPlan({ letter: 'k', caseType: 'lowercase', intensity: 'extended' });
    expect(ext.warmUp.map((w) => w.id)).toEqual(std.warmUp.map((w) => w.id));
    expect(ext.warmUp[0].rows).toBeGreaterThan(std.warmUp[0].rows);
  });

  it('shape practice steps large -> medium -> small', () => {
    expect(getWorksheetMotorPlan({ letter: 'c', caseType: 'lowercase' }).shapePracticeSizes)
      .toEqual(['large', 'medium', 'small']);
  });

  it('the primary shape is the letter\'s FIRST stroke', () => {
    expect(getWorksheetMotorPlan({ letter: 'k', caseType: 'lowercase' }).primaryShape.id).toBe('vertical_line');
    expect(getWorksheetMotorPlan({ letter: 'c', caseType: 'lowercase' }).primaryShape.id).toBe('half_circle');
  });

  it('an invalid intensity falls back to standard rather than throwing', () => {
    expect(getWorksheetMotorPlan({ letter: 'c', caseType: 'lowercase', intensity: 'severe' }).intensity)
      .toBe('standard');
  });
});

describe('an unmapped or mismatched letter is flagged, never guessed', () => {
  it('an unknown character reports unmapped with NO fabricated preparation', () => {
    const p = getWorksheetMotorPlan({ letter: 'é', caseType: 'lowercase' });
    expect(p.status).toBe('unmapped');
    expect(p.warmUp).toEqual([]);
    expect(p.primaryShape).toBeNull();
  });

  it('a case mismatch is rejected — C is never served as a lowercase plan', () => {
    expect(getWorksheetMotorPlan({ letter: 'C', caseType: 'lowercase' }).status).toBe('invalid_input');
    expect(getWorksheetMotorPlan({ letter: 'c', caseType: 'uppercase' }).status).toBe('invalid_input');
  });

  it('invalid inputs never produce a plan', () => {
    for (const bad of [{}, { letter: 'ab', caseType: 'lowercase' }, { letter: 'c', caseType: 'title' }]) {
      const p = getWorksheetMotorPlan(bad);
      expect(p.status).toBe('invalid_input');
      expect(p.warmUp).toEqual([]);
    }
  });

  it('getLetterStrokeTypes returns null rather than a default', () => {
    expect(getLetterStrokeTypes('é')).toBeNull();
    expect(getLetterStrokeTypes('')).toBeNull();
  });
});

describe('teacher/child-facing vocabulary', () => {
  it('shape labels and instructions carry no performance language', () => {
    const text = JSON.stringify(SHAPE_LIBRARY).toLowerCase();
    for (const banned of ['difficult', 'poor', 'weak', 'fail', 'severity', 'deficit', 'score', 'level']) {
      expect(text).not.toContain(banned);
    }
  });

  it('the family emphasis map covers exactly the three baseline families', () => {
    expect(Object.keys(FAMILY_EMPHASIS).sort()).toEqual(['complex', 'curved', 'straight']);
  });
});
