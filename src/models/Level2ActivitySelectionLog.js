'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Records the child's selection during Sentence 5's pre-step activity screen (Section 6).
const Level2ActivitySelectionLog = sequelize.define('Level2ActivitySelectionLog', {
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
  // First activity in teacher's questionnaire selection
  expected_activity: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  // What the child actually tapped
  child_selected_activity: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  matched_expected: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'level2_activity_selection_logs',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Level2ActivitySelectionLog;
