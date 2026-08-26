'use strict';

const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

// Feature 11B — S2. See
// migrations/20260826000001-create-letter-motor-state-evaluations.js for the
// full schema rationale, including why this is a sibling table rather than
// nullable pattern columns on letter_motor_state_history.
//
// One immutable row per (student, milestone, model_version) evaluation
// event. Written for an assigned pattern AND for a reference-range
// rejection, so a rejected milestone stays inspectable instead of being
// silently lost.
const LetterMotorStateEvaluation = sequelize.define('LetterMotorStateEvaluation', {
  id: {
    type:          DataTypes.INTEGER,
    primaryKey:    true,
    autoIncrement: true,
  },
  student_id: { type: DataTypes.INTEGER,    allowNull: false },
  milestone:  { type: DataTypes.STRING(40), allowNull: false },
  coverage_n: { type: DataTypes.INTEGER,    allowNull: false },
  evidence_row_count: { type: DataTypes.INTEGER, allowNull: false },
  observed_at: { type: DataTypes.DATE, allowNull: false },

  evaluation_status:      { type: DataTypes.STRING(40), allowNull: false },
  inside_reference_range: { type: DataTypes.BOOLEAN,    allowNull: false },

  smoothness_score: { type: DataTypes.FLOAT, allowNull: false },
  dtw_distance:     { type: DataTypes.FLOAT, allowNull: false },
  speed_cv:         { type: DataTypes.FLOAT, allowNull: false },

  // Verbatim copies of the ML service's own reference-range diagnostics.
  ood_reason:           { type: DataTypes.STRING(80), allowNull: true },
  ood_triggered_by:     { type: DataTypes.JSONB,      allowNull: true },
  ood_outside_features: { type: DataTypes.JSONB,      allowNull: true },
  ood_detail:           { type: DataTypes.JSONB,      allowNull: true },

  model_version: { type: DataTypes.STRING(40), allowNull: false },

  feature_version:       { type: DataTypes.STRING(20), allowNull: false },
  template_version:      { type: DataTypes.STRING(20), allowNull: false },
  normalization_version: { type: DataTypes.STRING(20), allowNull: false },

  // Writing Check link. NULL on legacy 14/17/20 milestone rows; set on
  // rows produced by a dedicated teacher-initiated Writing Check. See
  // migrations/20260826000003 for why uniqueness is split by this column.
  pattern_check_id: { type: DataTypes.INTEGER, allowNull: true },

  created_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
}, {
  tableName:  'letter_motor_state_evaluations',
  timestamps: false,
  indexes: [
    { fields: ['student_id', 'observed_at'] },
    { unique: true, fields: ['student_id', 'milestone', 'model_version'] },
  ],
});

module.exports = LetterMotorStateEvaluation;
