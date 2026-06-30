'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const ActionWordAttempt = sequelize.define('ActionWordAttempt', {
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
    references: { model: 'dialogue_words', key: 'id' },
  },
  session_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  drag_to_line_result: {
    type: DataTypes.ENUM('success', 'retry_correct', 'auto_advanced'),
    allowNull: true,
  },
  phase2_speech_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  phase2_transcript: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  phase2_match_type: {
    type: DataTypes.ENUM('none', 'exact', 'keyword', 'fuzzy', 'non_verbal'),
    allowNull: true,
  },
  // RC1 — phoneme scorer (mirrors DialogueWordAttempt)
  phase2_phoneme_error_class: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  phase2_phoneme_accuracy: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  // RC3 — echolalia detection (mirrors DialogueWordAttempt)
  phase2_response_latency_ms: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  phase2_echolalia_flag: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  phase3_correct: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
  },
  phase3_attempts: {
    type: DataTypes.INTEGER,
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
  tableName: 'action_word_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = ActionWordAttempt;
