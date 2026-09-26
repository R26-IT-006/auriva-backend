'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Level2Session = sequelize.define('Level2Session', {
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
  // Optional reference to the parent learning session
  session_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  topic: {
    type: DataTypes.ENUM('self_introduction', 'describe_friend', 'describe_pet'),
    allowNull: false,
    defaultValue: 'self_introduction',
  },
  // 'verbal' or 'non_verbal' — determined when session completes
  pathway: {
    type: DataTypes.ENUM('verbal', 'non_verbal'),
    allowNull: true,
  },
  started_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  ended_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Full paragraph attempt data (Section 8.1)
  full_paragraph_transcript: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  full_paragraph_elements_detected: {
    type: DataTypes.JSON, // { name, age, hometown, gender, activity } each boolean
    allowNull: true,
  },
  full_paragraph_total_score: {
    type: DataTypes.INTEGER, // 0–5, count of elements detected
    allowNull: true,
  },
  silence_timeout_triggered: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  // Sum of sentence-by-sentence element scores (count of sentences with score >= 1), 0–5
  sxs_element_score: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  is_complete: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
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
  tableName: 'level2_sessions',
  timestamps: false,
  freezeTableName: true,
});

module.exports = Level2Session;
