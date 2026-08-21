'use strict';

// Fourth restore of students.reduce_stimulation. 20260809000003, 20260813000002
// and 20260816000001 are all recorded in SequelizeMeta, so sequelize-cli will
// not re-run any of them however many times the column is dropped.
//
// ddl_audit_log records seven drop/restore cycles between 2026-08-08 and
// 2026-08-16, e.g. restored 08-16 08:05:41 UTC and dropped again 08:42:41 UTC,
// 37 minutes later, from a different machine on the same network.
//
// Cause, in every case: sequelize.sync({ alter: true }) at boot on a branch
// whose Student model predates the column. alter defaults to drop: true, so the
// column is removed for everyone sharing the Azure database. This branch's own
// index.js has now been changed to opt-in (ALLOW_DB_SYNC) and non-destructive
// (alter: { drop: false }); the remaining branches need the same change before
// this can be the last restore.
//
// Idempotent — safe if the column happens to be back already.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

const TABLE = 'students';
const COLUMN = 'reduce_stimulation';

module.exports = {
  async up(queryInterface, Sequelize) {
    if (!(await columnExists(queryInterface, TABLE, COLUMN))) {
      // Defaults off so existing students keep their current behaviour.
      await queryInterface.addColumn(TABLE, COLUMN, {
        type:         Sequelize.BOOLEAN,
        allowNull:    false,
        defaultValue: false,
      });
    }
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, TABLE, COLUMN)) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
