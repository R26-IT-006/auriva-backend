'use strict';

// Third time restoring students.reduce_stimulation. 20260809000003 and
// 20260813000002 are both recorded in SequelizeMeta, so sequelize-cli will
// never re-run them, and the column keeps disappearing regardless.
//
// The cause is not migrations — it is sequelize.sync({ alter: true }) running
// on branches whose Student model predates this column. alter defaults to
// drop: true, so booting such a branch against the shared Azure database drops
// every column the local model does not know about. As of this migration:
//
//   dev/hiranya, dev/maryse, master  → model lacks BOTH columns, sync is
//                                      unguarded → drops both on boot
//   dev/liluksha                     → model has personal_thresholds but not
//                                      reduce_stimulation, sync uses
//                                      drop: false → re-creates only the one
//                                      it knows about
//
// That sequence explains the exact state found today: personal_thresholds
// present, reduce_stimulation missing. Until those branches take the guarded
// index.js from dev/integration (ALLOW_DB_SYNC + alter: { drop: false }), this
// will keep recurring and a fourth restore migration will be needed.
//
// Idempotent, so it is safe if the column is already back by the time it runs.
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
