'use strict';

// Writing Check (Letter Motor Pattern Check) — the dedicated, teacher-initiated
// route for letter_motor_cluster_v1.
//
// ── Why this exists ────────────────────────────────────────────────────────
// The frozen model was fitted on 7 participants x 20 reference letters captured
// under the COLLECTION protocol, where attempt 3 renders a faded ghost guide
// (guideOpacity 0.26 — see handwritingSupportLevels.js's collection-low
// override). Normal learning renders NO guide at attempt 3 (opacity 0), so the
// child writes from memory. Live data shows the consequence directly: mean DTW
// 14.58 under collection vs 29.48 under normal practice, roughly double within
// the same students. The model was therefore correctly refusing to score
// normal-practice evidence — a different task.
//
// A Writing Check re-runs the EXACT training protocol, so the model receives
// the input distribution it was fitted on. Nothing about the model, the scaler,
// the cluster centres, the feature order or the reference-range guard changes.
//
// ── What this table is NOT ─────────────────────────────────────────────────
// It is not mastery, not progression, not a milestone. It never gates a
// child-facing decision. Its attempt rows are written with collection_mode =
// true, which every normal-learning query in this codebase already excludes.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('letter_motor_pattern_checks', {
      id: {
        type:          Sequelize.INTEGER,
        primaryKey:    true,
        autoIncrement: true,
      },
      student_id: { type: Sequelize.INTEGER, allowNull: false },

      // The collection session whose attempt rows belong to this check. One
      // collection session belongs to exactly one Writing Check (unique below),
      // so a check's evidence can never be assembled from mixed sources.
      collection_session_id: { type: Sequelize.UUID, allowNull: false },

      // 'in_progress' | 'completed' | 'evaluated' | 'evaluation_failed'
      //   in_progress       — capture under way, fewer than 20 pairs captured
      //   completed         — all 20 required pairs captured, not yet evaluated
      //   evaluated         — the frozen model produced a result (assigned OR
      //                       outside_reference_range); both are real outcomes
      //   evaluation_failed — the ML service could not be reached. Retryable;
      //                       nothing is persisted as a result.
      status: { type: Sequelize.STRING(24), allowNull: false, defaultValue: 'in_progress' },

      started_at:   { type: Sequelize.DATE, allowNull: false },
      completed_at: { type: Sequelize.DATE, allowNull: true },

      // How many of the 20 required pairs currently have a valid attempt-3 row.
      // Denormalized for cheap progress reads; the authoritative check always
      // re-derives it from letter_attempts before evaluating.
      letters_captured: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

      // Stamped only once the model has actually run, so a check can never
      // claim a model version it was never scored by.
      model_version: { type: Sequelize.STRING(40), allowNull: true },

      created_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
    });

    // One collection session belongs to exactly one Writing Check.
    await queryInterface.addIndex(
      'letter_motor_pattern_checks',
      ['collection_session_id'],
      { name: 'letter_motor_pattern_checks_session_uniq', unique: true }
    );

    // "This student's checks, newest first" — the teacher history read.
    await queryInterface.addIndex(
      'letter_motor_pattern_checks',
      ['student_id', 'started_at'],
      { name: 'letter_motor_pattern_checks_student_started_idx' }
    );

    // ── Link model results to the check that produced them ─────────────────
    for (const table of ['letter_motor_state_history', 'letter_motor_state_evaluations']) {
      await queryInterface.addColumn(table, 'pattern_check_id', {
        type:      Sequelize.INTEGER,
        allowNull: true,
      });
    }

    // ── Uniqueness, split so the two routes can never collide ──────────────
    //
    // The old key was (student_id, milestone, model_version). Simply adding
    // pattern_check_id to it would BREAK milestone uniqueness: Postgres treats
    // NULLs as distinct in a unique index, so every milestone row (all of which
    // have a NULL pattern_check_id) would become mutually non-conflicting.
    //
    // Two PARTIAL indexes instead:
    //   - milestone rows  (pattern_check_id IS NULL): the ORIGINAL key,
    //     byte-for-byte, so legacy 14/17/20 semantics are preserved exactly.
    //   - Writing Check rows (pattern_check_id IS NOT NULL): keyed on the check
    //     itself, so repeated checks for the same student under the same model
    //     version each get their own row and never overwrite one another.
    for (const table of ['letter_motor_state_history', 'letter_motor_state_evaluations']) {
      const legacyName = `${table}_idempotency_uniq`;
      await queryInterface.removeIndex(table, legacyName);
      await queryInterface.addIndex(table, ['student_id', 'milestone', 'model_version'], {
        name:   legacyName,
        unique: true,
        where:  { pattern_check_id: null },
      });
      await queryInterface.addIndex(table, ['pattern_check_id', 'model_version'], {
        name:   `${table}_check_uniq`,
        unique: true,
        where:  { pattern_check_id: { [Sequelize.Op.ne]: null } },
      });
    }
  },

  async down(queryInterface, Sequelize) {
    for (const table of ['letter_motor_state_history', 'letter_motor_state_evaluations']) {
      await queryInterface.removeIndex(table, `${table}_check_uniq`);
      await queryInterface.removeIndex(table, `${table}_idempotency_uniq`);
      await queryInterface.addIndex(table, ['student_id', 'milestone', 'model_version'], {
        name: `${table}_idempotency_uniq`, unique: true,
      });
      await queryInterface.removeColumn(table, 'pattern_check_id');
    }
    await queryInterface.dropTable('letter_motor_pattern_checks');
  },
};
