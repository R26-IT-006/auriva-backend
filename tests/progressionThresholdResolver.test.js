'use strict';

// Feature 2 final workflow integration — resolveProgressionThreshold().
// Mocks ../src/services/dynamicThresholdService (getCurrentFamilyThreshold +
// createInitialFamilyThresholds) — letterBaselineFamilies.js is used REAL/
// unmocked throughout, proving genuine mapping correctness against the
// actual reviewed mapping data, not a stand-in. This resolver no longer
// reads ../src/models (Student/personal_thresholds) at all — the legacy
// tier was removed entirely, so there is nothing to mock there anymore.
// PILOT NOTE: PROGRESSION_FAMILY_THRESHOLDS_ENABLED is currently `false` in
// production (see config/masteryPolicy.js) — while Motor Score calibration is
// outstanding, the resolver short-circuits to the pilot mastery threshold and
// the whole Feature 2 family branch below is bypassed at runtime.
//
// This suite deliberately forces the flag ON rather than deleting those tests.
// The family branch is not gone, it is switched off, and it WILL be switched
// back on once calibration is validated. Deleting its safety net now would
// mean re-enabling it later with no test coverage at all — exactly when
// coverage matters most. The disabled-path behaviour is covered separately in
// tests/progressionThresholdPilotPolicy.test.js.
jest.mock('../src/config/masteryPolicy', () => ({
  ...jest.requireActual('../src/config/masteryPolicy'),
  PROGRESSION_FAMILY_THRESHOLDS_ENABLED: true,
}));

const mockGetCurrentFamilyThreshold = jest.fn();
const mockCreateInitialFamilyThresholds = jest.fn();

jest.mock('../src/services/dynamicThresholdService', () => ({
  getCurrentFamilyThreshold: (...a) => mockGetCurrentFamilyThreshold(...a),
  createInitialFamilyThresholds: (...a) => mockCreateInitialFamilyThresholds(...a),
}));

const {
  resolveProgressionThreshold, GLOBAL_DEFAULT,
  SOURCE_REQUEST_OVERRIDE, SOURCE_FEATURE2_FAMILY, SOURCE_GLOBAL_SAFE_FALLBACK,
  FALLBACK_REASON_UNMAPPED_FAMILY, FALLBACK_REASON_NOT_YET_INITIALIZED, FALLBACK_REASON_READ_ERROR,
} = require('../src/services/progressionThresholdResolver');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Resolver 1 — explicit request threshold wins', () => {
  it('resolves to the request override, never consulting Feature 2', async () => {
    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase', requestedQualityThreshold: 75 });

    expect(result).toEqual({ status: 'resolved', threshold: 75, source: SOURCE_REQUEST_OVERRIDE, family: null, historyId: null, fallbackReason: null });
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
    expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
  });

  it('wins even with an invalid studentId — mirrors the exact original short-circuit', async () => {
    const result = await resolveProgressionThreshold({ studentId: -1, letter: 'c', caseType: 'lowercase', requestedQualityThreshold: 75 });
    expect(result.status).toBe('resolved');
    expect(result.threshold).toBe(75);
  });
});

describe('Resolver 2 — mapped family + initialized Feature 2 target (initial_from_baseline)', () => {
  it('resolves to the family target', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'found', currentThreshold: 88, sourceEvent: { historyId: 2, source: 'initial_from_baseline' } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result).toEqual({ status: 'resolved', threshold: 88, source: SOURCE_FEATURE2_FAMILY, family: 'curved', historyId: 2, fallbackReason: null });
    expect(mockGetCurrentFamilyThreshold).toHaveBeenCalledWith({ studentId: 13, family: 'curved' });
    expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
  });
});

describe('Resolver 3 — mapped family + automatic latest', () => {
  it('resolves to the automatic value', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'found', currentThreshold: 93, sourceEvent: { historyId: 5, source: 'automatic' } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'o', caseType: 'lowercase' });

    expect(result.threshold).toBe(93);
    expect(result.source).toBe(SOURCE_FEATURE2_FAMILY);
    expect(result.family).toBe('curved');
  });
});

describe('Resolver 4 — mapped family + teacher override latest', () => {
  it('resolves to the teacher value', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'found', currentThreshold: 85, sourceEvent: { historyId: 9, source: 'teacher_override' } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'O', caseType: 'uppercase' });

    expect(result.threshold).toBe(85);
    expect(result.source).toBe(SOURCE_FEATURE2_FAMILY);
    expect(result.family).toBe('curved');
  });
});

describe('Resolver 5 — mapped family, no Feature 2 target -> lazy repair succeeds (created)', () => {
  it('initializes Feature 2 inline and resolves to the freshly-created threshold, never a legacy value', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockCreateInitialFamilyThresholds.mockResolvedValueOnce({
      status: 'created', studentId: 13, baselineId: 1, baselineVersion: 'baseline-v1', mappingVersion: 'letter-baseline-family-v1', margin: 5,
      created: { curved: { status: 'created', historyId: 42, newThreshold: 92 } },
    });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result).toEqual({ status: 'resolved', threshold: 92, source: SOURCE_FEATURE2_FAMILY, family: 'curved', historyId: 42, fallbackReason: null });
    expect(mockCreateInitialFamilyThresholds).toHaveBeenCalledWith({ studentId: 13 });
  });
});

describe('Resolver 6 — mapped family, no Feature 2 target -> lazy repair resolves already_initialized', () => {
  it('a race with another concurrent request still resolves to the real threshold, never a duplicate/error', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockCreateInitialFamilyThresholds.mockResolvedValueOnce({
      status: 'already_initialized', studentId: 13, baselineId: 1, baselineVersion: 'baseline-v1', mappingVersion: 'letter-baseline-family-v1', margin: 5,
      created: { curved: { status: 'already_initialized', historyId: 42, newThreshold: 92 } },
    });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.threshold).toBe(92);
    expect(result.source).toBe(SOURCE_FEATURE2_FAMILY);
  });
});

describe('Resolver 7 — mapped family, no target, repair cannot yet produce one (no baseline) -> safe global fallback', () => {
  it('falls back to the global default, never a legacy individualized value', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockCreateInitialFamilyThresholds.mockResolvedValueOnce({
      status: 'baseline_not_found', studentId: 13, baselineId: null, baselineVersion: null, mappingVersion: 'letter-baseline-family-v1', margin: 5,
      created: null,
    });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.threshold).toBe(GLOBAL_DEFAULT);
    expect(result.threshold).toBe(55);
    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
    expect(result.fallbackReason).toBe(FALLBACK_REASON_NOT_YET_INITIALIZED);
    expect(result.family).toBe('curved'); // still reported, for traceability
  });

  it('a repair-requires_review family score also falls back to the safe global default', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockCreateInitialFamilyThresholds.mockResolvedValueOnce({
      status: 'no_eligible_families', studentId: 13, baselineId: 1, baselineVersion: 'baseline-v1', mappingVersion: 'letter-baseline-family-v1', margin: 5,
      created: { curved: { status: 'skipped_requires_review', reason: 'target_exceeds_score_range' } },
    });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.threshold).toBe(55);
    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
  });

  it('a repair service throw is caught, logged, and still falls back safely (never rejects the caller)', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockCreateInitialFamilyThresholds.mockRejectedValueOnce(new Error('DB down'));

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.status).toBe('resolved');
    expect(result.threshold).toBe(55);
    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
  });
});

describe('Resolver 8 — ambiguous letter -> safe global fallback, Feature 2 never consulted', () => {
  it('never calls getCurrentFamilyThreshold or createInitialFamilyThresholds for an unmapped letter', async () => {
    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'a', caseType: 'lowercase' });

    expect(result.family).toBeNull();
    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
    expect(result.fallbackReason).toBe(FALLBACK_REASON_UNMAPPED_FAMILY);
    expect(result.threshold).toBe(GLOBAL_DEFAULT);
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
    expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
  });
});

describe('Resolver 9 — lowercase y maps to complex', () => {
  it('is treated as a clean Feature 2 mapping', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'found', currentThreshold: 73, sourceEvent: { historyId: 3, source: 'initial_from_baseline' } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'y', caseType: 'lowercase' });

    expect(result.family).toBe('complex');
    expect(mockGetCurrentFamilyThreshold).toHaveBeenCalledWith({ studentId: 13, family: 'complex' });
  });
});

describe('Resolver 10 — uppercase Y is ambiguous -> safe fallback', () => {
  it('does NOT reuse lowercase y\'s clean mapping — case independence', async () => {
    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'Y', caseType: 'uppercase' });

    expect(result.family).toBeNull();
    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
  });
});

describe('Resolver 11 — invalid studentId', () => {
  it('rejects before any query', async () => {
    const result = await resolveProgressionThreshold({ studentId: -1, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
    expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0, 'abc', 1.5, NaN])('rejects studentId=%p', async (studentId) => {
    const result = await resolveProgressionThreshold({ studentId, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
  });
});

describe('Resolver 12 — invalid letter/case', () => {
  it('a malformed letter degrades gracefully to the safe fallback, never throws or rejects', async () => {
    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'zz', caseType: 'lowercase' });

    expect(result.status).toBe('resolved');
    expect(result.family).toBeNull();
    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
  });

  it('a malformed caseType also degrades gracefully — no Feature 2 mapping, no throw', async () => {
    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'bogus' });

    expect(result.status).toBe('resolved');
    expect(result.family).toBeNull();
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
  });
});

describe('Resolver 13 — Feature 2 DB read error (distinct from no_target — repair never attempted)', () => {
  it('a thrown error fails open to the safe global fallback, never rejects the caller, never attempts repair', async () => {
    mockGetCurrentFamilyThreshold.mockRejectedValueOnce(new Error('connection terminated'));

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.status).toBe('resolved');
    expect(result.threshold).toBe(55);
    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
    expect(result.fallbackReason).toBe(FALLBACK_REASON_READ_ERROR);
    expect(result.family).toBe('curved'); // still reports the mapped family, for traceability
    expect(mockCreateInitialFamilyThresholds).not.toHaveBeenCalled();
  });

  it('a read_failed status (not a throw) fails open the same explicit way', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'read_failed' });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.source).toBe(SOURCE_GLOBAL_SAFE_FALLBACK);
    expect(result.fallbackReason).toBe(FALLBACK_REASON_READ_ERROR);
    expect(result.threshold).toBe(55);
  });

  it('never silently reports a read failure as simply "no target" — the fallbackReason is always distinct', async () => {
    mockGetCurrentFamilyThreshold.mockRejectedValueOnce(new Error('timeout'));

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.fallbackReason).toBe(FALLBACK_REASON_READ_ERROR);
    expect(result.fallbackReason).not.toBe(FALLBACK_REASON_NOT_YET_INITIALIZED);
  });
});

describe('Resolver 14 — legacy tiers fully removed from exports', () => {
  it('no longer exports any legacy source constant', () => {
    const exported = require('../src/services/progressionThresholdResolver');
    expect(exported.SOURCE_LEGACY_LETTER).toBeUndefined();
    expect(exported.SOURCE_LEGACY_DEFAULT).toBeUndefined();
    expect(exported.SOURCE_GLOBAL_DEFAULT).toBeUndefined();
    expect(exported.SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR).toBeUndefined();
  });
});

describe('Resolver 15 — no independent Student/personal_thresholds dependency', () => {
  it('the resolver source never imports ../models or personal_thresholds', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/progressionThresholdResolver.js'), 'utf8');
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/personal_thresholds/);
    expect(withoutComments).not.toMatch(/require\(['"]\.\.\/models['"]\)/);
  });
});
