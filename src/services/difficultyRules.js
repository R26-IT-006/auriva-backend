'use strict';

/**
 * Rule-based motor difficulty definitions.
 *
 * Each rule contains:
 *  - conditions  : array of { featureKey, threshold (0-100), weight, featureName, hint }
 *  - feature values are all normalised to 0-100 (higher = more problematic) by explainabilityService
 *  - weights per rule MUST sum to 100
 *  - explanationTemplates : per-feature teacher-friendly text, shown when that condition fires
 *  - exercises : recommended targeted activities, ordered by priority
 */

const DIFFICULTY_RULES = {

  WEAK_CURVE_CONTROL: {
    label: 'Weak Curve Control',
    description: 'Difficulty forming smooth, continuous curved strokes such as circles and arcs.',
    icon: 'ellipse-outline',
    conditions: [
      {
        featureKey: 'curveSmoothnessNorm',
        featureName: 'Curve Smoothness',
        threshold: 30,
        weight: 40,
        hint: 'Unsteady hand movements during curved strokes',
      },
      {
        featureKey: 'pauseNorm',
        featureName: 'Pause Frequency',
        threshold: 40,
        weight: 30,
        hint: 'Frequent mid-stroke pauses',
      },
      {
        featureKey: 'curveDeviationNorm',
        featureName: 'Curve Accuracy',
        threshold: 30,
        weight: 20,
        hint: 'Straying from the intended curve path',
      },
      {
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
    label: 'Weak Straight-Line Control',
    description: 'Difficulty maintaining straight, controlled line strokes.',
    icon: 'remove-outline',
    conditions: [
      {
        featureKey: 'lineDeviationNorm',
        featureName: 'Line Accuracy',
        threshold: 40,
        weight: 40,
        hint: 'High deviation from ideal straight-line path',
      },
      {
        featureKey: 'lineSmoothnessNorm',
        featureName: 'Line Smoothness',
        threshold: 30,
        weight: 30,
        hint: 'Unsteady movements during straight-line strokes',
      },
      {
        featureKey: 'pauseNorm',
        featureName: 'Pause Frequency',
        threshold: 40,
        weight: 20,
        hint: 'Pauses interrupting continuous line flow',
      },
      {
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
    label: 'Zigzag Instability',
    description: 'Difficulty with direction changes and diagonal strokes.',
    icon: 'trending-up-outline',
    conditions: [
      {
        featureKey: 'zigzagSmoothnessNorm',
        featureName: 'Direction Change Control',
        threshold: 40,
        weight: 50,
        hint: 'Unsteady direction changes in diagonal strokes',
      },
      {
        featureKey: 'overallDeviationNorm',
        featureName: 'Stroke Accuracy',
        threshold: 40,
        weight: 30,
        hint: 'High overall stroke deviation',
      },
      {
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
    label: 'Motor Fatigue',
    description: 'Signs of reduced motor control consistent with tiredness or low stamina.',
    icon: 'battery-half-outline',
    conditions: [
      {
        featureKey: 'pauseNorm',
        featureName: 'Pause Frequency',
        threshold: 60,
        weight: 40,
        hint: 'Very frequent pauses across all shapes',
      },
      {
        featureKey: 'speedNorm',
        featureName: 'Speed Consistency',
        threshold: 30,
        weight: 35,
        hint: 'Slowing and inconsistent writing speed',
      },
      {
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