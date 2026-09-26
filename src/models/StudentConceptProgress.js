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
  // Mirrors the tier-1 trio. Nullable rather than defaulted: a concept whose
  // tier 2 has not been attempted has no score, and 0 would read as "scored
  // zero" to everything that ranks weakest-first.
  tier2_score: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  tier2_attempts: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  // The timestamp mastery actually happens at — mastery needs tier 1 AND tier 2,
  // so tier1_passed_at always precedes it.
  tier2_passed_at: {
    type: DataTypes.DATE,
    allowNull: true,
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
