'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Feature 1: Individual Motor-Family Baseline — see
// src/services/motorBaselineService.js for creation logic and
// migrations/20260807000001-create-student-motor-baselines.js for schema
// rationale. Immutable: no route updates or deletes rows in this table.
const StudentMotorBaseline = sequelize.define('StudentMotorBaseline', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  source_assessment_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
    unique:    true,
  },

  // Copied verbatim from HandwritingAssessment.motor_profile — never
  // recalculated (see calculateMotorProfile() in
  // frontend/src/utils/adaptiveSequencing.js).
  straight_score: {
    type:      DataTypes.FLOAT,
    allowNull: false,
  },
  curved_score: {
    type:      DataTypes.FLOAT,
    allowNull: false,
  },
  complex_score: {
    type:      DataTypes.FLOAT,
    allowNull: false,
  },
  // Copied verbatim from HandwritingAssessment.motor_score.
  overall_motor_score: {
    type:      DataTypes.FLOAT,
    allowNull: false,
  },

  baseline_version: {
    type:         DataTypes.STRING(20),
    allowNull:    false,
    defaultValue: 'baseline-v1',
  },
  // straight/curved/complex taxonomy — distinct from the
  // vertical_horizontal/curved/diagonal/mixed taxonomy in
  // config/letterMotorPrimitives.js. See migration comment.
  taxonomy_version: {
    type:         DataTypes.STRING(20),
    allowNull:    false,
    defaultValue: 'assessment-motor-v1',
  },
  source_type: {
    type:         DataTypes.STRING(30),
    allowNull:    false,
    defaultValue: 'initial_assessment',
  },

  is_backfilled: {
    type:         DataTypes.BOOLEAN,
    allowNull:    false,
    defaultValue: false,
  },
  backfilled_at: {
    type:      DataTypes.DATE,
    allowNull: true,
  },

  created_at: {
    type:         DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName:       'student_motor_baselines',
  timestamps:      false,
  freezeTableName: true,
  indexes: [
    { fields: ['source_assessment_id'], unique: true },
    { fields: ['student_id'] },
  ],
});

module.exports = StudentMotorBaseline;
