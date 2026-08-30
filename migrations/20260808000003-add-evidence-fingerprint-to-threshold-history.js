'use strict';

// Feature 2 Step 6B: narrowly-scoped addition for AUTOMATIC threshold
// idempotency only. Adds exactly one nullable column and exactly one
// partial unique index — no other column touched, no existing row modified.
//
// Why a new column rather than reusing an existing one: the table has no
// field that can safely double as an evidence identifier without overloading
// its real meaning —
//   - `reason` is a short, closed-vocabulary string (e.g. '4_or_5_met_target')
//     shared across ALL sources; hiding a fingerprint inside it would break
//     that vocabulary and make `reason` simultaneously mean two different
//     things depending on `source` (explicitly disallowed by Step 6B).
//   - `recent_window_snapshot` is real, useful JSONB diagnostic data (scores,
//     metTarget, attemptIds) that must remain human/audit-readable — folding
//     a hash into it would mix a machine idempotency key into a payload
//     that's meant to explain *why* a decision was made, and would require
//     an index expression on a JSONB path instead of a plain column.
// A dedicated `evidence_fingerprint` column keeps the idempotency key
// explicit, directly indexable, and orthogonal to both.
//
// Existing 'initial_from_baseline' and 'teacher_override' rows are
// unaffected — they simply keep evidence_fingerprint = NULL, matching their
// own existing uniqueness strategies (Step 3's baseline_id/mapping_version
// key for the former; no uniqueness at all, by design, for the latter). The
// partial unique index below only ever applies to source = 'automatic' AND
// evidence_fingerprint IS NOT NULL, so it can never block or interact with
// either of those.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('student_threshold_history', 'evidence_fingerprint', {
      type: Sequelize.STRING(64), // sha256 hex digest — fixed 64 chars
      allowNull: true,
    });

    await queryInterface.addIndex('student_threshold_history',
      ['student_id', 'scope_type', 'scope_key', 'source', 'evidence_fingerprint'],
      {
        name:   'student_threshold_history_automatic_evidence_uniq',
        unique: true,
        where:  { source: 'automatic', evidence_fingerprint: { [Sequelize.Op.ne]: null } },
      }
    );
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('student_threshold_history', 'student_threshold_history_automatic_evidence_uniq');
    await queryInterface.removeColumn('student_threshold_history', 'evidence_fingerprint');
  },
};
