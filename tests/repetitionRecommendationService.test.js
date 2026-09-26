'use strict';

// Feature 5 Step 2 — evaluateRepetitionRecommendation() composition-logic
// tests. Mocks Feature 2's evaluateDynamicThresholds() and Feature 3's
// evaluateSupportRecommendations() directly (both already exhaustively
// tested elsewhere), plus ../src/models (only LetterAttempt.findAll is used
// by this service, for cycle-history diagnostics) — so this file proves
// ONLY the composition/trigger/cap/history logic this service adds,
// precisely and deterministically. A separate file
// (repetitionRecommendationServiceReadOnly.test.js) proves the real
// end-to-end read-only guarantee against the real underlying models.

const mockLaFindAll = jest.fn();

jest.mock('../src/models', () => ({
  LetterAttempt: { findAll: (...a) => mockLaFindAll(...a) },
}));

const mockEvaluateDynamicThresholds = jest.fn();
const mockEvaluateSupportRecommendations = jest.fn();

jest.mock('../src/services/dynamicThresholdService', () => ({
  evaluateDynamicThresholds: (...args) => mockEvaluateDynamicThresholds(...args),
}));
jest.mock('../src/services/adaptiveSupportService', () => ({
  evaluateSupportRecommendations: (...args) => mockEvaluateSupportRecommendations(...args),
}));

const { evaluateRepetitionRecommendation, REPETITION_REASON } = require('../src/services/repetitionRecommendationService');
const { MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION } = require('../src/config/repetitionPolicy');

beforeEach(() => {
  jest.clearAllMocks();
  mockLaFindAll.mockResolvedValue([]);
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

function sessionRows(sessionKey, attemptNumbers) {
  return attemptNumbers.map(n => ({ session_key: sessionKey, attempt_number: n }));
}

// ─── Mapping/input tests — Tests 1-8 ────────────────────────────────────────

describe('Mapping/input — Tests 1-8', () => {
  it('Test 1 — reviewed straight letter resolves family=straight', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ straight: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ straight: 'recommend_low' }));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'i', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(result.family).toBe('straight');
  });

  it('Test 2 — reviewed curved letter resolves family=curved', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_low' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.family).toBe('curved');
  });

  it('Test 3 — reviewed complex letter resolves family=complex', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ complex: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ complex: 'recommend_low' }));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'v', caseType: 'lowercase' });
    expect(result.family).toBe('complex');
  });

  it('Test 4 — ambiguous letter -> not_applicable, zero DB reads', async () => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.status).toBe('evaluated');
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.NOT_APPLICABLE);
    expect(result.family).toBeNull();
    expect(result.signals).toBeNull();
    expect(result.policy).toBeNull();
    expect(result.history).toBeNull();
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
    expect(mockLaFindAll).not.toHaveBeenCalled();
  });

  it.each([null, -1, 1.5, 'abc'])('Test 5 — invalid studentId (%p) -> invalid_input', async (badId) => {
    const result = await evaluateRepetitionRecommendation({ studentId: badId, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
  });

  it.each(['cc', '3', '', null])('Test 6 — invalid letter (%p) -> invalid_input', async (badLetter) => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: badLetter, caseType: 'lowercase' });
    expect(result.status).toBe('invalid_input');
  });

  it.each(['sideways', '', null])('Test 7 — invalid caseType (%p) -> invalid_input', async (badCaseType) => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: badCaseType });
    expect(result.status).toBe('invalid_input');
  });

  it.each([-1, 1.5, 'zero', NaN])('Test 8 — invalid adaptiveRepetitionsUsed (%p) -> invalid_input', async (badCount) => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: badCount });
    expect(result.status).toBe('invalid_input');
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
  });

  it('adaptiveRepetitionsUsed defaults to 0 when omitted', async () => {
    mockSignals({ f2: 'hold', f3: 'insufficient_data' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.policy.adaptiveRepetitionsUsed).toBe(0);
  });
});

// ─── Trigger tests — Tests 9-19 ─────────────────────────────────────────────

describe('Trigger rules — Tests 9-19', () => {
  it('Test 9 — Feature 3 support_review -> shouldRepeat true', async () => {
    mockSignals({ f2: 'hold', f3: 'support_review' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(true);
    expect(result.reason).toBe(REPETITION_REASON.FEATURE3_SUPPORT_REVIEW);
  });

  it('Test 10 — Feature 2 support_review -> shouldRepeat true', async () => {
    mockSignals({ f2: 'support_review', f3: 'recommend_medium' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(true);
    expect(result.reason).toBe(REPETITION_REASON.FEATURE2_SUPPORT_REVIEW);
  });

  it('Test 11 — both support_review -> Feature 3 reason priority, both diagnostics visible', async () => {
    mockSignals({ f2: 'support_review', f3: 'support_review' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(true);
    expect(result.reason).toBe(REPETITION_REASON.FEATURE3_SUPPORT_REVIEW);
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'support_review' });
  });

  it('Test 12 — Feature 3 recommend_high ALONE -> false (not support_review)', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_high' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 13 — Feature 3 recommend_medium -> false', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_medium' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 14 — Feature 3 recommend_low -> false', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_low' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 15 — Feature 2 hold -> false', async () => {
    mockSignals({ f2: 'hold', f3: 'insufficient_data' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 16 — Feature 2 raise -> false', async () => {
    mockSignals({ f2: 'raise', f3: 'insufficient_data' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 17 — both complete/no review -> no_persistent_difficulty', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_high' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.reason).toBe(REPETITION_REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 18 — both insufficient_data -> insufficient_data', async () => {
    mockSignals({ f2: 'insufficient_data', f3: 'insufficient_data' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.INSUFFICIENT_DATA);
  });

  it('Test 19 — no target -> insufficient_target', async () => {
    mockSignals({ f2: 'no_target', f3: 'insufficient_target' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.INSUFFICIENT_TARGET);
  });
});

// ─── Cap tests — Tests 20-25 ─────────────────────────────────────────────────

describe('Cap model — Tests 20-25', () => {
  it('Test 20 — used=0, cap=1 -> eligible if signals justify', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 0 });
    expect(result.shouldRepeat).toBe(true);
    expect(result.policy).toEqual({ maxAdaptiveRepetitionsPerInteraction: 1, adaptiveRepetitionsUsed: 0, remainingAdaptiveRepetitions: 1 });
  });

  it('Test 21 — used=1 (== cap) -> cap_reached', async () => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 1 });
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.CAP_REACHED);
    expect(result.family).toBe('curved'); // family is still returned (spec §24)
    expect(result.signals).toBeNull();
    expect(result.history).toBeNull();
  });

  it('Test 22 — used=2 (beyond cap) -> cap_reached, remaining floors at 0', async () => {
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 2 });
    expect(result.reason).toBe(REPETITION_REASON.CAP_REACHED);
    expect(result.policy.remainingAdaptiveRepetitions).toBe(0);
  });

  it('Test 23 — cap reached short-circuits Feature 2/3 reads entirely', async () => {
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: 1 });
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
    expect(mockEvaluateSupportRecommendations).not.toHaveBeenCalled();
    expect(mockLaFindAll).not.toHaveBeenCalled();
  });

  it('Test 24 — remaining count correct across several used values', async () => {
    for (const used of [0, 1, 2]) {
      const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: used });
      expect(result.policy.remainingAdaptiveRepetitions).toBe(Math.max(0, 1 - used));
    }
  });

  it('Test 25 — cap metadata (max) is stable regardless of used count', async () => {
    for (const used of [0, 1, 2]) {
      const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase', adaptiveRepetitionsUsed: used });
      expect(result.policy.maxAdaptiveRepetitionsPerInteraction).toBe(MAX_ADAPTIVE_REPETITIONS_PER_LETTER_PER_INTERACTION);
    }
  });
});

// ─── History tests — Tests 26-35 ────────────────────────────────────────────

describe('History diagnostics — Tests 26-35', () => {
  beforeEach(() => {
    mockSignals({ f2: 'hold', f3: 'insufficient_data' }); // any non-cap-reached, non-error signal set
  });

  it('Test 26 — one clean {1,2,3} session', async () => {
    mockLaFindAll.mockResolvedValue(sessionRows('s1', [1, 2, 3]));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history).toEqual({ totalCycles: 1, cleanCycles: 1, malformedCycles: 0 });
  });

  it('Test 27 — multiple distinct session_keys counted as separate cycles', async () => {
    mockLaFindAll.mockResolvedValue([
      ...sessionRows('s1', [1, 2, 3]),
      ...sessionRows('s2', [1, 2, 3]),
      ...sessionRows('s3', [1, 2, 3]),
    ]);
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history).toEqual({ totalCycles: 3, cleanCycles: 3, malformedCycles: 0 });
  });

  it('Test 28 — a duplicate attempt row within one session does not create another cycle', async () => {
    mockLaFindAll.mockResolvedValue([
      ...sessionRows('s1', [1, 2, 3]),
      { session_key: 's1', attempt_number: 3 }, // duplicate row, same session+attempt
    ]);
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history.totalCycles).toBe(1);
  });

  it('Test 29 — malformed {3}-only session counted as malformed', async () => {
    mockLaFindAll.mockResolvedValue(sessionRows('s1', [3]));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history).toEqual({ totalCycles: 1, cleanCycles: 0, malformedCycles: 1 });
  });

  it('Test 30 — malformed {1,2}-only session counted as malformed', async () => {
    mockLaFindAll.mockResolvedValue(sessionRows('s1', [1, 2]));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history).toEqual({ totalCycles: 1, cleanCycles: 0, malformedCycles: 1 });
  });

  it('Test 31 — six-row session with duplicate attempt identities remains ONE cycle (and is clean, since deduped set is {1,2,3})', async () => {
    mockLaFindAll.mockResolvedValue([
      ...sessionRows('s1', [1, 1, 2, 2, 3, 3]), // 6 raw rows, 3 distinct attempt numbers
    ]);
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history.totalCycles).toBe(1);
    expect(result.history.cleanCycles).toBe(1);
  });

  it('Test 32 — normal mode only: the query excludes collection rows via collection_mode filter', async () => {
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockLaFindAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ collection_mode: false }),
    }));
  });

  it('Test 33 — case-specific isolation: query filters by the exact case_type requested', async () => {
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockLaFindAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ case_type: 'lowercase' }),
    }));
  });

  it('Test 34 — letter-specific isolation: query filters by the exact letter requested', async () => {
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockLaFindAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ letter: 'c' }),
    }));
  });

  it('Test 35 — student-specific isolation: query filters by the exact studentId requested', async () => {
    await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockLaFindAll).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ student_id: 13 }),
    }));
  });
});

// ─── History does not trigger — Tests 36-38 ─────────────────────────────────

describe('History is diagnostic only, never a trigger — Tests 36-38', () => {
  it('Test 36 — 30 historical cycles + no support_review -> no recommendation', async () => {
    // letter 'l' resolves to the straight family — target that family
    // explicitly rather than the curved-only mockSignals() helper.
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ straight: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ straight: 'recommend_high' }));
    const manyRows = [];
    for (let i = 0; i < 30; i++) manyRows.push(...sessionRows(`s${i}`, [1, 2, 3]));
    mockLaFindAll.mockResolvedValue(manyRows);
    const result = await evaluateRepetitionRecommendation({ studentId: 10, letter: 'l', caseType: 'lowercase' });
    expect(result.history.totalCycles).toBe(30);
    expect(result.shouldRepeat).toBe(false);
    expect(result.reason).toBe(REPETITION_REASON.NO_PERSISTENT_DIFFICULTY);
  });

  it('Test 37 — 1 historical cycle + support_review -> recommendation fires', async () => {
    mockSignals({ f2: 'hold', f3: 'support_review' });
    mockLaFindAll.mockResolvedValue(sessionRows('s1', [1, 2, 3]));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history.totalCycles).toBe(1);
    expect(result.shouldRepeat).toBe(true);
  });

  it('Test 38 — malformed history does not force a recommendation', async () => {
    mockSignals({ f2: 'hold', f3: 'recommend_medium' });
    mockLaFindAll.mockResolvedValue([...sessionRows('s1', [3]), ...sessionRows('s2', [1, 2])]);
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.history.malformedCycles).toBe(2);
    expect(result.shouldRepeat).toBe(false);
  });
});

// ─── Read failure — Tests 39-41 ──────────────────────────────────────────────

describe('Read failure (fail-closed) — Tests 39-41', () => {
  it('Test 39 — attempt-history read throws -> status=read_failed, never partial', async () => {
    mockSignals({ f2: 'support_review', f3: 'insufficient_data' });
    mockLaFindAll.mockRejectedValue(new Error('connection lost'));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.shouldRepeat).toBe(false);
  });

  it('Test 40 — Feature 2 read fails -> status=read_failed', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue({ status: 'read_failed', studentId: 13, families: null });
    mockEvaluateSupportRecommendations.mockResolvedValue(support({ curved: 'support_review' }));
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.shouldRepeat).toBe(false);
  });

  it('Test 41 — Feature 3 read fails -> status=read_failed, even though Feature 2 succeeded with support_review', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValue(thresholds({ curved: 'support_review' }));
    mockEvaluateSupportRecommendations.mockResolvedValue({ status: 'read_failed', studentId: 13, families: null });
    const result = await evaluateRepetitionRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.shouldRepeat).toBe(false);
  });
});
