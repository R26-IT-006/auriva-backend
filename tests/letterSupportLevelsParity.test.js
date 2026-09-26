'use strict';

// Feature 3 Step 3 — proves the backend support-level vocabulary matches
// the frontend's Step 2 vocabulary exactly.
//
// auriva-frontend and auriva-backend are two INDEPENDENT git repositories
// (confirmed: each has its own .git directory, not a shared monorepo), so
// this cannot be a live cross-package import the way, e.g., a monorepo
// workspace could share a single source file. FRONTEND_SUPPORT_LEVEL_VALUES
// below is therefore a manually-synced golden copy of
// auriva-frontend/src/constants/handwritingSupportLevels.js's
// `export const SUPPORT_LEVELS = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' }`
// values — the same documented pattern this project already uses for
// mirroring frontend logic into a backend fixture (see
// src/utils/attemptPerformanceScore.js's header comment, which mirrors
// frontend/src/utils/adaptiveSequencing.js's featuresToScore() the same
// way: execute/inspect the frontend source once, then keep the backend
// fixture in sync by hand).
//
// Whenever handwritingSupportLevels.js's SUPPORT_LEVELS values change on the
// frontend, FRONTEND_SUPPORT_LEVEL_VALUES here must be updated in the same
// change — this test is the tripwire that catches a forgotten update (it
// will fail the moment the two lists disagree), not a fully automatic
// cross-repo guarantee.
const { LETTER_SUPPORT_LEVELS, isValidLetterSupportLevel } = require('../src/config/letterSupportLevels');

// Golden copy of auriva-frontend/src/constants/handwritingSupportLevels.js's
// SUPPORT_LEVELS values as of Feature 3 Step 2/3.
const FRONTEND_SUPPORT_LEVEL_VALUES = ['high', 'medium', 'low'];

describe('Parity Test — backend vocabulary matches frontend vocabulary exactly', () => {
  it('LETTER_SUPPORT_LEVELS contains the same values as the frontend SUPPORT_LEVELS, ignoring order', () => {
    expect([...LETTER_SUPPORT_LEVELS].sort()).toEqual([...FRONTEND_SUPPORT_LEVEL_VALUES].sort());
  });

  it('every backend value is lowercase — the frontend sends lowercase strings, never uppercase enum keys (HIGH/MEDIUM/LOW)', () => {
    for (const value of LETTER_SUPPORT_LEVELS) {
      expect(value).toBe(value.toLowerCase());
    }
  });

  it('the frontend enum keys (HIGH/MEDIUM/LOW) are never themselves valid persisted values', () => {
    expect(isValidLetterSupportLevel('HIGH')).toBe(false);
    expect(isValidLetterSupportLevel('MEDIUM')).toBe(false);
    expect(isValidLetterSupportLevel('LOW')).toBe(false);
  });

  it('every frontend-sendable value round-trips through isValidLetterSupportLevel as valid', () => {
    for (const value of FRONTEND_SUPPORT_LEVEL_VALUES) {
      expect(isValidLetterSupportLevel(value)).toBe(true);
    }
  });
});
