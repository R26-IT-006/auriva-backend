'use strict';

// Feature 2 Step 7 — resolveProgressionThreshold(). Mocks ../src/models
// (Student.findByPk) and ../src/services/dynamicThresholdService
// (getCurrentFamilyThreshold) — letterBaselineFamilies.js is used REAL/
// unmocked throughout, proving genuine mapping correctness against the
// actual reviewed mapping data, not a stand-in.
const mockStudentFindByPk = jest.fn();
const mockStudentCreate   = jest.fn();
const mockStudentUpdate   = jest.fn();
const mockStudentDestroy  = jest.fn();
const mockGetCurrentFamilyThreshold = jest.fn();

jest.mock('../src/models', () => ({
  Student: { findByPk: (...a) => mockStudentFindByPk(...a), create: mockStudentCreate, update: mockStudentUpdate, destroy: mockStudentDestroy },
}));

jest.mock('../src/services/dynamicThresholdService', () => ({
  getCurrentFamilyThreshold: (...a) => mockGetCurrentFamilyThreshold(...a),
}));

const {
  resolveProgressionThreshold, GLOBAL_DEFAULT,
  SOURCE_REQUEST_OVERRIDE, SOURCE_FEATURE2_FAMILY, SOURCE_LEGACY_LETTER,
  SOURCE_LEGACY_DEFAULT, SOURCE_GLOBAL_DEFAULT, SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR,
} = require('../src/services/progressionThresholdResolver');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Resolver 1 — explicit request threshold wins', () => {
  it('resolves to the request override, never consulting Feature 2 or legacy', async () => {
    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase', requestedQualityThreshold: 75 });

    expect(result).toEqual({ status: 'resolved', threshold: 75, source: SOURCE_REQUEST_OVERRIDE, family: null, historyId: null });
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
    expect(mockStudentFindByPk).not.toHaveBeenCalled();
  });

  it('wins even with an invalid studentId — mirrors the exact original short-circuit', async () => {
    const result = await resolveProgressionThreshold({ studentId: -1, letter: 'c', caseType: 'lowercase', requestedQualityThreshold: 75 });
    expect(result.status).toBe('resolved');
    expect(result.threshold).toBe(75);
  });
});

describe('Resolver 2 — mapped family + initialized Feature 2 target', () => {
  it('resolves to the family target (initial_from_baseline)', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'found', currentThreshold: 88, sourceEvent: { historyId: 2, source: 'initial_from_baseline' } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result).toEqual({ status: 'resolved', threshold: 88, source: SOURCE_FEATURE2_FAMILY, family: 'curved', historyId: 2 });
    expect(mockGetCurrentFamilyThreshold).toHaveBeenCalledWith({ studentId: 13, family: 'curved' });
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
  it('resolves to the teacher value — the first point a teacher override actually affects gating', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'found', currentThreshold: 85, sourceEvent: { historyId: 9, source: 'teacher_override' } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'O', caseType: 'uppercase' });

    expect(result.threshold).toBe(85);
    expect(result.source).toBe(SOURCE_FEATURE2_FAMILY);
    expect(result.family).toBe('curved');
  });
});

describe('Resolver 5 — mapped family, no Feature 2 target -> legacy per-letter', () => {
  it('falls back to personal_thresholds[letter], never auto-initializing a target', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: { c: 60 } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result).toEqual({ status: 'resolved', threshold: 60, source: SOURCE_LEGACY_LETTER, family: 'curved', historyId: null });
  });
});

describe('Resolver 6 — no per-letter override -> legacy default', () => {
  it('falls back to personal_thresholds.default', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: { default: 57 } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.threshold).toBe(57);
    expect(result.source).toBe(SOURCE_LEGACY_DEFAULT);
  });
});

describe('Resolver 7 — nothing set -> global 55', () => {
  it('falls all the way through to the global default', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.threshold).toBe(55);
    expect(result.threshold).toBe(GLOBAL_DEFAULT);
    expect(result.source).toBe(SOURCE_GLOBAL_DEFAULT);
  });
});

describe('Resolver 8 — ambiguous letter -> legacy, Feature 2 never consulted', () => {
  it('never calls getCurrentFamilyThreshold for an unmapped letter', async () => {
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'a', caseType: 'lowercase' });

    expect(result.family).toBeNull();
    expect(result.source).toBe(SOURCE_GLOBAL_DEFAULT);
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
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

describe('Resolver 10 — uppercase Y is ambiguous -> legacy fallback', () => {
  it('does NOT reuse lowercase y\'s clean mapping — case independence', async () => {
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'Y', caseType: 'uppercase' });

    expect(result.family).toBeNull();
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
  });
});

describe('Resolver 11 — invalid studentId', () => {
  it('rejects before any query', async () => {
    const result = await resolveProgressionThreshold({ studentId: -1, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
    expect(mockStudentFindByPk).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 0, 'abc', 1.5, NaN])('rejects studentId=%p', async (studentId) => {
    const result = await resolveProgressionThreshold({ studentId, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
  });
});

describe('Resolver 12 — invalid letter/case', () => {
  it('a malformed letter degrades gracefully to legacy fallback, never throws or rejects', async () => {
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'zz', caseType: 'lowercase' });

    expect(result.status).toBe('resolved');
    expect(result.family).toBeNull();
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
  });

  it('a malformed caseType also degrades gracefully — no Feature 2 mapping, no throw', async () => {
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'bogus' });

    expect(result.status).toBe('resolved');
    expect(result.family).toBeNull();
    expect(mockGetCurrentFamilyThreshold).not.toHaveBeenCalled();
  });
});

describe('Resolver 13 — Feature 2 DB read error', () => {
  it('a thrown error fails open to legacy with the distinct fail-open source, never rejects the caller', async () => {
    mockGetCurrentFamilyThreshold.mockRejectedValueOnce(new Error('connection terminated'));
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: { c: 60 } });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.status).toBe('resolved');
    expect(result.threshold).toBe(60);
    expect(result.source).toBe(SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR);
    expect(result.family).toBe('curved'); // still reports the mapped family, for traceability
  });

  it('a read_failed status (not a throw) fails open the same explicit way', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'read_failed' });
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.source).toBe(SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR);
    expect(result.threshold).toBe(55);
  });

  it('never silently reports a read failure as simply "no target" — the source string is always distinct', async () => {
    mockGetCurrentFamilyThreshold.mockRejectedValueOnce(new Error('timeout'));
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    const result = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(result.source).not.toBe(SOURCE_LEGACY_LETTER);
    expect(result.source).not.toBe(SOURCE_LEGACY_DEFAULT);
    expect(result.source).not.toBe(SOURCE_GLOBAL_DEFAULT);
    expect(result.source).toBe(SOURCE_LEGACY_FALLBACK_FEATURE2_ERROR);
  });
});

describe('Resolver 14 — no writes', () => {
  it('never calls Student.create/update/destroy, regardless of outcome', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'found', currentThreshold: 88, sourceEvent: { historyId: 2, source: 'initial_from_baseline' } });

    await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(mockStudentCreate).not.toHaveBeenCalled();
    expect(mockStudentUpdate).not.toHaveBeenCalled();
    expect(mockStudentDestroy).not.toHaveBeenCalled();
  });

  it('never calls Student.create/update/destroy on the legacy-fallback path either', async () => {
    mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
    mockStudentFindByPk.mockResolvedValueOnce({ personal_thresholds: {} });

    await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(mockStudentUpdate).not.toHaveBeenCalled();
  });
});

// ─── Bonus — parity with thresholdUtils.getStudentThreshold's own logic ───

describe('legacy-tier parity with thresholdUtils.getStudentThreshold', () => {
  it('produces the identical numeric result for a range of personal_thresholds fixtures', async () => {
    // Re-requires getStudentThreshold against the SAME mocked ../src/models
    // as this file — proving the resolver's own re-implemented 3-tier
    // legacy logic never diverges from the real, unmodified utility.
    const { getStudentThreshold } = require('../src/utils/thresholdUtils');

    const fixtures = [
      { personal_thresholds: {} },
      { personal_thresholds: { default: 60 } },
      { personal_thresholds: { c: 70 } },
      { personal_thresholds: { c: 70, default: 60 } },
    ];

    for (const fixture of fixtures) {
      mockGetCurrentFamilyThreshold.mockResolvedValueOnce({ status: 'no_target' });
      mockStudentFindByPk.mockResolvedValueOnce(fixture);
      const resolverResult = await resolveProgressionThreshold({ studentId: 13, letter: 'c', caseType: 'lowercase' });

      mockStudentFindByPk.mockResolvedValueOnce(fixture);
      const legacyResult = await getStudentThreshold(13, 'c');

      expect(resolverResult.threshold).toBe(legacyResult);
    }
  });
});
