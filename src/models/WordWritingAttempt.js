'use strict';
const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

module.exports = sequelize.define('WordWritingAttempt', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  action_id: { type: DataTypes.UUID, allowNull: false, unique: true },
  student_id: { type: DataTypes.INTEGER, allowNull: false },
  word: { type: DataTypes.STRING(32), allowNull: false },
  source_letter: { type: DataTypes.CHAR(1), allowNull: false },
  stage: { type: DataTypes.STRING(32), allowNull: false, validate: { isIn: [['guided_word_writing', 'practice_exercise_e']] } },
  attempt_number: { type: DataTypes.INTEGER, allowNull: true },
  support_stage: { type: DataTypes.STRING(10), allowNull: true },
  score: { type: DataTypes.FLOAT, allowNull: false },
  threshold_used: { type: DataTypes.FLOAT, allowNull: false },
  passed: { type: DataTypes.BOOLEAN, allowNull: false },
  completion_passed: { type: DataTypes.BOOLEAN, allowNull: false },
  expected_letter_count: { type: DataTypes.INTEGER, allowNull: false },
  covered_letter_count: { type: DataTypes.INTEGER, allowNull: false },
  strokes: { type: DataTypes.JSONB, allowNull: false },
  normalized_features: { type: DataTypes.JSONB, allowNull: true },
  canvas_width: { type: DataTypes.INTEGER, allowNull: false },
  canvas_height: { type: DataTypes.INTEGER, allowNull: false },
  capture_status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'complete' },
  collection_mode: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  word_score_version: { type: DataTypes.STRING(20), allowNull: false },
}, { tableName: 'handwriting_word_attempts', underscored: true, timestamps: true, createdAt: 'created_at', updatedAt: false });
