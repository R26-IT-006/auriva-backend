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
//
// ── Feature 9 repair (final integration audit finding, pre-deployment) ─────
// This migration was NEVER applied to any live/shared database (confirmed
// via a direct read-only query against production: the table is absent and
// this file is absent from SequelizeMeta) — it exists only in source. It is
// therefore edited IN PLACE here rather than superseded by a new corrective
// migration: no deployed environment's history depends on its original
// shape, so there is nothing to "correct after the fact." This is a
// deliberate exception to this project's normal rule (never edit an
// applied migration — see the 20260808000002/3 and 20260809000001 batch,
// which all *add* corrections rather than editing the original
// create-table migrations they follow) and applies ONLY because this file
// has zero deployment history. Once this migration is ever applied
// anywhere (including a shared dev/staging DB), it must never be edited
// again — only additive follow-up migrations from that point on.
//
// The original design (`docs/feature9-validation-history-design.md` §11)
// intended the semantic unique index below only to catch a literal
// same-button double-POST (a transport-level retry), not to prevent a
// teacher from legitimately alternating back to a previously-used
// `validation` value later. Because a UNIQUE constraint has no concept of
// "recency," it also silently blocked that legitimate case: a third action
// (Confirm→Dismiss→Confirm) collided with the FIRST historical Confirm row
// and `findOrCreate` returned that old row instead of appending a new one —
// so the newest teacher judgement was never recorded as newest. See the
// final integration audit's Feature 9 finding for the full reproduction.
//
// Fix: replace the semantic key with an explicit, client-generated
// `action_id` (UUID) — one value per submit *action* (a single button
// press), reused verbatim across any transport-level retry of that same
// action (client.js's response interceptor resends the identical request
// body), but a genuinely new value for every new button press. This
// correctly distinguishes "retry of the same action" from "a new action
// that happens to repeat an old value" — which the removed semantic key
// could not do. `action_id` follows this schema's own existing convention
// for a client/session-scoped grouping UUID (`letter_attempts.session_key`,
// `DataTypes.UUID`).
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
      // Client-generated, once per submit action (one Confirm/Not-suitable
      // button press) — the ONLY idempotency key for this table (see the
      // "Feature 9 repair" note above). Never derived from
      // student/teacher/case/family/validation/recommendation_fingerprint;
      // never reused across two distinct button presses, even if they
      // submit the identical validation value for the identical
      // recommendation instance.
      action_id: {
        type:      Sequelize.UUID,
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
    // Current-state query: "the latest event for THIS exact currently-
    // displayed recommendation instance" (getLatestValidationForRecommendation
    // — filters on all four columns, orders by created_at DESC, id DESC).
    // Added because this read happens on every recommendation-card render,
    // the highest-frequency Feature 9 query; the two indexes above don't
    // cover recommendation_fingerprint.
    await queryInterface.addIndex(
      'teacher_recommendation_validations',
      ['student_id', 'case_type', 'family', 'recommendation_fingerprint', 'created_at'],
      { name: 'teacher_recommendation_validations_current_state_idx' }
    );
    // Idempotency (repaired — see the "Feature 9 repair" note above): the
    // ONLY uniqueness constraint on this table. One row per client-generated
    // action_id — a transport-level retry of the SAME submit action (same
    // action_id) can never create a second row, but a genuinely new action
    // (new action_id) always can, even if it repeats an earlier
    // student/teacher/case/family/validation/fingerprint combination. This
    // is what makes legitimate alternating history
    // (Confirm→Dismiss→Confirm→Dismiss→...) possible — the previous
    // semantic key (student_id, teacher_id, case_type, family, validation,
    // recommendation_fingerprint) could not distinguish "the same action
    // retried" from "an old value legitimately chosen again later" and
    // incorrectly collapsed the two.
    await queryInterface.addIndex(
      'teacher_recommendation_validations',
      ['action_id'],
      { name: 'teacher_recommendation_validations_action_id_uniq', unique: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('teacher_recommendation_validations');
  },
};
