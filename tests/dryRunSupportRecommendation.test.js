'use strict';

// Feature 3 Step 5 — dryRunSupportRecommendation.js CLI. Verifies argument
// parsing and orchestration without hitting the real database. Mirrors
// tests/dryRunSupportPerformance.test.js's convention.
const mockEvaluateSupportRecommendations = jest.fn();

jest.mock('../src/services/adaptiveSupportService', () => ({
  SUPPORT_PERFORMANCE_WINDOW_SIZE: 5,
  evaluateSupportRecommendations: (...args) => mockEvaluateSupportRecommendations(...args),
}));

jest.mock('fs'); // no real file writes

const { parseArgs, run } = require('../src/scripts/dryRunSupportRecommendation');

function makeResult(overrides = {}) {
  return {
    status: 'evaluated',
    studentId: 13,
    windowSize: 5,
    families: {
      straight: {
        family: 'straight', currentTarget: 67, recommendedSupport: null,
        decision: 'insufficient_data', reason: 'no_support_level_has_a_complete_window', requiresReview: false,
        supportResults: {
          low: { count: 0, metTargetCount: 0, windowComplete: false },
          medium: { count: 0, metTargetCount: 0, windowComplete: false },
          high: { count: 0, metTargetCount: 0, windowComplete: false },
        },
        evidenceQuality: { explicitCount: 0, historicalProxyCount: 0, containsHistoricalProxy: false },
        evidenceBasis: null,
      },
      curved: {
        family: 'curved', currentTarget: 88, recommendedSupport: null,
        decision: 'insufficient_data', reason: 'no_support_level_has_a_complete_window', requiresReview: false,
        supportResults: {
          low: { count: 2, metTargetCount: 0, windowComplete: false },
          medium: { count: 2, metTargetCount: 0, windowComplete: false },
          high: { count: 2, metTargetCount: 0, windowComplete: false },
        },
        evidenceQuality: { explicitCount: 0, historicalProxyCount: 6, containsHistoricalProxy: true },
        evidenceBasis: 'historical_proxy_only',
      },
      complex: {
        family: 'complex', currentTarget: 73, recommendedSupport: null,
        decision: 'insufficient_data', reason: 'no_support_level_has_a_complete_window', requiresReview: false,
        supportResults: {
          low: { count: 0, metTargetCount: 0, windowComplete: false },
          medium: { count: 0, metTargetCount: 0, windowComplete: false },
          high: { count: 0, metTargetCount: 0, windowComplete: false },
        },
        evidenceQuality: { explicitCount: 0, historicalProxyCount: 0, containsHistoricalProxy: false },
        evidenceBasis: null,
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── parseArgs ──────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('--student-id is required', () => {
    expect(() => parseArgs([])).toThrow(/--student-id is required/);
  });

  it('parses --student-id=13 with the default window size', () => {
    expect(parseArgs(['--student-id=13'])).toEqual({ studentId: 13, windowSize: 5 });
  });

  it.each(['abc', '0', '-1', '1.5'])('rejects an invalid --student-id value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=${v}`])).toThrow();
  });

  it('parses --window-size=8', () => {
    expect(parseArgs(['--student-id=13', '--window-size=8'])).toEqual({ studentId: 13, windowSize: 8 });
  });

  it.each(['abc', '0', '-1', '2.5'])('rejects an invalid --window-size value (%p)', (v) => {
    expect(() => parseArgs([`--student-id=13`, `--window-size=${v}`])).toThrow();
  });

  it('--apply is a hard error — no write mode exists for this script', () => {
    expect(() => parseArgs(['--student-id=13', '--apply'])).toThrow(/read-only/);
  });

  it('--apply is rejected even before other args are considered invalid', () => {
    expect(() => parseArgs(['--apply'])).toThrow(/read-only/);
  });
});

// ─── Orchestration ──────────────────────────────────────────────────────────

describe('run — calls evaluateSupportRecommendations only, never a write function', () => {
  it('reports the student\'s recommendation result', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeResult());

    const report = await run({ studentId: 13, windowSize: 5 });

    expect(mockEvaluateSupportRecommendations).toHaveBeenCalledWith({ studentId: 13, windowSize: 5 });
    expect(report.mode).toBe('read-only');
    expect(report.studentId).toBe(13);
    expect(report.result.families.curved.decision).toBe('insufficient_data');
  });

  it('propagates a custom --window-size', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeResult({ windowSize: 8 }));
    await run({ studentId: 13, windowSize: 8 });
    expect(mockEvaluateSupportRecommendations).toHaveBeenCalledWith({ studentId: 13, windowSize: 8 });
  });

  it('a status other than "evaluated" (e.g. read_failed) is still reported, not thrown', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, windowSize: 5, families: null });
    const report = await run({ studentId: 13, windowSize: 5 });
    expect(report.result.status).toBe('read_failed');
  });

  it('a recommend_* decision with requiresReview is still just reported — never acted upon', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeResult({
      families: {
        ...makeResult().families,
        curved: {
          family: 'curved', currentTarget: 80, recommendedSupport: 'high',
          decision: 'support_review', reason: 'high_support_window_complete_but_success_rate_below_pilot_threshold', requiresReview: true,
          supportResults: {
            low: { count: 5, metTargetCount: 0, windowComplete: true },
            medium: { count: 5, metTargetCount: 1, windowComplete: true },
            high: { count: 5, metTargetCount: 1, windowComplete: true },
          },
          evidenceQuality: { explicitCount: 0, historicalProxyCount: 15, containsHistoricalProxy: true },
          evidenceBasis: 'historical_proxy_only',
        },
      },
    }));

    const report = await run({ studentId: 13, windowSize: 5 });
    expect(report.result.families.curved.decision).toBe('support_review');
    expect(report.result.families.curved.requiresReview).toBe(true);
    // The CLI only reports — it never calls any apply/persist function, and
    // none exists on the mocked service to call in the first place.
    expect(mockEvaluateSupportRecommendations).toHaveBeenCalledTimes(1);
  });

  it('never calls anything other than evaluateSupportRecommendations — no write function exists to call', async () => {
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(makeResult());
    await run({ studentId: 13, windowSize: 5 });
    expect(mockEvaluateSupportRecommendations).toHaveBeenCalledTimes(1);
  });
});
