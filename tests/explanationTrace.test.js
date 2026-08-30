'use strict';

// Rule-based explanation trace — pure builder + difficulty condition traces.
//
// Explanation only: these tests prove the trace reports what the engines
// already decided, never changes a decision, and never introduces
// probability/confidence language.

const fs = require('fs');
const path = require('path');

const {
  buildThresholdDecisionTrace, buildExplanation, BASIS,
} = require('../src/services/explanationTrace');
const { analyzeMotorDifficulty, buildConditionTraces } = require('../src/services/explainabilityService');
const DIFFICULTY_RULES = require('../src/data/difficultyRules');
const { REQUIRED_MET_COUNT, RECENT_FAMILY_WINDOW_SIZE, THRESHOLD_INCREASE_STEP } =
  require('../src/services/dynamicThresholdService');

const CONSTANTS = Object.freeze({
  windowSize: 5, increaseStep: 5, requiredMetCount: 4, mappingVersion: 'letter-family-v1',
});

function attempt(letter, score, target) {
  return {
    attemptId: 100 + score, letter, caseType: 'lowercase',
    performanceScore: score, targetAtEvaluation: target, metTarget: score >= target,
  };
}

// Builds a COMPLETE-window decision with exactly `metCount` met attempts,
// mirroring evaluateDynamicThresholds()'s own output shape.
function decisionWithMetCount(metCount, { target = 82, decision, reason, recommended = 82, raw = 82 } = {}) {
  const scores = [];
  for (let i = 0; i < 5; i += 1) scores.push(i < metCount ? target + 2 : target - 3);
  return {
    family: 'curved',
    currentThreshold: target,
    window: { count: 5, complete: true },
    scores,
    metTargetCount: metCount,
    decision,
    reason,
    rawRecommendedThreshold: raw,
    recommendedThreshold: recommended,
    requiresReview: false,
    attemptEvaluations: scores.map((s, i) => attempt(String.fromCharCode(97 + i), s, target)),
  };
}

// ─── C. Trace determinism ───────────────────────────────────────────────────

describe('trace determinism and purity', () => {
  const familyDecision = decisionWithMetCount(3, { decision: 'hold', reason: '2_or_3_met_target' });

  it('same input produces a deep-equal trace', () => {
    const a = buildThresholdDecisionTrace({ familyDecision, constants: CONSTANTS });
    const b = buildThresholdDecisionTrace({ familyDecision, constants: CONSTANTS });
    expect(a).toEqual(b);
  });

  it('does not mutate the engine output it formats', () => {
    const snapshot = JSON.parse(JSON.stringify(familyDecision));
    buildThresholdDecisionTrace({ familyDecision, constants: CONSTANTS });
    expect(familyDecision).toEqual(snapshot);
  });

  it('the builder module performs no database access and no rule evaluation', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/services/explanationTrace.js'), 'utf8');
    expect(source).not.toMatch(/require\(/);
    expect(source).not.toMatch(/\.findAll|\.findOne|\.create\(|\.update\(|\.destroy\(/);
  });
});

// ─── E/F/G. Decision wording is exact, per decision code ────────────────────

describe('threshold decision explanations are exact', () => {
  it('RAISE — states the count, the rule and the new target', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(4, {
        decision: 'raise', reason: '4_or_5_met_target', recommended: 87, raw: 87,
      }),
      constants: CONSTANTS,
    });
    expect(t.explanation.summary).toBe(
      '4 of the 5 recent eligible attempts met the current target of 82. '
      + 'The progression rule requires at least 4 of 5, so the target was increased to 87.',
    );
    expect(t.explanation.counterfactual).toBeNull();
  });

  it.each([[2, 2], [3, 1]])('HOLD with %i met — counterfactual needs %i more attempt(s)', (met, needed) => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(met, { decision: 'hold', reason: '2_or_3_met_target' }),
      constants: CONSTANTS,
    });
    expect(t.explanation.summary).toContain(`${met} of the 5 recent eligible attempts met the current target of 82`);
    expect(t.explanation.summary).toContain('At least 4 of 5 are required before the target can increase');
    expect(t.explanation.counterfactual).toContain(
      `${needed} more attempt${needed === 1 ? '' : 's'} within the current 5-attempt window`,
    );
  });

  it.each([[0, 4], [1, 3]])('SUPPORT_REVIEW with %i met — never says the target was lowered', (met, needed) => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(met, { decision: 'support_review', reason: '0_or_1_met_target' }),
      constants: CONSTANTS,
    });
    expect(t.explanation.summary).toContain('The target was not reduced automatically');
    expect(t.explanation.counterfactual).toContain(`${needed} more attempts within the current 5-attempt window`);
  });

  it.each([[0, 5], [3, 2], [4, 1]])(
    'INSUFFICIENT_DATA with %i observed — needs %i more, and is never worded as failure',
    (observed, remaining) => {
      const t = buildThresholdDecisionTrace({
        familyDecision: {
          family: 'curved', currentThreshold: 82,
          window: { count: observed, complete: false },
          scores: [], metTargetCount: null, diagnosticMetTargetCount: 0,
          decision: 'insufficient_data', reason: 'insufficient_window',
          rawRecommendedThreshold: 82, recommendedThreshold: 82,
          requiresReview: false, attemptEvaluations: [],
        },
        constants: CONSTANTS,
      });
      expect(t.explanation.summary).toBe(
        `Only ${observed} of the 5 eligible attempts required for a progression decision are currently available.`,
      );
      expect(t.explanation.counterfactual).toBe(
        `${remaining} more eligible attempt${remaining === 1 ? ' is' : 's are'} needed to complete the evidence window.`,
      );
      expect(t.explanation.summary).not.toMatch(/fail|did not|unsuccessful|below/i);
    },
  );

  it('NO_TARGET — states no decision was made', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: {
        family: 'straight', currentThreshold: null,
        window: { count: 0, complete: false }, scores: [], metTargetCount: null,
        decision: 'no_target', reason: 'target_not_initialized',
        rawRecommendedThreshold: null, recommendedThreshold: null,
        requiresReview: false, attemptEvaluations: [],
      },
      constants: CONSTANTS,
    });
    expect(t.explanation.summary).toBe(
      'No progression target is currently available for this movement family, '
      + 'so no progression decision was made.',
    );
  });

  it('RAISE_REQUIRES_REVIEW — names the +5 step and the 0-100 range', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(5, {
        target: 98, decision: 'raise_requires_review',
        reason: 'proposed_target_exceeds_score_range', recommended: null, raw: 103,
      }),
      constants: CONSTANTS,
    });
    expect(t.explanation.summary).toBe(
      '5 of 5 attempts met the current target of 98. Applying the standard +5 step would produce 103, '
      + 'which exceeds the supported 0-100 score range, so no automatic change was applied.',
    );
    expect(t.decision.code).toBe('raise_requires_review');
  });
});

// ─── H. Teacher override ────────────────────────────────────────────────────

describe('teacher override', () => {
  it('is reported prominently and explains why no automatic update was applied', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(4, {
        decision: 'raise', reason: '4_or_5_met_target', recommended: 87, raw: 87,
      }),
      protection: { protected: true, reason: 'latest_target_is_teacher_override', historyId: 42 },
      persistence: { action: 'skipped_teacher_protected' },
      constants: CONSTANTS,
    });
    expect(t.teacher_override.protected).toBe(true);
    expect(t.teacher_override.reason).toBe('latest_target_is_teacher_override');
    expect(t.persistence.note).toBe(
      'Automatic updating was not applied because the current target is protected by a teacher-defined setting.',
    );
    expect(t.target.changed).toBe(false);
    expect(t.target.final).toBe(82);
  });

  it.each([
    ['stale_decision', 'The evidence used for this decision changed before the update could be applied, so the update was not used.'],
    ['already_persisted', 'This same evidence has already been applied, so it was not counted again.'],
  ])('%s produces its exact note', (action, expected) => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(4, { decision: 'raise', reason: '4_or_5_met_target', recommended: 87, raw: 87 }),
      persistence: { action },
      constants: CONSTANTS,
    });
    expect(t.persistence.note).toBe(expected);
  });

  it('an applied raise reports the new target as final and changed', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(4, { decision: 'raise', reason: '4_or_5_met_target', recommended: 87, raw: 87 }),
      persistence: { action: 'created' },
      constants: CONSTANTS,
    });
    expect(t.target.final).toBe(87);
    expect(t.target.changed).toBe(true);
    expect(t.persistence.applied).toBe(true);
  });
});

// ─── Internal identifiers are excluded ──────────────────────────────────────

describe('internal identifiers are not exposed', () => {
  it('no attempt id, fingerprint or history id appears anywhere in the trace', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(3, { decision: 'hold', reason: '2_or_3_met_target' }),
      protection: { protected: true, reason: 'latest_target_is_teacher_override', historyId: 42 },
      persistence: { action: 'skipped_hold', historyId: 99, evidenceFingerprint: 'deadbeef' },
      constants: CONSTANTS,
    });
    const json = JSON.stringify(t);
    expect(json).not.toMatch(/attempt_id|attemptId|fingerprint|history_id|historyId|deadbeef/);
    expect(json).not.toMatch(/"99"|:99[,}]/);
  });

  it('attempts carry only teacher-useful fields', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(3, { decision: 'hold', reason: '2_or_3_met_target' }),
      constants: CONSTANTS,
    });
    for (const a of t.evidence_window.attempts) {
      expect(Object.keys(a).sort()).toEqual(['case_type', 'letter', 'met_target', 'score', 'threshold']);
    }
  });
});

// ─── B/E. The engine constant really is 4, and the trace states it ──────────

describe('required met count', () => {
  it('REQUIRED_MET_COUNT is 4 and matches the 4-of-5 rule the trace reports', () => {
    expect(REQUIRED_MET_COUNT).toBe(4);
    expect(RECENT_FAMILY_WINDOW_SIZE).toBe(5);
    expect(THRESHOLD_INCREASE_STEP).toBe(5);
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(3, { decision: 'hold', reason: '2_or_3_met_target' }),
      constants: { ...CONSTANTS, requiredMetCount: REQUIRED_MET_COUNT },
    });
    expect(t.engine.required_met_count).toBe(4);
    expect(t.engine.window_size).toBe(5);
  });
});

// ─── Terminology ────────────────────────────────────────────────────────────

describe('no probability or confidence language', () => {
  const codes = [
    ['raise', '4_or_5_met_target'], ['hold', '2_or_3_met_target'],
    ['support_review', '0_or_1_met_target'], ['insufficient_data', 'insufficient_window'],
    ['no_target', 'target_not_initialized'], ['raise_requires_review', 'proposed_target_exceeds_score_range'],
  ];

  it.each(codes)('%s wording avoids banned vocabulary', (decision, reason) => {
    const e = buildExplanation({
      decision, currentThreshold: 82, metTargetCount: 3, observedCount: 5,
      requiredCount: 5, requiredMetCount: 4, recommendedThreshold: 87,
      rawRecommendedThreshold: 87, increaseStep: 5,
    });
    const text = `${e.summary} ${e.counterfactual ?? ''}`;
    expect(text).not.toMatch(/confidence|probability|likely|likelihood|chance|predict|expect(ed|s)?\b/i);
  });

  it('the trace declares its deterministic, non-probabilistic basis', () => {
    const t = buildThresholdDecisionTrace({
      familyDecision: decisionWithMetCount(3, { decision: 'hold', reason: '2_or_3_met_target' }),
      constants: CONSTANTS,
    });
    expect(t.disclosure).toEqual({ basis: BASIS, not_a_probability: true });
    expect(BASIS).toBe('rule_based_deterministic');
  });
});

// ─── I/J/K. Difficulty condition traces ─────────────────────────────────────

describe('difficulty condition traces', () => {
  // Deterministic fixture that triggers WEAK_CURVE_CONTROL with a mix of
  // satisfied and unsatisfied conditions.
  const SHAPES = [
    { shapeId: 'full_circle',     features: { smoothness: 0.72, avg_deviation: 26 } },
    { shapeId: 'half_circle',     features: { smoothness: 0.68, avg_deviation: 24 } },
    { shapeId: 'curve_wave',      features: { smoothness: 0.66, avg_deviation: 22 } },
    { shapeId: 'horizontal_line', features: { smoothness: 0.10, avg_deviation: 4 } },
    { shapeId: 'vertical_line',   features: { smoothness: 0.12, avg_deviation: 5 } },
    { shapeId: 'zigzag',          features: { smoothness: 0.30, avg_deviation: 10 } },
  ];
  const METRICS = { avgPauses: 1, avgTime: 8 };

  it('rules metadata exists without changing the rule set', () => {
    expect(Object.keys(DIFFICULTY_RULES)).toEqual([
      'WEAK_CURVE_CONTROL', 'WEAK_STRAIGHT_LINE', 'ZIGZAG_INSTABILITY', 'MOTOR_FATIGUE',
    ]);
    expect(DIFFICULTY_RULES.RULES_VERSION).toBe('difficulty-rules-v1');
    // Must NOT be enumerable — analyzeMotorDifficulty iterates the rule set.
    expect(Object.keys(DIFFICULTY_RULES)).not.toContain('RULES_VERSION');
  });

  it('every declared condition has a deterministic id matching RULE.featureKey', () => {
    let total = 0;
    for (const [key, rule] of Object.entries(DIFFICULTY_RULES)) {
      expect(rule.ruleId).toBe(key);
      for (const cond of rule.conditions) {
        expect(cond.conditionId).toBe(`${key}.${cond.featureKey}`);
        total += 1;
      }
    }
    expect(total).toBe(14); // 4 + 4 + 3 + 3
  });

  it('returns BOTH satisfied and unsatisfied conditions for the primary rule', () => {
    const r = analyzeMotorDifficulty(SHAPES, METRICS, 62);
    expect(r.difficultyKey).toBe('WEAK_CURVE_CONTROL');
    expect(r.conditionTraces).toHaveLength(4);
    expect(r.conditionTraces.filter(c => c.satisfied).length).toBeGreaterThan(0);
    expect(r.conditionTraces.filter(c => !c.satisfied).length).toBeGreaterThan(0);
  });

  it('observed values, thresholds, relation and satisfied flags are correct', () => {
    const r = analyzeMotorDifficulty(SHAPES, METRICS, 62);
    const declared = DIFFICULTY_RULES.WEAK_CURVE_CONTROL.conditions;
    r.conditionTraces.forEach((trace, i) => {
      const cond = declared[i];
      expect(trace.condition_id).toBe(cond.conditionId);
      expect(trace.feature).toBe(cond.featureKey);
      expect(trace.feature_label).toBe(cond.featureName);
      expect(trace.threshold).toBe(cond.threshold);
      expect(trace.configured_weight).toBe(cond.weight);
      expect(trace.relation).toBe('>');
      // The satisfied flag must agree with the relation it reports.
      expect(trace.satisfied).toBe(trace.observed_value > trace.threshold);
    });
  });

  it('triggered condition percentages equal the existing featureContributions values', () => {
    const r = analyzeMotorDifficulty(SHAPES, METRICS, 62);
    for (const fc of r.featureContributions) {
      const match = r.conditionTraces.find(c => c.feature_label === fc.feature);
      expect(match).toBeDefined();
      expect(match.contribution_pct).toBe(fc.pct);
    }
  });

  it('unsatisfied conditions carry zero activation and zero contribution', () => {
    const r = analyzeMotorDifficulty(SHAPES, METRICS, 62);
    for (const c of r.conditionTraces.filter(x => !x.satisfied)) {
      expect(c.activation).toBe(0);
      expect(c.activated_weight).toBe(0);
      expect(c.contribution_pct).toBe(0);
    }
  });

  it('rule_activation_score equals the legacy confidence value exactly', () => {
    const r = analyzeMotorDifficulty(SHAPES, METRICS, 62);
    expect(r.ruleActivationScore).toBe(r.confidence);
    expect(typeof r.confidence).toBe('number');
  });

  it('the existing decision and score are unchanged, and featureContributions still filters to triggered only', () => {
    const r = analyzeMotorDifficulty(SHAPES, METRICS, 62);
    expect(r.difficultyKey).toBe('WEAK_CURVE_CONTROL');
    expect(r.confidence).toBe(27);
    expect(r.featureContributions.length).toBe(r.conditionTraces.filter(c => c.satisfied).length);
    // Pre-existing keys all still present.
    for (const key of ['difficulty', 'difficultyKey', 'confidence', 'description', 'motorScore',
      'featureContributions', 'explanation', 'recommendations', 'letterFocus',
      'secondaryDifficulty', 'featureContributionsMap']) {
      expect(r).toHaveProperty(key);
    }
  });

  it('no-data and no-issue branches expose an empty trace rather than a fabricated one', () => {
    const noData = analyzeMotorDifficulty([], {}, null);
    expect(noData.conditionTraces).toEqual([]);
    expect(noData.ruleActivationScore).toBeNull();

    const good = analyzeMotorDifficulty([
      { shapeId: 'full_circle',     features: { smoothness: 0.05, avg_deviation: 1 } },
      { shapeId: 'half_circle',     features: { smoothness: 0.05, avg_deviation: 1 } },
      { shapeId: 'curve_wave',      features: { smoothness: 0.05, avg_deviation: 1 } },
      { shapeId: 'horizontal_line', features: { smoothness: 0.05, avg_deviation: 1 } },
      { shapeId: 'vertical_line',   features: { smoothness: 0.05, avg_deviation: 1 } },
      { shapeId: 'zigzag',          features: { smoothness: 0.05, avg_deviation: 1 } },
    ], { avgPauses: 0, avgTime: 7 }, 95);
    expect(good.difficultyKey).toBe('NONE');
    expect(good.conditionTraces).toEqual([]);
  });

  it('buildConditionTraces is pure — it does not mutate the scored rule', () => {
    const scored = {
      key: 'WEAK_CURVE_CONTROL',
      rule: DIFFICULTY_RULES.WEAK_CURVE_CONTROL,
      contributions: { curveSmoothnessNorm: { rawValue: 69, activation: 0.5, activatedWeight: 20, triggered: true } },
    };
    const snapshot = JSON.parse(JSON.stringify(scored));
    buildConditionTraces(scored, 20);
    expect(JSON.parse(JSON.stringify(scored))).toEqual(snapshot);
  });
});
