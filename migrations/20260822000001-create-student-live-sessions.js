'use strict';

// Proposal FR-16, Phase 7B — CURRENT LIVE STATE ONLY (spec §7). This table
// never duplicates LetterAttempt/LetterProgress/WordWritingAttempt/Feature
// 11 history — it holds exactly one row per student, upserted in place, so
// there is structurally no way for it to accumulate unbounded rows.
//
// student_id is the PRIMARY KEY (not a separate UUID/serial id) precisely
// to guarantee "one current live-session row per student" (spec §6) at the
// schema level, not just by application discipline.
//
// ADDITIVE ONLY — creates one new table, touches nothing existing.
// NOT RUN AGAINST AZURE. See the Phase 7B final report for migration
// status and the explicit instruction this was authored under.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('student_live_handwriting_sessions', {
      // No FK constraint — matches this schema's existing convention
      // (letter_attempts, shape_features, collection_sessions); integrity
      // enforced at the app layer via teacherService.getOwnStudentById.
      student_id: {
        type:       Sequelize.INTEGER,
        primaryKey: true,
        allowNull:  false,
      },
      // VARCHAR, not a native Postgres enum — same rationale as
      // capture_status on collection_sessions: avoids enum-type management
      // complexity on rollback. Validated server-side against
      // config/liveSessionPolicy.js's LIVE_ACTIVITY_TYPES.
      activity_type: {
        type:      Sequelize.STRING(20),
        allowNull: false,
      },
      // Validated against LIVE_SESSION_STATUSES: active | break | ended.
      status: {
        type:      Sequelize.STRING(10),
        allowNull: false,
      },
      // current_letter OR current_word — one generic field (spec §6's own
      // conceptual schema), never two separate columns.
      current_item: {
        type:      Sequelize.STRING(30),
        allowNull: true,
      },
      case_type: {
        type:      Sequelize.STRING(10),
        allowNull: true,
      },
      attempt_number: {
        type:      Sequelize.INTEGER,
        allowNull: true,
      },
      support_level: {
        type:      Sequelize.STRING(20),
        allowNull: true,
      },
      elapsed_active_seconds: {
        type:         Sequelize.INTEGER,
        allowNull:    false,
        defaultValue: 0,
      },
      latest_saved_score: {
        type:      Sequelize.FLOAT,
        allowNull: true,
      },
      // Set once when a session begins (status transitions from
      // absent/'ended' to 'active') and preserved across subsequent
      // updates within the same visit — never reset on every letter/word
      // change (spec §17).
      started_at: {
        type:      Sequelize.DATE,
        allowNull: false,
      },
      // Updated on every write. The teacher-facing LIVE/STALE distinction
      // (spec §13) is computed from this field, server-side, against
      // STALE_THRESHOLD_SECONDS.
      last_updated_at: {
        type:      Sequelize.DATE,
        allowNull: false,
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('student_live_handwriting_sessions');
  },
};
