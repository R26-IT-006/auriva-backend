'use strict';

const { DataTypes } = require('sequelize');
const logger = require('./logger');

// ─── Self-heal: students.personal_thresholds ──────────────────────────────
// This DB is shared across dev machines, and a teammate booting with
// ALLOW_DB_SYNC=true on stale code (missing the alter:{drop:false} guard in
// index.js) can still run a full sync({ alter: true }) and drop this column
// out from under everyone else — it has happened repeatedly, and
// mid-session, not just at boot. Rather than everyone re-running the
// migration by hand each time it's dropped, poll for it and re-add it
// whenever it's missing. This never drops or alters anything else, so it's
// safe even outside ALLOW_DB_SYNC and even while the server is already
// handling traffic.
//
// Extracted out of index.js (Reliability investigation, 2026-08-09) purely
// so it can be unit-tested directly — identical SQL, identical logging,
// identical behavior; index.js requires and calls this exact function at
// both of its call sites (startup, and the 60s setInterval). See
// migrations/20260809000001-restore-personal-thresholds-column.js for the
// one-time repair this same detect-and-repair logic mirrors, and the
// Reliability investigation report for the full incident writeup — this
// function did not fail; it simply never got a chance to run, because no
// `node index.js` process was alive during that investigation (this
// function only executes inside a live server process, never from a
// standalone script).
//
// Deliberately does NOT catch its own errors — a failed detection/repair
// query must propagate to the caller, never resolve as if nothing happened.
// index.js's own call sites are the ones responsible for logging a failure
// (`.catch(err => logger.error(...))`), not this function silently
// swallowing it.
async function ensurePersonalThresholdsColumn(sequelize) {
  const [[info]] = await sequelize.query(
    `SELECT count(*) AS has_col FROM information_schema.columns
      WHERE table_name='students' AND column_name='personal_thresholds'`
  );
  if (Number(info.has_col) === 0) {
    logger.warn('students.personal_thresholds missing — re-adding it (likely dropped by another dev\'s sync against this shared DB)');
    await sequelize.getQueryInterface().addColumn('students', 'personal_thresholds', {
      type:         DataTypes.JSONB,
      allowNull:    false,
      defaultValue: {},
    });
    logger.warn('students.personal_thresholds re-added');
  }
  return Number(info.has_col) !== 0;
}

module.exports = { ensurePersonalThresholdsColumn };
