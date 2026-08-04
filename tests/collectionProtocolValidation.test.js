'use strict';

const {
  validateSession, EXPECTED_SHAPES, EXPECTED_LOWERCASE, EXPECTED_UPPERCASE,
} = require('../src/utils/collectionProtocolValidation');

function makeShapeRow(shape_type, overrides = {}) {
  return {
    shape_type, attempt_number: 1, task_order: EXPECTED_SHAPES.indexOf(shape_type),
    stroke_points: [{ stroke_id: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    features: { duration_ms: 500 },
    ...overrides,
  };
}

function makeLetterRows(letter, caseLabel, offset, overrides = {}) {
  return [1, 2, 3].map(attempt_number => ({
    letter, case_type: caseLabel,
    attempt_number,
    task_order: offset,
    stroke_points: [{ stroke_id: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }],
    features: { completionTime: 500 },
    ...overrides,
  }));
}

function completeSession() {
  const shapeRows = EXPECTED_SHAPES.map(makeShapeRow);
  const lowercaseRows = EXPECTED_LOWERCASE.flatMap((l, i) => makeLetterRows(l, 'lowercase', 6 + i));
  const uppercaseRows = EXPECTED_UPPERCASE.flatMap((l, i) => makeLetterRows(l, 'uppercase', 16 + i));
  return { shapeRows, lowercaseRows, uppercaseRows };
}

describe('validateSession', () => {
  it('returns no warnings for a fully complete, well-formed session', () => {
    const warnings = validateSession(completeSession());
    expect(warnings).toEqual([]);
  });

  it('flags a missing shape', () => {
    const session = completeSession();
    session.shapeRows = session.shapeRows.filter(r => r.shape_type !== 'zigzag');
    const warnings = validateSession(session);
    expect(warnings.some(w => w.includes('Missing shapes') && w.includes('zigzag'))).toBe(true);
  });

  it('flags a letter with the wrong attempt count', () => {
    const session = completeSession();
    session.lowercaseRows = session.lowercaseRows.filter(r => !(r.letter === 'i' && r.attempt_number === 3));
    const warnings = validateSession(session);
    expect(warnings.some(w => w.includes('lowercase letter "i"') && w.includes('expected 3'))).toBe(true);
  });

  it('flags incomplete uppercase letters distinctly from lowercase', () => {
    const session = completeSession();
    session.uppercaseRows = session.uppercaseRows.filter(r => r.letter !== 'K');
    const warnings = validateSession(session);
    expect(warnings.some(w => w.includes('Missing uppercase letters') && w.includes('K'))).toBe(true);
  });

  it('flags a task_order reused by two different tasks (but not by one task\'s own 3 attempts)', () => {
    const session = completeSession();
    // Sanity check: a letter's 3 attempts legitimately share one task_order
    // and must NOT be flagged on their own (already implied by
    // completeSession() producing zero warnings above).
    session.shapeRows[1].task_order = session.shapeRows[0].task_order; // two different shapes, same order
    const warnings = validateSession(session);
    expect(warnings.some(w => w.includes('task_order reused by different tasks'))).toBe(true);
  });

  it('flags empty stroke_points and missing features on a row', () => {
    const session = completeSession();
    session.shapeRows[0].stroke_points = [];
    session.shapeRows[0].features = {};
    const warnings = validateSession(session);
    expect(warnings.some(w => w.includes('Empty stroke_points'))).toBe(true);
    expect(warnings.some(w => w.includes('Missing features'))).toBe(true);
  });

  it('flags duplicate task sessions (same letter+attempt submitted twice)', () => {
    const session = completeSession();
    session.lowercaseRows.push({ ...session.lowercaseRows[0] });
    const warnings = validateSession(session);
    expect(warnings.some(w => w.includes('Duplicate lowercase letter task session'))).toBe(true);
  });
});
