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
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  child_age: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  child_hometown: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  child_gender: {
    type: DataTypes.ENUM('boy', 'girl'),
    allowNull: false,
  },
  favourite_activities: {
    type: DataTypes.JSON,
    allowNull: false,
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
