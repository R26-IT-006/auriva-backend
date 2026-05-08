'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const StudentConceptProgress = sequelize.define('StudentConceptProgress', {
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
  concept_key: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  tier1_status: {
    type: DataTypes.ENUM('not_started', 'in_progress', 'passed', 'failed'),
    allowNull: false,
    defaultValue: 'not_started',
  },
  tier1_attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  tier1_score: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  tier1_passed_at: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  tier1_retry_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  tier2_status: {
    type: DataTypes.ENUM('locked', 'not_started', 'in_progress', 'passed', 'failed'),
    allowNull: false,
    defaultValue: 'locked',
  },
  tier2_retry_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  tier3_status: {
    type: DataTypes.ENUM('locked', 'not_started', 'in_progress', 'passed'),
    allowNull: false,
    defaultValue: 'locked',
  },
}, {
  tableName: 'student_concept_progress',
  timestamps: false,
  freezeTableName: true,
  indexes: [
    {
      unique: true,
      fields: ['student_id', 'category_key', 'concept_key'],
    },
  ],
});

module.exports = StudentConceptProgress;
