'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const DialogueWordAttempt = sequelize.define('DialogueWordAttempt', {
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
  phase: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  speech_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  transcript: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  match_type: {
    type: DataTypes.ENUM('none', 'exact', 'keyword', 'fuzzy', 'non_verbal'),
    allowNull: true,
  },
  scenario_label: {
    type: DataTypes.ENUM('A', 'B', 'C', 'checkpoint'),
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
  attempted_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'dialogue_word_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = DialogueWordAttempt;
