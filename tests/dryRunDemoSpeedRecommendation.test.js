'use strict';

// Feature 6 Step 3 — dryRunDemoSpeedRecommendation.js CLI. Verifies argument
// parsing and orchestration without hitting the real database. Mirrors
// tests/dryRunRepetitionRecommendation.test.js's exact convention.
const mockEvaluateDemoSpeedRecommendation = jest.fn();

jest.mock('../src/services/demoSpeedRecommendationService', () => ({
  evaluateDemoSpeedRecommendation: (...args) => mockEvaluateDemoSpeedRecommendation(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, run } = require('../src/scripts/dryRunDemoSpeedRecommendation');

function makeResult(overrides = {}) {
  return {
    status: 'evaluated',
    studentId: 13, letter: 'c', caseType: 'lowercase',
    family: 'curved', recommendedSpeedLevel: 'standard', reason: 'insufficient_data',
    signals: { feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Test 34 — valid args ───────────────────────────────────────────────────

describe('Test 34 — parseArgs with valid args', () => {
  it('parses --student-id, --letter, --case-type', () => {
    expect(parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase']))
      .toEqual({ studentId: 13, letter: 'c', caseType: 'lowercase' });
  });
});

// ─── Test 35/36 — missing/invalid student ──────────────────────────────────

describe('Test 35 — missing --student-id', () => {
  it('throws requiring --student-id', () => {
    expect(() => parseArgs(['--letter=c', '--case-type=lowercase'])).toThrow(/--student-id is required/);
  });
});

describe('Test 36 — invalid --student-id', () => {
  it.each(['abc', '0', '-1', '1.5'])('throws for studentId=%p', (v) => {
    expect(() => parseArgs([`--student-id=${v}`, '--letter=c', '--case-type=lowercase'])).toThrow();
  });
});

// ─── Test 37/38 — missing/invalid letter ───────────────────────────────────

describe('Test 37 — missing --letter', () => {
  it('throws requiring --letter', () => {
    expect(() => parseArgs(['--student-id=13', '--case-type=lowercase'])).toThrow(/--letter is required/);
  });
});

describe('Test 38 — empty --letter is treated as missing', () => {
  it('throws requiring --letter', () => {
    expect(() => parseArgs(['--student-id=13', '--letter=', '--case-type=lowercase'])).toThrow(/--letter is required/);
  });
});

// ─── Test 39/40 — missing/invalid case-type ────────────────────────────────

describe('Test 39 — missing --case-type', () => {
  it('throws requiring --case-type', () => {
    expect(() => parseArgs(['--student-id=13', '--letter=c'])).toThrow(/--case-type is required/);
  });
});

describe('Test 40 — empty --case-type is treated as missing', () => {
  it('throws requiring --case-type', () => {
    expect(() => parseArgs(['--student-id=13', '--letter=c', '--case-type='])).toThrow(/--case-type is required/);
  });
});

// ─── Test 41 — --apply rejected ─────────────────────────────────────────────

describe('Test 41 — --apply is a hard error', () => {
  it('rejects --apply with the required args present', () => {
    expect(() => parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase', '--apply'])).toThrow(/read-only/);
  });

  it('rejects --apply even before other args are considered invalid', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });

  it('the service is never called when --apply is passed — parseArgs throws before run()', () => {
    expect(() => parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase', '--apply'])).toThrow();
    expect(mockEvaluateDemoSpeedRecommendation).not.toHaveBeenCalled();
  });
});

// ─── Test 42 — output: standard on insufficient-data ───────────────────────

describe('Test 42 — run() output: standard recommendation on insufficient-data', () => {
  it('reports recommendedSpeedLevel=standard, reason=insufficient_data', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult());

    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(mockEvaluateDemoSpeedRecommendation).toHaveBeenCalledWith({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(report.mode).toBe('read-only');
    expect(report.studentId).toBe(13);
    expect(report.result.recommendedSpeedLevel).toBe('standard');
    expect(report.result.reason).toBe('insufficient_data');
  });
});

// ─── Test 43 — output: slow on a qualifying synthetic result ───────────────

describe('Test 43 — run() output: slow recommendation on a qualifying synthetic result', () => {
  it('reports recommendedSpeedLevel=slow, reason=feature3_support_review', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult({
      recommendedSpeedLevel: 'slow', reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
    }));

    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(report.result.recommendedSpeedLevel).toBe('slow');
    expect(report.result.reason).toBe('feature3_support_review');
  });

  it('a status other than "evaluated" (e.g. read_failed) is still reported, not thrown', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce({
      status: 'read_failed', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: null, recommendedSpeedLevel: 'standard', reason: null, signals: null,
    });
    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(report.result.status).toBe('read_failed');
  });

  it('never calls anything other than evaluateDemoSpeedRecommendation — no write function exists to call', async () => {
    mockEvaluateDemoSpeedRecommendation.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockEvaluateDemoSpeedRecommendation).toHaveBeenCalledTimes(1);
  });
});
