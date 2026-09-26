'use strict';

// Feature 8 Step 3 — evaluateWorksheetRecommendations() composition-logic
// tests. Mocks persistentDifficultyService.js directly (already
// exhaustively tested in Feature 7's own suites) so this file proves ONLY
// the composition/orchestration logic this service adds — the REAL
// worksheetRecommendationPolicy.js is used throughout (never mocked), which
// is exactly the §53/§54/§55 "composition test" setup the spec asks for.

const mockEvaluatePersistentDifficulty = jest.fn();

jest.mock('../src/services/persistentDifficultyService', () => ({
  evaluatePersistentDifficulty: (...a) => mockEvaluatePersistentDifficulty(...a),
}));

const { evaluateWorksheetRecommendations } = require('../src/services/worksheetRecommendationService');

beforeEach(() => {
  mockEvaluatePersistentDifficulty.mockReset();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

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
    status: 'evaluated', studentId: 13, evaluatedAt: '2026-08-14T00:00:00.000Z',
    streams: allInsufficientStreams(),
    summary: { evaluatedStreamCount: 6, persistentCount: 0, notPersistentCount: 0, insufficientDataCount: 6, persistentStreams: [] },
    ...overrides,
  };
}

const CURVED_PERSISTENT_STREAM = stream({
  family: 'curved', status: 'persistent', reason: 'repeated_difficulty_across_windows',
  validCycleCount: 10, usableCycleCount: 10,
  earlierWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' },
  recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-01-03T00:00:00.000Z', evidenceEnd: '2026-01-03T01:00:00.000Z' },
  separationMs: 172800000,
  affectedLetters: [{ letter: 'c', totalCycles: 6, failedCycles: 6 }, { letter: 'o', totalCycles: 4, failedCycles: 3 }],
});

// ─── Item 1/2 — invalid student id ──────────────────────────────────────────

describe('Item 1 — invalid student id -> invalid_input', () => {
  it.each([-1, 0, 1.5, 'abc', null, undefined])('studentId=%p -> invalid_input', async (bad) => {
    const result = await evaluateWorksheetRecommendations({ studentId: bad });
    expect(result.status).toBe('invalid_input');
    expect(result.recommendations).toBeNull();
    expect(result.summary).toBeNull();
  });
});

describe('Item 2 — Feature 7 not called for invalid input', () => {
  it('evaluatePersistentDifficulty is never invoked when studentId is invalid', async () => {
    await evaluateWorksheetRecommendations({ studentId: -1 });
    expect(mockEvaluatePersistentDifficulty).not.toHaveBeenCalled();
  });
});

// ─── Item 3 — Feature 7 called exactly once ────────────────────────────────

describe('Item 3 — Feature 7 called exactly once', () => {
  it('evaluatePersistentDifficulty is invoked exactly once per evaluation', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result());
    await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledTimes(1);
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledWith({ studentId: 13 });
  });
});

// ─── Item 4/5 — Feature 7 read_failed / invalid_input propagation ─────────

describe('Item 4 — Feature 7 read_failed propagated', () => {
  it('Feature 8 becomes read_failed, never a fabricated empty recommendation list', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, evaluatedAt: null, streams: null, summary: null });
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expect(result.recommendations).toBeNull();
    expect(result.summary).toBeNull();
  });

  it('an unexpected thrown error is caught, not propagated — result is read_failed', async () => {
    mockEvaluatePersistentDifficulty.mockRejectedValueOnce(new Error('boom'));
    await expect(evaluateWorksheetRecommendations({ studentId: 13 })).resolves.toMatchObject({ status: 'read_failed' });
  });
});

describe('Item 5 — Feature 7 invalid_input propagated', () => {
  it('a defensive invalid_input from Feature 7 propagates as Feature 8 invalid_input', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce({ status: 'invalid_input', studentId: null, evaluatedAt: null, streams: null, summary: null });
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.status).toBe('invalid_input');
    expect(result.recommendations).toBeNull();
    expect(result.summary).toBeNull();
  });
});

// ─── Item 6/7 — zero recommendations ───────────────────────────────────────

describe('Item 6 — six insufficient -> zero recommendations', () => {
  it('recommendationCount=0, insufficientDataCount=6, notPersistentCount=0', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result());
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations).toEqual([]);
    expect(result.summary).toEqual({
      evaluatedStreamCount: 6, persistentStreamCount: 0, notPersistentCount: 0, insufficientDataCount: 6, recommendationCount: 0,
    });
  });
});

describe('Item 7 — six not_persistent -> zero recommendations', () => {
  it('recommendationCount=0, notPersistentCount=6, insufficientDataCount=0', async () => {
    const streams = allInsufficientStreams();
    for (const caseType of ['lowercase', 'uppercase']) {
      for (const family of ['straight', 'curved', 'complex']) {
        streams[caseType][family] = stream({ caseType, family, status: 'not_persistent', reason: 'no_persistent_difficulty' });
      }
    }
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations).toEqual([]);
    expect(result.summary).toEqual({
      evaluatedStreamCount: 6, persistentStreamCount: 0, notPersistentCount: 6, insufficientDataCount: 0, recommendationCount: 0,
    });
  });
});

// ─── Item 8/9 — one/two persistent streams ─────────────────────────────────

describe('Item 8 — one persistent -> one recommendation', () => {
  it('lowercase curved persistent produces exactly one recommendation', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      recommendationType: 'motor_family_practice', caseType: 'lowercase', family: 'curved',
      title: 'Curved Movement Practice', focusLetters: ['c', 'o'],
    });
    expect(result.summary.recommendationCount).toBe(1);
    expect(result.summary.persistentStreamCount).toBe(1);
  });
});

describe('Item 9 — two persistent -> two recommendations', () => {
  it('lowercase curved + uppercase straight both persistent -> two recommendations, no contamination', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    streams.uppercase.straight = stream({
      caseType: 'uppercase', family: 'straight', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-02-01T00:00:00.000Z', evidenceEnd: '2026-02-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-02-03T00:00:00.000Z', evidenceEnd: '2026-02-03T01:00:00.000Z' },
      separationMs: 200000000,
      affectedLetters: [{ letter: 'I', totalCycles: 5, failedCycles: 5 }],
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations).toHaveLength(2);
    expect(result.summary.recommendationCount).toBe(2);
    expect(result.summary.persistentStreamCount).toBe(2);
    // No contamination: the curved recommendation never carries 'I', the
    // straight recommendation never carries 'c'/'o'.
    expect(result.recommendations[0].focusLetters).toEqual(['c', 'o']);
    expect(result.recommendations[1].focusLetters).toEqual(['I']);
  });
});

// ─── Item 10 — deterministic stream order ──────────────────────────────────

describe('Item 10 — deterministic stream order', () => {
  it('recommendations appear in lowercase-then-uppercase, straight-curved-complex order, never sorted by failedCycles', async () => {
    const streams = allInsufficientStreams();
    // Deliberately give the LATER-ordered stream a higher failedCycles
    // count, to prove ordering is NOT severity-based.
    streams.lowercase.complex = stream({
      family: 'complex', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-03-01T00:00:00.000Z', evidenceEnd: '2026-03-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-03-03T00:00:00.000Z', evidenceEnd: '2026-03-03T01:00:00.000Z' },
      affectedLetters: [{ letter: 's', totalCycles: 10, failedCycles: 10 }], // most failures
    });
    streams.lowercase.straight = stream({
      family: 'straight', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-03-01T00:00:00.000Z', evidenceEnd: '2026-03-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-03-03T00:00:00.000Z', evidenceEnd: '2026-03-03T01:00:00.000Z' },
      affectedLetters: [{ letter: 'l', totalCycles: 2, failedCycles: 1 }], // fewest failures
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    // straight (index 0 in FAMILIES) must appear before complex (index 2),
    // even though complex has far more failures.
    expect(result.recommendations.map((r) => r.family)).toEqual(['straight', 'complex']);
  });
});

// ─── Item 11 — focusLetters preserved ──────────────────────────────────────

describe('Item 11 — focusLetters preserved exactly as Feature 7 provided', () => {
  it('order and content match affectedLetters exactly', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = { ...CURVED_PERSISTENT_STREAM, affectedLetters: [{ letter: 'o', totalCycles: 4, failedCycles: 3 }, { letter: 'c', totalCycles: 6, failedCycles: 6 }] };
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations[0].focusLetters).toEqual(['o', 'c']); // NOT re-sorted to ['c','o']
  });
});

// ─── Item 12 — case preserved ───────────────────────────────────────────────

describe('Item 12 — case preserved', () => {
  it('uppercase C/O stay uppercase in the recommendation', async () => {
    const streams = allInsufficientStreams();
    streams.uppercase.curved = stream({
      caseType: 'uppercase', family: 'curved', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-04-01T00:00:00.000Z', evidenceEnd: '2026-04-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-04-03T00:00:00.000Z', evidenceEnd: '2026-04-03T01:00:00.000Z' },
      affectedLetters: [{ letter: 'C', totalCycles: 5, failedCycles: 5 }, { letter: 'O', totalCycles: 3, failedCycles: 2 }],
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations[0].caseType).toBe('uppercase');
    expect(result.recommendations[0].focusLetters).toEqual(['C', 'O']);
  });
});

// ─── Item 13 — complex only uses live focus letters ────────────────────────

describe('Item 13 — complex family only uses live focus letters, never a static list', () => {
  it('affectedLetters=[s] never expands to [s,v,w,x,y]', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.complex = stream({
      family: 'complex', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-05-01T00:00:00.000Z', evidenceEnd: '2026-05-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-05-03T00:00:00.000Z', evidenceEnd: '2026-05-03T01:00:00.000Z' },
      affectedLetters: [{ letter: 's', totalCycles: 5, failedCycles: 5 }],
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations[0].focusLetters).toEqual(['s']);
  });
});

// ─── Item 14 — builder called only for persistent streams ─────────────────

describe('Item 14 — builder invoked only for persistent streams', () => {
  it('insufficient_data and not_persistent streams never produce a recommendation object', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    streams.uppercase.complex = stream({ caseType: 'uppercase', family: 'complex', status: 'not_persistent', reason: 'no_persistent_difficulty' });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations.every((r) => r.family === 'curved')).toBe(true);
  });
});

// ─── Item 15 — malformed builder null safely skipped ───────────────────────

describe('Item 15 — a malformed persistent stream (invalid family) is safely skipped, never crashes the evaluation', () => {
  it('a stream with an unrecognized family never aborts the whole request', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    // Simulate a structurally malformed persistent stream (should never
    // happen from a real Feature 7 result, but the service must not crash).
    streams.uppercase.straight = stream({ caseType: 'uppercase', family: 'diagonal', status: 'persistent', reason: 'repeated_difficulty_across_windows' });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.status).toBe('evaluated');
    expect(result.recommendations).toHaveLength(1); // only the valid curved one
  });
});

// ─── Item 16 — summary counts correct ──────────────────────────────────────

describe('Item 16 — summary counts correct across a mixed evaluation', () => {
  it('1 persistent + 1 not_persistent + 4 insufficient tallies correctly', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    streams.uppercase.complex = stream({ caseType: 'uppercase', family: 'complex', status: 'not_persistent', reason: 'recent_improvement' });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.summary).toEqual({
      evaluatedStreamCount: 6, persistentStreamCount: 1, notPersistentCount: 1, insufficientDataCount: 4, recommendationCount: 1,
    });
  });
});

// ─── Item 17 — Feature 7 evaluatedAt reused ────────────────────────────────

describe('Item 17 — Feature 7 evaluatedAt reused verbatim', () => {
  it('Feature 8\'s evaluatedAt equals Feature 7\'s own timestamp exactly', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ evaluatedAt: '2026-05-05T05:05:05.000Z' }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.evaluatedAt).toBe('2026-05-05T05:05:05.000Z');
  });
});

// ─── Item 18 — no raw diagnostics leaked ───────────────────────────────────

describe('Item 18 — no raw Feature 7 diagnostics leaked into recommendation objects', () => {
  it('a recommendation object never contains separationMs/windowSize/validCycleCount/session keys', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    const blob = JSON.stringify(result.recommendations[0]);
    expect(blob).not.toMatch(/separationMs|windowSize|validCycleCount|usableCycleCount|session_key|sessionKey|attemptId/i);
  });
});

// ─── Item 19 — no direct DB imports ─────────────────────────────────────────

describe('Item 19 — no direct DB imports', () => {
  it('the service file never imports ../models', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/\.\.\/models/);
  });
});

// ─── Item 20 — no Features 1-6 imports ─────────────────────────────────────

describe('Item 20 — no Features 1-6 service imports', () => {
  it('the service file never imports Feature 1-6 services', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    const requireLines = source.split('\n').filter((l) => /require\(/.test(l)).join('\n');
    expect(requireLines).not.toMatch(/StudentMotorBaseline|dynamicThresholdService|adaptiveSupportService|adaptivePreWritingService|repetitionRecommendationService|demoSpeedRecommendationService/);
  });

  it('the only adaptive-input dependency is persistentDifficultyService + worksheetRecommendationPolicy', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    expect(source).toMatch(/require\(['"]\.\/persistentDifficultyService['"]\)/);
    expect(source).toMatch(/require\(['"]\.\.\/config\/worksheetRecommendationPolicy['"]\)/);
  });
});

// ─── Item 21 — no writes (source-scan; full model-mocked proof separately) ─

describe('Item 21 — no writes (source-scan)', () => {
  it('the service file (comment-stripped) never references a write method', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/worksheetRecommendationService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/\.create\(|\.bulkCreate\(|\.update\(|\.destroy\(|\.increment\(|\.findOrCreate\(|\.save\(|transaction\(/);
  });
});

// ─── Item 22 — deterministic same input ────────────────────────────────────

describe('Item 22 — deterministic: same input -> same output', () => {
  it('calling the service twice with identical (deep-equal, distinct-reference) Feature 7 results yields identical output, ignoring nothing (evaluatedAt is reused from Feature 7, not freshly generated)', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result());
    const first = await evaluateWorksheetRecommendations({ studentId: 13 });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result());
    const second = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(first).toEqual(second);
  });
});

// ─── §53 — full composition test (real policy, mocked Feature 7) ─────────

describe('§53 — full composition test: lowercase curved persistent, c/o affected', () => {
  it('produces the exact documented recommendation', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations[0]).toEqual({
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
      // Feature 9 Step 5 — additive provenance field only (spec §10/§12).
      recommendationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});

// ─── §54 — multiple-stream composition test ────────────────────────────────

describe('§54 — multiple-stream composition test: lowercase curved + uppercase straight persistent', () => {
  it('produces exactly 2 recommendations with zero cross-stream contamination', async () => {
    const streams = allInsufficientStreams();
    streams.lowercase.curved = CURVED_PERSISTENT_STREAM;
    streams.uppercase.straight = stream({
      caseType: 'uppercase', family: 'straight', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-06-01T00:00:00.000Z', evidenceEnd: '2026-06-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-06-03T00:00:00.000Z', evidenceEnd: '2026-06-03T01:00:00.000Z' },
      affectedLetters: [{ letter: 'T', totalCycles: 5, failedCycles: 5 }],
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(feature7Result({ streams }));
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations[0].family).toBe('curved');
    expect(result.recommendations[1].family).toBe('straight');
    expect(result.recommendations[1].title).toBe('Straight Movement Practice');
    expect(result.recommendations[1].focusLetters).toEqual(['T']);
  });
});

// ─── §55 — Feature 7 read failure integration test ─────────────────────────

describe('§55 — Feature 7 read failure integration test', () => {
  it('Feature 8 -> read_failed, recommendations=null, summary=null', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, evaluatedAt: null, streams: null, summary: null });
    const result = await evaluateWorksheetRecommendations({ studentId: 13 });
    expect(result).toEqual({ status: 'read_failed', studentId: 13, evaluatedAt: null, recommendations: null, summary: null });
  });
});
