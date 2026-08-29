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
  // Which activity this row belongs to. Coverage is tracked per type: a memory
  // game must never consume the concepts the mixed practice activity is waiting
  // on, or playing one would starve the other of a trigger.
  activity_type: {
    type: DataTypes.ENUM('practice', 'pair_match', 'memory'),
    allowNull: false,
    defaultValue: 'practice',
  },
  // nth activity for this (student, category, type) — drives the practice
  // activity's difficulty ladder. The card games have no ladder.
  activity_number: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // Practice only — nullable because a card game has no ladder to record, and a
  // placeholder here would be read as a real level by anything downstream.
  difficulty_level: {
    type: DataTypes.INTEGER,
    allowNull: true,
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
  // "apple|banana|cherry#IIN" — used to avoid repeating a recent activity shape.
  // Practice only; a card game has no round shape to collide on.
  signature: {
    type: DataTypes.STRING(120),
    allowNull: true,
  },
  // frozen blueprint: [{ round_number, question_type, concept_key, option_keys }]
  // Practice only — null for the card games, which have no rounds.
  question_plan: {
    type: DataTypes.JSONB,
    allowNull: true,
  },
  total_rounds: {
    type: DataTypes.INTEGER,
    allowNull: true,
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
    // Coverage and activity_number are both looked up per type.
    { fields: ['student_id', 'category_key', 'activity_type'] },
  ],
});

module.exports = StudentActivity;
