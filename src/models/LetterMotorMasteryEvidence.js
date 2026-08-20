'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Feature 11B Phase 5 — see
// migrations/20260821000001-create-letter-motor-mastery-evidence.js for the
// full schema rationale. One immutable row per (student, reference letter)
// frozen motor-evidence observation.
const LetterMotorMasteryEvidence = sequelize.define('LetterMotorMasteryEvidence', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id:        { type: DataTypes.INTEGER,    allowNull: false },
  letter:             { type: DataTypes.CHAR(1),    allowNull: false },
  case_type:          { type: DataTypes.STRING(10), allowNull: false },

  letter_attempt_id: { type: DataTypes.INTEGER, allowNull: false },
  mastered_at:        { type: DataTypes.DATE,    allowNull: false },

  smoothness_score: { type: DataTypes.FLOAT, allowNull: false },
  dtw_distance:     { type: DataTypes.FLOAT, allowNull: false },
  speed_cv:         { type: DataTypes.FLOAT, allowNull: false },

  support_level: { type: DataTypes.STRING(10), allowNull: false },

  feature_version:       { type: DataTypes.STRING(20), allowNull: false },
  template_version:      { type: DataTypes.STRING(20), allowNull: false },
  normalization_version: { type: DataTypes.STRING(20), allowNull: false },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName:  'letter_motor_mastery_evidence',
  timestamps: false,
  indexes: [
    { unique: true, fields: ['student_id', 'letter', 'case_type'] },
    { fields: ['student_id'] },
  ],
});

module.exports = LetterMotorMasteryEvidence;
