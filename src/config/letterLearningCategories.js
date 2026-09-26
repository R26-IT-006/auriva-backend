'use strict';

/**
 * letterLearningCategories.js
 *
 * Feature 11B Phase 5 — a static, backend-side copy of the LETTER
 * MEMBERSHIP portion of the frontend's production teaching taxonomy
 * (auriva-frontend/src/constants/letterCategories.js's LETTER_CATEGORIES).
 * Letters-only — deliberately does NOT copy complexity/motorRequirements/
 * strokeTypes, since category-completion derivation (letterCategoryCompletionService.js)
 * only needs "which letters belong to this category," never the
 * personalized ordering logic (that stays frontend-only, in
 * adaptiveSequencing.js, and is unaffected by this file).
 *
 * ── Why a separate copy instead of importing the frontend file ────────────
 * auriva-backend (Node/CommonJS) and auriva-frontend (Metro/React Native
 * ES modules) are different runtimes in different repos — there is no
 * shared-package boundary between them anywhere in this project (confirmed
 * by the existing letter_motor_state_service.py / mlServiceClient.js
 * pattern: cross-repo logic is always duplicated with matching tests, never
 * imported directly). This file is that same convention applied to the
 * teaching taxonomy.
 *
 * KEEP IN SYNC BY HAND with letterCategories.js's LETTER_CATEGORIES lists —
 * tests/letterLearningCategories.test.js parses the frontend file's source
 * text directly and asserts the two agree, so a drift is caught by CI, not
 * discovered silently in production.
 *
 * Do NOT confuse this taxonomy (straight/curved/mixed teaching categories)
 * with Feature 1/2's baseline-family taxonomy (letterBaselineFamilies.js —
 * straight/curved/complex, derived from strokeTypes, a genuinely different
 * classification — see that file's own header for the documented
 * conflicts between the two).
 */

const VALID_CASE_TYPES = ['lowercase', 'uppercase'];
const VALID_CATEGORIES = ['straight', 'curved', 'mixed'];

const LETTER_LEARNING_CATEGORIES = {
  lowercase: {
    straight: ['l', 'i', 't'],
    curved:   ['o', 'c', 'e', 'u', 'a', 's'],
    mixed:    ['d', 'g', 'n', 'r', 'h', 'f', 'k', 'v', 'w', 'y', 'b', 'j', 'm', 'p', 'q', 'x', 'z'],
  },
  uppercase: {
    straight: ['I', 'L', 'T', 'F', 'E', 'H'],
    curved:   ['O', 'C', 'U', 'J', 'S', 'G', 'Q'],
    mixed:    ['D', 'P', 'B', 'V', 'Y', 'A', 'K', 'M', 'N', 'R', 'W', 'X', 'Z'],
  },
};

// Fixed enumeration order used everywhere a "walk every category" loop is
// needed (category-completion status rollups, milestone-set derivation).
// Order here is arbitrary (does NOT imply any personalized sequencing —
// see this file's header) but must stay stable so results are
// deterministic and diff-able.
const ALL_CATEGORY_KEYS = [
  { caseType: 'lowercase', category: 'straight' },
  { caseType: 'lowercase', category: 'curved' },
  { caseType: 'lowercase', category: 'mixed' },
  { caseType: 'uppercase', category: 'straight' },
  { caseType: 'uppercase', category: 'curved' },
  { caseType: 'uppercase', category: 'mixed' },
];

/**
 * @param {'lowercase'|'uppercase'} caseType
 * @param {'straight'|'curved'|'mixed'} category
 * @returns {string[]} letters in this category, or [] for an invalid pair.
 */
function getCategoryLetters(caseType, category) {
  if (!VALID_CASE_TYPES.includes(caseType)) return [];
  if (!VALID_CATEGORIES.includes(category)) return [];
  return [...(LETTER_LEARNING_CATEGORIES[caseType][category] ?? [])];
}

module.exports = {
  LETTER_LEARNING_CATEGORIES,
  VALID_CASE_TYPES,
  VALID_CATEGORIES,
  ALL_CATEGORY_KEYS,
  getCategoryLetters,
};
