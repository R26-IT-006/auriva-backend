'use strict';

// Restores two students columns that the Student model declares but the
// database is missing, which makes every Student.findAll() that selects the
// full attribute list fail with "column Student.<name> does not exist":
//
//   reduce_stimulation  — added to the model in commit 1efb388 with no
//                         migration at all; it only ever existed on databases
//                         that got sequelize.sync({ alter: true }) on boot.
//   personal_thresholds — has several migrations already recorded as applied
//                         in SequelizeMeta (20260714000007, and on other
//                         branches 20260809000001 / 20260809000003), yet the
//                         column is absent from the live database again.
//
// Both went missing the same way: sync({ alter: true }) defaults to
// drop: true, so booting an older checkout whose Student model lacked these
// fields dropped them back out (index.js now passes drop: false and gates
// sync behind ALLOW_DB_SYNC for exactly this reason). Because sequelize-cli
// only consults SequelizeMeta and will not re-run a migration marked done,
// restoring them needs a new migration rather than a re-run of the old ones.
//
// Idempotent, same pattern as 20260714000002/20260714000007 — safe to run
// against a database where either column is already present.
async function columnExists(queryInterface, table, column) {
  const description = await queryInterface.describeTable(table);
  return Object.prototype.hasOwnProperty.call(description, column);
}

const TABLE = 'students';

// Must stay in sync with src/models/Student.js.
const COLUMNS = {
  // Defaults off so existing students keep their current behavior.
  reduce_stimulation:  { type: 'BOOLEAN', allowNull: false, defaultValue: false },
  personal_thresholds: { type: 'JSONB',   allowNull: false, defaultValue: {} },
};

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const [name, def] of Object.entries(COLUMNS)) {
      if (!(await columnExists(queryInterface, TABLE, name))) {
        await queryInterface.addColumn(TABLE, name, { ...def, type: Sequelize[def.type] });
      }
    }
  },

  async down(queryInterface) {
    for (const name of Object.keys(COLUMNS)) {
      if (await columnExists(queryInterface, TABLE, name)) {
        await queryInterface.removeColumn(TABLE, name);
      }
    }
  },
};
