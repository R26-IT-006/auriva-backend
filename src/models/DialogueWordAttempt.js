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
  // RC3 — echolalia detection (populated by assessPhase2Speech after echolalia FSD)
  response_latency_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  echolalia_flag: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  // RC1 — phoneme scorer (populated after phoneme microservice FSD)
  phoneme_error_class: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  phoneme_accuracy: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  attempted_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  is_probe: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
}, {
  tableName: 'dialogue_word_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = DialogueWordAttempt;
