'use strict';

/**
 * difficultyRules.js
 *
 * Hand-authored motor-difficulty rules. Each rule scores a set of threshold
 * conditions over the normalized 0-100 "problem severity" features built by
 * explainabilityService.buildFeatureVector().
 *
 * The metadata below (RULES_VERSION, ruleId, conditionId) exists ONLY so the
 * explanation layer can identify a rule/condition stably. Feature keys,
 * thresholds, weights, hints, explanation templates and exercises are
 * unchanged and must not be altered by explanation work — changing any of
 * them changes the system's behaviour, not its explanation.
 */

const RULES_VERSION = 'difficulty-rules-v1';

const DIFFICULTY_RULES = {

  WEAK_CURVE_CONTROL: {
    ruleId: 'WEAK_CURVE_CONTROL',
    label: 'Weak Curve Control',
    description: 'Difficulty forming smooth, continuous curved strokes such as circles and arcs.',
    icon: 'ellipse-outline',
    conditions: [
      {
        conditionId: 'WEAK_CURVE_CONTROL.curveSmoothnessNorm',
        featureKey: 'curveSmoothnessNorm',
        featureName: 'Curve Smoothness',
        threshold: 30,
        weight: 40,
        hint: 'Unsteady hand movements during curved strokes',
      },
      {
        conditionId: 'WEAK_CURVE_CONTROL.pauseNorm',
        featureKey: 'pauseNorm',
        featureName: 'Pause Frequency',
        threshold: 40,
        weight: 30,
        hint: 'Frequent mid-stroke pauses',
      },
      {
        conditionId: 'WEAK_CURVE_CONTROL.curveDeviationNorm',
        featureKey: 'curveDeviationNorm',
        featureName: 'Curve Accuracy',
        threshold: 30,
        weight: 20,
        hint: 'Straying from the intended curve path',
      },
      {
        conditionId: 'WEAK_CURVE_CONTROL.speedNorm',
        featureKey: 'speedNorm',
        featureName: 'Speed Consistency',
        threshold: 20,
        weight: 10,
        hint: 'Inconsistent writing speed disrupting rhythm',
      },
    ],
    explanationTemplates: {
      curveSmoothnessNorm: 'Unsteady hand movements during curved strokes affected writing smoothness.',
      pauseNorm:           'Frequent mid-stroke pauses interrupted continuous curve formation.',
      curveDeviationNorm:  'Strokes drifted from the intended curved path.',
      speedNorm:           'Inconsistent writing speed disrupted curved stroke rhythm.',
    },
    exercises: [
      { text: 'Circle tracing exercises',                   priority: 'high'   },
      { text: 'Letter C and O practice',                    priority: 'high'   },
      { text: 'Slow curved stroke repetition',              priority: 'medium' },
      { text: 'Half-circle tracing with visual guides',     priority: 'medium' },
      { text: 'Air-writing large circles before pencil use',priority: 'low'    },
    ],
    letterFocus: ['c', 'o', 'e', 'a', 'g', 'd', 'q', 'u'],
  },

  WEAK_STRAIGHT_LINE: {
    ruleId: 'WEAK_STRAIGHT_LINE',
    label: 'Weak Straight-Line Control',
    description: 'Difficulty maintaining straight, controlled line strokes.',
    icon: 'remove-outline',
    conditions: [
      {
        conditionId: 'WEAK_STRAIGHT_LINE.lineDeviationNorm',
        featureKey: 'lineDeviationNorm',
        featureName: 'Line Accuracy',
        threshold: 40,
        weight: 40,
        hint: 'High deviation from ideal straight-line path',
      },
      {
        conditionId: 'WEAK_STRAIGHT_LINE.lineSmoothnessNorm',
        featureKey: 'lineSmoothnessNorm',
        featureName: 'Line Smoothness',
        threshold: 30,
        weight: 30,
        hint: 'Unsteady movements during straight-line strokes',
      },
      {
        conditionId: 'WEAK_STRAIGHT_LINE.pauseNorm',
        featureKey: 'pauseNorm',
        featureName: 'Pause Frequency',
        threshold: 40,
        weight: 20,
        hint: 'Pauses interrupting continuous line flow',
      },
      {
        conditionId: 'WEAK_STRAIGHT_LINE.speedNorm',
        featureKey: 'speedNorm',
        featureName: 'Speed Consistency',
        threshold: 20,
        weight: 10,
        hint: 'Inconsistent speed affecting line steadiness',
      },
    ],
    explanationTemplates: {
      lineDeviationNorm:  'High deviation from the ideal straight-line path was detected.',
      lineSmoothnessNorm: 'Unsteady hand movements during straight-line strokes.',
      pauseNorm:          'Frequent pauses interrupted the continuous line flow.',
      speedNorm:          'Inconsistent writing speed affected line steadiness.',
    },
    exercises: [
      { text: 'Horizontal line tracing exercises',    priority: 'high'   },
      { text: 'Vertical line exercises',              priority: 'high'   },
      { text: 'Letters L, T, H, I, E practice',      priority: 'medium' },
      { text: 'Ruler-guided tracing activities',      priority: 'medium' },
      { text: 'Whiteboard arm-movement line tracing', priority: 'low'    },
    ],
    letterFocus: ['l', 't', 'h', 'i', 'e', 'f', 'b', 'p'],
  },

  ZIGZAG_INSTABILITY: {
    ruleId: 'ZIGZAG_INSTABILITY',
    label: 'Zigzag Instability',
    description: 'Difficulty with direction changes and diagonal strokes.',
    icon: 'trending-up-outline',
    conditions: [
      {
        conditionId: 'ZIGZAG_INSTABILITY.zigzagSmoothnessNorm',
        featureKey: 'zigzagSmoothnessNorm',
        featureName: 'Direction Change Control',
        threshold: 40,
        weight: 50,
        hint: 'Unsteady direction changes in diagonal strokes',
      },
      {
        conditionId: 'ZIGZAG_INSTABILITY.overallDeviationNorm',
        featureKey: 'overallDeviationNorm',
        featureName: 'Stroke Accuracy',
        threshold: 40,
        weight: 30,
        hint: 'High overall stroke deviation',
      },
      {
        conditionId: 'ZIGZAG_INSTABILITY.pauseNorm',
        featureKey: 'pauseNorm',
        featureName: 'Pause Frequency',
        threshold: 40,
        weight: 20,
        hint: 'Pauses at direction-change points',
      },
    ],
    explanationTemplates: {
      zigzagSmoothnessNorm: 'Difficulty controlling direction changes in diagonal strokes.',
      overallDeviationNorm: 'Strokes showed high deviation when changing direction.',
      pauseNorm:            'Frequent pauses at direction-change points interrupted flow.',
    },
    exercises: [
      { text: 'Zigzag tracing exercises',        priority: 'high'   },
      { text: 'Diagonal stroke activities',      priority: 'high'   },
      { text: 'Letters V, W, M, N, Z practice',  priority: 'medium' },
      { text: 'Pattern tracing worksheets',      priority: 'medium' },
      { text: 'Dot-to-dot diagonal activities',  priority: 'low'    },
    ],
    letterFocus: ['v', 'w', 'm', 'n', 'z', 'x', 'k', 'y'],
  },

  MOTOR_FATIGUE: {
    ruleId: 'MOTOR_FATIGUE',
    label: 'Motor Fatigue',
    description: 'Signs of reduced motor control consistent with tiredness or low stamina.',
    icon: 'battery-half-outline',
    conditions: [
      {
        conditionId: 'MOTOR_FATIGUE.pauseNorm',
        featureKey: 'pauseNorm',
        featureName: 'Pause Frequency',
        threshold: 60,
        weight: 40,
        hint: 'Very frequent pauses across all shapes',
      },
      {
        conditionId: 'MOTOR_FATIGUE.speedNorm',
        featureKey: 'speedNorm',
        featureName: 'Speed Consistency',
        threshold: 30,
        weight: 35,
        hint: 'Slowing and inconsistent writing speed',
      },
      {
        conditionId: 'MOTOR_FATIGUE.overallSmoothnessNorm',
        featureKey: 'overallSmoothnessNorm',
        featureName: 'Overall Smoothness',
        threshold: 50,
        weight: 25,
        hint: 'Widespread shakiness across multiple shapes',
      },
    ],
    explanationTemplates: {
      pauseNorm:             'A high number of pauses across all shapes suggests muscle fatigue.',
      speedNorm:             'Inconsistent and slowing writing speed indicates reduced stamina.',
      overallSmoothnessNorm: 'Widespread shakiness across multiple shapes points to fatigue.',
    },
    exercises: [
      { text: 'Short 5-minute breaks between writing activities', priority: 'high'   },
      { text: 'Finger strengthening exercises before sessions',   priority: 'high'   },
      { text: 'Gradual increase in session length over weeks',    priority: 'medium' },
      { text: 'Stress-ball or therapy putty exercises',           priority: 'low'    },
    ],
    letterFocus: [],
  },
};

module.exports = DIFFICULTY_RULES;

// Attached NON-ENUMERABLY on purpose. explainabilityService.js iterates the
// rule set with Object.entries(DIFFICULTY_RULES) to score every rule, so a
// plain `module.exports.RULES_VERSION = ...` would be picked up as if it were
// a fifth rule and change scoring. defineProperty keeps Object.keys/entries
// (and therefore the scoring loop) byte-identical while still exposing the
// version to the explanation layer.
Object.defineProperty(module.exports, 'RULES_VERSION', {
  value: RULES_VERSION,
  enumerable: false,
  writable: false,
});