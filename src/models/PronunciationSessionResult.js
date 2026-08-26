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
  scoring_method: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  // Layer-1 (MFCC-DTW) instrumentation, promoted from recommendation_details
  // to top-level columns so the cascade can be measured with plain SQL:
  // gate hit rate (layer1_decision), score distribution (segmental_accuracy),
  // and raw DTW distance vs teacher_reviewed_score. Null on rows scored by a
  // path that never runs layer 1 (reference-free GOP, prototype fallback).
  segmental_accuracy: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  dtw_distance: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  layer1_decision: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  recognized_text: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  speech_verification: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  confidence_level: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  needs_teacher_review: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  // Teacher-confirmed ground truth for this attempt. Populated only after a
  // teacher submits a review; this is the labeled corpus the layer-3
  // calibration model (adaptiveCalibrationService) fits against.
  teacher_reviewed_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
    validate: { min: 0, max: 100 },
  },
  teacher_reviewed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  teacher_reviewed_by: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  heard_reference_audio: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
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
