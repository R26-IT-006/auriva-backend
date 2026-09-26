'use strict';

// Feature 2 Step 1: append-only threshold CHANGE HISTORY / provenance store.
//
// This is NOT the live threshold store — students.personal_thresholds
// remains exactly as-is (see thresholdUtils.getStudentThreshold /
// recordLetterCompletion, both untouched by this migration). This table
// only records the trail of *why* a threshold became what it is, so a
// future automatic adjustment can detect and refuse to silently overwrite
// a teacher_override, and so a future "why did this change" explanation
// (Feature 2 audit §25) has real data to draw from.
//
// No FK constraint — matches existing convention in this schema
// (letter_attempts, shape_features, student_motor_baselines); integrity is
// enforced at the application layer.
//
// No updated_at — rows are never updated after creation. There is
// deliberately no PATCH/PUT/DELETE route for this table (none is created in
// this step at all — no API route exists yet).
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('student_threshold_history', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },

      // What this threshold event applies to. MVP supports family-level
      // events, but the existing system's real gate (recordLetterCompletion)
      // is per-letter/per-default — scope_type keeps this table honest about
      // that distinction rather than assuming everything is family-scoped
      // forever. VARCHAR (not a native Postgres enum) — same rationale as
      // letter_attempts.case_type: avoids enum-type management complexity on
      // rollback. Constrained at the Sequelize model layer instead
      // (validate: isIn) — see src/models/ThresholdHistory.js.
      scope_type: {
        type:      Sequelize.STRING(20),
        allowNull: false,
      },
      // e.g. 'curved', 'C', 'default' depending on scope_type.
      scope_key: {
        type:      Sequelize.STRING(20),
        allowNull: false,
      },

      // Nullable — only meaningful for scope_type='family' events. One of
      // straight/curved/complex (Feature 2's baseline family taxonomy only
      // — never 'mixed', see config/letterBaselineFamilies.js).
      baseline_family: {
        type:      Sequelize.STRING(20),
        allowNull: true,
      },

      // Nullable — an initial-creation event has no prior value.
      old_threshold: {
        type:      Sequelize.FLOAT,
        allowNull: true,
      },
      new_threshold: {
        type:      Sequelize.FLOAT,
        allowNull: false,
      },

      // Stable, closed vocabulary — constrained at the model layer.
      // initial_from_baseline | automatic | teacher_override | legacy
      source: {
        type:      Sequelize.STRING(30),
        allowNull: false,
      },
      // Short stable reason code, e.g. 'baseline_plus_margin',
      // '4_of_5_met_target', 'teacher_override', 'legacy_auto_lower' — never
      // long-form prose (length-capped, not free text).
      reason: {
        type:      Sequelize.STRING(100),
        allowNull: false,
      },

      // Conceptual, app-layer-only reference to student_motor_baselines.id
      // — nullable, since not every future threshold event will be
      // baseline-derived (e.g. a teacher_override event has no baseline tie).
      baseline_id: {
        type:      Sequelize.INTEGER,
        allowNull: true,
      },
      baseline_version: {
        type:      Sequelize.STRING(20),
        allowNull: true,
      },
      mapping_version: {
        type:      Sequelize.STRING(30),
        allowNull: true,
      },

      // Nullable now — recent-window calculation is explicitly NOT
      // implemented in this step. Reserved shape (future):
      // { scores: [...], metTarget: [...], windowSize: 5 }
      recent_window_snapshot: {
        type:      Sequelize.JSONB,
        allowNull: true,
      },

      created_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex(
      'student_threshold_history',
      ['student_id'],
      { name: 'student_threshold_history_student_id_idx' }
    );
    await queryInterface.addIndex(
      'student_threshold_history',
      ['baseline_family'],
      { name: 'student_threshold_history_baseline_family_idx' }
    );
    // Primary future query pattern: "history for this student's this
    // scope, most recent first" — covers scope_type/scope_key lookups
    // without a separate standalone created_at index (not independently
    // justified by any described query — see Step report for rationale).
    await queryInterface.addIndex(
      'student_threshold_history',
      ['student_id', 'scope_type', 'scope_key', 'created_at'],
      { name: 'student_threshold_history_scope_lookup_idx' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('student_threshold_history');
  },
};
