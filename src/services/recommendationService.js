'use strict';

/**
 * recommendationService.js
 *
 * Maps detected motor difficulties to targeted handwriting support activities.
 * Can be used independently from explainabilityService when a difficulty_key
 * is already known (e.g. fetched from the DB).
 */

const DIFFICULTY_RULES = require('./difficultyRules');

/**
 * Return the recommended exercises for a given difficulty key.
 *
 * @param {string} difficultyKey  e.g. 'WEAK_CURVE_CONTROL'
 * @param {string} priority       filter: 'all' | 'high' | 'medium' | 'low'
 * @returns {Array<{ text, priority }>}
 */
function getTargetedExercises(difficultyKey, priority = 'all') {
  const rule = DIFFICULTY_RULES[difficultyKey];
  if (!rule) return [];
  if (priority === 'all') return rule.exercises;
  return rule.exercises.filter(e => e.priority === priority);
}

/**
 * Return letter-focus suggestions for a detected difficulty.
 *
 * @param {string} difficultyKey
 * @returns {string[]}
 */
function getLetterFocus(difficultyKey) {
  return DIFFICULTY_RULES[difficultyKey]?.letterFocus ?? [];
}

/**
 * Build a complete recommendation response object.
 *
 * @param {string} difficultyKey
 * @param {string} studentName
 * @returns {Object}
 */
function buildRecommendationResponse(difficultyKey, studentName) {
  const rule = DIFFICULTY_RULES[difficultyKey];
  if (!rule) {
    return {
      difficultyKey,
      label:       'Unknown',
      description: '',
      exercises:   [],
      letterFocus: [],
      message:     `No recommendations available for difficulty type: ${difficultyKey}`,
    };
  }

  const highPriority   = rule.exercises.filter(e => e.priority === 'high');
  const mediumPriority = rule.exercises.filter(e => e.priority === 'medium');
  const lowPriority    = rule.exercises.filter(e => e.priority === 'low');

  return {
    difficultyKey,
    label:        rule.label,
    description:  rule.description,
    studentName:  studentName ?? null,
    exercises: {
      high:   highPriority.map(e => e.text),
      medium: mediumPriority.map(e => e.text),
      low:    lowPriority.map(e => e.text),
    },
    letterFocus: rule.letterFocus ?? [],
    message: `${highPriority.length} high-priority and ${mediumPriority.length} medium-priority exercises recommended.`,
  };
}

/**
 * List all available difficulty types (for UI dropdowns, admin views, etc.)
 *
 * @returns {Array<{ key, label, description }>}
 */
function listDifficultyTypes() {
  return Object.entries(DIFFICULTY_RULES).map(([key, rule]) => ({
    key,
    label:       rule.label,
    description: rule.description,
  }));
}

module.exports = {
  getTargetedExercises,
  getLetterFocus,
  buildRecommendationResponse,
  listDifficultyTypes,
};