'use strict';

// Feature 4 Step 4 — parity test for preWritingActivityCatalog.js against a
// golden copy of auriva-frontend's constants/preWritingActivities.js
// PRE_WRITING_ACTIVITIES catalogue (ids + primitive_group + difficulty_rank
// order only). auriva-frontend and auriva-backend are independent git
// repositories, so this is a manually-synced golden fixture, not a live
// cross-repo import — the same documented limitation as Feature 3's
// tests/letterSupportLevelsParity.test.js and Feature 4 Step 2's
// tests/preWritingFamilyMapping.test.js parity section. Whenever the
// frontend catalogue changes, this golden fixture AND
// src/config/preWritingActivityCatalog.js must be updated together.

const {
  PRE_WRITING_ACTIVITY_CATALOG,
  getEasiestActivityId,
  hasCatalogActivities,
} = require('../src/config/preWritingActivityCatalog');

// Golden copy of PRE_WRITING_ACTIVITIES from
// auriva-frontend/src/constants/preWritingActivities.js, filtered to
// {id, primitive_group}, sorted by difficulty_rank ascending — re-verified
// by direct inspection during Feature 4 Step 4.
const FRONTEND_CATALOG_ORDER = {
  vertical_horizontal: [
    'connect_vertical_dots',
    'connect_horizontal_dots',
    'trace_corner',
    'trace_cross',
    'trace_square',
    'trace_ladder',
  ],
  curved: [
    'connect_curve_dots',
    'trace_half_circle_cw',
    'trace_half_circle_ccw',
    'trace_circle',
    'trace_spiral',
    'trace_figure_eight',
  ],
  diagonal: [
    'trace_diagonal_forward',
    'trace_diagonal_back',
    'trace_zigzag',
    'trace_x',
    'trace_triangle',
    'trace_diamond',
  ],
  mixed: [],
};

describe('Parity — backend catalogue matches the frontend golden fixture exactly', () => {
  it.each(Object.keys(FRONTEND_CATALOG_ORDER))('%s group: ids and order match exactly', (group) => {
    expect(PRE_WRITING_ACTIVITY_CATALOG[group]).toEqual(FRONTEND_CATALOG_ORDER[group]);
  });

  it('no extra or missing primitive groups', () => {
    expect(Object.keys(PRE_WRITING_ACTIVITY_CATALOG).sort()).toEqual(Object.keys(FRONTEND_CATALOG_ORDER).sort());
  });

  it('every group has exactly 6 activities except mixed (0)', () => {
    expect(PRE_WRITING_ACTIVITY_CATALOG.vertical_horizontal).toHaveLength(6);
    expect(PRE_WRITING_ACTIVITY_CATALOG.curved).toHaveLength(6);
    expect(PRE_WRITING_ACTIVITY_CATALOG.diagonal).toHaveLength(6);
    expect(PRE_WRITING_ACTIVITY_CATALOG.mixed).toHaveLength(0);
  });

  it('no activity id is duplicated across or within groups', () => {
    const allIds = Object.values(PRE_WRITING_ACTIVITY_CATALOG).flat();
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

describe('getEasiestActivityId()', () => {
  it('returns the first id in each populated group', () => {
    expect(getEasiestActivityId('vertical_horizontal')).toBe('connect_vertical_dots');
    expect(getEasiestActivityId('curved')).toBe('connect_curve_dots');
    expect(getEasiestActivityId('diagonal')).toBe('trace_diagonal_forward');
  });

  it('returns null for mixed (no activities)', () => {
    expect(getEasiestActivityId('mixed')).toBeNull();
  });

  it('returns null for an unknown group, never throws', () => {
    expect(() => getEasiestActivityId('unknown_group')).not.toThrow();
    expect(getEasiestActivityId('unknown_group')).toBeNull();
    expect(getEasiestActivityId(undefined)).toBeNull();
  });
});

describe('hasCatalogActivities()', () => {
  it('true for vertical_horizontal/curved/diagonal, false for mixed', () => {
    expect(hasCatalogActivities('vertical_horizontal')).toBe(true);
    expect(hasCatalogActivities('curved')).toBe(true);
    expect(hasCatalogActivities('diagonal')).toBe(true);
    expect(hasCatalogActivities('mixed')).toBe(false);
  });

  it('false for an unknown group, never throws', () => {
    expect(hasCatalogActivities('unknown_group')).toBe(false);
  });
});

describe('Catalogue immutability', () => {
  it('PRE_WRITING_ACTIVITY_CATALOG and each group array are frozen', () => {
    expect(Object.isFrozen(PRE_WRITING_ACTIVITY_CATALOG)).toBe(true);
    expect(Object.isFrozen(PRE_WRITING_ACTIVITY_CATALOG.curved)).toBe(true);
  });
});
