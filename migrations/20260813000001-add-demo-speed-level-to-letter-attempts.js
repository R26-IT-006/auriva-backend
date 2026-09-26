'use strict';

// Feature 6 Step 5 — adds the single new nullable column needed to persist
// which demo-speed level ('standard'/'slow') was actually RENDERED to the
// student for a given LetterAttempt row's tracer, if any. DATA CAPTURE +
// RESEARCH/AUDITABILITY ONLY — mirrors 20260809000002's
// add-support-level-to-letter-attempts migration in every respect:
//
//   - No backfill of existing rows (780 as of this step) — their
//     demo_speed_level stays null. No historical proxy is derived from
//     support_level/attempt_number/the backend recommendation: this column
//     means "a tracer was ACTUALLY on screen at this speed", and no
//     historical row captured whether that was true (Step 4 predates this
//     column entirely; even Step 5's own new rows only get a non-null value
//     when resolveActualDemoSpeedLevel() actually resolved one). See
//     src/models/LetterAttempt.js's column comment and the Feature 6 Step 3
//     persistence-semantics analysis for the full rationale.
//   - No index — no query yet justifies one; add later only once a real
//     demo-speed-analysis read pattern exists.
//   - No other column touched.
//
// Vocabulary enforcement ('standard'|'slow') lives at the application layer
// only (Sequelize model `validate.isIn` + saveLetterAttempts() controller
// -level validation — see src/config/demoSpeedPolicy.js's
// isValidDemoSpeedLevel/DEMO_SPEED_LEVELS, already defined since Step 2), not
// a DB CHECK constraint or a native PostgreSQL ENUM — same rollback-safety
// rationale as support_level's own column.
//
// Idempotent by design — same columnExists() guard pattern already used by
// 20260714000002 / 20260723000001 / 20260809000002 in this migrations
// directory.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

const TABLE = 'letter_attempts';
const COLUMN = 'demo_speed_level';

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, TABLE, COLUMN))) {
      await queryInterface.addColumn(TABLE, COLUMN, {
        type:      Sequelize.STRING(10),
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
