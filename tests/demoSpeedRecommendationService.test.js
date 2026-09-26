'use strict';

// Feature 6 Step 3 — evaluateDemoSpeedRecommendation() composition-logic
// tests. Mocks Feature 2's evaluateDynamicThresholds() and Feature 3's
// evaluateSupportRecommendations() directly (both already exhaustively
// tested elsewhere) so this file proves ONLY the composition/trigger logic
// this service adds, precisely and deterministically. A separate file
// (demoSpeedRecommendationServiceReadOnly.test.js) proves the real
// end-to-end read-only guarantee against the real underlying models.

const mockEvaluateDynamicThresholds = jest.fn();
const mockEvaluateSupportRecommendations = jest.fn();

jest.mock('../src/services/dynamicThresholdService', () => ({
  evaluateDynamicThresholds: (...args) => mockEvaluateDynamicThresholds(...args),
}));
jest.mock('../src/services/adaptiveSupportService', () => ({
  evaluateSupportRecommendations: (...args) => mockEvaluateSupportRecommendations(...args),
}));

const { evaluateDemoSpeedRecommendation } = require('../src/services/demoSpeedRecommendationService');
const { DEMO_SPEED_LEVELS, DEMO_SPEED_REASONS } = require('../src/config/demoSpeedPolicy');

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function thresholds(decisions = {}) {
  return {
    status: 'evaluated', studentId: 13, mappingVersion: 'v1', windowSize: 5, increaseStep: 5,
    families: {
      straight: { decision: decisions.straight ?? 'insufficient_data' },
      curved:   { decision: decisions.curved ?? 'insufficient_data' },
      complex:  { decision: decisions.complex ?? 'insufficient_data' },
    },
  };
}

function support(decisions = {}) {
  return {
    status: 'evaluated', studentId: 13, windowSize: 5,
    families: {
      straight: { decision: decisions.straight ?? 'insufficient_data' },
      curved:   { decision: decisions.curved ?? 'insufficient_data' },
      complex:  { decision: decisions.complex ?? 'insufficient_data' },
    },
  };
}

function mockSignals({ f2, f3 }) {
  mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ curved: f2 }));
  mockEvaluateSupportRecommendations.mockResolvedValue(support({ curved: f3 }));
}

// ─── Tests 1-3 — mapping resolution ─────────────────────────────────────────

describe('Mapping resolution — Tests 1-3', () => {
  it('Test 1 — valid straight letter resolves family=straight', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ straight: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ straight: 'recommend_low' }));
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'i', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(result.family).toBe('straight');
  });

  it('Test 2 — valid curved letter resolves family=curved', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_low' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.family).toBe('curved');
  });

  it('Test 3 — valid complex letter resolves family=complex', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ complex: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ complex: 'recommend_low' }));
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'v', caseType: 'lowercase' });
    expect(result.family).toBe('complex');
  });
});

// ─── Test 4 — ambiguous letter ──────────────────────────────────────────────

describe('Test 4 — ambiguous letter -> standard/not_applicable', () => {
  it('"a" is Feature 2-ambiguous -> standard, not_applicable, zero DB reads', async () => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(result.family).toBeNull();
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NOT_APPLICABLE);
    expect(result.signals).toBeNull();
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
  });
});

// ─── Tests 5-7 — invalid input ───────────────────────────────────────────────

describe('Invalid input — Tests 5-7', () => {
  it.each([null, -1, 1.5, 'abc'])('Test 5 — invalid studentId (%p) -> invalid_input, recommendedSpeedLevel=standard', async (badId) => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: badId, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
  });

  it.each(['cc', '3', '', null])('Test 6 — invalid letter (%p) -> invalid_input', async (badLetter) => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: badLetter, caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
  });

  it.each(['sideways', '', null])('Test 7 — invalid caseType (%p) -> invalid_input', async (badCaseType) => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: badCaseType });
    expect(result.status).toBe('invalid_input');
  });

  it('completely missing args object never throws', async () => {
    await expect(evaluateDemoSpeedRecommendation()).resolves.toMatchObject({ status: 'invalid_input' });
  });
});

// ─── Tests 8-10 — support_review triggers ───────────────────────────────────

describe('support_review triggers — Tests 8-10', () => {
  it('Test 8 — Feature 3 support_review -> slow', async () => {
    mockSignals({ f2: 'hold', f3: 'support_review' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.SLOW);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.FEATURE3_SUPPORT_REVIEW);
  });

  it('Test 9 — Feature 2 support_review (Feature 3 not review) -> slow', async () => {
    mockSignals({ f2: 'support_review', f3: 'recommend_medium' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.SLOW);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.FEATURE2_SUPPORT_REVIEW);
  });

  it('Test 10 — both support_review -> slow, Feature 3 reason priority, both diagnostics visible', async () => {
    mockSignals({ f2: 'support_review', f3: 'support_review' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.SLOW);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.FEATURE3_SUPPORT_REVIEW);
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'support_review' });
  });
});

// ─── Tests 11-15 — non-review decisions never trigger slow ─────────────────

describe('Non-review decisions never trigger slow — Tests 11-15', () => {
  it('Test 11 — Feature 3 recommend_high ALONE -> standard (not support_review)', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_high' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 12 — Feature 3 recommend_medium -> standard', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_medium' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 13 — Feature 3 recommend_low -> standard', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_low' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 14 — Feature 2 hold -> standard', async () => {
    mockSignals({ f2: 'hold', f3: 'insufficient_data' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 15 — Feature 2 raise -> standard', async () => {
    mockSignals({ f2: 'raise', f3: 'insufficient_data' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });

  it('Feature 2 raise_requires_review -> standard', async () => {
    mockSignals({ f2: 'raise_requires_review', f3: 'insufficient_data' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });
});

// ─── Tests 16-18 — no-trigger / insufficient / missing-target ──────────────

describe('No-trigger scenarios — Tests 16-18', () => {
  it('Test 16 — both complete, neither support_review -> no_persistent_difficulty', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_high' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 17 — both insufficient_data -> standard, insufficient_data (never a default slow)', async () => {
    mockSignals({ f2: 'insufficient_data', f3: 'insufficient_data' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.INSUFFICIENT_DATA);
  });

  it('Test 18 — no target -> standard, insufficient_target, no fallback to 55', async () => {
    mockSignals({ f2: 'no_target', f3: 'insufficient_target' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.INSUFFICIENT_TARGET);
  });
});

// ─── Tests 19-20 — read failure ──────────────────────────────────────────────

describe('Read-failure handling — Tests 19-20', () => {
  it('Test 19 — Feature 2 read_failed -> whole result is read_failed, recommendedSpeedLevel=standard', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue({ status: 'read_failed', studentId: 13, families: null });
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ curved: 'support_review' }));
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
  });

  it('Test 20 — Feature 3 read_failed -> whole result is read_failed, even though Feature 2 succeeded with support_review', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ curved: 'support_review' }));
    mockEvaluateSupportRecommendations.mockResolvedValue({ status: 'read_failed', studentId: 13, families: null });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
  });

  it('an unexpected thrown error is caught, not propagated — result is read_failed', async () => {
    mockEvaluateDynamicThresholds.mockRejectedValue(new Error('boom'));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ curved: 'support_review' }));
    await expect(evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' })).resolves.toMatchObject({ status: 'read_failed' });
  });
});

// ─── Test 21 — no timing metric read ────────────────────────────────────────

describe('Test 21 — no timing metric is ever read', () => {
  it('the service source has zero references to attempt_duration_ms/attempt_avg_speed/pause metrics/LetterAttempt outside of comments', () => {
    // Scoped to actual code, not comments: the module's own JSDoc header
    // legitimately *discusses* these excluded signals by name (documenting
    // the trust decision from Feature 6 Step 2), which would otherwise be a
    // false positive on a bare substring match — the same source-scan
    // pitfall caught repeatedly earlier in this session.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/demoSpeedRecommendationService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/attempt_duration_ms|attempt_avg_speed|pause_frequency|pause_duration_ratio|LetterAttempt/);
  });
});

// ─── Provenance ──────────────────────────────────────────────────────────────

describe('Provenance diagnostics', () => {
  it('returns feature2Decision/feature3Decision/family/recommendedSpeedLevel, no raw score history', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals.feature2Decision).toBe('support_review');
    expect(result.family).toBe('curved');
    expect(result).not.toHaveProperty('scores');
    expect(result).not.toHaveProperty('attemptEvaluations');
  });

  it('signals stays null for not_applicable (short-circuited before any DB read)', async () => {
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.signals).toBeNull();
  });
});
