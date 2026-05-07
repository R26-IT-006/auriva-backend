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
