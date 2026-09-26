'use strict';

// Feature 3 Step 3 — adds the single new nullable column needed to persist
// which support level (high/medium/low) was actually RENDERED by the
// frontend for a given LetterAttempt row. DATA CAPTURE ONLY:
//
//   - No backfill of the existing 774 rows — their support_level stays
//     null. A historical proxy derived from attempt_number was deliberately
//     rejected (see src/models/LetterAttempt.js's header comment on this
//     column, and the Feature 3 Step 1 audit): collection-mode attempt 3's
//     presentation does not cleanly match any single support tier, so a
//     blanket attempt_number → support_level backfill would silently
//     fabricate wrong values for a meaningful slice of historical rows.
//     new rows → explicit support_level (or null if the client omitted /
//     sent an invalid value — see saveLetterAttempts() in
//     handwritingController.js) is the safest MVP.
//   - No index — no query yet justifies one; add later only once a real
//     support-analysis read pattern exists.
//   - No other column touched.
//
// Vocabulary enforcement ('high'|'medium'|'low') lives at the application
// layer only (Sequelize model `validate.isIn` + saveLetterAttempts()
// controller-level validation — see src/config/letterSupportLevels.js), not
// as a DB CHECK constraint or a native PostgreSQL ENUM. A plain VARCHAR
// keeps this column trivially alterable/rollback-safe while Feature 3's
// support vocabulary is still new — see the model's own column comment for
// the full rationale.
//
// Idempotent by design — same columnExists() guard pattern already used by
// 20260714000002 / 20260723000001 in this migrations directory.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

const TABLE = 'letter_attempts';
const COLUMN = 'support_level';

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
