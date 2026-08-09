'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Records attempts during the Independent Production Phase (Section 8).
// Covers both the Full Paragraph Attempt (8.1) and Sentence-by-Sentence Prompted Attempt (8.2).
const Level2ProductionAttempt = sequelize.define('Level2ProductionAttempt', {
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
  phase: {
    type: DataTypes.ENUM('full_paragraph', 'sentence_by_sentence'),
    allowNull: false,
  },
  // Null for full_paragraph; 1–5 for sentence_by_sentence
  sentence_index: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // 0–3 for sentence_by_sentence; null for full_paragraph (use elements_detected instead)
  score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  match_type: {
    type: DataTypes.ENUM('exact', 'fuzzy', 'keyword', 'no_match'),
    allowNull: true,
  },
  transcript: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  // For full_paragraph: { name: bool, age: bool, hometown: bool, gender: bool, activity: bool }
  elements_detected: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  silence_timeout_triggered: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  transcription_error: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'level2_production_attempts',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Level2ProductionAttempt;
