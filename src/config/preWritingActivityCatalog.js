'use strict';

/**
 * preWritingActivityCatalog.js
 *
 * Feature 4 Step 4 — minimal backend mirror of auriva-frontend's
 * constants/preWritingActivities.js `PRE_WRITING_ACTIVITIES` catalogue.
 *
 * Contains ONLY activity ids, grouped by primitive group, in the same
 * easiest-first (difficulty_rank ascending) order the frontend catalogue
 * already uses. Deliberately does NOT copy:
 *   - target_shape/generatePoints geometry
 *   - prompt_text
 *   - canvas coordinates or any rendering metadata
 * The backend has no use for any of that — a recommendation only needs to
 * identify WHICH activity id to suggest; the frontend remains the sole
 * owner of how that activity is drawn/rendered (Step 4 spec §16/§17).
 *
 * auriva-frontend and auriva-backend are independent git repositories, so
 * this is a manually-synced golden copy, not a live cross-repo import — the
 * same documented limitation as Feature 3's letterSupportLevelsParity.test.js
 * and Feature 4 Step 2's preWritingFamilyMapping parity test. Whenever
 * preWritingActivities.js's PRE_WRITING_ACTIVITIES changes (an activity
 * added/removed/reordered), this file and its parity test
 * (tests/preWritingActivityCatalog.test.js) must be updated together.
 *
 * Verified against the frontend catalogue as of Feature 4 Step 4:
 *   vertical_horizontal: 6 activities, curved: 6, diagonal: 6, mixed: 0.
 */

const PRE_WRITING_ACTIVITY_CATALOG = Object.freeze({
  vertical_horizontal: Object.freeze([
    'connect_vertical_dots',
    'connect_horizontal_dots',
    'trace_corner',
    'trace_cross',
    'trace_square',
    'trace_ladder',
  ]),
  curved: Object.freeze([
    'connect_curve_dots',
    'trace_half_circle_cw',
    'trace_half_circle_ccw',
    'trace_circle',
    'trace_spiral',
    'trace_figure_eight',
  ]),
  diagonal: Object.freeze([
    'trace_diagonal_forward',
    'trace_diagonal_back',
    'trace_zigzag',
    'trace_x',
    'trace_triangle',
    'trace_diamond',
  ]),
  // Mirrors preWritingActivities.js's GROUP_ACTIVITY_COUNT.mixed === 0 —
  // deliberately empty, never guessed/substituted (Feature 4 Step 1 audit
  // §14, Step 4 spec §13).
  mixed: Object.freeze([]),
});

/**
 * @param {string} primitiveGroup — 'vertical_horizontal'|'curved'|'diagonal'|'mixed'
 * @returns {string|null} the easiest (first, lowest difficulty_rank) activity
 *   id for this group, or null if the group has no catalogue activities
 *   (today: 'mixed') or is not a recognized group. Never throws, never
 *   guesses/substitutes a different group's activity.
 */
function getEasiestActivityId(primitiveGroup) {
  const ids = PRE_WRITING_ACTIVITY_CATALOG[primitiveGroup];
  return Array.isArray(ids) && ids.length > 0 ? ids[0] : null;
}

/**
 * @param {string} primitiveGroup
 * @returns {boolean} true only if this group has at least one catalogue
 *   activity. Kept separate from preWritingFamilyMapping.js's own
 *   `hasActivities`/`hasPreWritingActivitiesForPrimitiveGroup` (which is
 *   derived from the SAME underlying fact, documented in that file's own
 *   CATALOGUE_HAS_ACTIVITIES constant) — this local helper exists so
 *   activity-selection code in this file never needs to import the mapping
 *   config just to ask "does this group have an id list".
 */
function hasCatalogActivities(primitiveGroup) {
  return getEasiestActivityId(primitiveGroup) !== null;
}

module.exports = { PRE_WRITING_ACTIVITY_CATALOG, getEasiestActivityId, hasCatalogActivities };
