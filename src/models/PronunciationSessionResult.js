'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const PronunciationSessionResult = sequelize.define('PronunciationSessionResult', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  teacher_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  mode: {
    type: DataTypes.ENUM('word', 'alphabet'),
    allowNull: false,
  },
  category_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  word_id: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  word_label: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  overall_score: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  phoneme_scores: {
    type: DataTypes.JSONB,
    allowNull: false,
    defaultValue: [],
  },
  listen_choose_data: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  response_duration: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  hesitation_time: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  recommendation_type: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  recommendation_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  recommendation_details: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  next_word_id: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  attempt_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
  workflow_completed: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  recording_uri: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  raw_audio_data: {
    type: DataTypes.BLOB('long'),
    allowNull: true,
  },
  raw_audio_mime_type: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  raw_audio_size: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'pronunciation_session_results',
  timestamps: false,
  freezeTableName: true,
});

module.exports = PronunciationSessionResult;
