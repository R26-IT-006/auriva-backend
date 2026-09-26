'use strict';

// Small shared helper for tests that need to sweep every currently-
// supported canonical word (section 25) — reads the SAME generated asset
// wordScoringService.js itself loads, so the list can never drift from what
// production actually serves.
const { CANONICAL_PATH } = require('../src/services/wordScoringService');

function canonicalWordsForTest() {
  const asset = require(CANONICAL_PATH);
  return asset.words;
}

module.exports = { canonicalWordsForTest };
