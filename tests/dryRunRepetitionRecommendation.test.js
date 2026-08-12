'use strict';

// Feature 5 Step 2 — dryRunRepetitionRecommendation.js CLI. Verifies
// argument parsing and orchestration without hitting the real database.
// Mirrors tests/dryRunPreWritingRecommendation.test.js's convention.
const mockEvaluateRepetitionRecommendation = jest.fn();

jest.mock('../src/services/repetitionRecommendationService', () => ({
  evaluateRepetitionRecommendation: (...args) => mockEvaluateRepetitionRecommendation(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, run } = require('../src/scripts/dryRunRepetitionRecommendation');

function makeResult(overrides = {}) {
  return {
    status: 'evaluated',
    studentId: 13, letter: 'c', caseType: 'lowercase',
    family: 'curved', shouldRepeat: false, reason: 'insufficient_data',
    signals: { feature2Decision: 'insufficient_data', feature3Decision: 'insufficient_data' },
    policy: { maxAdaptiveRepetitionsPerInteraction: 1, adaptiveRepetitionsUsed: 0, remainingAdaptiveRepetitions: 1 },
    history: { totalCycles: 1, cleanCycles: 1, malformedCycles: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Test 42/45/46/47 — parseArgs ───────────────────────────────────────────

describe('parseArgs', () => {
  it('Test 42 — parses valid args with defaulted adaptiveRepetitionsUsed=0', () => {
    expect(parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase']))
      .toEqual({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
  });

  it('Test 43 — default adaptiveRepetitionsUsed is exactly 0 when the flag is omitted', () => {
    const flags = parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase']);
    expect(flags.adaptiveRepetitionsUsed).toBe(0);
  });

  it('Test 44 — parses an explicit --adaptive-repetitions-used value', () => {
    const flags = parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase', '--adaptive-repetitions-used=1']);
    expect(flags.adaptiveRepetitionsUsed).toBe(1);
  });

  it.each(['-1', '1.5', 'abc'])('Test 45 — rejects an invalid --adaptive-repetitions-used value (%p)', (v) => {
    expect(() => parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase', `--adaptive-repetitions-used=${v}`])).toThrow();
  });

  it('Test 46 — --apply is a hard error — no write mode exists for this script', () => {
    expect(() => parseArgs(['--student-id=13', '--letter=c', '--case-type=lowercase', '--apply'])).toThrow(/read-only/);
  });

  it('Test 46b — --apply is rejected even before other args are considered invalid', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });

  it('Test 47 — rejects a missing/invalid student, letter, or case-type', () => {
    expect(() => parseArgs([])).toThrow(/--student-id is required/);
    expect(() => parseArgs(['--student-id=13'])).toThrow(/--letter is required/);
    expect(() => parseArgs(['--student-id=13', '--letter=c'])).toThrow(/--case-type is required/);
    expect(() => parseArgs(['--student-id=abc', '--letter=c', '--case-type=lowercase'])).toThrow();
  });
});

// ─── Orchestration ──────────────────────────────────────────────────────────

describe('run — calls evaluateRepetitionRecommendation only, never a write function', () => {
  it('reports the recommendation result', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult());

    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });

    expect(mockEvaluateRepetitionRecommendation).toHaveBeenCalledWith({
      studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0,
    });
    expect(report.mode).toBe('read-only');
    expect(report.studentId).toBe(13);
    expect(report.result.reason).toBe('insufficient_data');
  });

  it('reports a shouldRepeat=true result', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      shouldRepeat: true, reason: 'feature3_support_review',
      signals: { feature2Decision: 'hold', feature3Decision: 'support_review' },
    }));
    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
    expect(report.result.shouldRepeat).toBe(true);
  });

  it('reports a cap_reached result with the used adaptiveRepetitionsUsed', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult({
      shouldRepeat: false, reason: 'cap_reached', signals: null, history: null,
      policy: { maxAdaptiveRepetitionsPerInteraction: 1, adaptiveRepetitionsUsed: 1, remainingAdaptiveRepetitions: 0 },
    }));
    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 1 });
    expect(mockEvaluateRepetitionRecommendation).toHaveBeenCalledWith(expect.objectContaining({ adaptiveRepetitionsUsed: 1 }));
    expect(report.result.reason).toBe('cap_reached');
  });

  it('a status other than "evaluated" (e.g. read_failed) is still reported, not thrown', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce({
      status: 'read_failed', studentId: 13, letter: 'c', caseType: 'lowercase',
      family: null, shouldRepeat: false, reason: null, signals: null, policy: null, history: null,
    });
    const report = await run({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
    expect(report.result.status).toBe('read_failed');
  });

  it('never calls anything other than evaluateRepetitionRecommendation — no write function exists to call', async () => {
    mockEvaluateRepetitionRecommendation.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
    expect(mockEvaluateRepetitionRecommendation).toHaveBeenCalledTimes(1);
  });
});
