'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Records the child's tap selection during Sentence 4's combined Step 2+3 screen (Section 6).
const Level2GenderSelectionLog = sequelize.define('Level2GenderSelectionLog', {
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
  first_tap: {
    type: DataTypes.ENUM('boy', 'girl'),
    allowNull: false,
  },
  correct_on_first_tap: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  required_prompt: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  auto_advanced: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'level2_gender_selection_logs',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Level2GenderSelectionLog;
