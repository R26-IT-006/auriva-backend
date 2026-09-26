'use strict';

// Feature 9 Step 5 — dedicated tests for the additive
// `recommendationFingerprint` field on Feature 8's own
// evaluateWorksheetRecommendations() result. Mocks only
// persistentDifficultyService.js (same convention as
// worksheetRecommendationService.test.js) — the real
// worksheetRecommendationPolicy.js and feature9Provenance.js are used
// throughout, never mocked, so fingerprint values are independently
// cross-checked against the real provenance helpers.

const fs = require('fs');
const path = require('path');

const mockEvaluatePersistentDifficulty = jest.fn();

jest.mock('../src/services/persistentDifficultyService', () => ({
  evaluatePersistentDifficulty: (...a) => mockEvaluatePersistentDifficulty(...a),
}));

const { evaluateWorksheetRecommendations } = require('../src/services/worksheetRecommendationService');
const {
  computePersistentEvidenceFingerprint, computeWorksheetRecommendationFingerprint,
  PERSISTENT_DIFFICULTY_POLICY_VERSION, WORKSHEET_RECOMMENDATION_POLICY_VERSION,
} = require('../src/config/feature9Provenance');
const { MAPPING_VERSION } = require('../src/config/letterBaselineFamilies');

const SHA256_HEX = /^[a-f0-9]{64}$/;
const STUDENT_ID = 13;

function stream(overrides = {}) {
  return {
    caseType: 'lowercase', family: 'straight',
    status: 'insufficient_data', reason: 'insufficient_cycles',
    validCycleCount: 0, usableCycleCount: 0, windowSize: 5, requiredSeparationMs: 86400000,
    earlierWindow: null, recentWindow: null, separationMs: null,
    affectedLetters: [],
    ...overrides,
  };
}

function allInsufficientStreams() {
  return {
    lowercase: { straight: stream(), curved: stream({ family: 'curved' }), complex: stream({ family: 'complex' }) },
    uppercase: {
      straight: stream({ caseType: 'uppercase' }),
      curved: stream({ caseType: 'uppercase', family: 'curved' }),
      complex: stream({ caseType: 'uppercase', family: 'complex' }),
    },
  };
}

function feature7Result(overrides = {}) {
  return {
    status: 'evaluated', studentId: STUDENT_ID, evaluatedAt: '2026-08-14T00:00:00.000Z',
    streams: allInsufficientStreams(),
    summary: { evaluatedStreamCount: 6, persistentCount: 0, notPersistentCount: 0, insufficientDataCount: 6, persistentStreams: [] },
    ...overrides,
  };
}

const EARLIER_WINDOW = { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' };
const RECENT_WINDOW = { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-01-03T00:00:00.000Z', evidenceEnd: '2026-01-03T01:00:00.000Z' };
const AFFECTED_LETTERS = [{ letter: 'c', totalCycles: 6, failedCycles: 6 }, { letter: 'o', totalCycles: 4, failedCycles: 3 }];

const CURVED_PERSISTENT_STREAM = stream({
  family: 'curved', status: 'persistent', reason: 'repeated_difficulty_across_windows',
  validCycleCount: 10, usableCycleCount: 10,
  earlierWindow: EARLIER_WINDOW, recentWindow: RECENT_WINDOW, separationMs: 172800000,
  affectedLetters: AFFECTED_LETTERS,
});

function expectedEvidenceFingerprint({ caseType = 'lowercase', family = 'curved', earlierWindow = EARLIER_WINDOW, recentWindow = RECENT_WINDOW, affectedLetters = AFFECTED_LETTERS } = {}) {
  return computePersistentEvidenceFingerprint({
    studentId: STUDENT_ID, caseType, family, earlierWindow, recentWindow, affectedLetters,
    persistentPolicyVersion: PERSISTENT_DIFFICULTY_POLICY_VERSION, mappingVersion: MAPPING_VERSION,
  });
}

function expectedRecommendationFingerprint({ caseType = 'lowercase', family = 'curved', focusLetters = ['c', 'o'], evidenceFingerprint, recommendationPolicyVersion = WORKSHEET_RECOMMENDATION_POLICY_VERSION } = {}) {
  return computeWorksheetRecommendationFingerprint({
    studentId: STUDENT_ID, caseType, family, recommendationType: 'motor_family_practice', focusLetters,
    evidenceFingerprint: evidenceFingerprint ?? expectedEvidenceFingerprint({ caseType, family }),
    recommendationPolicyVersion,
  });
}

beforeEach(() => {
  mockEvaluatePersistentDifficulty.mockReset();
});

describe('1. persistent recommendation includes recommendationFingerprint', () => {
  it('the field is present on a real persistent recommendation', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    expect(result.recommendations[0].recommendationFingerprint).toBeDefined();
  });
});

describe('2. fingerprint is 64-char lowercase hex', () => {
  it('matches the SHA-256 hex shape', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    expect(result.recommendations[0].recommendationFingerprint).toMatch(SHA256_HEX);
  });
});

describe('3. same Feature 7 evidence -> same fingerprint', () => {
  it('two identical (deep-equal) evaluations produce identical fingerprints', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const first = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    const streams2 = allInsufficientStreams();
    streams2.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streams2 }));
    const second = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    expect(second.recommendations[0].recommendationFingerprint).toBe(first.recommendations[0].recommendationFingerprint);
    expect(first.recommendations[0].recommendationFingerprint).toBe(expectedRecommendationFingerprint());
  });
});

describe('4. evidence change -> different fingerprint', () => {
  it('a changed recentWindow.evidenceEnd changes the fingerprint', async () => {
    const streams1 = allInsufficientStreams();
    streams1.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streams1 }));
    const first = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    const streams2 = allInsufficientStreams();
    streams2.lowercase.curved = {
      ...CURVED_PERSISTENT_STREAM,
      recentWindow: { ...RECENT_WINDOW, evidenceEnd: '2026-01-03T05:00:00.000Z' },
    };
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streams2 }));
    const second = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    expect(second.recommendations[0].recommendationFingerprint).not.toBe(first.recommendations[0].recommendationFingerprint);
  });
});

describe('5. focus-letter change -> different fingerprint', () => {
  it('a changed affectedLetters set changes the fingerprint', async () => {
    const streams1 = allInsufficientStreams();
    streams1.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streams1 }));
    const first = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    const streams2 = allInsufficientStreams();
    streams2.lowercase.curved = { ...CURVED_PERSISTENT_STREAM, affectedLetters: [{ letter: 'c', totalCycles: 6, failedCycles: 6 }] };
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streams2 }));
    const second = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    expect(second.recommendations[0].recommendationFingerprint).not.toBe(first.recommendations[0].recommendationFingerprint);
    expect(second.recommendations[0].focusLetters).toEqual(['c']);
  });
});

describe('6. case change -> different fingerprint', () => {
  it('uppercase curved differs from lowercase curved even with identical letters/windows', async () => {
    const streamsLower = allInsufficientStreams();
    streamsLower.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streamsLower }));
    const lower = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    const streamsUpper = allInsufficientStreams();
    streamsUpper.uppercase.curved = { ...CURVED_PERSISTENT_STREAM, caseType: 'uppercase', affectedLetters: [{ letter: 'C', totalCycles: 6, failedCycles: 6 }, { letter: 'O', totalCycles: 4, failedCycles: 3 }] };
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streamsUpper }));
    const upper = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    expect(upper.recommendations[0].recommendationFingerprint).not.toBe(lower.recommendations[0].recommendationFingerprint);
  });
});

describe('7. family change -> different fingerprint', () => {
  it('straight differs from curved even with the same case/windows', async () => {
    const streamsCurved = allInsufficientStreams();
    streamsCurved.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streamsCurved }));
    const curved = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    const streamsStraight = allInsufficientStreams();
    streamsStraight.lowercase.straight = { ...CURVED_PERSISTENT_STREAM, family: 'straight', affectedLetters: [{ letter: 'l', totalCycles: 6, failedCycles: 6 }] };
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams: streamsStraight }));
    const straight = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    expect(straight.recommendations[0].recommendationFingerprint).not.toBe(curved.recommendations[0].recommendationFingerprint);
  });
});

describe('8. recommendation policy version contributes (trusted constant actually used)', () => {
  it('the service fingerprint matches an independent computation using the real WORKSHEET_RECOMMENDATION_POLICY_VERSION, and differs from one computed with a different version string', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });

    expect(result.recommendations[0].recommendationFingerprint).toBe(expectedRecommendationFingerprint());
    const withDifferentVersion = expectedRecommendationFingerprint({ recommendationPolicyVersion: 'worksheet_recommendation_v2' });
    expect(result.recommendations[0].recommendationFingerprint).not.toBe(withDifferentVersion);
  });
});

describe('9. Feature 7 still called exactly once', () => {
  it('fingerprint computation adds no second evaluatePersistentDifficulty call', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledTimes(1);
  });
});

describe('10. zero persistent -> zero recommendations', () => {
  it('no fingerprint is ever computed when nothing is persistent', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result());
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    expect(result.recommendations).toHaveLength(0);
  });
});

describe('11. no evidence fingerprint exposed', () => {
  it('the recommendation object never carries an evidenceFingerprint field', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    expect(result.recommendations[0].evidenceFingerprint).toBeUndefined();
    expect(Object.keys(result.recommendations[0])).not.toContain('evidenceFingerprint');
  });
});

describe('12. no policy versions exposed', () => {
  it('the recommendation object never carries persistentPolicyVersion/recommendationPolicyVersion/mappingVersion', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    const keys = Object.keys(result.recommendations[0]);
    expect(keys).not.toContain('persistentPolicyVersion');
    expect(keys).not.toContain('recommendationPolicyVersion');
    expect(keys).not.toContain('mappingVersion');
  });
});

describe('13. no windows exposed', () => {
  it('the recommendation object never carries earlierWindow/recentWindow', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    const keys = Object.keys(result.recommendations[0]);
    expect(keys).not.toContain('earlierWindow');
    expect(keys).not.toContain('recentWindow');
    expect(keys.sort()).toEqual([
      'caseType', 'family', 'focusLetters', 'rationale', 'recommendationFingerprint',
      'recommendationType', 'suggestedActivities', 'title',
    ].sort());
  });
});

describe('14. no teacher validation dependency', () => {
  it('worksheetRecommendationService.js never imports teacherRecommendationValidationService, the model, or any Feature 9 persistence concept', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/teacherRecommendationValidationService/);
    expect(requireLines).not.toMatch(/TeacherRecommendationValidation/);
    expect(requireLines).not.toMatch(/require\(['"]\.\.\/models['"]\)/);
  });

  it('the module only gains feature9Provenance.js and letterBaselineFamilies.js as new imports (fingerprint/version knowledge only)', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).toMatch(/feature9Provenance/);
    expect(requireLines).toMatch(/letterBaselineFamilies/);
  });
});

describe('15. existing recommendation content unchanged', () => {
  it('title/focusLetters/rationale/suggestedActivities/recommendationType/caseType/family are byte-identical to Feature 8\'s own pre-Step-5 content', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: STUDENT_ID });
    const { recommendationFingerprint, ...contentOnly } = result.recommendations[0];
    expect(contentOnly).toEqual({
      recommendationType: 'motor_family_practice',
      caseType: 'lowercase',
      family: 'curved',
      title: 'Curved Movement Practice',
      focusLetters: ['c', 'o'],
      rationale: 'Curved movement practice is recommended because difficulty remained across two separate practice periods. The pattern was observed in both the earlier and recent practice periods.',
      suggestedActivities: [
        'Circle tracing exercises',
        'Half-circle tracing with visual guides',
        'Slow curved-stroke repetition',
        'Guided tracing of focus letters',
        'Independent writing of focus letters',
      ],
    });
  });
});
