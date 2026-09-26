'use strict';

// Feature 3 Step 3 — the single, authoritative backend vocabulary for
// per-attempt support level. Mirrors the frontend's SUPPORT_LEVELS values
// exactly (auriva-frontend/src/constants/handwritingSupportLevels.js):
// lowercase strings 'high' | 'medium' | 'low' — the same values the
// frontend enum's SUPPORT_LEVELS.HIGH/MEDIUM/LOW resolve to, and the same
// values it sends over the wire. See tests/letterSupportLevelsParity.test.js
// for the automated proof that this list and the frontend's never drift
// apart.
//
// Centralized here (not scattered across the model, the controller, and
// tests) so the model's Sequelize `validate.isIn` and the controller's
// saveLetterAttempts() ingestion check reuse exactly one array — never two
// copies that could silently disagree.
//
// Support level is DATA CAPTURE ONLY. Nothing in this codebase reads this
// vocabulary (or the column it validates) to make an adaptive decision —
// see Feature 3 Step 3 scope. That begins in a later step.

const LETTER_SUPPORT_LEVELS = Object.freeze(['high', 'medium', 'low']);

const LETTER_SUPPORT_LEVEL_SET = new Set(LETTER_SUPPORT_LEVELS);

/**
 * @param {*} value
 * @returns {boolean} true only for the exact strings 'high'|'medium'|'low'
 *   — never coerced (a number, boolean, or differently-cased string is
 *   rejected, matching the frontend's own descriptive-not-numeric vocabulary
 *   decision from Feature 3 Step 2).
 */
function isValidLetterSupportLevel(value) {
  return typeof value === 'string' && LETTER_SUPPORT_LEVEL_SET.has(value);
}

module.exports = { LETTER_SUPPORT_LEVELS, isValidLetterSupportLevel };
