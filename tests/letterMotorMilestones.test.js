'use strict';

// Feature 11B Phase 5 — proves the 3 pilot milestones are composed of
// EXACTLY the letter/case pairs the spec names (§13/§14/§15), never a
// substitute count.

const {
  MILESTONE_UPPERCASE_STRAIGHT_14, MILESTONE_UPPERCASE_CURVED_17, MILESTONE_FULL_REFERENCE_20,
  MILESTONES,
} = require('../src/config/letterMotorMilestones');

function keySet(pairs) {
  return new Set(pairs.map(p => `${p.letter}|${p.caseType}`));
}

describe('MILESTONES — exact composition', () => {
  it('has exactly 3 milestones, in ascending coverage order', () => {
    expect(MILESTONES.map(m => m.code)).toEqual([
      MILESTONE_UPPERCASE_STRAIGHT_14, MILESTONE_UPPERCASE_CURVED_17, MILESTONE_FULL_REFERENCE_20,
    ]);
    expect(MILESTONES.map(m => m.coverageN)).toEqual([14, 17, 20]);
  });

  it('UPPERCASE_STRAIGHT_14 is exactly the spec-named 14 pairs', () => {
    const milestone = MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_STRAIGHT_14);
    expect(milestone.requiredPairs.length).toBe(14);
    const keys = keySet(milestone.requiredPairs);
    // lowercase: i,l,t,a,c,o,s,b,h,k
    for (const letter of ['i', 'l', 't', 'a', 'c', 'o', 's', 'b', 'h', 'k']) {
      expect(keys.has(`${letter}|lowercase`)).toBe(true);
    }
    // uppercase: H,I,L,T
    for (const letter of ['H', 'I', 'L', 'T']) {
      expect(keys.has(`${letter}|uppercase`)).toBe(true);
    }
    // explicitly NOT yet included
    for (const letter of ['C', 'O', 'S', 'A', 'B', 'K']) {
      expect(keys.has(`${letter}|uppercase`)).toBe(false);
    }
  });

  it('UPPERCASE_CURVED_17 = the 14-set + C, O, S (uppercase)', () => {
    const fourteen = MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_STRAIGHT_14);
    const seventeen = MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_CURVED_17);
    expect(seventeen.requiredPairs.length).toBe(17);

    const fourteenKeys = keySet(fourteen.requiredPairs);
    const seventeenKeys = keySet(seventeen.requiredPairs);
    for (const key of fourteenKeys) expect(seventeenKeys.has(key)).toBe(true); // superset

    for (const letter of ['C', 'O', 'S']) {
      expect(seventeenKeys.has(`${letter}|uppercase`)).toBe(true);
    }
    for (const letter of ['A', 'B', 'K']) {
      expect(seventeenKeys.has(`${letter}|uppercase`)).toBe(false);
    }
  });

  it('FULL_REFERENCE_20 = the 17-set + A, B, K (uppercase) = the complete 20-letter reference set', () => {
    const seventeen = MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_CURVED_17);
    const twenty = MILESTONES.find(m => m.code === MILESTONE_FULL_REFERENCE_20);
    expect(twenty.requiredPairs.length).toBe(20);

    const seventeenKeys = keySet(seventeen.requiredPairs);
    const twentyKeys = keySet(twenty.requiredPairs);
    for (const key of seventeenKeys) expect(twentyKeys.has(key)).toBe(true); // superset

    for (const letter of ['A', 'B', 'K']) {
      expect(twentyKeys.has(`${letter}|uppercase`)).toBe(true);
    }

    const { getReferenceLetterPairs } = require('../src/config/letterMotorReferenceLetters');
    const fullReferenceKeys = keySet(getReferenceLetterPairs());
    expect(twentyKeys).toEqual(fullReferenceKeys);
  });

  it('each milestone records the completedCategory that made it eligible', () => {
    expect(MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_STRAIGHT_14).completedCategory)
      .toEqual({ caseType: 'uppercase', category: 'straight' });
    expect(MILESTONES.find(m => m.code === MILESTONE_UPPERCASE_CURVED_17).completedCategory)
      .toEqual({ caseType: 'uppercase', category: 'curved' });
    expect(MILESTONES.find(m => m.code === MILESTONE_FULL_REFERENCE_20).completedCategory)
      .toEqual({ caseType: 'uppercase', category: 'mixed' });
  });
});
