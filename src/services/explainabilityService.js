'use strict';

/**
 * explainabilityService.js
 */

const DIFFICULTY_RULES = require('./difficultyRules');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Normalise all handwriting features to a 0-100 "problem severity" scale.
 * Higher = more problematic.
 *
 * @param {Array}  assessmentData  [{ shapeId, features: { smoothness, avg_deviation } }]
 * @param {Object} letterMetrics   { avgPauses, avgTime } from letter-practice data (optional)
 */
function buildFeatureVector(assessmentData, letterMetrics) {
  const curveShapeIds = ['full_circle', 'half_circle', 'curve_wave'];
  const lineShapeIds  = ['horizontal_line', 'vertical_line'];

  const shapes      = Array.isArray(assessmentData) ? assessmentData : [];
  const curveShapes = shapes.filter(s => curveShapeIds.includes(s.shapeId));
  const lineShapes  = shapes.filter(s => lineShapeIds.includes(s.shapeId));
  const zigzag      = shapes.find(s => s.shapeId === 'zigzag');

  // Smoothness: raw 0-1 (0=perfect) → normalised 0-100 (0=perfect, 100=worst)
  const curveSmoothnessNorm  = avg(curveShapes.map(s => (s.features?.smoothness ?? 0.5) * 100));
  const lineSmoothnessNorm   = avg(lineShapes.map(s => (s.features?.smoothness ?? 0.5) * 100));
  const zigzagSmoothnessNorm = zigzag ? (zigzag.features?.smoothness ?? 0.5) * 100 : 50;
  const overallSmoothnessNorm= avg(shapes.map(s => (s.features?.smoothness ?? 0.5) * 100));

  // Deviation in px → normalised 0-100 (50 px = 100)
  // TODO(ML): ?? 0 zero-fills null accuracy/avg_deviation, biasing downstream
  // clustering. Once the ML pipeline consumes dtw_distance for zigzag/curve_wave,
  // replace ?? 0 with proper null-aware averaging (skip nulls, don't zero-fill).
  const lineDeviationNorm   = Math.min(100, avg(lineShapes.map(s => (s.features?.avg_deviation ?? 0) * 2)));
  const curveDeviationNorm  = Math.min(100, avg(curveShapes.map(s => (s.features?.avg_deviation ?? 0) * 2)));
  const overallDeviationNorm= Math.min(100, avg(shapes.map(s => (s.features?.avg_deviation ?? 0) * 2)));

  // Pause count → normalised (5+ pauses = 100)
  const pauseNorm = Math.min(100, (letterMetrics?.avgPauses ?? 0) * 20);

  // Speed: ideal 3-12 s/letter; too fast OR too slow = problematic
  const t = letterMetrics?.avgTime ?? 7;
  let speedNorm = 0;
  if (t < 2)       speedNorm = Math.min(100, (2 - t) * 50);
  else if (t < 3)  speedNorm = Math.min(100, (3 - t) * 33);
  else if (t > 15) speedNorm = Math.min(100, (t - 15) * 10);
  else if (t > 12) speedNorm = Math.min(100, (t - 12) * 8);

  return {
    curveSmoothnessNorm,
    lineSmoothnessNorm,
    zigzagSmoothnessNorm,
    overallSmoothnessNorm,
    lineDeviationNorm,
    curveDeviationNorm,
    overallDeviationNorm,
    pauseNorm,
    speedNorm,
    // Raw values carried for API response display
    raw: {
      curveSmoothnessAvg: avg(curveShapes.map(s => s.features?.smoothness ?? 0.5)),
      lineDeviationAvg:   avg(lineShapes.map(s => s.features?.avg_deviation ?? 0)),
      avgPauses:          letterMetrics?.avgPauses ?? 0,
      avgTimeSec:         letterMetrics?.avgTime ?? null,
    },
  };
}

/**
 * Score a single difficulty rule against a feature vector.
 * Returns a 0-100 confidence score and per-condition contributions.
 */
function scoreRule(rule, features) {
  let totalActivatedWeight = 0;
  const contributions = {};

  rule.conditions.forEach(cond => {
    const value = features[cond.featureKey] ?? 0;
    let activation = 0;

    if (value > cond.threshold) {
      // Severity: how far past the threshold (clamped 0-1)
      activation = Math.min(1, (value - cond.threshold) / Math.max(1, 100 - cond.threshold));
    }

    const activatedWeight = cond.weight * activation;
    totalActivatedWeight += activatedWeight;

    contributions[cond.featureKey] = {
      featureName:     cond.featureName,
      hint:            cond.hint,
      activation,
      activatedWeight,
      triggered:       activation > 0,
      rawValue:        Math.round(value),
    };
  });

  // Confidence = sum of activated weights (each cond at 100% gives its full weight → max 100)
  const confidence = Math.round(totalActivatedWeight);

  return { confidence, contributions, totalActivatedWeight };
}

// ─── Main analyser ────────────────────────────────────────────────────────────

/**
 * Analyse motor difficulty from shape-assessment data.
 *
 * @param {Array}  assessmentData  [{ shapeId, features }]
 * @param {Object} letterMetrics   optional { avgPauses, avgTime }
 * @param {number} motorScore      optional pre-computed 0-100 score
 * @returns {Object}               structured explanation result
 */
function analyzeMotorDifficulty(assessmentData, letterMetrics, motorScore) {
  if (!assessmentData || assessmentData.length === 0) {
    return {
      difficulty:           'No Data',
      difficultyKey:        null,
      confidence:           null,
      description:          'Complete the shape assessment to see difficulty analysis.',
      motorScore:           motorScore ?? null,
      featureContributions: [],
      // Additive, shape-consistent: there is no primary rule to trace here.
      ruleActivationScore:  null,
      conditionTraces:      [],
      rulesVersion:         DIFFICULTY_RULES.RULES_VERSION ?? null,
      explanation:          ['No shape assessment data available.'],
      recommendations:      [],
      noDataAvailable:      true,
    };
  }

  const features = buildFeatureVector(assessmentData, letterMetrics);

  // Score every rule
  const allScores = Object.entries(DIFFICULTY_RULES).map(([key, rule]) => {
    const result = scoreRule(rule, features);
    return { key, rule, ...result };
  });

  // Sort descending by confidence
  allScores.sort((a, b) => b.confidence - a.confidence);
  const primary = allScores[0];

  // Threshold: < 25 → no significant difficulty detected
  if (primary.confidence < 25) {
    return {
      difficulty:           'Good Motor Control',
      difficultyKey:        'NONE',
      confidence:           null,
      description:          'No significant motor difficulty detected. Motor movements showed good control across all shapes.',
      motorScore:           motorScore ?? null,
      featureContributions: [],
      // Additive. No difficulty was detected, so no rule is reported as
      // primary and no condition trace is emitted — the detection floor
      // itself is unchanged.
      ruleActivationScore:  null,
      conditionTraces:      [],
      rulesVersion:         DIFFICULTY_RULES.RULES_VERSION ?? null,
      explanation:          [
        'All motor control indicators are within the expected range.',
        'Continue regular handwriting practice to maintain and build on these skills.',
      ],
      recommendations: [
        { text: 'Continue regular letter practice sessions',    priority: 'low' },
        { text: 'Introduce slightly more complex letter forms', priority: 'low' },
      ],
      noIssueDetected: true,
    };
  }

  // Build feature contribution percentages
  const triggeredContribs = Object.entries(primary.contributions)
    .filter(([, c]) => c.triggered)
    .sort((a, b) => b[1].activatedWeight - a[1].activatedWeight);

  const totalActivated = triggeredContribs.reduce((s, [, c]) => s + c.activatedWeight, 0);

  const featureContributions = triggeredContribs.map(([featureKey, c]) => ({
    feature:  c.featureName,
    pct:      totalActivated > 0 ? Math.round((c.activatedWeight / totalActivated) * 100) : 0,
    severity: c.activatedWeight >= 25 ? 'high' : c.activatedWeight >= 10 ? 'medium' : 'low',
    hint:     c.hint,
  }));

  // Generate explanation lines for triggered conditions
  const explanation = triggeredContribs
    .map(([featureKey]) => primary.rule.explanationTemplates[featureKey])
    .filter(Boolean);

  // Secondary difficulty (if ≥ 20 confidence and different from primary)
  const secondary = allScores[1]?.confidence >= 20 ? {
    label:      allScores[1].rule.label,
    confidence: allScores[1].confidence,
    // Additive alias — same number, accurate name (see buildConditionTraces).
    ruleActivationScore: allScores[1].confidence,
  } : null;

  return {
    difficulty:           primary.rule.label,
    difficultyKey:        primary.key,
    confidence:           primary.confidence,
    // ADDITIVE ALIAS — byte-identical to `confidence` above, kept alongside it
    // for compatibility. `confidence` is a misnomer: the number is a weighted
    // sum of normalized threshold exceedances (see scoreRule), not a
    // probability or a likelihood. Nothing is renamed in this pass.
    ruleActivationScore:  primary.confidence,
    description:          primary.rule.description,
    icon:                 primary.rule.icon,
    motorScore:           motorScore ?? null,
    featureContributions,
    // ADDITIVE — every condition of the PRIMARY rule, satisfied and
    // unsatisfied alike. featureContributions above still carries only the
    // triggered ones and is unchanged.
    conditionTraces:      buildConditionTraces(primary, totalActivated),
    rulesVersion:         DIFFICULTY_RULES.RULES_VERSION ?? null,
    explanation,
    recommendations:      primary.rule.exercises,
    letterFocus:          primary.rule.letterFocus ?? [],
    secondaryDifficulty:  secondary,
    // For full API response compatibility
    featureContributionsMap: Object.fromEntries(
      featureContributions.map(c => [c.feature.replace(/ /g, '_').toLowerCase(), c.pct])
    ),
  };
}

/**
 * Exposes the per-condition values scoreRule() already computed, instead of
 * discarding them. PURE and ADDITIVE — it reads `scoredRule.contributions`
 * and the rule's own declared thresholds/weights, and computes no new score.
 *
 * Includes UNSATISFIED conditions, which the existing featureContributions
 * array deliberately filters out: for a rule engine, the condition that did
 * NOT fire (and the value it would have needed) is as explanatory as the one
 * that did.
 *
 * `contribution_pct` reuses the exact denominator featureContributions uses
 * (the total ACTIVATED weight across triggered conditions), so a triggered
 * condition's percentage here always equals the one shown there. Unsatisfied
 * conditions are 0 by construction.
 *
 * The comparison is `>` because that is literally what scoreRule() does
 * (`value > cond.threshold`); `relation` reports it rather than redefining it.
 *
 * @param {{key: string, rule: Object, contributions: Object}} scoredRule
 * @param {number} totalActivated — sum of activated weight over triggered conditions
 * @returns {Array<Object>} one entry per declared condition, in rule order
 */
function buildConditionTraces(scoredRule, totalActivated) {
  return scoredRule.rule.conditions.map((cond) => {
    const c = scoredRule.contributions[cond.featureKey] ?? {};
    const activatedWeight = c.activatedWeight ?? 0;
    return {
      condition_id:      cond.conditionId ?? `${scoredRule.key}.${cond.featureKey}`,
      rule_id:           scoredRule.rule.ruleId ?? scoredRule.key,
      feature:           cond.featureKey,
      feature_label:     cond.featureName,
      observed_value:    c.rawValue ?? null,
      threshold:         cond.threshold,
      relation:          '>',
      satisfied:         c.triggered === true,
      activation:        c.activation ?? 0,
      configured_weight: cond.weight,
      activated_weight:  activatedWeight,
      contribution_pct:  totalActivated > 0 ? Math.round((activatedWeight / totalActivated) * 100) : 0,
      hint:              cond.hint,
    };
  });
}

module.exports = { analyzeMotorDifficulty, buildFeatureVector, buildConditionTraces };