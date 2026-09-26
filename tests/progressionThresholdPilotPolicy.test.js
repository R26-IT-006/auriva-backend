'use strict';

// The PILOT threshold path — what resolveProgressionThreshold does while
// PROGRESSION_FAMILY_THRESHOLDS_ENABLED is false (its production value).
//
// The companion suite, tests/progressionThresholdResolver.test.js, forces the
// flag ON and keeps the full Feature 2 family-branch safety net alive for the
// day it is re-enabled. This one covers the behaviour that is actually live.

const mockGetCurrentFamilyThreshold = jest.fn();
const mockCreateInitialFamilyThresholds = jest.fn();

jest.mock('../src/services/dynamicThresholdService', () => ({
  getCurrentFamilyThreshold: (...a) => mockGetCurrentFamilyThreshold(...a),
  createInitialFamilyThresholds: (...a) => mockCreateInitialFamilyThresholds(...a),
}));

const {
  resolveProgressionThreshold, GLOBAL_DEFAULT,
  SOURCE_REQUEST_OVERRIDE, SOURCE_NORMAL_PRACTICE_PILOT,
  FALLBACK_REASON_FAMILY_DISABLED,
} = require('../src/services/progressionThresholdResolver');
const {
  NORMAL_PRACTICE_MASTERY_THRESHOLD, PROGRESSION_FAMILY_THRESHOLDS_ENABLED,
} = require('../src/config/masteryPolicy');

beforeEach(() => { jest.clearAllMocks(); });

describe('the flag under test is genuinely off in production config', () => {
  it('PROGRESSION_FAMILY_THRESHOLDS_ENABLED is false', () => {
    // If this ever flips, this whole suite is describing dead behaviour and
    // the companion suite becomes the live one. Fail loudly rather than
    // silently testing nothing.
    expect(PROGRESSION_FAMILY_THRESHOLDS_ENABLED).toBe(false);
  });
});

describe('every normal-practice letter resolves to the pilot threshold', () => {
  it.each([
    ['l', 'lowercase', 'straight'],
    ['c', 'lowercase', 'curved'],
    ['s', 'lowercase', 'complex'],
    ['E', 'uppercase', 'straight'],
    ['O', 'uppercase', 'curved'],
    ['V', 'uppercase', 'complex'],
  ])('%s/%s (mapped to %s) -> 70', async (letter, caseType, family) => {
    const r = await resolveProgressionThreshold({ studentId: 13, letter, caseType });
    expect(r.status).toBe('resolved');
    expect(r.threshold).toBe(NORMAL_PRACTICE_MASTERY_THRESHOLD);
    expect(r.source).toBe(SOURCE_NORMAL_PRACTICE_PILOT);
    expect(r.fallbackReason).toBe(FALLBACK_REASON_FAMILY_DISABLED);
    // The family is still REPORTED — reports and diagnostics keep working.
    expect(r.family).toBe(family);
  });

  it('an AMBIGUOUS (unmapped) letter gets the same threshold as a mapped one', async () => {
    // 28 of the 52 letter forms have no baseline family, by design. With the
    // family branch disabled, that distinction stops affecting mastery at
    // all — every letter is judged against the same pilot value.
    const mapped   = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    const unmapped = await resolveProgressionThreshold({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(unmapped.family).toBeNull();
    expect(unmapped.threshold).toBe(mapped.threshold);
    expect(unmapped.threshold).toBe(NORMAL_PRACTICE_MASTERY_THRESHOLD);
  });

  it('never consults Feature 2 while disabled — no DB read, no lazy repair', async () => {
    await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
    expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
  });
});

describe('the pilot threshold is not the old global fallback', () => {
  it('resolves to 70, and GLOBAL_DEFAULT is still 55 and untouched', async () => {
    const r = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(GLOBAL_DEFAULT).toBe(55);
    expect(r.threshold).toBe(70);
    expect(r.threshold).not.toBe(GLOBAL_DEFAULT);
  });

  it('reports its own source, never mislabelled as a safe fallback', async () => {
    const r = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(r.source).toBe('normal_practice_pilot');
    expect(r.source).not.toBe('global_safe_fallback');
  });
});

describe('a teacher override still outranks the pilot default', () => {
  it('an explicit requested threshold wins', async () => {
    const r = await resolveProgressionThreshold({
      studentId: 13, letter: 'c', caseType: 'lowercase', requestedQualityThreshold: 88,
    });
    expect(r.threshold).toBe(88);
    expect(r.source).toBe(SOURCE_REQUEST_OVERRIDE);
  });

  it('including an override BELOW the pilot value — a human decision is not overruled', async () => {
    const r = await resolveProgressionThreshold({
      studentId: 13, letter: 'c', caseType: 'lowercase', requestedQualityThreshold: 60,
    });
    expect(r.threshold).toBe(60);
  });
});

describe('input validation is unchanged', () => {
  it('an invalid studentId is still rejected before any policy applies', async () => {
    const r = await resolveProgressionThreshold({ studentId: 0, letter: 'c', caseType: 'lowercase' });
    expect(r.status).toBe('invalid_input');
    expect(r.threshold).toBeNull();
  });

  it('a malformed letter degrades to the pilot threshold rather than throwing', async () => {
    const r = await resolveProgressionThreshold({ studentId: 13, letter: '@@', caseType: 'lowercase' });
    expect(r.status).toBe('resolved');
    expect(r.threshold).toBe(NORMAL_PRACTICE_MASTERY_THRESHOLD);
    expect(r.family).toBeNull();
  });
});
