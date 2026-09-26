'use strict';

// 20260513000000-add-personal-thresholds-and-blocked-attempts.js is recorded
// as applied in SequelizeMeta, but only the letter_progress.blocked_attempts
// half of it ever actually ran against this database — students.
// personal_thresholds was never created (see scripts/seed-meta.js, which
// backfilled that migration's SequelizeMeta row manually before CLI
// migration tracking began, without re-running its SQL). Since Sequelize CLI
// only checks SequelizeMeta and won't retry a migration already marked
// done, this is a new migration rather than a re-run of the old one.
//
// Idempotent, same pattern as 20260714000002 — safe even if this ever runs
// twice, or if the column shows up via another path first.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

const TABLE = 'students';
const COLUMN = 'personal_thresholds';

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, TABLE, COLUMN))) {
      await queryInterface.addColumn(TABLE, COLUMN, {
        type:         Sequelize.JSONB,
        allowNull:    false,
        defaultValue: {},
      });
    }
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, TABLE, COLUMN)) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
