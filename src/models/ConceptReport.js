'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

/**
 * A frozen concept report for one child over one named period.
 *
 * The live report is a rolling window: open it in September and August has partly
 * fallen out of the bottom, open it twice in a week and the figures have moved.
 * That is right for "how are they doing now" and useless for "here is August" —
 * which is what a teacher needs for a review meeting, a parent conversation, or a
 * handover. So a report is generated once and never recomputed.
 *
 * `payload` holds the whole `getConceptReport` result as it stood. Storing the
 * derived figures rather than re-deriving them is the entire point: a snapshot a
 * teacher showed a parent last week must say the same thing today, even after the
 * child has logged another fortnight of sessions and even after we change how a
 * figure is calculated.
 */
const ConceptReport = sequelize.define('ConceptReport', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // Who generated it. Kept for provenance rather than access control — the read
  // path gates on the student's current teacher, so a report survives the child
  // being reallocated and the new teacher can still open it.
  teacher_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  period_type: {
    type: DataTypes.STRING(10),
    allowNull: false,
    validate: { isIn: [['week', 'month']] },
  },
  // Local calendar dates in the school's timezone, not instants. "August" is a
  // run of local days; the UTC instants that bound it are derived in periods.js
  // and belong in the query, not in the record of which period this is.
  period_start: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  period_end: {
    type: DataTypes.DATEONLY,
    allowNull: false,
  },
  // Bumped whenever the payload shape changes, so a client meeting an old report
  // can tell rather than guess. A stored report is never rewritten to match new
  // code — that would defeat the freezing.
  schema_version: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  payload: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  // Null when the model was disabled or the call failed at generation time. The
  // report is still worth keeping without it, so this never blocks a save.
  narrative: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  // The few figures the archive list shows. Separated so listing a year of
  // reports never has to read a year of full payloads out of the database.
  headline: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: {},
  },
  generated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'concept_reports',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    // Regenerating a period replaces it rather than accumulating near-duplicates
    // that differ only by when someone pressed the button.
    { unique: true, fields: ['student_id', 'period_type', 'period_start'] },
    // The archive is always read newest first for one child.
    { fields: ['student_id', 'period_start'] },
  ],
});

module.exports = ConceptReport;
