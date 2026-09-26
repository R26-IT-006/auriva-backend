'use strict';

// Feature 7 Step 3 — evaluatePersistentDifficulty() composition-logic
// tests. Mocks persistentDifficultyEvidence.js entirely (already
// exhaustively tested in Step 2) so this file proves ONLY the
// orchestration/serialization logic this service itself adds: one fetch,
// six streams, isolation, summary counts, affectedLetters/timestamp/
// separationMs pass-through, and independence from Features 2-6.

const mockFetchCandidateCycles = jest.fn();
const mockBuildFamilyCaseEvidence = jest.fn();
const mockSplitLongitudinalWindows = jest.fn();
const mockEvaluatePersistentDifficultyWindows = jest.fn();
const mockSummarizeAffectedLetters = jest.fn();

jest.mock('../src/services/persistentDifficultyEvidence', () => ({
  fetchCandidateCycles: (...a) => mockFetchCandidateCycles(...a),
  buildFamilyCaseEvidence: (...a) => mockBuildFamilyCaseEvidence(...a),
  splitLongitudinalWindows: (...a) => mockSplitLongitudinalWindows(...a),
  evaluatePersistentDifficultyWindows: (...a) => mockEvaluatePersistentDifficultyWindows(...a),
  summarizeAffectedLetters: (...a) => mockSummarizeAffectedLetters(...a),
}));

const { evaluatePersistentDifficulty } = require('../src/services/persistentDifficultyService');
const { PERSISTENT_DIFFICULTY_STATUSES, PERSISTENT_DIFFICULTY_REASONS } = require('../src/config/persistentDifficultyPolicy');

beforeEach(() => {
  mockFetchCandidateCycles.mockReset();
  mockBuildFamilyCaseEvidence.mockReset();
  mockSplitLongitudinalWindows.mockReset();
  mockEvaluatePersistentDifficultyWindows.mockReset();
  mockSummarizeAffectedLetters.mockReset();
});

// ─── Test 11 — invalid student ─────────────────────────────────────────────

describe('Test 11 — invalid student', () => {
  it.each([-1, 0, 1.5, 'abc', null, undefined])('studentId=%p -> invalid_input, zero reads', async (bad) => {
    const result = await evaluatePersistentDifficulty({ studentId: bad });
    expect(result.status).toBe('invalid_input');
    expect(result.streams).toBeNull();
    expect(result.summary).toBeNull();
    expect(mockFetchCandidateCycles).not.toHaveBeenCalled();
  });
});

// ─── Test 12 — one DB fetch ─────────────────────────────────────────────────

describe('Test 12 — one DB fetch', () => {
  it('fetchCandidateCycles is called exactly once per evaluation, regardless of six streams', async () => {
    mockFetchCandidateCycles.mockResolvedValueOnce({ status: 'found', studentId: 13, rows: [] });
    mockBuildFamilyCaseEvidence.mockReturnValue({ cycles: [], duplicateCount: 0, ambiguousExcludedCount: 0, otherCaseExcludedCount: 0, nonCandidateExcludedCount: 0 });
    mockSplitLongitudinalWindows.mockReturnValue({ status: 'insufficient', usableCount: 0, unknownCount: 0, earlierWindow: null, recentWindow: null });
    mockSummarizeAffectedLetters.mockReturnValue({});

    await evaluatePersistentDifficulty({ studentId: 13 });
    expect(mockFetchCandidateCycles).toHaveBeenCalledTimes(1);
    expect(mockFetchCandidateCycles).toHaveBeenCalledWith({ studentId: 13 });
  });
});

// ─── Test 13/14/15 — exactly six streams, isolated, all three families ────

const STREAM_KEYS = [
  'lowercase:straight', 'lowercase:curved', 'lowercase:complex',
  'uppercase:straight', 'uppercase:curved', 'uppercase:complex',
];

/** Wires the evidence mocks so each of the six streams is independently
 * controllable via a lookup table keyed by "caseType:family". */
function wireStreamMatrix(streamStatusByKey) {
  mockFetchCandidateCycles.mockResolvedValueOnce({ status: 'found', studentId: 13, rows: ['ROW'] });

  mockBuildFamilyCaseEvidence.mockImplementation(({ caseType, family }) => {
    const key = `${caseType}:${family}`;
    return { caseType, family, cycles: [{ __key: key }], duplicateCount: 0, ambiguousExcludedCount: 0, otherCaseExcludedCount: 0, nonCandidateExcludedCount: 0 };
  });

  mockSplitLongitudinalWindows.mockImplementation((cycles) => {
    const key = cycles[0].__key;
    const wanted = streamStatusByKey[key];
    if (wanted.split === 'insufficient') {
      return { status: 'insufficient', usableCount: wanted.usableCount ?? 2, unknownCount: 0, earlierWindow: null, recentWindow: null };
    }
    return {
      status: 'ok', usableCount: 10, unknownCount: 0,
      earlierWindow: [{ __key: key, slot: 'earlier' }],
      recentWindow: [{ __key: key, slot: 'recent' }],
    };
  });

  mockEvaluatePersistentDifficultyWindows.mockImplementation(({ earlierWindow, recentWindow }) => {
    const key = earlierWindow[0].__key;
    const wanted = streamStatusByKey[key];
    return {
      status: wanted.status,
      reason: wanted.reason,
      earlierWindow: { count: 5, complete: true, successfulCycles: 1, failedCycles: 4, unknownCycles: 0, isDifficult: true, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' },
      recentWindow: { count: 5, complete: true, successfulCycles: 0, failedCycles: 5, unknownCycles: 0, isDifficult: true, evidenceStart: '2026-01-03T00:00:00.000Z', evidenceEnd: '2026-01-03T01:00:00.000Z' },
      separationMs: wanted.separationMs ?? 172800000,
    };
  });

  mockSummarizeAffectedLetters.mockReturnValue({});
}

describe('Test 13 — exactly six streams evaluated', () => {
  it('all six (caseType, family) combinations appear in the response', async () => {
    const allInsufficient = Object.fromEntries(STREAM_KEYS.map((k) => [k, { split: 'insufficient' }]));
    wireStreamMatrix(allInsufficient);

    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    for (const caseType of ['lowercase', 'uppercase']) {
      for (const family of ['straight', 'curved', 'complex']) {
        expect(result.streams[caseType]).toHaveProperty(family);
      }
    }
    expect(mockBuildFamilyCaseEvidence).toHaveBeenCalledTimes(6);
  });
});

describe('Test 14 — lowercase/uppercase isolated', () => {
  it('a lowercase stream never leaks into the uppercase result and vice versa', async () => {
    wireStreamMatrix({
      'lowercase:straight': { split: 'ok', status: PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT, reason: PERSISTENT_DIFFICULTY_REASONS.REPEATED_DIFFICULTY_ACROSS_WINDOWS },
      'lowercase:curved': { split: 'insufficient' },
      'lowercase:complex': { split: 'insufficient' },
      'uppercase:straight': { split: 'insufficient' },
      'uppercase:curved': { split: 'insufficient' },
      'uppercase:complex': { split: 'insufficient' },
    });

    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(result.streams.lowercase.straight.status).toBe('persistent');
    expect(result.streams.uppercase.straight.status).toBe('insufficient_data');
    expect(result.streams.lowercase.curved.status).toBe('insufficient_data');
  });
});

describe('Test 15 — all three families present in both cases', () => {
  it('straight/curved/complex all appear under both lowercase and uppercase', async () => {
    const allInsufficient = Object.fromEntries(STREAM_KEYS.map((k) => [k, { split: 'insufficient' }]));
    wireStreamMatrix(allInsufficient);
    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(Object.keys(result.streams.lowercase).sort()).toEqual(['complex', 'curved', 'straight']);
    expect(Object.keys(result.streams.uppercase).sort()).toEqual(['complex', 'curved', 'straight']);
  });
});

// ─── Test 16/17/18 — summary counts ────────────────────────────────────────

describe('Tests 16/17/18 — persistent/not-persistent/insufficient counts, and the full synthetic matrix from spec §36', () => {
  it('a mix of all three statuses across the six streams produces correct counts and a correct persistentStreams list', async () => {
    wireStreamMatrix({
      'lowercase:straight': { split: 'ok', status: PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT, reason: PERSISTENT_DIFFICULTY_REASONS.REPEATED_DIFFICULTY_ACROSS_WINDOWS },
      'lowercase:curved':   { split: 'ok', status: PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT, reason: PERSISTENT_DIFFICULTY_REASONS.RECENT_IMPROVEMENT },
      'lowercase:complex':  { split: 'insufficient' },
      'uppercase:straight': { split: 'ok', status: PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT, reason: PERSISTENT_DIFFICULTY_REASONS.REPEATED_DIFFICULTY_ACROSS_WINDOWS },
      'uppercase:curved':   { split: 'ok', status: PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA, reason: PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION },
      'uppercase:complex':  { split: 'insufficient' },
    });

    const result = await evaluatePersistentDifficulty({ studentId: 13 });

    expect(result.summary.persistentCount).toBe(2);
    expect(result.summary.notPersistentCount).toBe(1);
    expect(result.summary.insufficientDataCount).toBe(3);
    expect(result.summary.evaluatedStreamCount).toBe(6);
    expect(result.summary.persistentStreams).toEqual(
      expect.arrayContaining([
        { caseType: 'lowercase', family: 'straight' },
        { caseType: 'uppercase', family: 'straight' },
      ])
    );
    expect(result.summary.persistentStreams).toHaveLength(2);

    // No global "student is persistent" boolean (spec §11).
    expect(result).not.toHaveProperty('isPersistent');
    expect(result.summary).not.toHaveProperty('isPersistent');
  });
});

// ─── Test 19 — affectedLetters passed through ──────────────────────────────

describe('Test 19 — affectedLetters passed through from summarizeAffectedLetters', () => {
  it('the object-keyed-by-letter shape is converted to the array shape, preserving order and counts', async () => {
    mockFetchCandidateCycles.mockResolvedValueOnce({ status: 'found', studentId: 13, rows: ['ROW'] });
    mockBuildFamilyCaseEvidence.mockReturnValue({ cycles: [{ letter: 'c' }], duplicateCount: 0, ambiguousExcludedCount: 0, otherCaseExcludedCount: 0, nonCandidateExcludedCount: 0 });
    mockSplitLongitudinalWindows.mockReturnValue({
      status: 'ok', usableCount: 10, unknownCount: 0,
      earlierWindow: [{ letter: 'c' }], recentWindow: [{ letter: 'o' }],
    });
    mockEvaluatePersistentDifficultyWindows.mockReturnValue({
      status: PERSISTENT_DIFFICULTY_STATUSES.PERSISTENT, reason: PERSISTENT_DIFFICULTY_REASONS.REPEATED_DIFFICULTY_ACROSS_WINDOWS,
      earlierWindow: { count: 5, complete: true, successfulCycles: 1, failedCycles: 4, unknownCycles: 0, isDifficult: true, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' },
      recentWindow: { count: 5, complete: true, successfulCycles: 0, failedCycles: 5, unknownCycles: 0, isDifficult: true, evidenceStart: '2026-01-03T00:00:00.000Z', evidenceEnd: '2026-01-03T01:00:00.000Z' },
      separationMs: 172800000,
    });
    mockSummarizeAffectedLetters.mockReturnValue({
      c: { totalCycles: 6, failedCycles: 5 },
      o: { totalCycles: 4, failedCycles: 4 },
    });

    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    const stream = result.streams.lowercase.straight;
    expect(stream.affectedLetters).toEqual([
      { letter: 'c', totalCycles: 6, failedCycles: 5 },
      { letter: 'o', totalCycles: 4, failedCycles: 4 },
    ]);
    // summarizeAffectedLetters is called with exactly the SELECTED (earlier
    // + recent) cycles, never the full evidence.cycles list, once a window
    // selection exists (spec §13).
    expect(mockSummarizeAffectedLetters).toHaveBeenCalledWith([{ letter: 'c' }, { letter: 'o' }]);
  });

  it('insufficient_cycles streams still surface affectedLetters, built from every reconstructed cycle (no window was ever selected)', async () => {
    mockFetchCandidateCycles.mockResolvedValueOnce({ status: 'found', studentId: 13, rows: ['ROW'] });
    mockBuildFamilyCaseEvidence.mockReturnValue({ cycles: [{ letter: 'c' }, { letter: 'c' }], duplicateCount: 0, ambiguousExcludedCount: 0, otherCaseExcludedCount: 0, nonCandidateExcludedCount: 0 });
    mockSplitLongitudinalWindows.mockReturnValue({ status: 'insufficient', usableCount: 2, unknownCount: 0, earlierWindow: null, recentWindow: null });
    mockSummarizeAffectedLetters.mockReturnValue({ c: { totalCycles: 2, failedCycles: 0 } });

    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    const stream = result.streams.lowercase.straight;
    expect(stream.status).toBe('insufficient_data');
    expect(stream.affectedLetters).toEqual([{ letter: 'c', totalCycles: 2, failedCycles: 0 }]);
    expect(mockSummarizeAffectedLetters).toHaveBeenCalledWith([{ letter: 'c' }, { letter: 'c' }]);
  });
});

// ─── Test 20 — timestamps serialized correctly ─────────────────────────────

describe('Test 20 — timestamps serialized correctly', () => {
  it('Date instances are converted to ISO strings, never leaked as raw Date objects', async () => {
    mockFetchCandidateCycles.mockResolvedValueOnce({ status: 'found', studentId: 13, rows: ['ROW'] });
    mockBuildFamilyCaseEvidence.mockReturnValue({ cycles: [{}], duplicateCount: 0, ambiguousExcludedCount: 0, otherCaseExcludedCount: 0, nonCandidateExcludedCount: 0 });
    mockSplitLongitudinalWindows.mockReturnValue({ status: 'ok', usableCount: 10, unknownCount: 0, earlierWindow: [{}], recentWindow: [{}] });
    mockEvaluatePersistentDifficultyWindows.mockReturnValue({
      status: PERSISTENT_DIFFICULTY_STATUSES.NOT_PERSISTENT, reason: PERSISTENT_DIFFICULTY_REASONS.NO_PERSISTENT_DIFFICULTY,
      earlierWindow: { count: 5, complete: true, successfulCycles: 5, failedCycles: 0, unknownCycles: 0, isDifficult: false, evidenceStart: new Date('2026-01-01T00:00:00.000Z'), evidenceEnd: new Date('2026-01-01T01:00:00.000Z') },
      recentWindow: { count: 5, complete: true, successfulCycles: 5, failedCycles: 0, unknownCycles: 0, isDifficult: false, evidenceStart: new Date('2026-01-03T00:00:00.000Z'), evidenceEnd: new Date('2026-01-03T01:00:00.000Z') },
      separationMs: 172800000,
    });
    mockSummarizeAffectedLetters.mockReturnValue({});

    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    const stream = result.streams.lowercase.straight;
    expect(stream.earlierWindow.evidenceStart).toBe('2026-01-01T00:00:00.000Z');
    expect(typeof stream.earlierWindow.evidenceStart).toBe('string');
    expect(stream.recentWindow.evidenceEnd).toBe('2026-01-03T01:00:00.000Z');
  });
});

// ─── Test 21 — separationMs preserved ──────────────────────────────────────

describe('Test 21 — separationMs preserved', () => {
  it('the exact separationMs value from evaluatePersistentDifficultyWindows is passed through unchanged', async () => {
    mockFetchCandidateCycles.mockResolvedValueOnce({ status: 'found', studentId: 13, rows: ['ROW'] });
    mockBuildFamilyCaseEvidence.mockReturnValue({ cycles: [{}], duplicateCount: 0, ambiguousExcludedCount: 0, otherCaseExcludedCount: 0, nonCandidateExcludedCount: 0 });
    mockSplitLongitudinalWindows.mockReturnValue({ status: 'ok', usableCount: 10, unknownCount: 0, earlierWindow: [{}], recentWindow: [{}] });
    mockEvaluatePersistentDifficultyWindows.mockReturnValue({
      status: PERSISTENT_DIFFICULTY_STATUSES.INSUFFICIENT_DATA, reason: PERSISTENT_DIFFICULTY_REASONS.INSUFFICIENT_TEMPORAL_DISPERSION,
      earlierWindow: { count: 5, complete: true, successfulCycles: 0, failedCycles: 5, unknownCycles: 0, isDifficult: true, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' },
      recentWindow: { count: 5, complete: true, successfulCycles: 0, failedCycles: 5, unknownCycles: 0, isDifficult: true, evidenceStart: '2026-01-01T01:30:00.000Z', evidenceEnd: '2026-01-01T02:30:00.000Z' },
      separationMs: 1800000,
    });
    mockSummarizeAffectedLetters.mockReturnValue({});

    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(result.streams.lowercase.straight.separationMs).toBe(1800000);
    expect(result.streams.lowercase.straight.requiredSeparationMs).toBe(86400000);
  });
});

// ─── Test 22 — candidate read failure ──────────────────────────────────────

describe('Test 22 — candidate read failure', () => {
  it('read_failed from fetchCandidateCycles fails the WHOLE evaluation — never six fabricated insufficient_data streams', async () => {
    mockFetchCandidateCycles.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, rows: [] });
    const result = await evaluatePersistentDifficulty({ studentId: 13 });
    expect(result.status).toBe('read_failed');
    expect(result.streams).toBeNull();
    expect(result.summary).toBeNull();
    expect(mockBuildFamilyCaseEvidence).not.toHaveBeenCalled();
  });

  it('an unexpected thrown error is caught, not propagated — result is read_failed', async () => {
    mockFetchCandidateCycles.mockRejectedValueOnce(new Error('boom'));
    await expect(evaluatePersistentDifficulty({ studentId: 13 })).resolves.toMatchObject({ status: 'read_failed' });
  });
});

// ─── Tests 23-28 — Feature 2/3/4/5/6/baseline independence ────────────────

describe('Tests 23-28 — no Feature 2/3/4/5/6/baseline import', () => {
  it('the service file never imports Feature 2/3/4/5/6 services or StudentMotorBaseline', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyService.js'), 'utf8');
    const requireLines = source.split('\n').filter((line) => /require\(/.test(line)).join('\n');
    expect(requireLines).not.toMatch(/dynamicThresholdService|adaptiveSupportService|adaptivePreWritingService|repetitionRecommendationService|demoSpeedRecommendationService|StudentMotorBaseline/);
  });

  it('the service file never references support_level/demo_speed_level/blocked_attempts as trigger inputs', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/support_level|demo_speed_level|blocked_attempts/);
  });

  it('never references raw timing metrics', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyService.js'), 'utf8');
    expect(source).not.toMatch(/attempt_duration_ms|attempt_avg_speed|pause_frequency|pause_duration_ratio/);
  });
});

// ─── Test 29 — no writes ────────────────────────────────────────────────────

describe('Test 29 — no writes (source-scan; full model-mocked proof in the ReadOnly suite)', () => {
  it('the service file (comment-stripped) never references a write method', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/\.create\(|\.bulkCreate\(|\.update\(|\.destroy\(|\.increment\(|\.findOrCreate\(|\.save\(|transaction\(/);
  });

  it('the service file never imports ../models directly (all DB access goes through persistentDifficultyEvidence.js)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/persistentDifficultyService.js'), 'utf8');
    const requireLines = source.split('\n').filter((line) => /require\(/.test(line)).join('\n');
    expect(requireLines).not.toMatch(/\.\.\/models/);
  });
});
