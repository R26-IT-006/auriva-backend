'use strict';

// Feature 2 Step 3: DB-backed idempotency for initial-from-baseline family
// threshold events, on top of the student_threshold_history table created in
// migrations/20260808000001-create-student-threshold-history.js. Narrowly
// scoped — this migration adds exactly one index, no other column/table
// touched.
//
// A PARTIAL unique index (Postgres-specific: WHERE source = 'initial_from_baseline')
// rather than a table-wide unique constraint, because ThresholdHistory must
// stay free to record many 'automatic'/'teacher_override' events over a
// student's lifetime for the same (student, family) — only the ONE-TIME
// "initial threshold derived from this exact baseline + mapping version"
// event needs to be unique. Scoping the constraint to source =
// 'initial_from_baseline' guarantees it can never block a future automatic
// or teacher_override row.
//
// This is also why baseline_id and mapping_version are both part of the key,
// not just student_id + scope_key: initialization is tied to a specific
// baseline/mapping combination, not freely re-runnable — running the same
// initialization again with a different margin (or after the mapping file
// is later revised) must resolve to already_initialized, never a silent
// second event overwriting/duplicating the first (see dynamicThresholdService.js).
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('student_threshold_history',
      ['student_id', 'scope_type', 'scope_key', 'baseline_id', 'mapping_version'],
      {
        name:   'student_threshold_history_initial_family_uniq',
        unique: true,
        where:  { source: 'initial_from_baseline' },
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('student_threshold_history', 'student_threshold_history_initial_family_uniq');
  },
};
