'use strict';

// Feature 11B Phase 4 — adds the single new nullable column needed to mark
// which LetterAttempt rows belong to a standardized Letter Motor
// Reassessment, as opposed to normal practice.
//
//   - Existing rows: source_type stays NULL. NOT backfilled — same "no
//     historical proxy, ever" discipline as support_level's own migration
//     (20260809000002-add-support-level-to-letter-attempts.js).
//   - Normal practice rows going forward: still NULL. Nothing about normal
//     saveLetterAttempts()/recordLetterCompletion() behavior changes.
//   - Feature 11B reassessment rows: source_type = 'letter_motor_reassessment'
//     (see src/config/letterMotorReassessmentLetters.js for the constant).
//   - A SEPARATE concept from collection_mode — collection_mode is
//     temporary pre-deployment research capture and is never touched by
//     this migration or by Feature 11B. source_type does not replace it;
//     both columns are independently readable/queryable.
//   - No index — no query yet justifies one; every normal-learning query
//     that needs to EXCLUDE reassessment rows already filters on
//     student_id (+ other columns) first, so `source_type IS NULL` is an
//     additional predicate on an already-narrow row set, not a full-table
//     scan driver.
//   - Vocabulary enforcement (currently one value:
//     'letter_motor_reassessment') lives at the application layer only —
//     same STRING-not-native-enum convention as support_level/
//     demo_speed_level on this same table, for the same rollback-safety
//     reason (see LetterAttempt.js's own column comments).
//
// Idempotent by design — same columnExists() guard pattern already used by
// the support_level/demo_speed_level migrations on this table.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

const TABLE = 'letter_attempts';
const COLUMN = 'source_type';

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, TABLE, COLUMN))) {
      await queryInterface.addColumn(TABLE, COLUMN, {
        type:      Sequelize.STRING(40),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, TABLE, COLUMN)) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
