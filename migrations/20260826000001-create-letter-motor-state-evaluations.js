'use strict';

// Feature 11B — S2. One immutable row per (student, milestone,
// model_version) MILESTONE EVALUATION EVENT, recording what the frozen
// letter_motor_cluster_v1 evaluation actually concluded.
//
// ── Why a sibling table rather than nullable columns on
//    letter_motor_state_history ──────────────────────────────────────────
// letter_motor_state_history means, and has always meant, "a pattern was
// assigned to this student at this milestone." Every reader relies on that:
// getLatestLetterMotorState() returns its newest row as THE current state,
// getLetterMotorStateHistory() lists its rows as the pattern timeline, and
// periodicReportService reads state_as_of_end_date/milestones_during_period
// straight out of it.
//
// Relaxing cluster_id/state_code/display_name/nearest_distance/
// second_nearest_distance/separation_margin to nullable so a rejected
// evaluation could live in the same table would silently change that
// meaning for every existing row and every existing read — a
// pattern-less row would surface as "the current pattern" with a null
// label. This table instead records the evaluation event, leaving the
// pattern table's contract exactly as it is.
//
// An evaluation row is written for BOTH outcomes:
//   - 'assigned'                 alongside the letter_motor_state_history
//                                row, so the audit trail is complete;
//   - 'outside_reference_range'  on its own, with no history row at all —
//                                the guard declined to report a pattern,
//                                and nothing about that is a cluster
//                                assignment.
//
// Deliberately NOT recorded here: transient/blocking non-outcomes
// (ml_service_unavailable, version_mismatch, not_yet_eligible). Those are
// not evaluations — the model never reached a conclusion — and persisting
// them would wrongly suppress a later genuine retry.
//
// No FK constraints — same no-FK convention as every other table in this
// schema.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('letter_motor_state_evaluations', {
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
      // — see src/config/letterMotorMilestones.js. Plain STRING, matching
      // this schema's rollback-safety convention for evolving vocabularies.
      milestone: {
        type:      Sequelize.STRING(40),
        allowNull: false,
      },
      coverage_n: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      // Number of frozen evidence rows this evaluation actually aggregated.
      // Always equals coverage_n for a real milestone evaluation; stored
      // separately so a future reader can verify that rather than assume it.
      evidence_row_count: {
        type:      Sequelize.INTEGER,
        allowNull: false,
      },
      observed_at: {
        type:      Sequelize.DATE,
        allowNull: false,
      },

      // 'assigned' | 'outside_reference_range'. Never 'PATTERN_C', never a
      // severity, never a clinical category.
      evaluation_status: {
        type:      Sequelize.STRING(40),
        allowNull: false,
      },
      // Denormalized convenience flag for reporting reads, always the exact
      // inverse of evaluation_status === 'outside_reference_range'.
      inside_reference_range: {
        type:      Sequelize.BOOLEAN,
        allowNull: false,
      },

      // The aggregated (arithmetic mean over exactly this milestone's
      // required evidence rows) vector actually sent to the model — the
      // same three values letter_motor_state_history stores for an assigned
      // pattern, so a rejected evaluation is equally inspectable.
      smoothness_score: { type: Sequelize.FLOAT, allowNull: false },
      dtw_distance:     { type: Sequelize.FLOAT, allowNull: false },
      speed_cv:         { type: Sequelize.FLOAT, allowNull: false },

      // Reference-range guard diagnostics, copied VERBATIM from the ML
      // service's own `ood` object. Nothing here is computed by the backend
      // and nothing is interpreted — these are the guard's own geometric
      // outputs, never a score, confidence, probability or severity.
      //   ood_reason           e.g. 'dtw_distance_outside_reference_range'
      //   ood_triggered_by     e.g. ['feature:dtw_distance']
      //   ood_outside_features e.g. ['dtw_distance']
      //   ood_detail           the whole `ood` object, for full auditability
      ood_reason:           { type: Sequelize.STRING(80), allowNull: true },
      ood_triggered_by:     { type: Sequelize.JSONB,      allowNull: true },
      ood_outside_features: { type: Sequelize.JSONB,      allowNull: true },
      ood_detail:           { type: Sequelize.JSONB,      allowNull: true },

      model_version: { type: Sequelize.STRING(40), allowNull: false },

      // Provenance snapshot of this milestone's evidence rows' shared
      // (enforced identical, never mixed) version trio.
      feature_version:       { type: Sequelize.STRING(20), allowNull: false },
      template_version:      { type: Sequelize.STRING(20), allowNull: false },
      normalization_version: { type: Sequelize.STRING(20), allowNull: false },

      created_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
      updated_at: { type: Sequelize.DATE, defaultValue: Sequelize.fn('NOW') },
    });

    // Reporting reads: "the latest evaluation for this student up to a date."
    await queryInterface.addIndex(
      'letter_motor_state_evaluations',
      ['student_id', 'observed_at'],
      { name: 'letter_motor_state_evaluations_student_observed_idx' }
    );

    // Idempotency — the SAME key letter_motor_state_history uses. A repeated
    // milestone check for an already-evaluated (student, milestone,
    // model_version) triple must never create a duplicate evaluation event.
    await queryInterface.addIndex(
      'letter_motor_state_evaluations',
      ['student_id', 'milestone', 'model_version'],
      { name: 'letter_motor_state_evaluations_idempotency_uniq', unique: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('letter_motor_state_evaluations');
  },
};
