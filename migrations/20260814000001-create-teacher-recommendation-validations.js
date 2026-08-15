'use strict';

// Feature 9 Step 3: append-only teacher-validation history for Feature 8
// worksheet recommendations.
//
// This is NOT a mutable "current judgement" table and NOT a reuse of any
// existing, unrelated table: `teacher_validation` (collection-mode quality
// ratings, keyed by collection_session_id), `recommendation_history` and
// `explanation_results` (the separate initial-assessment explainability
// system), and `persistent_difficulty_history` (Feature 7's own still-
// deferred, never-created design) are all distinct concepts — see
// docs/feature9-validation-history-design.md for the full rationale.
//
// Every row is one teacher action (Confirm / Not suitable) on one specific,
// server-verified Feature 8 recommendation instance. Rows are never updated
// or deleted — a changed judgement appends a new row (see `validation` +
// the idempotency index below). No FK constraints — matches this schema's
// existing convention (letter_attempts, shape_features,
// student_threshold_history, student_motor_baselines); integrity is
// enforced at the application layer via teacherService.getOwnStudentById
// (Step 1 audit §9/§10, Step 4).
//
// No updated_at — rows are immutable after creation, and no PATCH/PUT/
// DELETE route exists (none is created in this step at all — no API route
// exists yet, that is Step 4).
//
// Convention note: this migration follows the plain createTable/addIndex
// shape used by the two most recent "create a new table" migrations
// (20260807000001-create-student-motor-baselines.js,
// 20260808000001-create-student-threshold-history.js) rather than the
// older tableExists/indexExists idempotent-check helper used in the
// 20260714 batch — that helper existed to guard against a one-time
// historical circumstance (sync({alter:true}) racing ahead of migrations
// on server boot for tables that were brand new at the time); it is not
// this codebase's current standing convention for a new table.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('teacher_recommendation_validations', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      // Always the authenticated teacher's own id (req.user.id) — never
      // client-supplied (Step 1 audit §9/§43, Step 2 design doc §9).
      teacher_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },

      // One of Feature 7/8's own six-stream taxonomy values — constrained
      // at the model layer (validate: isIn), matching
      // student_threshold_history.scope_type's own STRING-not-native-enum
      // convention.
      case_type: {
        type:      Sequelize.STRING(20),
        allowNull: false,
      },
      family: {
        type:      Sequelize.STRING(20),
        allowNull: false,
      },

      // Currently only 'motor_family_practice' (Feature 8's sole type) —
      // stored as an open string rather than a hard 1-value check, so a
      // future second Feature 8 recommendation type does not require a
      // migration here.
      recommendation_type: {
        type:      Sequelize.STRING(50),
        allowNull: false,
      },
      // Snapshot of what the teacher actually saw — never re-derived later
      // by re-running Feature 8 (Step 2 design doc §6).
      recommendation_title: {
        type:      Sequelize.STRING(200),
        allowNull: false,
      },

      focus_letters: {
        type:      Sequelize.JSONB,
        allowNull: false,
      },
      suggested_activities: {
        type:      Sequelize.JSONB,
        allowNull: false,
      },
      rationale: {
        type:      Sequelize.TEXT,
        allowNull: false,
      },

      // 'confirmed' | 'dismissed' only — constrained at the model layer.
      validation: {
        type:      Sequelize.STRING(20),
        allowNull: false,
      },
      // Optional teacher note. Nullable — empty/whitespace-only input is
      // normalized to NULL at the service layer (Step 3 spec §17), never an
      // empty string.
      teacher_note: {
        type:      Sequelize.TEXT,
        allowNull: true,
      },

      // sha256 hex digests from src/config/feature9Provenance.js — see
      // that module's own header for exactly what each identifies.
      evidence_fingerprint: {
        type:      Sequelize.STRING(64),
        allowNull: false,
      },
      recommendation_fingerprint: {
        type:      Sequelize.STRING(64),
        allowNull: false,
      },

      // Provenance snapshot — the exact policy/mapping versions active when
      // this event was written, never re-derived from today's constants
      // when reading an old row.
      persistent_policy_version: {
        type:      Sequelize.STRING(30),
        allowNull: false,
      },
      recommendation_policy_version: {
        type:      Sequelize.STRING(30),
        allowNull: false,
      },
      mapping_version: {
        type:      Sequelize.STRING(30),
        allowNull: false,
      },

      created_at: {
        type:         Sequelize.DATE,
        defaultValue: Sequelize.fn('NOW'),
      },
    });

    // History query: "everything for this student, newest first".
    await queryInterface.addIndex(
      'teacher_recommendation_validations',
      ['student_id', 'created_at'],
      { name: 'teacher_recommendation_validations_student_created_idx' }
    );
    // Stream-history query: "everything for this student's this stream,
    // newest first" (Step 2 design doc §13's stream-level history).
    await queryInterface.addIndex(
      'teacher_recommendation_validations',
      ['student_id', 'case_type', 'family', 'created_at'],
      { name: 'teacher_recommendation_validations_stream_lookup_idx' }
    );
    // Idempotency: same teacher + same recommendation instance + same
    // action can never be written twice (Step 3 spec §26/§27). Deliberately
    // NOT (student_id, case_type, family) alone — that would prevent the
    // required history entirely. Deliberately NOT partial/conditional
    // (unlike student_threshold_history's own evidence_fingerprint index)
    // — every column here is always NOT NULL, so no WHERE clause is needed.
    // Including `validation` in the key means confirmed+dismissed for the
    // identical recommendation_fingerprint remain two distinct, valid rows.
    await queryInterface.addIndex(
      'teacher_recommendation_validations',
      ['student_id', 'teacher_id', 'case_type', 'family', 'validation', 'recommendation_fingerprint'],
      { name: 'teacher_recommendation_validations_idempotency_uniq', unique: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('teacher_recommendation_validations');
  },
};
