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
  child_gender: {
    type: DataTypes.ENUM('boy', 'girl'),
    allowNull: true,
  },
  favourite_activities: {
    type: DataTypes.JSON,
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
