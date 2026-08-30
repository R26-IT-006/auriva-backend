'use strict';

// Feature 4 Step 4 — evaluatePreWritingRecommendation() composition-logic
// tests. Mocks Feature 2's evaluateDynamicThresholds() and Feature 3's
// evaluateSupportRecommendations() directly (both already exhaustively
// tested elsewhere — tests/dynamicThresholdService.test.js,
// tests/adaptiveSupportServiceRecommendation.test.js) so this file proves
// ONLY the composition/trigger-priority logic this service adds, precisely
// and deterministically, without needing to reconstruct realistic
// LetterAttempt/ThresholdHistory row fixtures. The real, unmocked
// preWritingFamilyMapping.js and preWritingActivityCatalog.js are used —
// both are pure, DB-free config. A separate file
// (adaptivePreWritingServiceReadOnly.test.js) proves the real end-to-end
// read-only guarantee against the real underlying models.

const mockEvaluateDynamicThresholds = jest.fn();
const mockEvaluateSupportRecommendations = jest.fn();

jest.mock('../src/services/dynamicThresholdService', () => ({
  evaluateDynamicThresholds: (...args) => mockEvaluateDynamicThresholds(...args),
}));
jest.mock('../src/services/adaptiveSupportService', () => ({
  evaluateSupportRecommendations: (...args) => mockEvaluateSupportRecommendations(...args),
}));

const { evaluatePreWritingRecommendation, REASON } = require('../src/services/adaptivePreWritingService');

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

// ─── Tests 1-6 — mapping resolution ─────────────────────────────────────────

describe('Mapping resolution — Tests 1-6', () => {
  it('Test 1 — reviewed straight letter resolves primitive (vertical_horizontal)', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_low' }); // family here is 'straight', not curved — see below
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ straight: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ straight: 'recommend_low' }));
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'i', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(result.family).toBe('straight');
    expect(result.primitiveGroup).toBe('vertical_horizontal');
  });

  it('Test 2 — reviewed curved letter resolves primitive (curved)', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_low' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.family).toBe('curved');
    expect(result.primitiveGroup).toBe('curved');
  });

  it('Test 3 — complex-family diagonal letter (v) resolves primitiveGroup=diagonal', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ complex: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ complex: 'recommend_low' }));
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'v', caseType: 'lowercase' });
    expect(result.family).toBe('complex');
    expect(result.primitiveGroup).toBe('diagonal');
  });

  it('Test 4 — complex-family curved letter (s/S) resolves primitiveGroup=curved, not diagonal', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ complex: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ complex: 'recommend_low' }));
    const lower = await evaluatePreWritingRecommendation({ studentId: 13, letter: 's', caseType: 'lowercase' });
    const upper = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'S', caseType: 'uppercase' });
    expect(lower.family).toBe('complex');
    expect(lower.primitiveGroup).toBe('curved');
    expect(upper.family).toBe('complex');
    expect(upper.primitiveGroup).toBe('curved');
  });

  it('Test 5 — complex-family mixed letter (u/U) resolves primitiveGroup=mixed, no DB call made', async () => {
    const lower = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'u', caseType: 'lowercase' });
    const upper = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'U', caseType: 'uppercase' });
    expect(lower.family).toBe('complex');
    expect(lower.primitiveGroup).toBe('mixed');
    expect(upper.family).toBe('complex');
    expect(upper.primitiveGroup).toBe('mixed');
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
  });

  it('Test 6 — ambiguous Feature 2 letter -> not_applicable, no DB call made', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NOT_APPLICABLE);
    expect(result.family).toBeNull();
    expect(result.primitiveGroup).toBeNull();
    expect(result.signals).toBeNull();
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
  });
});

// ─── Tests 7-8 — no-activity handling ───────────────────────────────────────

describe('No-activity handling — Tests 7-8', () => {
  it('Test 7 — mixed group (no activities) -> no_activity_available', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'u', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_ACTIVITY_AVAILABLE);
    expect(result.family).toBe('complex');
    expect(result.primitiveGroup).toBe('mixed');
    expect(result.activityId).toBeNull();
  });

  it('Test 8 — no substitute activity is ever offered for u/U (never diagonal/curved)', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'U', caseType: 'uppercase' });
    expect(result.activityId).toBeNull();
    expect(result.primitiveGroup).toBe('mixed');
    expect(['diagonal', 'curved', 'vertical_horizontal']).not.toContain(result.primitiveGroup);
  });
});

// ─── Tests 9-18 — trigger rules ─────────────────────────────────────────────

describe('Trigger rules — Tests 9-18', () => {
  it('Test 9 — Feature 3 support_review -> recommended', async () => {
    mockSignals({ f2: 'hold', f3: 'support_review' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE3_SUPPORT_REVIEW);
  });

  it('Test 10 — Feature 2 support_review (Feature 3 not review) -> recommended', async () => {
    mockSignals({ f2: 'support_review', f3: 'recommend_medium' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE2_SUPPORT_REVIEW);
  });

  it('Test 11 — both support_review -> Feature 3 reason takes priority', async () => {
    mockSignals({ f2: 'support_review', f3: 'support_review' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE3_SUPPORT_REVIEW);
    // both diagnostics still returned, never collapsed
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'support_review' });
  });

  it('Test 12 — Feature 3 recommend_high ALONE -> no recommendation (not support_review)', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_high' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 13 — Feature 3 recommend_medium -> no recommendation', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_medium' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 14 — Feature 3 recommend_low -> no recommendation', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_low' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 15 — Feature 2 hold -> no recommendation', async () => {
    mockSignals({ f2: 'hold', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 16 — Feature 2 raise -> no recommendation', async () => {
    mockSignals({ f2: 'raise', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 16b — Feature 2 raise_requires_review -> no recommendation', async () => {
    mockSignals({ f2: 'raise_requires_review', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 17 — both complete, neither support_review -> no_persistent_difficulty', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_high' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 18 — both insufficient_data -> insufficient_data (not a default warm-up)', async () => {
    mockSignals({ f2: 'insufficient_data', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.INSUFFICIENT_DATA);
  });
});

// ─── Tests 19-22 — mixed availability states (proves signal independence) ──

describe('Mixed availability states — Tests 19-22', () => {
  it('Test 19 — F2 support_review + F3 insufficient_data -> recommend via F2', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE2_SUPPORT_REVIEW);
  });

  it('Test 20 — F3 support_review + F2 insufficient_data -> recommend via F3', async () => {
    mockSignals({ f2: 'insufficient_data', f3: 'support_review' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE3_SUPPORT_REVIEW);
  });

  it('Test 21 — F3 support_review + F2 hold -> recommend via F3', async () => {
    mockSignals({ f2: 'hold', f3: 'support_review' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE3_SUPPORT_REVIEW);
  });

  it('Test 22 — F2 support_review + F3 recommend_high -> recommend via F2 (F3 recommend_high never overrides)', async () => {
    mockSignals({ f2: 'support_review', f3: 'recommend_high' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.reason).toBe(REASON.FEATURE2_SUPPORT_REVIEW);
  });
});

// ─── Tests 23-25 — missing target ───────────────────────────────────────────

describe('Missing target — Tests 23-25', () => {
  it('Test 23 — Feature 2 no_target -> insufficient_target', async () => {
    mockSignals({ f2: 'no_target', f3: 'insufficient_target' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.reason).toBe(REASON.INSUFFICIENT_TARGET);
  });

  it('Test 24 — no fallback to a global default threshold (55) — no_target alone determines the outcome regardless of F3', async () => {
    // Even if F3 somehow reported something else, F2 no_target still wins —
    // proving this service never substitutes a legacy global default.
    mockSignals({ f2: 'no_target', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.reason).toBe(REASON.INSUFFICIENT_TARGET);
  });

  it('Test 25 — no recommendation when target is missing, even with support_review-like F3 value ignored', async () => {
    mockSignals({ f2: 'no_target', f3: 'insufficient_target' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.recommended).toBe(false);
    expect(result.activityId).toBeNull();
  });
});

// ─── Tests 26-31 — activity selection ───────────────────────────────────────

describe('Activity selection — Tests 26-31', () => {
  it('Test 26 — vertical_horizontal picks the first/easiest exact activity id', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ straight: 'support_review' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ straight: 'insufficient_data' }));
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'i', caseType: 'lowercase' });
    expect(result.recommended).toBe(true);
    expect(result.activityId).toBe('connect_vertical_dots');
  });

  it('Test 27 — curved picks the first/easiest exact activity id', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.activityId).toBe('connect_curve_dots');
  });

  it('Test 28 — diagonal picks the first/easiest exact activity id', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ complex: 'support_review' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ complex: 'insufficient_data' }));
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'v', caseType: 'lowercase' });
    expect(result.activityId).toBe('trace_diagonal_forward');
  });

  it('Test 29 — deterministic result across repeated calls with identical signals', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const first = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    const second = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(first.activityId).toBe(second.activityId);
  });

  it('Test 30 — no random selection: 20 repeated calls all resolve to the same activity id', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' }))
    );
    const uniqueIds = new Set(results.map(r => r.activityId));
    expect(uniqueIds.size).toBe(1);
    expect([...uniqueIds][0]).toBe('connect_curve_dots');
  });

  it('Test 31 — exactly one activity is recommended, never an array/multiple', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(typeof result.activityId).toBe('string');
    expect(Array.isArray(result.activityId)).toBe(false);
  });
});

// ─── Provenance (Step 4 spec §42) ───────────────────────────────────────────

describe('Provenance diagnostics', () => {
  it('returns feature2Decision/feature3Decision/family/primitiveGroup/activityId, no raw score history', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.signals.feature2Decision).toBe('support_review');
    expect(result.signals.feature3Decision).toBe('insufficient_data');
    expect(result.family).toBe('curved');
    expect(result.primitiveGroup).toBe('curved');
    expect(result.activityId).toBe('connect_curve_dots');
    expect(result).not.toHaveProperty('scores');
    expect(result).not.toHaveProperty('attemptEvaluations');
  });

  it('signals stays null when short-circuited before any DB read (not_applicable / no_activity_available)', async () => {
    const ambiguous = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(ambiguous.signals).toBeNull();
    const mixedGroup = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'u', caseType: 'lowercase' });
    expect(mixedGroup.signals).toBeNull();
  });
});

// ─── Read-failure handling ───────────────────────────────────────────────────

describe('Read-failure handling (Step 4 spec §26)', () => {
  it('Feature 2 read_failed -> whole result is read_failed, never a partial recommendation', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue({ status: 'read_failed', studentId: 13, families: null });
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ curved: 'support_review' }));
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.recommended).toBe(false);
  });

  it('Feature 3 read_failed -> whole result is read_failed, even though Feature 2 succeeded with support_review', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ curved: 'support_review' }));
    mockEvaluateSupportRecommendations.mockResolvedValue({ status: 'read_failed', studentId: 13, families: null });
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.recommended).toBe(false);
  });

  it('an unexpected thrown error is caught, not propagated — result is read_failed', async () => {
    mockEvaluateDynamicThresholds.mockRejectedValue(new Error('boom'));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ curved: 'support_review' }));
    await expect(evaluatePreWritingRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' })).resolves.toMatchObject({ status: 'read_failed' });
  });
});

// ─── Invalid input ───────────────────────────────────────────────────────────

describe('Invalid input', () => {
  it.each([
    [null, 'c', 'lowercase'],
    [-1, 'c', 'lowercase'],
    [1.5, 'c', 'lowercase'],
    [13, 'cc', 'lowercase'],
    [13, '3', 'lowercase'],
    [13, null, 'lowercase'],
    [13, 'c', 'sideways'],
    [13, 'c', null],
  ])('studentId=%p letter=%p caseType=%p -> invalid_input, never throws, no DB call', async (studentId, letter, caseType) => {
    await expect(evaluatePreWritingRecommendation({ studentId, letter, caseType })).resolves.toMatchObject({ status: 'invalid_input', recommended: false, activityId: null });
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
  });

  it('completely missing args object never throws', async () => {
    await expect(evaluatePreWritingRecommendation()).resolves.toMatchObject({ status: 'invalid_input' });
  });

  it('a mismatched letter/caseType pairing (no Feature 2 entry) is invalid_input, not not_applicable', async () => {
    const result = await evaluatePreWritingRecommendation({ studentId: 13, letter: 'a', caseType: 'uppercase' });
    expect(result.status).toBe('invalid_input');
  });
});
