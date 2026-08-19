'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Feature 11B Phase 4 — see
// migrations/20260820000002-create-letter-motor-reassessments.js for the
// full schema rationale. One row per COMPLETED standardized Letter Motor
// Reassessment. Immutable: no route or service in this codebase ever calls
// .update()/.destroy() on an existing row — only
// letterMotorReassessmentService.js's own finalize path ever writes, and
// only to insert a brand-new row (idempotent — see that service's own
// finalize logic).
const LetterMotorReassessment = sequelize.define('LetterMotorReassessment', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: {
    type:      DataTypes.INTEGER,
    allowNull: false,
  },
  reassessment_session_id: {
    type:      DataTypes.UUID,
    allowNull: false,
  },
  completed_at: {
    type:      DataTypes.DATE,
    allowNull: false,
  },

  smoothness_score: { type: DataTypes.FLOAT, allowNull: false },
  dtw_distance:     { type: DataTypes.FLOAT, allowNull: false },
  speed_cv:         { type: DataTypes.FLOAT, allowNull: false },

  cluster_id:   { type: DataTypes.INTEGER,    allowNull: false },
  state_code:   { type: DataTypes.STRING(40), allowNull: false },
  display_name: { type: DataTypes.STRING(80), allowNull: false },

  nearest_distance:        { type: DataTypes.FLOAT, allowNull: false },
  second_nearest_distance: { type: DataTypes.FLOAT, allowNull: false },
  separation_margin:       { type: DataTypes.FLOAT, allowNull: false },

  model_version: { type: DataTypes.STRING(40), allowNull: false },

  feature_version:       { type: DataTypes.STRING(20), allowNull: false },
  template_version:      { type: DataTypes.STRING(20), allowNull: false },
  normalization_version: { type: DataTypes.STRING(20), allowNull: false },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName:  'letter_motor_reassessments',
  timestamps: false, // created_at/updated_at are plain columns above, matching this schema's existing convention elsewhere
  indexes: [
    { fields: ['student_id', 'completed_at'] },
    { unique: true, fields: ['student_id', 'reassessment_session_id', 'model_version'] },
  ],
});

module.exports = LetterMotorReassessment;
