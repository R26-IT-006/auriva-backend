'use strict';

// Reliability fix: students.personal_thresholds was found missing from the
// live database on 2026-08-09, despite BOTH migrations that add it —
// 20260513000000-add-personal-thresholds-and-blocked-attempts.js and
// 20260714000007-add-missing-personal-thresholds-column.js — being recorded
// as applied in SequelizeMeta. See the Step 6B/schema-investigation report
// for the full finding; short version: this is a shared dev database, and
// index.js's own `ensurePersonalThresholdsColumn()` self-heal (startup +
// every 60s while the server process is alive) exists specifically because
// a teammate's out-of-date local Student model running
// `sequelize.sync({alter:true})` (pre-dating the alter:{drop:false} guard
// now in index.js) can drop this exact column out from under everyone else
// on this shared DB, mid-session — "has happened repeatedly" per that
// file's own comment. The self-heal only runs inside a live `node index.js`
// process; no such process was running during this investigation, so
// nothing re-added it automatically.
//
// Per the same reasoning as 20260714000007-add-missing-personal-thresholds-column.js
// (which cannot simply be re-run: Sequelize CLI never re-executes a
// migration already marked applied in SequelizeMeta, and manually
// unmarking/editing that file is explicitly out of scope here), this is a
// NEW, idempotent, narrowly-scoped migration rather than a modification of
// either prior one.
//
// Restoration value is the model-compatible default ({}), matching
// src/models/Student.js exactly — never a fabricated/reconstructed
// per-letter value. No other column, table, or row is touched.
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
        defaultValue: {}, // matches src/models/Student.js exactly — every existing row receives {} via this DEFAULT, not an invented value
      });
    }
    // Column already present -> no-op, matching the model/prior migrations exactly.
  },

  async down(queryInterface) {
    if (await columnExists(queryInterface, TABLE, COLUMN)) {
      await queryInterface.removeColumn(TABLE, COLUMN);
    }
  },
};
