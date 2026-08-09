'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const SentenceQuestionnaire = sequelize.define('SentenceQuestionnaire', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  teacher_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  child_first_name: {
    // nullable (TASK-17 Fix 2): a portrait-only row can exist before the
    // demographic questionnaire is filled in.
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  child_age: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  child_hometown: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  child_first_name_sinhala: {
    // Sinhala-script spelling of child_first_name, confirmed by the teacher
    // via SinhalaNameInput (TASK-30). Nullable: name pronunciation falls
    // back to the existing unmatched-proper-noun contract when absent.
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  child_gender: {
    type: DataTypes.ENUM('boy', 'girl'),
    allowNull: true,
  },
  favourite_activities: {
    type: DataTypes.JSON,
    allowNull: true,
  },
  friend_name: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  friend_name_sinhala: {
    // Sinhala-script spelling of friend_name, confirmed by the teacher via
    // SinhalaNameInput (TASK-30), same nullable/fallback contract as
    // child_first_name_sinhala.
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  friend_gender: {
    // Plain VARCHAR ('boy'|'girl'), matching this migration's own snippet —
    // not promoted to a Postgres ENUM like child_gender (see STATE.md for
    // the rationale: no other column in this task's scope needed ENUM-level
    // guarantees, and app-level validation already enforces the same set).
    type: DataTypes.STRING(10),
    allowNull: true,
  },
  friend_age: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  friend_grade: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  friend_personality: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  pet_type: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  pet_name: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  pet_name_sinhala: {
    type: DataTypes.STRING(100),
    allowNull: true,
  },
  portrait_strokes: {
    type: DataTypes.JSON,
    allowNull: true,
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
  tableName: 'sentence_questionnaires',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { unique: true, fields: ['student_id'] },
  ],
});

module.exports = SentenceQuestionnaire;
