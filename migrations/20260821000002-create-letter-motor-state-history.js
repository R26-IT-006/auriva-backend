'use strict';

// Feature 11B Phase 5 — one row per (student, milestone, model_version)
// PERSISTED K=2 prediction snapshot, created only at the three pilot
// cluster-eligibility milestones (UPPERCASE_STRAIGHT_14,
// UPPERCASE_CURVED_17, FULL_REFERENCE_20 — see
// src/config/letterMotorMilestones.js). Deliberately NO rows for the
// earlier 3/7/10 trend-only checkpoints (spec §12/§18) — those are
// evidence/trend display only, never a persisted "state."
//
// This table's shape reuses the design of Phase 4's now-deleted
// letter_motor_reassessments table (aggregated features + prediction +
// version metadata), since that shape turned out to be exactly what a
// milestone snapshot needs — only the grouping key changed
// (reassessment_session_id -> milestone, a fixed enum-like code rather
// than a per-session UUID). Phase 4's migration was never applied to any
// database, so this is a clean replacement, not a live-schema rename —
// see this feature's Phase 5 final report for the disposition audit.
//
// No FK constraints — same no-FK convention as every other table in this
// schema.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('letter_motor_state_history', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },

      // 'UPPERCASE_STRAIGHT_14' | 'UPPERCASE_CURVED_17' | 'FULL_REFERENCE_20'
      // — see letterMotorMilestones.js. Plain STRING (not a native
      // Postgres ENUM), matching this schema's rollback-safety convention
      // for young/evolving vocabularies (support_level, demo_speed_level,
      // source_type all made the same choice).
      milestone: {
        type:      Sequelize.STRING(40),
        allowNull: false,
      },
      coverage_n: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      // {caseType, category} of the category-completion event that made
      // this milestone eligible — e.g. {"caseType":"uppercase","category":"straight"}.
      // Stored as JSON purely for human/report readability; never queried by field.
      completed_category: {
        type:      Sequelize.JSONB,
        allowNull: false,
      },
      observed_at: {
        type:      Sequelize.DATE,
        allowNull: false,
      },

      // Aggregated (arithmetic mean over exactly this milestone's required
      // evidence rows) input vector actually sent to letter_motor_cluster_v1.
      smoothness_score: { type: Sequelize.FLOAT, allowNull: false },
      dtw_distance:     { type: Sequelize.FLOAT, allowNull: false },
      speed_cv:         { type: Sequelize.FLOAT, allowNull: false },

      // Prediction result — verbatim from auriva-ml-service's response.
      cluster_id:   { type: Sequelize.INTEGER,    allowNull: false },
      state_code:   { type: Sequelize.STRING(40), allowNull: false },
      display_name: { type: Sequelize.STRING(80), allowNull: false },

      nearest_distance:        { type: Sequelize.FLOAT, allowNull: false },
      second_nearest_distance: { type: Sequelize.FLOAT, allowNull: false },
      separation_margin:       { type: Sequelize.FLOAT, allowNull: false },

      model_version: { type: Sequelize.STRING(40), allowNull: false },

      // Provenance snapshot of this milestone's evidence rows' shared
      // (enforced identical, never mixed) version trio.
      feature_version:       { type: Sequelize.STRING(20), allowNull: false },
      template_version:      { type: Sequelize.STRING(20), allowNull: false },
      normalization_version: { type: Sequelize.STRING(20), allowNull: false },

      created_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
    });

    // Latest-state / history reads: "everything for this student, ordered."
    await queryInterface.addIndex(
      'letter_motor_state_history',
      ['student_id', 'observed_at'],
      { name: 'letter_motor_state_history_student_observed_idx' }
    );

    // Idempotency (spec §19) — a repeated milestone check for an
    // already-recorded (student, milestone, model_version) triple must
    // never create a duplicate.
    await queryInterface.addIndex(
      'letter_motor_state_history',
      ['student_id', 'milestone', 'model_version'],
      { name: 'letter_motor_state_history_idempotency_uniq', unique: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('letter_motor_state_history');
  },
};
