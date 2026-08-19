'use strict';

// Feature 11B Phase 4 — one row per COMPLETED standardized Letter Motor
// Reassessment (the aggregated result of exactly 20 valid, low-support,
// version-consistent raw LetterAttempt observations — see
// letterMotorReassessmentService.js). Never a partial/in-progress row: a
// reassessment session that hasn't reached 20/20 valid letters simply has
// no row here yet.
//
// No FK constraints — matches this schema's existing convention
// (letter_attempts, shape_features, student_threshold_history,
// student_motor_baselines, teacher_recommendation_validations); integrity
// is enforced at the application layer via teacherService.getOwnStudentById.
//
// reassessment_session_id is the SAME UUID value shared by all 20 raw
// LetterAttempt rows that fed this result (stored in their own
// session_key column — see Phase 3/4 design: session_key was judged
// reusable rather than adding yet another grouping column to
// letter_attempts). NOT collection_session_id — a completely separate,
// temporary, research-only concept this feature never touches.
//
// Idempotency: (student_id, reassessment_session_id, model_version) is
// unique — a second finalize request for an already-completed session
// resolves to the existing row (see the service's own idempotency logic),
// never a duplicate.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('letter_motor_reassessments', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      reassessment_session_id: {
        type:      Sequelize.UUID,
        allowNull: false,
      },
      completed_at: {
        type:      Sequelize.DATE,
        allowNull: false,
      },

      // Aggregated (arithmetic mean, exactly matching Colab training
      // aggregation) input vector — the raw values actually sent to
      // letter_motor_cluster_v1, kept verbatim for auditability.
      smoothness_score: { type: Sequelize.FLOAT, allowNull: false },
      dtw_distance:     { type: Sequelize.FLOAT, allowNull: false },
      speed_cv:         { type: Sequelize.FLOAT, allowNull: false },

      // Prediction result — verbatim from auriva-ml-service's response,
      // never re-derived/renamed.
      cluster_id:   { type: Sequelize.INTEGER,    allowNull: false },
      state_code:   { type: Sequelize.STRING(40), allowNull: false },
      display_name: { type: Sequelize.STRING(80), allowNull: false },

      nearest_distance:        { type: Sequelize.FLOAT, allowNull: false },
      second_nearest_distance: { type: Sequelize.FLOAT, allowNull: false },
      separation_margin:       { type: Sequelize.FLOAT, allowNull: false },

      model_version: { type: Sequelize.STRING(40), allowNull: false },

      // Provenance snapshot of the 20 source rows' shared (enforced
      // identical, never mixed) version trio — never re-derived from
      // today's constants when reading an old row.
      feature_version:        { type: Sequelize.STRING(20), allowNull: false },
      template_version:       { type: Sequelize.STRING(20), allowNull: false },
      normalization_version:  { type: Sequelize.STRING(20), allowNull: false },

      created_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
      updated_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    // History / latest-result query: "everything for this student, newest first".
    await queryInterface.addIndex(
      'letter_motor_reassessments',
      ['student_id', 'completed_at'],
      { name: 'letter_motor_reassessments_student_completed_idx' }
    );

    // Idempotency — the ONLY uniqueness constraint on this table. A second
    // finalize request for the same (student, session, model version) can
    // never create a second row.
    await queryInterface.addIndex(
      'letter_motor_reassessments',
      ['student_id', 'reassessment_session_id', 'model_version'],
      { name: 'letter_motor_reassessments_idempotency_uniq', unique: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('letter_motor_reassessments');
  },
};
