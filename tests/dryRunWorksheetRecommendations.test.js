'use strict';

// Feature 8 Step 3 — dryRunWorksheetRecommendations.js CLI. Verifies
// argument parsing and orchestration without hitting the real database.
// Mirrors tests/dryRunPersistentDifficulty.test.js's exact convention.
const mockEvaluateWorksheetRecommendations = jest.fn();

jest.mock('../src/services/worksheetRecommendationService', () => ({
  evaluateWorksheetRecommendations: (...args) => mockEvaluateWorksheetRecommendations(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, printResult, run } = require('../src/scripts/dryRunWorksheetRecommendations');

function makeRecommendation(overrides = {}) {
  return {
    recommendationType: 'motor_family_practice',
    caseType: 'lowercase', family: 'curved',
    title: 'Curved Movement Practice',
    focusLetters: ['c', 'o'],
    rationale: 'Curved movement practice is recommended because difficulty remained across two separate practice periods. The pattern was observed in both the earlier and recent practice periods.',
    suggestedActivities: ['Circle tracing exercises', 'Half-circle tracing with visual guides', 'Slow curved-stroke repetition', 'Guided tracing of focus letters', 'Independent writing of focus letters'],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    status: 'evaluated', studentId: 13, evaluatedAt: '2026-08-14T00:00:00.000Z',
    recommendations: [],
    summary: { evaluatedStreamCount: 6, persistentStreamCount: 0, notPersistentCount: 0, insufficientDataCount: 6, recommendationCount: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Item 37 — valid student id ─────────────────────────────────────────────

describe('Item 37 — parseArgs with a valid student id', () => {
  it('parses --student-id', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13 });
  });
});

// ─── Item 38 — missing student ──────────────────────────────────────────────

describe('Item 38 — missing --student-id', () => {
  it('throws requiring --student-id', () => {
    expect(() => parseArgs([])).toThrow(/--student-id is required/);
  });
});

// ─── Item 39 — invalid student ──────────────────────────────────────────────

describe('Item 39 — invalid --student-id', () => {
  it.each(['abc', '0', '-1', '1.5'])('throws for studentId=%p', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });
});

// ─── Item 40 — --apply rejected ─────────────────────────────────────────────

describe('Item 40 — --apply is a hard error', () => {
  it('rejects --apply with the required arg present', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow(/read-only/);
  });

  it('rejects --apply even before other args are considered invalid', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });

  it('the service is never called when --apply is passed — parseArgs throws before run()', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow();
    expect(mockEvaluateWorksheetRecommendations).not.toHaveBeenCalled();
  });
});

// ─── Item 41 — zero recommendation output ──────────────────────────────────

describe('Item 41 — run() output: zero recommendations', () => {
  it('reports recommendationCount=0 and the "no persistent difficulty" message, without throwing', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    const report = await run({ studentId: 13 });
    expect(mockEvaluateWorksheetRecommendations).toHaveBeenCalledWith({ studentId: 13 });
    expect(report.mode).toBe('read-only');
    expect(report.studentId).toBe(13);
    expect(report.result.summary.recommendationCount).toBe(0);
    expect(() => printResult({ studentId: 13 }, report.result)).not.toThrow();
  });
});

// ─── Item 42 — one recommendation output ───────────────────────────────────

describe('Item 42 — run() output: one recommendation', () => {
  it('reports the recommendation with title/focusLetters/rationale/activities', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult({
      recommendations: [makeRecommendation()],
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 1, notPersistentCount: 0, insufficientDataCount: 5, recommendationCount: 1 },
    }));
    const report = await run({ studentId: 13 });
    expect(report.result.recommendations).toHaveLength(1);
    expect(report.result.recommendations[0].title).toBe('Curved Movement Practice');
    expect(() => printResult({ studentId: 13 }, report.result)).not.toThrow();
  });
});

// ─── Item 43 — multiple recommendation output ──────────────────────────────

describe('Item 43 — run() output: multiple recommendations', () => {
  it('reports both recommendations without throwing', async () => {
    const second = makeRecommendation({ caseType: 'uppercase', family: 'straight', title: 'Straight Movement Practice', focusLetters: ['I'] });
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult({
      recommendations: [makeRecommendation(), second],
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 2, notPersistentCount: 0, insufficientDataCount: 4, recommendationCount: 2 },
    }));
    const report = await run({ studentId: 13 });
    expect(report.result.recommendations).toHaveLength(2);
    expect(() => printResult({ studentId: 13 }, report.result)).not.toThrow();
  });
});

// ─── Item 44 — focus letters displayed ─────────────────────────────────────

describe('Item 44 — focus letters displayed', () => {
  it('printResult renders the exact focusLetters without re-sorting (captured via console.log spy)', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = makeResult({
      recommendations: [makeRecommendation({ focusLetters: ['o', 'c'] })],
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 1, notPersistentCount: 0, insufficientDataCount: 5, recommendationCount: 1 },
    });
    printResult({ studentId: 13 }, result);
    const printedLines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printedLines).toMatch(/Focus letters: o, c/);
    logSpy.mockRestore();
  });
});

// ─── Item 45 — suggested activities displayed ──────────────────────────────

describe('Item 45 — suggested activities displayed', () => {
  it('printResult renders every suggested activity', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = makeResult({
      recommendations: [makeRecommendation()],
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 1, notPersistentCount: 0, insufficientDataCount: 5, recommendationCount: 1 },
    });
    printResult({ studentId: 13 }, result);
    const printedLines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    for (const activity of makeRecommendation().suggestedActivities) {
      expect(printedLines).toContain(activity);
    }
    logSpy.mockRestore();
  });
});

// ─── Item 46 — read_failed handling ─────────────────────────────────────────

describe('Item 46 — run() output: read_failed', () => {
  it('prints "Unable to evaluate worksheet recommendations." and never prints "No recommendations"', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    printResult({ studentId: 13 }, { status: 'read_failed', studentId: 13, evaluatedAt: null, recommendations: null, summary: null });
    const printedLines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printedLines).toMatch(/Unable to evaluate worksheet recommendations\./);
    expect(printedLines).not.toMatch(/No persistent handwriting difficulty/);
    logSpy.mockRestore();
  });

  it('run() itself never throws for a read_failed service result', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, evaluatedAt: null, recommendations: null, summary: null });
    const report = await run({ studentId: 13 });
    expect(report.result.status).toBe('read_failed');
  });
});

// ─── Item 47 — service invoked once ─────────────────────────────────────────

describe('Item 47 — Feature 8 service invoked exactly once', () => {
  it('evaluateWorksheetRecommendations is called exactly once per run()', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13 });
    expect(mockEvaluateWorksheetRecommendations).toHaveBeenCalledTimes(1);
  });
});

// ─── Item 48 — no clinical/severity wording ────────────────────────────────

describe('Item 48 — no clinical/severity wording anywhere in CLI output', () => {
  it('printResult output never contains diagnosis/therapy/severity/priority language', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = makeResult({
      recommendations: [makeRecommendation()],
      summary: { evaluatedStreamCount: 6, persistentStreamCount: 1, notPersistentCount: 0, insufficientDataCount: 5, recommendationCount: 1 },
    });
    printResult({ studentId: 13 }, result);
    const printedLines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printedLines).not.toMatch(/diagnos|therapy|clinical|severe|severity|priority/i);
    logSpy.mockRestore();
  });
});

// ─── Item 49 — JSON report behavior ─────────────────────────────────────────

describe('Item 49 — JSON report written to logs/, following the existing dry-run CLI convention', () => {
  it('the returned report object contains mode/timestamps/studentId/result, matching every other dry-run CLI in this project', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    const report = await run({ studentId: 13 });
    expect(report).toMatchObject({ mode: 'read-only', studentId: 13 });
    expect(typeof report.startedAt).toBe('string');
    expect(typeof report.finishedAt).toBe('string');
    expect(report.result).toBeDefined();
  });
});

// ─── Item 50 — no writes ────────────────────────────────────────────────────

describe('Item 50 — CLI performs no writes', () => {
  it('the CLI script source (comment-stripped) has zero write-method references', () => {
    const fs = jest.requireActual('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/scripts/dryRunWorksheetRecommendations.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/bulkCreate|\.increment\(|\.update\(|\.create\(|\.destroy\(|\.save\(|transaction\(/);
  });

  it('never calls anything other than evaluateWorksheetRecommendations — no write function exists to call', async () => {
    mockEvaluateWorksheetRecommendations.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13 });
    expect(mockEvaluateWorksheetRecommendations).toHaveBeenCalledTimes(1);
  });
});
