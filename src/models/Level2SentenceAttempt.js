'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Records Step 3 (drag-and-drop) and Step 4 (spoken repetition) data
// for each sentence during the per-sentence teaching flow (Sections 5–6).
const Level2SentenceAttempt = sequelize.define('Level2SentenceAttempt', {
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
  // 1 = name, 2 = age, 3 = hometown, 4 = gender, 5 = activity
  sentence_index: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // Step 3 drag-and-drop result
  step3_result: {
    type: DataTypes.ENUM('first_attempt', 'required_hint', 'auto_advanced'),
    allowNull: true,
  },
  // Step 4 spoken repetition
  step4_score: {
    type: DataTypes.INTEGER, // 0–3
    allowNull: true,
  },
  step4_transcript: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  step4_match_type: {
    type: DataTypes.ENUM('exact', 'fuzzy', 'keyword', 'no_match'),
    allowNull: true,
  },
  // Whether the non-verbal fallback was triggered for this sentence's Step 4
  non_verbal_triggered: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // Whether STT failed during Step 4
  transcription_error: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'level2_sentence_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Level2SentenceAttempt;
