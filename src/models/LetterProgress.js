'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const LetterProgress = sequelize.define('LetterProgress', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  letter: {
    type: DataTypes.CHAR(1),
    allowNull: false,
  },
  case_type: {
    type: DataTypes.ENUM('lowercase', 'uppercase'),
    allowNull: false,
  },
  // LEGACY. Stamped at row CREATION, which the failure branch of
  // recordLetterCompletion() also performs — so on a row born from a failure
  // this is the failure instant, not a mastery instant. Live audit found 19
  // rows where it precedes the real passing session by 17-95 days. Kept
  // untouched for historical continuity; never read as a mastery signal.
  // Use mastered_at below for that.
  completed_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  // Mastery-semantics correction — see
  // migrations/20260826000002-add-mastered-at-to-letter-progress.js.
  //
  //   NOT NULL -> this letter is MASTERED, at that instant
  //   NULL     -> practice/blocked history only, NOT mastered
  //
  // Row existence means nothing about mastery: the failure branch creates
  // rows purely to hold blocked_attempts. Every mastery reader must test
  // this column, never the row's presence.
  mastered_at: {
    type:      DataTypes.DATE,
    allowNull: true,
  },
  blocked_attempts: {
    type:         DataTypes.INTEGER,
    allowNull:    false,
    defaultValue: 0,
  },
  attempt_data: {
    type:      DataTypes.JSONB,
    allowNull: true,   // null on rows written by old clients
  },
  // Motor Score Unification (spec §24) — see
  // src/config/motorScoreRegime.js. NULL means this letter's mastery
  // (completed_at) was decided under the legacy regime (client
  // featuresToScore()-derived bestScore). A real value means mastery was
  // decided under the new authoritative computeMotorScore()-governed
  // regime. Never backfilled on historical rows (spec §25).
  progression_score_version: {
    type:      DataTypes.STRING(20),
    allowNull: true,
  },
  // The LetterAttempt row that actually established mastery - see
  // migrations/20260829000001-add-mastery-letter-attempt-id-to-letter-progress.js.
  //
  //   value -> that attempt's stroke_points ARE this letter's mastery evidence
  //   NULL  -> mastered before this column existed, or mastery is not yet held
  //
  // Written once, in the same block that stamps mastered_at, and guarded on
  // NULL so a later re-pass can never rewrite it. NEVER backfilled: nothing
  // stored on a historical row identifies its mastering attempt, and picking
  // one by score or recency would fabricate the very attribution this column
  // exists to make provable.
  mastery_letter_attempt_id: {
    type:      DataTypes.INTEGER,
    allowNull: true,
  },
}, {
  tableName: 'letter_progress',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    {
      unique: true,
      fields: ['student_id', 'letter', 'case_type'],
      name: 'uq_student_letter_case',
    },
  ],
});

module.exports = LetterProgress;
