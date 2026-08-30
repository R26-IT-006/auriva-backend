'use strict';

// Motor Score Unification (spec §6-§9, §24) — additive-only migration.
//
// student_motor_baselines: three NEW, nullable columns holding the
// AUTHORITATIVE (computeMotorScore-domain) family-averaged baseline,
// computed from ShapeFeature.motor_score. The EXISTING straight_score/
// curved_score/complex_score columns are left completely untouched — they
// remain Feature 11A's frozen research feature-representation input
// (computeUnifiedShapeScore domain) and MUST NOT be repointed at the new
// domain (spec §21 — Feature 11A's frozen model was trained against that
// exact existing domain). NULL for every existing/historical row —
// deliberately not backfilled (spec §8/§25 — do not rewrite historical
// baseline rows automatically).
//
// letter_attempts / letter_progress: one NEW, nullable STRING column each,
// recording which progression-scoring regime governed that row's
// pass/fail or mastery decision. NULL means "created before this phase —
// legacy featuresToScore-governed regime" (spec §24/§25 — historical rows
// are facts, never rewritten). A real value (see
// config/motorScoreRegime.js) means "created under the new
// computeMotorScore-governed regime."
//
// NOT RUN AGAINST AZURE. See the Motor Score Unification final report for
// migration status.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('student_motor_baselines', 'progression_straight_score', {
      type:      Sequelize.FLOAT,
      allowNull: true,
    });
    await queryInterface.addColumn('student_motor_baselines', 'progression_curved_score', {
      type:      Sequelize.FLOAT,
      allowNull: true,
    });
    await queryInterface.addColumn('student_motor_baselines', 'progression_complex_score', {
      type:      Sequelize.FLOAT,
      allowNull: true,
    });

    await queryInterface.addColumn('letter_attempts', 'progression_score_version', {
      type:      Sequelize.STRING(20),
      allowNull: true,
    });

    await queryInterface.addColumn('letter_progress', 'progression_score_version', {
      type:      Sequelize.STRING(20),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('student_motor_baselines', 'progression_straight_score');
    await queryInterface.removeColumn('student_motor_baselines', 'progression_curved_score');
    await queryInterface.removeColumn('student_motor_baselines', 'progression_complex_score');
    await queryInterface.removeColumn('letter_attempts', 'progression_score_version');
    await queryInterface.removeColumn('letter_progress', 'progression_score_version');
  },
};
