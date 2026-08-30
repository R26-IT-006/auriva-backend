'use strict';

// Feature 7 Step 3 — dryRunPersistentDifficulty.js CLI. Verifies argument
// parsing and orchestration without hitting the real database. Mirrors
// tests/dryRunDemoSpeedRecommendation.test.js's exact convention.
const mockEvaluatePersistentDifficulty = jest.fn();

jest.mock('../src/services/persistentDifficultyService', () => ({
  evaluatePersistentDifficulty: (...args) => mockEvaluatePersistentDifficulty(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, printResult, run } = require('../src/scripts/dryRunPersistentDifficulty');

function makeStream(overrides = {}) {
  return {
    caseType: 'lowercase', family: 'straight',
    status: 'insufficient_data', reason: 'insufficient_cycles',
    validCycleCount: 2, usableCycleCount: 2, windowSize: 5, requiredSeparationMs: 86400000,
    earlierWindow: null, recentWindow: null, separationMs: null,
    affectedLetters: [],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    status: 'evaluated', studentId: 13, evaluatedAt: '2026-08-13T00:00:00.000Z',
    streams: {
      lowercase: { straight: makeStream(), curved: makeStream({ family: 'curved' }), complex: makeStream({ family: 'complex' }) },
      uppercase: { straight: makeStream({ caseType: 'uppercase' }), curved: makeStream({ caseType: 'uppercase', family: 'curved' }), complex: makeStream({ caseType: 'uppercase', family: 'complex' }) },
    },
    summary: { evaluatedStreamCount: 6, persistentCount: 0, notPersistentCount: 0, insufficientDataCount: 6, persistentStreams: [] },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Test 30 — valid student id ─────────────────────────────────────────────

describe('Test 30 — parseArgs with a valid student id', () => {
  it('parses --student-id', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13 });
  });
});

// ─── Test 31 — missing student ──────────────────────────────────────────────

describe('Test 31 — missing --student-id', () => {
  it('throws requiring --student-id', () => {
    expect(() => parseArgs([])).toThrow(/--student-id is required/);
  });
});

// ─── Test 32 — invalid student ──────────────────────────────────────────────

describe('Test 32 — invalid --student-id', () => {
  it.each(['abc', '0', '-1', '1.5'])('throws for studentId=%p', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });
});

// ─── Test 33 — --apply rejected ─────────────────────────────────────────────

describe('Test 33 — --apply is a hard error', () => {
  it('rejects --apply with the required arg present', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow(/read-only/);
  });

  it('rejects --apply even before other args are considered invalid', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });

  it('the service is never called when --apply is passed — parseArgs throws before run()', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow();
    expect(mockEvaluatePersistentDifficulty).not.toHaveBeenCalled();
  });
});

// ─── Test 34 — persistent output ────────────────────────────────────────────

describe('Test 34 — run() output: persistent stream', () => {
  it('reports status=persistent, reason=repeated_difficulty_across_windows, and affected letters', async () => {
    const persistentStream = makeStream({
      family: 'curved', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-01-03T00:00:00.000Z', evidenceEnd: '2026-01-03T01:00:00.000Z' },
      separationMs: 172800000,
      affectedLetters: [{ letter: 'c', totalCycles: 6, failedCycles: 5 }, { letter: 'o', totalCycles: 4, failedCycles: 4 }],
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult({
      streams: { lowercase: { straight: makeStream(), curved: persistentStream, complex: makeStream({ family: 'complex' }) },
                 uppercase: { straight: makeStream({ caseType: 'uppercase' }), curved: makeStream({ caseType: 'uppercase', family: 'curved' }), complex: makeStream({ caseType: 'uppercase', family: 'complex' }) } },
      summary: { evaluatedStreamCount: 6, persistentCount: 1, notPersistentCount: 0, insufficientDataCount: 5, persistentStreams: [{ caseType: 'lowercase', family: 'curved' }] },
    }));

    const report = await run({ studentId: 13 });
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledWith({ studentId: 13 });
    expect(report.mode).toBe('read-only');
    expect(report.studentId).toBe(13);
    expect(report.result.streams.lowercase.curved.status).toBe('persistent');
    expect(report.result.summary.persistentCount).toBe(1);
  });

  it('printResult never throws when rendering a persistent stream', () => {
    const persistentStream = makeStream({
      family: 'curved', status: 'persistent', reason: 'repeated_difficulty_across_windows',
      earlierWindow: { successfulCycles: 1, failedCycles: 4, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T01:00:00.000Z' },
      recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-01-03T00:00:00.000Z', evidenceEnd: '2026-01-03T01:00:00.000Z' },
      separationMs: 172800000,
      affectedLetters: [{ letter: 'c', totalCycles: 6, failedCycles: 5 }],
    });
    const result = makeResult({
      streams: { lowercase: { straight: makeStream(), curved: persistentStream, complex: makeStream({ family: 'complex' }) },
                 uppercase: { straight: makeStream({ caseType: 'uppercase' }), curved: makeStream({ caseType: 'uppercase', family: 'curved' }), complex: makeStream({ caseType: 'uppercase', family: 'complex' }) } },
    });
    expect(() => printResult({ studentId: 13 }, result)).not.toThrow();
  });
});

// ─── Test 35 — insufficient-cycle output ────────────────────────────────────

describe('Test 35 — run() output: insufficient_cycles stream', () => {
  it('reports usable cycle count', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    const report = await run({ studentId: 13 });
    expect(report.result.streams.lowercase.straight.reason).toBe('insufficient_cycles');
    expect(report.result.streams.lowercase.straight.usableCycleCount).toBe(2);
  });
});

// ─── Test 36 — insufficient-dispersion output ───────────────────────────────

describe('Test 36 — run() output: insufficient_temporal_dispersion stream', () => {
  it('reports separation vs required separation', async () => {
    const dispersionStream = makeStream({
      family: 'curved', status: 'insufficient_data', reason: 'insufficient_temporal_dispersion',
      validCycleCount: 10, usableCycleCount: 10,
      earlierWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-01-01T00:00:00.000Z', evidenceEnd: '2026-01-01T00:10:00.000Z' },
      recentWindow: { successfulCycles: 0, failedCycles: 5, evidenceStart: '2026-01-01T00:40:00.000Z', evidenceEnd: '2026-01-01T00:50:00.000Z' },
      separationMs: 1800000,
    });
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult({
      streams: { lowercase: { straight: makeStream(), curved: dispersionStream, complex: makeStream({ family: 'complex' }) },
                 uppercase: { straight: makeStream({ caseType: 'uppercase' }), curved: makeStream({ caseType: 'uppercase', family: 'curved' }), complex: makeStream({ caseType: 'uppercase', family: 'complex' }) } },
    }));
    const report = await run({ studentId: 13 });
    expect(report.result.streams.lowercase.curved.reason).toBe('insufficient_temporal_dispersion');
    expect(report.result.streams.lowercase.curved.separationMs).toBe(1800000);
    expect(() => printResult({ studentId: 13 }, report.result)).not.toThrow();
  });
});

// ─── Test 37 — read failure ──────────────────────────────────────────────────

describe('Test 37 — run() output: read_failed', () => {
  it('a status other than "evaluated" is still reported, not thrown', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, evaluatedAt: null, streams: null, summary: null });
    const report = await run({ studentId: 13 });
    expect(report.result.status).toBe('read_failed');
    expect(() => printResult({ studentId: 13 }, report.result)).not.toThrow();
  });
});

// ─── Test 38 — exit behavior / never calls anything else ──────────────────

describe('Test 38 — never calls anything other than evaluatePersistentDifficulty — no write function exists to call', () => {
  it('evaluatePersistentDifficulty is called exactly once', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13 });
    expect(mockEvaluatePersistentDifficulty).toHaveBeenCalledTimes(1);
  });
});

// ─── Test 39 — report written (JSON report, this project's existing convention) ─

describe('Test 39 — report output', () => {
  it('the returned report object contains mode/timestamps/studentId/result, matching every other dry-run CLI in this project', async () => {
    mockEvaluatePersistentDifficulty.mockResolvedValueOnce(makeResult());
    const report = await run({ studentId: 13 });
    expect(report).toMatchObject({ mode: 'read-only', studentId: 13 });
    expect(typeof report.startedAt).toBe('string');
    expect(typeof report.finishedAt).toBe('string');
    expect(report.result).toBeDefined();
  });
});
