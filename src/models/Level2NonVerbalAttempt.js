'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Records the non-verbal word-match activity (Section 8.3).
// Triggered either during Step 4 teaching fallback or the production phase non-verbal pathway.
const Level2NonVerbalAttempt = sequelize.define('Level2NonVerbalAttempt', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  level2_session_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // 1–5, which sentence this activity belongs to
  sentence_index: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // 'teaching_fallback' = triggered during Step 4; 'production_fallback' = triggered in production phase
  context: {
    type: DataTypes.ENUM('teaching_fallback', 'production_fallback'),
    allowNull: false,
  },
  correct_on_first_attempt: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
  },
  required_second_attempt: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  auto_shown: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'level2_nonverbal_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Level2NonVerbalAttempt;
