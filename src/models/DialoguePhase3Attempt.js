'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DialoguePhase3Attempt = sequelize.define('DialoguePhase3Attempt', {
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
  session_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  scenario_label: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  phase3_correct: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
  },
  session_passed: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
  },
  // RC2 — ML training features (populated from frontend tap timing)
  response_latency_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  selection_change_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  first_tap_correct: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
  },
  prompt_count: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  // RC2 — Bloom's classification (populated after pragmatic model FSD)
  blooms_level: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  pragmatic_confidence: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  attempted_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'dialogue_phase3_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = DialoguePhase3Attempt;
