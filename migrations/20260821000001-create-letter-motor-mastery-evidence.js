'use strict';

// Feature 11B Phase 5 — one row per (student, reference letter) FROZEN
// motor-evidence observation, created the first time that letter becomes
// authoritatively mastered (a LetterProgress row exists for it — see
// letterMotorMasteryService.js's onLetterMastered()). Immutable once
// created (spec §11) — no route/service in this codebase ever calls
// .update()/.destroy() on an existing row.
//
// Supersedes Phase 4's letter_motor_reassessments design (an explicit
// 20-letter reassessment SESSION concept), which this Phase 5 spec
// explicitly rejected as not matching Auriva's adaptive-learning design.
// That migration was never applied to any database (confirmed unrun in
// the Phase 4 final report) and has been deleted outright rather than left
// as unused dead code — see this feature's Phase 5 final report for the
// full disposition rationale. letter_attempts.source_type (Phase 4,
// 20260820000001) is UNCHANGED and remains required infrastructure: every
// eligibility check here still requires source_type IS NULL (spec §9).
//
// No FK constraints — matches this schema's existing convention
// (letter_attempts, shape_features, student_motor_baselines,
// teacher_recommendation_validations, letter_progress); integrity is
// enforced at the application layer via teacherService.getOwnStudentById.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('letter_motor_mastery_evidence', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      student_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      letter: {
        type:      Sequelize.CHAR(1),
        allowNull: false,
      },
      case_type: {
        type:      Sequelize.STRING(10),
        allowNull: false,
      },

      // The exact LetterAttempt row this evidence was frozen from — the
      // attempt_number=3, support_level='low' row of the FIRST session in
      // which this letter became mastered (spec §8). No FK constraint
      // (schema convention), but always populated — kept for auditability
      // so a later question ("which raw attempt produced this?") never
      // requires guessing.
      letter_attempt_id: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      mastered_at: {
        type:      Sequelize.DATE,
        allowNull: false,
      },

      // Verbatim copy of the source row's own normalized_features — never
      // re-derived later, so this evidence stays frozen even if
      // normalizeLetterFeatures() itself changes in the future.
      smoothness_score: { type: Sequelize.FLOAT, allowNull: false },
      dtw_distance:     { type: Sequelize.FLOAT, allowNull: false },
      speed_cv:         { type: Sequelize.FLOAT, allowNull: false },

      // Always 'low' by construction (spec §9) — stored explicitly rather
      // than assumed, so a reader never has to trust an unstated invariant.
      support_level: { type: Sequelize.STRING(10), allowNull: false },

      feature_version:       { type: Sequelize.STRING(20), allowNull: false },
      template_version:      { type: Sequelize.STRING(20), allowNull: false },
      normalization_version: { type: Sequelize.STRING(20), allowNull: false },

      created_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
    });

    // Idempotency — one evidence row per (student, letter, case_type),
    // ever (spec §10/§11: "unique logically on student_id + letter +
    // case_type"). A second onLetterMastered() call for an
    // already-evidenced letter resolves to the existing row.
    await queryInterface.addIndex(
      'letter_motor_mastery_evidence',
      ['student_id', 'letter', 'case_type'],
      { name: 'letter_motor_mastery_evidence_student_letter_case_uniq', unique: true }
    );

    // Milestone-check read pattern: "give me all evidence for this student."
    await queryInterface.addIndex(
      'letter_motor_mastery_evidence',
      ['student_id'],
      { name: 'letter_motor_mastery_evidence_student_idx' }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('letter_motor_mastery_evidence');
  },
};
