'use strict';

// Feature 1: Individual Motor-Family Baseline.
//
// Immutable historical snapshot of a student's initial-assessment motor
// scores (straight/curved/complex), copied verbatim from
// HandwritingAssessment.motor_profile / motor_score at finalize time — see
// src/services/motorBaselineService.js. Never updated after creation: no
// updated_at column, and application code exposes no PUT/PATCH/DELETE for
// this table (see handwritingController.finalizeAssessment).
//
// No FK constraint — matches existing convention in this schema
// (letter_attempts, shape_features, collection_sessions); integrity is
// enforced at the application layer.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('student_motor_baselines', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      // One baseline per source assessment — enforced via UNIQUE index below.
      // This is the idempotency guarantee: a retried/duplicate finalize call
      // for the same assessment can never create a second baseline row.
      source_assessment_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },

      // Copied verbatim from HandwritingAssessment.motor_profile — never
      // recalculated here (see calculateMotorProfile() in
      // frontend/src/utils/adaptiveSequencing.js, the single source of truth).
      straight_score: {
        type:      Sequelize.FLOAT,
        allowNull: false,
      },
      curved_score: {
        type:      Sequelize.FLOAT,
        allowNull: false,
      },
      complex_score: {
        type:      Sequelize.FLOAT,
        allowNull: false,
      },
      // Copied verbatim from HandwritingAssessment.motor_score.
      overall_motor_score: {
        type:      Sequelize.FLOAT,
        allowNull: false,
      },

      // Schema/versioning of this baseline record shape, independent of the
      // score-family taxonomy below — bump if student_motor_baselines' own
      // columns change shape in a future migration.
      baseline_version: {
        type:         Sequelize.STRING(20),
        allowNull:    false,
        defaultValue: 'baseline-v1',
      },
      // Which motor-family taxonomy straight_score/curved_score/complex_score
      // belong to. Deliberately NOT the vertical_horizontal/curved/diagonal/mixed
      // taxonomy used by config/letterMotorPrimitives.js for the Teacher
      // Report's Motor Pattern Progress section — that is a separate,
      // pre-existing taxonomy and reconciling the two is out of scope for
      // this feature. Recorded so a future migration can convert safely.
      taxonomy_version: {
        type:         Sequelize.STRING(20),
        allowNull:    false,
        defaultValue: 'assessment-motor-v1',
      },
      // How this baseline came to exist: 'initial_assessment' (normal finalize
      // flow) or 'backfill' (src/scripts/backfillMotorBaselines.js, for
      // students whose initial assessment predates this feature).
      source_type: {
        type:         Sequelize.STRING(30),
        allowNull:    false,
        defaultValue: 'initial_assessment',
      },

      is_backfilled: {
        type:         Sequelize.BOOLEAN,
        allowNull:    false,
        defaultValue: false,
      },
      backfilled_at: {
        type:      Sequelize.DATE,
        allowNull: true,
      },

      // No updated_at — this record is immutable by design, not just by
      // convention: application code exposes no route that can modify it
      // after creation.
      created_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    await queryInterface.addIndex(
      'student_motor_baselines',
      ['source_assessment_id'],
      { name: 'student_motor_baselines_source_assessment_id_unique', unique: true }
    );
    await queryInterface.addIndex(
      'student_motor_baselines',
      ['student_id'],
      { name: 'student_motor_baselines_student_id_idx' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('student_motor_baselines');
  },
};
