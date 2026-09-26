'use strict';

const { classifyTabsStatus, evaluateRow } = require('../scripts/backfillAttemptDurationFeatures');

describe('classifyTabsStatus', () => {
  it('NO_TRAJECTORY: null, empty array, or every stroke empty', () => {
    expect(classifyTabsStatus(null)).toBe('NO_TRAJECTORY');
    expect(classifyTabsStatus([])).toBe('NO_TRAJECTORY');
    expect(classifyTabsStatus([{ stroke_id: 1, points: [] }])).toBe('NO_TRAJECTORY');
  });

  it('MISSING_TABS: points exist but none carry a finite tAbs', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0 }, { x: 1, y: 1, t: 100 }] }];
    expect(classifyTabsStatus(strokePoints)).toBe('MISSING_TABS');
  });

  it('INSUFFICIENT_TIMESTAMPS: only one point has a valid tAbs', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 1000 }, { x: 1, y: 1, t: 100 }] }];
    expect(classifyTabsStatus(strokePoints)).toBe('INSUFFICIENT_TIMESTAMPS');
  });

  it('INVALID_ORDERING: >= 2 valid tAbs but max <= min (degenerate)', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 1000 }, { x: 1, y: 1, t: 0, tAbs: 1000 }] }];
    expect(classifyTabsStatus(strokePoints)).toBe('INVALID_ORDERING');
  });

  it('VALID: >= 2 distinct valid tAbs values', () => {
    const strokePoints = [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 1000 }, { x: 1, y: 1, t: 100, tAbs: 1500 }] }];
    expect(classifyTabsStatus(strokePoints)).toBe('VALID');
  });

  it('VALID: multi-stroke, tAbs monotonic across strokes', () => {
    const strokePoints = [
      { stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 100000 }, { x: 1, y: 1, t: 900, tAbs: 100900 }] },
      { stroke_id: 2, points: [{ x: 2, y: 2, t: 0, tAbs: 101100 }, { x: 3, y: 3, t: 650, tAbs: 101750 }] },
    ];
    expect(classifyTabsStatus(strokePoints)).toBe('VALID');
  });
});

describe('evaluateRow — tabsStatus and status agree with the underlying plan', () => {
  it('a row with VALID tAbs that also has other missing fields is WOULD_UPDATE, not a tabs-skip status', () => {
    const row = {
      id: 1, student_id: 5, letter: 'a', case_type: 'lowercase',
      features: { completionTime: 500 },
      stroke_points: [{ stroke_id: 1, points: [{ x: 0, y: 0, t: 0, tAbs: 1000 }, { x: 1, y: 1, t: 500, tAbs: 1500 }] }],
      normalized_features: null,
      motor_score: null,
    };
    const result = evaluateRow(row, 'letter');
    expect(result.tabsStatus).toBe('VALID');
    expect(result.status).toBe('WOULD_UPDATE');
    expect(result.changedFields).toEqual(expect.arrayContaining(['attempt_duration_ms']));
  });

  it('a row with no trajectory is reported as SKIPPED_TABS_NO_TRAJECTORY when nothing else is derivable', () => {
    const row = {
      id: 2, student_id: 5, letter: 'b', case_type: 'lowercase',
      features: null,
      stroke_points: [],
      normalized_features: null,
      motor_score: null,
    };
    const result = evaluateRow(row, 'letter');
    expect(result.tabsStatus).toBe('NO_TRAJECTORY');
    expect(result.status).toBe('SKIPPED_TABS_NO_TRAJECTORY');
  });
});
