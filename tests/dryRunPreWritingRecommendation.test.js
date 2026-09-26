'use strict';

// Feature 4 Step 4 — dryRunPreWritingRecommendation.js CLI. Verifies
// argument parsing and orchestration without hitting the real database.
// Mirrors tests/dryRunSupportRecommendation.test.js's convention.
const mockEvaluatePreWritingRecommendation = jest.fn();

jest.mock('../src/services/adaptivePreWritingService', () => ({
  evaluatePreWritingRecommendation: (...args) => mockEvaluatePreWritingRecommendation(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, run } = require('../src/scripts/dryRunPreWritingRecommendation');

function makeResult(overrides = {}) {
  return {
    status: 'evaluated',
    studentId: 13, letter: 'c', caseType: 'lowercase',
    family: 'curved', primitiveGroup: 'curved',
    recommended: false, activityId: null, reason: 'insufficient_data',
    signals: { feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs (Step 4 spec §44) ─────────────────────────────────────────────

describe('parseArgs', () => {
  it('all three flags are required', () => {
    expect(() => parseArgs([])).toThrow(/--student-id is required/);
    expect(() => parseArgs(['--student-id=13'])).toThrow(/--letter is required/);
    expect(() => parseArgs(['--student-id=13', '--letter=c'])).toThrow(/--case-type is required/);
  });

  it('parses valid args', () => {
    expect(parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase']))
      .toEqual({ studentId: 13, letter: 'c', caseType: 'lowercase' });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`, '--letter=c', '--case-type=lowercase'])).toThrow();
  });

  it('--apply is a hard error — no write mode exists for this script', () => {
    expect(() => parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase', '--apply'])).toThrow(/read-only/);
  });

  it('--apply is rejected even before other args are considered invalid', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });

  it('accepts any --letter/--case-type string at the parse layer — validation happens in the service', () => {
    // parseArgs itself does not validate letter/case shape; the service's
    // own invalid_input handling is exercised in adaptivePreWritingService.test.js.
    expect(parseArgs(['--student-id=13', '--letter=zz', '--case-type=upside-down']))
      .toEqual({ studentId: 13, letter: 'zz', caseType: 'upside-down' });
  });
});

// ─── Orchestration ──────────────────────────────────────────────────────────

describe('run — calls evaluatePreWritingRecommendation only, never a write function', () => {
  it('reports the recommendation result', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult());

    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });

    expect(mockEvaluatePreWritingRecommendation).toHaveBeenCalledWith({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(report.mode).toBe('read-only');
    expect(report.studentId).toBe(13);
    expect(report.result.reason).toBe('insufficient_data');
  });

  it('reports a recommended=true result with an activityId', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      recommended: true, activityId: 'connect_curve_dots', reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
    }));
    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(report.result.recommended).toBe(true);
    expect(report.result.activityId).toBe('connect_curve_dots');
  });

  it('a status other than "evaluated" (e.g. read_failed) is still reported, not thrown', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce({
      status: 'read_failed', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: null, primitiveGroup: null, recommended: false, activityId: null, reason: null, signals: null,
    });
    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(report.result.status).toBe('read_failed');
  });

  it('a not_applicable result (ambiguous letter) is reported as-is', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult({
      family: null, primitiveGroup: null, reason: 'not_applicable', signals: null,
    }));
    const report = await run({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(report.result.reason).toBe('not_applicable');
  });

  it('never calls anything other than evaluatePreWritingRecommendation — no write function exists to call', async () => {
    mockEvaluatePreWritingRecommendation.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockEvaluatePreWritingRecommendation).toHaveBeenCalledTimes(1);
  });
});
