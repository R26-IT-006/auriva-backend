'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DialogueWordProgress = sequelize.define('DialogueWordProgress', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  word_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('not_started', 'in_progress', 'mastered', 'struggling'),
    defaultValue: 'not_started',
    allowNull: false,
  },
  current_phase: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
    allowNull: false,
  },
  phase1_exposure_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  phase1_required_exposures: {
    type: DataTypes.INTEGER,
    defaultValue: 4,
  },
  phase1_gate_passed: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  session_pass_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  last_pass_date: {
    type: DataTypes.DATEONLY,
    allowNull: true,
  },
  consecutive_fail_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  total_sessions: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  non_verbal_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  updated_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'dialogue_word_progress',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    {
      unique: true,
      fields: ['student_id', 'word_id'],
    },
  ],
});

module.exports = DialogueWordProgress;
