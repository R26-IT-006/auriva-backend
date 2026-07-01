'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const LetterProgress = sequelize.define('LetterProgress', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  student_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  letter: {
    type: DataTypes.CHAR(1),
    allowNull: false,
  },
  case_type: {
    type: DataTypes.ENUM('lowercase', 'uppercase'),
    allowNull: false,
  },
  completed_at: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  blocked_attempts: {
    type:         DataTypes.INTEGER,
    allowNull:    false,
    defaultValue: 0,
  },
  attempt_data: {
    type:      DataTypes.JSONB,
    allowNull: true,   // null on rows written by old clients
  },
}, {
  tableName: 'letter_progress',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    {
      unique: true,
      fields: ['student_id', 'letter', 'case_type'],
      name: 'uq_student_letter_case',
    },
  ],
});

module.exports = LetterProgress;
