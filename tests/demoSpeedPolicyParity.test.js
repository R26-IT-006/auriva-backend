'use strict';

// Feature 6 Step 2 — proves the backend's demo-speed VOCABULARY matches the
// frontend's exactly. auriva-frontend and auriva-backend are INDEPENDENT
// git repositories (confirmed: each has its own .git directory), so this
// cannot be a live cross-package import — the same documented, honest
// pattern already established for Feature 3's letterSupportLevelsParity.test.js
// and Feature 4's preWritingFamilyMapping/preWritingActivityCatalog parity
// tests.
//
// Parity here is VOCABULARY ONLY (the categorical level names) — not pixel
// implementation. The backend never needs STANDARD_TRACER_PX_PER_MS/
// SLOW_SPEED_MULTIPLIER/px-per-ms math at all (Step 2 spec §9/§53); those
// belong solely to the frontend's demoSpeedLevels.js. This test does not
// pretend the backend needs them and does not duplicate them here.
const { DEMO_SPEED_LEVELS } = require('../src/config/demoSpeedPolicy');

// Golden copy of auriva-frontend/src/constants/demoSpeedLevels.js's
// `DEMO_SPEED_LEVELS` values as of Feature 6 Step 2 — re-verified by direct
// inspection.
const FRONTEND_DEMO_SPEED_LEVEL_VALUES = ['standard', 'slow'];

describe('Parity Test — backend demo-speed vocabulary matches frontend vocabulary exactly', () => {
  it('DEMO_SPEED_LEVELS contains the same values as the frontend DEMO_SPEED_LEVELS, ignoring order', () => {
    expect(Object.values(DEMO_SPEED_LEVELS).sort()).toEqual([...FRONTEND_DEMO_SPEED_LEVEL_VALUES].sort());
  });

  it('every backend value is lowercase — the frontend never sends uppercase enum keys (STANDARD/SLOW)', () => {
    for (const value of Object.values(DEMO_SPEED_LEVELS)) {
      expect(value).toBe(value.toLowerCase());
    }
  });

  it('the frontend enum keys (STANDARD/SLOW) are never themselves valid values on either side', () => {
    expect(Object.values(DEMO_SPEED_LEVELS)).not.toContain('STANDARD');
    expect(Object.values(DEMO_SPEED_LEVELS)).not.toContain('SLOW');
  });

  it('no "fast" (or any third level) exists on either side of the parity boundary', () => {
    expect(Object.values(DEMO_SPEED_LEVELS)).not.toContain('fast');
    expect(FRONTEND_DEMO_SPEED_LEVEL_VALUES).not.toContain('fast');
  });
});
