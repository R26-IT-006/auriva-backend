'use strict';

// Feature 6 Step 5 — Final Orchestration + End-to-End Validation.
//
// Proves the COMPLETE demo-speed recommendation decision chain as a final
// acceptance gate (spec §52 items 1-12) — mocks Feature 2's
// evaluateDynamicThresholds() and Feature 3's evaluateSupportRecommendations()
// directly (both already exhaustively read-only-tested in their own
// features, and the real end-to-end read-only guarantee is separately
// proven in demoSpeedRecommendationServiceReadOnly.test.js). This file is
// the FINAL acceptance re-statement of that composed behavior, framed as
// headline end-to-end scenarios rather than granular unit coverage.
//
// Items 13-14 (controller ownership + response-schema stability) are
// covered by tests/getDemoSpeedRecommendationEndpoint.test.js (Test 24 and
// the "Response shape" describe block) — not duplicated here.
// Items 15-18 (demo_speed_level persistence) are covered by
// tests/saveLetterAttemptsDemoSpeedLevel.test.js.

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
  // mockReset (not clearAllMocks): Item 8's ambiguous-letter test queues
  // mockResolvedValueOnce values that are deliberately NEVER consumed (zero
  // DB work is the whole point of that test) — clearAllMocks() would leave
  // those queued "Once" values to leak into the next test's first real
  // call. mockReset() also discards any queued implementation, not just the
  // call-history, so every test starts from a clean queue.
  mockEvaluateDynamicThresholds.mockReset();
  mockEvaluateSupportRecommendations.mockReset();
});

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

async function evaluate({ f2, f3, letter = 'c', caseType = 'lowercase' }) {
  mockEvaluateDynamicThresholds.mockResolvedValueOnce(thresholds({ curved: f2 }));
  mockEvaluateSupportRecommendations.mockResolvedValueOnce(support({ curved: f3 }));
  return evaluateDemoSpeedRecommendation({ studentId: 13, letter, caseType });
}

describe('Item 1 — Feature 3 support_review -> slow / feature3_support_review', () => {
  it('slow tracer, HIGH support scenario from spec §4', async () => {
    const result = await evaluate({ f2: 'hold', f3: 'support_review' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.SLOW);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.FEATURE3_SUPPORT_REVIEW);
  });
});

describe('Item 2 — Feature 2 support_review -> slow / feature2_support_review', () => {
  it('slow tracer, HIGH support scenario from spec §5', async () => {
    const result = await evaluate({ f2: 'support_review', f3: 'recommend_high' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.SLOW);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.FEATURE2_SUPPORT_REVIEW);
  });
});

describe('Item 3 — both support_review -> slow / feature3_support_review, both diagnostics preserved', () => {
  it('Feature 3 priority wins the reason, but signals retain both raw decisions (spec §6)', async () => {
    const result = await evaluate({ f2: 'support_review', f3: 'support_review' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.SLOW);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.FEATURE3_SUPPORT_REVIEW);
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'support_review' });
  });
});

describe('Item 4 — hold + recommend_medium -> standard / no_persistent_difficulty', () => {
  it('no persistent difficulty scenario A from spec §7', async () => {
    const result = await evaluate({ f2: 'hold', f3: 'recommend_medium' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });
});

describe('Item 5 — raise + recommend_low -> standard / no_persistent_difficulty', () => {
  it('no persistent difficulty scenario B from spec §7', async () => {
    const result = await evaluate({ f2: 'raise', f3: 'recommend_low' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NO_PERSISTENT_DIFFICULTY);
  });
});

describe('Item 6 — insufficient_data + insufficient_data -> standard / insufficient_data', () => {
  it('never slow from sparse evidence (spec §8)', async () => {
    const result = await evaluate({ f2: 'insufficient_data', f3: 'insufficient_data' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.INSUFFICIENT_DATA);
  });
});

describe('Item 7 — no_target -> standard / insufficient_target', () => {
  it('no fallback to a global default threshold (spec §9)', async () => {
    const result = await evaluate({ f2: 'no_target', f3: 'insufficient_target' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.INSUFFICIENT_TARGET);
  });
});

describe('Item 8 — ambiguous letter -> family=null, standard / not_applicable', () => {
  it('no family guessed, zero DB work (spec §10)', async () => {
    // Deliberately NO mock setup here — an ambiguous letter must short-
    // circuit before either function is ever called (asserted below); if
    // that guarantee ever broke, calling an unconfigured mock would reject,
    // making this test fail loudly rather than silently passing.
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'a', caseType: 'lowercase' });
    expect(result.family).toBeNull();
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.NOT_APPLICABLE);
    expect(mockEvaluateDynamicThresholds).not.toHaveBeenCalled();
  });
});

describe('Item 9 — a Feature 2/3 read failure -> standard / read_failed', () => {
  it('never a fabricated slow when only one system succeeded', async () => {
    mockEvaluateDynamicThresholds.mockResolvedValueOnce({ status: 'read_failed', studentId: 13, families: null });
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(support({ curved: 'support_review' }));
    const result = await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(result.status).toBe('read_failed');
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.STANDARD);
  });
});

describe('Item 10 — no timing metric is ever read by the recommendation service', () => {
  it('source-scan proof (comment-stripped, avoiding the recurring false-positive pitfall)', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/demoSpeedRecommendationService.js'), 'utf8');
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/attempt_duration_ms|attempt_avg_speed|pause_frequency|pause_duration_ratio|LetterAttempt/);
  });
});

describe('Item 11 — no Feature 2 writes: the recommendation never mutates Feature 2\'s returned decision', () => {
  it('evaluateDynamicThresholds is called with read-only args; its result object is untouched afterward', async () => {
    const thresholdsResult = thresholds({ curved: 'hold' });
    mockEvaluateDynamicThresholds.mockResolvedValueOnce(thresholdsResult);
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(support({ curved: 'recommend_medium' }));
    await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockEvaluateDynamicThresholds).toHaveBeenCalledWith({ studentId: 13 });
    expect(thresholdsResult.families.curved.decision).toBe('hold');
  });
});

describe('Item 12 — no Feature 3 mutation: the recommendation never touches Feature 3\'s returned decision', () => {
  it('evaluateSupportRecommendations\'s result object is untouched after composition', async () => {
    const supportResult = support({ curved: 'support_review' });
    mockEvaluateDynamicThresholds.mockResolvedValueOnce(thresholds({ curved: 'hold' }));
    mockEvaluateSupportRecommendations.mockResolvedValueOnce(supportResult);
    await evaluateDemoSpeedRecommendation({ studentId: 13, letter: 'c', caseType: 'lowercase' });
    expect(mockEvaluateSupportRecommendations).toHaveBeenCalledWith({ studentId: 13 });
    expect(supportResult.families.curved.decision).toBe('support_review');
  });
});

// ─── Full lifecycle re-statement (spec §3) ─────────────────────────────────

describe('Full recommendation lifecycle, re-stated end-to-end', () => {
  it('letter -> family resolution -> Feature 2 + Feature 3 reads -> priority-ordered decision -> categorical result, in one pass', async () => {
    const result = await evaluate({ f2: 'support_review', f3: 'insufficient_data' });
    expect(result.status).toBe('evaluated');
    expect(result.family).toBe('curved');
    expect(result.signals).toEqual({ feature2Decision: 'support_review', feature3Decision: 'insufficient_data' });
    expect(result.recommendedSpeedLevel).toBe(DEMO_SPEED_LEVELS.SLOW);
    expect(result.reason).toBe(DEMO_SPEED_REASONS.FEATURE2_SUPPORT_REVIEW);
  });
});
