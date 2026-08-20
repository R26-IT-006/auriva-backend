'use strict';

/**
 * letterCategoryCompletionService.js
 *
 * Feature 11B Phase 5 §6 — a real, derived category-completion helper,
 * replacing the previous audit's finding that category completion was
 * "only a frontend array-boundary effect" with no backend/persisted
 * concept at all.
 *
 * Category completion is ALWAYS derived, never stored: a category is
 * complete for a student iff every letter in
 * letterLearningCategories.js's list for that (caseType, category) has an
 * authoritative LetterProgress row for that student. No competing manual
 * "category_completed" flag is introduced (spec §6: "prefer deriving
 * completion from LetterProgress").
 *
 * Also exposes getMasteredLetterPairs() — the single read this feature's
 * frontend resume/skip fix (§4/§5) needs: the authoritative list of every
 * (letter, caseType) pair this student has mastered, straight from
 * LetterProgress. Backend LetterProgress remains the ONLY authoritative
 * mastery source (spec §3) — this service never reads or writes frontend
 * AsyncStorage state.
 */

const { LetterProgress } = require('../models');
const { ALL_CATEGORY_KEYS, getCategoryLetters } = require('../config/letterLearningCategories');
const logger = require('../utils/logger');

function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * @param {Object} params
 * @param {number} params.studentId
 * @param {'lowercase'|'uppercase'} params.caseType
 * @param {'straight'|'curved'|'mixed'} params.category
 * @returns {Promise<{status: string, complete: boolean|null, letters: string[], masteredLetters: string[], missingLetters: string[]}>}
 *
 * Possible statuses: found, invalid_input, read_failed
 */
async function isCategoryComplete({ studentId, caseType, category }) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', complete: null, letters: [], masteredLetters: [], missingLetters: [] };
  }
  const letters = getCategoryLetters(caseType, category);
  if (letters.length === 0) {
    return { status: 'invalid_input', complete: null, letters: [], masteredLetters: [], missingLetters: [] };
  }

  try {
    const rows = await LetterProgress.findAll({
      where: { student_id: studentId, case_type: caseType, letter: letters },
      attributes: ['letter'],
      raw: true,
    });
    const masteredSet = new Set(rows.map(r => r.letter));
    const masteredLetters = letters.filter(l => masteredSet.has(l));
    const missingLetters  = letters.filter(l => !masteredSet.has(l));

    return {
      status: 'found',
      complete: missingLetters.length === 0,
      letters,
      masteredLetters,
      missingLetters,
    };
  } catch (err) {
    logger.error('Category completion check failed', { studentId, caseType, category, errorMessage: err.message });
    return { status: 'read_failed', complete: null, letters, masteredLetters: [], missingLetters: [] };
  }
}

/**
 * Rolls up isCategoryComplete() across all 6 (caseType, category) pairs —
 * a single read for a student-wide progression view (e.g. Teacher Report).
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, categories: Object[]|null}>}
 */
async function getAllCategoryCompletionStatus({ studentId }) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', categories: null };
  }

  const results = [];
  for (const { caseType, category } of ALL_CATEGORY_KEYS) {
    const result = await isCategoryComplete({ studentId, caseType, category });
    if (result.status !== 'found') {
      return { status: result.status, categories: null };
    }
    results.push({ caseType, category, ...result });
  }
  return { status: 'found', categories: results };
}

/**
 * The authoritative, full list of every (letter, caseType) pair this
 * student has mastered, straight from LetterProgress — no derivation, no
 * filtering. This is the exact data the frontend resume/skip fix needs
 * (spec §3/§4/§5): "Do NOT use frontend AsyncStorage completed flags as
 * authoritative. Backend LetterProgress is the source of truth."
 *
 * @param {Object} params
 * @param {number} params.studentId
 * @returns {Promise<{status: string, pairs: {letter: string, caseType: string}[]}>}
 *
 * Possible statuses: found, invalid_input, read_failed
 */
async function getMasteredLetterPairs({ studentId }) {
  if (!isPositiveInteger(studentId)) {
    return { status: 'invalid_input', pairs: [] };
  }
  try {
    const rows = await LetterProgress.findAll({
      where: { student_id: studentId },
      attributes: ['letter', 'case_type'],
      raw: true,
    });
    return { status: 'found', pairs: rows.map(r => ({ letter: r.letter, caseType: r.case_type })) };
  } catch (err) {
    logger.error('Mastered-letters read failed', { studentId, errorMessage: err.message });
    return { status: 'read_failed', pairs: [] };
  }
}

module.exports = {
  isCategoryComplete,
  getAllCategoryCompletionStatus,
  getMasteredLetterPairs,
};
