'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StudentActivity = sequelize.define('StudentActivity', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  category_key: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  // nth activity for this (student, category) — drives the fixed difficulty ladder
  activity_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  difficulty_level: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // { ladder, delta, recent_score, concept_strength } — kept for debugging the adaptation
  difficulty_meta: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('generated', 'in_progress', 'passed', 'failed'),
    allowNull: false,
    defaultValue: 'generated',
  },
  // sorted array of the concept keys under test
  concept_keys: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  // "apple|banana|cherry#IIN" — used to avoid repeating a recent activity shape
  signature: {
    type: DataTypes.STRING(120),
    allowNull: false,
  },
  // frozen blueprint: [{ round_number, question_type, concept_key, option_keys }]
  question_plan: {
    type: DataTypes.JSONB,
    allowNull: false,
  },
  total_rounds: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  correct_count: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  score: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  started_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  completed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  created_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'student_activities',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { fields: ['student_id', 'category_key'] },
    { fields: ['student_id', 'category_key', 'activity_number'] },
  ],
});

module.exports = StudentActivity;
